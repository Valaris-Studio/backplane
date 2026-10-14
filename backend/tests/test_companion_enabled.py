# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""COMPANION_ENABLED: off, every companion, pairing and captured-session
surface answers like it never existed, and the retention loop leaves companion
data alone. On, expired pairing requests are swept by the retention loop."""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings, settings
from app.database import get_db
from app.main import create_app
from app.models.companion_pairing import CompanionPairing
from app.services.session_retention import PAIRING_SWEEP_GRACE, SessionRetentionService

NEVER_EXISTED = "/api/no-such-route"
PAIRING_START = {"platform": "darwin", "arch": "arm64", "companion_version": "0.9.0"}


@pytest.fixture
def companion_off(monkeypatch):
    monkeypatch.setattr(settings, "COMPANION_ENABLED", False)


@pytest.fixture
async def anonymous(db_session):
    """No identity at all: what the public internet sees."""
    app = create_app()

    async def database():
        yield db_session

    app.dependency_overrides[get_db] = database
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        yield client


def test_companion_enabled_defaults_off():
    assert Settings.model_fields["COMPANION_ENABLED"].default is False


SIGNED_IN_SURFACES = [
    ("get", "/api/me/companion/installations", None),
    ("post", "/api/me/companion/installations", {"name": "Laptop", "platform": "darwin"}),
    ("patch", "/api/me/companion/installations/{random}", {"name": "Laptop"}),
    ("post", "/api/me/companion/pairing/lookup", {"user_code": "BCDF-GHJK"}),
    ("post", "/api/me/companion/pairing/approve", {"user_code": "BCDF-GHJK"}),
    ("post", "/api/me/companion/pairing/deny", {"user_code": "BCDF-GHJK"}),
    ("get", "/api/workspaces/{slug}/sessions", None),
    ("get", "/api/workspaces/{slug}/sessions/{random}", None),
    ("get", "/api/workspaces/{slug}/sessions/summary", None),
    ("get", "/api/workspaces/{slug}/sessions/{random}/rhythm", None),
    ("get", "/api/workspaces/{slug}/boards/{board}/cards/{card}/sessions", None),
    ("get", "/api/workspaces/{slug}/notes/{note}/sessions", None),
]


@pytest.mark.parametrize(("method", "path", "body"), SIGNED_IN_SURFACES)
async def test_signed_in_companion_surface_is_not_found_when_disabled(
    companion_off, client, test_workspace, test_board, test_card, test_note, method, path, body
):
    url = path.format(
        slug=test_workspace.slug,
        board=test_board.id,
        card=test_card.id,
        note=test_note.id,
        random=uuid.uuid4(),
    )
    response = await client.request(method, url, json=body)
    assert response.status_code == 404, response.text
    assert response.json() == (await client.get(NEVER_EXISTED)).json()


DEVICE_SURFACES = [
    ("post", "/api/companion/pairing", PAIRING_START),
    ("post", "/api/companion/pairing/token", {"device_code": "x" * 43}),
    ("get", "/api/companion/policy", None),
    ("get", "/api/companion/me", None),
    ("post", "/api/companion/ingest", {"records": []}),
    ("post", "/api/companion/status", {}),
    ("post", "/api/companion/agent-key", {}),
    ("get", "/api/me/companion/installations", None),
]


@pytest.mark.parametrize(("method", "path", "body"), DEVICE_SURFACES)
async def test_unauthenticated_companion_surface_is_not_found_before_auth_when_disabled(
    companion_off, anonymous, method, path, body
):
    # 404 must win over 401/403/422: a refusal would confirm the route exists.
    response = await anonymous.request(
        method, path, json=body, headers={"Authorization": "Bearer bpc_not-a-token"}
    )
    assert response.status_code == 404, response.text
    assert response.json() == (await anonymous.get(NEVER_EXISTED)).json()


async def test_pairing_start_is_served_when_enabled(anonymous):
    assert settings.COMPANION_ENABLED is True
    response = await anonymous.post("/api/companion/pairing", json=PAIRING_START)
    assert response.status_code == 200, response.text
    assert response.json()["user_code"]


async def test_companion_enabled_does_not_hide_unrelated_routes(companion_off, client, test_workspace):
    assert (await client.get(f"/api/workspaces/{test_workspace.slug}")).status_code == 200


@pytest.mark.parametrize("enabled", [True, False])
async def test_auth_modes_reports_companion_enabled(monkeypatch, anonymous, enabled):
    monkeypatch.setattr(settings, "COMPANION_ENABLED", enabled)
    body = (await anonymous.get("/api/auth/modes")).json()
    assert body["companion_enabled"] is enabled


@pytest.mark.parametrize("enabled", [True, False])
async def test_auth_modes_reports_rich_capture_enabled(monkeypatch, anonymous, enabled):
    # The devices page offers the rich level only where this server takes it.
    monkeypatch.setattr(settings, "RICH_CAPTURE_ENABLED", enabled)
    body = (await anonymous.get("/api/auth/modes")).json()
    assert body["rich_capture_enabled"] is enabled


# --- retention loop -------------------------------------------------------------


def _pairing(expires_at: datetime, state: str = "pending") -> CompanionPairing:
    return CompanionPairing(
        device_code_hash=uuid.uuid4().hex * 2,
        user_code_hash=uuid.uuid4().hex * 2,
        platform="darwin",
        arch="arm64",
        companion_version="0.9.0",
        state=state,
        expires_at=expires_at,
    )


async def _seed_pairings(db_session) -> dict[str, uuid.UUID]:
    now = datetime.now(timezone.utc)
    pairings = {
        "live": _pairing(now + timedelta(minutes=5)),
        # Just expired: still answers "expired" to a late poll or lookup.
        "within-grace": _pairing(now - PAIRING_SWEEP_GRACE + timedelta(minutes=5)),
        "long-expired-pending": _pairing(now - PAIRING_SWEEP_GRACE - timedelta(minutes=1)),
        "long-expired-consumed": _pairing(
            now - PAIRING_SWEEP_GRACE - timedelta(days=30), state="consumed"
        ),
    }
    db_session.add_all(pairings.values())
    await db_session.commit()
    return {name: pairing.id for name, pairing in pairings.items()}


async def _surviving(factory, ids: dict[str, uuid.UUID]) -> set[str]:
    async with factory() as reader:
        kept = set(await reader.scalars(select(CompanionPairing.id)))
    return {name for name, pairing_id in ids.items() if pairing_id in kept}


async def test_retention_pass_sweeps_pairings_expired_past_the_grace(db_session, db_engine):
    ids = await _seed_pairings(db_session)
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)

    await SessionRetentionService(factory).run_purge(batch_size=1, max_batches=10)

    assert await _surviving(factory, ids) == {"live", "within-grace"}


async def test_retention_pass_sweeps_pairings_in_bounded_batches(db_session, db_engine):
    ids = await _seed_pairings(db_session)
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)

    await SessionRetentionService(factory).run_purge(batch_size=1, max_batches=1)

    assert len(await _surviving(factory, ids)) == 3


async def test_retention_pass_leaves_companion_data_alone_when_disabled(
    companion_off, db_session, db_engine
):
    ids = await _seed_pairings(db_session)
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)

    assert await SessionRetentionService(factory).run_purge() == 0

    assert await _surviving(factory, ids) == set(ids)


# --- rate limiter -----------------------------------------------------------------


async def _limiter_trace(db_session, method: str, path: str, requests: int, **kwargs):
    """(status, x-ratelimit-limit) per request, on a fresh app (and limiter)."""
    app = create_app()

    async def database():
        yield db_session

    app.dependency_overrides[get_db] = database
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        return [
            (response.status_code, response.headers.get("x-ratelimit-limit"))
            for response in [await client.request(method, path, **kwargs) for _ in range(requests)]
        ]


@pytest.mark.parametrize(
    ("path", "kwargs"),
    [
        ("/api/companion/pairing", {"json": PAIRING_START}),
        ("/api/companion/pairing/token", {"json": {"device_code": "x" * 43}}),
        ("/api/companion/agent-key", {"headers": {"Authorization": "Bearer bpc_not-a-token"}}),
    ],
)
async def test_rate_limiter_treats_companion_paths_as_unknown_when_disabled(
    companion_off, db_session, path, kwargs
):
    # A dedicated bucket would answer 429 after a few requests and so reveal
    # the route; off, these paths spend the generic budget like any 404.
    observed = await _limiter_trace(db_session, "post", path, 12, **kwargs)
    unknown = await _limiter_trace(db_session, "post", NEVER_EXISTED, 12, **kwargs)
    assert observed == unknown
    assert {status for status, _ in observed} == {404}


async def test_rate_limiter_keeps_the_pairing_start_bucket_when_enabled(db_session):
    observed = await _limiter_trace(db_session, "post", "/api/companion/pairing", 11, json=PAIRING_START)
    assert observed[:10] == [(200, "10")] * 10
    assert observed[10][0] == 429
