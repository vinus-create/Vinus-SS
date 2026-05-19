# ShopeeScope — Auto Scraper
# Runs all 13 shops sequentially using your home Malaysian IP
# Triggered by Windows Task Scheduler: on boot + every 2 hours

$ProjectDir = "C:\Users\cws98\Downloads\Vinus-SS\scraper"
$LogFile    = "$ProjectDir\scrape.log"

# Load env vars from .env file
$EnvFile = "$ProjectDir\.env"
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match "^\s*([^#][^=]+)=(.+)$") {
            [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), "Process")
        }
    }
}

$Shops = @(
    "buddysnack", "winstartech", "1stopbatteries", "icare4allshop",
    "energizerbatteryhub", "gadgetspecialist", "gou.ori", "tenbucksfood",
    "dsconcept_store", "sxmixempire", "r_in_g", "nextgenhardware.os", "ham_radios.my"
)

$Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content $LogFile "`n========== $Timestamp =========="

$Success = 0
$Failed  = 0

foreach ($Shop in $Shops) {
    Write-Host "🏪 Scraping: $Shop" -ForegroundColor Cyan
    $env:SHOP_NAME = $Shop

    $Output = node "$ProjectDir\scrape.js" 2>&1
    $ExitCode = $LASTEXITCODE

    Add-Content $LogFile "[$Shop] exit=$ExitCode"
    $Output | ForEach-Object { Add-Content $LogFile "  $_" }

    if ($ExitCode -eq 0) {
        Write-Host "  ✅ Done" -ForegroundColor Green
        $Success++
    } else {
        Write-Host "  ❌ Failed" -ForegroundColor Red
        $Failed++
    }

    # 每家店之间随机等待 30-90 秒，模拟真人行为
    $Wait = Get-Random -Minimum 30 -Maximum 90
    Write-Host "  ⏳ 等待 ${Wait}s..." -ForegroundColor DarkGray
    Start-Sleep -Seconds $Wait
}

$Summary = "✅ $Success/$($Shops.Count) shops scraped"
Write-Host "`n$Summary" -ForegroundColor Yellow
Add-Content $LogFile $Summary
