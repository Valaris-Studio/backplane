#!/bin/sh
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

set -e

echo "Running database migrations..."
python -m alembic upgrade head

echo "Starting server..."
exec uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
