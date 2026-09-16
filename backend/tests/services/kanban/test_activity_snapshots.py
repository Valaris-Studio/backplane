# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Phase-1 Board Timeline: per-call-site before/after snapshot enrichment.

These tests assert that every kanban mutation that records an Activity also
persists a role-agnostic `before_state` / `after_state` snapshot on that
Activity row, plus that column-reorder (which currently records NOTHING) starts
emitting an `updated` activity per moved column.

TDD RED: the `before_state` / `after_state` columns and the reorder activity do
not exist yet, so these fail today (missing attribute / no activity rows) — NOT
on import.

Snapshots are read back straight from the `activities` table to prove they were
persisted, not merely serialized.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.kanban.board import Board
from app.models.kanban.column import Column
from app.models.user import User
from app.schemas.kanban.card import CardCreate, CardMoveRequest, CardUpdate
from app.schemas.kanban.column import ColumnCreate, ColumnUpdate
from app.services.kanban.card import CardService
from app.services.kanban.column import ColumnService


async def _activities_for_entity(
    db: AsyncSession, entity_id: uuid.UUID, action: ActivityAction | None = None
) -> list[Activity]:
    stmt = (
        select(Activity)
        .where(Activity.entity_id == entity_id)
        .order_by(Activity.seq.asc())  # insertion order; created_at+id was random
    )
    if action is not None:
        stmt = stmt.where(Activity.action == action)
    result = await db.execute(stmt)
    return list(result.scalars().all())


# --------------------------------------------------------------------------- #
# Card create / update / move / delete                                         #
# --------------------------------------------------------------------------- #


async def test_create_card_records_after_snapshot_only(
    db_session: AsyncSession,
    test_workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    service = CardService(db_session)
    card = await service.create_card(
        test_board.id,
        CardCreate(title="Snap me", column_id=test_column.id),
        test_user.id,
        workspace_id=test_workspace.id,
    )

    acts = await _activities_for_entity(db_session, card.id, ActivityAction.created)
    assert len(acts) == 1
    act = acts[0]
    assert act.before_state is None
    assert act.after_state is not None
    assert act.after_state["id"] == str(card.id)
    assert act.after_state["title"] == "Snap me"
    assert act.after_state["column_id"] == str(test_column.id)
    # role-agnostic card snapshot shape
    assert act.after_state["participants"] == []
    assert "card_type" in act.after_state
    assert "priority" in act.after_state
    assert "position" in act.after_state
    assert "status" in act.after_state
    assert "labels" in act.after_state


async def test_update_card_records_before_and_after(
    db_session: AsyncSession,
    test_workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    service = CardService(db_session)
    card = await service.create_card(
        test_board.id,
        CardCreate(title="Original", column_id=test_column.id),
        test_user.id,
        workspace_id=test_workspace.id,
    )

    await service.update_card(
        card.id,
        test_board.id,
        CardUpdate(title="Renamed"),
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
    )

    acts = await _activities_for_entity(db_session, card.id, ActivityAction.updated)
    assert len(acts) == 1
    act = acts[0]
    assert act.before_state is not None
    assert act.after_state is not None
    assert act.before_state["title"] == "Original"
    assert act.after_state["title"] == "Renamed"
    # existing `changes` field preserved (snapshots are additive)
    assert act.changes == {"fields": ["title"]}


async def test_move_card_records_before_after_column_change(
    db_session: AsyncSession,
    test_workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    # Second non-done column so the agent done-gate never fires (human actor
    # anyway: no current_agent_id set in this service-level test).
    target = Column(board_id=test_board.id, name="Doing", position=2048.0)
    db_session.add(target)
    await db_session.flush()

    service = CardService(db_session)
    card = await service.create_card(
        test_board.id,
        CardCreate(title="Mover", column_id=test_column.id),
        test_user.id,
        workspace_id=test_workspace.id,
    )

    await service.move_card(
        card.id,
        test_board.id,
        CardMoveRequest(column_id=target.id, position=1024.0),
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
    )

    acts = await _activities_for_entity(db_session, card.id, ActivityAction.moved)
    assert len(acts) == 1
    act = acts[0]
    assert act.before_state is not None
    assert act.after_state is not None
    assert act.before_state["column_id"] == str(test_column.id)
    assert act.after_state["column_id"] == str(target.id)
    # existing machine-readable `changes` intact
    assert act.changes["column_id"]["old"] == str(test_column.id)
    assert act.changes["column_id"]["new"] == str(target.id)


async def test_delete_card_records_before_snapshot_only(
    db_session: AsyncSession,
    test_workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    service = CardService(db_session)
    card = await service.create_card(
        test_board.id,
        CardCreate(title="Doomed", column_id=test_column.id),
        test_user.id,
        workspace_id=test_workspace.id,
    )
    card_id = card.id

    await service.delete_card(
        card_id,
        test_board.id,
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
    )

    acts = await _activities_for_entity(db_session, card_id, ActivityAction.deleted)
    assert len(acts) == 1
    act = acts[0]
    assert act.after_state is None
    assert act.before_state is not None
    assert act.before_state["title"] == "Doomed"
    assert act.before_state["id"] == str(card_id)


# --------------------------------------------------------------------------- #
# Participants — role-agnostic snapshot (opaque role string, no enumeration)   #
# --------------------------------------------------------------------------- #


async def test_add_participant_records_participant_delta(
    db_session: AsyncSession,
    test_workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    second_user: User,
):
    service = CardService(db_session)
    card = await service.create_card(
        test_board.id,
        CardCreate(title="Team card", column_id=test_column.id),
        test_user.id,
        workspace_id=test_workspace.id,
    )

    await service.add_participant(
        card.id,
        test_board.id,
        second_user.id,
        role="helper",
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
        pipeline_role="implementer",
    )

    acts = await _activities_for_entity(db_session, card.id, ActivityAction.updated)
    # the add-participant record is the only `updated` activity on this card
    add_acts = [a for a in acts if a.after_state and a.after_state.get("participants")]
    assert len(add_acts) == 1
    act = add_acts[0]
    assert act.before_state is not None
    assert act.after_state is not None
    # before: no participants; after: exactly the added one
    assert act.before_state["participants"] == []
    parts = act.after_state["participants"]
    assert len(parts) == 1
    p = parts[0]
    assert p["user_id"] == str(second_user.id)
    # role-agnostic: the opaque pipeline-role string is passed through verbatim
    assert p["role"] == "implementer"
    assert "name" in p
    assert "avatar_url" in p
    assert "agent_id" in p


async def test_remove_participant_records_participant_delta(
    db_session: AsyncSession,
    test_workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    second_user: User,
):
    service = CardService(db_session)
    card = await service.create_card(
        test_board.id,
        CardCreate(title="Shrinking", column_id=test_column.id),
        test_user.id,
        workspace_id=test_workspace.id,
    )
    await service.add_participant(
        card.id,
        test_board.id,
        second_user.id,
        role="helper",
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
        pipeline_role="reviewer",
    )

    await service.remove_participant(
        card.id,
        test_board.id,
        second_user.id,
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
    )

    acts = await _activities_for_entity(db_session, card.id, ActivityAction.updated)
    # Select the removal by its content (second_user present before, gone after),
    # not by position: same-second activities used to sort by random uuid4 id.
    def _removed_second(a: Activity) -> bool:
        if not a.before_state or a.after_state is None:
            return False
        before = {p["user_id"] for p in a.before_state["participants"]}
        after = {p["user_id"] for p in a.after_state["participants"]}
        return str(second_user.id) in before and str(second_user.id) not in after

    removals = [a for a in acts if _removed_second(a)]
    assert len(removals) == 1
    act = removals[0]
    before_users = {p["user_id"] for p in act.before_state["participants"]}
    after_users = {p["user_id"] for p in act.after_state["participants"]}
    assert str(second_user.id) in before_users
    assert str(second_user.id) not in after_users


async def test_participant_role_is_opaque_string_not_enumerated(
    db_session: AsyncSession,
    test_workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    second_user: User,
):
    """A user-defined pipeline role (outside any fixed set) survives verbatim."""
    service = CardService(db_session)
    card = await service.create_card(
        test_board.id,
        CardCreate(title="Custom role", column_id=test_column.id),
        test_user.id,
        workspace_id=test_workspace.id,
    )
    await service.add_participant(
        card.id,
        test_board.id,
        second_user.id,
        role="helper",
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
        pipeline_role="ui_validator",  # not in any enumerated set
    )

    acts = await _activities_for_entity(db_session, card.id, ActivityAction.updated)
    add_acts = [a for a in acts if a.after_state and a.after_state.get("participants")]
    assert add_acts
    roles = {p["role"] for p in add_acts[-1].after_state["participants"]}
    assert "ui_validator" in roles


# --------------------------------------------------------------------------- #
# Columns — create / update / delete                                          #
# --------------------------------------------------------------------------- #


async def test_create_column_records_after_snapshot(
    db_session: AsyncSession,
    test_workspace,
    test_board: Board,
    test_user: User,
):
    service = ColumnService(db_session)
    column = await service.create_column(
        test_board.id,
        ColumnCreate(name="QA", color="#abc123"),
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
    )

    acts = await _activities_for_entity(db_session, column.id, ActivityAction.created)
    assert len(acts) == 1
    act = acts[0]
    assert act.before_state is None
    assert act.after_state is not None
    assert act.after_state["id"] == str(column.id)
    assert act.after_state["name"] == "QA"
    assert "column_type" in act.after_state
    assert "position" in act.after_state


async def test_update_column_records_before_after(
    db_session: AsyncSession,
    test_workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    service = ColumnService(db_session)
    await service.update_column(
        test_column.id,
        test_board.id,
        ColumnUpdate(name="Renamed Col"),
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
    )

    acts = await _activities_for_entity(db_session, test_column.id, ActivityAction.updated)
    assert len(acts) == 1
    act = acts[0]
    assert act.before_state is not None
    assert act.after_state is not None
    assert act.before_state["name"] == "To Do"
    assert act.after_state["name"] == "Renamed Col"
    assert act.changes == {"fields": ["name"]}


async def test_delete_column_records_before_snapshot(
    db_session: AsyncSession,
    test_workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    service = ColumnService(db_session)
    col_id = test_column.id
    await service.delete_column(
        col_id,
        test_board.id,
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
    )

    acts = await _activities_for_entity(db_session, col_id, ActivityAction.deleted)
    assert len(acts) == 1
    act = acts[0]
    assert act.after_state is None
    assert act.before_state is not None
    assert act.before_state["name"] == "To Do"


# --------------------------------------------------------------------------- #
# Column reorder — currently records NOTHING; must now emit per-column events  #
# --------------------------------------------------------------------------- #


async def test_reorder_columns_records_per_column_updates(
    db_session: AsyncSession,
    test_workspace,
    test_board: Board,
    test_user: User,
):
    service = ColumnService(db_session)
    a = await service.create_column(
        test_board.id, ColumnCreate(name="A"),
        workspace_id=test_workspace.id, actor_id=test_user.id,
    )
    b = await service.create_column(
        test_board.id, ColumnCreate(name="B"),
        workspace_id=test_workspace.id, actor_id=test_user.id,
    )
    c = await service.create_column(
        test_board.id, ColumnCreate(name="C"),
        workspace_id=test_workspace.id, actor_id=test_user.id,
    )

    # Reverse the order: C, B, A. Middle column B keeps its position → no event.
    await service.reorder_columns(
        test_board.id,
        [c.id, b.id, a.id],
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
    )

    # A and C changed position → one `updated` column activity each, with a
    # position-bearing before/after snapshot so the FE can fold the reorder.
    a_acts = await _activities_for_entity(db_session, a.id, ActivityAction.updated)
    c_acts = await _activities_for_entity(db_session, c.id, ActivityAction.updated)
    assert len(a_acts) == 1
    assert len(c_acts) == 1
    for act in (a_acts[0], c_acts[0]):
        assert act.entity_type == ActivityEntityType.column
        assert act.board_id == test_board.id
        assert act.before_state is not None
        assert act.after_state is not None
        assert act.before_state["position"] != act.after_state["position"]

    # B's position is unchanged (still the middle slot) → no reorder event.
    b_acts = await _activities_for_entity(db_session, b.id, ActivityAction.updated)
    assert b_acts == []


async def test_reorder_columns_no_actor_records_nothing(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
):
    """Reorder without workspace/actor context (legacy call) records no activity."""
    second = Column(board_id=test_board.id, name="Two", position=2048.0)
    db_session.add(second)
    await db_session.flush()

    service = ColumnService(db_session)
    await service.reorder_columns(test_board.id, [second.id, test_column.id])

    result = await db_session.execute(
        select(Activity).where(Activity.entity_type == ActivityEntityType.column)
    )
    assert list(result.scalars().all()) == []
