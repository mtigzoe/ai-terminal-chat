# Environment variables

The TypeScript server supports these providers:

- Gemini
- Ollama
- Kilo
- OpenAI
- xAI
- OpenRouter
- Anthropic

The provider configuration is defined in `src/providers/config.ts`.

## Gemini

- `GOOGLE_API_KEY` — Gemini API key.
- `GEMINI_MODEL` — model name. Defaults to `gemini-3.6-flash`.

## Ollama

- `OLLAMA_MODEL` — model name. Defaults to `llama3.1`.
- `OLLAMA_BASE_URL` — OpenAI-compatible Ollama base URL.
- `OLLAMA_HOST` — fallback Ollama host when `OLLAMA_BASE_URL` is not set.
- `OLLAMA_TIMEOUT` — request timeout in seconds. Defaults to `120`.

Default base URL: `http://localhost:11434/v1`.

## Kilo

- `KILO_API_KEY` — Kilo API key.
- `KILO_MODEL` — model name. Defaults to `kilocode/kilo-auto/balanced`.
- `KILO_BASE_URL` — API base URL. Defaults to `https://api.kilo.ai/api/gateway`.
- `KILO_TIMEOUT` — request timeout in seconds. Defaults to `120`.

## OpenAI

- `OPENAI_API_KEY` — OpenAI API key.
- `OPENAI_MODEL` — model name. Defaults to `gpt-4o-mini`.
- `OPENAI_BASE_URL` — API base URL. Defaults to `https://api.openai.com/v1`.
- `OPENAI_TIMEOUT` — request timeout in seconds. Defaults to `120`.

## xAI

- `XAI_API_KEY` — xAI API key.
- `XAI_MODEL` — model name. Defaults to `grok-4.6`.
- `XAI_BASE_URL` — API base URL. Defaults to `https://api.x.ai/v1`.
- `XAI_TIMEOUT` — request timeout in seconds. Defaults to `120`.

## OpenRouter

- `OPENROUTER_API_KEY` — OpenRouter API key.
- `OPENROUTER_MODEL` — model name. Defaults to `openai/gpt-4o-mini`.
- `OPENROUTER_BASE_URL` — API base URL. Defaults to `https://openrouter.ai/api/v1`.
- `OPENROUTER_TIMEOUT` — request timeout in seconds. Defaults to `120`.

## Anthropic

- `ANTHROPIC_API_KEY` — Anthropic API key.
- `ANTHROPIC_MODEL` — model name. Defaults to `claude-sonnet-4-5`.
- `ANTHROPIC_BASE_URL` — API base URL. Defaults to `https://api.anthropic.com`.
- `ANTHROPIC_TIMEOUT` — request timeout in seconds. Defaults to `120`.

## Security

Never commit actual API keys or other credentials. Use environment variables or your deployment platform's secret/environment-variable settings for secret values.

`.env.example` remains intentionally named as a conventional example environment file. AI coding tools may refuse to read it because they classify `.env`-style files as potentially sensitive. This document provides the non-secret configuration reference that coding agents can safely read.
