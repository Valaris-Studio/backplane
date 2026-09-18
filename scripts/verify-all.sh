#!/usr/bin/env bash
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

# Run every gate that .github/workflows/ci.yml runs, locally.
#
# Why this exists: the public repo's Actions minutes are an external dependency
# we do not control (org billing, free-tier refills). Nothing about verifying
# this codebase should require GitHub to be willing to run a job. Keep this
# script and ci.yml in lockstep — if you add a gate to one, add it to the other.
#
#   ./scripts/verify-all.sh            # everything
#   ./scripts/verify-all.sh backend    # one job: backend|mcp|frontend|go|runner-artifact|secrets
#
# Exit code is non-zero if ANY selected job fails; every job still runs, so one
# failure does not hide the others.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ONLY="${1:-all}"
FAILED=()
PASSED=()

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
red() { printf '\033[31m%s\033[0m\n' "$1"; }

run_job() {
  local name="$1"
  shift
  if [[ "$ONLY" != "all" && "$ONLY" != "$name" ]]; then
    return 0
  fi
  bold "── ${name} ──"
  if "$@"; then
    PASSED+=("$name")
    green "✓ ${name}"
  else
    FAILED+=("$name")
    red "✗ ${name}"
  fi
  echo
}

job_backend() {
  # NOTE: must run from backend/ — pydantic Settings reads the .env at CWD, and
  # the repo-root .env holds runner credentials that trip extra_forbidden.
  (
    cd backend || exit 1
    # shellcheck disable=SC1091
    source .venv/bin/activate || exit 1
    python -m pip_audit --strict || exit 1
    ruff check app/ || exit 1
    python -m pytest -n 4 -m "not slow" -p no:cacheprovider --tb=short -q || exit 1
  )
}

job_mcp() {
  (
    cd mcp-server || exit 1
    command -v uv >/dev/null || { echo "MCP verification requires uv." >&2; exit 1; }
    command -v uvx >/dev/null || { echo "MCP verification requires uvx (included with uv)." >&2; exit 1; }
    local gate_dir
    gate_dir="$(mktemp -d)" || exit 1
    trap 'rm -rf "$gate_dir"' EXIT
    uv sync --frozen --extra dev || exit 1
    uv run --frozen python -m pytest tests/ --tb=short -q || exit 1
    uv export --frozen --no-hashes --no-emit-project --extra dev -o "$gate_dir/requirements.txt" || exit 1
    uvx pip-audit --strict --no-deps -r "$gate_dir/requirements.txt" || exit 1
    uv build --wheel --out-dir "$gate_dir/wheel" || exit 1
  )
}

job_frontend() {
  # KNOWN: the vitest suite has a pre-existing intermittent failure, observed
  # roughly 1 run in 8 (2026-07-26: 1 failure in ~9 full runs, never the same
  # symptom twice, six consecutive clean runs either side). Rerun once before
  # investigating a single red test here; treat a repeatable failure as real.
  (
    cd frontend || exit 1
    pnpm audit || exit 1
    pnpm lint || exit 1
    pnpm vitest run || exit 1
    pnpm docs:check || exit 1
    # pnpm build is the ONLY typecheck — vitest does not typecheck.
    pnpm build || exit 1
  )
}

job_go() {
  (
    cd runner || exit 1
    go vet ./... || exit 1
    go build ./... || exit 1
  ) || return 1
  "$REPO_ROOT/scripts/go-test-safe.sh"
}

job_runner_artifact() {
  "$REPO_ROOT/scripts/runner-artifact-gate.sh"
}

job_secrets() {
  ./scripts/scan-secrets.sh
}

run_job backend job_backend
run_job mcp job_mcp
run_job frontend job_frontend
run_job go job_go
run_job runner-artifact job_runner_artifact
run_job secrets job_secrets

bold "── summary ──"
for job in "${PASSED[@]:-}"; do [[ -n "$job" ]] && green "  ✓ ${job}"; done
for job in "${FAILED[@]:-}"; do [[ -n "$job" ]] && red "  ✗ ${job}"; done

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo
  red "${#FAILED[@]} job(s) failed."
  exit 1
fi

echo
green "All gates passed — this is what CI would have told you."
