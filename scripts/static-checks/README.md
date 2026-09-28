# Static Checks & Tests

Scripts for linting, type-checking, and running tests across the project.

## Layout

| Script | Target | What it runs |
|--------|--------|--------------|
| `check-python.sh` | `server-python/` | ruff check, ruff format --check, mypy |
| `check-typescript.sh` | `server-typescript/` | `tsc --noEmit`, npm lint (if present) |
| `check-react.sh` | `client-react/` | `tsc --noEmit`, npm lint / eslint |
| `run-all-tests.sh` | all three | pytest + npm test for each package |

## Prerequisites

- **Python**: `ruff`, `mypy`, `pytest` (scripts install ruff/mypy if missing)
- **Node**: npm, and dependencies installed in each package (`npm ci` runs automatically if `node_modules` is missing)

## Usage

From the **repository root**:

```bash
chmod +x scripts/static-checks/*.sh

# Static analysis
./scripts/static-checks/check-python.sh
./scripts/static-checks/check-typescript.sh
./scripts/static-checks/check-react.sh

# All unit/integration tests
./scripts/static-checks/run-all-tests.sh
```

## Notes

- Scripts assume the standard directory layout: `server-python/`, `server-typescript/`, `client-react/`.
- `run-all-tests.sh` continues through all suites and exits non-zero if any failed.
- mypy is run with `--ignore-missing-imports` so missing stubs do not block the pipeline.
- If a package has no `lint` or `test` script in `package.json`, that step is skipped with a message.
