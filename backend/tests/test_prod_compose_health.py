# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Pins docker-compose.prod.yml's healthcheck/dependency wiring.

Compose's `depends_on` (bare form) only waits for the container to START, not
for the app inside to be ready -- with no healthcheck, frontend/runner can
start proxying to `backend` before `alembic upgrade head` finishes, hammering
a not-yet-serving process. `condition: service_healthy` closes that gap, but
only once backend/frontend both define a `healthcheck:` and backend's probes
the new DB-backed /api/ready (not /api/health, which is deliberately DB-free
and would report "healthy" before migrations complete). Same yaml-parsing
style as test_prod_compose_env_drift.py.
"""

from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILE = REPO_ROOT / "docker-compose.prod.yml"


def _services() -> dict:
    compose = yaml.safe_load(COMPOSE_FILE.read_text())
    return compose["services"]


def test_backend_healthcheck_probes_ready_endpoint():
    backend = _services()["backend"]
    healthcheck = backend.get("healthcheck")
    assert healthcheck, "backend service is missing a healthcheck block"
    test = healthcheck.get("test")
    # `test` is either a string or a ["CMD"/"CMD-SHELL", ...] list -- flatten
    # to one string so either form matches the same substring check.
    test_str = test if isinstance(test, str) else " ".join(test)
    assert "/api/ready" in test_str, (
        f"backend healthcheck does not reference /api/ready: {test_str!r}. "
        "/api/health is deliberately DB-free and would report healthy before "
        "migrations finish -- the healthcheck must hit /api/ready instead."
    )


def test_frontend_has_healthcheck():
    frontend = _services()["frontend"]
    assert frontend.get("healthcheck"), "frontend service is missing a healthcheck block"


def test_frontend_depends_on_backend_healthy():
    frontend = _services()["frontend"]
    depends_on = frontend.get("depends_on")
    assert isinstance(depends_on, dict) and "backend" in depends_on, (
        "frontend must depend_on backend with an explicit condition (not the "
        "bare list form, which only waits for container start)"
    )
    assert depends_on["backend"].get("condition") == "service_healthy"


def test_runner_depends_on_backend_healthy():
    runner = _services()["runner"]
    depends_on = runner.get("depends_on")
    assert isinstance(depends_on, dict) and "backend" in depends_on, (
        "runner must depend_on backend with an explicit condition (not the "
        "bare list form, which only waits for container start)"
    )
    assert depends_on["backend"].get("condition") == "service_healthy"


def test_postgres_healthcheck_still_present():
    postgres = _services()["postgres"]
    assert postgres.get("healthcheck"), "postgres service lost its healthcheck block"
