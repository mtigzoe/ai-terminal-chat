# Development helper: start Vite (if needed) and Electron only.
# Does not start or manage the Flask backend.
#
# Usage (from repository root):
#   .\scripts\start-electron-dev.ps1
#
# Typical workflow:
#   1. Start backend:  cd server-python; python app.py
#   2. Run this script.

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$clientDir = Join-Path $repoRoot "client-react"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is required but was not found in PATH. Install Node.js/npm and run this script again."
}

if (-not (Test-Path (Join-Path $clientDir "package.json"))) {
  throw "client-react/package.json not found."
}

Set-Location $clientDir

if (-not (Test-Path (Join-Path $clientDir "node_modules\electron"))) {
  Write-Host "Installing frontend dependencies (including electron)..."
  npm install
  if ($LASTEXITCODE -ne 0) {
    throw "npm install failed."
  }
}

$portInUse = $false
try {
  $listener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
  if ($listener) { $portInUse = $true }
} catch {
  $test = Test-NetConnection -ComputerName "127.0.0.1" -Port 3000 -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
  if ($test -and $test.TcpTestSucceeded) { $portInUse = $true }
}

if (-not $portInUse) {
  Write-Host "Starting Vite development server..."
  Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$clientDir'; npm run dev"
  Start-Sleep -Seconds 4
} else {
  Write-Host "Vite appears to be already running on port 3000."
}

Write-Host "Launching Electron (backend must already be running)..."
npm run electron
