"""Script tải ngầm bộ model LTX-Video 2.5 cho ComfyUI.
Bao gồm:
1. Checkpoint: ltx-video-2b-v0.9.5.safetensors (~5.90 GB)
2. Text Encoder: t5xxl_fp8_e4m3fn_scaled.safetensors (~4.80 GB)

Có hỗ trợ Resume (tiếp tục tải nếu đứt mạng), tính tốc độ MB/s, ETA,
và ghi tiến trình thời gian thực ra file ltx_download_status.json.
"""

import os
import sys
import time
import json
import logging
from pathlib import Path
import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("LTX_Downloader")

COMFY_ROOT = Path(r"D:\ComfyUI_windows_portable\ComfyUI")
CHECKPOINT_DIR = COMFY_ROOT / "models" / "checkpoints"
TEXT_ENCODER_DIR = COMFY_ROOT / "models" / "text_encoders"

STATUS_PATHS = [
    Path(__file__).resolve().parent.parent / "ltx_download_status.json",
    Path(r"D:\VuonBaiGiang\ltx_download_status.json"),
]

DOWNLOAD_TARGETS = [
    {
        "name": "LTX-Video 2.5 Checkpoint",
        "filename": "ltx-video-2b-v0.9.5.safetensors",
        "url": "https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltx-video-2b-v0.9.5.safetensors",
        "dest_dir": CHECKPOINT_DIR,
        "expected_size": 6340729500,
    },
    {
        "name": "T5-XXL Text Encoder (FP8 Scaled)",
        "filename": "t5xxl_fp8_e4m3fn_scaled.safetensors",
        "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn_scaled.safetensors",
        "dest_dir": TEXT_ENCODER_DIR,
        "expected_size": 5157348688,
    },
]

def update_status(data: dict):
    for sp in STATUS_PATHS:
        try:
            sp.parent.mkdir(parents=True, exist_ok=True)
            with open(sp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.debug("Không thể ghi file status %s: %s", sp, e)

def download_file_resumable(target: dict, file_index: int, total_files: int, total_all_bytes: int, downloaded_prev_files: int):
    filename = target["filename"]
    dest_dir = target["dest_dir"]
    dest_dir.mkdir(parents=True, exist_ok=True)
    final_path = dest_dir / filename
    part_path = dest_dir / f"{filename}.part"
    url = target["url"]
    expected_size = target["expected_size"]

    # Kiểm tra nếu file đã tải xong từ trước
    if final_path.is_file():
        actual_size = final_path.stat().st_size
        if actual_size >= expected_size:
            logger.info("File %s đã tồn tại đầy đủ (%d bytes). Bỏ qua.", filename, actual_size)
            return actual_size

    existing_bytes = 0
    if part_path.is_file():
        existing_bytes = part_path.stat().st_size
        logger.info("Tiếp tục tải %s từ byte %d / %d...", filename, existing_bytes, expected_size)

    retries = 10
    chunk_size = 1024 * 1024  # 1MB chunks

    for attempt in range(retries):
        try:
            headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
            if existing_bytes > 0:
                headers["Range"] = f"bytes={existing_bytes}-"

            logger.info("Đang kết nối: %s (Lần thử %d/%d)...", filename, attempt + 1, retries)
            resp = requests.get(url, headers=headers, stream=True, timeout=30, allow_redirects=True)

            if resp.status_code not in (200, 206):
                raise RuntimeError(f"Server trả về mã HTTP {resp.status_code}")

            mode = "ab" if existing_bytes > 0 else "wb"
            last_report_time = time.time()
            bytes_since_report = 0
            start_download_time = time.time()

            with open(part_path, mode) as f:
                for chunk in resp.iter_content(chunk_size=chunk_size):
                    if not chunk:
                        continue
                    f.write(chunk)
                    existing_bytes += len(chunk)
                    bytes_since_report += len(chunk)

                    now = time.time()
                    elapsed = now - last_report_time
                    if elapsed >= 1.0:
                        speed_mbps = (bytes_since_report / (1024 * 1024)) / elapsed
                        total_downloaded = downloaded_prev_files + existing_bytes
                        overall_percent = round((total_downloaded / total_all_bytes) * 100, 1)
                        file_percent = round((existing_bytes / expected_size) * 100, 1)
                        remaining_bytes = max(0, total_all_bytes - total_downloaded)
                        eta_seconds = int(remaining_bytes / (speed_mbps * 1024 * 1024)) if speed_mbps > 0 else 0

                        status_data = {
                            "status": "downloading",
                            "file_index": file_index,
                            "total_files": total_files,
                            "current_file": filename,
                            "current_file_name": target["name"],
                            "file_downloaded_bytes": existing_bytes,
                            "file_total_bytes": expected_size,
                            "file_percent": file_percent,
                            "overall_downloaded_bytes": total_downloaded,
                            "overall_total_bytes": total_all_bytes,
                            "overall_percent": overall_percent,
                            "speed_mbps": round(speed_mbps, 2),
                            "eta_seconds": eta_seconds,
                            "updated_at": time.time(),
                            "message": f"Đang tải {target['name']} ({file_percent}% - {round(speed_mbps, 1)} MB/s)"
                        }
                        update_status(status_data)

                        bytes_since_report = 0
                        last_report_time = now

            # Khi vòng lặp kết thúc thành công
            if part_path.stat().st_size >= expected_size:
                if final_path.is_file():
                    final_path.unlink()
                part_path.rename(final_path)
                logger.info("Hoàn tất tải file: %s (%d bytes)", final_path, final_path.stat().st_size)
                return final_path.stat().st_size

        except Exception as ex:
            logger.warning("Lỗi trong quá trình tải %s: %s. Thử lại sau 5s...", filename, ex)
            if part_path.is_file():
                existing_bytes = part_path.stat().st_size
            time.sleep(5)

    raise RuntimeError(f"Không thể tải xong file {filename} sau {retries} lần thử.")

def main():
    logger.info("=== BẮT ĐẦU TIẾN TRÌNH TẢI BỘ MODEL LTX-VIDEO 2.5 ===")
    total_all_bytes = sum(t["expected_size"] for t in DOWNLOAD_TARGETS)
    total_files = len(DOWNLOAD_TARGETS)
    downloaded_prev_files = 0

    init_status = {
        "status": "starting",
        "file_index": 1,
        "total_files": total_files,
        "current_file": DOWNLOAD_TARGETS[0]["filename"],
        "current_file_name": DOWNLOAD_TARGETS[0]["name"],
        "overall_downloaded_bytes": 0,
        "overall_total_bytes": total_all_bytes,
        "overall_percent": 0.0,
        "speed_mbps": 0.0,
        "eta_seconds": 0,
        "updated_at": time.time(),
        "message": "Đang kết nối tới HuggingFace..."
    }
    update_status(init_status)

    try:
        for idx, target in enumerate(DOWNLOAD_TARGETS, 1):
            logger.info("Bắt đầu file [%d/%d]: %s", idx, total_files, target["name"])
            f_size = download_file_resumable(target, idx, total_files, total_all_bytes, downloaded_prev_files)
            downloaded_prev_files += f_size

        final_status = {
            "status": "completed",
            "file_index": total_files,
            "total_files": total_files,
            "current_file": DOWNLOAD_TARGETS[-1]["filename"],
            "overall_downloaded_bytes": total_all_bytes,
            "overall_total_bytes": total_all_bytes,
            "overall_percent": 100.0,
            "speed_mbps": 0.0,
            "eta_seconds": 0,
            "updated_at": time.time(),
            "message": "Tải thành công toàn bộ model LTX-Video 2.5! Đã sẵn sàng sinh video 15s."
        }
        update_status(final_status)
        logger.info("=== TẤT CẢ MODEL LTX-VIDEO ĐÃ TẢI XONG VÀ SẴN SÀNG HOẠT ĐỘNG ===")

    except Exception as exc:
        logger.exception("Lỗi tiến trình tải LTX-Video: %s", exc)
        err_status = {
            "status": "error",
            "error": str(exc),
            "updated_at": time.time(),
            "message": f"Lỗi tải model: {exc}"
        }
        update_status(err_status)
        sys.exit(1)

if __name__ == "__main__":
    main()
