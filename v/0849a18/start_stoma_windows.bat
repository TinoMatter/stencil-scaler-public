@echo off
setlocal
cd /d "%~dp0"
set PORT=8765
set ROOT=%CD%

where powershell >nul 2>nul
if %ERRORLEVEL%==0 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_stoma_windows.ps1" -Port %PORT% -Root "%ROOT%"
  goto :eof
)

echo PowerShell not found. Trying Python fallback...

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  start "" http://127.0.0.1:%PORT%/index.html
  py -m http.server %PORT%
  goto :eof
)

where python >nul 2>nul
if %ERRORLEVEL%==0 (
  start "" http://127.0.0.1:%PORT%/index.html
  python -m http.server %PORT%
  goto :eof
)

echo No PowerShell and no Python found.
echo Install PowerShell 5+ or Python 3 and retry.
pause
exit /b 1