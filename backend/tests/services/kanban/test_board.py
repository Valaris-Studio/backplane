# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ResourceNotFoundError
from app.models.kanban.board import Board
from app.models.kanban.column import ColumnType
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.kanban.board import BoardCreate, BoardUpdate
from app.services.kanban.board import BoardService


async def test_create_board(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = BoardService(db_session)
    data = BoardCreate(name="Sprint 1", description="First sprint")

    board = await service.create_board(test_workspace.id, data, test_user.id)

    assert board.name == "Sprint 1"
    assert board.description == "First sprint"
    assert board.workspace_id == test_workspace.id
    assert board.created_by == test_user.id


async def test_create_board_creates_default_columns(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = BoardService(db_session)
    data = BoardCreate(name="With Defaults")

    board = await service.create_board(test_workspace.id, data, test_user.id)
    full = await service.get_full_board(board.id, test_workspace.id)

    assert len(full.columns) == 4
    names = [c.name for c in full.columns]
    assert names == ["To Do", "In Progress", "Blocked", "Done"]


async def test_create_board_default_column_positions(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = BoardService(db_session)
    board = await service.create_board(
        test_workspace.id, BoardCreate(name="Positions"), test_user.id
    )
    full = await service.get_full_board(board.id, test_workspace.id)

    positions = [c.position for c in full.columns]
    assert len(positions) == 4
    assert all(a < b for a, b in zip(positions, positions[1:]))


async def test_create_board_default_columns_typed_and_colored(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = BoardService(db_session)
    board = await service.create_board(
        test_workspace.id, BoardCreate(name="Typed Defaults"), test_user.id
    )
    full = await service.get_full_board(board.id, test_workspace.id)

    types = [c.column_type for c in full.columns]
    assert types == [
        ColumnType.backlog,
        ColumnType.active,
        ColumnType.blocked,
        ColumnType.done,
    ]
    colors = [c.color for c in full.columns]
    assert all(colors)
    assert len(set(colors)) == 4


async def test_list_boards(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board
):
    service = BoardService(db_session)

    boards = await service.list_boards(test_workspace.id)

    assert any(b.id == test_board.id for b in boards)


async def test_list_boards_workspace_isolation(
    db_session: AsyncSession, test_board: Board
):
    service = BoardService(db_session)
    other_workspace_id = uuid.uuid4()

    boards = await service.list_boards(other_workspace_id)

    assert not any(b.id == test_board.id for b in boards)


async def test_get_full_board(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board
):
    service = BoardService(db_session)

    board = await service.get_full_board(test_board.id, test_workspace.id)

    assert board.id == test_board.id
    assert board.name == test_board.name


async def test_get_full_board_not_found(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = BoardService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.get_full_board(uuid.uuid4(), test_workspace.id)


async def test_get_full_board_wrong_workspace(
    db_session: AsyncSession, test_board: Board
):
    service = BoardService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.get_full_board(test_board.id, uuid.uuid4())


async def test_update_board(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board
):
    service = BoardService(db_session)
    data = BoardUpdate(name="Updated Name")

    updated = await service.update_board(test_board.id, test_workspace.id, data)

    assert updated.name == "Updated Name"
    assert updated.description == test_board.description


async def test_update_board_not_found(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = BoardService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.update_board(
            uuid.uuid4(), test_workspace.id, BoardUpdate(name="X")
        )


async def test_update_board_wrong_workspace(
    db_session: AsyncSession, test_board: Board
):
    service = BoardService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.update_board(
            test_board.id, uuid.uuid4(), BoardUpdate(name="X")
        )


async def test_delete_board(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = BoardService(db_session)
    board = await service.create_board(
        test_workspace.id, BoardCreate(name="Delete Me"), test_user.id
    )

    await service.delete_board(board.id, test_workspace.id)

    with pytest.raises(ResourceNotFoundError):
        await service.get_full_board(board.id, test_workspace.id)


async def test_delete_board_not_found(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = BoardService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.delete_board(uuid.uuid4(), test_workspace.id)


async def test_delete_board_wrong_workspace(
    db_session: AsyncSession, test_board: Board
):
    service = BoardService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.delete_board(test_board.id, uuid.uuid4())


async def test_create_board_with_tags(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = BoardService(db_session)
    data = BoardCreate(name="Tagged", tags=["backend", "api"])

    board = await service.create_board(test_workspace.id, data, test_user.id)

    assert board.tags == ["backend", "api"]


async def test_create_board_skip_default_columns(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = BoardService(db_session)
    data = BoardCreate(name="No Defaults", skip_default_columns=True)

    board = await service.create_board(test_workspace.id, data, test_user.id)
    full = await service.get_full_board(board.id, test_workspace.id)

    assert len(full.columns) == 0


async def test_create_board_default_tags(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = BoardService(db_session)
    data = BoardCreate(name="No Tags")

    board = await service.create_board(test_workspace.id, data, test_user.id)

    assert board.tags == []


async def test_update_board_tags(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board
):
    service = BoardService(db_session)
    data = BoardUpdate(tags=["new-tag", "sprint-1"])

    updated = await service.update_board(test_board.id, test_workspace.id, data)

    assert updated.tags == ["new-tag", "sprint-1"]


# --- Tests for enriched activity summaries ---


async def test_create_board_auto_slug(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = BoardService(db_session)
    board = await service.create_board(
        test_workspace.id, BoardCreate(name="Alpha One"), test_user.id
    )
    assert board.slug == "alpha-one"


async def test_create_board_disambiguates_slug_on_collision(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = BoardService(db_session)
    await service.create_board(
        test_workspace.id, BoardCreate(name="Foo"), test_user.id
    )
    second = await service.create_board(
        test_workspace.id, BoardCreate(name="Foo"), test_user.id
    )
    third = await service.create_board(
        test_workspace.id, BoardCreate(name="Foo"), test_user.id
    )
    assert second.slug == "foo-2"
    assert third.slug == "foo-3"


async def test_create_board_user_slug_collision_returns_existing(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = BoardService(db_session)
    first = await service.create_board(
        test_workspace.id, BoardCreate(name="A", slug="same"), test_user.id
    )
    second = await service.create_board(
        test_workspace.id, BoardCreate(name="B", slug="same"), test_user.id
    )
    assert first.id == second.id
    assert second.name == "A"


async def test_get_board_by_identifier_uuid(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board
):
    service = BoardService(db_session)
    board = await service.get_board_by_identifier(
        str(test_board.id), test_workspace.id
    )
    assert board.id == test_board.id


async def test_get_board_by_identifier_slug(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = BoardService(db_session)
    created = await service.create_board(
        test_workspace.id, BoardCreate(name="By Slug"), test_user.id
    )
    board = await service.get_board_by_identifier(created.slug, test_workspace.id)
    assert board.id == created.id


async def test_get_board_by_identifier_not_found(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = BoardService(db_session)
    with pytest.raises(ResourceNotFoundError):
        await service.get_board_by_identifier("ghost-board", test_workspace.id)


async def test_update_board_slug_conflict_raises(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    from app.exceptions import ConflictError

    service = BoardService(db_session)
    a = await service.create_board(
        test_workspace.id, BoardCreate(name="A", slug="a"), test_user.id
    )
    b = await service.create_board(
        test_workspace.id, BoardCreate(name="B", slug="b"), test_user.id
    )
    with pytest.raises(ConflictError):
        await service.update_board(
            b.id, test_workspace.id, BoardUpdate(slug=a.slug)
        )


async def test_update_board_enriched_summary(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    from app.models.activity import Activity, ActivityAction, ActivityEntityType
    from sqlalchemy import select

    service = BoardService(db_session)
    data = BoardUpdate(name="Renamed Board", description="New desc")

    await service.update_board(
        test_board.id, test_workspace.id, data, actor_id=test_user.id
    )

    result = await db_session.execute(
        select(Activity).where(Activity.action == ActivityAction.updated)
    )
    activities = list(result.scalars().all())
    assert len(activities) == 1
    a = activities[0]
    assert a.entity_type == ActivityEntityType.board
    assert a.entity_id == test_board.id
    assert "name" in a.summary
    assert "description" in a.summary
    assert set(a.changes["fields"]) == {"name", "description"}


# --- done-merge-gate override: service-level authorization ---


async def test_update_board_gate_override_requires_admin_role(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board
):
    from app.exceptions import ForbiddenError
    from app.models.workspace import WorkspaceRole

    service = BoardService(db_session)
    data = BoardUpdate(enforce_done_merge_gate=False)

    with pytest.raises(ForbiddenError) as exc:
        await service.update_board(
            test_board.id, test_workspace.id, data,
            actor_role=WorkspaceRole.member,
        )
    assert exc.value.error_code == "admin_required"
    assert test_board.enforce_done_merge_gate is None


async def test_update_board_gate_override_without_actor_role_denied(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board
):
    """No role supplied means an unattributed caller — never trusted with it."""
    from app.exceptions import ForbiddenError

    service = BoardService(db_session)

    with pytest.raises(ForbiddenError):
        await service.update_board(
            test_board.id, test_workspace.id,
            BoardUpdate(enforce_done_merge_gate=True),
        )


async def test_update_board_gate_override_allowed_for_admin_and_owner(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board
):
    from app.models.workspace import WorkspaceRole

    service = BoardService(db_session)

    updated = await service.update_board(
        test_board.id, test_workspace.id,
        BoardUpdate(enforce_done_merge_gate=True),
        actor_role=WorkspaceRole.admin,
    )
    assert updated.enforce_done_merge_gate is True

    updated = await service.update_board(
        test_board.id, test_workspace.id,
        BoardUpdate(enforce_done_merge_gate=False),
        actor_role=WorkspaceRole.owner,
    )
    assert updated.enforce_done_merge_gate is False


async def test_update_board_non_gate_fields_unaffected_by_role(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board
):
    from app.models.workspace import WorkspaceRole

    service = BoardService(db_session)
    updated = await service.update_board(
        test_board.id, test_workspace.id, BoardUpdate(name="Renamed"),
        actor_role=WorkspaceRole.member,
    )
    assert updated.name == "Renamed"
