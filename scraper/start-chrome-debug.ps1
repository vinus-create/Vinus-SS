# ShopeeScope - start the "scraper Chrome": a NORMAL Chrome (no automation flags)
# with a remote-debugging port that daily.js attaches to. Because Chrome is started
# normally (not by Playwright), Shopee sees a genuine browser, which sidesteps the
# crawler block a fresh automated browser triggers.
#
# Uses a DEDICATED profile so it runs alongside your everyday Chrome without conflict.
# Log into Shopee in this window ONCE; the session persists in this profile.

$Port        = 9222
$ProfileDir  = 'D:\ShopeeScope\chrome-debug-profile'

$candidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$Chrome = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Chrome) { Write-Error "Chrome not found. Install Google Chrome."; exit 1 }

# Already running on this port? (a debug Chrome with our profile is up) -> do nothing.
$alive = $false
try { $alive = (Invoke-WebRequest "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch {}
if ($alive) { Write-Host "Scraper Chrome already running on port $Port." -ForegroundColor Green; return }

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
Start-Process $Chrome -ArgumentList @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$ProfileDir",
  '--no-first-run',
  '--no-default-browser-check',
  '--start-maximized',
  'https://shopee.com.my/'
)
Write-Host "Started scraper Chrome on port $Port (profile: $ProfileDir)." -ForegroundColor Green
Write-Host "If this is the first time, log into Shopee in that window." -ForegroundColor Yellow
