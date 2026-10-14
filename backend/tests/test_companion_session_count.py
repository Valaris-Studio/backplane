# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""`session_count` on a device's read: what "Delete this device's sessions"
would delete, stated before the owner confirms. The delete spans every
workspace, so the count does too, and only the owner ever sees it."""

import uuid
from datetime import timedelta

import pytest

from app.config import settings
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from tests.session_rows import add_installation, add_session

ME = "/api/me/companion/installations"


@pytest.fixture
async def other_workspace(db_session, test_user):
    workspace = Workspace(name="Elsewhere", slug="elsewhere-" + uuid.uuid4().hex[:8], created_by=test_user.id)
    db_session.add(workspace)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(workspace_id=workspace.id, user_id=test_user.id, role=WorkspaceRole.owner)
    )
    await db_session.flush()
    return workspace


async def test_session_count_spans_every_workspace_and_matches_the_delete(
    client, db_session, test_user, test_workspace, other_workspace
):
    laptop = await add_installation(db_session, test_user, name="Laptop")
    desktop = await add_installation(db_session, test_user, name="Desktop")
    for workspace in (test_workspace, test_workspace, other_workspace):
        await add_session(db_session, laptop, workspace, started=timedelta(hours=2))
    await add_session(db_session, desktop, test_workspace, started=timedelta(hours=1))

    counts = {item["name"]: item["session_count"] for item in (await client.get(ME)).json()}
    assert counts == {"Laptop": 3, "Desktop": 1}
    assert (await client.get(f"{ME}/{laptop.id}")).json()["session_count"] == 3

    deleted = await client.delete(f"{ME}/{laptop.id}/sessions")
    assert deleted.json() == {"deleted": 3}
    assert (await client.get(f"{ME}/{laptop.id}")).json()["session_count"] == 0
    assert (await client.get(f"{ME}/{desktop.id}")).json()["session_count"] == 1


async def test_a_device_without_sessions_counts_zero_everywhere_it_is_read(
    client, db_session, test_user, test_workspace
):
    laptop = await add_installation(db_session, test_user)

    assert (await client.get(ME)).json()[0]["session_count"] == 0
    assert (await client.get(f"{ME}/{laptop.id}")).json()["session_count"] == 0
    renamed = await client.patch(f"{ME}/{laptop.id}", json={"name": "Renamed"})
    assert renamed.json()["session_count"] == 0
    assert (await client.delete(f"{ME}/{laptop.id}")).json()["session_count"] == 0


async def test_another_owners_device_count_is_never_disclosed(
    client, db_session, second_user, test_workspace
):
    theirs = await add_installation(db_session, second_user)
    await add_session(db_session, theirs, test_workspace, started=timedelta(hours=1))

    assert (await client.get(ME)).json() == []
    response = await client.get(f"{ME}/{theirs.id}")
    assert response.status_code == 404
    assert "session_count" not in response.text


async def test_agent_keys_cannot_read_a_devices_session_count(
    agent_client, db_session, test_user, test_workspace
):
    laptop = await add_installation(db_session, test_user)
    await add_session(db_session, laptop, test_workspace, started=timedelta(hours=1))

    for path in (ME, f"{ME}/{laptop.id}"):
        response = await agent_client.get(path)
        assert response.status_code == 403, path
        assert "session_count" not in response.text


async def test_session_count_is_not_found_like_any_route_when_companion_is_disabled(
    client, db_session, test_user, test_workspace, monkeypatch
):
    laptop = await add_installation(db_session, test_user)
    monkeypatch.setattr(settings, "COMPANION_ENABLED", False)

    never_existed = (await client.get("/api/no-such-route")).json()
    for path in (ME, f"{ME}/{laptop.id}"):
        response = await client.get(path)
        assert response.status_code == 404, path
        assert response.json() == never_existed
