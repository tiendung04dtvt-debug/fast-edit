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

echo [1/2] Kiểm tra mã nguồn...
git status -s

echo.
echo [2/2] Đang đẩy lên GitHub (https://github.com/tiendung04dtvt-debug/fast-edit)...
echo Nếu trình duyệt hiện cửa sổ đăng nhập GitHub, bạn chỉ cần ấn "Authorize" một lần duy nhất.
echo.
git push -u origin main

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ======================================================================
    echo  🎉 XUẤT BẢN THÀNH CÔNG LÊN GITHUB!
    echo  Máy của Dì mở Fast Edit lên sẽ thấy thông báo cập nhật v1.1.0 ngay lập tức!
    echo ======================================================================
) else (
    echo.
    echo ⚠️ Đẩy lên GitHub chưa thành công.
    echo Gợi ý: Hãy kiểm tra kết nối mạng hoặc đăng nhập tài khoản tiendung04dtvt-debug.
)

echo.
pause
