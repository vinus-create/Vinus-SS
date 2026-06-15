# ShopeeScope — manual "scrape all pending shops now" (one-off, foreground).
# The hourly automation is install-task.ps1 + run-scraper.ps1; use this only when
# you want to force a full sweep immediately.
#
# NOTE: replaces the old per-shop scrape.js loop, which launched the LIVE Chrome
# profile and failed with "profile already in use". daily.js uses a dedicated
# profile and resume instead.

$ErrorActionPreference = 'Continue'
$Dir  = 'D:\ShopeeScope\Vinus-SS\scraper'
$Node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $Node)) { $Node = 'node' }
Set-Location $Dir

# A big per-run cap = do every pending shop in this single invocation.
& $Node (Join-Path $Dir 'daily.js') --max-shops=99
Write-Host "exit=$LASTEXITCODE"
