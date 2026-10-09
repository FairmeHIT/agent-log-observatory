@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\services.ps1" -Action stop -Component all
if errorlevel 1 (
  pause
  exit /b 1
)
endlocal
