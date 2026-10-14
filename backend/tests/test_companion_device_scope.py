# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""A device token manages its own installation, and nothing else."""

import hashlib
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select

from app.config import settings
from app.core.event_bus import event_bus
from app.database import get_db
from app.main import create_app
from app.models.activity import Activity
from app.models.api_key import ApiKey
from app.models.git.git_repo import GitProvider, GitRepo
from app.models.kanban.board import Board
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from tests.test_agent_sessions import FIXTURE_EVENTS, as_user, record, upload
from tests.test_companion import ME, device, enroll

BOARDS = "/api/companion/boards"
MAPPINGS = "/api/companion/mappings"
SETTINGS = "/api/companion/settings"
SESSIONS = "/api/companion/sessions"
POLICY = "/api/companion/policy"
INVALIDATION = "companion_installation.updated"


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


async def foreign_workspace(db_session, second_user, slug="foreign"):
    workspace = Workspace(name="Foreign", slug=slug, created_by=second_user.id)
    db_session.add(workspace)
    await db_session.flush()
    board = Board(
        workspace_id=workspace.id,
        name="Hidden",
        slug="hidden",
        created_by=second_user.id,
    )
    db_session.add(board)
    await db_session.flush()
    return workspace, board


async def shared_workspace_with_repo(db_session, owner, second_user, url):
    workspace, board = await foreign_workspace(db_session, second_user, slug="shared")
    db_session.add(
        WorkspaceMember(
            workspace_id=workspace.id, user_id=owner.id, role=WorkspaceRole.member
        )
    )
    db_session.add(
        GitRepo(
            board_id=board.id,
            workspace_id=workspace.id,
            name="Shared repo",
            slug="shared-repo",
            url=url,
            provider=GitProvider.github,
            added_by=second_user.id,
        )
    )
    await db_session.flush()
    return workspace, board


async def leave(db_session, user, workspace):
    await db_session.execute(
        delete(WorkspaceMember).where(
            WorkspaceMember.user_id == user.id,
            WorkspaceMember.workspace_id == workspace.id,
        )
    )
    await db_session.flush()


def board_choice(workspace, board, **values):
    return {
        "workspace_id": str(workspace.id),
        "board_id": str(board.id),
        "content_level": "standard",
        **values,
    }


async def bind(normal_client, installation, body):
    response = await normal_client.post(
        MAPPINGS, json=body, headers=device(installation["device_token"])
    )
    assert response.status_code == 201, response.text
    return response.json()


# --- boards ---------------------------------------------------------------------


async def test_list_boards_returns_reachable_boards_with_normalized_repos(
    normal_client,
    db_session,
    laptop,
    test_workspace,
    test_board,
    test_git_repo,
    second_user,
):
    await foreign_workspace(db_session, second_user)
    db_session.add(
        GitRepo(
            board_id=test_board.id,
            workspace_id=test_workspace.id,
            name="Second remote",
            slug="second-remote",
            url="git@github.com:Valaris/Other.git",
            provider=GitProvider.github,
            added_by=test_board.created_by,
        )
    )
    await db_session.flush()

    response = await normal_client.get(BOARDS, headers=device(laptop["device_token"]))

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "workspaces": [
            {
                "id": str(test_workspace.id),
                "slug": "default",
                "name": "Default",
                "boards": [
                    {
                        "id": str(test_board.id),
                        "name": "Test Board",
                        "repos": [
                            "github.com/valaris/other",
                            "github.com/valaris/test-repo",
                        ],
                    }
                ],
            }
        ]
    }
    assert "Hidden" not in response.text


async def test_list_boards_forgets_a_workspace_the_owner_left(
    normal_client, db_session, laptop, test_workspace, test_board, test_user
):
    await leave(db_session, test_user, test_workspace)
    response = await normal_client.get(BOARDS, headers=device(laptop["device_token"]))
    assert response.status_code == 200
    assert response.json() == {"workspaces": []}


# --- mappings: create -------------------------------------------------------------


async def test_create_mapping_with_board_choice_for_a_root_is_idempotent(
    normal_client, laptop, test_workspace, test_board, db_session, test_user
):
    other_board = Board(
        workspace_id=test_workspace.id,
        name="Other",
        slug="other",
        created_by=test_user.id,
    )
    db_session.add(other_board)
    await db_session.flush()
    body = board_choice(
        test_workspace,
        test_board,
        root_path="/home/synthetic/project/",
        repo_url="git@github.com:Synthetic/Project.git",
        content_level="metadata",
    )
    headers = device(laptop["device_token"])

    created = await normal_client.post(MAPPINGS, json=body, headers=headers)
    assert created.status_code == 201, created.text
    mapping = created.json()
    assert mapping["installation_id"] == laptop["installation_id"]
    assert mapping["origin"] == "explicit"
    assert mapping["root_path"] == "/home/synthetic/project"
    assert mapping["repo_url_normalized"] == "github.com/synthetic/project"
    assert mapping["board_id"] == str(test_board.id)
    assert mapping["content_level"] == "metadata"
    assert mapping["enabled"] is True

    again = await normal_client.post(MAPPINGS, json=body, headers=headers)
    assert again.status_code == 200
    assert again.json()["id"] == mapping["id"]

    elsewhere = await normal_client.post(
        MAPPINGS, json={**body, "board_id": str(other_board.id)}, headers=headers
    )
    assert elsewhere.status_code == 409


async def test_create_mapping_with_board_choice_for_a_repository_is_idempotent(
    normal_client, laptop, test_workspace, test_board
):
    body = board_choice(
        test_workspace,
        test_board,
        repo_url="https://github.com/Synthetic/Unbound.git",
        enabled=False,
    )
    headers = device(laptop["device_token"])

    created = await normal_client.post(MAPPINGS, json=body, headers=headers)
    assert created.status_code == 201, created.text
    mapping = created.json()
    assert mapping["root_path"] is None
    assert mapping["repo_url_normalized"] == "github.com/synthetic/unbound"
    assert mapping["board_id"] == str(test_board.id)
    assert mapping["enabled"] is False

    again = await normal_client.post(MAPPINGS, json=body, headers=headers)
    assert again.status_code == 200
    assert again.json()["id"] == mapping["id"]


async def test_create_mapping_with_board_choice_ignores_auto_match_setting(
    client, normal_client, laptop, test_workspace, test_board
):
    await client.patch(
        f"{ME}/{laptop['installation_id']}/policy", json={"auto_match_repos": False}
    )
    await bind(
        normal_client,
        laptop,
        board_choice(test_workspace, test_board, repo_url="github.com/a/b"),
    )


@pytest.mark.parametrize(
    "change",
    [
        {},  # neither root_path nor repo_url
        {"board_id": None, "root_path": "/work"},
        {"content_level": None, "root_path": "/work"},
        {"content_level": "everything", "root_path": "/work"},
        {"root_path": "relative/path"},
        {"repo_url": "/home/synthetic/local-only"},
        {"root_path": "/work", "origin": "explicit"},
    ],
)
async def test_create_mapping_with_board_choice_rejects_a_bad_body(
    normal_client, laptop, test_workspace, test_board, change
):
    body = {**board_choice(test_workspace, test_board), **change}
    body = {key: value for key, value in body.items() if value is not None}
    response = await normal_client.post(
        MAPPINGS, json=body, headers=device(laptop["device_token"])
    )
    assert response.status_code == 422, (change, response.text)


@pytest.mark.parametrize("body", [[], "github.com/a/b", 7, None])
async def test_create_mapping_rejects_a_body_that_is_not_an_object(
    normal_client, laptop, body
):
    response = await normal_client.post(
        MAPPINGS, json=body, headers=device(laptop["device_token"])
    )
    assert response.status_code == 422, response.text


async def test_create_mapping_into_a_workspace_the_owner_is_not_in_is_forbidden(
    normal_client, db_session, laptop, test_workspace, test_board, second_user
):
    foreign, foreign_board = await foreign_workspace(db_session, second_user)
    headers = device(laptop["device_token"])
    for workspace_id in [foreign.id, uuid.uuid4()]:
        response = await normal_client.post(
            MAPPINGS,
            json={
                "workspace_id": str(workspace_id),
                "board_id": str(foreign_board.id),
                "root_path": "/work",
                "content_level": "standard",
            },
            headers=headers,
        )
        assert response.status_code == 403, response.text
        assert "Hidden" not in response.text


async def test_create_mapping_with_a_board_of_another_workspace_is_not_found(
    normal_client, db_session, laptop, test_workspace, second_user
):
    _, foreign_board = await foreign_workspace(db_session, second_user)
    for board_id in [foreign_board.id, uuid.uuid4()]:
        response = await normal_client.post(
            MAPPINGS,
            json={
                "workspace_id": str(test_workspace.id),
                "board_id": str(board_id),
                "root_path": "/work",
                "content_level": "standard",
            },
            headers=device(laptop["device_token"]),
        )
        assert response.status_code == 404, response.text


async def test_create_mapping_legacy_repo_url_body_behaves_as_before(
    client,
    normal_client,
    db_session,
    laptop,
    test_workspace,
    test_board,
    test_git_repo,
    test_user,
    second_user,
):
    headers = device(laptop["device_token"])
    body = {"repo_url": "git@github.com:valaris/test-repo.git"}

    created = await normal_client.post(MAPPINGS, json=body, headers=headers)
    assert created.status_code == 201, created.text
    assert created.json()["origin"] == "auto_repo"
    assert created.json()["board_id"] == str(test_board.id)
    again = await normal_client.post(MAPPINGS, json=body, headers=headers)
    assert (again.status_code, again.json()["id"]) == (200, created.json()["id"])

    unknown = await normal_client.post(
        MAPPINGS, json={"repo_url": "https://github.com/x/unknown"}, headers=headers
    )
    assert unknown.status_code == 404

    await shared_workspace_with_repo(
        db_session, test_user, second_user, "https://github.com/valaris/twice"
    )
    db_session.add(
        GitRepo(
            board_id=test_board.id,
            workspace_id=test_workspace.id,
            name="Twice",
            slug="twice",
            url="https://github.com/valaris/twice",
            provider=GitProvider.github,
            added_by=test_user.id,
        )
    )
    await db_session.flush()
    ambiguous = await normal_client.post(
        MAPPINGS, json={"repo_url": "github.com/valaris/twice"}, headers=headers
    )
    assert ambiguous.status_code == 409
    assert ambiguous.json()["error_code"] == "ambiguous_repo"

    await client.patch(
        f"{ME}/{laptop['installation_id']}/policy", json={"auto_match_repos": False}
    )
    disabled = await normal_client.post(
        MAPPINGS, json={"repo_url": "github.com/valaris/other"}, headers=headers
    )
    assert disabled.status_code == 403
    assert disabled.json()["error_code"] == "auto_match_disabled"


# --- mappings: list, patch, delete --------------------------------------------------


async def test_list_mappings_returns_only_this_devices_reachable_mappings(
    normal_client,
    db_session,
    laptop,
    desktop,
    test_workspace,
    test_board,
    test_user,
    second_user,
):
    shared, shared_board = await shared_workspace_with_repo(
        db_session, test_user, second_user, "https://github.com/valaris/shared"
    )
    own = await bind(
        normal_client, laptop, board_choice(test_workspace, test_board, root_path="/a")
    )
    await bind(
        normal_client, laptop, board_choice(shared, shared_board, root_path="/left")
    )
    await bind(
        normal_client, desktop, board_choice(test_workspace, test_board, root_path="/b")
    )
    await leave(db_session, test_user, shared)

    response = await normal_client.get(MAPPINGS, headers=device(laptop["device_token"]))

    assert response.status_code == 200, response.text
    assert [mapping["id"] for mapping in response.json()] == [own["id"]]


async def test_update_mapping_content_level_downgrade_reaches_the_policy(
    normal_client, laptop, test_workspace, test_board
):
    headers = device(laptop["device_token"])
    mapping = await bind(
        normal_client,
        laptop,
        board_choice(test_workspace, test_board, root_path="/a", content_level="full"),
    )

    updated = await normal_client.patch(
        f"{MAPPINGS}/{mapping['id']}",
        json={"content_level": "metadata", "enabled": False},
        headers=headers,
    )

    assert updated.status_code == 200, updated.text
    assert updated.json()["content_level"] == "metadata"
    assert updated.json()["enabled"] is False
    [policy_mapping] = (await normal_client.get(POLICY, headers=headers)).json()[
        "mappings"
    ]
    assert policy_mapping["content_level"] == "metadata"
    assert policy_mapping["enabled"] is False


@pytest.mark.parametrize(
    "body",
    [
        {"board_id": None},
        {"content_level": None},
        {"enabled": None},
        {"content_level": "everything"},
        {"root_path": "/elsewhere"},
    ],
)
async def test_update_mapping_rejects_a_bad_body(
    normal_client, laptop, test_workspace, test_board, body
):
    mapping = await bind(
        normal_client, laptop, board_choice(test_workspace, test_board, root_path="/a")
    )
    response = await normal_client.patch(
        f"{MAPPINGS}/{mapping['id']}", json=body, headers=device(laptop["device_token"])
    )
    assert response.status_code == 422, response.text


async def test_other_device_cannot_touch_this_devices_mappings(
    normal_client, laptop, desktop, test_workspace, test_board
):
    mapping = await bind(
        normal_client, laptop, board_choice(test_workspace, test_board, root_path="/a")
    )
    other = device(desktop["device_token"])

    patched = await normal_client.patch(
        f"{MAPPINGS}/{mapping['id']}", json={"enabled": False}, headers=other
    )
    deleted = await normal_client.delete(f"{MAPPINGS}/{mapping['id']}", headers=other)
    listed = await normal_client.get(MAPPINGS, headers=other)

    assert patched.status_code == 404
    assert deleted.status_code == 404
    assert listed.json() == []
    [kept] = (
        await normal_client.get(MAPPINGS, headers=device(laptop["device_token"]))
    ).json()
    assert kept["enabled"] is True


async def test_update_mapping_after_the_owner_left_the_workspace_is_forbidden(
    normal_client, db_session, laptop, test_workspace, test_board, test_user
):
    headers = device(laptop["device_token"])
    mapping = await bind(
        normal_client, laptop, board_choice(test_workspace, test_board, root_path="/a")
    )
    await leave(db_session, test_user, test_workspace)

    patched = await normal_client.patch(
        f"{MAPPINGS}/{mapping['id']}", json={"content_level": "full"}, headers=headers
    )

    assert patched.status_code == 403
    assert (await normal_client.get(POLICY, headers=headers)).json()["mappings"] == []
    assert (await normal_client.get(BOARDS, headers=headers)).json() == {
        "workspaces": []
    }


async def test_delete_mapping_removes_it_once(
    normal_client, laptop, test_workspace, test_board
):
    headers = device(laptop["device_token"])
    mapping = await bind(
        normal_client, laptop, board_choice(test_workspace, test_board, root_path="/a")
    )

    first = await normal_client.delete(f"{MAPPINGS}/{mapping['id']}", headers=headers)
    second = await normal_client.delete(f"{MAPPINGS}/{mapping['id']}", headers=headers)

    assert first.status_code == 204
    assert second.status_code == 404
    assert (await normal_client.get(MAPPINGS, headers=headers)).json() == []


# --- settings ---------------------------------------------------------------------


async def test_update_settings_changes_only_this_devices_policy(
    client, normal_client, laptop, desktop
):
    headers = device(laptop["device_token"])
    response = await normal_client.patch(
        SETTINGS,
        json={
            "auto_match_repos": False,
            "enabled_agents": ["codex_cli"],
            "exclude_globs": ["github.com/secret/*"],
        },
        headers=headers,
    )

    assert response.status_code == 200, response.text
    assert response.json() == {
        "paused": False,
        "auto_match_repos": False,
        "enabled_agents": ["codex_cli"],
        "exclude_globs": ["github.com/secret/*"],
        "retention_days": None,
    }
    policy = (await normal_client.get(POLICY, headers=headers)).json()["installation"]
    assert policy["auto_match_repos"] is False
    assert policy["enabled_agents"] == ["codex_cli"]
    untouched = (await client.get(f"{ME}/{desktop['installation_id']}/policy")).json()
    assert untouched["auto_match_repos"] is True
    assert untouched["exclude_globs"] == []


@pytest.mark.parametrize(
    "body",
    [
        {"retention_days": 30},
        {"retention_days": None},
        {"paused": True},
        {"auto_match_repos": None},
        {"enabled_agents": None},
        {"enabled_agents": ["Not An Agent"]},
        {"exclude_globs": [""]},
    ],
)
async def test_update_settings_rejects_web_only_or_bad_fields(
    client, normal_client, laptop, body
):
    response = await normal_client.patch(
        SETTINGS, json=body, headers=device(laptop["device_token"])
    )
    assert response.status_code == 422, response.text
    policy = (await client.get(f"{ME}/{laptop['installation_id']}/policy")).json()
    assert policy["retention_days"] is None
    assert policy["paused"] is False


# --- activity and invalidation ---------------------------------------------------------


async def test_device_changes_record_activity_by_the_owner_via_the_companion(
    normal_client, db_session, laptop, test_workspace, test_board, test_user
):
    headers = device(laptop["device_token"])
    mapping = await bind(
        normal_client,
        laptop,
        board_choice(test_workspace, test_board, root_path="/home/synthetic/secret"),
    )
    await normal_client.patch(
        f"{MAPPINGS}/{mapping['id']}", json={"content_level": "full"}, headers=headers
    )
    await normal_client.patch(
        SETTINGS, json={"exclude_globs": ["*/private/*"]}, headers=headers
    )
    await normal_client.delete(f"{MAPPINGS}/{mapping['id']}", headers=headers)

    activities = list(
        await db_session.scalars(
            select(Activity)
            .where(Activity.workspace_id == test_workspace.id)
            .order_by(Activity.created_at)
        )
    )
    assert [activity.action.value for activity in activities] == [
        "created",
        "updated",
        "updated",
        "deleted",
    ]
    for activity in activities:
        assert activity.actor_id == test_user.id
        assert activity.agent_id is None
        assert activity.via_api_key == "companion: Laptop"
        assert activity.changes["installation_id"] == laptop["installation_id"]
        # Local paths and exclusion patterns stay on the device.
        assert "/home/synthetic" not in str(activity.changes) + activity.summary
        assert "private" not in str(activity.changes) + activity.summary
    assert activities[0].board_id == test_board.id
    assert activities[2].changes["fields"] == ["exclude_globs"]
    assert [(activity.message_key, activity.message_params) for activity in activities] == [
        ("activity.companion.mapping_created", {}),
        ("activity.companion.mapping_updated", {}),
        ("activity.companion.settings_updated", {}),
        ("activity.companion.mapping_deleted", {}),
    ]


async def test_device_changes_publish_an_installation_invalidation(
    normal_client, laptop, test_workspace, test_board
):
    headers = device(laptop["device_token"])
    with patch.object(event_bus, "publish", new_callable=AsyncMock) as publish:
        mapping = await bind(
            normal_client,
            laptop,
            board_choice(test_workspace, test_board, root_path="/a"),
        )
        await normal_client.patch(
            f"{MAPPINGS}/{mapping['id']}", json={"enabled": False}, headers=headers
        )
        await normal_client.patch(
            SETTINGS, json={"auto_match_repos": False}, headers=headers
        )
        await normal_client.delete(f"{MAPPINGS}/{mapping['id']}", headers=headers)
        reasons = [
            call.kwargs["payload"]["reason"]
            for call in publish.await_args_list
            if call.kwargs["event_type"] == INVALIDATION
        ]
        assert all(
            call.kwargs["payload"]["installation_id"] == laptop["installation_id"]
            for call in publish.await_args_list
            if call.kwargs["event_type"] == INVALIDATION
        )
    assert reasons == [
        "mapping_created",
        "mapping_updated",
        "settings_updated",
        "mapping_deleted",
    ]


async def test_idempotent_device_writes_record_nothing(
    normal_client, db_session, laptop, test_workspace, test_board
):
    headers = device(laptop["device_token"])
    body = board_choice(test_workspace, test_board, root_path="/a")
    mapping = await bind(normal_client, laptop, body)
    before = len(list(await db_session.scalars(select(Activity))))
    with patch.object(event_bus, "publish", new_callable=AsyncMock) as publish:
        await normal_client.post(MAPPINGS, json=body, headers=headers)
        await normal_client.patch(
            f"{MAPPINGS}/{mapping['id']}",
            json={"content_level": "standard"},
            headers=headers,
        )
        await normal_client.patch(
            SETTINGS, json={"auto_match_repos": True}, headers=headers
        )
        assert publish.await_args_list == []
    assert len(list(await db_session.scalars(select(Activity)))) == before


# --- sessions ---------------------------------------------------------------------


async def upload_session(normal_client, installation, mapping, native_id):
    await upload(
        normal_client,
        installation["device_token"],
        [record(FIXTURE_EVENTS, mapping["id"], session=native_id)],
    )


@pytest.fixture
async def two_devices_with_sessions(
    normal_client, laptop, desktop, test_workspace, test_board
):
    laptop_mapping = await bind(
        normal_client, laptop, board_choice(test_workspace, test_board, root_path="/l")
    )
    desktop_mapping = await bind(
        normal_client, desktop, board_choice(test_workspace, test_board, root_path="/d")
    )
    for native_id in ["laptop-1", "laptop-2", "laptop-3"]:
        await upload_session(normal_client, laptop, laptop_mapping, native_id)
    await upload_session(normal_client, desktop, desktop_mapping, "desktop-1")
    return laptop, desktop


async def test_list_sessions_returns_only_this_devices_sessions_paginated(
    normal_client, two_devices_with_sessions
):
    laptop, _ = two_devices_with_sessions
    headers = device(laptop["device_token"])

    first = await normal_client.get(SESSIONS + "?limit=2", headers=headers)
    assert first.status_code == 200, first.text
    assert first.headers["cache-control"] == "no-store"
    page = first.json()
    assert len(page["items"]) == 2 and page["next_cursor"]
    rest = (
        await normal_client.get(
            SESSIONS + "?limit=2&cursor=" + page["next_cursor"], headers=headers
        )
    ).json()
    assert rest["next_cursor"] is None
    items = page["items"] + rest["items"]
    assert sorted(item["native_session_id"] for item in items) == [
        "laptop-1",
        "laptop-2",
        "laptop-3",
    ]
    assert {item["installation_id"] for item in items} == {laptop["installation_id"]}
    assert (
        await normal_client.get(SESSIONS + "?status=ended", headers=headers)
    ).json()["items"][0]["status"] == "ended"
    assert (
        await normal_client.get(SESSIONS + "?status=active", headers=headers)
    ).json()["items"] == []


@pytest.mark.parametrize(
    "query", ["?limit=101", "?limit=0", "?status=bogus", "?cursor=garbage"]
)
async def test_list_sessions_rejects_a_bad_query(normal_client, laptop, query):
    response = await normal_client.get(
        SESSIONS + query, headers=device(laptop["device_token"])
    )
    assert response.status_code == 422


async def test_session_detail_and_usage_are_own_device_only(
    normal_client, two_devices_with_sessions
):
    laptop, desktop = two_devices_with_sessions
    laptop_headers = device(laptop["device_token"])
    desktop_headers = device(desktop["device_token"])
    [desktop_session] = (
        await normal_client.get(SESSIONS, headers=desktop_headers)
    ).json()["items"]
    laptop_session = (await normal_client.get(SESSIONS, headers=laptop_headers)).json()[
        "items"
    ][0]

    own = await normal_client.get(
        f"{SESSIONS}/{laptop_session['id']}", headers=laptop_headers
    )
    own_usage = await normal_client.get(
        f"{SESSIONS}/{laptop_session['id']}/usage", headers=laptop_headers
    )
    assert own.status_code == 200 and own.json()["id"] == laptop_session["id"]
    assert own_usage.status_code == 200 and "price_table_version" in own_usage.json()

    for path in ["", "/usage"]:
        for session_id in [desktop_session["id"], str(uuid.uuid4())]:
            response = await normal_client.get(
                f"{SESSIONS}/{session_id}{path}", headers=laptop_headers
            )
            assert response.status_code == 404, (path, session_id)


async def test_sessions_hide_after_the_owner_left_the_workspace(
    normal_client, db_session, two_devices_with_sessions, test_workspace, test_user
):
    laptop, _ = two_devices_with_sessions
    headers = device(laptop["device_token"])
    session_id = (await normal_client.get(SESSIONS, headers=headers)).json()["items"][
        0
    ]["id"]
    await leave(db_session, test_user, test_workspace)

    assert (await normal_client.get(SESSIONS, headers=headers)).json()["items"] == []
    for path in ["", "/usage"]:
        response = await normal_client.get(
            f"{SESSIONS}/{session_id}{path}", headers=headers
        )
        assert response.status_code == 404


# --- authentication -----------------------------------------------------------------

DEVICE_ROUTES = [
    ("GET", BOARDS, None),
    ("GET", MAPPINGS, None),
    ("POST", MAPPINGS, {"repo_url": "github.com/valaris/test-repo"}),
    ("PATCH", f"{MAPPINGS}/{uuid.uuid4()}", {"enabled": False}),
    ("DELETE", f"{MAPPINGS}/{uuid.uuid4()}", None),
    ("PATCH", SETTINGS, {"auto_match_repos": False}),
    ("GET", SESSIONS, None),
    ("GET", f"{SESSIONS}/{uuid.uuid4()}", None),
    ("GET", f"{SESSIONS}/{uuid.uuid4()}/usage", None),
]


async def test_revoked_device_is_refused_on_every_self_service_route(
    normal_client, laptop
):
    headers = device(laptop["device_token"])
    assert (
        await normal_client.delete("/api/companion/installation", headers=headers)
    ).status_code == 200
    for method, path, body in DEVICE_ROUTES:
        response = await normal_client.request(method, path, json=body, headers=headers)
        assert response.status_code == 401, (method, path)
        assert response.json()["error_code"] == "invalid_device_token"


async def test_user_api_key_is_refused_on_every_self_service_route(
    normal_client, db_session, test_user, test_workspace
):
    raw_key = "vlr_device-scope-test-key-00000000000000"
    db_session.add(
        ApiKey(
            user_id=test_user.id,
            name="Personal",
            key_hash=hashlib.sha256(raw_key.encode()).hexdigest(),
            key_prefix=raw_key[:8],
        )
    )
    await db_session.flush()
    headers = {"Authorization": "Bearer " + raw_key}
    assert (await normal_client.get("/api/me", headers=headers)).status_code == 200
    for method, path, body in DEVICE_ROUTES:
        response = await normal_client.request(method, path, json=body, headers=headers)
        assert response.status_code == 401, (method, path)
        assert response.json()["error_code"] == "invalid_device_token"


async def test_device_token_stays_refused_on_owner_routes(
    normal_client, laptop, test_workspace, test_board
):
    headers = device(laptop["device_token"])
    base = f"{ME}/{laptop['installation_id']}"
    for method, path, body in [
        ("GET", f"{base}/mappings", None),
        (
            "POST",
            f"{base}/mappings",
            {"workspace_id": str(test_workspace.id), "root_path": "/a"},
        ),
        ("PATCH", f"{base}/policy", {"retention_days": 1}),
        ("GET", "/api/workspaces/default/sessions", None),
    ]:
        response = await normal_client.request(method, path, json=body, headers=headers)
        assert response.status_code == 403, (method, path)


# --- who the device is ----------------------------------------------------------------

WHOAMI = "/api/companion/me"


async def test_me_returns_the_owner_and_this_installation(
    normal_client, laptop, desktop, test_user, monkeypatch
):
    monkeypatch.setattr(settings, "FRONTEND_URL", "https://bp.example.test")
    response = await normal_client.get(WHOAMI, headers=device(laptop["device_token"]))

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "user": {"email": test_user.email, "display_name": "Dev User"},
        "installation": {"id": laptop["installation_id"], "name": "Laptop"},
        "web_origin": "https://bp.example.test",
    }


@pytest.mark.parametrize(
    ("frontend_url", "web_origin"),
    [
        ("https://bp.example.test/app/", "https://bp.example.test"),
        ("http://10.0.0.5:8080", "http://10.0.0.5:8080"),
        ("HTTPS://BP.Example.Test:443/", "https://bp.example.test:443"),
        ("", None),
        ("   ", None),
        ("not a url", None),
        ("ftp://files.example.test", None),
    ],
)
async def test_me_reports_the_configured_web_origin_without_a_path(
    normal_client, laptop, monkeypatch, frontend_url, web_origin
):
    monkeypatch.setattr(settings, "FRONTEND_URL", frontend_url)
    response = await normal_client.get(WHOAMI, headers=device(laptop["device_token"]))
    assert response.status_code == 200, response.text
    assert response.json()["web_origin"] == web_origin


async def test_me_reports_a_missing_display_name_as_null(
    normal_client, db_session, laptop, test_user
):
    test_user.name = ""
    await db_session.flush()
    response = await normal_client.get(WHOAMI, headers=device(laptop["device_token"]))
    assert response.json()["user"]["display_name"] is None


async def test_me_never_returns_another_users_data(
    normal_client, db_session, laptop, test_user, second_user
):
    other_device = await enroll(as_user(db_session, second_user), name="Theirs")
    assert other_device.status_code == 201, other_device.text
    other = other_device.json()

    mine = await normal_client.get(WHOAMI, headers=device(laptop["device_token"]))
    theirs = await normal_client.get(WHOAMI, headers=device(other["device_token"]))

    assert theirs.json()["user"] == {
        "email": second_user.email,
        "display_name": "Other User",
    }
    assert theirs.json()["installation"] == {
        "id": other["installation_id"],
        "name": "Theirs",
    }
    assert test_user.email not in theirs.text
    assert laptop["installation_id"] not in theirs.text
    assert second_user.email not in mine.text


async def test_me_refuses_a_revoked_device(normal_client, laptop):
    headers = device(laptop["device_token"])
    await normal_client.delete("/api/companion/installation", headers=headers)
    response = await normal_client.get(WHOAMI, headers=headers)
    assert response.status_code == 401
    assert response.json()["error_code"] == "invalid_device_token"


async def test_me_refuses_user_and_agent_keys(
    normal_client, agent_client, db_session, test_user
):
    raw_key = "vlr_device-whoami-test-key-0000000000000"
    db_session.add(
        ApiKey(
            user_id=test_user.id,
            name="Personal",
            key_hash=hashlib.sha256(raw_key.encode()).hexdigest(),
            key_prefix=raw_key[:8],
        )
    )
    await db_session.flush()
    for response in [
        await normal_client.get(WHOAMI, headers={"Authorization": "Bearer " + raw_key}),
        await agent_client.get(WHOAMI),
        await normal_client.get(WHOAMI),
    ]:
        assert response.status_code == 401
        assert response.json()["error_code"] == "invalid_device_token"
        assert test_user.email not in response.text


# --- the policy's repository catalog --------------------------------------------------


async def test_policy_repo_catalog_adds_workspace_names_and_keeps_old_fields(
    normal_client,
    db_session,
    laptop,
    test_workspace,
    test_board,
    test_git_repo,
    test_user,
    second_user,
):
    shared, shared_board = await shared_workspace_with_repo(
        db_session, test_user, second_user, "https://github.com/valaris/test-repo"
    )
    await foreign_workspace(db_session, second_user, slug="unreachable")
    headers = device(laptop["device_token"])

    catalog = (await normal_client.get(POLICY, headers=headers)).json()["repo_catalog"]

    assert sorted(catalog, key=lambda entry: entry["workspace_slug"]) == [
        {
            "workspace_slug": "default",
            "workspace_id": str(test_workspace.id),
            "workspace_name": "Default",
            "board_id": str(test_board.id),
            "board_name": "Test Board",
            "repo_url_normalized": "github.com/valaris/test-repo",
        },
        {
            "workspace_slug": "shared",
            "workspace_id": str(shared.id),
            "workspace_name": "Foreign",
            "board_id": str(shared_board.id),
            "board_name": "Hidden",
            "repo_url_normalized": "github.com/valaris/test-repo",
        },
    ]

    await leave(db_session, test_user, shared)
    after_leaving = (await normal_client.get(POLICY, headers=headers)).json()
    assert [entry["workspace_id"] for entry in after_leaving["repo_catalog"]] == [
        str(test_workspace.id)
    ]
