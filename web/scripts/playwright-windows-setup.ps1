# ============================================================
# Playwright Remote Browser Service — Windows Setup
# ============================================================
# Run this ONCE in PowerShell as Administrator.
#
# What it does:
#   1. Installs playwright + @playwright/cli + Chromium
#   2. Registers `npx playwright run-server` as an auto-start task
#   3. Opens firewall for LAN only
#
# After setup:
#   - Browser server auto-starts at login on port 3100
#   - Claude connects from the Linux VM via WebSocket
#   - You watch/steer via: playwright-cli show
#   - Claude controls via: playwright-cli goto/click/snapshot etc.
#
# Security model:
#   - Only browser automation exposed (no shell, no filesystem)
#   - Firewall: port 3100 open to 192.168.8.0/24 only
#   - Isolated browser profile (not your real Chrome)
# ============================================================

$ErrorActionPreference = "Stop"

# --- Step 1: Install packages ---
Write-Host "`n=== Step 1: Install packages ===" -ForegroundColor Cyan
npm install -g @playwright/cli playwright
npx playwright install chromium
Write-Host "Done." -ForegroundColor Green

# --- Step 2: Firewall rule (LAN only) ---
Write-Host "`n=== Step 2: Create firewall rule ===" -ForegroundColor Cyan
$ruleName = "Playwright Browser Server (LAN only)"
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
    Remove-NetFirewallRule -DisplayName $ruleName
}
New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 3100 `
    -RemoteAddress 192.168.8.0/24 `
    -Action Allow `
    -Profile Private | Out-Null
Write-Host "Firewall rule created (LAN only, port 3100)." -ForegroundColor Green

# --- Step 3: Register auto-start scheduled task ---
Write-Host "`n=== Step 3: Register auto-start task ===" -ForegroundColor Cyan

$taskName = "PlaywrightBrowserServer"

# Locate npx — the official CLI for running playwright run-server
$npxExe = (Get-Command npx).Source

# Remove existing task if present
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction `
    -Execute $npxExe `
    -Argument "playwright run-server --port 3100 --host 0.0.0.0"

$trigger = New-ScheduledTaskTrigger -AtLogon

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 365)

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Playwright headed browser server for remote agent testing (port 3100, LAN only)" `
    -RunLevel Highest | Out-Null

Write-Host "Scheduled task '$taskName' registered (starts at login)." -ForegroundColor Green

# --- Step 4: Start it now ---
Write-Host "`n=== Step 4: Start server now ===" -ForegroundColor Cyan
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 4

# --- Verify ---
$taskStatus = (Get-ScheduledTask -TaskName $taskName).State
Write-Host "`nTask status: $taskStatus" -ForegroundColor $(if ($taskStatus -eq "Running") { "Green" } else { "Yellow" })

Write-Host "`n=== Setup complete ===" -ForegroundColor Green
Write-Host @"

Playwright browser server is running on port 3100.

Management:
  playwright-cli show                  Watch/steer the browser live
  Get-ScheduledTask PlaywrightBrowserServer   Check status
  Stop-ScheduledTask PlaywrightBrowserServer  Stop server
  Start-ScheduledTask PlaywrightBrowserServer Restart server
  Unregister-ScheduledTask PlaywrightBrowserServer -Confirm:`$false  Uninstall

"@

$ip = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -like "192.168.8.*" }).IPAddress
if ($ip) {
    Write-Host "Your Windows IP: $ip" -ForegroundColor Yellow
    Write-Host "Linux VM config should have: ws://${ip}:3100" -ForegroundColor Yellow
} else {
    Write-Host "Could not detect 192.168.8.x IP — check ipconfig manually." -ForegroundColor Yellow
}
