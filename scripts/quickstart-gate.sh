#!/usr/bin/env bash
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

# Fresh-clone Quickstart gate. Runs README's Quickstart end-to-end in
# disposable containers/volumes and fails loudly if it ever regresses.
#
# Exists because `make dev` was broken on every fresh Docker clone for 6 days
# (2026-07 incident): frontend/pnpm-workspace.yaml lacked a `packages:` key,
# which made the pnpm 9 of the era refuse the container's install — a warm
# frontend-node-modules volume on every dev machine masked it, so nothing ever
# ran the cold path. (Pinned pnpm 11.5.1 defaults an omitted `packages` to
# ["."], so that exact mutation no longer fails at runtime; it is pinned at
# commit time by backend/tests/test_pnpm_config_drift.py instead.)
# COMPOSE_PROJECT_NAME below gives each run a unique project name, so named
# volumes start fresh even on a machine that has run `make dev` a hundred
# times. Fresh ≠ empty: Docker seeds a fresh named volume from the image's
# /app/node_modules on first mount, so the first-boot install the gate
# exercises is a reconcile over image-seeded modules, not install-from-zero —
# the gate's real value is proving the whole fresh-clone Quickstart boots to a
# serving stack.
#
# Self-contained by construction (2026-08 onboarding audit): the gate copies
# the checkout's tracked + untracked-unignored files into a temp workdir (so
# your real .env, node_modules, and volumes are never touched) and publishes
# on randomized free host ports — it runs fine from a checkout that is
# mid-Quickstart with `make dev` up on the default ports.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

GATE_START=$(date +%s)
elapsed() { echo "$(( $(date +%s) - GATE_START ))s"; }
log() { echo "[quickstart-gate $(elapsed)] $*"; }

export COMPOSE_PROJECT_NAME="backplane-quickstart-gate-$$"
log "using disposable compose project '$COMPOSE_PROJECT_NAME' (empty volumes, even on a warm dev machine)"

WORKDIR=""

dump_logs() {
  log "dumping last 50 lines of container logs for diagnosis"
  for svc in postgres backend frontend; do
    echo "----- docker compose logs $svc (tail 50) -----"
    docker compose logs --tail=50 "$svc" 2>&1 || true
  done
}

cleanup() {
  local status=$?
  if [[ -n "$WORKDIR" && -d "$WORKDIR" ]]; then
    cd "$WORKDIR"
    if [[ $status -ne 0 ]]; then
      dump_logs
    fi
    log "tearing down compose project '$COMPOSE_PROJECT_NAME'"
    docker compose down -v --remove-orphans >/dev/null 2>&1 || true
    cd /
    rm -rf "$WORKDIR"
  fi
  if [[ $status -eq 0 ]]; then
    log "QUICKSTART GATE: PASS (total $(elapsed))"
  else
    log "QUICKSTART GATE: FAIL (total $(elapsed))"
  fi
  exit "$status"
}
trap cleanup EXIT

fail() {
  log "FAIL: $*"
  exit 1
}

port_free() {
  local port=$1
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN -P -n >/dev/null 2>&1 && return 1 || return 0
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && return 1 || return 0
  fi
}

# --- Preflight: pristine workdir + free ports ---------------------------

# Tracked + untracked-unignored gives the working tree as a fresh clone would
# see it: uncommitted edits included, but .env / node_modules / volumes /
# docker-compose.override.yml (all gitignored) excluded. Deleted-but-tracked
# paths are filtered out so tar doesn't trip on them.
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/backplane-quickstart-gate.XXXXXX")"
log "copying pristine working tree into $WORKDIR"
(
  cd "$REPO_ROOT"
  git ls-files -co --exclude-standard -z | while IFS= read -r -d '' f; do
    [[ -e "$f" ]] && printf '%s\0' "$f"
  done | tar --null -T - -cf -
) | tar -C "$WORKDIR" -xf -

# Randomized ports keep the gate runnable next to a live `make dev` (or a
# second concurrent gate). docker-compose.yml reads these as host-port
# overrides; in-container ports never change.
for attempt in {1..20}; do
  base=$(( 20000 + RANDOM % 20000 ))
  if port_free "$base" && port_free "$((base + 1))" && port_free "$((base + 2))"; then
    export BACKPLANE_DEV_DB_PORT=$base
    export BACKPLANE_DEV_BACKEND_PORT=$((base + 1))
    export BACKPLANE_DEV_FRONTEND_PORT=$((base + 2))
    break
  fi
  [[ $attempt -eq 20 ]] && fail "could not find three free host ports after 20 attempts"
done
BACKEND_URL="http://localhost:$BACKPLANE_DEV_BACKEND_PORT"
FRONTEND_URL="http://localhost:$BACKPLANE_DEV_FRONTEND_PORT"
log "publishing on ports db=$BACKPLANE_DEV_DB_PORT backend=$BACKPLANE_DEV_BACKEND_PORT frontend=$BACKPLANE_DEV_FRONTEND_PORT"

cd "$WORKDIR"

# --- Step 1: cp .env.example .env --------------------------------------

log "step 1/8: cp .env.example .env"
cp "$WORKDIR/.env.example" "$WORKDIR/.env"
log "step 1/8: PASS"

# --- Step 2: docker compose up -d --build -------------------------------

log "step 2/8: docker compose up -d --build"
docker compose up -d --build
log "step 2/8: PASS"

# --- Step 3: wait for postgres healthy, backend migrations at head ------

log "step 3/8: waiting for postgres health=healthy (timeout 120s)"
deadline=$(( $(date +%s) + 120 ))
until [[ "$(docker compose ps -q postgres | xargs -I{} docker inspect -f '{{.State.Health.Status}}' {} 2>/dev/null)" == "healthy" ]]; do
  if (( $(date +%s) > deadline )); then
    fail "postgres did not become healthy within 120s"
  fi
  sleep 2
done
log "step 3/8: postgres healthy"

log "step 3/8: waiting for backend 'Application startup complete' (timeout 180s)"
deadline=$(( $(date +%s) + 180 ))
# `--tail=500` bounds the per-iteration fetch; the target line is the last
# thing the backend prints before going quiet, so it can't scroll past.
# Capture into a variable rather than piping straight into `grep -q`: grep
# closes its end of the pipe as soon as it finds a match, and under a
# detached/non-interactive process group (e.g. this script run via nohup in
# CI) `docker compose logs` reports that as a non-zero exit rather than dying
# silently to SIGPIPE like it does in an interactive shell — with `pipefail`
# set, that flips the whole pipeline's exit status to non-zero even though
# grep DID match, so the loop would spin until the timeout on a real match.
until backend_log="$(docker compose logs --tail=500 backend 2>&1)" && echo "$backend_log" | grep -q "Application startup complete"; do
  if (( $(date +%s) > deadline )); then
    fail "backend did not log 'Application startup complete' within 180s"
  fi
  sleep 2
done
log "step 3/8: backend startup complete"

log "step 3/8: verifying migrations are at head"
migration_output="$(docker compose exec -T backend python -m alembic current 2>&1)" || fail "alembic current failed: $migration_output"
echo "$migration_output" | grep -q "(head)" || fail "migrations not at head, alembic current said: $migration_output"
log "step 3/8: PASS (migrations at head)"

# --- Step 4: poll frontend for HTTP 200 ----------------------------------

# The frontend container's runtime `pnpm install --frozen-lockfile` into the
# fresh (image-seeded — see header) node_modules volume runs before Vite, and
# if it exits 1, curl never sees a 200. Under pinned pnpm 11.5.1 this does NOT
# catch a missing pnpm-workspace.yaml `packages:` key (omitted defaults to
# ["."]; backend/tests/test_pnpm_config_drift.py pins that at commit time) —
# the install failure it does catch is package.json↔lockfile drift, which
# --frozen-lockfile refuses loudly (verified: a drifted specifier fails with
# ERR_PNPM_OUTDATED_LOCKFILE before installing anything).
# An actual 200 subsumes the README's "VITE ready" log milestone — it proves
# the dev server serves, not merely that it printed a banner.
log "step 4/8: polling $FRONTEND_URL/ for HTTP 200 (timeout 180s)"
deadline=$(( $(date +%s) + 180 ))
until [[ "$(curl -s -o /dev/null -w '%{http_code}' "$FRONTEND_URL/" 2>/dev/null)" == "200" ]]; do
  if (( $(date +%s) > deadline )); then
    fail "frontend never returned HTTP 200 on :$BACKPLANE_DEV_FRONTEND_PORT within 180s"
  fi
  sleep 3
done
log "step 4/8: PASS"

# --- Step 5: backend health + swagger docs -------------------------------

log "step 5/8: asserting backend health + swagger docs"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$BACKEND_URL/api/health")" == "200" ]] || fail "GET /api/health did not return 200"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$BACKEND_URL/api/docs")" == "200" ]] || fail "GET /api/docs did not return 200"
log "step 5/8: PASS"

# --- Step 6: make seed-demo twice, second run idempotent -----------------

log "step 6/8: make seed-demo (first run)"
first_seed_output="$(make -C "$WORKDIR" seed-demo 2>&1)" || { echo "$first_seed_output"; fail "first make seed-demo did not exit 0"; }
echo "$first_seed_output"

log "step 6/8: make seed-demo (second run, must be idempotent)"
second_seed_output="$(make -C "$WORKDIR" seed-demo 2>&1)" || { echo "$second_seed_output"; fail "second make seed-demo did not exit 0"; }
echo "$second_seed_output"
echo "$second_seed_output" | grep -qi "already exists" || fail "second make seed-demo did not report idempotency ('already exists' not found in output)"
log "step 6/8: PASS"

# --- Step 7: frontend's /api proxy leg ------------------------------------

log "step 7/8: asserting Vite /api proxy leg ($FRONTEND_URL/api/health)"
proxy_response="$(curl -s -w '\n%{http_code}' "$FRONTEND_URL/api/health")"
proxy_status="$(echo "$proxy_response" | tail -n1)"
proxy_body="$(echo "$proxy_response" | sed '$d')"
[[ "$proxy_status" == "200" ]] || fail "GET $FRONTEND_URL/api/health returned $proxy_status, expected 200"
[[ -n "$proxy_body" ]] || fail "GET $FRONTEND_URL/api/health returned an empty body"
log "step 7/8: PASS (body: $proxy_body)"

# --- Step 8: teardown happens in the EXIT trap ----------------------------

log "step 8/8: all checks passed, teardown will run via EXIT trap"
