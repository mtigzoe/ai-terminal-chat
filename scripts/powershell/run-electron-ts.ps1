# Simple Windows launcher for the Electron development app, backed by the
# TypeScript API server instead of the Python/Flask one.
#
# Use this when you want one command to start the TypeScript backend, Vite,
# and Electron in development mode. The development launcher keeps Electron
# pointed at http://localhost:3000 rather than the production dist/ build.
#
# Usage (from repository root):
#   .\scripts\powershell\run-electron-ts.ps1

$ErrorActionPreference = "Stop"

$devLauncher = Join-Path $PSScriptRoot "start-electron-ts.ps1"

if (-not (Test-Path $devLauncher)) {
    throw "Electron development launcher not found: $devLauncher"
}

Write-Host "Starting AI Terminal Chat Electron development app (TypeScript backend)..."
Write-Host ""
Write-Host "This will start the TypeScript backend on port 9000 and Vite on port 3000"
Write-Host "when they are not already running, then launch Electron in development mode."
Write-Host ""

& $devLauncher

if ($LASTEXITCODE -ne 0) {
    throw "Electron development launcher exited with code $LASTEXITCODE."
}
