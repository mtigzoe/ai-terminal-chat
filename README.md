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
- Git staging through a confirmation-required `git_add` operation
- Streaming responses
- Tool-activity reporting
- Agent lifecycle progress reporting for planning, inspection, execution, confirmation, verification, recovery, and completion
- Accessible frontend agent-status announcements
- Confirmation-required file creation, modification, patching, deletion, and Git staging
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

Install Python dependencies with the repository's supported environment workflow. If the repository has a `pyproject.toml`, use `uv sync`; otherwise use the `requirements.txt` workflow described below.

For a standard Python virtual environment on Windows:

```powershell
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
```

Start the backend:

```powershell
python app.py
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

## Running the Python tests

From `server-python`, using an activated virtual environment with the required dependencies:

```powershell
pytest
```

To run the agent tests specifically:

```powershell
pytest tests/test_agent.py -q
```

To run the pending-confirmation tests specifically:

```powershell
pytest tests/test_pending.py -q
```

To run a particular test file:

```powershell
pytest tests/test_app.py
```

If the repository gains a `pyproject.toml` and `uv.lock` in the future, the equivalent managed-environment commands can be run with `uv run`.

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

### Confirm a pending action

```text
POST /confirm
```

Explicitly authorizes a previously previewed mutating operation. The backend retrieves the exact pending operation by its opaque action ID rather than trusting model-supplied tool names or arguments.

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

The long-term goal is to develop AI Terminal Chat into an accessible, security-conscious terminal agent for local software development. Possible future work includes:

### Accessibility

- Advanced screen-reader support for tool activity, model state, errors, and long terminal output
- Accessible confirmation dialogs and action previews
- Improved keyboard navigation and predictable focus management
- Keyboard shortcuts for common terminal-agent workflows
- Accessibility regression testing for important UI changes

### Agent capabilities

The core Agent Capabilities milestone is implemented. It adds multi-step agent behavior, lifecycle progress reporting, recovery from failed or repeated actions, verification guidance, and accessible frontend status announcements while preserving backend-enforced safety controls.

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

The core Security and Permissions milestone is implemented. It provides a unified backend-enforced pending-action confirmation system for filesystem mutations and Git staging while preserving the existing terminal allowlist and hard security restrictions.

Implemented capabilities include:

- Unified server-side pending actions for confirmation-required mutations
- Opaque action IDs and exact storage of the requested tool and arguments
- One-time confirmation authorization through the explicit `/confirm` endpoint
- Protection against model-supplied `confirm=True` bypasses
- Confirmation support for file creation, modification, patching, deletion, and Git staging
- Reapplication of filesystem path and sensitive-file checks during confirmed execution
- Confirmation lifecycle tests covering forged actions, replay attempts, cancellation, failures, and timeouts
- Expanded security regression coverage for path, command, sensitive-file, and confirmation behavior

The following remain future work rather than completed features:

- Configurable permission levels for different tool categories
- Action history or audit logging
- Broader confirmation of terminal commands, subject to a separate security review
- Additional Git mutations such as commit, checkout, reset, and push, with appropriate confirmation and permission controls

### Terminal and Git integration

The core Terminal and Git Integration milestone is implemented. The backend now provides controlled terminal execution and dedicated Git inspection/staging tools while preserving the existing security and confirmation model.

Implemented capabilities include:

- Allowlisted development command execution through the backend-controlled `run_command` tool
- Shell chaining, piping, redirection, and substitution blocked at the command boundary
- Destructive/system commands and credential-oriented commands denied by defense-in-depth checks
- Bounded command execution with timeouts and output-size limits
- Git status, diff, log, and branch inspection through dedicated tools
- Project-path validation for Git diff requests
- Bounded Git output with explicit truncation reporting
- Git staging through the backend-enforced, confirmation-required `git_add` operation
- Regression tests covering command security, Git inspection, path validation, output limits, and staging confirmation

The following remain future work rather than requirements of the completed milestone:

- Better screen-reader presentation of terminal output and Git changes
- More explicit user-facing presentation of long-running command state and timeout results
- Additional terminal commands with explicit permissions
- Additional Git mutations such as commit, checkout, reset, and push, each requiring a separate security review and appropriate confirmation

### Local and offline AI

- Complete Ollama provider support
- Support for additional OpenAI-compatible local providers
- Local-only/offline operation without a cloud API dependency
- Model selection and provider configuration from the application
- Provider capability detection so unsupported tool or streaming features are handled cleanly

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
