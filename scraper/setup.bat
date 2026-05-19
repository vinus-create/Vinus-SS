@echo off
SET PATH=C:\Program Files\nodejs;%PATH%
cd /d "C:\Users\cws98\Downloads\Vinus-SS\scraper"
echo Installing Playwright Chromium...
npx playwright install chromium
echo Done!
