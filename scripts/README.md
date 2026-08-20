# Project scripts

Scripts are organized by application and shell environment.

## Electron

- `scripts/electron/powershell/` — Windows PowerShell scripts for the Electron app.
- `scripts/electron/sh/` — Linux/macOS shell scripts for the Electron app.

## Web

- `scripts/web/powershell/` — Windows PowerShell scripts for the React web app.
- `scripts/web/sh/` — Linux/macOS shell scripts for the React web app.

## Makefile support

- `scripts/makefile/powershell/` — PowerShell helpers used by Makefile workflows.
- `scripts/makefile/sh/` — shell helpers used by Makefile workflows.

The root `Makefile` remains at the repository root. Windows users do not need Make; use the PowerShell scripts when appropriate.

## Current development scripts

Electron development:

```powershell
.\scripts\electron\powershell\dev.ps1
```

```bash
./scripts/electron/sh/dev.sh
```

Web development:

```powershell
.\scripts\web\powershell\dev.ps1
```

```bash
./scripts/web/sh/dev.sh
```

Makefile test helpers:

```powershell
.\scripts\makefile\powershell\test.ps1
```

```bash
./scripts/makefile/sh/test.sh
```
