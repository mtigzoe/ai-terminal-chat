\# Security Audit – ai-terminal-chat



\*\*Date:\*\* 2026-09-23  

\*\*Scope:\*\* Full codebase (Python Flask backend, TypeScript Hono backend, React/Electron client)  

\*\*Status:\*\* Passed for local-development use. Not hardened for public internet exposure.



\## Summary

The application deliberately restricts the AI model to a controlled tool surface. No unrestricted shell or filesystem access is granted.



\## Key Controls (verified)



| Control | Status | Location |

|---------|--------|----------|

| Project-root confinement | Pass | `server-python/security.py` (`safe\_path`) |

| Path traversal / absolute path rejection | Pass | `safe\_path` |

| Sensitive file blocking (`.env\*`, keys, `.git`, credentials) | Pass | `is\_sensitive\_filename` / `is\_sensitive\_path` |

| Write / Git-mutate require user confirmation | Pass | Pending-action + `/confirm` flow |

| Terminal commands allowlisted only | Pass | Configurable allowlist + blocked patterns |

| No shell metacharacters (chaining, redirect, pipe) | Pass | Command sanitizer |

| API keys never returned to frontend | Pass | Provider status endpoints |

| Electron: contextIsolation + sandbox, no Node in renderer | Pass | `client-react/electron/main.cjs` |

| SSRF protection on provider base URLs | Pass | `validate\_provider\_base\_url` |

| Per-tool timeouts + stuck-call detection | Pass | Tool executor |



\## Residual Risks

\- Backend binds to localhost by default; exposing it publicly without extra auth is unsafe.

\- Allowlist is user-configurable; a too-permissive list reduces protection.

\- Prompt-injection can still request allowed tools; confirmation gates only mutating actions.

\- Electron stage-1 does not auto-manage the backend process in all launch paths.



\## Recommendation

Treat this document as the permanent audit record. Re-audit only when security-sensitive modules change (`security.py`, tool executors, Electron main/preload, confirmation flow).



\## 2026-09-24 — Non-Git subprocess environment isolation

\*\*Scope:\*\* `server-typescript/src/terminal.ts` and `server-python/tools.py`, the shared execution path for allowlisted non-Git commands (`npm`, `pip`, `pytest`, `python -m pytest`, `ruff`, `black`, `flake8`). Continuation of the audit already covered by PRs \#162–\#172 (Git argument authorization, npm/Python execution-path boundaries, proxy/SSRF hardening, confirmation/project-root binding); this pass covers the area those PRs did not: the subprocess \*environment\*.

\*\*Findings:\*\*

\- \*\*(Python, high severity)\*\* `run_command()`'s non-Git path called `run_cancellable()` with no `env=` argument at all, so `subprocess.Popen(env=None)` inherited the entire server process environment into every `npm`/`pip`/`pytest`/`ruff`/`black`/`flake8` subprocess — every provider API key, plus `PYTHONPATH`/`NODE_OPTIONS`/proxy variables capable of changing what actually executes. No sanitization existed on this path prior to this change.

\- \*\*(TypeScript, medium severity)\*\* `sanitizedTerminalEnv()` only stripped credential-shaped names (`*_API_KEY`/`*_SECRET`/`*_TOKEN`/`*PASSWORD*` plus a fixed provider list). It did not strip Python/Node interpreter-altering variables, npm/pip/pytest/Ruff configuration-override namespaces, or proxy/TLS variables. Concretely, `NODE_OPTIONS=--require=/tmp/x.js` inherited from the server process would run in every Node subprocess `npm` spawns.

\- \*\*(TypeScript, medium severity, parity gap with PR \#169)\*\* `executionPathPermissionError()`'s pip handling only validated `-r`/`--requirement`/`-e`/`--editable`; `--target`, `--prefix`, `--root`, `--src`, `--find-links`, `--constraint`, `--log`, `--config-settings` were unchecked, allowing a confirmed `pip install` to install/log/read outside the project root. Flake8's `--output-file`/`--append-config` and Ruff's `--cache-dir` were similarly unchecked write/read targets.

\*\*Fixes:\*\*

\- Added `buildSanitizedTerminalEnv()` (TS) / `_sanitized_terminal_env()` (Python), one shared policy in each language: strip known + generic credential variables; strip Python/Node interpreter-altering variables (including `NODE_TLS_REJECT_UNAUTHORIZED`, added beyond the literal ask because it materially changes TLS validation the same way the named `NODE_*` variables change execution); strip `npm_config_*`/`NPM_CONFIG_*`/`PIP_*`/`PYTEST_*`/`RUFF_*` namespaces while explicitly preserving npm's own `npm_package_*`/`npm_lifecycle_*` runtime metadata; strip proxy/TLS variables (consistent with the proxy isolation already applied to Git operations and to `safe_fetch`'s SSRF hardening); redirect `HOME`/`USERPROFILE`/`XDG_CONFIG_HOME` to a fresh empty per-invocation temp directory (mirroring the isolated Git config directory already used for `_run_git`), removed on completion via `finally`/context-manager cleanup even on error. Wired into the single non-Git execution call site in each language so both the pre-confirmation and confirmed paths get the same sanitized environment — confirmation gates whether a command runs, never what environment it runs with.

\- Extended TS's pip/Flake8/Ruff execution-path checks to cover the options above, bringing TS to parity with the Python-side execution-path work in PR \#169 (left unmodified here, per instructions not to duplicate/modify open PRs).

\*\*Regression tests:\*\* `server-typescript/src/terminal.env-isolation.test.ts` (10 tests) + additions to `server-typescript/src/execution-path-security.test.ts` (12 tests); `server-python/tests/test_terminal_env_isolation.py` (11 tests). Each stripped/preserved category is asserted directly against the sanitizer's output using sentinel (non-real) values, plus one end-to-end test per language that spawns a real `npm test` subprocess with `confirm=true` and asserts sentinel credentials/config vars are absent from what the child process actually observed, while an unrelated control variable survives.

\*\*Verified:\*\* TS — `tsc --noEmit`, `tsc` build, `test:unit` (352 tests), `vitest run` (625 tests), all passing, 0 failures. Python — full `pytest` suite (680 tests), all passing, 0 failures.

\*\*Remaining limitations:\*\*

\- `XDG_CONFIG_DIRS` is deleted rather than redirected; on Linux, tools that fall back to the XDG-spec default (`/etc/xdg`) when the variable is absent may still consult that system-wide path. There is no project-relative equivalent to redirect it to, and removing it outright is the closest available approximation.

\- Proxy/TLS variables are stripped unconditionally. A deployment that legitimately requires a corporate HTTP(S) proxy for `npm install`/`pip install` to reach the network will need to reintroduce that configuration deliberately (e.g. via an explicit application setting), rather than relying on ambient environment inheritance. This is treated as an accepted trade-off consistent with the "no environment-controlled proxying" policy already applied to Git operations and `safe_fetch`.

\- `pip`'s `--build-constraint` and `--requirements-from-script` options were included in the TS boundary check defensively (per the audit brief) but were not confirmed to exist in the pip version exercised during this audit (pip 24.0); if a newer pip does not use these exact names, the corresponding check is inert but harmless.

\- This pass did not re-examine Black/Flake8 for environment-variable-driven configuration beyond what the generic Python/pip/pytest namespace stripping already covers; no Black/Flake8-specific environment variable with a credible exploit path was found, so none was added as a special case (per "do not create speculative vulnerabilities").

\- Non-Git commands invoked via `run_command()`/`runCommand()` — including a raw `git <subcommand>` string typed through that same generic tool rather than the dedicated `git_status`/`git_diff`/etc. tools — now also receive this sanitized environment as a side effect of the shared call site. This is a strict improvement and consistent with the isolation already applied to the dedicated Git tools, not a scope change to this audit.

