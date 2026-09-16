# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Anonymous instance telemetry — OPT-IN, and silent about everything personal.

Default is OFF: a self-hoster who never reads a config file never phones home.
When switched on, the payload is deliberately tiny — an instance id, the
version, and coarse counts — so the maintainer can see adoption without
learning anything about the deployment's people, projects, or content.
"""

from __future__ import annotations

import uuid

import httpx
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings as app_settings
from app.models.user import User
from app.models.workspace import Workspace
from app.services.telemetry import (
    TelemetryService,
    build_payload,
    instance_id_for,
    telemetry_enabled,
)


@pytest_asyncio.fixture
async def tel_db(db_engine):
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session


# ── the switch ──


def test_telemetry_is_off_by_default():
    """The shipped default must be silence — nobody opts in by accident."""
    from app.config import Settings

    assert Settings().BACKPLANE_TELEMETRY_ENABLED is False


def test_no_default_endpoint_ships():
    """Belt and braces: even if someone flips the flag, there is nowhere to
    send to until an operator names a URL. No receiving service exists yet."""
    from app.config import Settings

    assert Settings().BACKPLANE_TELEMETRY_ENDPOINT == ""


def test_disabled_by_default_at_runtime(monkeypatch):
    monkeypatch.setattr(app_settings, "BACKPLANE_TELEMETRY_ENABLED", False)
    assert telemetry_enabled() is False


def test_enabled_only_when_explicitly_set(monkeypatch):
    monkeypatch.setattr(app_settings, "BACKPLANE_TELEMETRY_ENABLED", True)
    assert telemetry_enabled() is True


@pytest.mark.asyncio
async def test_disabled_service_sends_nothing(monkeypatch, tel_db):
    """The strong guarantee: disabled means no outbound request at all."""
    monkeypatch.setattr(app_settings, "BACKPLANE_TELEMETRY_ENABLED", False)
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200)

    service = TelemetryService(
        tel_db, http_client_factory=_factory(handler)
    )
    sent = await service.send_ping()

    assert sent is False
    assert calls == [], "disabled telemetry must not make any network call"


# ── the payload ──


@pytest.mark.asyncio
async def test_payload_contains_only_anonymous_fields(monkeypatch, tel_db):
    monkeypatch.setattr(app_settings, "BACKPLANE_TELEMETRY_ENABLED", True)
    owner = User(email="alice@corp.example", name="Alice Smith")
    tel_db.add(owner)
    await tel_db.flush()
    tel_db.add(
        Workspace(
            name="Secret Client Project", slug="secret-client", created_by=owner.id
        )
    )
    await tel_db.flush()

    payload = await build_payload(tel_db)

    assert set(payload) == {
        "instance_id",
        "version",
        "python_version",
        "user_count",
        "workspace_count",
    }
    serialized = str(payload)
    # Nothing identifying may ride along, however convenient it would be.
    for leak in ("alice", "corp.example", "Alice", "Secret Client", "secret-client"):
        assert leak.lower() not in serialized.lower(), f"payload leaked {leak!r}"


@pytest.mark.asyncio
async def test_payload_counts_are_coarse_integers(monkeypatch, tel_db):
    monkeypatch.setattr(app_settings, "BACKPLANE_TELEMETRY_ENABLED", True)
    owner = User(email="a@b.c", name="A")
    tel_db.add(owner)
    await tel_db.flush()
    tel_db.add(Workspace(name="W", slug="w", created_by=owner.id))
    await tel_db.flush()

    payload = await build_payload(tel_db)
    assert isinstance(payload["user_count"], int)
    assert isinstance(payload["workspace_count"], int)
    assert payload["user_count"] >= 1


def test_instance_id_is_derived_not_random():
    """Stable across restarts (so it counts one instance, not one per boot)…"""
    seed = "postgresql+asyncpg://u:p@db:5432/backplane"
    assert instance_id_for(seed) == instance_id_for(seed)


def test_instance_id_differs_between_deployments():
    assert instance_id_for("dsn-one") != instance_id_for("dsn-two")


def test_instance_id_does_not_expose_its_seed():
    """…and is a one-way hash: the DSN holds credentials."""
    seed = "postgresql+asyncpg://admin:hunter2@db.internal:5432/backplane"
    derived = instance_id_for(seed)
    for secret in ("hunter2", "admin", "db.internal", "backplane"):
        assert secret not in derived
    uuid.UUID(derived)  # well-formed, so the receiver can treat it as an id


# ── failure behavior ──


@pytest.mark.asyncio
async def test_ping_failure_is_swallowed(monkeypatch, tel_db):
    """Telemetry must never be able to break the app that hosts it."""
    monkeypatch.setattr(app_settings, "BACKPLANE_TELEMETRY_ENABLED", True)

    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    service = TelemetryService(tel_db, http_client_factory=_factory(boom))
    assert await service.send_ping() is False  # no exception escapes


@pytest.mark.asyncio
async def test_ping_posts_to_configured_endpoint(monkeypatch, tel_db):
    monkeypatch.setattr(app_settings, "BACKPLANE_TELEMETRY_ENABLED", True)
    monkeypatch.setattr(
        app_settings, "BACKPLANE_TELEMETRY_ENDPOINT", "https://ping.example/v1"
    )
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200)

    service = TelemetryService(tel_db, http_client_factory=_factory(handler))
    assert await service.send_ping() is True
    assert str(seen[0].url) == "https://ping.example/v1"
    assert seen[0].method == "POST"


@pytest.mark.asyncio
async def test_no_endpoint_configured_means_no_ping(monkeypatch, tel_db):
    monkeypatch.setattr(app_settings, "BACKPLANE_TELEMETRY_ENABLED", True)
    monkeypatch.setattr(app_settings, "BACKPLANE_TELEMETRY_ENDPOINT", "")
    calls: list[httpx.Request] = []

    service = TelemetryService(
        tel_db, http_client_factory=_factory(lambda r: (calls.append(r), httpx.Response(200))[1])
    )
    assert await service.send_ping() is False
    assert calls == []


def _factory(handler):
    def factory() -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    return factory
