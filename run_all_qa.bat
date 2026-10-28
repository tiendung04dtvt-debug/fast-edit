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

"%NODE_EXE%" scripts\full_qa_test.mjs
echo.
echo Kiem tra da ket thuc. Project QA tam da duoc don.
pause
endlocal
