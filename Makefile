SHELL := /bin/bash
.PHONY: dev dev-backend dev-frontend dev-runner migrate migrate-create test test-fast test-all lint rebuild deploy deploy-backend deploy-frontend mcp-install mcp-dev mcp-lint mcp-test deploy-verify runner-setup runner-build runner-test runner-discover smoke smoke-fast quickstart-gate doctor test-e2e
.PHONY: runner-release

# Start everything (add --profile runner to include the agent)
dev:
	docker compose up

# Start with the runner
dev-runner:
	docker compose --profile runner up

# Backend only (assumes Postgres is running — the compose Postgres on :5433
# now matches the Settings default, so no env var override is needed)
dev-backend:
	cd backend && uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Frontend only
dev-frontend:
	cd frontend && pnpm dev

# Database migrations
DB_URL ?= postgresql+asyncpg://valaris:valaris@localhost:5433/valaris

migrate:
	cd backend && source .venv/bin/activate && DATABASE_URL=$(DB_URL) alembic upgrade head

migrate-create:
	@read -p "Migration message: " msg; \
	cd backend && source .venv/bin/activate && DATABASE_URL=$(DB_URL) alembic revision --autogenerate -m "$$msg"

migrate-downgrade:
	cd backend && source .venv/bin/activate && DATABASE_URL=$(DB_URL) alembic downgrade -1

# Populate an empty instance with a sample workspace + board so a fresh
# install has something to look at. Idempotent; refuses on a non-empty
# instance unless you pass FORCE=1. SEED_EMAIL gets owner access to the
# demo workspace (defaults to the dev-mode identity). seed-demo runs inside
# the dev container so the quickstart needs Docker only; seed-demo-native is
# for backend-native development.
SEED_EMAIL ?= dev@valaris.dev

seed-demo:
	docker compose exec -T backend python -m scripts.seed_demo --email $(SEED_EMAIL) $(if $(FORCE),--force,)

seed-demo-native:
	cd backend && source .venv/bin/activate && DATABASE_URL=$(DB_URL) python -m scripts.seed_demo --email $(SEED_EMAIL) $(if $(FORCE),--force,)

# Testing
test:
	cd backend && source .venv/bin/activate && python -m pytest -v

# Fast inner-loop: parallel via pytest-xdist, skips tests marked @pytest.mark.slow.
# Use during active development. `make test` remains the authoritative pre-commit / CI run.
test-fast:
	cd backend && source .venv/bin/activate && python -m pytest -n auto -m "not slow" -q

# Every gate that GitHub CI runs, locally — so verification never depends on
# Actions minutes being available. Optional job filter: make verify JOB=frontend
verify:
	./scripts/verify-all.sh $(JOB)

test-cov:
	cd backend && source .venv/bin/activate && python -m pytest --cov=app --cov-report=html

# Linting
lint:
	cd backend && ruff check app/
	cd frontend && pnpm lint

format:
	cd backend && ruff format app/

# Docker
build:
	docker compose build

rebuild:
	docker compose build --no-cache
	docker compose up -d

clean:
	docker compose down -v
	rm -rf backend/__pycache__ backend/app/__pycache__
	rm -rf frontend/node_modules frontend/dist

# Production deployment (Cloud Build)
deploy:
	gcloud builds submit --config=cloudbuild.yaml --substitutions=_DEPLOY_TARGET=all

deploy-backend:
	gcloud builds submit --config=cloudbuild.yaml --substitutions=_DEPLOY_TARGET=backend

deploy-frontend:
	gcloud builds submit --config=cloudbuild.yaml --substitutions=_DEPLOY_TARGET=frontend

# Post-merge fail-loud path: the valaris-full push trigger has a silent-miss
# history, so this finds-or-fires the build for HEAD and proves it is serving.
# Only CHECK_ONLY=1 enables the report-only mode; any other value is ignored.
deploy-verify:
	@test -x scripts/deploy-verify.sh || { echo "deploy-verify is internal-only (targets Valaris' own Cloud Run services); not part of the public tree"; exit 1; }
	./scripts/deploy-verify.sh $(if $(filter 1,$(CHECK_ONLY)),--check-only)

# MCP Server
# Creates mcp-server/.venv (which `make smoke` and `make test-all` require)
# with uv when available, stdlib venv+pip otherwise. The fallback prefers
# versioned interpreters (requires-python is >=3.12; macOS stock `python3`
# is 3.9) and upgrades pip first — the bundled pip on older interpreters
# predates PEP 660 and fails editable installs with a misleading
# "setup.py not found" instead of the real requires-python error.
# Locked resolution (same policy as CI). The by-ranges pip path runs ONLY when
# uv is absent; a failing frozen sync must fail loudly, not hand out a venv
# that differs from CI.
mcp-install:
	cd mcp-server && if command -v uv >/dev/null 2>&1; then uv sync --frozen --extra dev; else { python3.13 -m venv .venv 2>/dev/null || python3.12 -m venv .venv 2>/dev/null || python3 -m venv .venv; } && .venv/bin/python -m pip install --quiet --upgrade pip && .venv/bin/pip install -e ".[dev]"; fi

mcp-dev:
	cd mcp-server && uv run valaris-mcp

mcp-lint:
	cd mcp-server && ruff check src/

mcp-test:
	cd mcp-server && uv run --extra dev pytest tests/ -v

# Runner
runner-setup:
	cd runner && bash scripts/setup.sh

runner-build:
	cd runner && make build

runner-test:
	./scripts/go-test-safe.sh -v

# Cross-compile all release binaries (darwin/linux/windows × amd64/arm64).
# VERSION=x.y.z required; add PUBLISH=1 to upload to GCS, LATEST=1 to also
# repoint the runner/latest/ alias.
runner-release:
	@test -x scripts/release-runner.sh || { echo "runner-release is internal-only (publishes to Valaris' release bucket); not part of the public tree"; exit 1; }
	./scripts/release-runner.sh $(VERSION) $(if $(REF),--ref $(REF)) $(if $(PUBLISH),--publish) $(if $(LATEST),--latest)

runner-discover:
	cd runner && make discover

# Integration smoke — cross-card seam gate. Catches CORS/env/migration/MCP/build
# drift that per-card pipelines miss. Aim: <60s. Use `smoke-fast` to skip the
# frontend pnpm build during inner-loop iteration. Override with
# `SMOKE_SKIP=name1,name2 make smoke` to skip specific checks.
smoke:
	cd backend && source .venv/bin/activate && python ../scripts/smoke.py

smoke-fast:
	cd backend && source .venv/bin/activate && python ../scripts/smoke.py --fast

# Fresh-clone gate: runs the README Quickstart end-to-end in disposable
# containers/volumes. Self-contained: copies the working tree (tracked +
# untracked-unignored files only) into a temp dir and publishes on randomized
# free ports, so it runs safely from this checkout even with `make dev` up
# and a real .env present. Needs Docker, bash, and curl.
quickstart-gate:
	./scripts/quickstart-gate.sh

# One-shot dev-stack health readout: "is `make dev` actually up?" -- the
# audit's fix for a partial stack getting mistaken for success.
doctor:
	./scripts/doctor.sh

# Browser-level "console must be clean" acceptance gate (frontend/e2e/).
# Deliberately NOT in test-all or CI: it needs the live `make dev` stack,
# which CI does not have. The curl guard fails loudly instead of letting
# Playwright time out flow-by-flow against a dead stack.
test-e2e:
	@curl -sf -o /dev/null http://localhost:5173/ || { echo "test-e2e: frontend not answering on :5173 — run 'make dev' first (see 'make doctor')"; exit 1; }
	cd frontend && pnpm test:e2e

# Run all test suites
test-all:
	cd backend && source .venv/bin/activate && python -m pytest -v
	./scripts/go-test-safe.sh -v
	cd mcp-server && source .venv/bin/activate && uv run --extra dev pytest tests/ -v
	cd frontend && pnpm lint && pnpm vitest run && pnpm build
