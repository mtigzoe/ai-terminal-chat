# AI Terminal Chat

An accessible AI chat interface for working with a local project through controlled tools.

The project currently combines a React frontend with a Flask/Python backend and Google Gemini. The backend uses Gemini's function/tool calling so the model can request operations such as listing files, reading files, and running approved terminal commands. The Python application executes the requested tool and sends the result back to Gemini.

## Architecture

```text
React client (:3000)
        |
        | HTTP
        v
Flask server (:9000)
        |
        v
Google Gemini API
        |
        | tool calls
        v
Local Python tools
  - list files
  - read files
  - run approved commands
```

The tool system is deliberately controlled by the backend. Gemini does not receive unrestricted access to the computer.

## Repository layout

```text
ai-terminal-chat/
├── client-react/       # React/Vite chat frontend
├── server-python/      # Flask + Google Gemini backend
├── LICENSE             # Apache License 2.0
└── README.md
```

## Current features

- React chat interface
- Gemini-powered conversations
- Gemini function/tool calling
- Local project directory listing
- Local text-file reading
- Controlled terminal command execution
- Streaming responses
- CORS support for local frontend/backend development
- Filesystem access restricted to the configured project directory
- Maximum file-size protection when reading files

## Running the React frontend

From `client-react`:

```powershell
cd client-react
npm install
npm run dev
```

The Vite development server normally runs at:

```text
http://localhost:3000
```

## Running the Python backend

The Python backend can be run with [uv](https://docs.astral.sh/uv/), a fast Python package and project manager. This is the recommended way to run the backend during development.

### Windows PowerShell

From the repository root:

```powershell
cd server-python
uv run app.py
```

`uv run` creates and manages the project's virtual environment as needed and runs the application with its dependencies available. You do not need to manually activate a virtual environment first.

If you prefer to create and activate a virtual environment yourself, you can instead use:

```powershell
cd server-python
python -m venv .venv
.\.venv\Scripts\activate
```

Then install the dependencies with:

```powershell
uv pip install -r requirements.txt
```

If the Google GenAI SDK is not already included by the requirements file, install it with:

```powershell
uv pip install google-genai
```

### Configuration

Create a `.env` file from `.env.example` and set your Gemini API key:

```text
GOOGLE_API_KEY=your_api_key_here
PORT=9000
```

Do not commit `.env` or expose your API key in source code.

### Start the server with uv

The simplest development command is:

```powershell
cd server-python
uv run app.py
```

The backend runs at:

```text
http://127.0.0.1:9000
```

The chat endpoint is:

```text
POST http://127.0.0.1:9000/chat
```

The streaming endpoint is:

```text
POST http://127.0.0.1:9000/stream
```

## Tool calling

The backend exposes Python functions to Gemini as tools. A typical interaction is:

```text
User: git status
        |
        v
Gemini requests run_command("git status")
        |
        v
Python executes the approved command
        |
        v
Command output is returned to Gemini
        |
        v
Gemini explains the result to the user
```

The same architecture can be extended with additional tools while keeping explicit restrictions on what the AI can access or execute.

## Security considerations

This project is intended for local development and experimentation.

The backend should not be exposed to an untrusted network without additional security controls. In particular:

- Keep API keys in environment variables.
- Do not commit `.env` files or API keys.
- Restrict filesystem access to the intended project directory.
- Keep terminal command execution allowlisted or otherwise tightly controlled.
- Review new tools before exposing them to an AI model.

## Future direction

Possible future work includes:

- Additional filesystem and Git tools
- More terminal commands with explicit permissions
- Better tool-result presentation in the React interface
- Accessible screen-reader announcements for tool activity
- Gemini and Ollama as interchangeable AI providers
- A shared TypeScript tool layer
- More advanced terminal-agent behavior

## License

This project is licensed under the Apache License 2.0. See [LICENSE](LICENSE) for the complete license text.
