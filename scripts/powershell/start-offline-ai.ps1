param(
  [string]$LinuxOllamaHost = "http://cyber.local:11434",
  [string]$OllamaModel = "qwen3.5:9b"
)

# Start the Windows Flask + React development environment using a Linux Ollama server.
# The script installs frontend dependencies when needed and creates/updates the
# Python uv virtual environment automatically.
#
# Override the defaults when needed:
#   .\scripts\powershell\start-offline-ai.ps1 -LinuxOllamaHost "http://192.168.1.100:11434" -OllamaModel "qwen3.5:9b"

$ErrorActionPreference = "Stop"

# scripts/powershell -> scripts -> repository root
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$serverDir = Join-Path $repoRoot "server-python"
$clientDir = Join-Path $repoRoot "client-react"
$venvDir = Join-Path $serverDir ".venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  throw "uv is required but was not found in PATH. Install uv and run this script again."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is required but was not found in PATH. Install Node.js/npm and run this script again."
}

if (-not (Test-Path (Join-Path $serverDir "app.py"))) {
  throw "server-python/app.py not found. Expected repository root at: $repoRoot"
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

Write-Host "AI Terminal Chat - Windows + Linux Ollama"
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
Write-Host "Preparing Python environment..."
if (-not (Test-Path $venvPython)) {
  Write-Host "Creating uv virtual environment..."
  Push-Location $serverDir
  try {
    uv venv .venv
  } finally {
    Pop-Location
  }
}

Write-Host "Installing/updating Python dependencies..."
Push-Location $serverDir
try {
  uv pip install --python $venvPython -r requirements.txt
} finally {
  Pop-Location
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
Write-Host "Starting Flask backend..."
$serverCommand = "Set-Location -LiteralPath '$serverDir'; & '$venvPython' app.py"
Start-Process powershell -ArgumentList "-NoExit", "-Command", $serverCommand

Write-Host "Starting React frontend..."
$clientCommand = "Set-Location -LiteralPath '$clientDir'; npm run dev"
Start-Process powershell -ArgumentList "-NoExit", "-Command", $clientCommand

Write-Host ""
Write-Host "Backend:  http://localhost:9000"
Write-Host "Frontend: http://localhost:3000"
Write-Host "Ollama:   $env:OLLAMA_HOST"
Write-Host ""
Write-Host "Two PowerShell windows were opened for Flask and React."
