# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The companion mints one API key per installation for the agents it launches."""

import hashlib
import importlib.util
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine, inspect, select, update
from sqlalchemy.exc import IntegrityError

from app.core.rate_limit import (
    AGENT_KEY_MINT_LIMIT,
    API_KEY_LIMIT,
    UNAUTHENTICATED_LIMIT,
    RateLimitMiddleware,
)
from app.database import get_db
from app.main import create_app
from app.models.api_key import ApiKey
from app.models.companion import CompanionInstallation
from app.repositories.api_key import ApiKeyRepository
from tests.test_companion import ME, device, enroll

AGENT_KEY = "/api/companion/agent-key"
MIGRATION = Path(__file__).parents[1] / "alembic/versions/113_api_key_installation.py"


@pytest.fixture
async def normal_client(db_session):
    """Real auth dependencies, so device and API-key credentials are checked."""
    app = create_app()

    async def database():
        yield db_session

    app.dependency_overrides[get_db] = database
    async with AsyncClient(
        transport=ASGITransport(app), base_url="http://test"
    ) as client:
        yield client


@pytest.fixture
async def laptop(client, test_workspace):
    response = await enroll(client, name="Laptop")
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture
async def desktop(client, test_workspace):
    response = await enroll(client, name="Desktop")
    assert response.status_code == 201, response.text
    return response.json()


def bearer(raw_key):
    return {"Authorization": "Bearer " + raw_key}


def key_row(user_id, raw_key, installation_id=None):
    return ApiKey(
        user_id=user_id,
        name="Row",
        key_hash=hashlib.sha256(raw_key.encode()).hexdigest(),
        key_prefix=raw_key[:8],
        installation_id=installation_id,
    )


async def mint(normal_client, enrollment):
    response = await normal_client.post(
        AGENT_KEY, headers=device(enrollment["device_token"])
    )
    assert response.status_code == 201, response.text
    return response.json()


async def keys_of(db_session, enrollment):
    rows = await db_session.execute(
        select(ApiKey).where(
            ApiKey.installation_id == uuid.UUID(enrollment["installation_id"])
        )
    )
    return list(rows.scalars().all())


# --- minting ----------------------------------------------------------------------


async def test_create_agent_key_returns_raw_once_and_stores_hash(
    normal_client, db_session, laptop, test_user, caplog
):
    caplog.set_level(logging.DEBUG)
    created = await mint(normal_client, laptop)

    assert set(created) == {"id", "name", "key_prefix", "key", "created_at"}
    assert created["key"].startswith("vlr_")
    assert created["key_prefix"] == created["key"][:8]
    assert created["name"] == "Companion · Laptop · agents"
    (stored,) = await keys_of(db_session, laptop)
    assert str(stored.id) == created["id"]
    assert stored.user_id == test_user.id
    assert stored.key_hash == hashlib.sha256(created["key"].encode()).hexdigest()
    assert created["key"] not in caplog.text

    fetched = await normal_client.get(AGENT_KEY, headers=device(laptop["device_token"]))
    assert fetched.status_code == 200
    assert "key" not in fetched.json()
    assert created["key"] not in fetched.text


async def test_create_agent_key_names_fit_for_the_longest_installation_name(
    client, normal_client, test_workspace
):
    enrollment = (await enroll(client, name="x" * 200)).json()
    created = await mint(normal_client, enrollment)
    assert created["name"] == "Companion · " + "x" * 200 + " · agents"
    assert len(created["name"]) <= 255


async def test_create_agent_key_requires_a_live_device_token(
    normal_client, db_session, laptop, test_user
):
    raw_user_key = "vlr_agent-key-test-user-key-000000000000"
    db_session.add(
        ApiKey(
            user_id=test_user.id,
            name="Personal",
            key_hash=hashlib.sha256(raw_user_key.encode()).hexdigest(),
            key_prefix=raw_user_key[:8],
        )
    )
    await db_session.flush()
    revoked_device = device(laptop["device_token"])
    assert (
        await normal_client.delete("/api/companion/installation", headers=revoked_device)
    ).status_code == 200

    for method in ("POST", "GET", "DELETE"):
        for headers in ({}, bearer(raw_user_key), revoked_device):
            response = await normal_client.request(method, AGENT_KEY, headers=headers)
            assert response.status_code == 401, (method, headers)
            assert response.json()["error_code"] == "invalid_device_token"
    assert await keys_of(db_session, laptop) == []


async def test_create_agent_key_rotates_previous(normal_client, db_session, laptop):
    first = await mint(normal_client, laptop)
    second = await mint(normal_client, laptop)

    assert first["key"] != second["key"]
    assert [str(key.id) for key in await keys_of(db_session, laptop)] == [second["id"]]
    assert (await normal_client.get("/api/me", headers=bearer(first["key"]))).status_code == 403
    assert (await normal_client.get("/api/me", headers=bearer(second["key"]))).status_code == 200


async def test_create_agent_key_is_rate_limited_per_installation(
    normal_client, laptop, desktop
):
    for _ in range(10):
        await mint(normal_client, laptop)

    limited = await normal_client.post(AGENT_KEY, headers=device(laptop["device_token"]))
    assert limited.status_code == 429
    assert limited.json()["error_code"] == "rate_limited"
    await mint(normal_client, desktop)
    reading = await normal_client.get(AGENT_KEY, headers=device(laptop["device_token"]))
    assert reading.status_code == 200


def _mint_request(authorization):
    headers = {"authorization": authorization} if authorization else {}
    return SimpleNamespace(
        headers=headers,
        cookies={},
        client=SimpleNamespace(host="10.0.0.9"),
        method="POST",
        url=SimpleNamespace(path=AGENT_KEY),
    )


def test_agent_key_bucket_applies_to_device_tokens_only():
    limiter = RateLimitMiddleware(app=lambda scope, receive, send: None)

    key, limit = limiter._get_client_key(_mint_request("Bearer bpc_" + "a" * 43))
    assert key.startswith("agent-key:") and limit == AGENT_KEY_MINT_LIMIT

    key, limit = limiter._get_client_key(_mint_request("Bearer vlr_" + "a" * 43))
    assert key.startswith("apikey:") and limit == API_KEY_LIMIT
    key, limit = limiter._get_client_key(_mint_request(None))
    assert key.startswith("ip:") and limit == UNAUTHENTICATED_LIMIT


async def test_agent_key_bucket_is_not_spent_by_unauthenticated_posts(
    normal_client, laptop
):
    for _ in range(AGENT_KEY_MINT_LIMIT + 1):
        response = await normal_client.post(AGENT_KEY, headers=bearer("junk"))
        assert response.status_code == 401
    await mint(normal_client, laptop)


# --- rotation under concurrency ----------------------------------------------------


async def test_installation_key_unique_index_refuses_second_key(
    db_session, laptop, test_user
):
    installation_id = uuid.UUID(laptop["installation_id"])
    db_session.add(key_row(test_user.id, "vlr_unique-one-" + "0" * 26, installation_id))
    await db_session.flush()
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            db_session.add(
                key_row(test_user.id, "vlr_unique-two-" + "0" * 26, installation_id)
            )
            await db_session.flush()


async def test_user_keys_without_installation_are_not_unique_constrained(
    db_session, test_user
):
    db_session.add(key_row(test_user.id, "vlr_plain-one-" + "0" * 27))
    db_session.add(key_row(test_user.id, "vlr_plain-two-" + "0" * 27))
    await db_session.flush()
    rows = await db_session.execute(
        select(ApiKey).where(
            ApiKey.user_id == test_user.id, ApiKey.installation_id.is_(None)
        )
    )
    assert len(rows.scalars().all()) == 2


async def test_create_agent_key_rotation_conflict_returns_409(
    normal_client, db_session, laptop
):
    first = await mint(normal_client, laptop)
    # A concurrent rotation that deleted nothing before this one inserted: the
    # index, not the delete, is what stops the second live key.
    with patch.object(
        ApiKeyRepository, "delete_for_installation", AsyncMock(return_value=None)
    ):
        response = await normal_client.post(
            AGENT_KEY, headers=device(laptop["device_token"])
        )
    assert response.status_code == 409
    assert response.json()["error_code"] == "agent_key_rotation_conflict"
    assert [str(key.id) for key in await keys_of(db_session, laptop)] == [first["id"]]


async def test_create_agent_key_locks_the_installation_row(normal_client, laptop):
    with patch.object(
        ApiKeyRepository,
        "lock_installation",
        AsyncMock(return_value=None),
        create=True,
    ) as lock:
        await mint(normal_client, laptop)
    lock.assert_awaited_once_with(uuid.UUID(laptop["installation_id"]))


# --- reading and deleting ---------------------------------------------------------


async def test_get_agent_key_reports_metadata(normal_client, laptop):
    created = await mint(normal_client, laptop)
    fetched = await normal_client.get(AGENT_KEY, headers=device(laptop["device_token"]))

    assert fetched.status_code == 200
    body = fetched.json()
    assert set(body) == {"id", "name", "key_prefix", "created_at", "last_used_at"}
    assert (body["id"], body["key_prefix"]) == (created["id"], created["key_prefix"])
    assert body["last_used_at"] is None


async def test_get_agent_key_missing_after_user_delete(client, normal_client, laptop):
    created = await mint(normal_client, laptop)
    assert (await client.delete(f"/api/me/api-keys/{created['id']}")).status_code == 204

    missing = await normal_client.get(AGENT_KEY, headers=device(laptop["device_token"]))
    assert missing.status_code == 404
    assert missing.json()["error_code"] == "agent_key_missing"


async def test_get_agent_key_missing_when_never_minted(normal_client, laptop):
    missing = await normal_client.get(AGENT_KEY, headers=device(laptop["device_token"]))
    assert missing.status_code == 404
    assert missing.json()["error_code"] == "agent_key_missing"


async def test_get_agent_key_ignores_other_installations(normal_client, laptop, desktop):
    await mint(normal_client, desktop)
    missing = await normal_client.get(AGENT_KEY, headers=device(laptop["device_token"]))
    assert missing.status_code == 404


async def test_delete_agent_key_idempotent(normal_client, db_session, laptop, desktop):
    headers = device(laptop["device_token"])
    assert (await normal_client.delete(AGENT_KEY, headers=headers)).status_code == 204

    created = await mint(normal_client, laptop)
    kept = await mint(normal_client, desktop)
    for _ in range(2):
        response = await normal_client.delete(AGENT_KEY, headers=headers)
        assert response.status_code == 204
        assert response.content == b""
    assert await keys_of(db_session, laptop) == []
    assert (await normal_client.get("/api/me", headers=bearer(created["key"]))).status_code == 403
    assert [str(key.id) for key in await keys_of(db_session, desktop)] == [kept["id"]]


# --- installation revocation ------------------------------------------------------


async def test_revoke_installation_deletes_agent_keys(
    client, normal_client, db_session, laptop, desktop
):
    revoked = await mint(normal_client, laptop)
    kept = await mint(normal_client, desktop)

    response = await client.delete(f"{ME}/{laptop['installation_id']}")
    assert response.status_code == 200

    assert await keys_of(db_session, laptop) == []
    assert [str(key.id) for key in await keys_of(db_session, desktop)] == [kept["id"]]
    assert (await normal_client.get("/api/me", headers=bearer(revoked["key"]))).status_code == 403
    assert (await normal_client.get("/api/me", headers=bearer(kept["key"]))).status_code == 200


async def test_device_revoke_deletes_agent_keys(
    normal_client, db_session, laptop, desktop
):
    revoked = await mint(normal_client, laptop)
    kept = await mint(normal_client, desktop)

    response = await normal_client.delete(
        "/api/companion/installation", headers=device(laptop["device_token"])
    )
    assert response.status_code == 200

    assert await keys_of(db_session, laptop) == []
    assert [str(key.id) for key in await keys_of(db_session, desktop)] == [kept["id"]]
    assert (await normal_client.get("/api/me", headers=bearer(revoked["key"]))).status_code == 403


async def test_installation_key_rejected_when_installation_revoked(
    normal_client, db_session, laptop
):
    created = await mint(normal_client, laptop)
    # A row that somehow outlived the revoke must still be refused.
    await db_session.execute(
        update(CompanionInstallation)
        .where(CompanionInstallation.id == uuid.UUID(laptop["installation_id"]))
        .values(revoked_at=datetime.now(timezone.utc))
    )
    await db_session.flush()

    assert len(await keys_of(db_session, laptop)) == 1
    response = await normal_client.get("/api/me", headers=bearer(created["key"]))
    assert response.status_code == 403


# --- what the key can and cannot do -----------------------------------------------


async def test_installation_key_authenticates_workspace_routes(
    normal_client, laptop, test_board
):
    created = await mint(normal_client, laptop)
    response = await normal_client.get(
        "/api/workspaces/default/boards", headers=bearer(created["key"])
    )
    assert response.status_code == 200
    assert [board["id"] for board in response.json()] == [str(test_board.id)]


async def test_forbid_agent_callers_refuses_installation_key(
    normal_client, db_session, laptop, test_user
):
    created = await mint(normal_client, laptop)
    headers = bearer(created["key"])

    minted = await normal_client.post("/api/me/api-keys", json={"name": "x"}, headers=headers)
    assert minted.status_code == 403
    deleted = await normal_client.delete(f"/api/me/api-keys/{created['id']}", headers=headers)
    assert deleted.status_code == 403
    installations = await normal_client.get(ME, headers=headers)
    assert installations.status_code == 403

    raw_user_key = "vlr_agent-key-plain-user-key-00000000000"
    db_session.add(
        ApiKey(
            user_id=test_user.id,
            name="Personal",
            key_hash=hashlib.sha256(raw_user_key.encode()).hexdigest(),
            key_prefix=raw_user_key[:8],
        )
    )
    await db_session.flush()
    plain = await normal_client.post(
        "/api/me/api-keys", json={"name": "y"}, headers=bearer(raw_user_key)
    )
    assert plain.status_code == 201


async def test_list_api_keys_refused_for_installation_and_agent_keys(
    normal_client, agent_client, db_session, laptop, test_user
):
    created = await mint(normal_client, laptop)
    listed = await normal_client.get("/api/me/api-keys", headers=bearer(created["key"]))
    assert listed.status_code == 403
    assert (await agent_client.get("/api/me/api-keys")).status_code == 403

    raw_user_key = "vlr_agent-key-list-user-key-000000000000"
    db_session.add(key_row(test_user.id, raw_user_key))
    await db_session.flush()
    plain = await normal_client.get("/api/me/api-keys", headers=bearer(raw_user_key))
    assert plain.status_code == 200
    assert created["id"] in [key["id"] for key in plain.json()]


async def test_list_api_keys_exposes_installation_id(
    client, normal_client, db_session, laptop, test_user
):
    created = await mint(normal_client, laptop)
    personal = await client.post("/api/me/api-keys", json={"name": "Personal"})
    assert personal.status_code == 201
    assert personal.json()["installation_id"] is None

    listed = {key["id"]: key for key in (await client.get("/api/me/api-keys")).json()}
    assert listed[created["id"]]["installation_id"] == laptop["installation_id"]
    assert listed[personal.json()["id"]]["installation_id"] is None


# --- migration 113 ----------------------------------------------------------------


def _load_migration():
    spec = importlib.util.spec_from_file_location(MIGRATION.stem, MIGRATION)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_migration_113_adds_nullable_installation_fk_and_reverses(tmp_path):
    migration = _load_migration()
    assert (migration.revision, migration.down_revision) == ("113", "112")
    engine = create_engine("sqlite:///" + str(tmp_path / "migration.db"))
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE companion_installations (id CHAR(32) PRIMARY KEY)")
        connection.exec_driver_sql(
            "CREATE TABLE api_keys (id CHAR(32) PRIMARY KEY, name VARCHAR(255))"
        )
        connection.exec_driver_sql("INSERT INTO api_keys VALUES ('k1', 'existing')")
        migration.op = Operations(MigrationContext.configure(connection))

        migration.upgrade()
        inspector = inspect(connection)
        columns = {c["name"]: c for c in inspector.get_columns("api_keys")}
        assert columns["installation_id"]["nullable"] is True
        (foreign_key,) = inspector.get_foreign_keys("api_keys")
        assert foreign_key["referred_table"] == "companion_installations"
        assert foreign_key["constrained_columns"] == ["installation_id"]
        assert foreign_key["options"].get("ondelete") == "CASCADE"
        (index,) = [
            index
            for index in inspector.get_indexes("api_keys")
            if index["column_names"] == ["installation_id"]
        ]
        assert index["unique"]
        connection.exec_driver_sql(
            "INSERT INTO companion_installations VALUES ('i1')"
        )
        connection.exec_driver_sql(
            "INSERT INTO api_keys (id, name, installation_id) VALUES ('k2', 'a', 'i1')"
        )
        with pytest.raises(Exception, match="UNIQUE"):
            connection.exec_driver_sql(
                "INSERT INTO api_keys (id, name, installation_id) VALUES ('k3', 'b', 'i1')"
            )
        connection.exec_driver_sql("DELETE FROM api_keys WHERE id = 'k2'")
        connection.exec_driver_sql("INSERT INTO api_keys (id, name) VALUES ('k4', 'null too')")
        assert connection.exec_driver_sql(
            "SELECT name, installation_id FROM api_keys WHERE id = 'k1'"
        ).all() == [("existing", None)]

        migration.downgrade()
        inspector = inspect(connection)
        assert "installation_id" not in {
            c["name"] for c in inspector.get_columns("api_keys")
        }
        assert inspector.get_foreign_keys("api_keys") == []
        assert inspector.get_indexes("api_keys") == []


async def test_list_api_keys_installation_key_refused(installation_key_client):
    response = await installation_key_client.get("/api/me/api-keys")
    assert response.status_code == 403, response.text


async def test_list_api_keys_plain_user_key_allowed(plain_key_client):
    response = await plain_key_client.get("/api/me/api-keys")
    assert response.status_code == 200, response.text
