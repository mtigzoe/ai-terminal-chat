# AI Terminal Chat

An accessible AI chat interface for working with a local project through controlled tools.

The project combines a React/Vite frontend with a Flask/Python backend and a provider layer for AI models. The backend does not give an AI model unrestricted access to the computer: models can request explicitly exposed tools, and the Python backend validates and executes those requests under security constraints.

## Table of Contents

- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
  - [Backend setup](#backend-setup)
  - [Frontend setup (web)](#frontend-setup-web)
- [Running the Electron application](#running-the-electron-application)
- [Environment and configuration](#environment-and-configuration)
- [AI providers and models](#ai-providers-and-models)
- [Local and offline AI](#local-and-offline-ai)
- [Terminal and Git integration](#terminal-and-git-integration)
- [Security and permissions](#security-and-permissions)
- [Accessibility](#accessibility)
- [API endpoints](#api-endpoints)
- [Project Status](#project-status)
  - [Completed](#completed)
  - [Future work](#future-work)
- [Testing](#testing)
  - [Frontend tests](#frontend-tests)
  - [Backend tests](#backend-tests)
  - [Accessibility regression tests](#accessibility-regression-tests)
  - [Manual screen-reader testing](#manual-screen-reader-testing)
  - [Accessibility testing limitations](#accessibility-testing-limitations)
- [Development guidelines](#development-guidelines)
- [License](#license)

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
  - list / read / search files
  - run allowlisted commands
  - inspect Git state
  - stage files / modify files with confirmation
```

The tool system is controlled by the backend. AI providers do not receive unrestricted shell or filesystem access.

## Repository layout

```text
ai-terminal-chat/
├── client-react/       # React/Vite chat frontend (+ Electron shell)
├── server-python/      # Flask backend, providers, tools, security
├── scripts/            # Startup helpers (offline AI, Electron)
├── LICENSE             # Apache License 2.0
└── README.md
```

## Prerequisites

- Git
- Node.js and npm
- Python 3.11 or newer
- `uv` (recommended for Python environment and dependency management; used by the startup scripts)
- Credentials for any cloud provider you intend to use
- Ollama installed and running if you use the local/offline workflow

## Quick start

Clone the repository:

```bash
git clone https://github.com/mtigzoe/ai-terminal-chat.git
cd ai-terminal-chat
```

### Backend setup

From `server-python`:

```bash
cd server-python
```

Copy the environment template and edit it for your chosen provider:

```bash
cp .env.example .env
```

Create a virtual environment and install dependencies. Using `uv` (preferred by the repository scripts):

```bash
uv venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
uv pip install -r requirements.txt
```

Alternatively, with a standard virtual environment:

```bash
python -m venv .venv
# activate the venv, then:
pip install -r requirements.txt
```

Start the backend:

```bash
python app.py
```

The server listens on `http://127.0.0.1:9000` by default (`PORT` environment variable).

### Frontend setup (web)

In a second terminal, from the repository root:

```bash
cd client-react
npm install
npm run dev
```

The Vite development server runs at `http://localhost:3000` by default.

To point the client at a different backend URL, set `VITE_API_URL` in a `.env` file under `client-react` (default is `http://localhost:9000`).

## Running the Electron application

A minimal Electron shell is provided so the same React frontend can run as a desktop window while continuing to talk to the Flask backend.

### Development mode

1. Start the Flask backend (`python app.py` from `server-python`, or use a helper script).
2. Start the Vite development server:

   ```bash
   cd client-react
   npm run dev
   ```

3. Launch Electron in development mode (loads `http://localhost:3000`):

   ```bash
   npm run electron:dev
   ```

Helper scripts that start backend, frontend, and Electron together are available under `scripts/`:

- Windows: `scripts/start-electron.ps1`, `scripts/start-electron-dev.ps1`
- Linux/macOS: `scripts/start-electron.sh`

These scripts use `uv` for the Python environment and will start services that are not already listening on ports 9000 and 3000.

### Production / packaged usage

Build the frontend first:

```bash
cd client-react
npm run build
```

Then run Electron against the built assets:

```bash
npm run electron
```

This runs `npm run build && electron . --production`. In production (or when the `--production` flag is used), Electron loads `client-react/dist/index.html`. Unpackaged development runs always load the Vite URL.

Notes:

- Stage-1 Electron does not manage the Flask process automatically when you run `npm run electron:dev` directly; the helper scripts do start the backend when needed.
- Context isolation and sandboxing are enabled; Node integration is disabled in the renderer.
- The preload script exposes a limited API (for example, a folder-picker dialog).

## Environment and configuration

Backend configuration is driven by `server-python/.env` (see `.env.example`). Important variables include:

| Variable | Purpose |
|---|---|
| `PROVIDER` | Active provider id (`gemini`, `ollama`, `kilo`, `openai`, `xai`, `openrouter`, `anthropic`) |
| `PORT` | Flask listen port (default `9000`) |
| Provider-specific keys and models | See `.env.example` (for example `GOOGLE_API_KEY` / `GEMINI_MODEL`, `OLLAMA_*`, `OPENAI_*`, `XAI_*`, `OPENROUTER_*`, `ANTHROPIC_*`) |

API keys remain on the backend only. They are never returned by the provider status or selection endpoints.

Project root and allowed terminal command prefixes can also be managed through the application UI / API and are stored under `~/.ai-terminal-chat/config.json` (outside the project tree).

## AI providers and models

Supported provider identifiers (from `server-python/providers.py`):

| Provider | `PROVIDER` value |
|---|---|
| Google Gemini | `gemini` |
| Ollama (local) | `ollama` |
| Kilo | `kilo` |
| OpenAI | `openai` |
| xAI / Grok | `xai` |
| OpenRouter | `openrouter` |
| Anthropic | `anthropic` |

The same agent and tool layer is used across providers. Provider capabilities (tools, streaming, model listing, local, requires API key) are reported by the backend so the UI can adapt.

Switching providers or models at runtime is done through the `/providers/select` endpoint (and the Settings UI). Model listing is available via `/providers/<name>/models` when the provider supports it.

## Local and offline AI

Ollama is supported as a local provider (`PROVIDER=ollama`). Typical environment settings:

```text
PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_MODEL=llama3.1
```

Helper scripts automate environment setup and startup for an offline-oriented workflow:

- Windows: `scripts/start-offline-ai.ps1`
- Linux: `scripts/start-offline-ai.sh`

These scripts require `uv` and `npm`, create or update the Python virtual environment, install dependencies when needed, verify that Ollama is reachable, and start the Flask backend plus the React development server. You can pass a model name as an argument (or set `OLLAMA_MODEL`).

Ollama may run on the same machine or on a reachable host (for example a Linux machine serving models to a Windows backend). The application continues to enforce its normal backend tool and permission controls regardless of where the model runs.

## Terminal and Git integration

The backend exposes a controlled set of tools to the model and to the UI:

- **Filesystem (read)**: `list_files`, `read_file`, `search_files` — restricted to the configured project root; sensitive paths are blocked.
- **Terminal**: `run_command` — only allowlisted command prefixes may run. Chaining, piping, redirection, and a set of blocked patterns are refused. The allowlist is configurable via Settings / `/allowed-commands` and is persisted outside the project.
- **Git (read-only)**: `git_status`, `git_diff`, `git_log`, `git_branch`.
- **Git (mutating, confirmation required)**: `git_add` stages a single file; there is no commit or push tool.
- **File mutation (confirmation required)**: `create_file`, `write_file`, `apply_patch`, `delete_file`.

Mutating operations use a preview-then-confirm pattern. The model cannot self-authorize a write; confirmation is performed through the `/confirm` endpoint with an opaque action id.

The integrated terminal panel in the UI uses the same `run_command` path and therefore the same allowlist and restrictions.

## Security and permissions

This project is intended for local development and experimentation. Do not expose the backend to an untrusted network without additional controls.

Implemented protections include:

- API keys loaded from environment variables and never returned to the frontend.
- Filesystem access confined to the configured project root; absolute paths and path traversal are rejected.
- Sensitive filenames and paths (for example `.env*`, credential-like names, `.git` contents, key material) are blocked from model access.
- Size limits on file reads and searches.
- Terminal commands restricted to an explicit, configurable allowlist with additional blocked patterns and no shell metacharacters for chaining or redirection.
- File creation, modification, patching, deletion, and Git staging require explicit user confirmation via a server-side pending-action mechanism.
- Pending actions use opaque identifiers, are consumed once, and re-check security constraints before execution.
- Per-tool execution timeouts and detection of repeated/stuck tool calls.

These measures are defense-in-depth, not a guarantee of safety for public deployment.

## Accessibility

Accessibility is a core goal. Implemented features include:

- Keyboard-operable chat, workspace tabs, and project tree.
- Accessible expandable/collapsible project tree with focus management, filtering, and multi-file selection.
- ARIA live regions and status announcements for agent progress and errors, with clear-then-set re-announcement support.
- Streaming tool-activity announcements via polite live regions so progress is heard without leaving the message input.
- Concise terminal result summaries (exit code and line counts) instead of dumping long stdout/stderr into live regions.
- Labelled controls and dialog semantics (including Escape dismissal and a focus trap on the confirmation dialog).
- Skip links to conversation, message input, and workspace panels.
- Screen-reader-oriented presentation of tool activity and conversation state.

Automated tests cover many structural and keyboard behaviours; they do not replace manual testing with JAWS, NVDA, or Orca. See the Testing section for details and limitations.

## API endpoints

Main endpoints implemented by the Flask backend:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/chat` | Run a conversation to completion; returns final text and tool activity |
| `POST` | `/stream` | Stream progress, tool activity, and the final response as plain text |
| `POST` | `/confirm` | Approve or reject a pending mutating action by `action_id` |
| `POST` | `/cancel/<request_id>` | Cooperatively cancel an in-flight chat or stream request |
| `GET` | `/providers` | Active provider status, capabilities, and supported provider names (`?probe=0` skips reachability check) |
| `GET` | `/providers/<name>/models` | List models for a provider without switching |
| `POST` | `/providers/select` | Switch active provider and optional model |
| `GET`/`POST` | `/project-root` | Read or set the project root used by tools |
| `GET`/`POST`/`DELETE` | `/allowed-commands` | List, add, or remove allowlisted terminal command prefixes |
| `GET` | `/project/list` | List directory entries inside the project root |
| `GET` | `/project/read` | Read a text file inside the project root |
| `POST` | `/terminal/run` | Run an allowlisted command (same rules as the tool) |

## Project Status

### Completed

- [x] Provider ecosystem
- [x] Agent capabilities
- [x] Security and permissions
- [x] Terminal and Git integration
- [x] Local and offline AI
- [x] Initial Electron integration
- [x] Configurable allowed commands
- [x] Accessible expandable/collapsible project tree
- [x] Keyboard navigation and screen-reader support for the project tree
- [x] Project tree expand/collapse controls and focus management
- [x] Project tree filtering and multi-file selection
- [x] Project tree state persistence and workspace-tab persistence
- [x] Project path display and project-tree recovery states
- [x] Automated accessibility regression tests
- [x] Advanced screen-reader support for agent status, tool activity, terminal output, and confirmation dialogs
- [x] Skip links and clearer landmarks for conversation, message input, and workspace panels
- [x] Concise terminal result summaries (exit code + line counts) to avoid dumping long output into live regions
- [x] Streaming tool-activity announcements via polite live regions
- [x] Confirmation dialog focus trap and safer initial focus on Deny

### Future work

- [ ] Better integrated project and terminal views
- [ ] Native local-project selection/configuration
- [ ] Accessible desktop workflows that don't depend on browser navigation
- [ ] TypeScript backend
- [ ] Virtualized project tree for very large directories
- [ ] Accessible project-tree context menu
- [ ] Git status badges in the project tree
- [ ] Drag-and-drop file workflows with keyboard alternatives
- [ ] Optional user-controlled announcement verbosity preferences

## Testing

### Frontend tests

The React frontend uses **Vitest** with **@testing-library/react** and **jest-dom**.

```bash
cd client-react
npm test
```

Or run in watch mode:

```bash
cd client-react
npm run test:watch
```

### Backend tests

The Python/Flask backend uses **pytest**.

```bash
cd server-python
uv run pytest tests/ -v
```

### Accessibility regression tests

The frontend test suite includes automated accessibility regression tests covering three layers:

1. **Automated DOM/axe tests** — catch common WCAG/HTML accessibility regressions.
   - `App.a11y.test.jsx` runs `jest-axe` against the full chat app.
2. **Keyboard and focus tests** — verify that key workflows are operable without a mouse.
   - `App.keyboard.a11y.test.jsx` — Enter sends, Shift+Enter inserts a newline, Escape closes dialogs, focus returns to the input after a response.
   - `MessageInput.a11y.test.jsx` — label association, `aria-describedby` help text, Enter/Shift+Enter behavior.
   - `WorkspaceTabs.a11y.test.jsx` — ArrowLeft/ArrowRight, Home, End keyboard navigation; `aria-selected`; tab sequence management.
   - `TerminalPanel.a11y.test.jsx` — `aria-live` output region, `role="status"` for status updates, Enter submission, focus return.
   - `Header.a11y.test.jsx` — `aria-pressed` on the stream toggle, clear-conversation dialog semantics, Escape dismissal.
   - `ConversationDisplayArea.a11y.test.jsx` — message `aria-label`, `aria-busy`, streaming `aria-live="off"`, decorative images.
3. **Live-region and ARIA tests** — verify status announcements.
   - `App.test.jsx` and `App.chat.test.jsx` — agent status region (`aria-live`, `aria-atomic`), error announcements, dialog semantics.

Run only the accessibility tests:

```bash
cd client-react
npx vitest run --reporter=verbose src/*.a11y.test.jsx src/*.a11y.test.jsx
```

### Manual screen-reader testing

Automated tests can verify DOM structure, accessible names, focus, keyboard behavior, and ARIA states, but they cannot fully reproduce how JAWS, NVDA, or Orca interact with the application.

The following behaviors should still be verified manually with a screen reader:

- **Chat messages**: JAWS/NVDA/Orca correctly announces new messages and streaming updates.
- **Agent status**: polite and assertive live-region announcements are heard at the right time; identical consecutive status messages re-announce.
- **Tool activity while streaming**: new progress/result items are announced via the polite live region without requiring the user to leave the message input.
- **Terminal output**: a concise summary (exit code + line counts) is announced; full stdout/stderr remains available in the log for browse mode.
- **Skip links**: Tab from the start of the page reaches Skip to conversation / message input / project and terminal, and activation moves focus to the target region.
- **Project tree**: treeitem roles are navigable with screen-reader arrow keys; expand/collapse state is announced.
- **Workspace tabs**: tab and tabpanel roles are announced correctly when switching panels.
- **Dialogs**: confirmation dialogs receive focus on Deny, trap Tab between Deny and Allow, announce their description, and close on Escape.
- **Settings form**: all form fields are labelled and errors are announced.

### Accessibility testing limitations

- Automated tests use **jsdom**, which does not implement all browser behaviors (for example, default textarea handling of Shift+Enter, native focus behavior inside `setTimeout`, or xterm.js terminal emulation).
- **JAWS/NVDA/Orca-specific behaviors** (virtual cursor, forms mode, browse/read mode) cannot be tested with these tools.
- **xterm.js terminal accessibility** depends on the xterm.js accessibility renderer and cannot be fully tested in jsdom. Terminal keyboard tests verify the surrounding React UI, not xterm.js internals.
- Tests verify that the correct ARIA attributes are present in the DOM; they do not verify that every screen reader interprets them identically.
- Tests do not cover **visual** accessibility (color contrast, font sizing, motion preferences beyond the CSS media query).

## Development guidelines

When extending the project:

1. Inspect the existing implementation before changing it.
2. Keep provider-specific code inside the provider layer.
3. Keep local-tool validation and security rules in the backend rather than trusting the model.
4. Prefer small, targeted changes over rewriting complete files unnecessarily.
5. Add tests for new provider behaviour and important tool/security behaviour.
6. Run the relevant tests before committing.
7. Test frontend accessibility changes with keyboard navigation and a screen reader.

## License

This project is licensed under the Apache License 2.0. See [LICENSE](LICENSE) for the complete license text.
