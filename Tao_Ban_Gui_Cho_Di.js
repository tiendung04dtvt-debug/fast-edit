import fs from 'fs';
import path from 'path';

const srcDir = 'D:\\VuonBaiGiang';
const destDir = 'D:\\VuonBaiGiang_ChoDi';
const oldDir = 'D:\\VuonBaiGiang_BanGuiChoDi';

console.log('Bắt đầu đóng gói bản cài đặt độc lập cho Dì...');

// Xóa thư mục cũ gây nhiễu
if (fs.existsSync(oldDir)) {
  fs.rmSync(oldDir, { recursive: true, force: true });
}

if (fs.existsSync(destDir)) {
  fs.rmSync(destDir, { recursive: true, force: true });
}
fs.mkdirSync(destDir, { recursive: true });

// Copy file
function copyFileSafe(src, dst) {
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

// Copy thư mục
function copyDirSafe(src, dst, excludes = []) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const item of fs.readdirSync(src)) {
    if (excludes.includes(item)) continue;
    const s = path.join(src, item);
    const d = path.join(dst, item);
    const stat = fs.statSync(s);
    if (stat.isDirectory()) {
      copyDirSafe(s, d, excludes);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

// 1. Copy files gốc
copyFileSafe(path.join(srcDir, 'FastEdit.exe'), path.join(destDir, 'FastEdit.exe'));
copyFileSafe(path.join(srcDir, 'FastEdit.ico'), path.join(destDir, 'FastEdit.ico'));
copyFileSafe(path.join(srcDir, 'VuonBaiGiang.exe'), path.join(destDir, 'VuonBaiGiang.exe'));
copyFileSafe(path.join(srcDir, 'VuonBaiGiang.vbs'), path.join(destDir, 'VuonBaiGiang.vbs'));
copyFileSafe(path.join(srcDir, 'start.bat'), path.join(destDir, 'start.bat'));
copyFileSafe(path.join(srcDir, 'server.mjs'), path.join(destDir, 'server.mjs'));
copyFileSafe(path.join(srcDir, 'video_concat_planner.mjs'), path.join(destDir, 'video_concat_planner.mjs'));
copyFileSafe(path.join(srcDir, 'package.json'), path.join(destDir, 'package.json'));
copyFileSafe(path.join(srcDir, 'version.json'), path.join(destDir, 'version.json'));

// 2. Copy runtime (node.exe, ffmpeg.exe)
console.log('Đang sao chép runtime (Node.js & FFmpeg)...');
copyDirSafe(path.join(srcDir, 'runtime'), path.join(destDir, 'runtime'), ['rhubarb']);

// 3. Copy public UI
console.log('Đang sao chép giao diện Web UI...');
copyDirSafe(path.join(srcDir, 'public'), path.join(destDir, 'public'), ['mouths']);

// 4. Tạo thư mục projects trống
fs.mkdirSync(path.join(destDir, 'projects'), { recursive: true });

// 5. Tạo script tạo shortcut Desktop cho Dì
const shortcutBat = `@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "TARGET_EXE=%~dp0FastEdit.exe"
set "DESKTOP_DIR=%USERPROFILE%\\Desktop"
set "SHORTCUT_PATH=%DESKTOP_DIR%\\Fast Edit.lnk"
set "ICON_PATH=%~dp0FastEdit.ico"

powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%SHORTCUT_PATH%'); $s.TargetPath = '%TARGET_EXE%'; $s.WorkingDirectory = '%~dp0'; $s.IconLocation = '%ICON_PATH%'; $s.Description = 'Phần mềm Cắt Ghép Video Siêu Tốc - Fast Edit'; $s.Save()"

echo.
echo ========================================================
echo   DA TAO THANH CONG BIEU TUONG NGOAI MAN HINH DESKTOP!
echo   Chi can ra Desktop nhap dup chuot vao "Fast Edit" la mo app ngay!
echo ========================================================
echo.
pause
`;
fs.writeFileSync(path.join(destDir, 'Tao_Bieu_Tuong_Desktop.bat'), shortcutBat, 'utf8');

// 6. Tạo file Hướng dẫn siêu ngắn gọn và dễ hiểu cho Dì
const readmeText = `========================================================================
             HƯỚNG DẪN SỬ DỤNG PHẦN MỀM FAST EDIT
========================================================================

Chào bạn! Đây là ứng dụng cắt và ghép video bài giảng độc lập "Fast Edit".
Bạn KHÔNG CẦN cài đặt thêm bất kỳ phần mềm nào khác!

------------------------------------------------------------------------
CÁCH 1: MỞ TRỰC TIẾP (NHANH NHẤT)
------------------------------------------------------------------------
- Bạn chỉ cần nhấp đúp chuột vào tệp: FastEdit.exe (hoặc VuonBaiGiang.exe)
- Ứng dụng sẽ tự động mở lên thành một CỬA SỔ PHẦN MỀM RIÊNG BIỆT (như CapCut / Word),
  không có thanh địa chỉ web, không cần gõ link gì cả!

------------------------------------------------------------------------
CÁCH 2: TẠO BIỂU TƯỢNG RA NGOÀI MÀN HÌNH CHÍNH (DESKTOP)
------------------------------------------------------------------------
- Bấm đúp vào tệp: Tao_Bieu_Tuong_Desktop.bat
- Ngay lập tức ngoài màn hình Desktop sẽ có biểu tượng "Fast Edit" màu xanh tím với tia sét.
- Lần sau cứ bấm vào biểu tượng ngoài Desktop là dùng được ngay!

------------------------------------------------------------------------
TÍNH NĂNG CHÍNH CỦA FAST EDIT:
------------------------------------------------------------------------
1. [Cắt Video Siêu Tốc]:
   - Tải video lên -> Kéo 2 đầu thanh trắng trên thanh sóng âm (hoặc bấm [In] và [Out])
   - Bấm "▶ Xem thử đoạn này" để duyệt trước
   - Bấm "Cắt phân đoạn ngay": Chỉ mất 1 giây là xong, giữ nguyên 100% độ nét gốc!

2. [Ghép Nhiều Video]:
   - Bấm chọn các video cần ghép vào danh sách timeline.
   - Bấm "⚡ Ghép siêu tốc": Ghép xong toàn bộ trong vài giây!

Chúc bạn tạo được những video bài giảng thật hay và ưng ý!
`;
fs.writeFileSync(path.join(destDir, 'HUONG_DAN_CHO_DI.txt'), readmeText, 'utf8');

console.log('✓ Đóng gói hoàn tất tại: ' + destDir);
