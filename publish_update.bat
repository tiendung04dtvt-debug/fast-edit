@echo off
chcp 65001 >nul
title Fast Edit - Xuất bản cập nhật lên GitHub
cls
echo ======================================================================
echo          🚀 XUẤT BẢN BẢN CẬP NHẬT FAST EDIT LÊN GITHUB
echo ======================================================================
echo.
echo Khi bạn đẩy bản mới lên, máy của Dì sẽ tự động nhận được thông báo
echo và chỉ cần 1 click là cập nhật xong (chưa tới 2 giây)!
echo.

set GIT_CMD="C:\Users\OS\AppData\Local\Microsoft\WinGet\Packages\Git.MinGit_Microsoft.Winget.Source_8wekyb3d8bbwe\cmd\git.exe"
if not exist %GIT_CMD% (
    set GIT_CMD=git
)

set /p NOTE="👉 Nhập nội dung cập nhật (hoặc ấn Enter để dùng mặc định): "
if "%NOTE%"=="" set NOTE=Cập nhật tính năng và giao diện mới

echo.
echo [1/3] Đang cập nhật số phiên bản trong version.json...
.\runtime\node.exe -e "
import fs from 'node:fs';
let v = { version: '1.0.0', notes: '' };
try { v = JSON.parse(fs.readFileSync('version.json', 'utf8')); } catch {}
const parts = (v.version || '1.0.0').split('.');
parts[2] = parseInt(parts[2] || 0) + 1;
v.version = parts.join('.');
v.updatedAt = new Date().toISOString();
v.notes = process.env.UPDATE_NOTE || '%NOTE%';
fs.writeFileSync('version.json', JSON.stringify(v, null, 2), 'utf8');
console.log('    -> Đã nâng lên phiên bản: v' + v.version);
"

echo.
echo [2/3] Đang lưu trữ thay đổi mã nguồn...
%GIT_CMD% add .
%GIT_CMD% commit -m "%NOTE%"

echo.
echo [3/3] Đang đẩy lên GitHub (https://github.com/tiendung04dtvt-debug/fast-edit)...
%GIT_CMD% push origin main

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ======================================================================
    echo  🎉 XUẤT BẢN THÀNH CÔNG!
    echo  Máy của Dì mở app lên hoặc ấn nút 'Bản v...' sẽ tự động nâng cấp ngay!
    echo ======================================================================
) else (
    echo.
    echo ⚠️ Đẩy lên GitHub thất bại. Hãy kiểm tra kết nối mạng hoặc quyền truy cập.
)

echo.
pause
