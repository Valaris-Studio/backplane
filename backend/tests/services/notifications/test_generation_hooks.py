# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Phase 2 (RED) — generation hooked into the REAL mutation paths.

These exercise the actual services (CardService.move_card,
NoteService.create_note, ApprovalService.create_approval/.decide) and assert
that durable notification rows appear as a side effect — the INV-2 "two source
paths" wiring from docs/notification-system-contract.md. They are RED until the
implementer:
  - hooks generation into ActivityService.record() / ApprovalService, and
  - (for card_comment) enriches the note activity `changes` with card_id
    (contract §"Open items — RESOLVED": card_comment note→card linkage).

Driving the real events (not the mapping table) per the task brief: the
category↔(entity_type, action) map is implementation; we assert the OUTCOME.

Marked @pytest.mark.slow where a test spins the full service stack (>500ms is
plausible under the parallel gate).
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent, AgentType
from app.models.approvals.approval import ApprovalCategory, ApprovalStatus
from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardParticipant
from app.models.kanban.column import Column
from app.models.notifications.notification import Notification
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.schemas.approvals.approval import ApprovalCreate, ApprovalDecide
from app.schemas.kanban.card import CardMoveRequest
from app.schemas.notes.note import NoteCreate
from app.services.activity import ActivityService
from app.services.approvals.approval import ApprovalService
from app.services.kanban.card import CardService
from app.services.notes.note import NoteService


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
async def _make_user(db: AsyncSession, email: str) -> User:
    user = User(email=email, name=email.split("@")[0])
    db.add(user)
    await db.flush()
    return user


async def _add_member(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID,
    role: WorkspaceRole = WorkspaceRole.member,
) -> None:
    db.add(WorkspaceMember(workspace_id=workspace_id, user_id=user_id, role=role))
    await db.flush()


async def _add_column(db: AsyncSession, board_id: uuid.UUID, name: str, position: float) -> Column:
    column = Column(board_id=board_id, name=name, position=position, color="#6b7280")
    db.add(column)
    await db.flush()
    return column


async def _participant(
    db: AsyncSession, card_id: uuid.UUID, user_id: uuid.UUID, role: str = "helper"
) -> None:
    db.add(CardParticipant(card_id=card_id, user_id=user_id, role=role))
    await db.flush()


async def _rows_for(db: AsyncSession, user_id: uuid.UUID, category: str | None = None) -> list[Notification]:
    stmt = select(Notification).where(Notification.recipient_user_id == user_id)
    if category is not None:
        stmt = stmt.where(Notification.category == category)
    return list((await db.execute(stmt)).scalars().all())


async def _all_rows(db: AsyncSession) -> list[Notification]:
    return list((await db.execute(select(Notification))).scalars().all())


# --------------------------------------------------------------------------- #
# F. move a card → participants get card_participant_changed, actor does not
# --------------------------------------------------------------------------- #
@pytest.mark.slow
async def test_move_card_notifies_participant_not_actor(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board,
    test_column: Column, test_card: Card, test_user: User,
):
    """test_user (actor) moves a card on which second user participates →
    second user gets exactly one card_participant_changed row carrying the
    right workspace/board/actor/link; the actor gets none."""
    other = await _make_user(db_session, "follower@valaris.dev")
    await _participant(db_session, test_card.id, test_user.id, role="hero")
    await _participant(db_session, test_card.id, other.id, role="helper")

    target = await _add_column(db_session, test_board.id, "In Progress", 2048.0)

    service = CardService(db_session)
    await service.move_card(
        test_card.id,
        test_board.id,
        CardMoveRequest(column_id=target.id, position=1024.0),
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
    )

    rows = await _rows_for(db_session, other.id, category="card_participant_changed")
    assert len(rows) == 1
    row = rows[0]
    assert row.workspace_id == test_workspace.id
    assert row.board_id == test_board.id
    assert row.actor_id == test_user.id
    assert row.params  # non-empty structured params
    assert row.link is not None and row.link.get("card_id") == str(test_card.id)

    assert len(await _rows_for(db_session, test_user.id)) == 0


@pytest.mark.slow
async def test_move_card_no_other_participants_creates_zero(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board,
    test_column: Column, test_user: User,
):
    """Negative paired with a positive control so it can't pass vacuously
    (before generation is wired everything is zero). Two cards moved by the same
    actor: the watched card (has another participant) MUST get a row; the lonely
    card (only the actor participates) MUST get none."""
    other = await _make_user(db_session, "watched-card-follower@valaris.dev")

    watched = Card(
        board_id=test_board.id, column_id=test_column.id, title="Watched",
        description="", position=1024.0, created_by=test_user.id,
    )
    lonely = Card(
        board_id=test_board.id, column_id=test_column.id, title="Lonely",
        description="", position=2048.0, created_by=test_user.id,
    )
    db_session.add_all([watched, lonely])
    await db_session.flush()
    await _participant(db_session, watched.id, test_user.id, role="hero")
    await _participant(db_session, watched.id, other.id, role="helper")
    await _participant(db_session, lonely.id, test_user.id, role="hero")

    target = await _add_column(db_session, test_board.id, "In Progress", 4096.0)
    service = CardService(db_session)
    for card in (watched, lonely):
        await service.move_card(
            card.id,
            test_board.id,
            CardMoveRequest(column_id=target.id, position=1024.0),
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
        )

    # Positive control: the watched card produced a row for `other`.
    assert len(await _rows_for(db_session, other.id, category="card_participant_changed")) == 1
    # Negative: the lonely card produced none — the only rows in the DB belong
    # to the watched card's follower.
    rows = await _all_rows(db_session)
    assert {r.entity_id for r in rows} == {watched.id}


# --------------------------------------------------------------------------- #
# F. create a note on a participated card → card_comment
#    (RED until the implementer enriches the note activity changes with card_id)
# --------------------------------------------------------------------------- #
@pytest.mark.slow
async def test_create_card_note_notifies_participant(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board,
    test_card: Card, test_user: User,
):
    """A card-scoped note creates a card_comment notification for the card's
    other participant. Depends on the note activity carrying card_id."""
    other = await _make_user(db_session, "commenter-target@valaris.dev")
    await _participant(db_session, test_card.id, test_user.id, role="hero")
    await _participant(db_session, test_card.id, other.id, role="helper")

    service = NoteService(db_session)
    await service.create_note(
        workspace_id=test_workspace.id,
        data=NoteCreate(
            title="A comment",
            content="Looks good, one nit.",
            card_id=test_card.id,
        ),
        user_id=test_user.id,
        board_id=test_board.id,
    )

    rows = await _rows_for(db_session, other.id, category="card_comment")
    assert len(rows) == 1
    assert rows[0].actor_id == test_user.id
    assert len(await _rows_for(db_session, test_user.id)) == 0


@pytest.mark.slow
async def test_workspace_level_note_creates_no_card_comment(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board,
    test_column: Column, test_card: Card, test_user: User,
):
    """Negative paired with a positive control so it can't pass vacuously. The
    same author writes two notes: a CARD-scoped note (positive — must create a
    card_comment for the card's other participant) and a WORKSPACE-level note
    with no card_id (negative — must create no card_comment)."""
    other = await _make_user(db_session, "ws-note-watcher@valaris.dev")
    await _add_member(db_session, test_workspace.id, other.id)
    await _participant(db_session, test_card.id, test_user.id, role="hero")
    await _participant(db_session, test_card.id, other.id, role="helper")

    service = NoteService(db_session)
    # Positive control: card-scoped note.
    await service.create_note(
        workspace_id=test_workspace.id,
        data=NoteCreate(title="On the card", content="nit", card_id=test_card.id),
        user_id=test_user.id,
        board_id=test_board.id,
    )
    # Negative: workspace-level note (no card_id).
    await service.create_note(
        workspace_id=test_workspace.id,
        data=NoteCreate(title="Team memo", content="FYI", card_id=None),
        user_id=test_user.id,
        board_id=None,
    )

    rows = await _rows_for(db_session, other.id, category="card_comment")
    # Exactly one card_comment — from the card note, not the workspace note.
    assert len(rows) == 1
    assert rows[0].entity_id == test_card.id


# --------------------------------------------------------------------------- #
# F. create an approval (pending) → workspace admin/owner gets approval_requested
# --------------------------------------------------------------------------- #
@pytest.mark.slow
async def test_create_pending_approval_notifies_admin(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User,
):
    """A pending approval notifies a workspace admin/owner who is waiting to
    decide. Setup: the agent is created_by a DIFFERENT user, so the
    approval_requested recipient (the admin) is distinct from the agent owner."""
    agent_owner = await _make_user(db_session, "agent-owner@valaris.dev")
    await _add_member(db_session, test_workspace.id, agent_owner.id)
    # test_user is the workspace OWNER (per the test_workspace fixture).

    agent = Agent(
        name="risky-agent",
        agent_type=AgentType.coding,
        created_by_id=agent_owner.id,
        is_active=True,
    )
    db_session.add(agent)
    await db_session.flush()

    service = ApprovalService(db_session)
    approval = await service.create_approval(
        test_workspace.id,
        ApprovalCreate(
            agent_id=agent.id,
            category=ApprovalCategory.deployment,  # high risk → pending, not auto-approved
            action_description="Deploy to production",
            action_payload={"environment": "production"},
            board_id=test_board.id,
        ),
    )
    assert approval.status == ApprovalStatus.pending

    rows = await _rows_for(db_session, test_user.id, category="approval_requested")
    assert len(rows) == 1
    assert rows[0].workspace_id == test_workspace.id


@pytest.mark.slow
async def test_decide_approval_notifies_agent_owner(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User,
):
    """Deciding (approve) an approval notifies the agent's owner
    (created_by_id) with approval_decided — distinct from the deciding admin."""
    agent_owner = await _make_user(db_session, "decided-owner@valaris.dev")
    await _add_member(db_session, test_workspace.id, agent_owner.id)

    agent = Agent(
        name="awaiting-agent",
        agent_type=AgentType.coding,
        created_by_id=agent_owner.id,
        is_active=True,
    )
    db_session.add(agent)
    await db_session.flush()

    service = ApprovalService(db_session)
    approval = await service.create_approval(
        test_workspace.id,
        ApprovalCreate(
            agent_id=agent.id,
            category=ApprovalCategory.deployment,
            action_description="Deploy to production",
            action_payload={"environment": "production"},
            board_id=test_board.id,
        ),
    )
    assert approval.status == ApprovalStatus.pending

    # test_user (workspace owner) decides.
    await service.decide(
        approval.id,
        test_workspace.id,
        test_user.id,
        ApprovalDecide(decision=ApprovalStatus.approved, reason="ok"),
    )

    rows = await _rows_for(db_session, agent_owner.id, category="approval_decided")
    assert len(rows) == 1
    assert rows[0].workspace_id == test_workspace.id


# --------------------------------------------------------------------------- #
# G. no-regression sentinel — an unmapped event is a safe no-op
# --------------------------------------------------------------------------- #
@pytest.mark.slow
async def test_unmapped_activity_is_safe_noop(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board,
    test_column: Column, test_card: Card, test_user: User,
):
    """Paired positive/negative so it can't pass vacuously. A MAPPED event (a
    card move with another participant) must generate exactly one row; an
    UNMAPPED event (column.created) recorded right after must add nothing and
    must not raise — generation is a safe no-op for events with no category."""
    from app.models.activity import ActivityAction, ActivityEntityType

    other = await _make_user(db_session, "noop-control@valaris.dev")
    await _participant(db_session, test_card.id, test_user.id, role="hero")
    await _participant(db_session, test_card.id, other.id, role="helper")

    target = await _add_column(db_session, test_board.id, "In Progress", 2048.0)
    card_service = CardService(db_session)
    await card_service.move_card(
        test_card.id,
        test_board.id,
        CardMoveRequest(column_id=target.id, position=1024.0),
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
    )
    # Positive control: the mapped move generated one row.
    assert len(await _all_rows(db_session)) == 1

    # Unmapped event: must not raise and must not add a row.
    activity = ActivityService(db_session)
    await activity.record(
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
        entity_type=ActivityEntityType.column,
        entity_id=uuid.uuid4(),
        action=ActivityAction.created,
        board_id=test_board.id,
        summary="created column 'To Do'",
    )

    # Still exactly one — the unmapped event was a no-op.
    assert len(await _all_rows(db_session)) == 1
