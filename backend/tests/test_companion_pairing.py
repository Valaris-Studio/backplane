# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, update

from app.config import settings
from app.database import get_db
from app.main import create_app
from app.models.activity import Activity
from app.models.companion import CompanionInstallation
from app.models.companion_pairing import CompanionPairing
from tests.test_agent_sessions import as_user

START = "/api/companion/pairing"
TOKEN = "/api/companion/pairing/token"
ME = "/api/me/companion/pairing"
USER_CODE_PATTERN = re.compile(r"^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$")


@pytest.fixture
async def device(db_session):
    """No user identity at all: the unauthenticated device side."""
    app = create_app()

    async def database():
        yield db_session

    app.dependency_overrides[get_db] = database
    async with AsyncClient(
        transport=ASGITransport(app), base_url="http://test"
    ) as client:
        yield client


async def start(device, **values):
    body = {
        "platform": "darwin",
        "arch": "arm64",
        "companion_version": "0.9.0",
        **values,
    }
    response = await device.post(START, json=body)
    assert response.status_code == 200, response.text
    return response.json()


async def poll(device, device_code):
    return await device.post(TOKEN, json={"device_code": device_code})


async def lookup(client, user_code):
    return await client.post(f"{ME}/lookup", json={"user_code": user_code})


async def decide(client, user_code, decision):
    return await client.post(f"{ME}/{decision}", json={"user_code": user_code})


async def rewind_last_poll(db_session, seconds=60):
    """Let the next poll through as if the device had waited `interval`."""
    await db_session.execute(
        update(CompanionPairing).values(
            last_polled_at=datetime.now(timezone.utc) - timedelta(seconds=seconds)
        )
    )
    await db_session.flush()


async def expire_all(db_session):
    await db_session.execute(
        update(CompanionPairing).values(
            expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)
        )
    )
    await db_session.flush()


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


async def test_start_pairing_returns_rfc8628_codes_and_stores_only_hashes(
    device, db_session
):
    started = await start(device, name="Work laptop")
    assert USER_CODE_PATTERN.match(started["user_code"])
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", started["device_code"])
    assert started["interval"] == 5
    assert started["expires_in"] == 600
    origin = settings.FRONTEND_URL.rstrip("/")
    assert started["verification_uri"] == f"{origin}/companion/pair"
    assert (
        started["verification_uri_complete"]
        == f"{origin}/companion/pair#code={started['user_code']}"
    )

    stored = (await db_session.scalars(select(CompanionPairing))).one()
    assert stored.state == "pending"
    assert stored.device_code_hash == sha256(started["device_code"])
    assert stored.user_code_hash == sha256(started["user_code"].replace("-", ""))
    row_text = repr(
        {column.name: getattr(stored, column.key) for column in stored.__mapper__.columns}
    )
    assert started["device_code"] not in row_text
    assert started["user_code"].replace("-", "") not in row_text


async def test_start_pairing_rejects_unknown_fields(device):
    response = await device.post(
        START,
        json={"platform": "darwin", "arch": "arm64", "companion_version": "1", "x": 1},
    )
    assert response.status_code == 422


async def test_start_pairing_is_rate_limited_per_ip(device):
    for _ in range(10):
        await start(device)
    refused = await device.post(
        START, json={"platform": "darwin", "arch": "arm64", "companion_version": "1"}
    )
    assert refused.status_code == 429
    assert refused.json()["error_code"] == "rate_limited"


async def test_poll_pending_returns_authorization_pending(device):
    started = await start(device)
    response = await poll(device, started["device_code"])
    assert response.status_code == 400
    assert response.json()["error_code"] == "authorization_pending"


async def test_poll_faster_than_interval_returns_slow_down(device, db_session):
    started = await start(device)
    assert (await poll(device, started["device_code"])).json()[
        "error_code"
    ] == "authorization_pending"
    too_fast = await poll(device, started["device_code"])
    assert too_fast.status_code == 400
    assert too_fast.json()["error_code"] == "slow_down"
    await rewind_last_poll(db_session)
    assert (await poll(device, started["device_code"])).json()[
        "error_code"
    ] == "authorization_pending"


async def test_approve_then_poll_delivers_the_device_token_exactly_once(
    client, device, db_session, test_user
):
    started = await start(device)
    approved = await decide(client, started['user_code'], "approve")
    assert approved.status_code == 200, approved.text
    assert approved.json()["state"] == "approved"

    granted = await poll(device, started["device_code"])
    assert granted.status_code == 200, granted.text
    body = granted.json()
    assert body["device_token"].startswith("bpc_")
    assert granted.headers["cache-control"] == "no-store"

    installation = await db_session.get(
        CompanionInstallation, uuid.UUID(body["installation_id"]), populate_existing=True
    )
    assert installation.owner_id == test_user.id
    assert installation.name == f"darwin-arm64-{body['installation_id'][:8]}"
    assert installation.platform == "darwin/arm64"
    assert installation.token_hash == sha256(body["device_token"])

    policy = await device.get(
        "/api/companion/policy",
        headers={"Authorization": "Bearer " + body["device_token"]},
    )
    assert policy.status_code == 200

    await rewind_last_poll(db_session)
    replay = await poll(device, started["device_code"])
    assert replay.status_code == 400
    assert replay.json()["error_code"] == "expired_token"
    assert "device_token" not in replay.text


async def test_approve_uses_the_requested_device_name(client, device, db_session):
    started = await start(device, name="Studio Mac")
    await decide(client, started['user_code'], "approve")
    body = (await poll(device, started["device_code"])).json()
    installation = await db_session.get(
        CompanionInstallation, uuid.UUID(body["installation_id"])
    )
    assert installation.name == "Studio Mac"


async def test_poll_expired_code_returns_expired_token(device, db_session):
    started = await start(device)
    await expire_all(db_session)
    response = await poll(device, started["device_code"])
    assert response.status_code == 400
    assert response.json()["error_code"] == "expired_token"
    stored = (await db_session.scalars(select(CompanionPairing))).one()
    await db_session.refresh(stored)
    assert stored.state == "expired"


async def test_approved_pairing_that_expires_uncollected_leaves_no_installation(
    client, device, db_session
):
    started = await start(device)
    await decide(client, started["user_code"], "approve")
    await expire_all(db_session)
    response = await poll(device, started["device_code"])
    assert response.json()["error_code"] == "expired_token"
    assert (await db_session.scalars(select(CompanionInstallation))).all() == []


async def test_approval_alone_creates_no_installation(client, device, db_session, test_user):
    started = await start(device)
    await decide(client, started["user_code"], "approve")
    assert (await db_session.scalars(select(CompanionInstallation))).all() == []
    stored = (await db_session.scalars(select(CompanionPairing))).one()
    await db_session.refresh(stored)
    assert (stored.state, stored.approved_by) == ("approved", test_user.id)
    assert stored.approved_at is not None and stored.installation_id is None


async def test_poll_unknown_device_code_returns_expired_token(device):
    response = await poll(device, "x" * 43)
    assert response.status_code == 400
    assert response.json()["error_code"] == "expired_token"


async def test_deny_then_poll_returns_access_denied(client, device, db_session):
    started = await start(device)
    denied = await decide(client, started['user_code'], "deny")
    assert denied.status_code == 200
    assert denied.json()["state"] == "denied"
    response = await poll(device, started["device_code"])
    assert response.status_code == 400
    assert response.json()["error_code"] == "access_denied"
    assert (await db_session.scalars(select(CompanionInstallation))).all() == []


async def test_approve_after_deny_conflicts(client, device):
    started = await start(device)
    await decide(client, started['user_code'], "deny")
    response = await decide(client, started['user_code'], "approve")
    assert response.status_code == 409
    assert response.json()["error_code"] == "pairing_denied"


async def test_approve_expired_code_conflicts(client, device, db_session):
    started = await start(device)
    await expire_all(db_session)
    shown = await lookup(client, started['user_code'])
    assert shown.json()["state"] == "expired"
    response = await decide(client, started['user_code'], "approve")
    assert response.status_code == 409
    assert response.json()["error_code"] == "pairing_expired"


async def test_lookup_shows_the_request_for_the_approval_page(client, device):
    started = await start(device, name="Work laptop")
    # Codes are read back from people: case, dash and spaces do not matter.
    typed = started["user_code"].replace("-", " ").lower()
    response = await lookup(client, typed)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "Work laptop"
    assert (body["platform"], body["arch"]) == ("darwin", "arm64")
    assert body["state"] == "pending"
    assert body["requested_at"] and body["expires_at"]
    assert "device_code" not in response.text


async def test_double_approve_by_the_same_user_is_idempotent(
    client, device, db_session
):
    started = await start(device)
    first = await decide(client, started['user_code'], "approve")
    second = await decide(client, started['user_code'], "approve")
    assert first.status_code == second.status_code == 200
    assert (await poll(device, started["device_code"])).status_code == 200
    assert len((await db_session.scalars(select(CompanionInstallation))).all()) == 1


async def test_another_user_cannot_read_or_approve_an_approved_pairing(
    client, device, db_session, second_user
):
    started = await start(device)
    assert (await decide(client, started['user_code'], "approve")).status_code == 200
    async with as_user(db_session, second_user) as other:
        assert (await lookup(other, started['user_code'])).status_code == 404
        assert (
            await decide(other, started['user_code'], "approve")
        ).status_code == 404
        assert (await decide(other, started['user_code'], "deny")).status_code == 404
    assert (await poll(device, started["device_code"])).status_code == 200
    installation = (await db_session.scalars(select(CompanionInstallation))).one()
    assert installation.owner_id != second_user.id


async def test_unknown_code_is_indistinguishable_from_someone_elses(
    client, device, db_session, second_user
):
    started = await start(device)
    await decide(client, started['user_code'], "approve")
    async with as_user(db_session, second_user) as other:
        taken = await lookup(other, started['user_code'])
        unknown = await lookup(other, "BCDF-GHJK")
        malformed = await lookup(other, "not-a-code!")
    assert taken.status_code == unknown.status_code == malformed.status_code == 404
    assert taken.content == unknown.content == malformed.content


async def test_user_code_guessing_is_capped_per_user(client, device, second_user, db_session):
    started = await start(device)
    for guess in range(5):
        response = await lookup(client, f"BCDF-GHJ{'KLMNP'[guess]}")
        assert response.status_code == 404
    capped = await lookup(client, started['user_code'])
    assert capped.status_code == 429
    assert capped.json()["error_code"] == "rate_limited"
    assert (
        await decide(client, started['user_code'], "approve")
    ).status_code == 429
    # The cap is per user, not global.
    async with as_user(db_session, second_user) as other:
        assert (await lookup(other, started['user_code'])).status_code == 200


async def test_agent_keys_cannot_read_approve_or_deny(agent_client, device, db_session):
    started = await start(device)
    for action in ["lookup", "approve", "deny"]:
        response = await decide(agent_client, started["user_code"], action)
        assert response.status_code == 403, action
    assert (await db_session.scalars(select(CompanionInstallation))).all() == []
    stored = (await db_session.scalars(select(CompanionPairing))).one()
    assert stored.state == "pending"


async def test_pairing_installation_key_refused(
    installation_key_client, device, db_session
):
    started = await start(device)
    for action in ["lookup", "approve", "deny"]:
        response = await decide(installation_key_client, started["user_code"], action)
        assert response.status_code == 403, action
    stored = (await db_session.scalars(select(CompanionPairing))).one()
    assert stored.state == "pending"


async def test_pairing_lookup_plain_user_key_allowed(plain_key_client, device):
    started = await start(device)
    response = await lookup(plain_key_client, started["user_code"])
    assert response.status_code == 200, response.text


async def test_pairing_lookup_service_refuses_installation_key(device, db_session, test_user):
    """The router refuses agent callers too; the service must hold on its own."""
    from app.core.auth import current_api_key_installation_id
    from app.exceptions import ForbiddenError
    from app.services.companion_pairing import CompanionPairingService

    started = await start(device)
    token = current_api_key_installation_id.set(uuid.uuid4())
    try:
        with pytest.raises(ForbiddenError):
            await CompanionPairingService(db_session).lookup(test_user.id, started["user_code"])
    finally:
        current_api_key_installation_id.reset(token)
    found = await CompanionPairingService(db_session).lookup(test_user.id, started["user_code"])
    assert found is not None


async def test_pairing_writes_no_workspace_activity(
    client, device, db_session, test_workspace
):
    started = await start(device)
    await decide(client, started["user_code"], "approve")
    await poll(device, started["device_code"])
    assert (await db_session.scalars(select(Activity))).all() == []


async def test_user_codes_never_appear_in_request_paths(client, device):
    started = await start(device)
    for response in [
        await lookup(client, started["user_code"]),
        await decide(client, started["user_code"], "approve"),
    ]:
        assert response.status_code == 200
        path = response.request.url.path
        assert started["user_code"] not in path
        assert started["user_code"].replace("-", "") not in path


async def test_pairing_secrets_never_reach_the_logs(
    client, device, db_session, caplog
):
    caplog.set_level(logging.DEBUG)
    started = await start(device)
    await poll(device, started["device_code"])
    await lookup(client, started['user_code'])
    await decide(client, started['user_code'], "approve")
    await rewind_last_poll(db_session)
    granted = (await poll(device, started["device_code"])).json()
    await rewind_last_poll(db_session)
    await poll(device, started["device_code"])
    await lookup(client, "BCDF-GHJK")
    # The test client's own request lines are not the server's logs (the
    # user_code is part of the approval URL by contract).
    server_logs = "\n".join(
        record.getMessage() for record in caplog.records if record.name != "httpx"
    )
    assert "companion_pairings" in server_logs  # the capture itself works
    for secret in [
        granted["device_token"],
        started["device_code"],
        started["user_code"],
        started["user_code"].replace("-", ""),
    ]:
        assert secret not in server_logs


async def test_polling_is_rate_limited_per_ip_even_for_unknown_codes(device):
    for _ in range(60):
        assert (await poll(device, "unknown")).status_code == 400
    refused = await poll(device, "unknown")
    assert refused.status_code == 429


async def test_start_limit_ignores_user_identity_headers(device):
    """A claimed identity must not buy a larger pairing budget."""
    for index in range(10):
        response = await device.post(
            START,
            json={"platform": "linux", "arch": "amd64", "companion_version": "1"},
            headers={"X-User-Email": f"user{index}@example.com"},
        )
        assert response.status_code == 200
    refused = await device.post(
        START,
        json={"platform": "linux", "arch": "amd64", "companion_version": "1"},
        headers={"X-User-Email": "fresh@example.com"},
    )
    assert refused.status_code == 429


async def test_approve_race_loser_gets_not_found_and_mints_nothing(
    device, db_session, test_user, second_user
):
    """The loser passes _visible while the row is pending; the winner's claim
    lands just before the loser's claim_pending."""
    from app.services.companion_pairing import (
        CompanionPairingService,
        PairingCodeNotFound,
    )

    started = await start(device)
    loser = CompanionPairingService(db_session)
    claim_pending = loser.repo.claim_pending

    async def winner_claims_first(pairing_id, decision, decided_by, *args, **kwargs):
        assert await claim_pending(pairing_id, "approved", test_user.id, *args, **kwargs)
        return await claim_pending(pairing_id, decision, decided_by, *args, **kwargs)

    loser.repo.claim_pending = winner_claims_first
    with pytest.raises(PairingCodeNotFound):
        await loser.approve(second_user.id, started["user_code"])

    stored = (await db_session.scalars(select(CompanionPairing))).one()
    await db_session.refresh(stored)
    assert (stored.state, stored.approved_by) == ("approved", test_user.id)
    assert (await db_session.scalars(select(CompanionInstallation))).all() == []

    granted = (await poll(device, started["device_code"])).json()
    installations = (await db_session.scalars(select(CompanionInstallation))).all()
    assert [i.owner_id for i in installations] == [test_user.id]
    assert str(installations[0].id) == granted["installation_id"]


async def test_approve_race_loser_response_matches_an_unknown_code(
    device, db_session, test_user, second_user
):
    from app.repositories.companion_pairing import CompanionPairingRepository

    started = await start(device)
    original = CompanionPairingRepository.claim_pending
    raced = False

    async def winner_claims_first(self, pairing_id, decision, decided_by, *args, **kwargs):
        nonlocal raced
        if not raced:
            raced = True
            await original(self, pairing_id, "approved", test_user.id, *args, **kwargs)
        return await original(self, pairing_id, decision, decided_by, *args, **kwargs)

    CompanionPairingRepository.claim_pending = winner_claims_first
    try:
        async with as_user(db_session, second_user) as other:
            lost = await decide(other, started["user_code"], "approve")
    finally:
        CompanionPairingRepository.claim_pending = original
    async with as_user(db_session, second_user) as other:
        unknown = await decide(other, "BCDF-GHJK", "approve")
    assert lost.status_code == unknown.status_code == 404
    assert lost.content == unknown.content


async def test_concurrent_approvals_create_one_installation_for_one_owner(
    db_engine, device, db_session, test_user, second_user
):
    import asyncio

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from app.services.companion_pairing import (
        CompanionPairingService,
        PairingCodeNotFound,
    )

    started = await start(device)
    await db_session.commit()
    sessions = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)

    async def approve_as(user):
        async with sessions() as session:
            try:
                await CompanionPairingService(session).approve(user.id, started["user_code"])
                await session.commit()
                return user.id
            except PairingCodeNotFound:
                await session.commit()
                return None

    winners = [
        winner
        for winner in await asyncio.gather(approve_as(test_user), approve_as(second_user))
        if winner is not None
    ]
    assert len(winners) == 1
    granted = (await poll(device, started["device_code"])).json()
    installations = (await db_session.scalars(select(CompanionInstallation))).all()
    assert [i.owner_id for i in installations] == winners
    assert str(installations[0].id) == granted["installation_id"]
