# Environment Configuration

This file documents the environment variables used by the Python backend. It is safe for AI coding agents to read; it contains names, defaults, and configuration guidance only, not credentials.

## Backend

- `PROVIDER` — Provider used by `/chat` and `/stream`. Supported values: `gemini`, `ollama`, `kilo`, `openai`, `xai`, `openrouter`, `anthropic`. Default: `gemini`.
- `PORT` — HTTP server port. Default: `9000`.
- `HOST` — Bind address. Default: `127.0.0.1`; use `0.0.0.0` when the backend runs in Docker and must be reachable from the host.

## Gemini

- `GOOGLE_API_KEY` — Gemini API credential. Never commit its value.
- `GEMINI_MODEL` — Gemini model name. Default: `gemini-3.6-flash`.

## Ollama

- `OLLAMA_BASE_URL` — OpenAI-compatible Ollama endpoint. Default: `http://localhost:11434/v1`.
- `OLLAMA_HOST` — Optional Ollama host override.
- `OLLAMA_MODEL` — Ollama model name. Default: `llama3.1`.
- `OLLAMA_TIMEOUT` — Request timeout in seconds. Default: `120`.

## Kilo

- `KILO_API_KEY` — Kilo gateway credential. Never commit its value.
- `KILO_BASE_URL` — Kilo gateway URL. Default: `https://api.kilo.ai/api/gateway`.
- `KILO_MODEL` — Kilo model identifier. Default: `kilocode/kilo-auto/balanced`.
- `KILO_TIMEOUT` — Request timeout in seconds. Default: `120`.

## OpenAI

- `OPENAI_API_KEY` — OpenAI API credential. Never commit its value or expose it to the React frontend.
- `OPENAI_BASE_URL` — OpenAI API base URL. Default: `https://api.openai.com/v1`.
- `OPENAI_MODEL` — OpenAI model name. Default: `gpt-4o-mini`.
- `OPENAI_TIMEOUT` — Request timeout in seconds. Default: `120`.

## xAI

- `XAI_API_KEY` — xAI API credential. Never commit its value or expose it to the React frontend.
- `XAI_BASE_URL` — xAI API base URL. Default: `https://api.x.ai/v1`.
- `XAI_MODEL` — xAI/Grok model name. Default: `grok-4.6`.
- `XAI_TIMEOUT` — Request timeout in seconds. Default: `120`.

## OpenRouter

- `OPENROUTER_API_KEY` — OpenRouter API credential. Never commit its value or expose it to the React frontend.
- `OPENROUTER_BASE_URL` — OpenRouter API base URL. Default: `https://openrouter.ai/api/v1`.
- `OPENROUTER_MODEL` — OpenRouter model slug passed through unchanged. Default: `openai/gpt-4o-mini`.
- `OPENROUTER_TIMEOUT` — Request timeout in seconds. Default: `120`.
- `OPENROUTER_HTTP_REFERER` — Optional attribution header for OpenRouter rankings.
- `OPENROUTER_APP_TITLE` — Optional application title header for OpenRouter rankings.

## Anthropic

- `ANTHROPIC_API_KEY` — Anthropic API credential. Never commit its value or expose it to the React frontend.
- `ANTHROPIC_BASE_URL` — Anthropic API base URL. Default: `https://api.anthropic.com`.
- `ANTHROPIC_MODEL` — Anthropic model name. Default: `claude-sonnet-4-5`.
- `ANTHROPIC_TIMEOUT` — Request timeout in seconds. Default: `120`.
- `ANTHROPIC_MAX_TOKENS` — Maximum output tokens. Default: `8192`.

## Security

Keep real API keys in local environment variables or deployment secret storage. Do not put real credentials in `.env.example`, source code, documentation, commits, or client-side configuration.

`.env.example` remains the canonical template for local environment setup, but AI coding agents may refuse to read it because environment files can contain credentials. Use this document and the backend configuration code instead.
