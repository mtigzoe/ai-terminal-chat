# Startup and development scripts

Scripts are organized by purpose and shell environment. The original backend startup scripts remain under `scripts/powershell/` and `scripts/sh/` for compatibility. New application-focused entry points are grouped under `electron/`, `web/`, and `makefile/`.

## Layout

```text
scripts/
├── electron/
│   ├── powershell/
│   │   └── dev.ps1
│   └── sh/
│       └── dev.sh
├── web/
│   ├── powershell/
│   │   ├── dev.ps1
│   │   ├── install.ps1
│   │   └── build.ps1
│   └── sh/
│       ├── dev.sh
│       ├── install.sh
│       └── build.sh
├── makefile/
│   ├── powershell/
│   │   └── test.ps1
│   └── sh/
│       └── test.sh
├── powershell/       # Existing backend/Electron compatibility scripts
├── sh/               # Existing Linux/macOS backend/Electron scripts
└── readme.md
```

The root `Makefile` remains at the repository root.

## Electron

Windows PowerShell:

```powershell
.\scripts\electron\powershell\dev.ps1
```

Linux/macOS:

```bash
./scripts/electron/sh/dev.sh
```

These entry points run Electron from `client-react`. For the full workflow that automatically starts the Python or TypeScript backend and Vite, use the existing scripts under `scripts/powershell/` or `scripts/sh/`.

## Web application

These scripts operate on `client-react`.

Windows PowerShell:

```powershell
.\scripts\web\powershell\dev.ps1
.\scripts\web\powershell\install.ps1
.\scripts\web\powershell\build.ps1
```

Linux/macOS:

```bash
./scripts/web/sh/dev.sh
./scripts/web/sh/install.sh
./scripts/web/sh/build.sh
```

## Makefile helpers

Windows users do not need GNU Make to run the tests:

```powershell
.\scripts\makefile\powershell\test.ps1
.\scripts\makefile\powershell\test.ps1 python
.\scripts\makefile\powershell\test.ps1 typescript
.\scripts\makefile\powershell\test.ps1 react
```

Linux/macOS:

```bash
./scripts/makefile/sh/test.sh
./scripts/makefile/sh/test.sh python
./scripts/makefile/sh/test.sh typescript
./scripts/makefile/sh/test.sh react
```

Or use the root Makefile on systems with `make`:

```bash
make test
make test-python
make test-typescript
make test-react
make typecheck-typescript
make build-react
```

## Existing compatibility scripts

The original scripts remain under `scripts/powershell/` and `scripts/sh/` so existing commands are not broken. They include Python/Flask backend startup, TypeScript backend startup, Electron development startup, offline-AI startup, and service-stop helpers.
