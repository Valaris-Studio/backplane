# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""DEP-2: DependencyService + DependencyRepository.

Service-layer cycle detection, workspace scoping, idempotency.
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ResourceNotFoundError, ValidationError
from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardDependency
from app.models.kanban.column import Column
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.services.kanban.dependencies import DependencyService


async def _make_card(
    db: AsyncSession, board: Board, column: Column, user: User, title: str
) -> Card:
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title=title,
        description="",
        position=1024.0,
        created_by=user.id,
    )
    db.add(card)
    await db.flush()
    return card


@pytest.mark.asyncio
async def test_add_dependency_creates_row(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    test_workspace: Workspace,
):
    a = await _make_card(db_session, test_board, test_column, test_user, "A")
    b = await _make_card(db_session, test_board, test_column, test_user, "B")
    service = DependencyService(db_session)

    dep = await service.add(
        workspace_id=test_workspace.id,
        card_id=a.id,
        depends_on_card_id=b.id,
        actor_id=test_user.id,
    )

    assert dep.card_id == a.id
    assert dep.depends_on_card_id == b.id
    assert dep.created_by == test_user.id


@pytest.mark.asyncio
async def test_add_dependency_idempotent_returns_existing(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    test_workspace: Workspace,
):
    a = await _make_card(db_session, test_board, test_column, test_user, "A")
    b = await _make_card(db_session, test_board, test_column, test_user, "B")
    service = DependencyService(db_session)

    first = await service.add(
        workspace_id=test_workspace.id,
        card_id=a.id,
        depends_on_card_id=b.id,
        actor_id=test_user.id,
    )
    second = await service.add(
        workspace_id=test_workspace.id,
        card_id=a.id,
        depends_on_card_id=b.id,
        actor_id=test_user.id,
    )

    assert second.created_at == first.created_at


@pytest.mark.asyncio
async def test_add_dependency_rejects_self(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    test_workspace: Workspace,
):
    a = await _make_card(db_session, test_board, test_column, test_user, "A")
    service = DependencyService(db_session)

    with pytest.raises(ValidationError) as exc:
        await service.add(
            workspace_id=test_workspace.id,
            card_id=a.id,
            depends_on_card_id=a.id,
            actor_id=test_user.id,
        )
    assert exc.value.error_code == "validation_error"


@pytest.mark.asyncio
async def test_add_dependency_rejects_direct_cycle(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    test_workspace: Workspace,
):
    a = await _make_card(db_session, test_board, test_column, test_user, "A")
    b = await _make_card(db_session, test_board, test_column, test_user, "B")
    service = DependencyService(db_session)

    await service.add(
        workspace_id=test_workspace.id,
        card_id=a.id,
        depends_on_card_id=b.id,
        actor_id=test_user.id,
    )

    # Adding B -> A now would close the 2-cycle.
    with pytest.raises(ValidationError) as exc:
        await service.add(
            workspace_id=test_workspace.id,
            card_id=b.id,
            depends_on_card_id=a.id,
            actor_id=test_user.id,
        )
    assert exc.value.error_code == "cycle_detected"


@pytest.mark.asyncio
async def test_add_dependency_rejects_transitive_cycle(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    test_workspace: Workspace,
):
    a = await _make_card(db_session, test_board, test_column, test_user, "A")
    b = await _make_card(db_session, test_board, test_column, test_user, "B")
    c = await _make_card(db_session, test_board, test_column, test_user, "C")
    service = DependencyService(db_session)

    await service.add(
        workspace_id=test_workspace.id,
        card_id=a.id,
        depends_on_card_id=b.id,
        actor_id=test_user.id,
    )
    await service.add(
        workspace_id=test_workspace.id,
        card_id=b.id,
        depends_on_card_id=c.id,
        actor_id=test_user.id,
    )

    # Now adding C -> A would create A -> B -> C -> A.
    with pytest.raises(ValidationError) as exc:
        await service.add(
            workspace_id=test_workspace.id,
            card_id=c.id,
            depends_on_card_id=a.id,
            actor_id=test_user.id,
        )
    assert exc.value.error_code == "cycle_detected"


@pytest.mark.asyncio
async def test_add_dependency_rejects_unknown_card(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    test_workspace: Workspace,
):
    import uuid

    a = await _make_card(db_session, test_board, test_column, test_user, "A")
    service = DependencyService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.add(
            workspace_id=test_workspace.id,
            card_id=a.id,
            depends_on_card_id=uuid.uuid4(),
            actor_id=test_user.id,
        )


@pytest.mark.asyncio
async def test_add_dependency_rejects_cross_workspace(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    test_workspace: Workspace,
):
    a = await _make_card(db_session, test_board, test_column, test_user, "A")

    other_ws = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(other_ws)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=other_ws.id, user_id=test_user.id, role=WorkspaceRole.owner
        )
    )
    await db_session.flush()
    other_board = Board(
        workspace_id=other_ws.id, name="O", slug="o", created_by=test_user.id
    )
    db_session.add(other_board)
    await db_session.flush()
    other_col = Column(board_id=other_board.id, name="X", position=1.0, color="#888")
    db_session.add(other_col)
    await db_session.flush()
    other_card = await _make_card(db_session, other_board, other_col, test_user, "O1")

    service = DependencyService(db_session)
    with pytest.raises(ResourceNotFoundError):
        await service.add(
            workspace_id=test_workspace.id,
            card_id=a.id,
            depends_on_card_id=other_card.id,
            actor_id=test_user.id,
        )


@pytest.mark.asyncio
async def test_remove_dependency_idempotent_when_missing(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    test_workspace: Workspace,
):
    a = await _make_card(db_session, test_board, test_column, test_user, "A")
    b = await _make_card(db_session, test_board, test_column, test_user, "B")
    service = DependencyService(db_session)
    # Deleting a non-existent edge is a 200/no-op.
    await service.remove(
        workspace_id=test_workspace.id, card_id=a.id, depends_on_card_id=b.id
    )


@pytest.mark.asyncio
async def test_list_dependencies_returns_bidirectional_view(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    test_workspace: Workspace,
):
    a = await _make_card(db_session, test_board, test_column, test_user, "A")
    b = await _make_card(db_session, test_board, test_column, test_user, "B")
    c = await _make_card(db_session, test_board, test_column, test_user, "C")
    service = DependencyService(db_session)
    await service.add(
        workspace_id=test_workspace.id, card_id=a.id,
        depends_on_card_id=b.id, actor_id=test_user.id,
    )
    await service.add(
        workspace_id=test_workspace.id, card_id=c.id,
        depends_on_card_id=a.id, actor_id=test_user.id,
    )

    view = await service.list_for_card(
        workspace_id=test_workspace.id, card_id=a.id
    )
    assert {d.depends_on_card_id for d in view.depends_on} == {b.id}
    assert {d.card_id for d in view.blocks} == {c.id}


@pytest.mark.asyncio
async def test_list_dependencies_enriches_depends_on_projection(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    test_workspace: Workspace,
):
    from app.models.kanban.column import ColumnType

    done_col = Column(
        board_id=test_board.id, name="Done", position=2048.0,
        color="#22c55e", column_type=ColumnType.done,
    )
    db_session.add(done_col)
    await db_session.flush()

    a = await _make_card(db_session, test_board, test_column, test_user, "A")
    b = await _make_card(db_session, test_board, done_col, test_user, "B")
    b.status = "shipped"
    await db_session.flush()
    service = DependencyService(db_session)
    await service.add(
        workspace_id=test_workspace.id, card_id=a.id,
        depends_on_card_id=b.id, actor_id=test_user.id,
    )

    view = await service.list_for_card(
        workspace_id=test_workspace.id, card_id=a.id
    )
    dep = view.depends_on[0]
    assert dep.depends_on_title == "B"
    assert dep.depends_on_status == "shipped"
    assert dep.depends_on_column_type == "done"


@pytest.mark.asyncio
async def test_list_dependencies_enriches_non_done_column_type(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    test_workspace: Workspace,
):
    from app.models.kanban.column import ColumnType

    active_col = Column(
        board_id=test_board.id, name="Active", position=1500.0,
        color="#3b82f6", column_type=ColumnType.active,
    )
    db_session.add(active_col)
    await db_session.flush()

    a = await _make_card(db_session, test_board, test_column, test_user, "A")
    b = await _make_card(db_session, test_board, active_col, test_user, "B")
    service = DependencyService(db_session)
    await service.add(
        workspace_id=test_workspace.id, card_id=a.id,
        depends_on_card_id=b.id, actor_id=test_user.id,
    )

    view = await service.list_for_card(
        workspace_id=test_workspace.id, card_id=a.id
    )
    dep = view.depends_on[0]
    assert dep.depends_on_title == "B"
    assert dep.depends_on_column_type == "active"


@pytest.mark.asyncio
async def test_list_dependencies_enriches_blocks_projection_with_dependent(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    test_workspace: Workspace,
):
    from app.models.kanban.column import ColumnType

    done_col = Column(
        board_id=test_board.id, name="Done", position=2048.0,
        color="#22c55e", column_type=ColumnType.done,
    )
    db_session.add(done_col)
    await db_session.flush()

    a = await _make_card(db_session, test_board, test_column, test_user, "A")
    # C is the dependent (C depends on A) and sits in Done.
    c = await _make_card(db_session, test_board, done_col, test_user, "C")
    c.status = "merged"
    await db_session.flush()
    service = DependencyService(db_session)
    await service.add(
        workspace_id=test_workspace.id, card_id=c.id,
        depends_on_card_id=a.id, actor_id=test_user.id,
    )

    view = await service.list_for_card(
        workspace_id=test_workspace.id, card_id=a.id
    )
    blk = view.blocks[0]
    assert blk.card_id == c.id
    # For the blocks direction the projection describes the dependent card
    # (the one rendered by the frontend), not the prerequisite.
    assert blk.depends_on_title == "C"
    assert blk.depends_on_status == "merged"
    assert blk.depends_on_column_type == "done"


@pytest.mark.asyncio
async def test_add_dependency_records_activity_event(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    test_workspace: Workspace,
):
    from app.models.activity import Activity, ActivityAction
    from sqlalchemy import select

    a = await _make_card(db_session, test_board, test_column, test_user, "A")
    b = await _make_card(db_session, test_board, test_column, test_user, "B")
    service = DependencyService(db_session)

    await service.add(
        workspace_id=test_workspace.id,
        card_id=a.id,
        depends_on_card_id=b.id,
        actor_id=test_user.id,
    )

    rows = (await db_session.execute(
        select(Activity).where(Activity.action == ActivityAction.dependency_added)
    )).scalars().all()
    assert len(rows) == 1
    assert rows[0].entity_id == a.id


@pytest.mark.asyncio
async def test_remove_dependency_records_activity_event(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    test_workspace: Workspace,
):
    from app.models.activity import Activity, ActivityAction
    from sqlalchemy import select

    a = await _make_card(db_session, test_board, test_column, test_user, "A")
    b = await _make_card(db_session, test_board, test_column, test_user, "B")
    service = DependencyService(db_session)
    await service.add(
        workspace_id=test_workspace.id, card_id=a.id,
        depends_on_card_id=b.id, actor_id=test_user.id,
    )
    await service.remove(
        workspace_id=test_workspace.id, card_id=a.id, depends_on_card_id=b.id,
        actor_id=test_user.id,
    )

    rows = (await db_session.execute(
        select(Activity).where(Activity.action == ActivityAction.dependency_removed)
    )).scalars().all()
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_bulk_set_records_dependencies_replaced_event(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    test_workspace: Workspace,
):
    from app.models.activity import Activity, ActivityAction
    from sqlalchemy import select

    a = await _make_card(db_session, test_board, test_column, test_user, "A")
    b = await _make_card(db_session, test_board, test_column, test_user, "B")
    c = await _make_card(db_session, test_board, test_column, test_user, "C")
    service = DependencyService(db_session)

    await service.bulk_set(
        workspace_id=test_workspace.id, card_id=a.id,
        depends_on_card_ids=[b.id, c.id], actor_id=test_user.id,
    )

    rows = (await db_session.execute(
        select(Activity).where(Activity.action == ActivityAction.dependencies_replaced)
    )).scalars().all()
    assert len(rows) == 1
    assert rows[0].message_key == "activity.card.dependencies_replaced"
    assert rows[0].message_params == {"dependency_count": 2}


@pytest.mark.asyncio
async def test_bulk_set_dependencies_replaces_atomically(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    test_workspace: Workspace,
):
    a = await _make_card(db_session, test_board, test_column, test_user, "A")
    b = await _make_card(db_session, test_board, test_column, test_user, "B")
    c = await _make_card(db_session, test_board, test_column, test_user, "C")
    d = await _make_card(db_session, test_board, test_column, test_user, "D")
    service = DependencyService(db_session)
    await service.add(
        workspace_id=test_workspace.id, card_id=a.id,
        depends_on_card_id=b.id, actor_id=test_user.id,
    )

    # Replace deps of A: drop B, add C+D.
    await service.bulk_set(
        workspace_id=test_workspace.id, card_id=a.id,
        depends_on_card_ids=[c.id, d.id], actor_id=test_user.id,
    )

    view = await service.list_for_card(
        workspace_id=test_workspace.id, card_id=a.id
    )
    assert {dep.depends_on_card_id for dep in view.depends_on} == {c.id, d.id}


@pytest.mark.asyncio
async def test_add_dependency_activity_names_target_card_title(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    test_workspace: Workspace,
):
    """Activity rows must carry the prerequisite's title so the feed can
    render "added dependency on 'Ship billing'" instead of a raw card id."""
    from app.models.activity import Activity, ActivityAction
    from sqlalchemy import select

    a = await _make_card(db_session, test_board, test_column, test_user, "A")
    b = await _make_card(
        db_session, test_board, test_column, test_user, "Ship billing"
    )
    service = DependencyService(db_session)

    await service.add(
        workspace_id=test_workspace.id,
        card_id=a.id,
        depends_on_card_id=b.id,
        actor_id=test_user.id,
    )

    row = (await db_session.execute(
        select(Activity).where(Activity.action == ActivityAction.dependency_added)
    )).scalar_one()
    assert row.message_key == "activity.card.dependency_added"
    assert row.message_params.get("depends_on_title") == "Ship billing"
    assert row.message_params["depends_on_card_id"] == str(b.id)
    assert "Ship billing" in row.summary
    assert str(b.id) not in row.summary


@pytest.mark.asyncio
async def test_remove_dependency_activity_names_target_card_title(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    test_workspace: Workspace,
):
    from app.models.activity import Activity, ActivityAction
    from sqlalchemy import select

    a = await _make_card(db_session, test_board, test_column, test_user, "A")
    b = await _make_card(
        db_session, test_board, test_column, test_user, "Ship billing"
    )
    service = DependencyService(db_session)
    await service.add(
        workspace_id=test_workspace.id, card_id=a.id,
        depends_on_card_id=b.id, actor_id=test_user.id,
    )
    await service.remove(
        workspace_id=test_workspace.id, card_id=a.id, depends_on_card_id=b.id,
        actor_id=test_user.id,
    )

    row = (await db_session.execute(
        select(Activity).where(Activity.action == ActivityAction.dependency_removed)
    )).scalar_one()
    assert row.message_key == "activity.card.dependency_removed"
    assert row.message_params.get("depends_on_title") == "Ship billing"
    assert row.message_params["depends_on_card_id"] == str(b.id)
    assert "Ship billing" in row.summary
    assert str(b.id) not in row.summary


@pytest.mark.asyncio
async def test_dependency_activity_summaries_fit_the_column_with_a_max_length_title(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    test_workspace: Workspace,
):
    """Card.title and Activity.summary are both String(500): a max-length
    title plus the verb overflows on Postgres (StringDataRightTruncation rolls
    back the edge). SQLite stores the overflow silently, so this pins the
    LENGTH of what the service records rather than the round-trip."""
    from app.models.activity import Activity, ActivityAction
    from sqlalchemy import select

    max_title = "T" * 500
    a = await _make_card(db_session, test_board, test_column, test_user, "A")
    b = await _make_card(db_session, test_board, test_column, test_user, max_title)
    service = DependencyService(db_session)

    await service.add(
        workspace_id=test_workspace.id, card_id=a.id,
        depends_on_card_id=b.id, actor_id=test_user.id,
    )
    await service.remove(
        workspace_id=test_workspace.id, card_id=a.id, depends_on_card_id=b.id,
        actor_id=test_user.id,
    )

    rows = (await db_session.execute(
        select(Activity).where(
            Activity.action.in_(
                [ActivityAction.dependency_added, ActivityAction.dependency_removed]
            )
        )
    )).scalars().all()
    assert len(rows) == 2
    for row in rows:
        assert len(row.summary) <= 500, (row.action, len(row.summary))
        # The structured param is the localized row's source of truth and
        # has no width cap (JSON) — it must keep the full title.
        assert row.message_params["depends_on_title"] == max_title
