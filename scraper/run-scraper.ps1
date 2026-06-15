# ShopeeScope — scheduled launcher (called by Task Scheduler)
# Runs one scrape slot and appends output to scrape.log. Keep this dumb; all
# logic lives in daily.js.

$ErrorActionPreference = 'Continue'
$Dir = 'D:\ShopeeScope\Vinus-SS\scraper'
$Log = Join-Path $Dir 'scrape.log'
$Node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $Node)) { $Node = 'node' }   # fall back to PATH

Set-Location $Dir

# Rotate log if it grows past ~5 MB (keep one .old)
if ((Test-Path $Log) -and ((Get-Item $Log).Length -gt 5MB)) {
    Move-Item $Log "$Log.old" -Force
}

$Stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Add-Content $Log "`n========== $Stamp (scheduled) =========="

# Run daily.js; capture stdout+stderr into the log.
& $Node (Join-Path $Dir 'daily.js') 2>&1 | ForEach-Object { Add-Content $Log ("  " + $_) }

Add-Content $Log "  exit=$LASTEXITCODE"
