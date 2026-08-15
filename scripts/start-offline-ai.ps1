param(
  [string]$LinuxOllamaHost = "http://cyber.local:11434",
  [string]$OllamaModel = "qwen3.5:9b"
)

# Start the Windows Flask + React development environment using a Linux Ollama server.
# Override the defaults when needed:
#   .\scripts\start-offline-ai.ps1 -LinuxOllamaHost "http://192.168.1.100:11434" -OllamaModel "qwen3.5:9b"

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $repoRoot "server-python"
$clientDir = Join-Path $repoRoot "client-react"

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
Write-Host "Starting Flask backend..."
$serverCommand = "Set-Location -LiteralPath '$serverDir'; python app.py"
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
