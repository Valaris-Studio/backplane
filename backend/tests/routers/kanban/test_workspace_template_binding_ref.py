# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""A saved binding must return a ref the template APIs can resolve unchanged."""

from copy import deepcopy

import pytest
import pytest_asyncio

from app.models.kanban.board import Board
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole


CATALOG = "/api/workspaces/default/loop-templates"
SLOTS = {"PROJECT": "Roundtrip Project"}
CONTENT = {
    "system_prompt": "House rules for <<PROJECT>>.",
    "loop_prompt": "Advance <<PROJECT>>.",
    "slots": [{"name": "PROJECT", "kind": "scalar", "required": True}],
    "tools": ["mcp__valaris__get_card", "mcp__valaris__set_board_loop"],
}


def board_path(board):
    return f"/api/workspaces/default/boards/{board.id}"


@pytest_asyncio.fixture
async def published_binding(client, test_board):
    created = await client.post(CATALOG, json={
        "slug": "house-roundtrip", "name": "House Roundtrip", "content": CONTENT,
    })
    assert created.status_code == 201, created.text
    template_id = created.json()["id"]
    published = await client.post(f"{CATALOG}/{template_id}/publish", json={})
    assert published.status_code == 200, published.text
    saved = await client.put(f"{board_path(test_board)}/loop", json={
        "enabled": False,
        "template": {"source": "workspace", "ref": template_id, "slot_values": SLOTS},
    })
    assert saved.status_code == 200, saved.text
    assert saved.json()["system_prompt"] == "House rules for Roundtrip Project."
    return {"id": template_id, "saved": saved.json()}


@pytest.mark.parametrize("view", ["save", "loop", "binding"])
async def test_workspace_binding_public_ref_is_template_uuid(
    client, test_board, published_binding, view,
):
    if view == "save":
        body = published_binding["saved"]
    else:
        suffix = "/binding" if view == "binding" else ""
        response = await client.get(f"{board_path(test_board)}/loop{suffix}")
        assert response.status_code == 200, response.text
        body = response.json()
    assert body["template"]["source"] == "workspace"
    assert body["template"]["ref"] == published_binding["id"]
    assert body["template"]["version"] == 1
    assert body["template"]["drift"] == {"kind": "none"}


@pytest.mark.parametrize("consumer", [
    "detail", "workspace_preview", "board_preview", "fit", "policy_preview",
])
async def test_returned_workspace_binding_ref_roundtrips_template_consumers(
    client, db_session, test_board, published_binding, consumer,
):
    binding = await client.get(f"{board_path(test_board)}/loop/binding")
    assert binding.status_code == 200, binding.text
    returned = binding.json()["template"]
    # Deliberately use the actual returned ref, rather than the known good
    # create response UUID: that substitution concealed the browser failure.
    ref = returned["ref"]
    rehearsal = {"slot_values": SLOTS, "draft": False, "version": returned["version"]}
    before = deepcopy(test_board.loop_config)
    if consumer == "detail":
        response = await client.get(f"{CATALOG}/{ref}")
    elif consumer == "workspace_preview":
        response = await client.post(f"{CATALOG}/{ref}/preview", json=rehearsal)
    elif consumer in {"board_preview", "fit"}:
        suffix = "preview" if consumer == "board_preview" else "fit"
        response = await client.post(
            f"{board_path(test_board)}/loop-templates/{ref}/{suffix}", json=rehearsal,
        )
    else:
        response = await client.post(
            f"{board_path(test_board)}/completion/policy/preview", json={
                "policy": None, "loop_config": {"enabled": False},
                "template": {
                    "source": returned["source"], "ref": ref,
                    "version": returned["version"], "slot_values": SLOTS,
                },
            },
        )
    assert response.status_code == 200, response.text
    data = response.json()
    if consumer == "detail":
        assert data["id"] == published_binding["id"]
        assert data["slug"] == "house-roundtrip"
    elif consumer == "fit":
        assert data["template"]["ref"] == published_binding["id"]
    elif consumer == "policy_preview":
        assert data["template_preview"]["system_prompt"] == "House rules for Roundtrip Project."
        assert data["incompatibilities"] == []
    else:
        assert data["system_prompt"] == "House rules for Roundtrip Project."
    await db_session.refresh(test_board)
    assert test_board.loop_config == before


@pytest.mark.parametrize("consumer", ["detail", "preview", "fit", "bind"])
async def test_workspace_template_uuid_remains_invisible_to_other_workspace(
    client, db_session, test_user, published_binding, consumer,
):
    other = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(other)
    await db_session.flush()
    board = Board(workspace_id=other.id, name="Other", created_by=test_user.id)
    db_session.add_all([
        board,
        WorkspaceMember(workspace_id=other.id, user_id=test_user.id, role=WorkspaceRole.owner),
    ])
    await db_session.flush()
    ref = published_binding["id"]
    catalog = "/api/workspaces/other/loop-templates"
    board_url = f"/api/workspaces/other/boards/{board.id}"
    if consumer == "detail":
        response = await client.get(f"{catalog}/{ref}")
    elif consumer == "preview":
        response = await client.post(f"{catalog}/{ref}/preview", json={"slot_values": SLOTS})
    elif consumer == "fit":
        response = await client.post(f"{board_url}/loop-templates/{ref}/fit", json={"slot_values": SLOTS})
    else:
        response = await client.put(f"{board_url}/loop", json={"template": {
            "source": "workspace", "ref": ref, "slot_values": SLOTS,
        }})
    assert response.status_code == 404, response.text
    assert "House rules" not in response.text
    assert "house-roundtrip" not in response.text
