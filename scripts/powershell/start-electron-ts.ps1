# Launch the Electron desktop development environment for AI Terminal Chat,
# backed by the TypeScript API server instead of the Python/Flask one.
#
# Starts the TypeScript backend and Vite automatically when they are not
# already listening, then launches Electron. The Electron renderer uses Vite
# at http://localhost:3000 while the backend serves the API at port 9000.
#
# Usage (from repository root):
#   .\scripts\powershell\start-electron-ts.ps1

$ErrorActionPreference = "Stop"

# scripts/powershell -> scripts -> repository root
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$serverDir = Join-Path $repoRoot "server-typescript"
$clientDir = Join-Path $repoRoot "client-react"

function Test-Port([int]$Port) {
  try {
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return [bool]$listener
  } catch {
    $test = Test-NetConnection -ComputerName "127.0.0.1" -Port $Port -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
    return [bool]($test -and $test.TcpTestSucceeded)
  }
}

function Wait-Port([int]$Port, [string]$Name) {
  for ($i = 0; $i -lt 30; $i++) {
    if (Test-Port $Port) {
      Write-Host "$Name is ready on port $Port."
      return
    }
    Start-Sleep -Seconds 1
  }
  throw "$Name did not become ready on port $Port within 30 seconds."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is required but was not found in PATH. Install Node.js/npm and run this script again."
}
if (-not (Test-Path (Join-Path $serverDir "package.json"))) {
  throw "server-typescript/package.json not found. Expected repository root at: $repoRoot"
}
if (-not (Test-Path (Join-Path $clientDir "package.json"))) {
  throw "client-react/package.json not found. Expected repository root at: $repoRoot"
}

Write-Host "AI Terminal Chat - Electron (TypeScript backend)"
Write-Host ""

if (-not (Test-Path (Join-Path $serverDir "node_modules"))) {
  Write-Host "Installing TypeScript backend dependencies..."
  Push-Location $serverDir
  try { npm install; if ($LASTEXITCODE -ne 0) { throw "npm install failed." } } finally { Pop-Location }
}

Push-Location $clientDir
try {
  if (-not (Test-Path (Join-Path $clientDir "node_modules\electron"))) {
    Write-Host "Installing frontend dependencies..."
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
  }
} finally { Pop-Location }

$backendStarted = $false
$frontendStarted = $false
$backendProcess = $null
$frontendProcess = $null

try {
  if (-not (Test-Port 9000)) {
    Write-Host "Starting TypeScript backend (tsx watch)..."
    $backendCommand = "Set-Location -LiteralPath '$serverDir'; npm run dev"
    $backendProcess = Start-Process powershell -ArgumentList "-NoExit", "-Command", $backendCommand -PassThru
    $backendStarted = $true
    Wait-Port 9000 "TypeScript backend"
  } else {
    Write-Host "A backend is already running on port 9000."
  }

  if (-not (Test-Port 3000)) {
    Write-Host "Starting Vite development server..."
    $frontendCommand = "Set-Location -LiteralPath '$clientDir'; npm run dev"
    $frontendProcess = Start-Process powershell -ArgumentList "-NoExit", "-Command", $frontendCommand -PassThru
    $frontendStarted = $true
    Wait-Port 3000 "Vite"
  } else {
    Write-Host "Vite is already running on port 3000."
  }

  Write-Host ""
  Write-Host "Launching Electron..."
  Push-Location $clientDir
  try { npm run electron:dev } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw "Electron exited with code $LASTEXITCODE." }
}
finally {
  # Only stop processes started by this script. Existing services are left alone.
  if ($frontendStarted -and $frontendProcess) {
    taskkill /PID $frontendProcess.Id /T /F 2>$null | Out-Null
  }
  if ($backendStarted -and $backendProcess) {
    taskkill /PID $backendProcess.Id /T /F 2>$null | Out-Null
  }
}
