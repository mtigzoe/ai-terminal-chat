.PHONY: help test test-typescript test-react test-smoke-typescript test-smoke-react typecheck-typescript build-react install-typescript install-react

help:
	@echo "Available targets:"
	@echo "  make test                  Run TypeScript and React tests"
	@echo "  make test-typescript       Run backend tests"
	@echo "  make test-react            Run client tests"
	@echo "  make test-smoke-typescript Run backend smoke tests"
	@echo "  make test-smoke-react      Run React smoke tests"
	@echo "  make typecheck-typescript  Run backend typecheck"
	@echo "  make build-react           Build the React client"
	@echo "  make install-typescript    Install backend dependencies"
	@echo "  make install-react         Install client dependencies"

install-typescript:
	cd server-typescript && npm ci

install-react:
	cd client-react && npm ci

test-typescript:
	cd server-typescript && npm test -- --run

test-react:
	cd client-react && npm test -- --run

test-smoke-typescript:
	cd server-typescript && npx vitest run tests/smoke.test.ts

test-smoke-react:
	cd client-react && npm test -- --run src/App.smoke.test.jsx

test: test-typescript test-react

typecheck-typescript:
	cd server-typescript && npm run typecheck

build-react:
	cd client-react && npm run build
