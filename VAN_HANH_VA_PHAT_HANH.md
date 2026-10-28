# TÀI LIỆU VẬN HÀNH & QUY TRÌNH PHÁT HÀNH (FAST EDIT)
*Dành cho kỹ sư vận hành, kiểm thử và người duy trì hệ thống Fast Edit*

---

## 1. HƯỚNG DẪN KHỞI ĐỘNG & BỘ LỆNH KIỂM THỬ

### 1.1. Khởi động Ứng dụng
Fast Edit tích hợp sẵn môi trường chạy Portable trong thư mục `runtime/`, không phụ thuộc môi trường ngoài.

* **Khởi động nhanh (Khuyên dùng):** Nhấp đúp vào `FastEdit.exe` trên màn hình.
* **Khởi động bằng dòng lệnh:**
  ```powershell
  Set-Location "D:\VuonBaiGiang"
  .\runtime\node.exe server.mjs
  ```
* **Cổng mặc định:** `4177` (Địa chỉ web: `http://127.0.0.1:4177`).
* **Dấu hiệu sẵn sàng:** Console hiển thị dòng thông báo:
  `Tool Tạo Video đang chạy: http://127.0.0.1:4177`

---

### 1.2. Bộ Lệnh Kiểm Thử Toàn Diện (Test Suites)

Mọi bài test đều sử dụng dữ liệu giả lập tự sinh và tự thu dọn sạch sẽ sau khi chạy xong, bảo vệ tuyệt đối các dự án thật của người dùng:

| Hạng mục kiểm thử | Lệnh thực thi | Mục tiêu xác nhận |
| :--- | :--- | :--- |
| **Full QA Tích Hợp (22 bài)** | `.\runtime\node.exe scripts\full_qa_test.mjs` *(hoặc `run_all_qa.bat`)* | Toàn bộ luồng: Tải video, cắt lossless, lọc ồn, dập phụ đề, PiP, Concat, Loudnorm |
| **Bộ Unit Tests (31 bài)** | `.\runtime\node.exe video_concat_planner.test.mjs`<br/>`.\runtime\node.exe media_duration.test.mjs`<br/>`.\runtime\node.exe file_hash.test.mjs`<br/>`.\runtime\node.exe project_housekeeping.test.mjs` | Kiểm tra logic cô lập: Lập kế hoạch concat, đọc duration cache, hash SHA-256, tự dọn rác |
| **Pipeline Âm Thanh** | `.\runtime\node.exe scripts\test_fastEditAudio.mjs` | Lọc ồn DSP, vi fade 10ms, kiểm tra lệch A/V drift (< 1 frame), chuẩn hóa Two-pass Loudnorm |
| **Ca Biên & Tài Nguyên (Edge QA)** | `.\runtime\node.exe scripts\edge_case_qa.mjs` | File tiếng Việt Unicode (NFC/NFD), ký tự lạ `' # %`, đo Peak RAM 4K, hủy tác vụ dọn `.part` |
| **Cờ Xoay & Tỉ Lệ Hình** | `.\runtime\node.exe scripts\orientation_qa.mjs` | Bảo toàn cờ xoay Display Matrix 90°, ghép video dọc vào khung 16:9 không méo hình |

---

## 2. GIỚI HẠN CỦA CÁC SỐ LIỆU ĐO LƯỜNG

> [!IMPORTANT]
> Các chỉ số tài nguyên công bố (Node.js Peak RSS ~62 MB, Process Tree Peak ~499 MB, thời gian cắt 63ms) là kết quả **lấy mẫu thực nghiệm trên máy tính phát triển** với video mẫu kiểm thử.

* **Độ biến thiên thực tế:** Khi chạy trên các dòng laptop văn phòng khác nhau (chip Core i3 đời cũ, ổ cứng HDD hoặc SSD SATA chậm), mức tải CPU, tốc độ đọc ghi đĩa và thời gian thực thi có thể chênh lệch tùy theo:
  - Độ dài và bitrate của video nguồn (video 4K 100Mbps sẽ tốn RAM đệm hơn video 720p 4Mbps).
  - Tình trạng bộ nhớ RAM thực tế đang bị chiếm bởi Windows và các ứng dụng văn phòng khác.
* **Nguyên tắc an toàn:** Hệ thống luôn kích hoạt cờ hạ ưu tiên tiến trình `PRIORITY_BELOW_NORMAL` và giới hạn tối đa 4 luồng nhân vật lý để đảm bảo giao diện máy luôn mượt mà trên mọi laptop.

---

## 3. AN TOÀN DỮ LIỆU & NƠI LƯU TRỮ

1. **Bảo vệ Dự án Người dùng:**
   - Toàn bộ dữ liệu bài giảng của người dùng được lưu trữ trong thư mục `projects/<project-id>/`.
   - Cơ chế dọn dẹp rác tự động (`project_housekeeping.mjs`) **tuyệt đối không bao giờ can thiệp** vào các video người dùng tải lên (`media/`) hay cấu hình bài giảng (`project.json`). Nó chỉ quét và xóa các file rác dở dang `.part_*`, `.tmp_*` tồn tại quá 24 giờ.
2. **Nơi tìm Video Thành Phẩm:**
   - Video sau khi cắt hoặc ghép hoàn chỉnh được lưu tại:  
     `D:\VuonBaiGiang\projects\<project-id>\media\<tên_video>.mp4`  
   - Người dùng có thể xem lại hoặc tải trực tiếp từ giao diện web tại thẻ "Thư viện Video".
3. **Quy trình Sao Lưu:**
   - Trước khi thực hiện các đợt bảo trì hoặc nâng cấp lớn, kỹ sư chỉ cần sao chép (copy) thư mục `projects/` ra vị trí an toàn để dự phòng.

---

## 4. XỬ LÝ SỰ CỐ KHI TÁC VỤ BỊ NGẮT QUÃNG

* **Hiện tượng:** Laptop bị gập nắp, máy chuyển sang chế độ Sleep hoặc mất điện đột ngột trong khi đang render video dài.
* **Cơ chế tự bảo vệ của Fast Edit:**
  1. **Không hỏng video cũ:** Mọi tác vụ xuất file đều ghi ra file tạm `.part_[timestamp].mp4`. Video cũ chỉ bị thay thế khi video mới đã ghi xong 100% và qua bước kiểm tra dung lượng hợp lệ.
  2. **Tự dọn dẹp file mồ côi:** Khi ứng dụng được khởi động lại vào lần kế tiếp, module `project_housekeeping` sẽ tự động phát hiện và xóa sạch các file `.part` dở dang.
  3. **Giải phóng tiến trình treo:** Khi người dùng bấm nút "Dừng", bộ điều khiển `AbortSignal` lập tức phát lệnh `taskkill /pid <PID> /T /F` để tiêu diệt sạch sẽ cây tiến trình FFmpeg, không để lại tiến trình ngầm chiếm RAM.
* **Cách khôi phục:** Chỉ cần mở lại Fast Edit, mở lại bài giảng và bấm nút thực hiện lại thao tác.

---

## 5. CHECKLIST PHÁT HÀNH PHIÊN BẢN MỚI (RELEASE CHECKLIST)

Khi chuẩn bị phát hành một bản cập nhật mới lên GitHub cho máy của Dì:

- [ ] **Bước 1 - Chạy kiểm thử:** Chạy đủ các kịch bản test (`full_qa_test.mjs`, `orientation_qa.mjs`, `edge_case_qa.mjs`) và đảm bảo **100% PASS**.
- [ ] **Bước 2 - Đồng bộ phiên bản:**
  - Nâng số phiên bản trong `version.json` (ví dụ: `1.4.0` lên `1.4.1`).
  - Cập nhật mô tả nội dung nâng cấp ngắn gọn, dễ hiểu trong trường `notes`.
  - Kiểm tra mảng `files` trong `version.json` đã chứa đầy đủ các file `.mjs` và `.html` mới hay chưa.
- [ ] **Bước 3 - Commit & Đẩy lên GitHub:**
  - Thực hiện lệnh `git add` và `git commit -m "Release vX.X.X: ..."`.
  - Đẩy lên nhánh chính: `git push origin main`.
- [ ] **Bước 4 - Đồng bộ gói nén bàn giao:**
  - Sao chép các file thay đổi sang thư mục `D:\VuonBaiGiang_ChoDi\`.
  - Cập nhật file nén xuất xưởng `VuonBaiGiang_ChoDi.zip`.
- [ ] **Bước 5 - Kiểm tra trực tuyến:**
  - Gọi endpoint `http://127.0.0.1:4177/api/update/check` để xác nhận hệ thống đã nhận diện chính xác bản mới từ GitHub.
