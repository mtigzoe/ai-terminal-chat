# Startup Scripts

Helper scripts that prepare the backend environment, install frontend dependencies when needed, and start the backend, Vite development server, and (optionally) the Electron shell. Companion stop scripts free the default development ports.

Two backend implementations exist (`server-python` and `server-typescript`), so most start scripts come in two variants — a plain name for the Python/Flask backend (via `uv`), and a `-ts` suffixed name for the TypeScript backend (via `npm`). Both expose the same API on port 9000, so the Vite frontend and Electron shell work unmodified with either one. Only run one backend at a time — the scripts detect port 9000 is already in use and won't start a second backend on top of it, so make sure the previous one is stopped (`stop-services.sh`) before switching backends.

## Layout

```text
scripts/
├── powershell/                 # Windows PowerShell helpers
├── sh/                         # Linux / macOS Bash helpers
├── electron/                   # Application-focused Electron scripts
│   ├── powershell/
│   │   └── dev.ps1
│   └── sh/
│       └── dev.sh
├── web/                        # Application-focused React web scripts
│   ├── powershell/
│   │   ├── dev.ps1
│   │   ├── install.ps1
│   │   └── build.ps1
│   └── sh/
│       ├── dev.sh
│       ├── install.sh
│       └── build.sh
├── makefile/                   # Makefile test helpers
│   ├── powershell/
│   │   └── test.ps1
│   └── sh/
│       └── test.sh
└── readme.md                   # This file
```

The root `Makefile` remains at the repository root.

## Prerequisites

- `uv` (required for the Python scripts; no pip fallback)
- Node.js / `npm` (required for all scripts — it's also how the TypeScript backend and Vite are installed/run)
- For offline / Ollama workflows: a reachable Ollama instance
- For Electron scripts: the `electron` package (installed via `npm ci` / `npm install` when missing)
- For `stop-services.sh`: `lsof` or `fuser` (usually present on Linux/macOS)

## Existing compatibility scripts

The original backend startup scripts remain under `scripts/powershell/` and `scripts/sh/` so existing commands are not broken. They include Python/Flask backend startup, TypeScript backend startup, full Electron development startup, offline-AI startup, and service-stop helpers.

## Application-focused Electron scripts

These scripts launch the Electron shell directly from the repository root without replacing the existing full-stack startup scripts.

Windows PowerShell:

```powershell
.\scripts\electron\powershell\dev.ps1
```

Linux/macOS:

```bash
./scripts/electron/sh/dev.sh
```

## Application-focused web scripts

These scripts operate on `client-react` only.

Windows PowerShell:

```powershell
.\scripts\web\powershell\install.ps1
.\scripts\web\powershell\dev.ps1
.\scripts\web\powershell\build.ps1
```

Linux/macOS:

```bash
./scripts/web/sh/install.sh
./scripts/web/sh/dev.sh
./scripts/web/sh/build.sh
```

## Makefile test helpers

Windows users do not need GNU Make to run the tests:

```powershell
.\scripts\makefile\powershell\test.ps1
.\scripts\makefile\powershell\test.ps1 python
.\scripts\makefile\powershell\test.ps1 typescript
.\scripts\makefile\powershell\test.ps1 react
```

Linux/macOS:

```bash
bash ./scripts/makefile/sh/test.sh
bash ./scripts/makefile/sh/test.sh python
bash ./scripts/makefile/sh/test.sh typescript
bash ./scripts/makefile/sh/test.sh react
```

On systems with `make`, the root Makefile provides the same common operations:

```bash
make test
make test-python
make test-typescript
make test-react
make typecheck-typescript
make build-react
```

## Usage (from repository root)

### Windows (PowerShell)

```powershell
# Existing full-stack Electron workflow, Python backend
.\scripts\powershell\run-electron.ps1

# Existing full-stack Electron workflow, TypeScript backend
.\scripts\powershell\run-electron-ts.ps1

# Application-focused Electron shell
.\scripts\electron\powershell\dev.ps1

# Web application only
.\scripts\web\powershell\install.ps1
.\scripts\web\powershell\dev.ps1
.\scripts\web\powershell\build.ps1

# Stop existing services
.\scripts\powershell\stop-services.ps1
```

### Linux / macOS (Bash)

```bash
# Make existing scripts executable once, if needed
chmod +x scripts/sh/*.sh scripts/electron/sh/*.sh scripts/web/sh/*.sh

# Existing full-stack Electron workflow, Python backend
./scripts/sh/run-electron.sh

# Existing full-stack Electron workflow, TypeScript backend
./scripts/sh/run-electron-ts.sh

# Application-focused Electron shell
./scripts/electron/sh/dev.sh

# Web application only
./scripts/web/sh/install.sh
./scripts/web/sh/dev.sh
./scripts/web/sh/build.sh

# Stop existing services
./scripts/sh/stop-services.sh
```

## Behaviour notes

- Existing start scripts detect whether ports 9000 (backend — Flask or TypeScript) and 3000 (Vite) are already in use and only start the missing services.
- Application-focused Electron scripts intentionally launch Electron directly and do not replace the full-stack startup scripts.
- Application-focused web scripts only install, develop, or build the React client.
- Processes started by the existing Electron scripts are cleaned up when Electron exits (only those launched by the script itself).
- The offline-AI scripts open the backend and frontend in separate processes/windows and leave them running; they do not launch Electron.
- Python start scripts refuse to run if `uv` or `npm` is missing from `PATH`. TypeScript start scripts (`-ts`) refuse to run if `npm` is missing from `PATH`; they don't need `uv`.
- Both backends serve an identical API contract on port 9000, so the Vite frontend and Electron shell require no changes to work with either.
