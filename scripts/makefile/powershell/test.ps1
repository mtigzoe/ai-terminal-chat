param(
    [ValidateSet("all", "python", "typescript", "react")]
    [string]$Target = "all"
)

$ErrorActionPreference = "Stop"

function Invoke-Test {
    param([string]$Name, [scriptblock]$Command)
    Write-Host "==> $Name"
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

switch ($Target) {
    "python" {
        Invoke-Test "server-python tests" { python -m pytest server-python/tests -q }
    }
    "typescript" {
        Push-Location server-typescript
        try {
            Invoke-Test "server-typescript typecheck" { npm run typecheck }
            Invoke-Test "server-typescript tests" { npm test -- --run }
        }
        finally { Pop-Location }
    }
    "react" {
        Push-Location client-react
        try {
            Invoke-Test "client-react tests" { npm test -- --run }
            Invoke-Test "client-react build" { npm run build }
        }
        finally { Pop-Location }
    }
    "all" {
        & $PSCommandPath python
        & $PSCommandPath typescript
        & $PSCommandPath react
    }
}
