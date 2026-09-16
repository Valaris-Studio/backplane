# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole


BASE_URL = "/api/workspaces/default/boards"


async def test_list_boards_empty(client: AsyncClient, test_workspace: Workspace):
    response = await client.get(BASE_URL)
    assert response.status_code == 200
    assert response.json() == []


async def test_list_boards_returns_boards(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.get(BASE_URL)
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["id"] == str(test_board.id)
    assert data[0]["name"] == "Test Board"
    assert data[0]["description"] == "A test board"


async def test_list_boards_includes_stats(
    client: AsyncClient, test_workspace: Workspace
):
    created = await client.post(BASE_URL, json={"name": "Stats Board"})
    assert created.status_code == 201
    board_id = created.json()["id"]
    columns = (await client.get(f"{BASE_URL}/{board_id}")).json()["columns"]

    for title in ("Card A", "Card B"):
        response = await client.post(
            f"{BASE_URL}/{board_id}/cards",
            json={"title": title, "column_id": columns[0]["id"]},
        )
        assert response.status_code == 201

    response = await client.get(BASE_URL)
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["card_count"] == 2
    assert data[0]["column_count"] == 4
    # Card creation records board-scoped activity, so the freshness signal is set.
    assert data[0]["last_activity_at"] is not None


async def test_list_boards_stats_zero_for_empty_board(
    client: AsyncClient, test_workspace: Workspace
):
    created = await client.post(
        BASE_URL, json={"name": "Empty Board", "skip_default_columns": True}
    )
    assert created.status_code == 201

    response = await client.get(BASE_URL)
    data = response.json()
    assert data[0]["card_count"] == 0
    assert data[0]["column_count"] == 0


async def test_create_board_success(
    client: AsyncClient, test_workspace: Workspace, test_user: User
):
    response = await client.post(
        BASE_URL, json={"name": "New Board", "description": "A new board"}
    )
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "New Board"
    assert data["description"] == "A new board"
    assert data["created_by"] == str(test_user.id)
    assert data["workspace_id"] == str(test_workspace.id)

    # Verify the 4 default columns were created
    board_id = data["id"]
    detail = await client.get(f"{BASE_URL}/{board_id}")
    assert detail.status_code == 200
    columns = detail.json()["columns"]
    assert len(columns) == 4
    column_names = [c["name"] for c in columns]
    assert column_names == ["To Do", "In Progress", "Blocked", "Done"]
    column_colors = [c["color"] for c in columns]
    assert all(column_colors)
    assert len(set(column_colors)) == 4


async def test_create_board_minimal(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(BASE_URL, json={"name": "Minimal Board"})
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "Minimal Board"
    assert data["description"] == ""


async def test_create_board_skip_default_columns(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(
        BASE_URL, json={"name": "Custom Board", "skip_default_columns": True}
    )
    assert response.status_code == 201
    board_id = response.json()["id"]

    detail = await client.get(f"{BASE_URL}/{board_id}")
    assert detail.status_code == 200
    assert len(detail.json()["columns"]) == 0


async def test_create_board_default_columns_by_default(
    client: AsyncClient, test_workspace: Workspace
):
    """Verify backward compat: omitting skip_default_columns still creates defaults."""
    response = await client.post(BASE_URL, json={"name": "Default Board"})
    assert response.status_code == 201
    board_id = response.json()["id"]

    detail = await client.get(f"{BASE_URL}/{board_id}")
    assert detail.status_code == 200
    assert len(detail.json()["columns"]) == 4


async def test_create_board_seeds_typed_default_columns(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(BASE_URL, json={"name": "Typed Board"})
    assert response.status_code == 201
    board_id = response.json()["id"]

    detail = await client.get(f"{BASE_URL}/{board_id}")
    assert detail.status_code == 200
    columns = detail.json()["columns"]
    assert [(c["name"], c["column_type"]) for c in columns] == [
        ("To Do", "backlog"),
        ("In Progress", "active"),
        ("Blocked", "blocked"),
        ("Done", "done"),
    ]
    positions = [c["position"] for c in columns]
    assert all(a < b for a, b in zip(positions, positions[1:]))


async def test_create_board_response_includes_seeded_columns(
    client: AsyncClient, test_workspace: Workspace
):
    """The create response itself carries the seeded columns, so the frontend
    needs no follow-up column creation or extra fetch after POST."""
    response = await client.post(BASE_URL, json={"name": "Inline Columns"})
    assert response.status_code == 201
    body = response.json()
    assert [c["column_type"] for c in body.get("columns", [])] == [
        "backlog",
        "active",
        "blocked",
        "done",
    ]


async def test_get_board_detail(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
):
    response = await client.get(f"{BASE_URL}/{test_board.id}")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == str(test_board.id)
    assert data["name"] == "Test Board"

    assert "columns" in data
    assert len(data["columns"]) == 1
    col = data["columns"][0]
    assert col["id"] == str(test_column.id)
    assert col["name"] == "To Do"

    assert "cards" in col
    assert len(col["cards"]) == 1
    card = col["cards"][0]
    assert card["id"] == str(test_card.id)
    assert card["title"] == "Test Card"


async def test_get_board_not_found(client: AsyncClient, test_workspace: Workspace):
    fake_id = uuid.uuid4()
    response = await client.get(f"{BASE_URL}/{fake_id}")
    assert response.status_code == 404


async def test_get_board_wrong_workspace(
    client: AsyncClient,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    other_workspace = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(other_workspace)
    await db_session.flush()
    member = WorkspaceMember(
        workspace_id=other_workspace.id, user_id=test_user.id, role=WorkspaceRole.owner
    )
    db_session.add(member)
    await db_session.flush()

    # test_board belongs to "default" workspace, request via "other"
    response = await client.get(f"/api/workspaces/other/boards/{test_board.id}")
    assert response.status_code == 404


async def test_update_board_success(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.patch(
        f"{BASE_URL}/{test_board.id}",
        json={"name": "Updated Board", "description": "Updated description"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "Updated Board"
    assert data["description"] == "Updated description"
    assert data["id"] == str(test_board.id)


async def test_update_board_partial(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.patch(
        f"{BASE_URL}/{test_board.id}", json={"name": "Only Name Updated"}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "Only Name Updated"
    assert data["description"] == "A test board"


async def test_delete_board_success(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.delete(f"{BASE_URL}/{test_board.id}")
    assert response.status_code == 204

    # Verify board is gone
    response = await client.get(f"{BASE_URL}/{test_board.id}")
    assert response.status_code == 404


async def test_delete_board_with_cards(
    client: AsyncClient, test_workspace: Workspace, db_session: AsyncSession
):
    created = await client.post(BASE_URL, json={"name": "Populated Board"})
    assert created.status_code == 201
    board_id = created.json()["id"]
    columns = (await client.get(f"{BASE_URL}/{board_id}")).json()["columns"]

    for title in ("Card A", "Card B"):
        response = await client.post(
            f"{BASE_URL}/{board_id}/cards",
            json={"title": title, "column_id": columns[0]["id"]},
        )
        assert response.status_code == 201

    response = await client.delete(f"{BASE_URL}/{board_id}")
    assert response.status_code == 204

    response = await client.get(f"{BASE_URL}/{board_id}")
    assert response.status_code == 404

    column_count = await db_session.scalar(
        select(func.count()).select_from(Column).where(Column.board_id == uuid.UUID(board_id))
    )
    card_count = await db_session.scalar(
        select(func.count()).select_from(Card).where(Card.board_id == uuid.UUID(board_id))
    )
    assert column_count == 0
    assert card_count == 0


async def test_delete_board_with_parent_child_cards(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    parent = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title="Parent Card",
        position=1024.0,
        created_by=test_user.id,
    )
    db_session.add(parent)
    await db_session.flush()
    child = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title="Child Card",
        position=2048.0,
        created_by=test_user.id,
        parent_card_id=parent.id,
    )
    db_session.add(child)
    await db_session.flush()

    response = await client.delete(f"{BASE_URL}/{test_board.id}")
    assert response.status_code == 204

    card_count = await db_session.scalar(
        select(func.count()).select_from(Card).where(Card.board_id == test_board.id)
    )
    assert card_count == 0


async def test_delete_board_not_found(client: AsyncClient, test_workspace: Workspace):
    fake_id = uuid.uuid4()
    response = await client.delete(f"{BASE_URL}/{fake_id}")
    assert response.status_code == 404


async def test_create_board_has_tags_default(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(BASE_URL, json={"name": "No Tags Board"})
    assert response.status_code == 201
    data = response.json()
    assert data["tags"] == []


async def test_create_board_with_tags(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(
        BASE_URL, json={"name": "Tagged Board", "tags": ["frontend", "urgent"]}
    )
    assert response.status_code == 201
    data = response.json()
    assert data["tags"] == ["frontend", "urgent"]


async def test_update_board_tags(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.patch(
        f"{BASE_URL}/{test_board.id}",
        json={"tags": ["tag1", "tag2"]},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["tags"] == ["tag1", "tag2"]


async def test_update_board_clear_tags(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    # First set tags
    await client.patch(
        f"{BASE_URL}/{test_board.id}",
        json={"tags": ["tag1", "tag2"]},
    )
    # Then clear them
    response = await client.patch(
        f"{BASE_URL}/{test_board.id}",
        json={"tags": []},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["tags"] == []


async def test_board_tags_in_list(
    client: AsyncClient, test_workspace: Workspace
):
    await client.post(
        BASE_URL, json={"name": "Listed Board", "tags": ["v1", "sprint"]}
    )
    response = await client.get(BASE_URL)
    assert response.status_code == 200
    data = response.json()
    board = next(b for b in data if b["name"] == "Listed Board")
    assert board["tags"] == ["v1", "sprint"]


# --- slug tests ---


async def test_board_read_includes_slug(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(BASE_URL, json={"name": "Slugged Board"})
    assert response.status_code == 201
    assert "slug" in response.json()


async def test_create_board_auto_generates_slug_from_name(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(BASE_URL, json={"name": "My Cool Board"})
    assert response.status_code == 201
    assert response.json()["slug"] == "my-cool-board"


async def test_create_board_disambiguates_duplicate_slug(
    client: AsyncClient, test_workspace: Workspace
):
    first = await client.post(BASE_URL, json={"name": "Foo"})
    second = await client.post(BASE_URL, json={"name": "Foo"})
    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["slug"] == "foo"
    assert second.json()["slug"] == "foo-2"


async def test_create_board_accepts_user_slug(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(
        BASE_URL, json={"name": "Custom", "slug": "my-custom-slug"}
    )
    assert response.status_code == 201
    assert response.json()["slug"] == "my-custom-slug"


async def test_create_board_rejects_invalid_slug(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(
        BASE_URL, json={"name": "Bad", "slug": "Has Spaces!"}
    )
    assert response.status_code == 422


async def test_create_board_duplicate_user_slug_returns_existing(
    client: AsyncClient, test_workspace: Workspace
):
    first = await client.post(
        BASE_URL, json={"name": "First", "slug": "taken"}
    )
    assert first.status_code == 201
    first_id = first.json()["id"]

    second = await client.post(
        BASE_URL, json={"name": "Second Different", "slug": "taken"}
    )
    assert second.status_code in (200, 201)
    assert second.json()["id"] == first_id
    assert second.json()["slug"] == "taken"
    assert second.json()["name"] == "First"  # existing returned unchanged


async def test_get_board_by_slug(
    client: AsyncClient, test_workspace: Workspace
):
    created = await client.post(BASE_URL, json={"name": "By Slug"})
    slug = created.json()["slug"]

    response = await client.get(f"{BASE_URL}/{slug}")
    assert response.status_code == 200
    assert response.json()["id"] == created.json()["id"]
    assert response.json()["slug"] == slug


async def test_get_board_by_uuid_still_works(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.get(f"{BASE_URL}/{test_board.id}")
    assert response.status_code == 200
    assert response.json()["id"] == str(test_board.id)


async def test_get_board_by_slug_scoped_to_workspace(
    client: AsyncClient,
    test_user: User,
    test_workspace: Workspace,
    db_session: AsyncSession,
):
    other_workspace = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(other_workspace)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=other_workspace.id, user_id=test_user.id,
            role=WorkspaceRole.owner,
        )
    )
    await db_session.flush()

    created = await client.post(BASE_URL, json={"name": "Shared", "slug": "shared"})
    assert created.status_code == 201

    leaked = await client.get("/api/workspaces/other/boards/shared")
    assert leaked.status_code == 404


async def test_update_board_slug(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.patch(
        f"{BASE_URL}/{test_board.id}", json={"slug": "renamed-slug"}
    )
    assert response.status_code == 200
    assert response.json()["slug"] == "renamed-slug"


async def test_update_board_slug_conflict_returns_409(
    client: AsyncClient, test_workspace: Workspace
):
    a = await client.post(BASE_URL, json={"name": "Alpha", "slug": "alpha"})
    b = await client.post(BASE_URL, json={"name": "Beta", "slug": "beta"})
    assert a.status_code == 201 and b.status_code == 201

    response = await client.patch(
        f"{BASE_URL}/{b.json()['id']}", json={"slug": "alpha"}
    )
    assert response.status_code == 409


# --- done-merge-gate override (tri-state, admin-only field) ---


async def _demote_to_member(
    db_session: AsyncSession, workspace: Workspace, user: User
) -> None:
    await db_session.execute(
        WorkspaceMember.__table__.update()
        .where(
            WorkspaceMember.workspace_id == workspace.id,
            WorkspaceMember.user_id == user.id,
        )
        .values(role=WorkspaceRole.member)
    )
    await db_session.flush()


async def test_update_board_gate_override_admin_persists(
    client: AsyncClient, test_workspace: Workspace, test_board: Board,
    db_session: AsyncSession,
):
    response = await client.patch(
        f"{BASE_URL}/{test_board.id}", json={"enforce_done_merge_gate": False}
    )
    assert response.status_code == 200
    assert response.json()["enforce_done_merge_gate"] is False

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is False


async def test_update_board_gate_override_rejects_non_admin_member(
    client: AsyncClient, test_workspace: Workspace, test_board: Board,
    test_user: User, second_user: User, db_session: AsyncSession,
):
    """A plain member who did NOT create the board is still refused. Reparented
    to second_user because the caller (test_user) is test_board's creator, and
    creators have their own carve-out below (card B10 AC4)."""
    test_board.created_by = second_user.id
    await db_session.flush()
    await _demote_to_member(db_session, test_workspace, test_user)

    response = await client.patch(
        f"{BASE_URL}/{test_board.id}", json={"enforce_done_merge_gate": True}
    )
    assert response.status_code == 403
    assert response.json()["error_code"] == "admin_required"

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is None


async def test_update_board_gate_override_explicit_null_by_member_rejected(
    client: AsyncClient, test_workspace: Workspace, test_board: Board,
    test_user: User, second_user: User, db_session: AsyncSession,
):
    """An explicit null is a privileged change too: a member must not be able
    to clear an admin's override back to inherit. Pins the model_fields_set
    check — a `is not None` check would let this request through."""
    test_board.enforce_done_merge_gate = True
    test_board.created_by = second_user.id
    await db_session.flush()
    await _demote_to_member(db_session, test_workspace, test_user)

    response = await client.patch(
        f"{BASE_URL}/{test_board.id}", json={"enforce_done_merge_gate": None}
    )
    assert response.status_code == 403
    assert response.json()["error_code"] == "admin_required"

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is True


async def test_update_board_without_gate_field_still_open_to_members(
    client: AsyncClient, test_workspace: Workspace, test_board: Board,
    test_user: User, db_session: AsyncSession,
):
    """The admin bar is field-level, not endpoint-level."""
    await _demote_to_member(db_session, test_workspace, test_user)

    response = await client.patch(
        f"{BASE_URL}/{test_board.id}", json={"name": "Member Renamed"}
    )
    assert response.status_code == 200
    assert response.json()["name"] == "Member Renamed"


async def test_update_board_gate_override_explicit_null_clears(
    client: AsyncClient, test_workspace: Workspace, test_board: Board,
    db_session: AsyncSession,
):
    """Explicit null is a real change (clear to inherit), not an omission."""
    test_board.enforce_done_merge_gate = True
    await db_session.flush()

    response = await client.patch(
        f"{BASE_URL}/{test_board.id}", json={"enforce_done_merge_gate": None}
    )
    assert response.status_code == 200
    assert response.json()["enforce_done_merge_gate"] is None

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is None


async def test_update_board_omitting_gate_override_leaves_it_untouched(
    client: AsyncClient, test_workspace: Workspace, test_board: Board,
    db_session: AsyncSession,
):
    test_board.enforce_done_merge_gate = True
    await db_session.flush()

    response = await client.patch(
        f"{BASE_URL}/{test_board.id}", json={"name": "Untouched Override"}
    )
    assert response.status_code == 200
    assert response.json()["enforce_done_merge_gate"] is True

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is True


async def test_get_board_exposes_gate_override(
    client: AsyncClient, test_workspace: Workspace, test_board: Board,
    db_session: AsyncSession,
):
    response = await client.get(f"{BASE_URL}/{test_board.id}")
    assert response.status_code == 200
    assert response.json()["enforce_done_merge_gate"] is None

    test_board.enforce_done_merge_gate = False
    await db_session.flush()

    response = await client.get(f"{BASE_URL}/{test_board.id}")
    assert response.json()["enforce_done_merge_gate"] is False


async def test_update_board_gate_override_allows_the_boards_creator(
    client: AsyncClient, test_workspace: Workspace, test_board: Board,
    test_user: User, db_session: AsyncSession,
):
    """AC4. A first-time operator creates their own board and configures a
    self-merging loop on it; requiring a workspace admin to un-arm the gate
    they just armed is the trap this card removes. Scoped to the board they
    created — not a general member permission."""
    await _demote_to_member(db_session, test_workspace, test_user)
    assert test_board.created_by == test_user.id

    response = await client.patch(
        f"{BASE_URL}/{test_board.id}", json={"enforce_done_merge_gate": False}
    )
    assert response.status_code == 200, response.text
    assert response.json()["enforce_done_merge_gate"] is False

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is False


async def test_update_board_gate_override_creator_may_clear_to_inherit(
    client: AsyncClient, test_workspace: Workspace, test_board: Board,
    test_user: User, db_session: AsyncSession,
):
    """The carve-out is the FIELD, not one value of it: a creator who relaxed
    their board must be able to re-arm it without finding an admin."""
    test_board.enforce_done_merge_gate = False
    await db_session.flush()
    await _demote_to_member(db_session, test_workspace, test_user)

    response = await client.patch(
        f"{BASE_URL}/{test_board.id}", json={"enforce_done_merge_gate": None}
    )
    assert response.status_code == 200, response.text
    assert response.json()["enforce_done_merge_gate"] is None

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is None


async def test_update_board_gate_override_still_allows_admin_on_a_foreign_board(
    client: AsyncClient, test_workspace: Workspace, test_board: Board,
    second_user: User, db_session: AsyncSession,
):
    """Owner/admin is unchanged by the widening — it is an OR, not a swap."""
    test_board.created_by = second_user.id
    await db_session.flush()

    response = await client.patch(
        f"{BASE_URL}/{test_board.id}", json={"enforce_done_merge_gate": True}
    )
    assert response.status_code == 200, response.text
    assert response.json()["enforce_done_merge_gate"] is True


# --- agent-key callers on board PATCH (card 83602fbf) ---
#
# An agent API key resolves to its CREATING user, so an agent minted by the
# board's creator passes the creator carve-out above and can un-arm the very
# done-merge gate that governs its own self-merge behavior. Board PATCH must
# refuse agent keys outright — forbid_agent_callers on the whole route, like
# board DELETE and the loop-template mutations. The human field-level rules
# pinned above are unchanged.


async def test_update_board_gate_override_refuses_agent_key_of_board_creator(
    agent_client: AsyncClient, test_workspace: Workspace, test_board: Board,
    test_user: User, db_session: AsyncSession,
):
    """The hole itself: the agent's creating user is a plain MEMBER and the
    board's creator, so the only thing admitting this request today is the
    creator carve-out — which an agent key must never inherit. error_code
    pins the refusal as the agent ban, not admin_required (dropping the
    carve-out for humans would be the wrong fix)."""
    test_board.enforce_done_merge_gate = True
    await db_session.flush()
    await _demote_to_member(db_session, test_workspace, test_user)
    assert test_board.created_by == test_user.id

    response = await agent_client.patch(
        f"{BASE_URL}/{test_board.id}", json={"enforce_done_merge_gate": False}
    )
    assert response.status_code == 403, (
        "agent key un-armed the done-merge gate through the creator "
        f"carve-out: {response.status_code}: {response.text}"
    )
    assert response.json()["error_code"] == "forbidden"

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is True


async def test_update_board_gate_override_refuses_agent_key_of_owner(
    agent_client: AsyncClient, test_workspace: Workspace, test_board: Board,
    db_session: AsyncSession,
):
    """Like board delete: even an agent whose creating user is the workspace
    OWNER is refused — agents are banned from the route, not out-ranked."""
    test_board.enforce_done_merge_gate = True
    await db_session.flush()

    response = await agent_client.patch(
        f"{BASE_URL}/{test_board.id}", json={"enforce_done_merge_gate": False}
    )
    assert response.status_code == 403, (
        "owner-created agent key changed the done-merge gate: "
        f"{response.status_code}: {response.text}"
    )

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is True


async def test_update_board_refuses_agent_key_on_benign_fields(
    agent_client: AsyncClient, test_workspace: Workspace, test_board: Board,
    db_session: AsyncSession,
):
    """The ban is the ROUTE, not the gate field: a name-only PATCH from an
    agent key is refused too (option A — route-level forbid_agent_callers)."""
    response = await agent_client.patch(
        f"{BASE_URL}/{test_board.id}", json={"name": "Agent Renamed"}
    )
    assert response.status_code == 403, (
        "agent key renamed the board through PATCH: "
        f"{response.status_code}: {response.text}"
    )

    await db_session.refresh(test_board)
    assert test_board.name == "Test Board"
