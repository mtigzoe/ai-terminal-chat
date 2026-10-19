# React/Electron and TypeScript architecture migration audit

Date: 2026-10-19. Source: `mtigzoe/ai-terminal-chat` at `8cf14a5d7066e6549c0160eb81c30ab1cbf2c546`.
The local checkout was clean at the start; GitHub's comparison confirmed this commit matched `main` during the audit. Findings below are source inspection unless explicitly identified as executed tests.

## Recommendation

Keep Hono as the HTTP/security transport and make the existing TypeScript implementation the migration target. First fix behavioral differences and establish shared contract tests; then migrate React incrementally; promote TypeScript only after browser, packaged Electron, security, and accessibility gates pass. Extract Python after a stable TypeScript release and an independently validated Python extraction rehearsal.

The backend is substantially implemented already. This is a compatibility and release-readiness effort, not a new backend rewrite. Packaged Electron already starts the bundled TypeScript server, while normal Compose and non-`-ts` startup helpers select Python. A single global description of the current default is therefore misleading.

This preparatory proposal adds documentation and a Git-object inventory only. It does not change code, backend defaults, dependencies, workflows, Python files, or repository ownership. No Pi code or dependency has been copied or integrated. No extraction, destination repository creation, merge, or backend switch is part of this change.

## Current architecture

| Area | Implementation and evidence | Implication |
| --- | --- | --- |
| React renderer | React 18, Vite, JavaScript/JSX; five HTML/page entries in [vite.config.js](../../client-react/vite.config.js); no renderer tsconfig or typecheck script | Preserve multipage behavior and storage contracts while converting files |
| Desktop | CommonJS main/preload in [electron](../../client-react/electron); [package.json](../../client-react/package.json) extraResources and [prepare-server.cjs](../../client-react/scripts/prepare-server.cjs) bundle TypeScript; `main.cjs:123-155` starts it with `utilityProcess.fork` | Desktop promotion is partly shipped already; validate packaged behavior independently of Vite |
| TypeScript API | [server.ts](../../server-typescript/src/server.ts) applies host/origin/auth/body-size boundaries; [routes.ts](../../server-typescript/src/routes.ts) is Hono; provider, agent and tool modules are separate | Preserve security wrapper when refactoring or testing routes |
| Python API | [app.py](../../server-python/app.py), [secure_server.py](../../server-python/secure_server.py), provider/agent/security/tools modules | Preserve as supported compatibility backend during migration |
| Configuration | Both use `~/.ai-terminal-chat/config.json` for project/provider/command settings; pending actions and cancellation registries are in memory | Do not run backends against shared mutable config concurrently or transfer live action IDs |
| Sessions | Renderer localStorage history/preferences and sessionStorage handoffs; wire requests carry history, request ID and permissions | Neither backend currently offers a durable session CRUD service; don't promise server-side session migration |

## Backend feature comparison

All eight provider IDs exist in both: `gemini`, `ollama`, `kilo`, `openai`, `xai`, `openrouter`, `anthropic`, `nvidia`. Compare [Python providers.py](../../server-python/providers.py) with [TypeScript factory.ts](../../server-typescript/src/providers/factory.ts), not the older README examples.

| Feature | Python | TypeScript | Parity assessment / required evidence |
| --- | --- | --- | --- |
| Providers and custom endpoints | Native Gemini/Anthropic, OpenAI-compatible adapters, provider-specific keys/base URL/model/timeout | Same broad provider coverage | Feature presence is close; key-required metadata, history conversion and fallback behavior diverge |
| Provider/model selection | `/providers`, selection, optional key, persisted model, failure rollback | Equivalent routes and persistence | Contract fixtures must cover failure/rollback, redaction, model retained across restart and provider switches |
| Model listing | Generic catalog parsing plus Ollama native tags, model info and diagnostics | Generic compatible models API; native Gemini/Anthropic catalogs | Port Ollama metadata/tool support; test raw-array catalogs and unreachable/no-model errors |
| Chat and tools | JSON `/chat`, provider-neutral multi-round loop | Same architecture and tool categories | Anthropic previous-user history is lost in TS; malformed tool-call handling also differs |
| Streaming | `/stream` always emits NDJSON agent events | NDJSON only when Accept includes `application/x-ndjson`; otherwise plain formatted text | React sets Accept, but other clients differ. Freeze event/error/completion contract first |
| Provider token streaming | Provider `generate` returns completed responses; some capabilities advertise streaming | Completed provider calls; several capabilities report false | Agent-event streaming is present; token-by-token provider streaming is not established parity |
| Sessions/history | Client-supplied transcript; in-memory pending confirmation/resume and request cancellation | Same model, with TS request-context helpers | Preserve history roles/parts, confirmation chaining, provider/root fingerprint invalidation; restart loses pending work |
| Filesystem | List/read/search, create/write/patch/delete with sensitive-path/root checks and confirmation | Same categories plus platform-specific path/handle protections | Preserve root/symlink/junction boundaries, file grants, TOCTOU and stale-preview checks; platform implementations differ |
| Git | Status/diff/log/branch; add/restore/fetch/pull/commit/push with confirmations for mutations | Same operations | Do not rely on stale docs/types claiming add-only. Retain config/credential/hooks/remote/path isolation |
| Terminal | Allowlist, argument/path checks, shell-free execution, timeout/output/env controls | Equivalent controls and process helpers | `/terminal/run` defaults confirmation differently; cancellation propagation needs end-to-end verification |
| Security | Secure wrapper enforces bind/token/origin/host and request limits; constrained tools | Equivalent wrapper plus typed context helpers | Route-only tests do not prove the network boundary. Never bypass server.ts during promotion |
| Permissions | Explicit user file grants; model writes preview, opaque action ID and confirm/resume; root/provider/file-state checks | Same broad pattern | Freeze defaults and negative cases; model-provided `confirm` must never self-authorize mutations |
| Ollama management | Status/run allowlisted CLI, offline support | Status/run and CLI module | Native model diagnosis remains Python's richer path |

Both registries expose 19 tools: `list_files`, `read_file`, `search_files`, `run_command`, `git_status`, `git_committed_file_count`, `git_diff`, `git_log`, `git_branch`, `git_add`, `git_restore`, `git_fetch`, `git_pull`, `git_commit`, `git_push`, `create_file`, `write_file`, `apply_patch`, `delete_file`.

The API surface is also largely shared: providers/status/select/models, Ollama status/run, project-root GET/POST, project list/read, allowed-commands GET/POST/DELETE, terminal/run, chat, stream, cancel and confirm. TypeScript additionally provides `GET /health`; Python has no equivalent dedicated health route. Most Python routes live in `app_original.py` and are re-exported/overridden by `app.py`, so audit both. The Python provider-model path uses Flask parameter syntax; the TS equivalent uses Hono syntax. Python normalizes invalid stream requests into NDJSON text events; TS returns plain text even when NDJSON was requested. TS also preserves some progress fields stripped by Python. Shared endpoint names alone do not establish matching request validation, status codes, content types, or effects.

## Findings that block default promotion

| Priority | Finding and source | Required change / validation |
| --- | --- | --- |
| P1 | Anthropic TS `normalizeHistoryItem` (`src/providers/anthropic.ts:180-195`) accepts prior user `content`, but React sends `{role:'user',parts:[{text:...}]}`; its parts branch only preserves assistant/model. Python `anthropic_provider.py:143-173` preserves user parts | Add multi-turn wire-history fixtures for all providers, then fix conversion before promotion |
| P1 | TS compatible adapter `openai-compatible.ts:249-267` converts invalid tool JSON to an empty object and permits parsed non-object values; Python `openai_compatible.py:301-332` rejects malformed calls | Require validated object arguments before dispatch; malformed JSON/scalar/array/null/name fixtures must never execute a tool |
| P1 | TS fallback detector `openai-compatible.ts:356-372` matches broad words on arbitrary errors; Python restricts tool-unsupported status/message combinations | Narrow fallback classification; unrelated auth/network/timeout errors must not retry as tool-free chat or disable tools |
| P1 | TS `agent.ts:1222` passes a signal but `routes.ts:1044-1070` tool wrappers drop it. `terminal.ts:1425` supports a signal | Wire cancellation through the real route/agent/tool path and prove child/descendant exit. Python context propagation also needs an integration test; it is not a proven reference here |
| P1 | `routes.ts:552-553` defaults terminal `confirm` to true; Python leaves omitted confirm false | Define explicit user-terminal authorization separately from model confirmation; align defaults without silently weakening either backend's safety |
| P1 | Renderer Axios/fetch has no Authorization transport, while Compose requires API_AUTH_TOKEN and server.ts authenticates API requests | Design explicit browser authentication and desktop transport. Never compile tokens into VITE_* or allow arbitrary origins |
| P1 verification gate | Packaged pages load file:// (`electron/main.cjs:217`), while TS default origins exclude opaque `null`; inherited API_AUTH_TOKEN also differs from Electron's generated health token (`main.cjs:70,149`) | Packaged smoke must test real fetch origin and token-configured startup. Origin failure is a source-based inference, not an executed packaged reproduction |
| P1 | Frontend Dockerfile:13 copies only index/settings HTML, but Vite builds five pages | Copy all inputs and run actual Docker build/smoke before promotion; expected failure is from static inspection |
| P1 baseline gate | Existing automated failures / unavailable suites are recorded below | Resolve failures and obtain a complete supported-platform baseline before using passing tests as a migration gate |

Python functionality/behavior still missing or weaker in TS:

- Ollama native `/api/tags` discovery, `/api/show` per-model tool capabilities, chat-only fallback precision and actionable no-model/unreachable diagnostics (`ollama.py` versus generic TS compatible adapter).
- OpenRouter optional attribution headers (`OPENROUTER_HTTP_REFERER`, `OPENROUTER_APP_TITLE`), and `ANTHROPIC_MAX_TOKENS` configuration (Python defaults to 8192; TS currently fixes 4096).
- Early cloud-key validation and accurate `requires_api_key` metadata for Kilo/xAI/OpenRouter; compare Python provider constructors and TS factory/config.
- Robust rejection of malformed model tool calls; multi-turn Anthropic wire-history preservation; compatible raw-array model catalog handling.
- Python's native folder-picker sentinel `__CHOOSE_PROJECT_ROOT__` invokes Tkinter; TypeScript rejects the sentinel and expects Electron's picker or a typed path. Decide and document an accessible web alternative (`security.py:250-288`; `security.ts:425-429`).
- Python's default NDJSON negotiation behavior and conservative omitted terminal-confirm behavior, if retained as the agreed public contract.

These are ports/compatibility decisions, not evidence that Python-only filesystem or Git categories need rewriting.

Do not port every behavioral difference mechanically: TS frames user instructions as subordinate input, while Python appends them to system text. Keep the intended instruction hierarchy explicit. Provider-switch pending behavior also differs: Python can execute a consumed legacy confirmation after provider change, while TS rejects mismatched provider fingerprints. Prefer explicit invalidation with a clear UI message, and never replay those actions across backends.

Test orchestration debt: the config-lock worker test imports compiled `dist/config.js`. A first run before build encountered a missing module that still satisfied a generic nonzero-exit assertion; the successful serial baseline below ran after build. Make that prerequisite explicit and assert the intended lock failure, so clean-checkout CI cannot accept an unrelated worker crash.

Additional debt: [types.ts](../../server-typescript/src/types.ts) tool-name unions still describe an earlier add-only Git surface and omit implemented tools; its provider-name union also omits NVIDIA; [app.ts](../../server-typescript/src/app.ts) is only an old placeholder (as are `main.ts` and `providers.ts`). Update/remove misleading declarations only after tracing actual imports; do not expose server runtime modules to the renderer as a shortcut to shared contracts.

## Accessibility and Electron invariants

Keep the current multipage interface and behavior during conversion. Existing tests cover Enter send / Shift+Enter newline, continued textarea editing, F6/Shift+F6 chat/terminal focus, skip links, confirmation focus initially on Decline, Tab trapping, Escape decline and focus restoration. Preserve project-tree roving focus, arrows/Home/End, position/setsize, selection independent of focus, keyboard context menus, preview focus return, tab semantics, terminal log summaries and repeatable polite/assertive live announcements.

Evidence: `App.keyboard.a11y.test.jsx`, `App.focus.a11y.test.jsx`, `ProjectExplorer*.a11y.test.jsx`, `ProjectTreeContextMenu.a11y.test.jsx`, `WorkspaceTabs.a11y.test.jsx`, `liveAnnounce.test.js`, `ConversationDisplayArea.a11y.test.jsx`, `TerminalPanel.a11y.test.jsx`. Memory-off behavior must continue clearing durable history and file grants.

Current F6 help mentions project/chat/terminal although App cycles chat/terminal; correct descriptions or implement and test a deliberate cross-page model separately. ProjectExplorer's `/settings.html#settings-project-root` links (`ProjectExplorer.jsx:371,380,382`) also need file://-safe relative targets with a packaged-navigation regression.

Preserve Electron `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`; same-dist navigation and HTTP(S)-only external launch; native-picker authorization persistence; realpath-aware editor/reveal confinement; minimal preload methods; backend readiness challenge/HMAC; and owned-child shutdown. Current sources: `main.cjs`, `preload.cjs`, `security-utils.cjs`, `health-check.cjs`, `project-root-store.cjs`.

Schedule IPC sender/frame authorization, explicit permission request/check handlers, CSP/trusted renderer protocol, and a per-instance authenticated backend channel as reviewable hardening changes. Do not loosen origin/path/sandbox controls to make migration pass. Keep Electron main/preload CommonJS until a separately verified compilation/packaging step exists.

Require actual keyboard and screen-reader checks (NVDA/JAWS on Windows and the supported Linux reader; VoiceOver if macOS is supported), packaged and browser flows, zoom/high contrast/reduced motion/focus visibility. Axe/jsdom passing is useful but cannot establish actual assistive-technology announcements.

## Hono and Pi decision

Retain Hono. Hono is the HTTP transport; a Pi SDK would be an optional agent/provider runtime behind it. They are not interchangeable architectural layers. The exported raw Hono app in routes.ts has permissive CORS middleware; production host/origin/auth/body-size controls live in server.ts. Any embedding or future SDK adapter must keep that secured boundary, ideally through a reusable secured app factory, and test actual HTTP entrypoints.

Pi's useful reference is separation of model adapters, agent execution, tools and host services. Its README explicitly states it has no built-in filesystem/process/network/credential permission system. Therefore the app must retain its own security and confirmation boundaries regardless of a future runtime choice. [Pi architecture and permissions](https://github.com/earendil-works/pi).

The SDK supports host-provided tools, model/settings/session managers and resource loading. Its default persistent sessions and resource discovery differ from this app's client-supplied history and constrained project access. An integration would require an explicit adapter and lifecycle design. [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md).

The lower-level agent package documents typed lifecycle events and cancellation; the provider layer documents compatible endpoints. These are useful design references for a typed event union, provider-independent loop and explicit abort propagation. [Agent core](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md), [provider API](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md).

A separate, later evaluation must pin an exact Pi revision/package set and compare: provider/model parity including Ollama/Kilo/NIM and custom endpoints; history/tool-call fidelity; error/retry/cost semantics; NDJSON event adaptation; abort/timeout cleanup; custom tools only; disabled implicit extension/resource discovery; opaque confirmation/resume integrity; credential/network isolation; durable-session privacy; license/dependency review; Electron runtime/native dependency support, package size and offline behavior. Use a disposable proof of concept and the same contract/security fixtures. Prefer a narrow provider adapter evaluation before adopting the full coding-agent SDK. No Pi package decision is needed to complete this migration.

## Incremental React TypeScript plan

1. Freeze request/response/error, stream, storage and preload fixtures. Reconcile the incomplete existing server types with behavior. Introduce a pure shared contracts boundary; Python consumes JSON fixtures/schema, renderer imports types/runtime validators without server dependencies.
2. Add TypeScript, React/DOM types, renderer tsconfig (`allowJs:true`, `checkJs:false`, `noEmit:true`, strict converted files, `jsx:react-jsx`, DOM libs and Vite-compatible module resolution), `vite-env.d.ts`, and a typed `Window.electronAPI`. Make typecheck required in CI. Leave JS tests and Electron CJS working.
3. Convert pure helpers (`agentStatus`, `agentPermissions`, `liveAnnounce`), then shared API/storage/stream adapters. Parse network/storage values as unknown, validate at boundaries, and use discriminated unions for events and pending state. Avoid broad any and casts that conceal missing validation.
4. Convert MainNav/Header/MessageInput/WorkspaceTabs and instructions/history pages. Keep DOM structure, labels, keys, refs and focus timing. Update each HTML script path when its page entry becomes TSX.
5. Convert provider/settings/root manager, explorer/context menu, Git and terminal components in separate changes. Temporarily retain backend response fallbacks (`contents/content`, `returncode/exit_code`) inside the API adapter.
6. Convert App last. Extract the stream parser and request/confirmation controller separately before changing orchestration. Preserve TextDecoder buffering, partial final line, plain-text fallback, stale-response guards, cancellation, permission handoff and repeated confirmation resume.
7. Convert Electron with a separate Node/Electron tsconfig and emitted CJS (`.cts` if suitable), updating entry/preload/helper/builder paths together. Verify sandbox-compatible preload and production dependencies in the packaged Electron runtime.
8. Tighten remaining JS checking and remove allowJs only when conversion is complete. Each conversion should be a revertible PR with unchanged wire/storage schema and passing keyboard/focus tests.

## Phases, gates and rollback

| Phase | Scope | Exit gate | Rollback |
| --- | --- | --- | --- |
| 0: Audit/preparation | This report, extraction manifest/runbook, reproducible test results; agree compatibility contracts and supported runtime matrix | Findings triaged; baseline failures recorded; no defaults changed | Revert documentation commit; application unaffected |
| 1: Contract and safety baseline | Shared wire fixtures and differential runner; fix history, args/fallback, cancellation, auth/packaging/confirmation issues in small PRs | Both backends satisfy agreed fixtures; complete platform suites; browser/container/desktop smoke | Revert individual fix/adapter; keep existing Python launch paths and prior desktop release |
| 2: Typed renderer foundation | TS setup and helpers/components in the order above | Renderer typecheck required; production five-page build; all accessibility/behavior tests | Revert converted slice and HTML/config changes together; retain JS interop |
| 3: TypeScript opt-in release | Stable Hono backend with explicit selection; real provider smoke (opt-in credentials), offline Ollama, packaged Windows validation and supported Linux runtime validation (define Linux packaging before claiming a packaged Linux release) | No unexplained parity/security/test gaps; manual screen-reader checks; backup/restore exercised | For tested browser/source launch paths, stop only the owned TS process and use explicit Python helpers; for packaged desktop use its previous verified artifact/backend; restore compatible private config if needed |
| 4: Promote TypeScript | Separate reviewed release changes default scripts/Compose/docs after acceptance | Release tagged, explicit Python fallback documented and exercised; identical user-data behavior | Revert default-selection commit; stop selected backend before starting a tested browser/source fallback on 9000; packaged desktop returns to its previous verified installer/artifact and owned backend |
| 5: Python extraction | Separately authorized fresh-clone rehearsal, history/manifest/license checks, standalone CI/docs, then destination publication | Independent Python tests pass; commit/ref mappings and provenance archived; standalone release usable | Original monorepo stays authoritative until verified; discard rehearsal on mismatch; never rewrite original history |
| 6: Optional runtime evaluation | Separate Pi ADR/prototype, only after migration stabilizes | Measured parity/security/packaging benefit and explicit decision | Remove experimental adapter/dependencies; retain Hono and current runtime |

Phases 1 and 2 can overlap after contracts stabilize, but do not combine a backend default switch, session schema change, Electron transport change and renderer rewrite in one release. Phase 5 may be prepared in parallel but publication/removal must remain separate decisions.

Main risks are silent permission changes, transcript loss, shared-config/storage incompatibility, platform-specific filesystem/native dependency regressions, and security fixes drifting after the split. Mitigate them with negative/effect-based contract tests, explicit transcript fixtures, isolated profiles plus rehearsed private backups, a tested Node/Electron/OS matrix, and a documented cross-repository API/security patch policy. TS conversion should not change storage keys, renderer origin or permission semantics.

Before any backend switch, finish or explicitly cancel in-flight turns and pending confirmations. Both are process-local and cannot safely be resumed on the other backend. Back up `~/.ai-terminal-chat/config.json` and Electron authorized-root data privately, record provider/model/allowed commands/root, and preserve renderer localStorage/sessionStorage semantics. Record Electron app ID, userData path, renderer origin and installer identity; prove old and new versions can read history/settings. Avoid changing protocol/install paths during TS conversion. Signing policy is a separate release gate, not an assumed property of current artifacts. Avoid concurrent writes to shared config and avoid migrating secrets through browser storage. Do not shadow real mutating operations against two backends.

Python has no dedicated health identity endpoint, so it is not a proven drop-in replacement for the bundled TypeScript process expected by packaged Electron. Browser/source-launch fallback and packaged-desktop rollback must be tested as distinct procedures.

Use fixture-based dual execution against isolated temporary project/config roots; sanitize IDs/timing only, compare effects and permission denials too. Required fixtures include all eight providers, prior user/model/tool turns, invalid payloads/errors, selection rollback, NDJSON chunk boundaries and disconnects, root/provider/file changes before confirmation, memory-off behavior, sensitive files, symlink/junction/TOCTOU, Git credential/config isolation and actual child-process cancellation. Real provider smoke requires explicit opt-in and credentials; offline CI should stay deterministic.

## Files that require follow-up changes

| Group | Paths | Required timing / change |
| --- | --- | --- |
| Defaults and tests | `Makefile`; `scripts/makefile/{powershell/test.ps1,sh/test.sh}` | Add renderer typecheck/contracts, later adjust primary targets; retain Python targets until extraction is independently usable |
| Windows launchers | `scripts/powershell/start-electron.ps1`, `start-electron-dev.ps1`, `run-electron.ps1`, `start-offline-ai.ps1`; their `start-electron-ts.ps1`, `run-electron-ts.ps1`, `start-offline-ai-ts.ps1`; `stop-services.ps1` | Explicit backend selection/health identity and owned-process lifecycle first; defaults only phase 4; preserve aliases/fallback |
| Bash launchers | `scripts/sh/{start-electron.sh,run-electron.sh,start-offline-ai.sh,start-electron-ts.sh,run-electron-ts.sh,start-offline-ai-ts.sh,stop-services.sh}` | Same semantics as Windows; no killing unrelated port owners |
| App wrappers | `scripts/{electron,web}/{powershell,sh}` (all dev/install/build wrappers) | Review path/backend assumptions; update entry/build commands as TS configs arrive; wrappers already client-only need no backend rewrite |
| Static checks | `scripts/static-checks/{check-react.sh,check-typescript.sh,check-python.sh,run-all-tests.sh,README.md}` | React script currently masks tsc/ESLint errors; replace with explicit configured required checks; relocate Python jobs only after extraction |
| Renderer build | `client-react/{package.json,package-lock.json,pnpm-lock.yaml,pnpm-workspace.yaml,vite.config.js,vitest.config.js}`; all five HTML entries; new tsconfig/types files | Choose/document canonical npm lock workflow; retain pnpm artifacts until separately decided; update includes/imports/build after TS setup |
| Desktop build | `client-react/scripts/prepare-server.cjs`; `client-react/electron/*`; package builder files/extraResources | Validate staged server, native modules, packaged runtime, preload and shutdown; do not rename CJS without build support |
| Containers | Root `docker-compose.yml`; all three `Dockerfile` and `.dockerignore` files; `client-react/nginx.conf` | Fix missing HTML now in separate change; auth/origins and Node matrix; later opt-in Python service/external path with stable fallback. nginx needs review if proxy/auth or page paths change |
| Backend runtime | TS `package.json`, lock, tsconfig, routes/providers/agent/tool adapters/types; Python env/requirements as needed for standalone | Small parity fixes, contracts and runtime matrix first; no runtime replacement required |
| CI | `.github/workflows/ci.yml` | Build before dist-dependent backend tests; required renderer types/contracts, full Windows helper coverage, package/container smoke; retain Python Linux/Windows/Ruff until standalone CI exists. Ruff full lint/format currently advisory |
| Site publishing | `.github/workflows/pages.yml` | No structural change needed for current static publication; review paths only if site layout changes |
| User/developer docs | Root `README.md`; `client-react/README.md`; `server-typescript/{README.md,ENVIRONMENT.md}`; Python README/ENVIRONMENT/.env.example; `scripts/readme.md`; `scripts/static-checks/README.md` | Correct actual desktop backend, supported Node/Python versions, auth, tool surface, startup and fallback; standalone Python docs must stop assuming monorepo |
| Public project/policies | `docs/{index.html,about.html,downloads.html}`; `.github/CONTRIBUTING.md`; `SECURITY.md`; `LICENSE`, `CODE_OF_CONDUCT.md` | Ownership/support/download links and Python destination only when published; preserve licensing/attribution |
| Historical records | `.github/audit.md`, `MANIFEST.md` | Add a dated superseding reference if needed; do not silently replace historical verification claims |

Node/runtime guidance currently differs: CI uses Node 24, container builds use Node 22, TS README says 18+, and frontend README says 22. Establish a tested development/build/runtime matrix including Electron's embedded Node and native Koffi before changing ranges.

## Executed validation

All application checks below ran on Windows against the audited source, using Node 24.19.0 / npm 11.17.0. JavaScript dependencies were installed from the local cache with `rtk npm ci --offline --ignore-scripts --no-audit --no-fund` in each package. Initial missing-dependency and sandbox child-spawn failures were resolved before the completed runs.

| Check | Command / working directory | Result |
| --- | --- | --- |
| TypeScript typecheck | `rtk npm run typecheck` in server-typescript | PASS |
| TypeScript build | `rtk npm run build` in server-typescript | PASS |
| TypeScript full suite, serial after build | `rtk npm test` in server-typescript | PASS: Node runner 411 passed / 1 skipped (412); Vitest 734 passed / 2 skipped (736), 37 files |
| React production build | `rtk npm run build` in client-react | PASS: Vite 7.3.6, 284 modules, five-page output |
| React + Electron helper suite | `rtk npm test` in client-react | FAIL: 438 passed / 9 failed (447); 32 files passed / 1 failed (33). Accessibility suites passed |
| Standalone Electron external URL checks | `rtk node tests/external-url.test.cjs` in client-react | PASS: 28 checks |
| Standalone Electron project path checks | `rtk node tests/project-path.test.cjs` in client-react | PASS: 18 checks, including Windows junction containment |
| Python full suite | Isolated temporary CPython 3.14.0; `python -B` invokes `pytest.main(['tests','-q','-ra'])` in server-python, clearing live Ollama opt-in/host overrides | PASS: 918 passed / 11 skipped, one dependency deprecation warning, 49.24 seconds |
| Python syntax | AST parse of all 66 tracked .py files without bytecode writes | PASS |
| Extraction inventory | Compare each of 115 source Git blobs with manifest; simulate sequential renames and check uniqueness; validate 16 relative Markdown links | PASS; extraction itself was not run |

All nine reproducible failures are in `client-react/electron/editor-handler.test.js`: Windows .cmd/.bat editor launch routing, seven command-metacharacter rejection cases, and the editor fallback. Source inspection found an overescaped extension regex in `editor-handler.cjs`, so the intended Windows shim branch is not selected; the metacharacter regex also uses literal backslash-r/backslash-n rather than CR/LF. Audit the matching escaped test patterns/fixtures during the repair, then require these full helper tests on Windows before promotion. Existing Windows CI runs only the two standalone security scripts; the full client suite runs on Linux, where these Windows expectations are skipped.

An earlier overlapping TypeScript Vitest run produced two POST /confirm 404 failures; an independent run and the final serial full run passed. They were not reproducible after serializing execution and building first. Keep comparison runs isolated and do not run backend suites concurrently against shared on-disk state. Do not erase this observation or represent the initial run as clean.

Python dependencies were initially absent and unavailable offline; installation from the configured package index into a temporary environment succeeded without changing tracked requirements. That environment used pytest 9.1.1, Flask 3.1.3, google-genai 2.31.0 and requests 2.34.2. Eleven skips are four opt-in live Ollama tests and seven POSIX-only hardening checks on Windows. The warning is the google-genai dependency's use of a deprecated typing alias. CI's Python 3.11 and Linux behavior still need their own runs; this local pass establishes a Windows/Python 3.14 baseline only.

No JavaScript lint script is configured in either package; no lint/Ruff baseline is claimed here. The Python suite was invoked with the temporary environment's interpreter and the wrapper described above, with live Ollama opt-in disabled; dependency setup used requirements-dev.txt and did not install into the system interpreter.

No source/lock/workflow files were changed by the validation. This documentation-only proposal has no new runtime tests; it records existing test results and the independently checked extraction inventory.

Docker build, packaged Electron launch, manual screen-reader testing, live provider/Ollama calls and extraction rehearsal were not performed. Source-based issues are not reported as reproduced runtime failures. Successful isolated suites do not imply cross-backend contract parity.

## Python extraction preparation

See [the extraction runbook](python-extraction.md) and [the path/blob manifest](python-extraction-manifest.json). The manifest includes all 74 tracked Python-tree files (42 test files) and four shared policy/license files plus 37 archived monorepo documentation/tooling files (115 total), with destination names, modes and Git blob IDs. A local full-history path scan found no Python/requirements paths outside `server-python`; repeat it against fully fetched remote refs before extraction. This checkout is not shallow and has 1,379 commits reachable from the audit HEAD.

Relevant history must survive via filtering in a disposable clone, not copying the directory into an initial commit. Preserve the original source archive, filtered commit/ref maps and provenance, and carry Apache-2.0 license and existing notices. Standalone docs/CI/container/startup adaptation follows in a separate commit after byte-identical extraction verification.
