# Startup and development scripts

Scripts are organized by purpose and shell environment. The TypeScript-backed compatibility startup scripts remain under `scripts/powershell/` and `scripts/sh/` for compatibility. New application-focused entry points are grouped under `electron/`, `web/`, and `makefile/`.

## Layout

```text
scripts/
├── powershell/                 # Existing Windows PowerShell helpers
├── sh/                         # Existing Linux/macOS Bash helpers
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

The startup scripts use the TypeScript backend. The separate Python implementation is maintained at https://github.com/mtigzoe/ai-terminal-chat-python.

* TypeScript backend scripts require `npm`; they do not require `uv`.
* The backend services use port `9000`.
* The Vite development server uses port `3000`.
* Only one backend should run at a time.

## Existing compatibility scripts

The original backend startup scripts remain under `scripts/powershell/` and `scripts/sh/` so existing commands are not broken.

They include:

* TypeScript backend startup
* Full Electron development startup
* Offline-AI startup
* Service-stop helpers

Existing startup scripts detect whether ports `9000` and `3000` are already in use and only start missing services.

The TypeScript backend exposes the HTTP API on port `9000` for both Vite and Electron.

## Application-focused Electron scripts

These scripts launch the Electron shell directly from `client-react`. They do not replace the existing full-stack startup scripts.

### Windows PowerShell

```powershell
.\scripts\electron\powershell\dev.ps1
```

### Linux/macOS

```bash
./scripts/electron/sh/dev.sh
```

For the full workflow that automatically starts the backend and Vite, use the existing scripts under `scripts/powershell/` or `scripts/sh/`.

## Application-focused web scripts

These scripts operate on `client-react` only.

### Windows PowerShell

```powershell
.\scripts\web\powershell\install.ps1
.\scripts\web\powershell\dev.ps1
.\scripts\web\powershell\build.ps1
```

### Linux/macOS

```bash
./scripts/web/sh/install.sh
./scripts/web/sh/dev.sh
./scripts/web/sh/build.sh
```

## Makefile test helpers

Windows users do not need GNU Make to run the tests.

### Windows PowerShell

```powershell
.\scripts\makefile\powershell\test.ps1
.\scripts\makefile\powershell\test.ps1 typescript
.\scripts\makefile\powershell\test.ps1 react
```

### Linux/macOS

```bash
bash ./scripts/makefile/sh/test.sh
bash ./scripts/makefile/sh/test.sh typescript
bash ./scripts/makefile/sh/test.sh react
```

On systems with `make`, the root Makefile provides the same common operations:

```bash
make test
make test-typescript
make test-react
make typecheck-typescript
make build-react
```

## Usage from the repository root

### Windows PowerShell

Existing full-stack Electron workflow using the TypeScript backend:

```powershell
.\scripts\powershell\run-electron.ps1
```

Explicit TypeScript launcher (equivalent to the compatibility command above):

```powershell
.\scripts\powershell\run-electron-ts.ps1
```

Application-focused Electron shell:

```powershell
.\scripts\electron\powershell\dev.ps1
```

Web application only:

```powershell
.\scripts\web\powershell\install.ps1
.\scripts\web\powershell\dev.ps1
.\scripts\web\powershell\build.ps1
```

Stop existing services:

```powershell
.\scripts\powershell\stop-services.ps1
```

### Linux/macOS

Make existing scripts executable once, if needed:

```bash
chmod +x scripts/sh/*.sh scripts/electron/sh/*.sh scripts/web/sh/*.sh scripts/makefile/sh/*.sh
```

Existing full-stack Electron workflow using the TypeScript backend:

```bash
./scripts/sh/run-electron.sh
```

Explicit TypeScript launcher (equivalent to the compatibility command above):

```bash
./scripts/sh/run-electron-ts.sh
```

Application-focused Electron shell:

```bash
./scripts/electron/sh/dev.sh
```

Web application only:

```bash
./scripts/web/sh/install.sh
./scripts/web/sh/dev.sh
./scripts/web/sh/build.sh
```

Stop existing services:

```bash
./scripts/sh/stop-services.sh
```

## Behavior and compatibility

* Existing startup scripts remain available for compatibility.
* Existing Electron startup scripts can start the backend, Vite, and Electron together.
* Application-focused Electron scripts launch Electron directly from `client-react`.
* Application-focused web scripts only install, develop, or build the React client.
* Makefile test helpers provide convenient test commands without requiring GNU Make on Windows.
* Processes started by the existing Electron scripts are cleaned up when Electron exits, limited to processes launched by the script itself.
* Offline-AI scripts open the backend and frontend separately and leave them running; they do not launch Electron.
* The backend startup scripts refuse to start a second backend when port `9000` is already in use.
* The Python and TypeScript backends expose the same API contract on port `9000`.
