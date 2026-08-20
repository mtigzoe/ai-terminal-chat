$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "../../../")

npm run electron:dev
