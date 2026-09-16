#!/bin/sh
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

set -e

echo "Running database migrations..."
# Cloud Run rolling updates can spawn a new instance while the DB pool is
# saturated; a bare `alembic upgrade head` then dies for lack of a slot and
# `set -e` crash-loops the whole container. Retry a few times so a transient
# connection shortage self-heals instead of taking the instance down.
attempt=1
max_attempts=5
until python -m alembic upgrade head; do
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "Migrations failed after ${max_attempts} attempts; giving up." >&2
    exit 1
  fi
  echo "Migration attempt ${attempt} failed; retrying in 5s..." >&2
  attempt=$((attempt + 1))
  sleep 5
done

echo "Starting production server..."
exec gunicorn app.main:app -k uvicorn.workers.UvicornWorker \
  --bind 0.0.0.0:${PORT:-8000} --workers 2
