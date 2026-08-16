# Reliability and Testing — delivery contents

## How to apply

From the root of the `ai-terminal-chat` repo, on the `main` branch:

```
git apply reliability-and-testing.patch
```

(Verified: applies cleanly to a clean checkout of `main`, and the
patched backend suite passes — 285 passed, 4 skipped.)

Alternatively, the `files/` folder contains every new/modified file
individually, at its correct path relative to the repo root, if you'd
rather copy them in by hand or review them one at a time.

## Files changed

### Modified
- `README.md` — fixed a stale/incorrect "Running the frontend checks"
  section (it told readers to run `node src/agentStatus.test.js`
  directly, which actually throws; replaced with the correct `npm
  test` instruction).
- `server-python/openai_compatible.py` — non-JSON provider response
  bodies now raise a clear, provider-attributed `RuntimeError` instead
  of leaking a raw `ValueError` (brings OpenAI/xAI/OpenRouter/Kilo/
  Ollama in line with how the Anthropic adapter already behaved).
- `server-python/tests/test_tools.py` — removed a block of dead,
  unreachable code left over in a fixture (no behavior change).
- `client-react/src/testSetup.js` — added a `scrollIntoView` stub
  (jsdom doesn't implement it; needed by any test that submits a chat
  message).
- `client-react/src/App.test.jsx`, `client-react/src/App.a11y.test.jsx`
  — added an axios mock so these existing tests stop making real,
  unmocked network calls. No existing assertions changed.

### New test files
- `server-python/tests/test_app_chat_endpoints.py` (16 tests) — first
  HTTP-level tests for `/chat` and `/stream`, plus the global error
  handler.
- `server-python/tests/test_app_provider_select.py` (5 tests) —
  regression coverage for the project-root/provider-select atomicity
  fix.
- `server-python/tests/test_provider_error_handling.py` (13 tests) —
  malformed responses, unexpected shapes, and timeouts across provider
  adapters.
- `server-python/tests/test_write_tools.py` (26 tests) — create_file /
  write_file / delete_file / apply_patch preview, confirm, and failure
  paths.
- `client-react/src/App.chat.test.jsx` (10 tests) — loading/success/
  error/cancellation for streaming and non-streaming chat, including a
  regression test for the message composer staying usable.
- `client-react/src/components/SettingsPage.test.jsx` (9 tests) —
  previously zero coverage: load/save success and failure, folder
  picker failure.

## Verified before packaging
- Backend: 285 passed, 4 skipped (`pytest`)
- Frontend: 28 passed (`npm test`)
- Frontend production build: succeeds (`npm run build`)
- Patch applies cleanly to a fresh `git checkout` of `main` and the
  patched backend suite re-passes in full.

Nothing has been committed or pushed to the repository.
