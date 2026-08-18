# TypeScript API Server

This directory contains the TypeScript implementation of the HTTP API layer, equivalent to the Python Flask backend in `server-python/`.

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Installation

```bash
npm install
```

### Running the Server

```bash
npm run dev
```

The server starts on `http://127.0.0.1:9000` by default. Override the port with the `PORT` environment variable.

### Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the development server with hot reload via `tsx` |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start` | Run the compiled server from `dist/` |
| `npm run typecheck` | Run `tsc --noEmit` to check for type errors |
| `npm test` | Run the API test suite with Vitest |

## API Endpoints

All endpoints match the Python Flask backend contract so the React frontend can swap backends without changes.

### Provider Management

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/providers` | Current provider status, capabilities, and supported provider names. Pass `?probe=0` to skip the network probe. |
| `POST` | `/providers/select` | Switch the active provider, model, and optional API key. JSON body: `{provider, model?, api_key?}` |
| `GET` | `/providers/:name/models` | List installed/available models for a provider |

### Project Root

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/project-root` | Read the current project root used by all tools |
| `POST` | `/project-root` | Change the project root. JSON body: `{path}` |

### Project Explorer

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/project/list` | List directory entries. Query param: `path` (default `.`) |
| `GET` | `/project/read` | Read a UTF-8 text file. Query param: `path` (required) |

### Terminal

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/terminal/run` | Run an allowlisted development command. JSON body: `{command}` |

### Allowed Commands

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/allowed-commands` | List allowed terminal command prefixes |
| `POST` | `/allowed-commands` | Add a command prefix. JSON body: `{command}` or `{prefix}` |
| `DELETE` | `/allowed-commands/:command` | Remove a command prefix |

### Chat

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/chat` | Non-streaming chat. JSON body: `{chat, history?, request_id?}` |
| `POST` | `/stream` | Streaming chat (NDJSON). JSON body: same as `/chat` |

### Agent Control

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/cancel/:request_id` | Cancel an in-flight chat or stream request |
| `POST` | `/confirm` | Approve or reject a pending model write operation. JSON body: `{action_id, confirmed}` |

## Request/Response Schemas

### GET /providers

Response:
```json
{
  "name": "ollama",
  "model": "llama3.1",
  "capabilities": {
    "tools": true,
    "streaming": true,
    "model_listing": true,
    "requires_api_key": false,
    "local": true,
    "notes": ""
  },
  "base_url": "http://localhost:11434/v1",
  "available": true,
  "error": null,
  "current": "ollama",
  "providers": ["gemini", "ollama", "kilo", "openai", "xai", "openrouter", "anthropic"]
}
```

### POST /chat

Request:
```json
{
  "chat": "List files in the project",
  "history": [],
  "request_id": "optional-uuid"
}
```

Response (success):
```json
{
  "text": "Here are the files...",
  "tool_activity": [
    {"type": "progress", "phase": "plan", "message": "Planning next step", "round": 1, "max_rounds": 10},
    {"type": "tool_call", "name": "list_files", "args": {"path": "."}},
    {"type": "tool_result", "name": "list_files", "result": {"path": ".", "entries": [...]}}
  ],
  "request_id": "optional-uuid"
}
```

Response (validation error):
```json
{
  "text": "",
  "error": "Message must not be empty.",
  "request_id": "optional-uuid"
}
```

### POST /terminal/run

Request:
```json
{
  "command": "git status"
}
```

Response:
```json
{
  "command": "git status",
  "returncode": 0,
  "stdout": "M  src/file.ts\n",
  "stderr": "",
  "truncated": false
}
```

## Architecture

The TypeScript backend mirrors the Python backend structure:

```
server-typescript/src/
  security.ts       - Filesystem access control, project root management, path safety
  filesystem.ts     - File read/write/list/search operations
  git.ts            - Git status, diff, log, branch operations
  terminal.ts       - Command execution with allowlist and safety checks
  providers/
    base.ts         - Provider abstraction (Provider, ProviderCapabilities, ProviderResponse)
    config.ts       - Provider environment configuration and supported providers list
    stub.ts         - Stub provider for testing without real API calls
    openai-compatible.ts - OpenAI-compatible provider (Ollama, OpenAI, xAI, etc.)
    factory.ts      - Provider factory and status builder
    index.ts        - Module exports
  pending.ts        - In-memory pending action store for write confirmations
  cancellation.ts  - Cooperative cancellation registry for in-flight requests
  agent.ts          - Provider-agnostic tool-calling loop with write confirmation
  routes.ts         - Hono HTTP route handlers
  server.ts         - Node.js server entry point
```

### Key Design Decisions

1. **Hono** is used as the HTTP framework for its lightweight footprint and excellent TypeScript support.
2. **Node.js built-ins** (`fs`, `path`, `child_process`) are used for filesystem, git, and terminal operations, matching the Python backend's behavior.
3. **In-memory stores** (`pending.ts`, `cancellation.ts`) mirror the Python `threading.Lock`-protected stores, using `Map` for thread-safety in Node.js's single-threaded environment.
4. **Provider abstraction** supports both stub providers (for testing) and OpenAI-compatible providers (for Ollama, OpenAI, xAI, OpenRouter, etc.).
5. **Security** is enforced at the tool and route level: path containment, sensitive file blocking, command allowlisting, and dangerous character blocking.

## Cross-Platform Support

The implementation works on Windows and Linux:

- **Path handling**: Uses `path.resolve()` and `path.relative()` which are platform-aware.
- **Terminal commands**: On Windows, `ls` is mapped to `cmd /c dir` via PowerShell-compatible execution.
- **Git operations**: Uses `spawnSync` with platform-appropriate arguments.

## Correspondence to Python Backend

| Python (`server-python/`) | TypeScript (`server-typescript/src/`) |
|---------------------------|---------------------------------------|
| `app.py` (Flask routes) | `routes.ts` (Hono routes) |
| `security.py` | `security.ts` |
| `tools.py` | `filesystem.ts`, `git.ts`, `terminal.ts` |
| `providers.py` + `openai_compatible.py` | `providers/` |
| `agent.py` | `agent.ts` |
| `pending.py` | `pending.ts` |
| `cancellation.py` | `cancellation.ts` |
| `base.py` | `providers/base.ts` |
