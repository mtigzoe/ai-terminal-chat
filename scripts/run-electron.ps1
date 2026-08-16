# Simple Windows launcher for the Electron development app.
#
# Use this when you want one command to start the backend, Vite, and Electron.
# The existing start-electron.ps1 performs the environment/dependency setup and
# waits for ports 9000 and 3000 before launching Electron.
#
# Usage (from repository root):
#   .\scripts\run-electron.ps1

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot "start-electron.ps1"

if (-not (Test-Path $launcher)) {
    throw "Electron launcher not found: $launcher"
}

Write-Host "Starting AI Terminal Chat Electron app..."
Write-Host ""
Write-Host "This will start the Flask backend on port 9000 and Vite on port 3000"
Write-Host "when they are not already running, then launch Electron."
Write-Host ""

& $launcher

if ($LASTEXITCODE -ne 0) {
    throw "Electron launcher exited with code $LASTEXITCODE."
}
