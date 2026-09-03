.PHONY: help test test-python test-typescript test-react test-smoke-python test-smoke-typescript test-smoke-react typecheck-typescript build-react install-python install-typescript install-react

help:
	@echo "Available targets:"
	@echo "  make test                Run all Python, TypeScript, and React tests"
	@echo "  make test-python         Run server-python tests"
	@echo "  make test-typescript     Run server-typescript tests"
	@echo "  make test-react          Run client-react tests"
	@echo "  make test-smoke-python   Run server-python smoke tests"
	@echo "  make test-smoke-typescript Run server-typescript smoke tests"
	@echo "  make test-smoke-react    Run client-react smoke tests"
	@echo "  make typecheck-typescript Run TypeScript typecheck"
	@echo "  make build-react         Build the React client"
	@echo "  make install-python      Install Python dependencies"
	@echo "  make install-typescript  Install TypeScript dependencies"
	@echo "  make install-react       Install React dependencies"

install-python:
	python -m pip install -r server-python/requirements.txt
	python -m pip install pytest

install-typescript:
	cd server-typescript && npm install

install-react:
	cd client-react && npm install

test-python:
	python -m pytest server-python/tests -q

test-typescript:
	cd server-typescript && npm test -- --run

test-react:
	cd client-react && npm test -- --run

test-smoke-python:
	python -m pytest server-python/tests/test_smoke.py -q

test-smoke-typescript:
	cd server-typescript && npm test -- --run tests/smoke.test.ts

test-smoke-react:
	cd client-react && npm test -- --run src/App.smoke.test.jsx

test: test-python test-typescript test-react

typecheck-typescript:
	cd server-typescript && npm run typecheck

build-react:
	cd client-react && npm run build
