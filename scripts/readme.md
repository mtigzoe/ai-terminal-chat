# Startup Scripts

Helper scripts that prepare the Python environment (via `uv`), install frontend dependencies when needed, and start the Flask backend, Vite development server, and (optionally) the Electron shell. Companion stop scripts free the default development ports.

## Layout

```text
scripts/
├── powershell/                 # Windows PowerShell helpers
│   ├── run-electron.ps1        # Convenience wrapper → start-electron-dev.ps1
│   ├── start-electron.ps1      # Backend + Vite + Electron
│   ├── start-electron-dev.ps1  # Same as above (kept for compatibility)
│   ├── start-offline-ai.ps1    # Backend + Vite with remote Linux Ollama
│   └── stop-services.ps1       # Stop listeners on ports 9000 and 3000
├── sh/                         # Linux / macOS Bash helpers
│   ├── run-electron.sh         # Convenience wrapper → start-electron.sh
│   ├── start-electron.sh       # Backend + Vite + Electron
│   ├── start-offline-ai.sh     # Backend + Vite with local Ollama
│   └── stop-services.sh        # Stop listeners on ports 9000 and 3000
└── readme.md                   # This file
```

## Prerequisites

- `uv` (required; no pip fallback)
- Node.js / `npm`
- For offline / Ollama workflows: a reachable Ollama instance
- For Electron scripts: the `electron` package (installed via `npm ci` / `npm install` when missing)
- For `stop-services.sh`: `lsof` or `fuser` (usually present on Linux/macOS)

## Usage (from repository root)

### Windows (PowerShell)

```powershell
# Electron development (backend + Vite + Electron)
.\scripts\powershell\run-electron.ps1
# or use either implementation directly
.\scripts\powershell\start-electron.ps1
.\scripts\powershell\start-electron-dev.ps1

# Offline-oriented (Windows client + Linux Ollama)
.\scripts\powershell\start-offline-ai.ps1
.\scripts\powershell\start-offline-ai.ps1 -LinuxOllamaHost "http://192.168.1.100:11434" -OllamaModel "qwen3.5:9b"

# Stop services on the default ports
.\scripts\powershell\stop-services.ps1
```

### Linux / macOS (Bash)

```bash
# Make scripts executable once (if needed)
chmod +x scripts/sh/*.sh

# Electron development (backend + Vite + Electron)
./scripts/sh/run-electron.sh
# or
./scripts/sh/start-electron.sh

# Offline-oriented (local Ollama)
./scripts/sh/start-offline-ai.sh
./scripts/sh/start-offline-ai.sh qwen3.5:9b
# or via environment variables
OLLAMA_HOST=http://127.0.0.1:11434 OLLAMA_MODEL=qwen3.5:9b ./scripts/sh/start-offline-ai.sh

# Stop services on the default ports
./scripts/sh/stop-services.sh
```

## Top-level README references

The repository-level `README.md` should use the organized paths shown below:

- Electron development on Windows: `scripts/powershell/run-electron.ps1` (or `start-electron.ps1` / `start-electron-dev.ps1`)
- Electron development on Linux/macOS: `scripts/sh/run-electron.sh` (or `start-electron.sh`)
- Offline AI on Windows: `scripts/powershell/start-offline-ai.ps1`
- Offline AI on Linux/macOS: `scripts/sh/start-offline-ai.sh`
- Stop services on Windows: `scripts/powershell/stop-services.ps1`
- Stop services on Linux/macOS: `scripts/sh/stop-services.sh`

For the full script layout, prerequisites, usage examples, convenience wrappers, and stop helpers, refer to this file from the top-level README as `scripts/readme.md`.

## Behaviour notes

- Start scripts detect whether ports 9000 (Flask) and 3000 (Vite) are already in use and only start the missing services.
- Processes started by the Electron scripts are cleaned up when Electron exits (only those launched by the script itself).
- The offline-AI scripts open the backend and frontend in separate processes/windows and leave them running; they do not launch Electron.
- All start scripts refuse to run if `uv` or `npm` is missing from `PATH`.
- Path resolution is relative to the script location (`scripts/powershell` or `scripts/sh`) and walks up two directory levels to reach the repository root.
- Stop scripts only terminate processes that are actively listening on ports 9000 and 3000; they do not perform a broad process-name search.

## Duplication note

`start-electron.ps1` and `start-electron-dev.ps1` are currently nearly identical. `run-electron.ps1` provides a convenience entry point to the development script. The Bash side provides a single implementation plus a `run-electron.sh` convenience wrapper.
