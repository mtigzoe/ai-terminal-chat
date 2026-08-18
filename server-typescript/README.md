# TypeScript Backend

This directory contains the experimental TypeScript backend for AI Terminal Chat.

The TypeScript backend is being developed alongside the existing Python backend in `server-python/`. It is not yet a replacement for the Python implementation. The goal is to incrementally reproduce the backend API, provider layer, agent/tool system, filesystem controls, terminal integration, Git integration, and security model in TypeScript.

## Current status

Phase 1 (`config.ts`, `types.ts`) and Phase 2 (`security.ts`, `filesystem.ts`)
are implemented and tested. All other modules are still empty skeletons.

Currently included:

- Node.js project configuration (`"type": "module"`, ESM/NodeNext)
- TypeScript, strict compiler configuration
- `tsx` for running TypeScript during development and for tests
- Node.js type definitions (`@types/node`)
- Typed environment/config loading (`config.ts`)
- Shared API/provider/tool/agent types (`types.ts`)
- Project-root, path-containment, and sensitive-file security controls (`security.ts`)
- Read-only filesystem tools: `list_files`, `read_file`, `search_files` (`filesystem.ts`)

## Migration checklist

Status of each `server-python` module against its `server-typescript`
replacement. "Tests completed" counts automated TypeScript tests, not
manual verification.

| Python module | TypeScript replacement | Status | Tests completed | Known differences |
| --- | --- | --- | --- | --- |
| *(none — no single config.py)* | `config.ts` | Done (Phase 1) | Yes (17 tests) | New module: consolidates env loading (`load_dotenv()` in `app.py`), `PORT` handling, and `PROVIDER` selection (`providers.py`/`__init__.py`) behind typed helpers. Server bind host is hardcoded to `127.0.0.1` (not env-configurable) to preserve the existing loopback-only security posture. |
| *(implicit — dict/dataclass shapes across `base.py`, `providers.py`, `tools.py`, `agent.py`, `pending.py`, `app.py`)* | `types.ts` | Done (Phase 1) | N/A (type-only; verified via `tsc --noEmit`) | Wire types keep existing snake_case JSON keys for `client-react` compatibility; internal-only types (e.g. `Provider`) use camelCase. |
| `security.py` | `security.ts` | Done (Phase 2) | Yes (53 tests) | Symlink-based path-traversal protection re-implemented explicitly (`resolveFollowingSymlinks`) since Node's `path.resolve()`, unlike Python's `Path.resolve()`, does not follow symlinks or touch the filesystem — verified equivalent to server-python by direct empirical testing (see report). `CHOOSE_PROJECT_ROOT` (native folder picker) sentinel is rejected with a clear error instead of opening a server-side dialog; unused by client-react in practice (see report). Case sensitivity of path-containment checks is host-platform-dependent (case-insensitive on Windows, case-sensitive on POSIX), both branches unit-tested via an explicit parameter. |
| `tools.py` (filesystem functions: `list_files`, `read_file`, `search_files`) | `filesystem.ts` | Done (Phase 2) | Yes (27 tests) | `read_file`/`search_files` use `TextDecoder("utf-8", { fatal: true })` to reject invalid UTF-8 the same way Python's `read_text()` does (Node's default `Buffer#toString("utf8")` would silently substitute replacement characters instead). `search_files`' non-recursion into symlinked directories (`os.walk(followlinks=False)`) re-implemented explicitly and verified empirically against server-python. No dedicated Python unit tests existed for these three functions' own normal-path behavior (only indirect coverage via agent/provider mocks) — TypeScript tests were written directly against `tools.py`'s implementation as the spec; see report. |
| `tools.py` (terminal functions: `run_command`, `is_command_allowed`) | `terminal.ts` | Not started (Phase 3) | No | — |
| `tools.py` (git functions: `git_status`, `git_diff`, `git_log`, `git_branch`, `git_add`) | `git.ts` | Not started (Phase 3) | No | — |
| `base.py`, `providers.py`, `gemini.py`, `ollama.py`, `kilo.py`, `openai_provider.py`, `openai_compatible.py`, `xai.py`, `openrouter.py`, `anthropic_provider.py` | `providers.ts` | Not started (Phase 4) | No | — |
| `tools.py` (write functions: `create_file`, `write_file`, `delete_file`, `apply_patch`; `TOOL_SCHEMAS`) | `tools.ts` | Not started (Phase 5) | No | — |
| `agent.py`, `pending.py`, `cancellation.py` | `agent.ts` | Not started (Phase 6) | No | — |
| `app.py` | `app.ts` | Not started (Phase 7) | No | — |
| *(none — `python app.py` entry point)* | `main.ts` | Not started (Phase 7) | No | — |

## Requirements

- Node.js
- npm

Check the installed versions:

```powershell
node --version
npm --version
```

## Development setup

From the repository root:

```powershell
cd server-typescript
npm install
```

The project uses TypeScript with `tsx` during development.

## Recommended project structure

As development progresses, the backend is expected to grow toward this structure:

```text
server-typescript/
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── routes/
│   ├── providers/
│   ├── agent/
│   ├── tools/
│   ├── security/
│   └── types/
├── package.json
├── package-lock.json
├── tsconfig.json
└── README.md
```

The structure is intentionally incremental. Directories should be added when the corresponding functionality is implemented rather than creating empty copies of the Python backend.

## Planned implementation order

1. Create the basic TypeScript HTTP server.
2. Add configuration and environment-variable handling.
3. Define shared API request/response types.
4. Implement health and basic API endpoints.
5. Add the provider abstraction.
6. Add the agent/tool loop.
7. Port filesystem tools with the existing project-root restrictions.
8. Port sensitive-file and path-traversal protections.
9. Port controlled terminal execution and command-safety checks.
10. Port Git inspection and confirmation-required Git mutations.
11. Add automated backend tests.
12. Compare TypeScript behavior with the Python backend.
13. Evaluate the TypeScript backend for feature parity, accessibility, reliability, performance, and security before considering it as a replacement.

## Security requirements

The TypeScript backend must preserve the security boundaries of `server-python`.

In particular:

- Restrict filesystem access to the configured project directory.
- Protect `.env`, credentials, private keys, `.git`, and other sensitive files.
- Enforce file-size limits.
- Keep terminal execution behind an explicit command allowlist.
- Reject command chaining, piping, redirection, and shell substitution where the existing backend rejects them.
- Keep destructive/system commands restricted.
- Require explicit confirmation for file mutations and Git staging.
- Never trust model-supplied confirmation identifiers or tool arguments without backend validation.
- Keep API keys on the backend and out of the React client.
- Add tests for security behavior before treating migrated functionality as complete.

The TypeScript implementation should not weaken an existing Python security control merely to make migration easier.

## Relationship to the Python backend

`server-python/` remains the reference implementation while the TypeScript backend is experimental.

```text
client-react/
      |
      +--------------------+
      |                    |
      v                    v
server-python/     server-typescript/
 reference            experimental
 backend               backend
```

The two backends should share the same API contracts and security expectations as the TypeScript implementation develops.

## Development commands

Available now:

```powershell
npm run typecheck
```

```powershell
npm test
```

`npm test` runs Node's built-in test runner (`node:test`) over every
`src/**/*.test.ts` file via `tsx` — no separate test-framework dependency.

Not yet available (added once the corresponding module lands):

- `npm run dev` — once `main.ts`/`app.ts` implement the HTTP server (Phase 7)
- `npm run build` / `npm start` — once there is a compiled entry point to run (Phase 7)

## Testing

Phase 1 (`config.ts`) has 17 passing tests in `config.test.ts`, covering
normal, default, blank, invalid, and strict-mode behavior. `types.ts` is
type-only and is verified via `npm run typecheck` rather than runtime tests.

Each subsequent phase adds a co-located `*.test.ts` file before being
marked "Done" in the migration checklist above, mirroring the behavior
established by the corresponding `server-python/tests/test_*.py` file:
normal behavior, error behavior, security boundaries, and edge cases.

The TypeScript backend should eventually be testable independently from the React frontend and should support API-level and tool-level tests.

## Migration principle

The goal is **incremental migration, not a rewrite**.

A feature should be considered migrated only when the TypeScript implementation has equivalent behavior, appropriate tests, and equivalent or stronger security controls. The Python backend should remain available until the TypeScript backend has demonstrated sufficient parity and stability.
