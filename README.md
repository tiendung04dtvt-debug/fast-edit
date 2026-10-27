# Vườn Bài Giảng 2.0 — AI Video Studio & Lesson Builder (Local-first)

Ứng dụng tạo video bài giảng thế hệ mới chạy cục bộ (**Local-first & 100% Offline**) trên Windows dành riêng cho giáo viên tiểu học và nhà giáo dục. Hệ thống hỗ trợ dựng bài giảng đa phương tiện kết hợp giữa **Slide hình ảnh** và **Video hoạt cảnh AI sinh từ văn bản (Prompt-to-Video)** bằng mô hình **Wan2.1** cùng giọng đọc AI tiếng Việt tự nhiên (**VieNeu-TTS / KorvaTTS**).

---

## 🌟 Nguyên tắc thiết kế của Vườn Bài Giảng 2.0

1. **Giáo viên luôn là đạo diễn nội dung:** AI chỉ đóng vai trò trợ lý họa sĩ và người dẫn chuyện; giáo viên toàn quyền biên tập, chỉnh sửa kịch bản và quyết định cảnh nào dùng hình tĩnh, cảnh nào dùng video AI sinh động.
2. **Tuyệt đối bảo mật và riêng tư (100% On-device):** Toàn bộ dữ liệu bài học, hình ảnh và giọng đọc học sinh/giáo viên được xử lý trực tiếp trên phần cứng máy tính cá nhân, không tải lên bất kỳ máy chủ đám mây nào.
3. **Kiến trúc mô-đun độc lập (Hybrid Mode):** Giáo viên có thể sử dụng bài giảng kết hợp linh hoạt: cảnh slide minh họa tĩnh xen kẽ các cảnh video hoạt hình 3D/anime do AI tạo ra.
4. **Bảo toàn giọng đọc bài giảng:** Thuật toán dựng phim thông minh tự động đóng băng khung hình video cuối cùng nếu lời giảng của giáo viên dài hơn thời lượng video AI, đảm bảo lời giảng không bao giờ bị cắt cụt giữa chừng.

---

## 🚀 Các tính năng chính trong Phiên bản 2.0

### 1. Bàn làm việc đa phương tiện (Hybrid Studio)
- Chuyển đổi linh hoạt giữa 2 chế độ cho từng cảnh:
  - 🖼️ **Chế độ Slide:** Tải ảnh minh họa có sẵn từ máy tính.
  - 🎬 **Chế độ Video AI (Prompt-to-Video):** Nhập lời gợi ý (prompt) bằng tiếng Việt hoặc tiếng Anh, AI sẽ tự động sinh đoạn video ngắn tương ứng bằng mô hình Wan2.1.
- Trình xem trước (Inline Video & Audio Preview) hỗ trợ phát video MP4 và nghe thử giọng đọc trực tiếp trên từng cảnh.
- Hỗ trợ chuẩn streaming **HTTP 206 Range Requests**, cho phép tua nhanh video mượt mà không phải chờ tải hết file.

### 2. Bàn dựng phim (Timeline Editor Kéo - Thả)
- Thanh dòng thời gian (Timeline) trực quan ở cuối màn hình.
- Kéo thả tự do để thay đổi thứ tự các cảnh trong bài giảng.
- Tự động đồng bộ thời gian thực hai chiều giữa giao diện và tệp cấu hình `project.json`.

### 3. Động cơ xuất phim (Hybrid FFmpeg Render Engine)
- Tự động xử lý tỉ lệ khung hình:
  - **16:9** (1920×1080 / 1280×720) cho máy chiếu lớp học, TV, YouTube.
  - **9:16** (1080×1920 / 720×1280) cho điện thoại thông minh, TikTok, Shorts.
- Bộ lọc `tpad=stop_mode=clone:stop=-1,trim=...` đóng băng khung hình video khi lời đọc dài hơn video sinh ra, tạo hiệu ứng dừng hình tự nhiên cho học sinh quan sát.
- Phụ đề bài học tự động ngắt dòng thông minh, nền mờ cân đối hiển thị rõ ràng trên màn chiếu lớn.

### 4. Quản lý VRAM thông minh & Tự động bật/tắt AI Engine
- Tự động nhận diện và khởi động ngầm ComfyUI khi có yêu cầu sinh video AI (Lazy Auto-Launch).
- Tự động giải phóng bộ nhớ GPU (VRAM) qua endpoint `/free` ngay sau khi sinh video xong, tránh tràn VRAM trên card màn hình 12GB (RTX 3060).
- Nút bấm **"Giải phóng VRAM"** thủ công trên thanh công cụ để nhường tài nguyên cho FFmpeg xuất phim hoặc các phần mềm khác.
- Tự động đóng tiến trình ngầm sạch sẽ khi tắt ứng dụng, không để lại tiến trình rác chiếm dụng bộ nhớ.

---

## 📦 Chiến lược đóng gói 2 tầng (Two-Tier Packaging)

Để phù hợp với mọi điều kiện phần cứng của giáo viên, hệ thống được đóng gói thành 2 gói cài đặt độc lập:

| Gói cài đặt | Tên tệp bộ cài | Dung lượng nén | Dung lượng giải nén | Thành phần bao gồm | Yêu cầu phần cứng |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Gói 1: Nền tảng Core** | `Setup_VuonBaiGiang_Core_v2.0.exe` | **~1.4 GB** | **~6.3 GB** | Node.js runtime, Web UI, FFmpeg LGPL binary, Python TTS Engine (VieNeu + KorvaTTS) | Mọi máy tính Windows 10/11 (kể cả máy chỉ có CPU) |
| **Gói 2: Bộ tăng tốc Video AI** | `Setup_VuonBaiGiang_AIEngine_v2.0.exe` | **~9.2 GB** | **~13.3 GB** | ComfyUI Portable + Bộ 3 mô hình Wan2.1 (Diffusion 1.3B, Text Encoder FP8, VAE) | Card đồ họa NVIDIA RTX (khuyến nghị 8GB - 12GB VRAM trở lên) |

> **Ưu điểm cho nhà trường:** Giáo viên không có card đồ họa rời vẫn có thể tải và dùng ngay **Gói 1 (Core)** để tạo bài giảng slide + lồng tiếng AI siêu tốc. Khi có máy tính cấu hình mạnh, chỉ cần cài thêm **Gói 2 (AI Engine)** vào bất kỳ ổ đĩa nào (D:, E:, C:); Gói Core sẽ tự động nhận diện qua Windows Registry mà không cần cấu hình phức tạp.

---

## ⏱️ Hiệu năng thực tế trên NVIDIA GeForce RTX 3060 (12GB VRAM)

| Tác vụ | Thời gian thực thi | Mức tiêu thụ VRAM | Trạng thái sau thực thi |
| :--- | :--- | :--- | :--- |
| **Khởi động ComfyUI (Lazy Launch)** | ~8 – 12 giây | ~0.8 GB | Sẵn sàng nhận prompt |
| **Sinh video Wan2.1 (T2V 832×480, 49 frames)** | ~130 – 140 giây | Đỉnh ~9.5 GB | Tự động giải phóng về < 1 GB |
| **Lồng tiếng AI VieNeu-TTS (câu 20–30 từ)** | ~1.5 – 2.5 giây | ~1.2 GB | Sẵn sàng xuất âm thanh |
| **Dựng video tổng thể (FFmpeg 1080p, 5 cảnh)** | ~2 – 4 giây | ~0.5 GB | Xuất file MP4 H.264 hoàn chỉnh |

---

## 🛠️ Hướng dẫn sử dụng cho giáo viên

1. **Khởi động:** Nhấp đúp biểu tượng **Vườn Bài Giảng 2.0** trên Desktop (hoặc chạy `start.bat`).
2. **Tạo kịch bản:** Bấm **＋ Thêm cảnh**, chọn chế độ **Ảnh Slide** hoặc **Video AI**.
3. **Tạo Video AI:** Nhập mô tả cảnh (ví dụ: *"Cảnh mặt trời mọc trên cánh đồng lúa vàng óng, phong cách hoạt hình giáo dục"*), bấm **Tạo video AI**.
4. **Tạo giọng đọc:** Nhập văn bản lời giảng và bấm **Tạo giọng đọc**.
5. **Sắp xếp Timeline:** Kéo thả các thẻ cảnh trên thanh Timeline phía dưới theo đúng trình tự giảng dạy.
6. **Xuất video:** Chọn độ phân giải (1080p / 720p), chọn tỉ lệ (16:9 / 9:16), rồi bấm **Tạo video MP4 ↗**.

---

## 📜 Bản quyền & Giấy phép bên thứ ba

Dự án tuân thủ nghiêm ngặt các quy định về nguồn mở và bản quyền phần mềm:
- **FFmpeg:** Sử dụng bản phân phối chuẩn LGPLv2.1+ dạng dynamic linking / executable rời.
- **Wan2.1:** Mô hình sinh video mã nguồn mở của Wan-Video Team (Apache 2.0).
- **VieNeu-TTS & KorvaTTS:** Mô hình âm thanh tiếng Việt phục vụ nghiên cứu và giáo dục.
- Chi tiết xem tại [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
