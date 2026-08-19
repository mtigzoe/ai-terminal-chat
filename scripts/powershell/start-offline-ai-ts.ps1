param(
  [string]$LinuxOllamaHost = "http://cyber.local:11434",
  [string]$OllamaModel = "qwen3.5:9b"
)

# Start the Windows TypeScript backend + React development environment using
# a Linux Ollama server. The script installs backend and frontend
# dependencies when needed.
#
# Override the defaults when needed:
#   .\scripts\powershell\start-offline-ai-ts.ps1 -LinuxOllamaHost "http://192.168.1.100:11434" -OllamaModel "qwen3.5:9b"

$ErrorActionPreference = "Stop"

# scripts/powershell -> scripts -> repository root
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$serverDir = Join-Path $repoRoot "server-typescript"
$clientDir = Join-Path $repoRoot "client-react"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is required but was not found in PATH. Install Node.js/npm and run this script again."
}

if (-not (Test-Path (Join-Path $serverDir "package.json"))) {
  throw "server-typescript/package.json not found. Expected repository root at: $repoRoot"
}
if (-not (Test-Path (Join-Path $clientDir "package.json"))) {
  throw "client-react/package.json not found. Expected repository root at: $repoRoot"
}

$ollamaHost = $LinuxOllamaHost.TrimEnd('/')
$ollamaBaseUrl = "$ollamaHost/v1"

$env:PROVIDER = "ollama"
$env:OLLAMA_HOST = $ollamaHost
$env:OLLAMA_BASE_URL = $ollamaBaseUrl
$env:OLLAMA_MODEL = $OllamaModel

Write-Host "AI Terminal Chat - Windows + Linux Ollama (TypeScript backend)"
Write-Host "Ollama server: $env:OLLAMA_HOST"
Write-Host "Ollama model:  $env:OLLAMA_MODEL"
Write-Host ""

# Verify that the Linux Ollama server is reachable before starting the application.
$tagsUrl = "$ollamaHost/api/tags"
try {
  $response = Invoke-WebRequest -Uri $tagsUrl -Method Get -TimeoutSec 5 -UseBasicParsing
  if ($response.StatusCode -ne 200) {
    throw "Ollama returned HTTP $($response.StatusCode)."
  }
  Write-Host "Ollama server is reachable."
} catch {
  Write-Warning "Could not reach Ollama at $ollamaHost."
  Write-Warning "Make sure Ollama is running on Linux and reachable from Windows."
  Write-Warning "You can continue, but the backend will not be able to use the Ollama provider until it is available."
}

Write-Host ""
Write-Host "Preparing TypeScript backend..."
if (-not (Test-Path (Join-Path $serverDir "node_modules"))) {
  Write-Host "Installing backend dependencies with npm..."
  Push-Location $serverDir
  try {
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
  } finally {
    Pop-Location
  }
} else {
  Write-Host "Backend dependencies already installed; skipping npm install."
}

if (-not (Test-Path (Join-Path $clientDir "node_modules"))) {
  Write-Host "Installing React dependencies with npm..."
  Push-Location $clientDir
  try {
    npm install
  } finally {
    Pop-Location
  }
} else {
  Write-Host "React dependencies already installed; skipping npm install."
}

Write-Host ""
Write-Host "Starting TypeScript backend..."
$serverCommand = "Set-Location -LiteralPath '$serverDir'; npm run dev"
Start-Process powershell -ArgumentList "-NoExit", "-Command", $serverCommand

Write-Host "Starting React frontend..."
$clientCommand = "Set-Location -LiteralPath '$clientDir'; npm run dev"
Start-Process powershell -ArgumentList "-NoExit", "-Command", $clientCommand

Write-Host ""
Write-Host "Backend:  http://localhost:9000"
Write-Host "Frontend: http://localhost:3000"
Write-Host "Ollama:   $env:OLLAMA_HOST"
Write-Host ""
Write-Host "Two PowerShell windows were opened for the TypeScript backend and React."
