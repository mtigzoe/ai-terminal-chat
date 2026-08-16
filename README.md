# AI Terminal Chat

An accessible AI chat interface for working with a local project through controlled tools.

The project combines a React/Vite frontend with a Flask/Python backend and a provider layer for AI models. The backend does not give an AI model unrestricted access to the computer: models can request explicitly exposed tools, and the Python backend validates and executes those requests.

## Architecture

```text
React client (:3000)
        |
        | HTTP
        v
Flask server (:9000)
        |
        v
Provider layer
   |       |       |       |       |       |
 Gemini  Ollama   Kilo   OpenAI    xAI  OpenRouter  Anthropic
        |
        | tool calls
        v
Local Python tools
  - list files
  - read files
  - search files
  - run approved commands
  - inspect Git state
  - modify files with confirmation
```

The tool system is deliberately controlled by the backend. AI providers do not receive unrestricted shell or filesystem access.

## Repository layout

The repository currently contains one React frontend directory, `client-react/`; there is no `client-react - Copy` directory.

```text
ai-terminal-chat/
├── client-react/       # React/Vite chat frontend (+ Electron Stage 1 shell)
├── server-python/      # Flask backend, providers, and local tools
├── scripts/            # Local/offline and Electron startup helpers
├── LICENSE             # Apache License 2.0
└── README.md
```

## Current features

- React/Vite chat interface
- Keyboard-friendly and screen-reader-oriented interface
- Conversations through the supported provider ecosystem:
  - Gemini
  - Ollama
  - Kilo
  - OpenAI
  - xAI/Grok
  - OpenRouter
  - Anthropic
- Provider abstraction with a single `ProviderConfig` model for provider configuration
- Provider capability detection (`tools`, `streaming`, `model_listing`, `local`, `requires_api_key`)
- Backend-controlled provider and model selection from the UI (`/providers`, `/providers/select`, `/providers/<name>/models`)
- Actionable connection diagnostics when a provider is unreachable
- Provider-specific function/tool calling where supported by the provider/model
- Local project directory listing
- Local text-file reading
- Text-file searching
- Controlled terminal command execution
- Git status, diff, log, and branch inspection
- Git staging through a confirmation-required `git_add` operation
- Streaming responses where supported
- Cooperative request cancellation (`/cancel/<request_id>`)
- Tool-activity reporting
- Agent lifecycle progress reporting for planning, inspection, execution, confirmation, verification, recovery, completion, and cancellation
- Accessible frontend agent-status announcements
- Integrated accessible project/file browser (directory navigation, file open/read, live announcements)
- Integrated accessible terminal panel for allowlisted development commands (separate from AI tool execution UI)
- Confirmation-required file creation, modification, patching, deletion, and Git staging
- Filesystem access restricted to the project directory
- Sensitive-file protection for files such as `.env`, credentials, keys, and `.git`
- Maximum file-size protection when reading and searching files
- Per-tool execution timeouts
- Protection against repeated/stuck tool calls
- CORS support for local frontend/backend development

## Provider ecosystem

The provider ecosystem milestone is **implemented**. The backend now has first-class provider entries for Gemini, Ollama, Kilo, OpenAI, xAI/Grok, OpenRouter, and Anthropic, with provider configuration centralized in `server-python/providers.py`.

The application uses the same agent/tool layer across providers rather than duplicating filesystem, terminal, Git, and confirmation logic for each vendor. Provider capabilities are reported explicitly because support for tool calling, streaming, and model listing can differ by provider and model.

### Supported provider IDs

| Provider | `PROVIDER` value | Typical configuration |
|---|---|---|
| Google Gemini | `gemini` | `GOOGLE_API_KEY`, `GEMINI_MODEL` |
| Ollama | `ollama` | `OLLAMA_BASE_URL`/`OLLAMA_HOST`, `OLLAMA_MODEL` |
| Kilo | `kilo` | `KILO_API_KEY`, `KILO_BASE_URL`, `KILO_MODEL` |
| OpenAI | `openai` | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` |
| xAI/Grok | `xai` | `XAI_API_KEY`, `XAI_BASE_URL`, `XAI_MODEL` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `OPENROUTER_MODEL` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` |

GitHub Copilot was investigated as a possible provider option, but it is **deferred** rather than implemented as a first-class provider. The current provider ecosystem therefore does not claim GitHub Copilot support.

## Prerequisites

- Git
- Node.js and npm
- Python 3.11 or newer
- `uv` for Python dependency and environment management
- Credentials for whichever cloud provider you choose, if applicable
- Ollama installed and running if you choose the local/offline workflow

Install `uv` from the official Astral documentation if it is not already installed. The Electron startup scripts require `uv` to be available on `PATH` and do not fall back to `pip`.

## Quick start

Clone the repository:

```powershell
git clone https://github.com/mtigzoe/ai-terminal-chat.git
cd ai-terminal-chat
```

### 1. Configure the Python backend

From `server-python`:

```powershell
cd server-python
```

Create or update `.env` from `.env.example`. Set `PROVIDER` to the provider you want to use and configure that provider's variables. For example, Gemini uses:

```text
PROVIDER=gemini
GOOGLE_API_KEY=your_api_key_here
GEMINI_MODEL=gemini-3.6-flash
PORT=9000
```

Do not commit `.env` or expose API keys in source code.

The recommended Python workflow uses `uv`:

```powershell
uv venv .venv
.\.venv\Scripts\Activate.ps1
uv pip install -r requirements.txt
uv run app.py
```

The backend normally runs at:

```text
http://127.0.0.1:9000
```

### 2. Start the React frontend

Open a second terminal and from the repository root run:

```powershell
cd client-react
npm install
npm run dev
```

The Vite development server normally runs at:

```text
http://localhost:3000
```

If the frontend needs a different backend URL, set `VITE_API_URL` in the frontend environment configuration. The frontend defaults to `http://localhost:9000`.

### 3. Run as a desktop app (Electron — Stage 1)

A minimal Electron shell is available so the same React frontend can run in a desktop window. The Flask backend and Vite development server are required for an unpackaged Electron development run.

**Manual development workflow**

1. Start the Flask backend using the `uv` workflow above.
2. In a second terminal start the Vite development server:

   ```powershell
   cd client-react
   npm install
   npm run dev
   ```

3. In a third terminal launch Electron:

   ```powershell
   cd client-react
   npm run electron:dev
   ```

In development (unpackaged) Electron always loads `http://localhost:3000` so a leftover `dist/` folder cannot override the Vite server. When the application is packaged, it loads `dist/index.html` from the application resources.

## Electron startup scripts

The repository includes one-command Electron development launchers in `scripts/`. They can prepare the Python environment, install dependencies, start the Flask backend, start Vite, wait for both services to become ready, and then launch Electron.

```text
scripts/
├── start-electron.ps1       # Windows PowerShell
├── start-electron-dev.ps1   # Windows PowerShell development helper
└── start-electron.sh        # Linux/macOS-style shell
```

### What the Electron scripts do

The scripts are designed for **unpackaged Electron development**. They:

1. Check that `uv` and `npm` are available.
2. Create `server-python/.venv` with `uv venv` when needed.
3. Install backend requirements with `uv pip install -r requirements.txt`.
4. Install frontend dependencies with `npm ci` when needed.
5. Start Flask with `uv run app.py` on port `9000` if it is not already running.
6. Wait for the Flask backend to become available.
7. Start Vite on port `3000` if it is not already running.
8. Wait for Vite to become available.
9. Launch Electron.
10. Clean up only the Flask/Vite processes started by the script when Electron exits; services that were already running are left alone.

The scripts do **not** use `pip install` or silently fall back to pip. If `uv` is not available, they stop with an error instead.

### Windows: `start-electron.ps1`

From the repository root in PowerShell:

```powershell
.\scripts\start-electron.ps1
```

This is the main one-command Electron development launcher. You do **not** need to manually run `python app.py` or `npm run dev` first unless you prefer to manage those processes yourself.

You can verify that `uv` is available with:

```powershell
uv --version
```

### Windows: `start-electron-dev.ps1`

From the repository root:

```powershell
.\scripts\start-electron-dev.ps1
```

This is the development helper for the same backend + Vite + Electron workflow. It also preserves services that were already running and cleans up only processes it started itself.

### Linux/macOS-style shell: `start-electron.sh`

From the repository root:

```bash
./scripts/start-electron.sh
```

The shell script uses the same `uv`-based Python workflow and starts Flask, Vite, and Electron as needed.

Check that the required tools are available:

```bash
uv --version
npm --version
```

If the executable permission is missing after a checkout, restore it once with:

```bash
chmod +x scripts/start-electron.sh
```

You can also invoke the script through Bash:

```bash
bash scripts/start-electron.sh
```

When invoked through Bash, the script attempts to restore its executable permission for subsequent direct invocations.

### Manual versus scripted startup

If you want to control each process separately, use the manual workflow in the Electron section above. If you want one command to prepare the environment and launch the complete development stack, use one of the `start-electron.*` scripts.

The Electron startup scripts are development launchers, not packaging scripts. They do not create an installer or packaged `.exe`, `.AppImage`, or other distributable application.

## Provider configuration and `.env.example`

`server-python/.env.example` is the reference configuration template. It documents all seven supported provider IDs and their environment variables.

Common settings:

```text
PROVIDER=gemini
PORT=9000
```

Gemini:

```text
GOOGLE_API_KEY=
GEMINI_MODEL=gemini-3.6-flash
```

Ollama (local, no API key):

```text
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_HOST=
OLLAMA_MODEL=llama3.1
OLLAMA_TIMEOUT=120
```

Kilo:

```text
KILO_API_KEY=
KILO_BASE_URL=https://api.kilo.ai/api/gateway
KILO_MODEL=kilocode/kilo-auto/balanced
KILO_TIMEOUT=120
```

OpenAI:

```text
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
OPENAI_TIMEOUT=120
```

xAI/Grok:

```text
XAI_API_KEY=
XAI_BASE_URL=https://api.x.ai/v1
XAI_MODEL=grok-4.6
XAI_TIMEOUT=120
```

OpenRouter:

```text
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=openai/gpt-4o-mini
OPENROUTER_TIMEOUT=120
OPENROUTER_HTTP_REFERER=
OPENROUTER_APP_TITLE=
```

OpenRouter model names are opaque model slugs, such as `openai/gpt-4o-mini` or an Anthropic model slug, and are passed through to OpenRouter.

Anthropic:

```text
ANTHROPIC_API_KEY=
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_MODEL=claude-sonnet-4-5
ANTHROPIC_TIMEOUT=120
ANTHROPIC_MAX_TOKENS=8192
```

API keys are backend-only. They are not sent to the React frontend by the provider status or provider-selection endpoints.

## Running the Python tests

From `server-python`, using the repository's `uv` environment:

```powershell
uv run pytest
```

To run the agent tests specifically:

```powershell
uv run pytest tests/test_agent.py -q
```

To run the pending-confirmation tests specifically:

```powershell
uv run pytest tests/test_pending.py -q
```

To run a particular test file:

```powershell
uv run pytest tests/test_app.py
```

The README intentionally does not publish a fixed total test count because the suite changes as the project evolves.

## Running the frontend checks

From `client-react`:

```powershell
npm install
```

Run the frontend test suite (Vitest — component, accessibility, and chat-flow tests, including `src/agentStatus.test.js`):

```powershell
npm test
```

Build the production frontend:

```powershell
npm run build
```

## API endpoints

The Flask backend provides these main endpoints.

### Chat

```text
POST /chat
```

Runs a conversation to completion and returns the final model response together with tool activity. Accepts an optional `request_id` so the request can be cancelled while it is in flight.

### Streaming chat

```text
POST /stream
```

Streams tool activity and the model's response as plain text for compatibility with the React client. Also accepts an optional `request_id` for cancellation.

### Confirm a pending action

```text
POST /confirm
```

Explicitly authorizes a previously previewed mutating operation. The backend retrieves the exact pending operation by its opaque action ID rather than trusting model-supplied tool names or arguments.

### Cancel an in-flight request

```text
POST /cancel/<request_id>
```

Cooperatively cancels a `/chat` or `/stream` request that was started with a matching `request_id`. The agent loop checks for cancellation between rounds and between individual tool calls and stops cleanly.

### Provider status

```text
GET /providers
```

Reports the active provider's name, model, capabilities (`tools`, `streaming`, `model_listing`, `local`, `requires_api_key`), live availability, and the list of supported provider names. Add `?probe=0` to skip the network reachability check. When a provider is unavailable, the response includes actionable diagnostics instead of only a raw error string. This endpoint never returns an API key.

### List a provider's models

```text
GET /providers/<name>/models
```

Lists available models for a provider without switching the active provider. Model-listing support varies by provider, so an empty list can be returned when the provider cannot be reached or does not support model discovery.

### Project directory listing

```text
GET /project/list?path=.
```

Lists files and directories under a path relative to the configured project root. Reuses the `list_files` tool.

### Read a project file

```text
GET /project/read?path=relative/path.txt
```

Reads a UTF-8 text file inside the project root. Reuses the `read_file` tool.

### Run a terminal command

```text
POST /terminal/run
```

Example body:

```json
{"command":"git status"}
```

Runs an allowlisted development command via `run_command` (same allowlist as AI tools).

### Switch the active provider

```text
POST /providers/select
```

Example:

```json
{"provider":"ollama","model":"qwen3.5:9b"}
```

`model` is optional. The browser can only request a provider/model; this endpoint validates and constructs it on the backend. A request naming an unsupported provider, or one whose configuration is invalid, is rejected while the previously active provider remains in place.

## Tool calling and confirmation

The backend exposes selected Python functions to the AI provider. A typical interaction is:

```text
User: What files are in the project?
        |
        v
AI requests list_files(".")
        |
        v
Python validates and executes the tool
        |
        v
Directory information is returned to the AI
        |
        v
AI explains the result to the user
```

For a development request such as modifying a file, the workflow is intentionally more restrictive:

```text
User requests a change
        |
        v
AI inspects the relevant files
        |
        v
AI prepares a change
        |
        v
Backend stores a pending confirmation action
        |
        v
User explicitly confirms
        |
        v
Backend retrieves the exact pending action
        |
        v
Backend applies the change
        |
        v
AI verifies the result
```

The confirmation requirement is enforced by the backend rather than relying only on the model to behave correctly. Pending actions use opaque identifiers, store the requested operation and arguments, and are consumed once when confirmed.

### Confirmed operations

The current confirmation system protects these mutating operations:

- `create_file`
- `write_file`
- `apply_patch`
- `delete_file`
- `git_add`

Read-only Git inspection tools such as `git_status`, `git_diff`, `git_log`, and `git_branch` do not require confirmation.

The terminal `run_command` tool remains restricted to its existing read-only/low-risk allowlist. Confirmation does not bypass that allowlist or turn arbitrary shell commands into permitted commands.

## Provider architecture

The Python backend is organized around a provider abstraction so the application does not need to duplicate its agent logic for every model vendor.

The separation is:

```text
Flask API
   |
   v
Agent/tool loop
   |
   v
Provider interface
   |---------|---------|---------|---------|---------|---------|
   v         v         v         v         v         v         v
 Gemini    Ollama    Kilo     OpenAI     xAI   OpenRouter Anthropic
```

A provider is responsible for communicating with an AI model, while the agent/tool layer remains responsible for executing local tools and enforcing the application's safety rules.

`ProviderConfig` in `server-python/providers.py` is the central place that reads provider environment variables into a plain `provider`/`model`/`base_url`/`api_key`/`timeout` structure. `get_provider()` resolves a supported provider and constructs its provider class. This keeps provider-specific configuration and API communication separate from filesystem, terminal, Git, and confirmation logic.

Every provider also declares `ProviderCapabilities` (`tools`, `streaming`, `model_listing`, `local`, `requires_api_key`) so the backend and frontend can ask what a provider/model actually supports instead of assuming all providers behave identically.

### Don't expose API keys to React

API keys live exclusively in the Python backend's environment and are read by `ProviderConfig` and the provider classes:

```text
React → Flask → AI provider
```

never

```text
React → AI provider API directly
```

`GET /providers` and `POST /providers/select` return provider status, model, capabilities, and availability, but never the provider's API key.

## Accessibility

Accessibility is a core project goal rather than an optional UI feature.

The frontend is designed to support keyboard-only operation and screen-reader users. Tool activity and important application state should be presented in a way that can be understood without relying on visual-only indicators.

When adding UI controls:

- Give every interactive control an accessible name.
- Prefer native HTML controls where possible.
- Make status changes available to assistive technology.
- Do not rely on color alone to communicate state.
- Keep keyboard focus behavior predictable.
- Test changes with a screen reader such as JAWS or NVDA.

## Security model

This project is intended for local development and experimentation. The backend should not be exposed to an untrusted network without additional security controls.

Important protections include:

- API keys are loaded from environment variables rather than source code.
- Sensitive files such as `.env`, credentials, private keys, and `.git` contents are blocked from model access.
- Filesystem paths are resolved and restricted to the project directory.
- File reads and searches have size limits.
- Terminal commands are restricted to an explicit allowlist.
- Command chaining, piping, redirection, and shell substitution are blocked.
- Destructive/system commands are denied.
- File creation, modification, patching, and deletion require explicit confirmation.
- Git staging requires explicit confirmation.
- Pending confirmations are stored server-side and identified by opaque action IDs.
- The model cannot self-authorize a pending mutating operation.
- Confirmed operations re-run their normal path and sensitive-file security checks before execution.
- A pending authorization is consumed once and cannot be replayed.
- Tool calls have execution time limits.
- Repeated identical tool calls are detected to prevent stuck loops.

These controls are defense-in-depth measures, not a guarantee that the application is safe to expose as a public service.

## Development guidelines

When extending the project:

1. Inspect the existing implementation before changing it.
2. Keep provider-specific code inside the provider layer.
3. Keep local-tool validation and security rules in the backend rather than trusting the model.
4. Prefer small, targeted changes over rewriting complete files unnecessarily.
5. Add tests for new provider behavior and important tool/security behavior.
6. Run the relevant tests before committing.
7. Test frontend accessibility changes with keyboard navigation and a screen reader.

## Future direction

The long-term goal is to develop AI Terminal Chat into an accessible, security-conscious terminal agent for local software development. The core provider, agent, security, terminal/Git, local/offline, and initial Electron milestones are implemented; future work focuses on refinement, testing, accessibility, packaging, and additional integrations.

### Accessibility

- Advanced screen-reader support for tool activity, model state, errors, and long terminal output
- Accessible confirmation dialogs and action previews
- Improved keyboard navigation and predictable focus management
- Keyboard shortcuts for common terminal-agent workflows
- Accessibility regression testing for important UI changes

### Agent capabilities

The core Agent Capabilities milestone is implemented. It adds multi-step agent behavior, lifecycle progress reporting, recovery from failed or repeated actions, verification guidance, and accessible frontend status announcements while preserving backend-enforced safety controls.

Further enhancements may include structured plan objects, automatic continuation after a confirmed write, richer frontend progress presentation, and expanded end-to-end testing.

### Security and permissions

The core Security and Permissions milestone is implemented. It provides a unified backend-enforced pending-action confirmation system for filesystem mutations and Git staging while preserving the existing terminal allowlist and hard security restrictions.

The following remain future work:

- Configurable permission levels for different tool categories
- Action history or audit logging
- Broader confirmation of terminal commands, subject to a separate security review
- Additional Git mutations such as commit, checkout, reset, and push, with appropriate confirmation and permission controls

### Terminal and Git integration

The core Terminal and Git Integration milestone is implemented. The backend provides controlled terminal execution and dedicated Git inspection/staging tools while preserving the existing security and confirmation model.

The following remain future work:

- Better screen-reader presentation of terminal output and Git changes
- More explicit user-facing presentation of long-running command state and timeout results
- Additional terminal commands with explicit permissions
- Additional Git mutations such as commit, checkout, reset, and push, each requiring a separate security review and appropriate confirmation

### Local and offline AI

The core Local and Offline AI milestone is **implemented**. AI Terminal Chat can use Ollama as a local model provider without requiring a Gemini or other cloud API key. Ollama can run on the same machine as the application or on a separate Linux machine, while the React frontend and Flask backend run on Windows.

#### Supported Windows → Linux Ollama workflow

The completed split-machine development setup is:

```text
Windows
  React/Vite client (:3000)
          |
          v
  Flask/Python backend (:9000)
          |
          | HTTP on local network
          v
Linux
  Ollama (:11434)
          |
          v
  Local model (for example qwen3:8b)
```

The Linux machine performs model inference, while Windows runs the application and user interface. The model does not need a cloud AI service. Ollama can also run on Windows or on the same Linux machine as the backend.

#### Implemented capabilities

- Dedicated `OllamaProvider` using `OLLAMA_BASE_URL`/`OLLAMA_HOST` and `OLLAMA_MODEL`
- Ollama server availability/health detection with actionable diagnostics through `GET /providers`
- Installed-model discovery through Ollama's `/api/tags` endpoint and `GET /providers/ollama/models`
- Provider/model selection from the React UI without restarting the Flask server
- Streaming responses with local models
- Function/tool calling when the selected Ollama model supports tools
- Capability detection so models without tool support can operate in chat-only mode
- Shared OpenAI-compatible provider support for Ollama, Kilo, LM Studio, llama.cpp, and similar servers
- Real opt-in Ollama end-to-end integration testing through the agent/tool loop
- Cooperative cancellation for long-running local-model generations
- Preservation of the existing backend-enforced filesystem, terminal, Git, sensitive-file, and confirmation security boundaries
- Local-only operation without a Gemini API key
- Windows startup support through `scripts/start-offline-ai.ps1`
- Linux startup support through `scripts/start-offline-ai.sh`
- Startup scripts that can create the Python `uv` environment, install backend requirements, install frontend npm dependencies, and start the application components for the intended local-AI workflow

#### Windows → Linux configuration

Configure the Windows backend environment with the Linux Ollama server address, for example:

```text
PROVIDER=ollama
OLLAMA_HOST=http://<linux-host>:11434
OLLAMA_MODEL=qwen3:8b
```

The Linux machine must have Ollama running and listening on an address reachable from Windows. Putting the model on Linux does not grant it unrestricted access to either computer; the application continues to enforce its normal backend tool and permission controls.

#### Startup scripts

From the repository root:

Windows PowerShell:

```powershell
.\scripts\start-offline-ai.ps1
```

Linux shell:

```bash
./scripts/start-offline-ai.sh
```

The scripts automate routine environment setup where possible, including the Python `uv` environment/dependencies and frontend `npm install`, before starting the application. Environment-specific Ollama configuration remains the responsibility of the user.

#### Verification

The local/offline implementation has been exercised with a real Ollama server and a local model, including a tool-call round trip through the agent/tool loop. The README deliberately does not publish a stale fixed test count; run `pytest` in `server-python` for the current suite. The Vite production frontend can be verified with `npm run build` from `client-react`.

The remaining local/offline work is enhancement rather than completion of the core milestone:

- Surface richer per-model metadata such as context-window size and quantization in the model-selection UI
- Add automatic Ollama installation and optional model pulling where platform support makes that practical
- Expand cross-platform end-to-end coverage for Windows-only, Linux-only, and split-machine deployments

### Provider ecosystem

The provider ecosystem milestone is **completed**, not future work. The current first-class provider set is:

- Gemini
- Ollama
- Kilo
- OpenAI
- xAI/Grok
- OpenRouter
- Anthropic

GitHub Copilot was investigated and deliberately deferred. It is not currently represented as a supported first-class provider.

Future provider-related work is limited to compatibility improvements, regression coverage, and additional provider integrations rather than implementing the current seven-provider milestone itself.

### Reliability and testing

- End-to-end tests covering the frontend, backend, provider, and tool loop, including the frontend's provider/model selector
- Automated security and accessibility regression tests
- A frontend test runner that supports Vite's `import.meta.env`
- Cancellation coverage for the non-Ollama providers under real network conditions
- More robust testing of multi-step agent workflows
- Provider compatibility tests to reduce regressions when adding or changing models

### Desktop application

The initial Electron desktop milestone is implemented. Electron provides a desktop shell for the existing React/Vite application, with the Flask backend continuing to provide the application API during development.

Current Electron work includes:

- Electron main and preload processes
- Secure `contextIsolation` and disabled Node integration in the renderer
- Development loading through Vite at `http://localhost:3000`
- Startup scripts for Windows PowerShell and Linux/macOS-style shells
- Automated `uv` Python environment/dependency setup in the Electron startup scripts
- Automatic startup and readiness checks for the Flask backend and Vite

Future desktop work includes:

- Production packaging and installers
- Integrated project and terminal views (implemented in React UI via `/project/*` and `/terminal/run`)
- Native local-project selection and configuration
- Accessible desktop workflows that do not depend on browser navigation

The roadmap is intentionally incremental: safety, accessibility, reliability, and backend-enforced permissions should remain priorities as more agent capabilities are added.

## License

This project is licensed under the Apache License 2.0. See [LICENSE](LICENSE) for the complete license text.
