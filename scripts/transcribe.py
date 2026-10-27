import sys
import os
import json
import argparse

# Tự động nạp thư viện CUDA DLL từ torch nếu có để GPU CTranslate2 hoạt động trên Windows
def setup_cuda_dlls():
    try:
        import ctypes
        current_dir = os.path.dirname(os.path.abspath(__file__))
        root_dir = os.path.dirname(current_dir)
        possible_torch_lib = os.path.join(root_dir, ".venv-tts", "Lib", "site-packages", "torch", "lib")
        if os.path.exists(possible_torch_lib):
            try:
                ctypes.windll.kernel32.SetDllDirectoryW(possible_torch_lib)
            except Exception:
                pass
            if hasattr(os, "add_dll_directory"):
                try:
                    os.add_dll_directory(possible_torch_lib)
                except Exception:
                    pass
            os.environ["PATH"] = possible_torch_lib + os.pathsep + os.environ.get("PATH", "")
    except Exception as e:
        print(f"[Transcribe Warning] Không thể nạp torch/lib: {e}", file=sys.stderr)

setup_cuda_dlls()

from faster_whisper import WhisperModel

def format_timestamp(seconds: float) -> str:
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int(round((seconds - int(seconds)) * 1000))
    if millis >= 1000:
        millis = 999
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"

def main():
    parser = argparse.ArgumentParser(description="Transcribe audio to SRT and JSON segments using faster-whisper")
    parser.add_argument("--audio", required=True, help="Path to input audio/video file")
    parser.add_argument("--output_json", required=True, help="Path to output JSON result")
    parser.add_argument("--output_srt", default=None, help="Optional path to output SRT file")
    parser.add_argument("--model", default="base", help="Model size: base or small")
    parser.add_argument("--language", default="auto", help="Spoken language code (e.g. vi, en, or auto)")
    parser.add_argument("--device", default="auto", help="Device: auto, cuda, or cpu")
    parser.add_argument("--compute_type", default="auto", help="Compute type: auto, float16, int8")
    parser.add_argument("--mode", default="speech", help="Mode: speech (lời nói) or music (bài hát / có nhạc nền)")
    args = parser.parse_args()

    if not os.path.exists(args.audio):
        print(f"Error: audio file {args.audio} not found", file=sys.stderr)
        sys.exit(1)

    # Tự động chọn device CUDA nếu khả dụng
    device = args.device
    compute_type = args.compute_type
    if device == "auto":
        try:
            import ctranslate2
            if ctranslate2.get_cuda_device_count() > 0:
                device = "cuda"
                if compute_type == "auto":
                    compute_type = "float16"
            else:
                device = "cpu"
                if compute_type == "auto":
                    compute_type = "int8"
        except Exception:
            device = "cpu"
            if compute_type == "auto":
                compute_type = "int8"

    if compute_type == "auto":
        compute_type = "float16" if device == "cuda" else "int8"

    print(f"[Transcribe] Loading faster-whisper model '{args.model}' (device={device}, compute_type={compute_type})...")
    try:
        model = WhisperModel(args.model, device=device, compute_type=compute_type)
    except Exception as e:
        print(f"[Transcribe] Fallback to CPU int8 due to: {e}", file=sys.stderr)
        device = "cpu"
        compute_type = "int8"
        model = WhisperModel(args.model, device="cpu", compute_type="int8")

    lang = None if not args.language or args.language.lower() in ("auto", "none") else args.language
    print(f"[Transcribe] Transcribing: {args.audio} (language={lang or 'auto-detect'}, mode={args.mode})...")

    is_music = args.mode.lower() in ("music", "song", "hat", "nhac")
    vad_on = False if is_music else True

    segments_gen, info = model.transcribe(
        args.audio,
        language=lang,
        beam_size=1, # Tốc độ cao nhất
        condition_on_previous_text=False, # Tránh lặp loop câu hoặc kẹt từ
        vad_filter=vad_on,
        vad_parameters=dict(min_silence_duration_ms=400, threshold=0.3) if vad_on else None,
        word_timestamps=True # Bật bóc tách mốc thời gian từng từ cho Karaoke
    )

    detected_lang = info.language if hasattr(info, "language") else (lang or "vi")
    results = []
    srt_entries = []
    idx = 1

    for seg in segments_gen:
        text = seg.text.strip()
        if not text:
            continue
        start = round(float(seg.start), 2)
        end = round(float(seg.end), 2)
        words_list = []
        if hasattr(seg, "words") and seg.words:
            for w in seg.words:
                words_list.append({
                    "word": w.word,
                    "start": round(float(w.start), 2),
                    "end": round(float(w.end), 2)
                })

        results.append({
            "id": idx,
            "start": start,
            "end": end,
            "text": text,
            "words": words_list
        })
        start_ts = format_timestamp(start)
        end_ts = format_timestamp(end)
        srt_entries.append(f"{idx}\n{start_ts} --> {end_ts}\n{text}\n")
        idx += 1

    srt_content = "\n".join(srt_entries)
    if args.output_srt:
        with open(args.output_srt, "w", encoding="utf-8") as f:
            f.write(srt_content)

    output_data = {
        "ok": True,
        "language": detected_lang,
        "duration": round(info.duration if hasattr(info, "duration") else 0, 2),
        "segments": results,
        "srt": srt_content,
        "deviceUsed": device
    }

    with open(args.output_json, "w", encoding="utf-8") as f:
        json.dump(output_data, f, ensure_ascii=False, indent=2)

    print(f"[Transcribe] Done! Extracted {len(results)} segments (detected_language={detected_lang}, device={device}, words_enabled=True).")

    # Giải phóng VRAM/RAM triệt để
    try:
        del model
        import gc
        gc.collect()
        if device == "cuda":
            import torch
            torch.cuda.empty_cache()
    except Exception:
        pass

if __name__ == "__main__":
    main()
