# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""A capture-only device token reaches the headless uplink and nothing else.

The headless worker's token sits on a machine the operator does not fully
trust, so the server enforces what the headless Companion only refrains from
doing: no agent key, no mapping or settings writes, no catalog or session
reads. An agent key that outlives the restriction (a mint racing it)
authenticates nowhere, so it cannot read or delete the owner's sessions."""

import hashlib
import importlib.util
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine, inspect, select, update

from app.config import settings
from app.core.event_bus import event_bus
from app.database import get_db
from app.core.rate_limit import UNAUTHENTICATED_LIMIT
from app.models.api_key import ApiKey
from app.exceptions import DeviceAuthenticationError, ForbiddenError
from app.models.companion import CompanionInstallation
from app.main import create_app
from app.routers import companion as companion_routes
from app.services.companion import CompanionService
from app.services.events.authority import (
    CLOSE_CREDENTIAL,
    DeliveryPrincipal,
    current_delivery_authority,
)
from tests.test_agent_sessions import FIXTURE_EVENTS, as_user, record, upload
from tests.test_companion import ME, device, enroll

MIGRATION = (
    Path(__file__).parents[1] / "alembic/versions/127_companion_token_scope.py"
)
PATH_PARAM = re.compile(r"\{[^}]+\}")
SOME_ID = "7b779090-29c6-4d37-953f-3edebda2b310"

# The headless uplink allowlist (companion/internal/uplink/uplink.go
# refuseOutsideCapture), by route template.
CAPTURE_ROUTES = {
    ("GET", "/api/companion/me"),
    ("GET", "/api/companion/policy"),
    ("POST", "/api/companion/status"),
    ("POST", "/api/companion/ingest"),
    ("GET", "/api/companion/contents/{content_id}"),
    ("PUT", "/api/companion/contents/{content_id}/chunks/{index}"),
    ("POST", "/api/companion/contents/{content_id}/finalize"),
}
DEVICE_ROUTES = sorted(
    (method, route.path)
    for route in companion_routes.device_router.routes
    for method in route.methods
)


def bearer(raw):
    return {"Authorization": "Bearer " + raw}


async def enrolled(client, **values):
    response = await enroll(client, **values)
    assert response.status_code == 201, response.text
    return response.json()


async def map_root(client, installation, workspace, root="/work/repo"):
    response = await client.post(
        f"{ME}/{installation['installation_id']}/mappings",
        json={"workspace_id": str(workspace.id), "root_path": root},
    )
    assert response.status_code == 201, response.text
    return response.json()


async def restrict(client, installation_id):
    return await client.post(f"{ME}/{installation_id}/capture-only")


def device_app(db_session):
    app = create_app()

    async def database():
        yield db_session

    app.dependency_overrides[get_db] = database
    return app


def refused_as_capture_only(response):
    return (
        response.status_code == 403
        and response.json().get("error_code") == "capture_only_token"
    )


# --- choosing the scope -----------------------------------------------------


async def test_enrollment_defaults_to_full_scope(client, test_workspace):
    enrollment = await enrolled(client)
    assert enrollment["token_scope"] == "full"
    read = await client.get(f"{ME}/{enrollment['installation_id']}")
    assert read.json()["token_scope"] == "full"


async def test_enrollment_can_mint_a_capture_only_token(client, test_workspace):
    enrollment = await enrolled(client, token_scope="capture_only")
    assert enrollment["token_scope"] == "capture_only"
    assert enrollment["device_token"].startswith("bpc_")
    listed = (await client.get(ME)).json()
    assert [item["token_scope"] for item in listed] == ["capture_only"]


@pytest.mark.parametrize("scope", ["admin", "", "CAPTURE_ONLY", None])
async def test_enrollment_refuses_an_unknown_scope(client, test_workspace, scope):
    response = await enroll(client, token_scope=scope)
    assert response.status_code == 422, response.text


async def test_enrollment_retry_with_another_scope_conflicts(
    client, db_session, test_workspace
):
    installation_id = uuid.uuid4()
    first = await enrolled(client, installation_id=installation_id)

    retried = await enroll(
        client, installation_id=installation_id, token_scope="capture_only"
    )
    assert retried.status_code == 409, retried.text
    assert retried.json()["error_code"] == "token_scope_mismatch"
    assert "device_token" not in retried.text

    same = await enroll(client, installation_id=installation_id)
    assert same.status_code == 200
    assert same.json()["device_token"] is None
    assert same.json()["token_scope"] == "full"
    read = await client.get(f"{ME}/{first['installation_id']}")
    assert read.json()["token_scope"] == "full"


async def test_rotating_a_capture_only_token_keeps_its_scope(
    client, device_client, test_workspace
):
    enrollment = await enrolled(client, token_scope="capture_only")
    rotated = await client.post(f"{ME}/{enrollment['installation_id']}/rotate")
    assert rotated.status_code == 200, rotated.text
    assert rotated.json()["token_scope"] == "capture_only"
    refused = await device_client.post(
        "/api/companion/agent-key", headers=device(rotated.json()["device_token"])
    )
    assert refused_as_capture_only(refused), refused.text


# --- the owner restricting an installation ----------------------------------


async def test_owner_restricts_a_device_and_its_agent_key_dies_with_it(
    client, device_client, db_session, test_workspace
):
    enrollment = await enrolled(client)
    token = enrollment["device_token"]
    minted = await device_client.post(
        "/api/companion/agent-key", headers=device(token)
    )
    assert minted.status_code == 201, minted.text
    agent_key = minted.json()["key"]
    assert (
        await device_client.get(
            "/api/workspaces/default/boards", headers=bearer(agent_key)
        )
    ).status_code == 200

    with patch.object(event_bus, "publish", new_callable=AsyncMock) as publish:
        restricted = await restrict(client, enrollment["installation_id"])
    assert restricted.status_code == 200, restricted.text
    assert restricted.json()["token_scope"] == "capture_only"
    assert "device_token" not in restricted.text
    [call] = [
        call
        for call in publish.await_args_list
        if call.kwargs["event_type"] == "companion_installation.updated"
    ]
    assert call.kwargs["payload"]["reason"] == "token_scope"

    assert (
        await device_client.get(
            "/api/workspaces/default/boards", headers=bearer(agent_key)
        )
    ).status_code == 403
    keys = await db_session.scalars(
        select(ApiKey).where(
            ApiKey.installation_id == uuid.UUID(enrollment["installation_id"])
        )
    )
    assert list(keys) == []
    # The same token keeps capturing, now under the narrower scope.
    assert (
        await device_client.get("/api/companion/me", headers=device(token))
    ).status_code == 200
    again = await device_client.post("/api/companion/agent-key", headers=device(token))
    assert refused_as_capture_only(again), again.text


async def test_restricting_is_idempotent_and_has_no_way_back(
    client, device_client, test_workspace
):
    enrollment = await enrolled(client)
    installation_id = enrollment["installation_id"]
    assert (await restrict(client, installation_id)).status_code == 200
    with patch.object(event_bus, "publish", new_callable=AsyncMock) as publish:
        again = await restrict(client, installation_id)
    assert again.status_code == 200, again.text
    assert again.json()["token_scope"] == "capture_only"
    assert publish.await_args_list == []

    widened = [
        await client.patch(
            f"{ME}/{installation_id}", json={"name": "x", "token_scope": "full"}
        ),
        await client.patch(f"{ME}/{installation_id}/policy", json={"token_scope": "full"}),
        await client.post(f"{ME}/{installation_id}/full"),
    ]
    assert [response.status_code for response in widened] == [422, 422, 404]
    assert (await client.get(f"{ME}/{installation_id}")).json()[
        "token_scope"
    ] == "capture_only"


async def test_only_the_owner_restricts_and_never_a_revoked_device(
    client, device_client, installation_key_client, test_workspace, second_user
):
    enrollment = await enrolled(client)
    installation_id = enrollment["installation_id"]

    by_installation_key = await installation_key_client.post(
        f"{ME}/{installation_id}/capture-only"
    )
    assert by_installation_key.status_code == 403
    by_device_token = await device_client.post(
        f"{ME}/{installation_id}/capture-only",
        headers=device(enrollment["device_token"]),
    )
    assert by_device_token.status_code == 403
    assert (await restrict(client, uuid.uuid4())).status_code == 404

    revoked = await enrolled(client)
    assert (await client.delete(f"{ME}/{revoked['installation_id']}")).status_code == 200
    refused = await restrict(client, revoked["installation_id"])
    assert refused.status_code == 409, refused.text


async def test_another_owner_cannot_restrict_my_device(
    client, db_session, test_workspace, second_user
):
    enrollment = await enrolled(client)
    async with as_user(db_session, second_user) as stranger:
        response = await stranger.post(
            f"{ME}/{enrollment['installation_id']}/capture-only"
        )
    assert response.status_code == 404
    assert (await client.get(f"{ME}/{enrollment['installation_id']}")).json()[
        "token_scope"
    ] == "full"


# --- what a capture-only token reaches --------------------------------------


def test_the_allowlist_names_only_existing_device_routes():
    assert CAPTURE_ROUTES <= set(DEVICE_ROUTES)


@pytest.mark.parametrize("method,template", DEVICE_ROUTES)
async def test_capture_only_token_reaches_exactly_the_headless_uplink(
    client, device_client, test_workspace, method, template
):
    enrollment = await enrolled(client, token_scope="capture_only")
    path = PATH_PARAM.sub(lambda match: "0" if match[0] == "{index}" else SOME_ID, template)
    response = await device_client.request(
        method,
        path,
        headers={
            **device(enrollment["device_token"]),
            "Backplane-Chunk-SHA256": "0" * 64,
        },
        json={} if method in {"POST", "PATCH"} else None,
    )
    if (method, template) in CAPTURE_ROUTES:
        assert not refused_as_capture_only(response), (method, template, response.text)
    else:
        assert refused_as_capture_only(response), (method, template, response.text)


def test_every_token_authenticated_companion_route_is_on_the_device_router():
    # Pairing is the unauthenticated grant flow that hands out a token; every
    # other route under the device prefix must go through the scope check.
    mounted = {
        (method, route.path)
        for route in create_app().routes
        if getattr(route, "path", "").startswith("/api/companion")
        and not route.path.startswith("/api/companion/pairing")
        for method in getattr(route, "methods", ())
    }
    assert mounted == set(DEVICE_ROUTES)


METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
# Never reached a handler: no such route, wrong method, or a slash redirect.
NOT_ROUTED = {307, 308, 404, 405}


async def test_no_method_or_spelling_reaches_a_handler_outside_the_uplink(
    client, db_session, test_workspace
):
    enrollment = await enrolled(client, token_scope="capture_only")
    headers = {
        **device(enrollment["device_token"]),
        "Backplane-Chunk-SHA256": "0" * 64,
    }
    templates = sorted({template for _, template in DEVICE_ROUTES})
    app = device_app(db_session)
    reached = []
    peer = 0
    for template in templates:
        path = PATH_PARAM.sub(
            lambda match: "0" if match[0] == "{index}" else SOME_ID, template
        )
        for slash in ("", "/"):
            for method in METHODS:
                uplink = (method, template) in CAPTURE_ROUTES or (
                    method == "HEAD" and ("GET", template) in CAPTURE_ROUTES
                )
                if uplink and not slash:
                    continue
                # One client address per request: a wrong path spends its
                # address's refusal budget, which is not under test here.
                peer += 1
                transport = ASGITransport(app, client=(f"10.0.{peer // 250}.{peer % 250}", 1))
                async with AsyncClient(transport=transport, base_url="http://test") as one:
                    response = await one.request(method, path + slash, headers=headers)
                if response.status_code in NOT_ROUTED or refused_as_capture_only(
                    response
                ):
                    continue
                reached.append((method, path + slash, response.status_code))
    assert reached == []


async def test_full_token_reach_is_unchanged(client, device_client, test_workspace):
    enrollment = await enrolled(client)
    headers = device(enrollment["device_token"])
    me = await device_client.get("/api/companion/me", headers=headers)
    assert me.json()["installation"]["token_scope"] == "full"
    assert (await device_client.get("/api/companion/boards", headers=headers)).status_code == 200
    assert (await device_client.get("/api/companion/sessions", headers=headers)).status_code == 200
    assert (
        await device_client.patch(
            "/api/companion/settings", json={"auto_match_repos": False}, headers=headers
        )
    ).status_code == 200
    assert (
        await device_client.post("/api/companion/agent-key", headers=headers)
    ).status_code == 201


async def test_scope_refusals_spend_the_device_budget_not_the_ip_refusal_budget(
    client, device_client, test_workspace
):
    # A valid token refused for its scope is still a verified device: its
    # refusals must not fill the per-IP budget kept for unknown tokens.
    enrollment = await enrolled(client, token_scope="capture_only")
    headers = device(enrollment["device_token"])
    for _ in range(UNAUTHENTICATED_LIMIT + 1):
        refused = await device_client.get("/api/companion/boards", headers=headers)
        assert refused_as_capture_only(refused), refused.text
    stranger = await device_client.get(
        "/api/companion/me", headers=device("bpc_" + "x" * 43)
    )
    assert stranger.status_code == 401, stranger.text
    allowed = await device_client.get("/api/companion/me", headers=headers)
    assert allowed.status_code == 200


async def test_capture_only_policy_carries_no_auto_match_catalog(
    client, device_client, test_workspace, test_board, test_git_repo, monkeypatch
):
    # A capture-only device launches no agents, so it is told no API base.
    monkeypatch.setattr(settings, "API_URL", "https://api.example.test/")
    full = await enrolled(client)
    full_policy = await device_client.get(
        "/api/companion/policy", headers=device(full["device_token"])
    )
    assert full_policy.json()["api_base_url"] == "https://api.example.test"
    enrollment = await enrolled(client, token_scope="capture_only")
    mapping = await map_root(client, enrollment, test_workspace)

    response = await device_client.get(
        "/api/companion/policy", headers=device(enrollment["device_token"])
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["installation"]["auto_match_repos"] is False
    assert body["repo_catalog"] == []
    assert body["api_base_url"] is None
    assert [item["id"] for item in body["mappings"]] == [mapping["id"]]
    assert "test-repo" not in response.text
    # The owner's stored choice is untouched; the device just cannot act on it.
    owner_view = await client.get(f"{ME}/{enrollment['installation_id']}/policy")
    assert owner_view.json()["auto_match_repos"] is True


async def test_capture_only_token_captures_end_to_end(
    client, device_client, test_workspace, test_board
):
    enrollment = await enrolled(client, token_scope="capture_only")
    token = enrollment["device_token"]
    mapping = await map_root(client, enrollment, test_workspace)

    me = await device_client.get("/api/companion/me", headers=device(token))
    assert me.status_code == 200
    assert me.json()["installation"]["id"] == enrollment["installation_id"]
    assert me.json()["installation"]["token_scope"] == "capture_only"
    status = await device_client.post(
        "/api/companion/status",
        json={"companion_version": "0.1.0", "queue": {"pending": 0, "dropped_total": 0}},
        headers=device(token),
    )
    assert status.status_code == 200, status.text
    await upload(device_client, token, [record(FIXTURE_EVENTS, mapping["id"])])
    sessions = (await client.get("/api/workspaces/default/sessions")).json()
    assert len(sessions["items"]) == 1


# --- an agent key left behind by a racing mint --------------------------------


@pytest.fixture
async def captured_session(client, device_client, test_workspace, test_board):
    enrollment = await enrolled(client)
    mapping = await map_root(client, enrollment, test_workspace)
    await upload(
        device_client,
        enrollment["device_token"],
        [record(FIXTURE_EVENTS, mapping["id"])],
    )
    [session] = (await client.get("/api/workspaces/default/sessions")).json()["items"]
    minted = await device_client.post(
        "/api/companion/agent-key", headers=device(enrollment["device_token"])
    )
    assert minted.status_code == 201, minted.text
    return enrollment, session, minted.json()["key"]


async def key_that_raced_the_restriction(db_session, test_user, enrollment):
    """A mint that checked the scope before the restriction committed inserts
    its key after the restriction deleted the others."""
    raw = "vlr_raced-capture-only-mint-0000000000000"
    key = ApiKey(
        user_id=test_user.id,
        name="Companion · raced",
        key_hash=hashlib.sha256(raw.encode()).hexdigest(),
        key_prefix=raw[:8],
        installation_id=uuid.UUID(enrollment["installation_id"]),
    )
    db_session.add(key)
    await db_session.flush()
    return key, raw


def _session_reads(session_id, test_board, test_card, test_note):
    base = f"/api/workspaces/default/sessions/{session_id}"
    return [
        ("GET", "/api/workspaces/default/sessions"),
        ("GET", "/api/workspaces/default/sessions/summary"),
        ("GET", base),
        ("GET", base + "/children"),
        ("GET", base + "/events"),
        ("GET", base + "/calls"),
        ("GET", base + "/calls/toolu_evidence_1"),
        ("GET", base + "/rhythm"),
        ("GET", base + "/usage"),
        ("GET", base + "/links"),
        (
            "GET",
            f"/api/workspaces/default/boards/{test_board.id}/cards/{test_card.id}/sessions",
        ),
        ("GET", f"/api/workspaces/default/notes/{test_note.id}/sessions"),
        ("DELETE", base),
    ]


@pytest.mark.parametrize("change", ["capture_only", "revoked"])
async def test_a_mint_that_raced_a_restriction_or_revocation_mints_nothing(
    client, db_session, test_workspace, change
):
    # The device authenticated while the installation was full; the change
    # committed before the mint took the installation's row lock.
    enrollment = await enrolled(client)
    installation_id = uuid.UUID(enrollment["installation_id"])
    installation = await db_session.get(CompanionInstallation, installation_id)
    values = (
        {"token_scope": "capture_only"}
        if change == "capture_only"
        else {"revoked_at": datetime.now(timezone.utc)}
    )
    await db_session.execute(
        update(CompanionInstallation)
        .where(CompanionInstallation.id == installation_id)
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    assert installation.token_scope == "full" and installation.revoked_at is None

    with pytest.raises((ForbiddenError, DeviceAuthenticationError)):
        await CompanionService(db_session).create_agent_key(installation)
    keys = await db_session.scalars(
        select(ApiKey).where(ApiKey.installation_id == installation_id)
    )
    assert list(keys) == []


async def test_a_key_left_on_a_capture_only_installation_authenticates_nowhere(
    client, device_client, db_session, captured_session, test_user,
    test_board, test_card, test_note,
):
    enrollment, session, _ = captured_session
    assert (await restrict(client, enrollment["installation_id"])).status_code == 200
    _, raw = await key_that_raced_the_restriction(db_session, test_user, enrollment)

    boards = await device_client.get(
        "/api/workspaces/default/boards", headers=bearer(raw)
    )
    assert boards.status_code == 403, boards.text
    for method, path in _session_reads(session["id"], test_board, test_card, test_note):
        response = await device_client.request(method, path, headers=bearer(raw))
        assert response.status_code == 403, (method, path, response.text)
    still_there = await client.get(f"/api/workspaces/default/sessions/{session['id']}")
    assert still_there.status_code == 200


async def test_an_open_socket_of_that_key_loses_its_authority(
    client, db_session, captured_session, test_user, test_workspace
):
    # Delivery re-reads authority before each event; the restriction would
    # have deleted this key, so this is the key a racing mint left behind.
    enrollment, _, _ = captured_session
    key = await db_session.scalar(
        select(ApiKey).where(
            ApiKey.installation_id == uuid.UUID(enrollment["installation_id"])
        )
    )
    principal = DeliveryPrincipal(
        workspace_id=test_workspace.id, user_id=test_user.id, api_key_id=key.id
    )
    assert (await current_delivery_authority(db_session, principal)).close_code is None

    await db_session.execute(
        update(CompanionInstallation)
        .where(CompanionInstallation.id == key.installation_id)
        .values(token_scope="capture_only")
    )
    after = await current_delivery_authority(db_session, principal)
    assert after.close_code == CLOSE_CREDENTIAL


async def test_a_personal_key_still_reads_and_deletes_sessions(
    client, device_client, db_session, captured_session, test_user,
    test_board, test_card, test_note,
):
    _, session, _ = captured_session
    raw = "vlr_capture-only-personal-key-000000000000"
    db_session.add(
        ApiKey(
            user_id=test_user.id,
            name="Personal",
            key_hash=hashlib.sha256(raw.encode()).hexdigest(),
            key_prefix=raw[:8],
        )
    )
    await db_session.flush()
    for method, path in _session_reads(session["id"], test_board, test_card, test_note):
        if method == "DELETE":
            continue
        response = await device_client.request(method, path, headers=bearer(raw))
        assert response.status_code in {200, 404}, (method, path, response.text)
        assert response.status_code == 200 or path.endswith("/calls/toolu_evidence_1")
    deleted = await device_client.delete(
        f"/api/workspaces/default/sessions/{session['id']}", headers=bearer(raw)
    )
    assert deleted.status_code == 204, deleted.text


# --- migration 127 ----------------------------------------------------------


def _load_migration():
    spec = importlib.util.spec_from_file_location(MIGRATION.stem, MIGRATION)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_migration_127_defaults_existing_devices_to_full_and_reverses(tmp_path):
    migration = _load_migration()
    assert (migration.revision, migration.down_revision) == ("127", "126")
    engine = create_engine("sqlite:///" + str(tmp_path / "migration.db"))
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE companion_installations (id CHAR(32) PRIMARY KEY, name VARCHAR(200))"
        )
        connection.exec_driver_sql(
            "INSERT INTO companion_installations VALUES ('i1', 'existing')"
        )
        migration.op = Operations(MigrationContext.configure(connection))

        migration.upgrade()
        columns = {
            column["name"]: column
            for column in inspect(connection).get_columns("companion_installations")
        }
        assert columns["token_scope"]["nullable"] is False
        assert connection.exec_driver_sql(
            "SELECT token_scope FROM companion_installations WHERE id = 'i1'"
        ).scalar_one() == "full"
        connection.exec_driver_sql(
            "INSERT INTO companion_installations (id, name, token_scope) "
            "VALUES ('i2', 'headless', 'capture_only')"
        )
        with pytest.raises(Exception, match="CHECK"):
            connection.exec_driver_sql(
                "INSERT INTO companion_installations (id, name, token_scope) "
                "VALUES ('i3', 'bad', 'admin')"
            )

        migration.downgrade()
        assert "token_scope" not in {
            column["name"]
            for column in inspect(connection).get_columns("companion_installations")
        }
        assert connection.exec_driver_sql(
            "SELECT count(*) FROM companion_installations"
        ).scalar_one() == 2
    engine.dispose()
