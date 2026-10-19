# Python extraction runbook (proposal, not executed)

Destination: `mtigzoe/ai-terminal-chat-python`.
Boundary: `mtigzoe/ai-terminal-chat@8cf14a5d7066e6549c0160eb81c30ab1cbf2c546`.
Companion: [architecture audit and rollout gates](2026-10-typescript-audit.md).

No source deletion, Git rewrite, clone/filter rehearsal, destination repository creation, or publication has been performed. This document and the inventory prepare a later, separately authorized extraction. Keep `server-python` and its current CI/startup support intact until the extracted project passes its own acceptance checks.

## What is preserved

[python-extraction-manifest.json](python-extraction-manifest.json) records 115 tracked files with original blob IDs and modes:

| Source | Destination | Purpose |
| --- | --- | --- |
| `server-python/**` (74 files, including 42 test files) | Repository root with prefix removed | All Python code, tests, README, ENVIRONMENT, .env.example, dependency requirements, Dockerfile/.dockerignore/.gitignore; retain app_original.py because app.py uses it |
| `LICENSE`, `SECURITY.md`, `CODE_OF_CONDUCT.md` | Same paths | License and project policies |
| `.github/CONTRIBUTING.md` | `CONTRIBUTING.md` | Preserve contribution/AI-disclosure guidance |
| Root `README.md`, `Makefile`, `docker-compose.yml`, `MANIFEST.md` | `docs/monorepo/<same-path>` | Preserve mixed application/Python documentation and tooling history without activating monorepo assumptions |
| `.github/audit.md`, `.github/workflows/ci.yml` | `docs/monorepo/audit.md`, `docs/monorepo/ci.yml` | Keep historical audit and complete CI provenance as archived material |
| Entire `scripts/**` | `docs/monorepo/scripts/**` | Preserve cross-platform startup/test/static-check documentation and history; adapt Python-only replacements later |

The 37 archived mixed-purpose files are reference material, not runnable standalone entrypoints. Keep them outside active workflow/script roots, explain this in a follow-up `docs/monorepo/ARCHIVE.md` index, and link their source boundary. Electron/React and TypeScript source trees are not extraction inputs.

The available local Git history is not shallow. `git log --all --name-only` found no Python/requirements paths outside `server-python`; `app.py` history reaches its addition at `84af8aa`. It also contains delete/re-add history. Repeat rename/path analysis on the fully fetched source before filtering: Git path filters do not follow historical renames automatically. Add any discovered predecessor paths and noncolliding destination mappings to the manifest and filter command.

Preserve authors, author/commit timestamps, relevant merge ancestry and messages through a history filter. Commit IDs change, empty/nonrelevant history may be pruned, and old signatures cannot attest rewritten commits. Keep a full unmodified source bundle and commit/ref mappings so the originals remain verifiable. Do not rewrite the original repository or force-push it.

## Future rehearsal sequence

Run these steps only during the later extraction phase. Commands below are an example for a dedicated disposable working area, not commands to run in the current application checkout.

1. Record approved source HEAD, supported Python versions, test results, source license and file counts. If HEAD moves from the boundary above, regenerate the manifest at the approved boundary. Archive source-only issues/PR links relevant to Python; Git history does not transfer issues, settings, Actions secrets, or release assets.
2. Fetch a fresh full mirror into a new empty directory and create an unmodified bundle. Review all refs/history for secrets and third-party material before publication; never copy local .env, config, provider keys, caches or untracked files. Rotate/report any historical credentials privately before proceeding.
3. Create a second disposable clone for rewriting. Identify its absolute Git directory and prove it is inside the dedicated extraction workspace and distinct from both the original checkout and source archive. Never use `--force` to bypass fresh-clone checks.

Example archive/rehearsal preparation, after that phase is authorized:

~~~powershell
git clone --mirror https://github.com/mtigzoe/ai-terminal-chat.git source-mirror.git
git -C source-mirror.git rev-parse refs/heads/main
git -C source-mirror.git bundle create ../source-before-extraction.bundle --all
git clone --mirror --no-local ./source-mirror.git python-filter.git
git -C python-filter.git rev-parse --absolute-git-dir
~~~

Compare the recorded main SHA with the approved manifest boundary and stop on mismatch. The bundle and original mirror remain unmodified throughout the filter. Keep them private if they contain unpublished refs. A future rehearsal can use a compatible explicitly pinned `git-filter-repo`; record its version and command.

4. In `python-filter.git` only, apply the following conceptual filter (PowerShell backticks are line continuations):

~~~powershell
git filter-repo `
  --path server-python/ `
  --path LICENSE `
  --path SECURITY.md `
  --path CODE_OF_CONDUCT.md `
  --path .github/CONTRIBUTING.md `
  --path README.md `
  --path Makefile `
  --path docker-compose.yml `
  --path MANIFEST.md `
  --path .github/audit.md `
  --path .github/workflows/ci.yml `
  --path scripts/ `
  --path-rename '.github/CONTRIBUTING.md:CONTRIBUTING.md' `
  --path-rename 'README.md:docs/monorepo/README.md' `
  --path-rename 'Makefile:docs/monorepo/Makefile' `
  --path-rename 'docker-compose.yml:docs/monorepo/docker-compose.yml' `
  --path-rename 'MANIFEST.md:docs/monorepo/MANIFEST.md' `
  --path-rename '.github/audit.md:docs/monorepo/audit.md' `
  --path-rename '.github/workflows/ci.yml:docs/monorepo/ci.yml' `
  --path-rename 'scripts/:docs/monorepo/scripts/' `
  --path-rename 'server-python/:' `
  --tag-rename ':monorepo-'
~~~

Rename order is intentional: archive root paths before removing the server-python prefix. Sequential renames applied in the opposite order would move the Python README into the archive and collide with the root README.

Run it with the current directory explicitly set to the verified disposable bare clone. Do not add `--refs main` without understanding partial-rewrite behavior: retained unfiltered refs could still expose unrelated source. Filter the disposable clone completely, then publish only individually approved heads/tags. Never push a mirror wholesale.

This uses path selection/renaming rather than `--subdirectory-filter`, which on its own would discard root license/policy/documentation history. See the primary [git-filter-repo manual](https://github.com/newren/git-filter-repo/blob/main/Documentation/git-filter-repo.txt) for fresh-clone protection, path selection/renaming and commit-map behavior.

5. Before editing standalone files, verify every manifest destination at filtered main has the same Git blob ID and mode as its source. Verify there are exactly 115 expected files at this boundary; inspect any extras. Use `git ls-tree -r refs/heads/main` and `git cat-file`, not working-tree hashes affected by Windows CRLF conversion.
6. Save the filter's commit-map and ref-map and map the approved source boundary to its new main SHA. Inspect `git log --follow -- app.py`, providers, tools/security, tests and LICENSE across early and recent commits. Check author identities/counts for retained paths and verify renamed documentation history. Verify the source archive still resolves original commits; run `git fsck --full` on the disposable output.
7. Keep old source release tags namespaced `monorepo-*` and non-release by default. Review signatures/messages/targets before publishing any. Branches other than main require individual review. A rewritten tag is not the original signed release.

## Standalone adaptation, after identity verification

Make one new, reviewable commit after the byte-identical extraction boundary; keep it separate from filtering.

- Replace the stale Gemini-only README with all eight providers, supported Python versions, env setup, offline Ollama, API/auth/permission contract, tests, Docker, standalone startup and original-project link. Keep the old README history and archived monorepo docs.
- Retain `.env.example` without values/secrets; update its provider list (NVIDIA is currently absent from the opening list) and all configuration/timeout/auth explanations.
- Preserve both `requirements.txt` and `requirements-dev.txt`; establish a tested reproducible dependency policy separately. Existing requirements are unpinned; do not silently change resolver behavior as part of history filtering.
- Start with `python -m pip install -r requirements-dev.txt` and `python -m pytest -q` from standalone root. Use an isolated test profile and mocked providers; `OLLAMA_INTEGRATION_TEST` remains off by default.
- Most tests locate their server directory with `Path(__file__).resolve().parents[1]`, which survives flattening. Audit cwd/root-dependent cases, especially `tests/test_tools.py:266` referring to `server-python`; make them use isolated fixtures rather than weakening containment assertions. Verify imports of `app_original` still work.
- The project root currently falls back to cwd (`security.py:26`); require an explicit test/project root in automated or container runs so a standalone start cannot silently target a different workspace.
- Build active Python-only Linux/Windows CI and critical Ruff checks at the new root. Carry the original workflow's advisory full lint/format distinction until addressed; do not gate publication on a silently disabled suite. Archive, rather than activate, the original mixed CI workflow.
- Add active standalone Makefile/test wrappers and Python start/stop helpers based on preserved scripts. Remove React/npm/monorepo-path assumptions from these new helpers. Scripts that stop services must only stop processes they own.
- Retain the Python Dockerfile health/auth/nonroot behavior; build context becomes repository root. Add standalone Compose with Python only, explicit auth/origins, host Ollama, project bind mount and private config volume. Preserve `secure_server.py` as the container entrypoint.
- Document separately the two repositories' API compatibility version, supported release pair, deprecation policy and security reporting ownership. Update inherited `SECURITY.md`, contribution links, badges and repository URLs without losing provenance.
- Add `ORIGIN.md` recording original URL/SHA/date, filtered SHA, filter version/command, mappings/archive location, file moves and maintainer verification. Keep the manifest alongside release provenance.

## Licensing and provenance

The source root license is Apache-2.0. Keep it byte-identical at extraction, retain existing source headers (including `app_original.py`), attribution and any applicable historical third-party notices; record changed files in the standalone adaptation. No root NOTICE file was present at the audited boundary; inspect relevant historical/ref inputs and dependencies before concluding there are no additional notice obligations. Do not invent copyright holders or relicense the project. These steps reflect the [Apache-2.0 redistribution terms](https://www.apache.org/licenses/LICENSE-2.0), especially license/notice retention and changed-file notices.

Pi is not part of this extraction. Its license/dependencies would need a separate review only if a future evaluation proposes using it.

## Publication and rollback gates

The new repository must not be created during the preparatory phase. Later creation/publication needs a separate explicit decision and verified output. Do not initialize it with a competing README/license commit that creates unrelated history.

Before any future push, require:

- Manifest identity and history/provenance checks passed before adaptation.
- Full Python suite passed on Linux and Windows with documented skips; critical Ruff passed; import/startup and Docker build/health/auth/project-root smoke passed from a clean standalone checkout.
- Mocked-provider/API parity checks and an opt-in local Ollama smoke passed; no credentials or private user config in the Git history/publication set.
- License/policies/docs and source links complete; CI active; maintainers and support scope identified.
- Original monorepo Python remains intact, its CI stays active, and original launch paths still work.
- Only reviewed main and selected namespaced tags are eligible for publication. Do not force-push source or use `git push --mirror`.

After the separate creation/publication decision, push the reviewed standalone main explicitly and observe destination CI before announcing availability. Keep the original tree for a compatibility window; any later removal is a distinct PR after the TypeScript default has proven stable.

Rollback before publication: discard the verified disposable rehearsal output and start again from the unmodified archive; no application change is necessary. Rollback after publication: keep the original monorepo source/release authoritative, stop announcing the standalone release, and correct it with a follow-up commit/release. Do not rewrite published source history or delete repositories to repair a migration. Do not point launchers at an extraction that has not passed clean-checkout CI.

Backend rollout rollback remains independent: finish/cancel pending actions, stop only the owned TypeScript process, and restore private compatible config if changed. For tested browser/source-launch flows, launch the retained Python helper on the API port. For packaged Electron, restore the previous verified installer/artifact with its expected bundled backend; Python has no dedicated health identity endpoint and is not a proven drop-in desktop replacement. Never reuse opaque pending action IDs across processes.
