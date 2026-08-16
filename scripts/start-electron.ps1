# Launch the Electron desktop shell for AI Terminal Chat (Stage 1).
#
# Prerequisites:
#   - Flask backend already running (e.g. python app.py in server-python)
#   - Node.js / npm available on PATH
#
# Behaviour:
#   1. Ensures frontend dependencies are installed (including electron).
#   2. Starts the Vite development server in a new PowerShell window if
#      nothing is already listening on port 3000.
#   3. Launches Electron, which loads http://localhost:3000.
#
# Usage (from repository root):
#   .\scripts\start-electron.ps1
#
# The browser-based workflow (npm run dev alone) is unaffected.

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$clientDir = Join-Path $repoRoot "client-react"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is required but was not found in PATH. Install Node.js/npm and run this script again."
}

if (-not (Test-Path (Join-Path $clientDir "package.json"))) {
  throw "client-react/package.json not found. Run this script from a complete checkout of the repository."
}

Write-Host "AI Terminal Chat - Electron (Stage 1)"
Write-Host "Client directory: $clientDir"
Write-Host ""

Set-Location $clientDir

# Install dependencies when node_modules is missing or electron is not present.
$needsInstall = $false
if (-not (Test-Path (Join-Path $clientDir "node_modules"))) {
  $needsInstall = $true
} elseif (-not (Test-Path (Join-Path $clientDir "node_modules\electron"))) {
  $needsInstall = $true
}

if ($needsInstall) {
  Write-Host "Installing frontend dependencies (including electron)..."
  npm install
  if ($LASTEXITCODE -ne 0) {
    throw "npm install failed."
  }
  Write-Host ""
}

# Check whether Vite is already serving on port 3000.
$portInUse = $false
try {
  $listener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
  if ($listener) {
    $portInUse = $true
  }
} catch {
  # Fallback for environments without Get-NetTCPConnection.
  $test = Test-NetConnection -ComputerName "127.0.0.1" -Port 3000 -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
  if ($test -and $test.TcpTestSucceeded) {
    $portInUse = $true
  }
}

if (-not $portInUse) {
  Write-Host "Starting Vite development server on port 3000 in a new window..."
  Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$clientDir'; npm run dev"
  Write-Host "Waiting a few seconds for Vite to become ready..."
  Start-Sleep -Seconds 4
} else {
  Write-Host "Port 3000 is already in use; assuming Vite is running."
}

Write-Host "Launching Electron..."
Write-Host "(Ensure the Flask backend is running at http://127.0.0.1:9000)"
Write-Host ""

npm run electron
if ($LASTEXITCODE -ne 0) {
  throw "Electron exited with code $LASTEXITCODE."
}
