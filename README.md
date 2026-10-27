# Fast Edit — Bộ Công Cụ Biên Tập Video Siêu Tốc & Tối Ưu Âm Thanh Bài Giảng

**Fast Edit** là ứng dụng biên tập, cắt ghép video siêu tốc chạy cục bộ (**100% Offline & On-device**) trên Windows, được tối ưu hóa đặc biệt cho **Laptop văn phòng phổ thông** (Intel Core i3 / i5, RAM 8GB, không cần card đồ họa rời).

---

## 🌟 Điểm nổi bật của Fast Edit

1. **Cắt video siêu tốc không mất chất lượng (Lossless Stream Copy):**
   - Áp dụng kỹ thuật snap Keyframe thông minh, cắt và trích xuất phân đoạn video chỉ trong **vài trăm mili-giây** (0% tải CPU/GPU, giữ nguyên 100% chất lượng gốc của camera).
2. **Lọc sạch tạp âm & Tiếng quạt gió (DSP Voice Enhancement):**
   - Bộ lọc hạ âm `highpass=80Hz` triệt tiêu tiếng ồn gió quạt và rung lắc micro mà không làm mỏng giọng nói.
   - Thuật toán khử ồn thích ứng `afftdn` giúp giọng giảng bài trong trẻo, tự nhiên.
3. **Triệt tiêu tiếng nổ "bụp bụp" ở các mối cắt (Micro-Fade):**
   - Vi vuốt mềm âm thanh 5ms – 10ms tại điểm cắt, loại bỏ hoàn toàn xung điện áp DC và lỗi đệm khung mã hóa AAC.
4. **Chuẩn hóa âm lượng bài giảng chuyên nghiệp (Two-pass EBU R128 Loudnorm):**
   - Tự động cân bằng toàn bộ video bài giảng về chuẩn phát sóng **-16 LUFS**, đỉnh âm an toàn **-1.5 dBFS**, âm lượng đều đặn không bị đoạn to đoạn nhỏ.
5. **Siêu tối ưu cho Laptop văn phòng:**
   - **Chống đơ chuột, chống rú quạt:** Giới hạn luồng theo nhân vật lý thực và tự động hạ mức ưu tiên tiến trình (`PRIORITY_BELOW_NORMAL`), đảm bảo máy luôn mát mẻ, chuột và bàn phím mượt mà.
   - **Tiết kiệm 50% – 75% ổ cứng:** Tối ưu file cache âm thanh về PCM 16-bit với dither chống méo, tự động dọn dẹp cache (LRU) không quá 2GB.
   - **Ghi file nguyên tử (Atomic Writes):** Tránh hỏng file khi laptop bất ngờ gập nắp hoặc chuyển sang chế độ Sleep.
6. **Hệ thống cập nhật 1-Click qua GitHub:**
   - Tự động phát hiện phiên bản mới và cập nhật tức thì (chưa tới 2 giây) mà không cần tải lại các gói phần mềm nặng.

---

## 🛠️ Yêu cầu hệ thống

* **Hệ điều hành:** Windows 10 / Windows 11 (64-bit).
* **Phần cứng:** Bất kỳ laptop hoặc máy tính để bàn nào (kể cả chip Intel Core i3 dòng U, RAM 8GB).
* **Môi trường:** Đã tích hợp sẵn Node.js và FFmpeg Portable trong thư mục `runtime/`, không cần cài đặt thêm bất kỳ phần mềm phụ trợ nào.

---

## 🚀 Hướng dẫn sử dụng

1. **Khởi động:** Nhấp đúp vào tệp `FastEdit.exe` (hoặc mở đường dẫn `http://127.0.0.1:4177` trên trình duyệt).
2. **Cắt video:**
   - Kéo video bài giảng vào khung làm việc.
   - Chọn đoạn cần lấy trên thanh thời gian.
   - Tích chọn `[✓] 🎙️ Lọc sạch tạp âm & Tiếng quạt, gió`.
   - Bấm nút **Cắt video ngay** — Hoàn tất trong nháy mắt!
3. **Lọc ồn 1-Click cho toàn bộ video:** Bấm nút `🎙️ Lọc ồn cả video (1s)` để có ngay bản video sạch tiếng quạt gió.
