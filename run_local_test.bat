@echo off
setlocal
cd /d "%~dp0"

set "PORT=4193"
set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

"%NODE_EXE%" --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Khong tim thay Node.js. Hay kiem tra runtime\node.exe.
    pause
    exit /b 1
)

echo Dang mo ban kiem tra Fast Edit tai http://127.0.0.1:4193
echo Dong cua so server nay hoac nhan Ctrl+C de dung ban kiem tra.
start "Fast Edit - Local Test Server" "%NODE_EXE%" server.mjs
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:4193"

endlocal
