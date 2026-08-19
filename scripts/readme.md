# Startup Scripts

Helper scripts that prepare the backend environment, install frontend dependencies when needed, and start the backend, Vite development server, and (optionally) the Electron shell. Companion stop scripts free the default development ports.

Two backend implementations exist (`server-python` and `server-typescript`), so most start scripts come in two variants — a plain name for the Python/Flask backend (via `uv`), and a `-ts` suffixed name for the TypeScript backend (via `npm`). Both expose the same API on port 9000, so the Vite frontend and Electron shell work unmodified with either one. Only run one backend at a time — the scripts detect port 9000 is already in use and won't start a second backend on top of it, so make sure the previous one is stopped (`stop-services.sh`) before switching backends.

## Layout

```text
scripts/
├── powershell/                 # Windows PowerShell helpers
│   ├── run-electron.ps1        # Convenience wrapper → start-electron-dev.ps1 (Python backend)
│   ├── start-electron.ps1      # Python backend + Vite + Electron
│   ├── start-electron-dev.ps1  # Same as above (kept for compatibility)
│   ├── start-offline-ai.ps1    # Python backend + Vite with remote Linux Ollama
│   ├── run-electron-ts.ps1     # Convenience wrapper → start-electron-ts.ps1 (TypeScript backend)
│   ├── start-electron-ts.ps1   # TypeScript backend + Vite + Electron
│   ├── start-offline-ai-ts.ps1 # TypeScript backend + Vite with remote Linux Ollama
│   └── stop-services.ps1       # Stop listeners on ports 9000 and 3000 (either backend)
├── sh/                         # Linux / macOS Bash helpers
│   ├── run-electron.sh         # Convenience wrapper → start-electron.sh (Python backend)
│   ├── start-electron.sh       # Python backend + Vite + Electron
│   ├── start-offline-ai.sh     # Python backend + Vite with local Ollama
│   ├── run-electron-ts.sh      # Convenience wrapper → start-electron-ts.sh (TypeScript backend)
│   ├── start-electron-ts.sh    # TypeScript backend + Vite + Electron
│   ├── start-offline-ai-ts.sh  # TypeScript backend + Vite with local Ollama
│   └── stop-services.sh        # Stop listeners on ports 9000 and 3000 (either backend)
└── readme.md                   # This file
```

## Prerequisites

- `uv` (required for the Python scripts; no pip fallback)
- Node.js / `npm` (required for all scripts — it's also how the TypeScript backend and Vite are installed/run)
- For offline / Ollama workflows: a reachable Ollama instance
- For Electron scripts: the `electron` package (installed via `npm ci` / `npm install` when missing)
- For `stop-services.sh`: `lsof` or `fuser` (usually present on Linux/macOS)

## Usage (from repository root)

### Windows (PowerShell)

```powershell
# Electron development, Python backend (backend + Vite + Electron)
.\scripts\powershell\run-electron.ps1
# or use either implementation directly
.\scripts\powershell\start-electron.ps1
.\scripts\powershell\start-electron-dev.ps1

# Electron development, TypeScript backend
.\scripts\powershell\run-electron-ts.ps1
# or directly
.\scripts\powershell\start-electron-ts.ps1

# Offline-oriented (Windows client + Linux Ollama), Python backend
.\scripts\powershell\start-offline-ai.ps1
.\scripts\powershell\start-offline-ai.ps1 -LinuxOllamaHost "http://192.168.1.100:11434" -OllamaModel "qwen3.5:9b"

# Offline-oriented (Windows client + Linux Ollama), TypeScript backend
.\scripts\powershell\start-offline-ai-ts.ps1
.\scripts\powershell\start-offline-ai-ts.ps1 -LinuxOllamaHost "http://192.168.1.100:11434" -OllamaModel "qwen3.5:9b"

# Stop services on the default ports (works regardless of which backend is running)
.\scripts\powershell\stop-services.ps1
```

### Linux / macOS (Bash)

```bash
# Make scripts executable once (if needed)
chmod +x scripts/sh/*.sh

# Electron development, Python backend (backend + Vite + Electron)
./scripts/sh/run-electron.sh
# or
./scripts/sh/start-electron.sh

# Electron development, TypeScript backend
./scripts/sh/run-electron-ts.sh
# or
./scripts/sh/start-electron-ts.sh

# Offline-oriented (local Ollama), Python backend
./scripts/sh/start-offline-ai.sh
./scripts/sh/start-offline-ai.sh qwen3.5:9b
# or via environment variables
OLLAMA_HOST=http://127.0.0.1:11434 OLLAMA_MODEL=qwen3.5:9b ./scripts/sh/start-offline-ai.sh

# Offline-oriented (local Ollama), TypeScript backend
./scripts/sh/start-offline-ai-ts.sh
./scripts/sh/start-offline-ai-ts.sh qwen3.5:9b
# or via environment variables
OLLAMA_HOST=http://127.0.0.1:11434 OLLAMA_MODEL=qwen3.5:9b ./scripts/sh/start-offline-ai-ts.sh

# Stop services on the default ports (works regardless of which backend is running)
./scripts/sh/stop-services.sh
```

## Top-level README references

The repository-level `README.md` should use the organized paths shown below:

- Electron development on Windows, Python backend: `scripts/powershell/run-electron.ps1` (or `start-electron.ps1` / `start-electron-dev.ps1`)
- Electron development on Windows, TypeScript backend: `scripts/powershell/run-electron-ts.ps1` (or `start-electron-ts.ps1`)
- Electron development on Linux/macOS, Python backend: `scripts/sh/run-electron.sh` (or `start-electron.sh`)
- Electron development on Linux/macOS, TypeScript backend: `scripts/sh/run-electron-ts.sh` (or `start-electron-ts.sh`)
- Offline AI on Windows, Python backend: `scripts/powershell/start-offline-ai.ps1`
- Offline AI on Windows, TypeScript backend: `scripts/powershell/start-offline-ai-ts.ps1`
- Offline AI on Linux/macOS, Python backend: `scripts/sh/start-offline-ai.sh`
- Offline AI on Linux/macOS, TypeScript backend: `scripts/sh/start-offline-ai-ts.sh`
- Stop services on Windows: `scripts/powershell/stop-services.ps1`
- Stop services on Linux/macOS: `scripts/sh/stop-services.sh`

For the full script layout, prerequisites, usage examples, convenience wrappers, and stop helpers, refer to this file from the top-level README as `scripts/readme.md`.

## Behaviour notes

- Start scripts detect whether ports 9000 (backend — Flask or TypeScript) and 3000 (Vite) are already in use and only start the missing services.
- Processes started by the Electron scripts are cleaned up when Electron exits (only those launched by the script itself).
- The offline-AI scripts open the backend and frontend in separate processes/windows and leave them running; they do not launch Electron.
- Python start scripts refuse to run if `uv` or `npm` is missing from `PATH`. TypeScript start scripts (`-ts`) refuse to run if `npm` is missing from `PATH`; they don't need `uv`.
- The TypeScript scripts install backend dependencies with `npm install` in `server-typescript` (mirroring the `uv venv` / `uv pip install` step in the Python scripts) and start the backend with `npm run dev` (`tsx watch`, matching the Python scripts' use of `uv run app.py` / the venv Python for hot-reload style development).
- Path resolution is relative to the script location (`scripts/powershell` or `scripts/sh`) and walks up two directory levels to reach the repository root.
- Stop scripts only terminate processes that are actively listening on ports 9000 and 3000; they do not perform a broad process-name search, so they work the same way regardless of which backend was running.
- Both backends serve an identical API contract on port 9000 (see `server-typescript/README.md`), so the Vite frontend and Electron shell require no changes to work with either — the only difference between the plain and `-ts` scripts is how the backend itself is installed and started.

## Duplication note

`start-electron.ps1` and `start-electron-dev.ps1` are currently nearly identical. `run-electron.ps1` provides a convenience entry point to the development script. The Bash side provides a single implementation plus a `run-electron.sh` convenience wrapper. The TypeScript scripts intentionally don't replicate the `start-electron-ts.ps1` / `start-electron-dev-ts.ps1` split — there's just `start-electron-ts.ps1` plus its `run-electron-ts.ps1` wrapper, on both PowerShell and Bash, to avoid adding to the existing duplication.
