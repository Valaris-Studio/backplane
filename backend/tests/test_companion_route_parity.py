# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""COMPANION_ENABLED off: every companion path, under every method and with or
without a trailing slash, answers exactly like a route that never existed.

A 405 (wrong method), a 307 (trailing slash) or a 401/422 would each confirm
the feature is deployed, so the comparison is status + body + headers."""

import re
import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import settings
from app.database import get_db
from app.main import create_app
from app.routers import agent_session, companion, companion_pairing

COMPANION_ROUTERS = [
    companion.router,
    companion.device_router,
    companion_pairing.router,
    companion_pairing.device_router,
    agent_session.router,
    agent_session.card_router,
    agent_session.note_router,
]
METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
# Shared per-client budget headers count down between the two requests.
VOLATILE_HEADERS = {"x-ratelimit-remaining"}
PATH_PARAM = re.compile(r"\{[^}]+\}")


def _companion_paths() -> list[str]:
    some_id = "7b779090-29c6-4d37-953f-3edebda2b310"
    return sorted(
        {
            PATH_PARAM.sub(some_id, route.path)
            for router in COMPANION_ROUTERS
            for route in router.routes
        }
    )


COMPANION_PATHS = _companion_paths()


def test_parity_covers_the_whole_companion_surface():
    assert len(COMPANION_PATHS) >= 30
    assert "/api/companion/pairing" in COMPANION_PATHS
    assert "/api/companion/sessions" in COMPANION_PATHS


def _fingerprint(response) -> tuple[int, bytes, list[tuple[str, str]]]:
    headers = sorted(
        (name, value)
        for name, value in response.headers.multi_items()
        if name not in VOLATILE_HEADERS
    )
    return response.status_code, response.content, headers


@pytest.mark.parametrize("path", COMPANION_PATHS)
async def test_companion_path_is_an_unknown_route_for_every_method_when_disabled(
    monkeypatch, db_session, path
):
    monkeypatch.setattr(settings, "COMPANION_ENABLED", False)
    app = create_app()

    async def database():
        yield db_session

    app.dependency_overrides[get_db] = database
    unknown = f"/api/no-such-route-{uuid.uuid4().hex}"
    headers = {"Authorization": "Bearer bpc_not-a-token"}
    mismatches = []
    async with AsyncClient(
        transport=ASGITransport(app), base_url="http://test"
    ) as client:
        for method in METHODS:
            for slash in ("", "/"):
                observed = await client.request(method, path + slash, headers=headers)
                reference = await client.request(
                    method, unknown + slash, headers=headers
                )
                if _fingerprint(observed) != _fingerprint(reference):
                    mismatches.append(
                        (
                            method,
                            path + slash,
                            observed.status_code,
                            reference.status_code,
                        )
                    )
    assert mismatches == []


async def test_companion_routes_are_absent_from_the_schema_when_disabled(monkeypatch):
    monkeypatch.setattr(settings, "COMPANION_ENABLED", False)
    leaked = [
        path
        for path in create_app().openapi()["paths"]
        if "companion" in path or path.endswith("/sessions") or "/sessions/" in path
    ]
    assert leaked == []


async def test_companion_routes_are_served_when_enabled():
    assert settings.COMPANION_ENABLED is True
    served = set(create_app().openapi()["paths"])
    assert "/api/companion/pairing" in served
    assert "/api/workspaces/{slug}/sessions" in served
