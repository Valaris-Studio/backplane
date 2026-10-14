# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select, update

from app.config import settings
from app.core.event_bus import event_bus
from app.database import get_db
from app.main import create_app
from app.models.companion import CompanionInstallation, CompanionProjectMapping
from app.models.git.git_repo import GitProvider, GitRepo
from app.models.kanban.board import Board
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from tests.test_agent_sessions import as_user

ME = "/api/me/companion/installations"


@pytest.fixture
async def normal_client(db_session):
    """Real auth dependencies: nothing overrides get_current_user."""
    app = create_app()

    async def database():
        yield db_session

    app.dependency_overrides[get_db] = database
    async with AsyncClient(
        transport=ASGITransport(app), base_url="http://test"
    ) as client:
        yield client


async def enroll(client, installation_id=None, **values):
    body = {
        "installation_id": str(installation_id or uuid.uuid4()),
        "name": "Synthetic laptop",
        "platform": "darwin-arm64",
        **values,
    }
    return await client.post(ME, json=body)


def device(token):
    return {"Authorization": "Bearer " + token}


@pytest.fixture
async def installation(client, test_workspace):
    response = await enroll(client)
    assert response.status_code == 201, response.text
    return response.json()


async def test_enrollment_mints_token_once_and_is_idempotent(client, db_session):
    installation_id = uuid.uuid4()
    first = await enroll(client, installation_id)
    assert first.status_code == 201
    token = first.json()["device_token"]
    assert token.startswith("bpc_") and len(token) == 47
    assert first.json()["token_prefix"] == token[:8]
    assert first.json()["installation_id"] == str(installation_id)
    assert first.headers["cache-control"] == "no-store"

    retry = await enroll(client, installation_id)
    assert retry.status_code == 200
    assert retry.json()["device_token"] is None
    assert retry.json()["token_prefix"] == token[:8]

    stored = await db_session.scalar(
        select(CompanionInstallation).where(CompanionInstallation.id == installation_id)
    )
    assert stored.token_hash != token and token not in stored.token_hash


async def test_enrollment_of_another_owners_installation_id_conflicts(
    client, db_session, second_user
):
    installation_id = uuid.uuid4()
    assert (await enroll(client, installation_id)).status_code == 201
    row = await db_session.get(CompanionInstallation, installation_id)
    row.owner_id = second_user.id
    await db_session.flush()
    response = await enroll(client, installation_id)
    assert response.status_code == 409
    assert "device_token" not in response.text


async def test_list_get_rotate_and_revoke(client, normal_client, installation):
    installation_id = installation["installation_id"]
    old_token = installation["device_token"]
    listed = (await client.get(ME)).json()
    assert [item["installation_id"] for item in listed] == [installation_id]
    assert listed[0]["policy"] == {
        "paused": False,
        "auto_match_repos": True,
        "enabled_agents": ["claude_code", "codex_cli", "codex_desktop", "pi_cli"],
        "exclude_globs": [],
        "retention_days": None,
    }

    rotated = await client.post(f"{ME}/{installation_id}/rotate")
    assert rotated.status_code == 200
    new_token = rotated.json()["device_token"]
    assert new_token != old_token
    assert (
        await normal_client.get("/api/companion/policy", headers=device(old_token))
    ).status_code == 401
    assert (
        await normal_client.get("/api/companion/policy", headers=device(new_token))
    ).status_code == 200

    revoked = await client.delete(f"{ME}/{installation_id}")
    assert revoked.status_code == 200
    assert revoked.json()["revoked_at"] is not None
    assert (
        await normal_client.get("/api/companion/policy", headers=device(new_token))
    ).status_code == 401
    assert (await client.post(f"{ME}/{installation_id}/rotate")).status_code == 409
    assert (await client.delete(f"{ME}/{installation_id}")).status_code == 200


async def test_other_owner_cannot_see_or_manage_installation(
    client, db_session, installation, second_user
):
    installation_id = installation["installation_id"]
    row = await db_session.get(CompanionInstallation, uuid.UUID(installation_id))
    row.owner_id = second_user.id
    await db_session.flush()
    assert (await client.get(ME)).json() == []
    for method, path in [
        ("GET", ""),
        ("POST", "/rotate"),
        ("DELETE", ""),
        ("GET", "/policy"),
        ("GET", "/mappings"),
    ]:
        response = await client.request(method, f"{ME}/{installation_id}{path}")
        assert response.status_code == 404, (method, path)


async def test_policy_get_and_patch(client, installation):
    path = f"{ME}/{installation['installation_id']}/policy"
    patched = await client.patch(
        path,
        json={
            "paused": True,
            "enabled_agents": ["claude_code", "brand_new_agent"],
            "exclude_globs": ["/secret/**"],
        },
    )
    assert patched.status_code == 200, patched.text
    assert patched.json() == {
        "paused": True,
        "auto_match_repos": True,
        "enabled_agents": ["claude_code", "brand_new_agent"],
        "exclude_globs": ["/secret/**"],
        "retention_days": None,
    }
    assert (await client.get(path)).json() == patched.json()
    invalid = await client.patch(path, json={"enabled_agents": ["Not A Harness"]})
    assert invalid.status_code == 422
    assert (await client.patch(path, json={"enabled_agents": None})).status_code == 422
    disabled = await client.patch(path, json={"enabled_agents": []})
    assert disabled.json()["enabled_agents"] == []


async def test_agent_keys_cannot_manage_installations(agent_client, test_workspace):
    assert (await enroll(agent_client)).status_code == 403
    assert (await agent_client.get(ME)).status_code == 403


async def test_manage_installations_installation_key_refused(
    installation_key_client, test_workspace
):
    assert (await installation_key_client.get(ME)).status_code == 403


async def test_manage_installations_plain_user_key_allowed(
    plain_key_client, test_workspace
):
    assert (await plain_key_client.get(ME)).status_code == 200


async def test_list_installations_service_refuses_installation_key(db_session, test_user):
    """The router refuses agent callers too; the service must hold on its own."""
    from app.core.auth import current_api_key_installation_id
    from app.exceptions import ForbiddenError
    from app.services.companion import CompanionService

    token = current_api_key_installation_id.set(uuid.uuid4())
    try:
        with pytest.raises(ForbiddenError):
            await CompanionService(db_session).list_installations(test_user.id)
    finally:
        current_api_key_installation_id.reset(token)
    assert await CompanionService(db_session).list_installations(test_user.id) == []


async def test_mapping_crud_requires_membership_and_board_in_workspace(
    client, db_session, installation, test_workspace, test_board, second_user
):
    path = f"{ME}/{installation['installation_id']}/mappings"
    body = {
        "workspace_id": str(test_workspace.id),
        "board_id": str(test_board.id),
        "root_path": "/home/synthetic/project/",
        "repo_url": "git@github.com:Synthetic/Project.git",
        "content_level": "standard",
    }
    created = await client.post(path, json=body)
    assert created.status_code == 201, created.text
    mapping = created.json()
    assert mapping["root_path"] == "/home/synthetic/project"
    assert mapping["repo_url_normalized"] == "github.com/synthetic/project"
    assert mapping["origin"] == "explicit"
    assert mapping["content_level"] == "standard"
    assert (await client.post(path, json=body)).status_code == 200
    moved = {**body, "board_id": None}
    assert (await client.post(path, json=moved)).status_code == 409

    foreign = Workspace(name="Foreign", slug="foreign", created_by=second_user.id)
    db_session.add(foreign)
    await db_session.flush()
    foreign_board = Board(
        workspace_id=foreign.id, name="Hidden", slug="hidden", created_by=second_user.id
    )
    db_session.add(foreign_board)
    await db_session.flush()
    not_member = await client.post(
        path,
        json={"workspace_id": str(foreign.id), "root_path": "/home/synthetic/other"},
    )
    assert not_member.status_code == 404
    wrong_board = await client.post(
        path,
        json={
            "workspace_id": str(test_workspace.id),
            "board_id": str(foreign_board.id),
            "root_path": "/home/synthetic/other",
        },
    )
    assert wrong_board.status_code == 404
    assert (
        await client.post(
            path,
            json={"workspace_id": str(test_workspace.id), "root_path": "relative/path"},
        )
    ).status_code == 422

    updated = await client.patch(
        f"{path}/{mapping['id']}",
        json={"content_level": "metadata", "enabled": False, "board_id": None},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["content_level"] == "metadata"
    assert updated.json()["enabled"] is False
    assert updated.json()["board_id"] is None
    assert [item["id"] for item in (await client.get(path)).json()] == [mapping["id"]]
    assert (await client.delete(f"{path}/{mapping['id']}")).status_code == 204
    assert (await client.get(path)).json() == []


async def test_device_token_only_authenticates_device_endpoints(
    normal_client, installation, test_workspace
):
    token = installation["device_token"]
    assert (
        await normal_client.get("/api/companion/policy", headers=device(token))
    ).status_code == 200
    for path in ["/api/me", "/api/workspaces/default/boards", ME]:
        response = await normal_client.get(path, headers=device(token))
        assert response.status_code == 403, path
    for scheme in ["bearer", "BEARER"]:
        response = await normal_client.get(
            "/api/me", headers={"Authorization": f"{scheme} {token}"}
        )
        assert response.status_code == 403


@pytest.mark.parametrize("query", [False, True])
async def test_device_token_cannot_authenticate_websocket(
    db_session, installation, monkeypatch, query
):
    from contextlib import asynccontextmanager
    from types import SimpleNamespace

    from app.routers import events

    @asynccontextmanager
    async def session():
        yield db_session

    monkeypatch.setattr(events, "async_session", session)
    token = installation["device_token"]
    ws = SimpleNamespace(
        headers={} if query else {"authorization": "Bearer " + token},
        query_params={"token": token} if query else {},
        cookies={},
    )
    assert await events._authenticate_ws(ws) == (None, None)


@pytest.mark.parametrize(
    "authorization",
    [
        None,
        "Bearer bpc_" + "x" * 43,
        "Bearer vlr_not-a-device-token",
        "Basic bpc_" + "x" * 43,
    ],
)
async def test_device_endpoints_reject_missing_or_unknown_tokens(
    normal_client, authorization
):
    headers = {"Authorization": authorization} if authorization else {}
    for method, path in [
        ("GET", "/api/companion/policy"),
        ("POST", "/api/companion/mappings"),
        ("POST", "/api/companion/ingest"),
        ("DELETE", "/api/companion/installation"),
    ]:
        response = await normal_client.request(
            method, path, headers=headers, json={} if method == "POST" else None
        )
        assert response.status_code == 401, (method, path)


async def test_device_policy_lists_mappings_and_member_repo_catalog(
    client,
    normal_client,
    db_session,
    installation,
    test_workspace,
    test_board,
    test_git_repo,
    test_user,
    second_user,
):
    foreign = Workspace(name="Foreign", slug="foreign", created_by=second_user.id)
    db_session.add(foreign)
    await db_session.flush()
    foreign_board = Board(
        workspace_id=foreign.id, name="Hidden", slug="hidden", created_by=second_user.id
    )
    db_session.add(foreign_board)
    await db_session.flush()
    db_session.add(
        GitRepo(
            board_id=foreign_board.id,
            workspace_id=foreign.id,
            name="Hidden repo",
            slug="hidden-repo",
            url="https://github.com/valaris/hidden",
            provider=GitProvider.github,
            added_by=second_user.id,
        )
    )
    await db_session.flush()
    await client.post(
        f"{ME}/{installation['installation_id']}/mappings",
        json={"workspace_id": str(test_workspace.id), "root_path": "/work/repo"},
    )

    response = await normal_client.get(
        "/api/companion/policy", headers=device(installation["device_token"])
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["installation"]["id"] == installation["installation_id"]
    assert body["installation"]["paused"] is False
    assert [mapping["root_path"] for mapping in body["mappings"]] == ["/work/repo"]
    assert body["repo_catalog"] == [
        {
            "workspace_slug": "default",
            "workspace_id": str(test_workspace.id),
            "workspace_name": "Default",
            "board_id": str(test_board.id),
            "board_name": "Test Board",
            "repo_url_normalized": "github.com/valaris/test-repo",
        }
    ]
    assert "hidden" not in response.text


async def test_device_auto_mapping_matches_accessible_repo_idempotently(
    client,
    normal_client,
    db_session,
    installation,
    test_workspace,
    test_board,
    test_git_repo,
):
    headers = device(installation["device_token"])
    body = {"repo_url": "git@github.com:valaris/test-repo.git"}
    created = await normal_client.post(
        "/api/companion/mappings", json=body, headers=headers
    )
    assert created.status_code == 201, created.text
    assert created.json()["origin"] == "auto_repo"
    assert created.json()["workspace_id"] == str(test_workspace.id)
    assert created.json()["board_id"] == str(test_board.id)
    again = await normal_client.post(
        "/api/companion/mappings", json=body, headers=headers
    )
    assert again.status_code == 200
    assert again.json()["id"] == created.json()["id"]

    unknown = await normal_client.post(
        "/api/companion/mappings",
        json={"repo_url": "https://github.com/x/unknown"},
        headers=headers,
    )
    assert unknown.status_code == 404

    await client.patch(
        f"{ME}/{installation['installation_id']}/policy",
        json={"auto_match_repos": False},
    )
    disabled = await normal_client.post(
        "/api/companion/mappings",
        json={"repo_url": body["repo_url"]},
        headers=headers,
    )
    assert disabled.status_code == 403


async def test_device_auto_mapping_never_discloses_inaccessible_boards(
    normal_client, db_session, installation, test_workspace, test_git_repo, test_user
):
    await db_session.execute(
        delete(WorkspaceMember).where(WorkspaceMember.user_id == test_user.id)
    )
    await db_session.flush()
    response = await normal_client.post(
        "/api/companion/mappings",
        json={"repo_url": "https://github.com/valaris/test-repo"},
        headers=device(installation["device_token"]),
    )
    assert response.status_code == 404
    assert str(test_workspace.id) not in response.text


async def test_viewer_membership_is_enough_to_map(
    client, db_session, installation, test_workspace, test_user
):
    member = await db_session.scalar(
        select(WorkspaceMember).where(WorkspaceMember.user_id == test_user.id)
    )
    member.role = WorkspaceRole.viewer
    await db_session.flush()
    response = await client.post(
        f"{ME}/{installation['installation_id']}/mappings",
        json={"workspace_id": str(test_workspace.id), "root_path": "/viewer"},
    )
    assert response.status_code == 201


async def test_device_can_revoke_its_own_installation(
    client, normal_client, installation
):
    headers = device(installation["device_token"])
    revoked = await normal_client.delete("/api/companion/installation", headers=headers)
    assert revoked.status_code == 200
    assert revoked.json()["installation_id"] == installation["installation_id"]
    assert revoked.json()["revoked_at"] is not None
    for method, path in [
        ("GET", "/api/companion/policy"),
        ("DELETE", "/api/companion/installation"),
    ]:
        response = await normal_client.request(method, path, headers=headers)
        assert response.status_code == 401
    listed = (await client.get(ME)).json()
    assert listed[0]["revoked_at"] is not None


async def test_device_auto_mapping_is_rootless_and_one_per_repository(
    normal_client, installation, test_workspace, test_git_repo
):
    headers = device(installation["device_token"])
    first = await normal_client.post(
        "/api/companion/mappings",
        json={"repo_url": "git@GitHub.com:Valaris/Test-Repo.git"},
        headers=headers,
    )
    assert first.status_code == 201, first.text
    assert first.json()["root_path"] is None
    assert first.json()["repo_url_normalized"] == "github.com/valaris/test-repo"
    # A second clone of the same repository shares the mapping.
    second = await normal_client.post(
        "/api/companion/mappings",
        json={"repo_url": "github.com/valaris/test-repo"},
        headers=headers,
    )
    assert second.status_code == 200
    assert second.json()["id"] == first.json()["id"]
    for local in ["/home/synthetic/repo", "file:///home/synthetic/repo"]:
        response = await normal_client.post(
            "/api/companion/mappings", json={"repo_url": local}, headers=headers
        )
        assert response.status_code in (404, 422)


async def test_device_auto_mapping_refuses_a_local_root(
    normal_client, installation, test_git_repo
):
    response = await normal_client.post(
        "/api/companion/mappings",
        json={
            "root_path": "/home/synthetic/test-repo",
            "repo_url": "github.com/valaris/test-repo",
        },
        headers=device(installation["device_token"]),
    )
    assert response.status_code == 422


async def test_device_policy_hides_mappings_in_workspaces_the_owner_left(
    client, normal_client, db_session, installation, test_workspace, test_user
):
    await client.post(
        f"{ME}/{installation['installation_id']}/mappings",
        json={"workspace_id": str(test_workspace.id), "root_path": "/work/repo"},
    )
    await db_session.execute(
        delete(WorkspaceMember).where(WorkspaceMember.user_id == test_user.id)
    )
    await db_session.flush()
    response = await normal_client.get(
        "/api/companion/policy", headers=device(installation["device_token"])
    )
    assert response.json()["mappings"] == []


# --- a reconnect keeps the owner's privacy choices ------------------------------

REPO = {"repo_url": "git@github.com:valaris/test-repo.git"}
EARLIER = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)
LATER = EARLIER + timedelta(days=7)


async def _auto_map(normal_client, enrollment):
    response = await normal_client.post(
        "/api/companion/mappings",
        json=REPO,
        headers=device(enrollment["device_token"]),
    )
    assert response.status_code in (200, 201), response.text
    return response.json()


async def _choose(client, enrollment, mapping, **choice):
    response = await client.patch(
        f"{ME}/{enrollment['installation_id']}/mappings/{mapping['id']}", json=choice
    )
    assert response.status_code == 200, response.text


async def _stamp(db_session, mapping, at):
    """When the owner last touched the mapping; SQLite's now() only has seconds."""
    await db_session.execute(
        update(CompanionProjectMapping)
        .where(CompanionProjectMapping.id == uuid.UUID(mapping["id"]))
        .values(updated_at=at)
    )
    await db_session.flush()


async def _revoke(client, enrollment):
    assert (
        await client.delete(f"{ME}/{enrollment['installation_id']}")
    ).status_code == 200


async def _reconnect(client, enrollment):
    assert (
        await client.delete(f"{ME}/{enrollment['installation_id']}")
    ).status_code == 200
    response = await enroll(client)
    assert response.status_code == 201, response.text
    return response.json()


async def test_reconnect_auto_maps_at_the_level_the_owner_chose(
    client, normal_client, installation, test_git_repo, monkeypatch
):
    # The carry-over rules as written against the standard default; the
    # rich default is pinned in test_session_content_policy.py.
    monkeypatch.setattr(settings, "RICH_CAPTURE_ENABLED", False)
    first = await _auto_map(normal_client, installation)
    assert first["content_level"] == "standard"
    await _choose(client, installation, first, content_level="metadata")

    replacement = await _reconnect(client, installation)
    remapped = await _auto_map(normal_client, replacement)
    assert remapped["installation_id"] == replacement["installation_id"]
    assert remapped["content_level"] == "metadata"


async def test_reconnect_keeps_a_repository_switched_off(
    client, normal_client, installation, test_git_repo
):
    first = await _auto_map(normal_client, installation)
    await _choose(client, installation, first, enabled=False)
    replacement = await _reconnect(client, installation)
    assert (await _auto_map(normal_client, replacement))["enabled"] is False


async def test_an_explicit_choice_after_a_reconnect_wins(
    client, normal_client, db_session, installation, test_git_repo
):
    first = await _auto_map(normal_client, installation)
    await _choose(client, installation, first, content_level="metadata")
    await _stamp(db_session, first, EARLIER)
    second = await _reconnect(client, installation)
    remapped = await _auto_map(normal_client, second)
    await _choose(client, second, remapped, content_level="full")
    await _stamp(db_session, remapped, LATER)
    assert (await _auto_map(normal_client, second))["content_level"] == "full"

    # The device it replaced is history: the newer choice carries forward.
    third = await _reconnect(client, second)
    assert (await _auto_map(normal_client, third))["content_level"] == "full"


@pytest.mark.parametrize(
    "lowered,expected",
    [
        ({"content_level": "metadata"}, ("metadata", True)),
        ({"enabled": False}, ("full", False)),
    ],
)
async def test_the_latest_choice_wins_whatever_order_devices_were_revoked(
    client, normal_client, db_session, installation, test_git_repo, lowered, expected
):
    first = await _auto_map(normal_client, installation)
    await _choose(client, installation, first, content_level="full")
    second = (await enroll(client)).json()
    second_mapping = await _auto_map(normal_client, second)
    assert second_mapping["content_level"] == "full"
    await _stamp(db_session, second_mapping, EARLIER)
    await _choose(client, installation, first, **lowered)
    await _stamp(db_session, first, LATER)

    await _revoke(client, installation)
    await _revoke(client, second)
    newest = (await enroll(client)).json()
    remapped = await _auto_map(normal_client, newest)
    assert (remapped["content_level"], remapped["enabled"]) == expected


async def test_a_long_revoked_device_does_not_pin_its_level(
    client, normal_client, db_session, installation, test_git_repo
):
    ancient = await _auto_map(normal_client, installation)
    await _choose(client, installation, ancient, content_level="metadata")
    await _stamp(db_session, ancient, EARLIER)
    recent = (await enroll(client)).json()
    recent_mapping = await _auto_map(normal_client, recent)
    await _choose(client, recent, recent_mapping, content_level="full")
    await _stamp(db_session, recent_mapping, LATER)

    # Revoked last, but its choice is the older one.
    await _revoke(client, recent)
    await _revoke(client, installation)
    newest = (await enroll(client)).json()
    assert (await _auto_map(normal_client, newest))["content_level"] == "full"


async def test_equally_recent_choices_resolve_to_the_more_private_one(
    client, normal_client, db_session, installation, test_git_repo
):
    first = await _auto_map(normal_client, installation)
    second = (await enroll(client)).json()
    second_mapping = await _auto_map(normal_client, second)
    await _choose(client, installation, first, content_level="full")
    await _choose(client, second, second_mapping, content_level="metadata")
    for mapping in (first, second_mapping):
        await _stamp(db_session, mapping, LATER)
    await _revoke(client, installation)
    await _revoke(client, second)
    newest = (await enroll(client)).json()
    assert (await _auto_map(normal_client, newest))["content_level"] == "metadata"


async def test_devices_that_disagree_resolve_to_the_more_private_level(
    client, normal_client, installation, test_git_repo
):
    first = await _auto_map(normal_client, installation)
    await _choose(client, installation, first, content_level="metadata")
    other = (await enroll(client)).json()
    other_mapping = await _auto_map(normal_client, other)
    await _choose(client, other, other_mapping, content_level="full")

    newest = (await enroll(client)).json()
    assert (await _auto_map(normal_client, newest))["content_level"] == "metadata"


async def test_an_explicit_mapping_that_names_its_repository_carries_over(
    client, normal_client, installation, test_workspace, test_git_repo
):
    explicit = await client.post(
        f"{ME}/{installation['installation_id']}/mappings",
        json={
            "workspace_id": str(test_workspace.id),
            "root_path": "/work/secret",
            "repo_url": "https://github.com/valaris/test-repo",
            "content_level": "metadata",
            "enabled": False,
        },
    )
    assert explicit.status_code == 201, explicit.text
    replacement = await _reconnect(client, installation)
    remapped = await _auto_map(normal_client, replacement)
    assert remapped["origin"] == "auto_repo"
    assert (remapped["content_level"], remapped["enabled"]) == ("metadata", False)


async def test_a_choice_in_another_workspace_does_not_carry_over(
    client,
    normal_client,
    db_session,
    installation,
    test_git_repo,
    test_user,
    monkeypatch,
):
    # The carry-over rules as written against the standard default; the
    # rich default is pinned in test_session_content_policy.py.
    monkeypatch.setattr(settings, "RICH_CAPTURE_ENABLED", False)
    elsewhere = Workspace(name="Elsewhere", slug="elsewhere", created_by=test_user.id)
    db_session.add(elsewhere)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=elsewhere.id, user_id=test_user.id, role=WorkspaceRole.member
        )
    )
    await db_session.flush()
    other = (await enroll(client)).json()
    explicit = await client.post(
        f"{ME}/{other['installation_id']}/mappings",
        json={
            "workspace_id": str(elsewhere.id),
            "root_path": "/work/fork",
            "repo_url": "https://github.com/valaris/test-repo",
            "content_level": "metadata",
        },
    )
    assert explicit.status_code == 201, explicit.text

    mapped = await _auto_map(normal_client, installation)
    assert mapped["content_level"] == "standard"


async def test_another_owners_choice_never_carries_over(
    client,
    normal_client,
    db_session,
    installation,
    test_workspace,
    test_git_repo,
    second_user,
    monkeypatch,
):
    # The carry-over rules as written against the standard default; the
    # rich default is pinned in test_session_content_policy.py.
    monkeypatch.setattr(settings, "RICH_CAPTURE_ENABLED", False)
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=second_user.id,
            role=WorkspaceRole.member,
        )
    )
    await db_session.flush()
    async with as_user(db_session, second_user) as other_client:
        theirs = (await enroll(other_client)).json()
        their_mapping = await _auto_map(normal_client, theirs)
        await _choose(other_client, theirs, their_mapping, content_level="metadata")
        await _choose(other_client, theirs, their_mapping, enabled=False)

    mine = await _auto_map(normal_client, installation)
    assert (mine["content_level"], mine["enabled"]) == ("standard", True)


# --- a device renames itself --------------------------------------------------


async def test_device_renames_its_own_installation(
    client, normal_client, installation, test_workspace
):
    sibling = (await enroll(client, name="Other laptop")).json()
    headers = device(installation["device_token"])
    with patch.object(event_bus, "publish", new_callable=AsyncMock) as publish:
        renamed = await normal_client.patch(
            "/api/companion/installation",
            json={"name": "linux-amd64-1a2b3c4d"},
            headers=headers,
        )
        assert renamed.status_code == 200, renamed.text
        assert renamed.json()["installation_id"] == installation["installation_id"]
        assert renamed.json()["name"] == "linux-amd64-1a2b3c4d"
        [call] = [
            call
            for call in publish.await_args_list
            if call.kwargs["event_type"] == "companion_installation.updated"
        ]
        assert call.kwargs["payload"]["reason"] == "renamed"

        publish.reset_mock()
        again = await normal_client.patch(
            "/api/companion/installation",
            json={"name": "linux-amd64-1a2b3c4d"},
            headers=headers,
        )
        assert again.status_code == 200
        assert publish.await_args_list == []

    names = {
        item["installation_id"]: item["name"] for item in (await client.get(ME)).json()
    }
    assert names == {
        installation["installation_id"]: "linux-amd64-1a2b3c4d",
        sibling["installation_id"]: "Other laptop",
    }


@pytest.mark.parametrize(
    "body",
    [{"name": ""}, {"name": "x" * 201}, {}, {"name": "ok", "platform": "linux"}],
)
async def test_device_rename_rejects_a_bad_name(normal_client, installation, body):
    response = await normal_client.patch(
        "/api/companion/installation",
        json=body,
        headers=device(installation["device_token"]),
    )
    assert response.status_code == 422


async def test_a_revoked_device_cannot_rename_itself(
    client, normal_client, installation
):
    await client.delete(f"{ME}/{installation['installation_id']}")
    for headers in [device(installation["device_token"]), {}]:
        response = await normal_client.patch(
            "/api/companion/installation", json={"name": "renamed"}, headers=headers
        )
        assert response.status_code == 401
    [listed] = (await client.get(ME)).json()
    assert listed["name"] == "Synthetic laptop"


BAD_NAMES = ["", "   ", "​​", "laptop\nname", "bell\x07", "‮evil", "x" * 201]


@pytest.mark.parametrize("name", BAD_NAMES)
async def test_enroll_and_rename_refuse_an_unprintable_name(
    client, normal_client, installation, name
):
    assert (await enroll(client, name=name)).status_code == 422
    response = await normal_client.patch(
        "/api/companion/installation",
        json={"name": name},
        headers=device(installation["device_token"]),
    )
    assert response.status_code == 422


async def test_enroll_and_rename_trim_the_name(client, normal_client):
    enrolled = await enroll(client, name="  Studio Mac\t")
    assert enrolled.status_code == 201, enrolled.text
    renamed = await normal_client.patch(
        "/api/companion/installation",
        json={"name": "  darwin-amd64-1a2b3c4d  "},
        headers=device(enrolled.json()["device_token"]),
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "darwin-amd64-1a2b3c4d"
    [listed] = (await client.get(ME)).json()
    assert listed["name"] == "darwin-amd64-1a2b3c4d"


async def test_a_name_keeps_its_inner_spaces_and_unicode(client):
    enrolled = await enroll(client, name="Estación de trabajo 🖥️")
    assert enrolled.status_code == 201, enrolled.text
    [listed] = (await client.get(ME)).json()
    assert listed["name"] == "Estación de trabajo 🖥️"


async def test_device_policy_advertises_the_api_base_agents_should_call(
    normal_client, installation, monkeypatch
):
    from app.config import settings

    monkeypatch.setattr(settings, "API_URL", "https://api.example.test/")
    response = await normal_client.get(
        "/api/companion/policy", headers=device(installation["device_token"])
    )
    assert response.status_code == 200, response.text
    assert response.json()["api_base_url"] == "https://api.example.test"


async def test_device_policy_omits_an_unconfigured_api_base(
    normal_client, installation, monkeypatch
):
    from app.config import settings

    monkeypatch.setattr(settings, "API_URL", "  ")
    response = await normal_client.get(
        "/api/companion/policy", headers=device(installation["device_token"])
    )
    assert response.status_code == 200, response.text
    assert response.json()["api_base_url"] is None


@pytest.mark.parametrize(
    "api_url", ["http://backend:8000", "http://localhost:8000", "ftp://api.example.test"]
)
async def test_device_policy_never_advertises_a_non_https_api_base(
    normal_client, installation, monkeypatch, api_url
):
    from app.config import settings

    monkeypatch.setattr(settings, "API_URL", api_url)
    response = await normal_client.get(
        "/api/companion/policy", headers=device(installation["device_token"])
    )
    assert response.status_code == 200, response.text
    assert response.json()["api_base_url"] is None
