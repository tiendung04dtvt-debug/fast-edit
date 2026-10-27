@echo off
setlocal
cd /d "%~dp0"

set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

set "HF_HOME=%~dp0projects\_models"
if exist "%HF_HOME%\.offline-cache" set "HF_HUB_OFFLINE=1"

if exist "%~dp0runtime\ffmpeg.exe" set "FFMPEG_PATH=%~dp0runtime\ffmpeg.exe"
if exist "%~dp0ffmpeg\bin\ffmpeg.exe" set "FFMPEG_PATH=%~dp0ffmpeg\bin\ffmpeg.exe"

"%NODE_EXE%" --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please verify runtime\node.exe.
    pause
    exit /b 1
)

:: Khoi dong server ngam
start "Vuon Bai Giang - Server" /min cmd /c ""%NODE_EXE%" server.mjs"
ping -n 3 127.0.0.1 >nul

:: Mo giao dien o che do Cua so App rieng biet (Native Desktop App Window)
set "EDGE_PATH="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE_PATH=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE_PATH=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%LocalAppData%\Microsoft\Edge\Application\msedge.exe" set "EDGE_PATH=%LocalAppData%\Microsoft\Edge\Application\msedge.exe"

if defined EDGE_PATH (
    start "" "%EDGE_PATH%" --app="http://127.0.0.1:4177" --window-size=1300,850
) else (
    start "" http://127.0.0.1:4177
)

endlocal
