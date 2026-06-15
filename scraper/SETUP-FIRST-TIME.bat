@echo off
REM ShopeeScope - first-time setup wizard. Just double-click this file.
setlocal
SET PATH=C:\Program Files\nodejs;%PATH%
cd /d "%~dp0"

echo ============================================================
echo   ShopeeScope - First Time Setup
echo ============================================================
echo.
echo This will:
echo   1. Install the browser the scraper drives
echo   2. Open Shopee so you can log in once
echo   3. Run a small test (2 shops)
echo   4. Schedule it to run automatically every hour
echo.
echo Tip: you can re-run this file any time. It is safe.
echo.
pause
echo.

echo [1/4] Installing browser (this can take a minute)...
call npx playwright install chrome
echo.

echo [2/4] Opening Shopee to log in...
echo      A Chrome window will open. Log into your Shopee account,
echo      then come BACK to this black window and press ENTER.
echo.
node daily.js --login
echo.

echo [3/4] Running a quick test on 2 shops...
echo      A minimized Chrome may appear - leave it alone.
node daily.js --once --max-shops=2
echo.
echo      Test done. If you saw "products: ... saved" above, it works.
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
echo   All done. You can close this window.
echo ============================================================
pause
endlocal
