@echo off
REM ShopeeScope - first-time setup wizard (attach-to-real-Chrome mode). Double-click me.
setlocal
SET PATH=C:\Program Files\nodejs;%PATH%
cd /d "%~dp0"

echo ============================================================
echo   ShopeeScope - First Time Setup
echo ============================================================
echo.
echo This will:
echo   1. Open a "scraper Chrome" window (your real Chrome, debug mode)
echo   2. Let you log into Shopee in that window (once)
echo   3. Run a small test (2 shops)
echo   4. Schedule it to run automatically every hour
echo.
echo Tip: you can re-run this file any time. It is safe.
echo.
pause
echo.

echo [1/4] Opening the scraper Chrome window...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-chrome-debug.ps1"
echo.
echo [2/4] Log into Shopee in the Chrome window that just opened.
echo       (If it is already logged in, just continue.)
echo       When you are logged in and see the normal Shopee homepage,
echo       come BACK here and press ENTER.
echo.
pause
echo.

echo [3/4] Running a quick test on 2 shops...
node daily.js --once --max-shops=2
echo.
echo      If you saw "products: ... saved" above, it works!
echo      If you saw "blocked" / "verify", tell Claude what you saw.
echo.

echo [4/4] Schedule automatic hourly runs?
set /p DOSCHED="   Type Y then ENTER to schedule (or N to skip): "
if /i "%DOSCHED%"=="Y" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-task.ps1"
) else (
  echo   Skipped. You can schedule later by running install-task.ps1
)
echo.
echo ============================================================
echo   Done. Keep the scraper Chrome window open (you can minimize it).
echo   You can close THIS black window.
echo ============================================================
pause
endlocal
