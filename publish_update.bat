@echo off
title Fast Edit - Xuat ban cap nhat len GitHub
cls
echo ======================================================================
echo          XUAT BAN BAN CAP NHAT FAST EDIT LEN GITHUB
echo ======================================================================
echo.
echo [1/2] Kiem tra ma nguon...
git status -s

echo.
echo [2/2] Dang day len GitHub: https://github.com/tiendung04dtvt-debug/fast-edit
echo Neu trinh duyet hien cua so dang nhap GitHub, ban chi can an "Authorize" 1 lan.
echo.
git push -u origin main

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ======================================================================
    echo  XUAT BAN THANH CONG LEN GITHUB!
    echo  May cua Di mo Fast Edit len se thay thong bao cap nhat v1.1.0 ngay!
    echo ======================================================================
) else (
    echo.
    echo Day len GitHub chua thanh cong.
    echo Hay kiem tra ket noi mang hoac dang nhap tai khoan tiendung04dtvt-debug.
)

echo.
pause
