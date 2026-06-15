@echo off
SET PATH=C:\Program Files\nodejs;%PATH%
cd /d "D:\ShopeeScope\Vinus-SS\scraper"
echo Installing Chrome channel for Playwright...
npx playwright install chrome
echo Done! Next: node daily.js --login   (log in once), then powershell -ExecutionPolicy Bypass -File install-task.ps1
