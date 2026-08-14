# AI Terminal Chat

An accessible AI chat interface for working with a local project through controlled tools.

The project combines a React frontend with a Flask/Python backend and a provider layer for AI models. Gemini currently provides the primary function/tool-calling implementation, while the provider architecture is designed to make additional providers such as Ollama easier to add.

The backend does not give an AI model unrestricted access to the computer. The model can request explicitly exposed tools, and the Python backend validates and executes those requests.

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
   |         |
 Gemini    Ollama
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

```text
ai-terminal-chat/
├── client-react/       # React/Vite chat frontend
├── server-python/      # Flask backend, providers, and local tools
├── LICENSE             # Apache License 2.0
└── README.md
```

## Current features

- React chat interface
- Keyboard-friendly and screen-reader-oriented interface
- Gemini-powered conversations
- Provider abstraction for AI backends
- Gemini function/tool calling
- Local project directory listing
- Local text-file reading
- Text-file searching
- Controlled terminal command execution
- Git status, diff, log, and branch inspection
- Streaming responses
- Tool-activity reporting
- Agent lifecycle progress reporting for planning, inspection, execution, confirmation, verification, recovery, and completion
- Accessible frontend agent-status announcements
- Confirmation-required file creation, modification, patching, and deletion
- Filesystem access restricted to the project directory
- Sensitive-file protection for files such as `.env`, credentials, keys, and `.git`
- Maximum file-size protection when reading and searching files
- Per-tool execution timeouts
- Protection against repeated/stuck tool calls
- CORS support for local frontend/backend development

## Prerequisites

- Git
- Node.js and npm
- Python 3.11 or newer
- `uv` for Python dependency and environment management
- A Google Gemini API key when using the Gemini provider

Install `uv` from the official Astral documentation if it is not already installed.

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

Create or update the `.env` file from `.env.example` and set your API key:

```text
GOOGLE_API_KEY=your_api_key_here
PORT=9000
```

Do not commit `.env` or expose your API key in source code.

Install the Python project dependencies with `uv`:

```powershell
uv sync
```

`uv` creates and manages the project's virtual environment and installs the dependencies declared by the Python project. You do not need to manually create or activate a traditional `venv` when using this workflow.

Start the backend:

```powershell
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

## Running the Python backend with uv

The normal development workflow is:

```powershell
cd server-python
uv sync
uv run app.py
```

To run the full Python test suite:

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

Using `uv run` ensures commands use the project's managed Python environment and dependencies.

## Running the frontend checks

From `client-react`:

```powershell
npm install
```

Build the production frontend:

```powershell
npm run build
```

The agent-status helper has a standalone test script that does not require a test runner:

```powershell
node src/agentStatus.test.js
```

The current `package.json` does not define an `npm test` script. React Testing Library dependencies are present, but the React test files require a configured test runner before they can be executed as a standard npm test command.

## Running without uv

`uv` is the recommended workflow, but a standard Python virtual environment can also be used.

### Windows PowerShell

From the repository root:

```powershell
cd server-python
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

### Linux/macOS

```bash
cd server-python
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

## API endpoints

The Flask backend provides these main endpoints:

### Chat

```text
POST /chat
```

Runs a conversation to completion and returns the final model response together with tool activity.

### Streaming chat

```text
POST /stream
```

Streams tool activity and the model's response as plain text for compatibility with the React client.

## Tool calling

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
Backend produces a confirmation preview
        |
        v
User explicitly confirms
        |
        v
Backend applies the change
        |
        v
AI verifies the result
```

The confirmation requirement is enforced by the backend tool implementation rather than relying only on the model to behave correctly.

## Provider architecture

The Python backend is being organized around a provider abstraction so the application does not need to duplicate its agent logic for every model vendor.

The intended separation is:

```text
Flask API
   |
   v
Agent/tool loop
   |
   v
Provider interface
   |----------------|
   v                v
Gemini            Ollama
```

A provider is responsible for communicating with an AI model, while the agent/tool layer remains responsible for executing local tools and enforcing the application's safety rules.

This makes it possible to add or change providers without moving filesystem, terminal, Git, or confirmation logic into each provider implementation.

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
6. Run the relevant tests with `uv run pytest` before committing.
7. Test frontend accessibility changes with keyboard navigation and a screen reader.

## Future direction

The long-term goal is to develop AI Terminal Chat into an accessible, security-conscious terminal agent for local software development. Possible future work includes:

### Accessibility

- Advanced screen-reader support for tool activity, model state, errors, and long terminal output
- Accessible confirmation dialogs and action previews
- Improved keyboard navigation and predictable focus management
- Keyboard shortcuts for common terminal-agent workflows
- Accessibility regression testing for important UI changes

### Agent capabilities

The core Agent Capabilities milestone is implemented on the `agent-capabilities` branch. It adds multi-step agent behavior, lifecycle progress reporting, recovery from failed or repeated actions, verification guidance, and accessible frontend status announcements while preserving backend-enforced safety controls.

Implemented capabilities include:

- Multi-step task execution with explicit planning and progress reporting
- Lifecycle progress phases for planning, inspection, execution, confirmation, verification, recovery, completion, and errors
- Post-change verification guidance and support; verification remains model-driven with tool support rather than an unconditional automatic command runner
- Recovery and retry guidance for failed tools, including recovery hints after consecutive errors
- Detection and protection against repeated or stuck agent actions
- Context-aware tool-selection guidance that favors inspection, targeted changes, and minimal useful tool sequences
- Structured frontend agent-status events and screen-reader announcements without unnecessary focus changes
- Expanded agent and pending-confirmation tests

Further enhancements may include structured plan objects, automatic continuation after a confirmed write, richer frontend progress presentation, and expanded end-to-end testing. These are follow-up improvements rather than requirements for the completed milestone.

### Security and permissions

- A unified pending-action confirmation system for files, terminal commands, and Git operations
- Configurable permission levels for different tool categories
- Clear previews of proposed changes before execution
- Action history or audit logging
- Expanded security regression tests for path traversal, command restrictions, sensitive files, and confirmation enforcement

### Local and offline AI

- Complete Ollama provider support
- Support for additional OpenAI-compatible local providers
- Local-only/offline operation without a cloud API dependency
- Model selection and provider configuration from the application
- Provider capability detection so unsupported tool or streaming features are handled cleanly

### Terminal and Git integration

Read-only Git inspection and controlled terminal execution are implemented on the `git-integrations` branch. Dedicated tools expose `git status`, `git diff` (including staged), `git log`, and `git branch`. The general `run_command` tool remains restricted to an explicit allowlist of development commands (selected Git inspection forms, tests, builds, linters, and dependency installation). Destructive, system-level, and credential-exposing commands continue to be refused, and command chaining, piping, redirection, and shell substitution are blocked.

Implemented capabilities include:

- Dedicated Git inspection tools (`git_status`, `git_diff`, `git_log`, `git_branch`) separate from the general command runner
- Allowlisted terminal commands for common local development workflows (tests, builds, package installs, version checks)
- Backend validation of commands before execution, with timeouts and output size limits
- Clear separation between read-only inspection and any future mutation of repository state

Further work may include:

- Additional terminal commands with explicit, reviewed permissions and clear documentation of each allowed prefix
- Git mutation operations (for example add, commit, checkout, and carefully scoped push) gated by the same confirmation model used for file changes
- Unified pending-action confirmation for terminal and Git writes, with accessible previews of the exact command or repository change
- Better presentation of long command output and Git diffs for screen-reader users (structured summaries, navigable sections, and truncation notices)
- Improved handling of long-running commands, cancellation, and non-interactive workflows
- Expanded regression tests for allowlist enforcement, blocked patterns, Git tool boundaries, and confirmation requirements for any new write paths

These extensions should preserve the existing security model: the backend, not the model, decides what may run, and repository-changing actions should never execute without explicit user confirmation.

### Provider ecosystem

- Complete provider/agent test coverage
- Additional cloud and local AI providers
- Consistent tool-calling and streaming behavior across providers
- Provider compatibility tests to reduce regressions when adding models

### Reliability and testing

- End-to-end tests covering the frontend, backend, provider, and tool loop
- Automated security and accessibility regression tests
- Better error, timeout, cancellation, and recovery handling
- More robust testing of multi-step agent workflows

### Desktop application

- An Electron-based desktop application for a more integrated terminal experience
- Integrated project and terminal views
- Native local-project selection and configuration
- Accessible desktop workflows that do not depend on browser navigation

The roadmap is intentionally incremental: safety, accessibility, reliability, and backend-enforced permissions should remain priorities as more agent capabilities are added.

## License

This project is licensed under the Apache License 2.0. See [LICENSE](LICENSE) for the complete license text.
