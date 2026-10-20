# Compatibility entry point; TypeScript is the primary backend.
$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "run-electron-ts.ps1") @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
