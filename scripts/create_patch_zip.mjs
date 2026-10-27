import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const patchDir = 'D:\\FastEdit_Patch';
if (fs.existsSync(patchDir)) fs.rmSync(patchDir, { recursive: true, force: true });
fs.mkdirSync(patchDir, { recursive: true });

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const item of fs.readdirSync(src)) {
    const s = path.join(src, item);
    const d = path.join(dst, item);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

copyDir('D:\\VuonBaiGiang\\public', path.join(patchDir, 'public'));
fs.copyFileSync('D:\\VuonBaiGiang\\server.mjs', path.join(patchDir, 'server.mjs'));
fs.copyFileSync('D:\\VuonBaiGiang\\video_concat_planner.mjs', path.join(patchDir, 'video_concat_planner.mjs'));
fs.copyFileSync('D:\\VuonBaiGiang\\version.json', path.join(patchDir, 'version.json'));
fs.copyFileSync('D:\\VuonBaiGiang\\package.json', path.join(patchDir, 'package.json'));

const readme = `============================================================
   HƯỚNG DẪN KÍCH HOẠT TÍNH NĂNG CẬP NHẬT TỰ ĐỘNG
============================================================

Dì (hoặc bạn) chỉ cần:
1. Giải nén toàn bộ các file trong file zip này
2. Chép đè vào thư mục Fast Edit trên máy
3. Mở FastEdit.exe lên dùng bình thường!

Từ giây phút này trở đi, mỗi khi có tính năng mới:
- Ứng dụng sẽ tự hiện thông báo: "🚀 Có bản mới!"
- Dì chỉ cần ấn 1 click chuột vào nút [Bản v...] ở góc trên là ứng dụng tự nâng cấp xong trong 2 giây!
`;
fs.writeFileSync(path.join(patchDir, 'HUONG_DAN_CHO_DI.txt'), readme, 'utf8');

const zipDest = 'D:\\FastEdit_CapNhat_SieuNhe.zip';
if (fs.existsSync(zipDest)) fs.unlinkSync(zipDest);

execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${patchDir}\\*' -DestinationPath '${zipDest}'"`);
fs.rmSync(patchDir, { recursive: true, force: true });

const size = fs.statSync(zipDest).size;
console.log(`Đã tạo thành công bản vá siêu nhẹ: ${zipDest} (${(size / 1024).toFixed(1)} KB)`);
