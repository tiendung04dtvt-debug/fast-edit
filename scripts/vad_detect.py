import sys
import os
import json
import argparse
import subprocess
import numpy as np

# Đảm bảo in console UTF-8 trên Windows
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# Tự động nạp CUDA DLL nếu có
def setup_cuda_dlls():
    try:
        current_dir = os.path.dirname(os.path.abspath(__file__))
        root_dir = os.path.dirname(current_dir)
        possible_torch_lib = os.path.join(root_dir, ".venv-tts", "Lib", "site-packages", "torch", "lib")
        if os.path.exists(possible_torch_lib):
            if hasattr(os, "add_dll_directory"):
                try:
                    os.add_dll_directory(possible_torch_lib)
                except Exception:
                    pass
            os.environ["PATH"] = possible_torch_lib + os.pathsep + os.environ.get("PATH", "")
    except Exception:
        pass

setup_cuda_dlls()

from faster_whisper.vad import get_speech_timestamps, VadOptions

def load_audio_16k_mono(input_path: str) -> np.ndarray:
    """Dùng ffmpeg giải mã âm thanh bất kỳ sang float32 16kHz Mono"""
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", input_path,
        "-ac", "1", "-ar", "16000",
        "-f", "f32le", "-"
    ]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    raw, err = p.communicate()
    if p.returncode != 0:
        raise RuntimeError(f"FFmpeg decode error: {err.decode('utf-8', errors='ignore')}")
    audio = np.frombuffer(raw, dtype=np.float32)
    return audio

def main():
    parser = argparse.ArgumentParser(description="Silero VAD Speech Segments Detector")
    parser.add_argument("--input", required=True, help="Input video or audio file")
    parser.add_argument("--output_json", required=True, help="Output JSON with speech and silence segments")
    parser.add_argument("--threshold", type=float, default=0.45, help="Speech probability threshold (0.1 to 0.9)")
    parser.add_argument("--min_silence_ms", type=int, default=400, help="Min silence duration in ms to split")
    parser.add_argument("--speech_pad_ms", type=int, default=150, help="Speech padding around segments in ms")
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"Error: file not found {args.input}", file=sys.stderr)
        sys.exit(1)

    print(f"[Silero VAD] Đang trích xuất audio và quét giọng nói bằng Silero VAD (threshold={args.threshold}, min_silence={args.min_silence_ms}ms)...")
    audio = load_audio_16k_mono(args.input)
    sr = 16000
    total_sec = len(audio) / sr

    vad_opts = VadOptions(
        threshold=args.threshold,
        min_speech_duration_ms=250,
        min_silence_duration_ms=args.min_silence_ms,
        speech_pad_ms=args.speech_pad_ms
    )

    timestamps = get_speech_timestamps(audio, vad_opts, sampling_rate=sr)

    # Chuyển đổi sample index sang seconds
    speech_segments = []
    for t in timestamps:
        s = round(t["start"] / sr, 3)
        e = round(t["end"] / sr, 3)
        if e > s:
            speech_segments.append({"start": s, "end": e, "duration": round(e - s, 3)})

    # Tính toán các khoảng lặng (silence segments)
    silence_segments = []
    last_end = 0.0
    for seg in speech_segments:
        if seg["start"] > last_end:
            sil_dur = round(seg["start"] - last_end, 3)
            if sil_dur >= (args.min_silence_ms / 1000.0):
                silence_segments.append({"start": last_end, "end": seg["start"], "duration": sil_dur})
        last_end = max(last_end, seg["end"])

    if last_end < total_sec:
        sil_dur = round(total_sec - last_end, 3)
        if sil_dur >= 0.2:
            silence_segments.append({"start": last_end, "end": round(total_sec, 3), "duration": sil_dur})

    result = {
        "ok": True,
        "total_duration": round(total_sec, 3),
        "speech_segments": speech_segments,
        "silence_segments": silence_segments,
        "speech_count": len(speech_segments),
        "silence_count": len(silence_segments)
    }

    with open(args.output_json, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"[Silero VAD] Hoàn tất: Phát hiện {len(speech_segments)} đoạn giọng nói và {len(silence_segments)} khoảng lặng.")

    # Giải phóng bộ nhớ RAM triệt để
    try:
        del model
        del wav
        import gc
        gc.collect()
    except Exception:
        pass

if __name__ == "__main__":
    main()
