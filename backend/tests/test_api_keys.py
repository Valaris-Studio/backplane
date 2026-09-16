# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.database import get_db
from app.main import create_app
from app.models.activity import Activity
from app.models.api_key import ApiKey
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole


# --- Fixtures ---


@pytest_asyncio.fixture
async def api_key_record(db_session: AsyncSession, test_user: User) -> tuple[ApiKey, str]:
    """Create an API key directly in the DB and return (record, raw_key)."""
    raw_key = "vlr_test-key-for-unit-tests-000000000000"
    key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
    api_key = ApiKey(
        user_id=test_user.id,
        name="Test Key",
        key_hash=key_hash,
        key_prefix=raw_key[:8],
    )
    db_session.add(api_key)
    await db_session.flush()
    return api_key, raw_key


@pytest_asyncio.fixture
async def auth_client(db_session: AsyncSession, test_user: User) -> AsyncClient:
    """Client that does NOT override get_current_user — tests real auth flow."""
    app = create_app()

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest_asyncio.fixture
async def touch_session_factory(_api_key_touch_uses_test_engine):
    """The test-engine session factory the API-key touch is pinned to.

    The patching itself is global (see the autouse fixture in conftest.py —
    every API-key-authenticated test needs it, not just these). This exposes the
    same factory so tests can open their own sessions against that engine.
    """
    return _api_key_touch_uses_test_engine


async def _stored_last_used_at(db_session: AsyncSession, key_id: uuid.UUID):
    """Re-read last_used_at, bypassing the identity map.

    The touch committed on a DIFFERENT session, so `db_session`'s cached
    ApiKey instance still holds the pre-touch value.
    """
    result = await db_session.execute(
        select(ApiKey.last_used_at).where(ApiKey.id == key_id)
    )
    return result.scalar_one()


# --- GET /api/me ---


@pytest.mark.anyio
async def test_get_me(client: AsyncClient, test_user: User):
    resp = await client.get("/api/me")
    assert resp.status_code == 200
    data = resp.json()
    assert data["email"] == test_user.email
    assert data["name"] == test_user.name


# --- POST /api/me/api-keys ---


@pytest.mark.anyio
async def test_create_api_key(client: AsyncClient):
    resp = await client.post("/api/me/api-keys", json={"name": "My Key"})
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "My Key"
    assert data["raw_key"].startswith("vlr_")
    assert data["key_prefix"] == data["raw_key"][:8]
    assert "id" in data
    assert "created_at" in data


@pytest.mark.anyio
async def test_create_api_key_missing_name(client: AsyncClient):
    resp = await client.post("/api/me/api-keys", json={})
    assert resp.status_code == 422


# --- GET /api/me/api-keys ---


@pytest.mark.anyio
async def test_list_api_keys_empty(client: AsyncClient):
    resp = await client.get("/api/me/api-keys")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_list_api_keys(client: AsyncClient):
    await client.post("/api/me/api-keys", json={"name": "Key 1"})
    await client.post("/api/me/api-keys", json={"name": "Key 2"})
    resp = await client.get("/api/me/api-keys")
    assert resp.status_code == 200
    keys = resp.json()
    assert len(keys) == 2
    names = {k["name"] for k in keys}
    assert names == {"Key 1", "Key 2"}
    # raw_key should NOT appear in list response
    for k in keys:
        assert "raw_key" not in k


# --- DELETE /api/me/api-keys/{key_id} ---


@pytest.mark.anyio
async def test_delete_api_key(client: AsyncClient):
    create_resp = await client.post("/api/me/api-keys", json={"name": "Doomed"})
    key_id = create_resp.json()["id"]

    resp = await client.delete(f"/api/me/api-keys/{key_id}")
    assert resp.status_code == 204

    list_resp = await client.get("/api/me/api-keys")
    assert len(list_resp.json()) == 0


@pytest.mark.anyio
async def test_delete_api_key_not_found(client: AsyncClient):
    resp = await client.delete("/api/me/api-keys/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 404


@pytest.mark.anyio
async def test_delete_api_key_wrong_user(
    client: AsyncClient, db_session: AsyncSession, second_user: User
):
    """A user cannot delete another user's key."""
    raw = "vlr_other-user-key-00000000000000000000"
    other_key = ApiKey(
        user_id=second_user.id,
        name="Other's Key",
        key_hash=hashlib.sha256(raw.encode()).hexdigest(),
        key_prefix=raw[:8],
    )
    db_session.add(other_key)
    await db_session.flush()

    resp = await client.delete(f"/api/me/api-keys/{other_key.id}")
    assert resp.status_code == 404


# --- Auth via Bearer token ---


@pytest.mark.anyio
async def test_auth_with_api_key(
    auth_client: AsyncClient,
    api_key_record: tuple[ApiKey, str],
    test_user: User,
):
    _, raw_key = api_key_record
    resp = await auth_client.get(
        "/api/me", headers={"Authorization": f"Bearer {raw_key}"}
    )
    assert resp.status_code == 200
    assert resp.json()["email"] == test_user.email


@pytest.mark.anyio
async def test_auth_with_invalid_api_key(auth_client: AsyncClient):
    resp = await auth_client.get(
        "/api/me", headers={"Authorization": "Bearer vlr_invalid-key-that-doesnt-exist"}
    )
    assert resp.status_code == 403


# --- Activity attribution via API key ---


@pytest.mark.anyio
async def test_activity_records_via_api_key(
    auth_client: AsyncClient,
    db_session: AsyncSession,
    api_key_record: tuple[ApiKey, str],
    test_user: User,
):
    """Actions via API key should tag activity records with the key name."""
    _, raw_key = api_key_record

    # Set up workspace + membership for the API key user
    workspace = Workspace(name="Test WS", slug="test-ws", created_by=test_user.id)
    db_session.add(workspace)
    await db_session.flush()
    member = WorkspaceMember(
        workspace_id=workspace.id, user_id=test_user.id, role=WorkspaceRole.owner
    )
    db_session.add(member)
    await db_session.flush()

    # Create a channel via API key auth (triggers activity recording)
    resp = await auth_client.post(
        "/api/workspaces/test-ws/channels",
        json={"name": "Slack", "channel_type": "slack", "contact_value": "#general"},
        headers={"Authorization": f"Bearer {raw_key}"},
    )
    assert resp.status_code == 201

    # Check the activity record has via_api_key set
    result = await db_session.execute(
        select(Activity).where(Activity.workspace_id == workspace.id)
    )
    activities = list(result.scalars().all())
    assert len(activities) == 1
    assert activities[0].via_api_key == "Test Key"
    assert activities[0].summary == "created channel 'Slack'"


# --- last_used_at stamping + api_key.first_used event ---


@pytest.mark.anyio
async def test_api_key_first_use_stamps_last_used_at(
    auth_client: AsyncClient,
    db_session: AsyncSession,
    api_key_record: tuple[ApiKey, str],
    touch_session_factory,
):
    api_key, raw_key = api_key_record
    assert api_key.last_used_at is None

    resp = await auth_client.get("/api/me", headers={"Authorization": f"Bearer {raw_key}"})
    assert resp.status_code == 200

    assert await _stored_last_used_at(db_session, api_key.id) is not None


@pytest.mark.anyio
async def test_api_key_first_use_publishes_event_once(
    auth_client: AsyncClient,
    db_session: AsyncSession,
    api_key_record: tuple[ApiKey, str],
    test_user: User,
    test_workspace: Workspace,
    touch_session_factory,
):
    """The never-used -> used transition fires exactly once, ever."""
    api_key, raw_key = api_key_record
    headers = {"Authorization": f"Bearer {raw_key}"}

    with patch.object(event_bus, "publish", new_callable=AsyncMock) as mock_publish:
        await auth_client.get("/api/me", headers=headers)
        first_use_calls = [
            call
            for call in mock_publish.await_args_list
            if call.kwargs.get("event_type") == "api_key.first_used"
        ]
        assert len(first_use_calls) == 1

        payload = first_use_calls[0].kwargs["payload"]
        assert payload["api_key_id"] == str(api_key.id)
        assert payload["user_id"] == str(test_user.id)
        assert payload["key_name"] == "Test Key"
        assert payload["last_used_at"]
        assert first_use_calls[0].kwargs["workspace_id"] == test_workspace.id

        mock_publish.reset_mock()
        await auth_client.get("/api/me", headers=headers)
        assert [
            call
            for call in mock_publish.await_args_list
            if call.kwargs.get("event_type") == "api_key.first_used"
        ] == []


@pytest.mark.anyio
async def test_api_key_second_use_within_throttle_does_not_rewrite(
    auth_client: AsyncClient,
    db_session: AsyncSession,
    api_key_record: tuple[ApiKey, str],
    touch_session_factory,
):
    api_key, raw_key = api_key_record
    headers = {"Authorization": f"Bearer {raw_key}"}

    await auth_client.get("/api/me", headers=headers)
    after_first = await _stored_last_used_at(db_session, api_key.id)

    await auth_client.get("/api/me", headers=headers)
    after_second = await _stored_last_used_at(db_session, api_key.id)

    assert after_second == after_first


@pytest.mark.anyio
async def test_api_key_throttled_request_opens_no_session(
    db_session: AsyncSession,
    api_key_record: tuple[ApiKey, str],
    touch_session_factory,
    monkeypatch,
):
    """Inside the throttle window the touch must not even open a session.

    The in-memory check is the whole point of the throttle: the repository's
    `older_than` guard keeps the stored VALUE correct either way, so only
    counting sessions catches a regression that spends a pooled connection
    (pool_size=3) on every authenticated request.

    Driven through the service with a session PER call rather than through
    `auth_client`, which shares one session across requests — the second
    verify_key would otherwise return the identity-mapped instance still
    holding the pre-touch NULL, and the throttle would have nothing to read.
    """
    api_key, raw_key = api_key_record
    await db_session.commit()

    from app.services.api_key import ApiKeyService

    async with touch_session_factory() as session:
        first = await ApiKeyService(session).verify_key(raw_key)
        await ApiKeyService(session).touch(first)

    import app.services.api_key as api_key_module

    opened = 0

    def counting_factory(*args, **kwargs):
        nonlocal opened
        opened += 1
        return touch_session_factory(*args, **kwargs)

    async with touch_session_factory() as session:
        second = await ApiKeyService(session).verify_key(raw_key)
        assert second.last_used_at is not None
        monkeypatch.setattr(api_key_module, "async_session", counting_factory)
        await ApiKeyService(session).touch(second)

    assert opened == 0


@pytest.mark.anyio
async def test_api_key_touch_refreshes_once_past_throttle_window(
    auth_client: AsyncClient,
    db_session: AsyncSession,
    api_key_record: tuple[ApiKey, str],
    touch_session_factory,
):
    """A stamp older than the throttle window is refreshed — without an event."""
    api_key, raw_key = api_key_record
    stale = datetime.now(timezone.utc) - timedelta(hours=6)
    api_key.last_used_at = stale
    await db_session.flush()

    with patch.object(event_bus, "publish", new_callable=AsyncMock) as mock_publish:
        resp = await auth_client.get(
            "/api/me", headers={"Authorization": f"Bearer {raw_key}"}
        )
        assert resp.status_code == 200
        assert [
            call
            for call in mock_publish.await_args_list
            if call.kwargs.get("event_type") == "api_key.first_used"
        ] == []

    refreshed = await _stored_last_used_at(db_session, api_key.id)
    # SQLite strips tzinfo on the way back out; compare naive-to-naive.
    assert refreshed.replace(tzinfo=None) > stale.replace(tzinfo=None)


@pytest.mark.anyio
async def test_api_key_stamped_even_when_request_fails_after_auth(
    auth_client: AsyncClient,
    db_session: AsyncSession,
    api_key_record: tuple[ApiKey, str],
    touch_session_factory,
):
    """The dedicated touch session survives get_db's rollback on a failed request.

    Stamping on the request-scoped session would vanish here — get_db rolls the
    whole transaction back whenever the request raises.
    """
    api_key, raw_key = api_key_record

    resp = await auth_client.get(
        f"/api/workspaces/{uuid.uuid4()}/boards",
        headers={"Authorization": f"Bearer {raw_key}"},
    )
    assert resp.status_code == 404

    assert await _stored_last_used_at(db_session, api_key.id) is not None


@pytest.mark.anyio
async def test_list_api_keys_reports_never_used_as_null(
    auth_client: AsyncClient,
    api_key_record: tuple[ApiKey, str],
    touch_session_factory,
):
    _, raw_key = api_key_record

    resp = await auth_client.get(
        "/api/me/api-keys", headers={"Authorization": f"Bearer {raw_key}"}
    )
    assert resp.status_code == 200
    keys = resp.json()
    assert len(keys) == 1
    # This very request is what stamps the key, so the response still reports
    # the pre-request state.
    assert keys[0]["last_used_at"] is None


@pytest.mark.anyio
async def test_list_api_keys_serializes_a_used_key(
    auth_client: AsyncClient,
    db_session: AsyncSession,
    api_key_record: tuple[ApiKey, str],
):
    """A stamped key surfaces its timestamp through ApiKeyRead.

    The stamp is seeded directly rather than driven through a prior request:
    `auth_client` shares ONE session across requests (production gives each its
    own), so the touch's commit on its dedicated session stays invisible to the
    identity-mapped ApiKey this session already loaded. Durability of that write
    is pinned by the _stored_last_used_at tests above; this one pins schema
    serialization.
    """
    api_key, raw_key = api_key_record
    api_key.last_used_at = datetime(2026, 8, 4, 12, 30, tzinfo=timezone.utc)
    await db_session.flush()

    resp = await auth_client.get(
        "/api/me/api-keys", headers={"Authorization": f"Bearer {raw_key}"}
    )
    assert resp.status_code == 200
    last_used = resp.json()[0]["last_used_at"]
    assert last_used is not None
    assert last_used.startswith("2026-08-04T12:30")


@pytest.mark.anyio
async def test_create_api_key_response_reports_never_used(client: AsyncClient):
    resp = await client.post("/api/me/api-keys", json={"name": "Fresh Key"})
    assert resp.status_code == 201
    assert resp.json()["last_used_at"] is None


@pytest.mark.anyio
async def test_api_key_touch_failure_never_breaks_auth(
    auth_client: AsyncClient,
    api_key_record: tuple[ApiKey, str],
    touch_session_factory,
):
    _, raw_key = api_key_record
    import app.services.api_key as api_key_module

    with patch.object(
        api_key_module.ApiKeyService,
        "_apply_touch",
        side_effect=RuntimeError("db is on fire"),
    ):
        resp = await auth_client.get(
            "/api/me", headers={"Authorization": f"Bearer {raw_key}"}
        )
    assert resp.status_code == 200

