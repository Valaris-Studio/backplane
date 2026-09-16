#!/usr/bin/env bash
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

# One-shot dev-stack health readout: "is `make dev` actually up?"
#
# The audit's finding was a partial stack getting mistaken for success --
# `docker compose up` returning does not mean Postgres finished its healthcheck,
# migrations landed, or Vite is actually serving. This prints one readout
# covering all of that and exits non-zero only when something concrete is
# wrong, so it's safe to run reflexively whenever `make dev` feels off.
#
# Every check below is collected, never aborted on — a docker daemon that's
# down, or a service that's exited, must still let the rest of the readout
# print, so `set -e` cannot apply to the check bodies themselves.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

problems=0
note_problem() { problems=$((problems + 1)); }

section() { echo; echo "== $* =="; }

section "Versions"
if command -v docker >/dev/null 2>&1; then
  docker --version
else
  echo "docker: missing"
  note_problem
fi
if docker compose version >/dev/null 2>&1; then
  docker compose version
else
  echo "docker compose: missing"
  note_problem
fi

section "docker compose ps"
if ! docker compose ps 2>&1; then
  echo "(docker compose ps failed -- daemon unreachable or compose project unresolvable)"
  note_problem
fi

# `docker compose ps --format` is the only reliable "is X running" signal
# across compose versions; grep the human table above only for the printout.
running_services="$(docker compose ps --status running --format '{{.Service}}' 2>/dev/null || true)"
all_services="$(docker compose ps -a --format '{{.Service}} {{.State}}' 2>/dev/null || true)"

is_running() {
  local svc="$1"
  printf '%s\n' "$running_services" | grep -qx "$svc"
}

# "Stack down" means no essential service is actually running -- exited
# leftovers from a previous `make dev` (or `docker compose ps -a` being empty
# outright on a repo that's never been upped) both count. A `docker compose
# ps` with only exited containers is not "up" just because records exist.
any_essential_running=0
for svc in postgres backend frontend; do
  is_running "$svc" && any_essential_running=1
done

# An absent stack is a diagnosis, not a success: automation (and reflexive
# humans) treat exit 0 as "all good", so this must fail like any other problem.
if [[ "$any_essential_running" -eq 0 ]]; then
  echo
  echo "DOCTOR: STACK NOT RUNNING"
  exit 1
fi

section "Essential services (postgres / backend / frontend)"
essential_unhealthy=0
for svc in postgres backend frontend; do
  state_line="$(printf '%s\n' "$all_services" | awk -v s="$svc" '$1==s {print; exit}')"
  if [[ -z "$state_line" ]]; then
    echo "$svc: not created"
    essential_unhealthy=1
    continue
  fi
  echo "$state_line"
  case "$state_line" in
    *exited*|*dead*)
      essential_unhealthy=1
      ;;
  esac
  # Health status isn't in the State column on every compose version; ask
  # docker inspect directly for the healthcheck's own verdict when present.
  cid="$(docker compose ps -q "$svc" 2>/dev/null || true)"
  if [[ -n "$cid" ]]; then
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$cid" 2>/dev/null || true)"
    if [[ -n "$health" ]]; then
      echo "  health: $health"
      [[ "$health" == "unhealthy" ]] && essential_unhealthy=1
    fi
  fi
done
[[ "$essential_unhealthy" -eq 1 ]] && note_problem

section "Ports"
for port in 5433 8000 5173; do
  if command -v lsof >/dev/null 2>&1; then
    listener="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | tail -n +2)"
    if [[ -n "$listener" ]]; then
      echo "$port: listening"
    else
      echo "$port: NO LISTENER"
      note_problem
    fi
  else
    # Without lsof we can't tell "free" from "unobservable" — say so instead
    # of counting a phantom problem.
    echo "$port: cannot check (lsof missing)"
  fi
done

section "HTTP probes"
probe() {
  local label="$1" url="$2"
  local code
  # On connection failure curl's `-w` already prints "000" AND exits non-zero;
  # reassigning (instead of `|| echo`, which appended a second "000" into the
  # same substitution → "000000") keeps the code a single well-formed value.
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null)" || code="000"
  echo "$label ($url): $code"
  # These endpoints have exactly one healthy answer: 2xx. A 404 or a redirect
  # is a misrouted or half-up stack, not success.
  if [[ ! "$code" =~ ^2[0-9][0-9]$ ]]; then
    note_problem
    return 1
  fi
  return 0
}

if is_running backend; then
  probe "backend /api/health" "http://127.0.0.1:8000/api/health" || true
  probe "backend /api/ready" "http://127.0.0.1:8000/api/ready" || true
else
  echo "backend not running -- skipping backend probes"
fi

if is_running frontend; then
  probe "frontend /" "http://127.0.0.1:5173/" || true
else
  echo "frontend not running -- skipping frontend probe"
fi

section "Migration state"
if is_running backend; then
  # `alembic current` exiting 0 only proves alembic ran — a database sitting
  # on an older revision reports it happily. "(head)" in the output is the
  # actual up-to-date signal (same contract quickstart-gate.sh enforces).
  if migration_output="$(docker compose exec -T backend python -m alembic current 2>&1)"; then
    echo "$migration_output"
    if ! grep -q "(head)" <<<"$migration_output"; then
      echo "(migrations NOT at head)"
      note_problem
    fi
  else
    echo "$migration_output"
    echo "(alembic current failed)"
    note_problem
  fi
else
  echo "backend not running"
fi

section "Frontend lockfile"
if [[ -f "$REPO_ROOT/frontend/pnpm-lock.yaml" ]]; then
  echo "frontend/pnpm-lock.yaml: present"
else
  echo "frontend/pnpm-lock.yaml: MISSING"
  note_problem
fi

echo
if [[ "$problems" -eq 0 ]]; then
  echo "DOCTOR: OK"
  exit 0
else
  echo "DOCTOR: PROBLEMS FOUND ($problems)"
  exit 1
fi
