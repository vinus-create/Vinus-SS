@echo off
REM ShopeeScope - Scrapling (stealth) setup + test. Double-click me.
setlocal
SET VPY=D:\ShopeeScope\scraper-venv\Scripts\python.exe
cd /d "%~dp0"

if not exist "%VPY%" (
  echo ERROR: Scrapling venv not found at %VPY%
  echo Run the install steps first.
  pause
  exit /b 1
)

echo ============================================================
echo   ShopeeScope - Scrapling (stealth Chromium) setup
echo ============================================================
echo.
echo Best run when your IP is NOT freshly rate-limited (e.g. first thing,
echo before other scraping attempts).
echo.
pause
echo.

echo [1/2] Opening Shopee to log in (stealth window)...
echo       Log into Shopee in the window, then press ENTER in THIS window.
"%VPY%" daily_scrapling.py --login
echo.

echo [2/2] Testing a 1-shop scrape through the logged-in stealth browser...
"%VPY%" daily_scrapling.py --once --max-shops=1
echo.
echo   If you saw "products: N saved" it works.
echo   If you saw "blocked" / "captcha", your IP is likely still rate-limited - try later.
echo.
pause
endlocal
