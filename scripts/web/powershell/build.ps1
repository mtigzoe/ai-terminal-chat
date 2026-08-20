$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "../../../client-react")

npm run build
