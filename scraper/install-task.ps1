# ShopeeScope — register the unattended daily scraper as a Windows Scheduled Task.
# Run once (normal user, no admin needed):
#     powershell -ExecutionPolicy Bypass -File .\install-task.ps1
#
# Creates "ShopeeScope Daily Scraper": fires hourly from 08:00, wakes the PC from
# sleep, catches up a missed slot, and won't start a second copy if one is running.
# daily.js itself only scrapes a few pending shops per slot (resume-aware), so the
# day's shops complete across the hourly slots. Remove with:
#     Unregister-ScheduledTask -TaskName 'ShopeeScope Daily Scraper' -Confirm:$false

$ErrorActionPreference = 'Stop'
$TaskName = 'ShopeeScope Daily Scraper'
$Dir      = 'D:\ShopeeScope\Vinus-SS\scraper'
$Launcher = Join-Path $Dir 'run-scraper.ps1'

if (-not (Test-Path $Launcher)) { throw "Launcher not found: $Launcher" }

$Action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Launcher`""

# Hourly, all day, starting at the next 08:00; repeat effectively forever.
$Trigger = New-ScheduledTaskTrigger -Once -At ([DateTime]::Today.AddHours(8)) `
    -RepetitionInterval (New-TimeSpan -Hours 1) `
    -RepetitionDuration ([TimeSpan]::FromDays(3650))

$Settings = New-ScheduledTaskSettingsSet `
    -WakeToRun `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -MultipleInstances IgnoreNew

# Run as the current interactive user so the (minimized) Chrome window has a session.
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger `
    -Settings $Settings -Principal $Principal -Force | Out-Null

# --- Also auto-start the "scraper Chrome" at logon so daily.js always has a browser
# to attach to (CDP mode). It's a normal Chrome on a debug port with a dedicated profile.
$ChromeTask = 'ShopeeScope Debug Chrome'
$ChromeLauncher = Join-Path $Dir 'start-chrome-debug.ps1'
$ChromeAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ChromeLauncher`""
$ChromeTrigger = New-ScheduledTaskTrigger -AtLogOn
$ChromeSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $ChromeTask -Action $ChromeAction -Trigger $ChromeTrigger `
    -Settings $ChromeSettings -Principal $Principal -Force | Out-Null
Write-Host "✅ Registered '$ChromeTask' (starts your scraper Chrome at logon)" -ForegroundColor Green

Write-Host "✅ Registered scheduled task: '$TaskName'" -ForegroundColor Green
Write-Host "   Hourly from 08:00, wakes from sleep, catches up missed runs." -ForegroundColor Gray
Write-Host ""
Write-Host "   Run now to test:   Start-ScheduledTask -TaskName '$TaskName'" -ForegroundColor Gray
Write-Host "   View history:      Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo" -ForegroundColor Gray
Write-Host "   Remove:            Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false" -ForegroundColor Gray
Write-Host ""
Write-Host "   ⚠ First, log in once:  node daily.js --login" -ForegroundColor Yellow
