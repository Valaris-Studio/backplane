# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Pins docker-compose.yml's (dev) healthcheck wiring for backend and frontend.

Unlike docker-compose.prod.yml (see test_prod_compose_health.py), dev has NO
healthchecks on backend or frontend at all today -- a contributor's `make dev`
gives no signal beyond "container started" for either service, so a slow
migration or a frontend still mid-`pnpm install` looks identical to "ready"
from the outside. This adds probes (backend -> /api/ready, frontend -> :5173)
without adding `depends_on: condition: service_healthy` gating between them:
dev iteration deliberately does NOT want frontend blocked on backend health --
a contributor working frontend-only should not stall behind a backend that's
still migrating. Same yaml-parsing style as test_prod_compose_health.py.
"""

from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILE = REPO_ROOT / "docker-compose.yml"


def _services() -> dict:
    compose = yaml.safe_load(COMPOSE_FILE.read_text())
    return compose["services"]


def _healthcheck_test_str(service: dict) -> str:
    healthcheck = service.get("healthcheck")
    assert healthcheck, "service is missing a healthcheck block"
    test = healthcheck.get("test")
    # `test` is either a string or a ["CMD"/"CMD-SHELL", ...] list -- flatten
    # to one string so either form matches the same substring check.
    return test if isinstance(test, str) else " ".join(test)


def test_backend_has_readiness_healthcheck():
    backend = _services()["backend"]
    test_str = _healthcheck_test_str(backend)
    assert (
        "/api/ready" in test_str
    ), f"backend healthcheck does not reference /api/ready: {test_str!r}"


def test_frontend_has_healthcheck():
    frontend = _services()["frontend"]
    test_str = _healthcheck_test_str(frontend)
    assert (
        "5173" in test_str
    ), f"frontend healthcheck does not reference the dev server port 5173: {test_str!r}"


def test_postgres_healthcheck_still_present():
    postgres = _services()["postgres"]
    assert postgres.get("healthcheck"), "postgres service lost its healthcheck block"
