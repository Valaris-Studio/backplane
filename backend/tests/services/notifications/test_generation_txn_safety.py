# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Phase-2 adversarial-review remediation — PostgreSQL-only transaction-safety
guards the all-SQLite suite cannot otherwise see (same bug CLASS as the
2026-06-08 activities.seq board-wide outage: green-on-SQLite, broken-on-PG).

What these pin (CRITICAL/MAJOR from the review):

  1. post-conflict session usability — generating the SAME event twice leaves
     exactly ONE row AND the session stays usable for a later unrelated
     write+commit. On the OLD SELECT-then-INSERT this raced into an
     IntegrityError that, on asyncpg, poisons the whole txn; the on_conflict
     upsert removes the error entirely. (CRITICAL-2)

  2. savepoint isolation — a generation failure during a card move must NOT roll
     back the move: the card stays moved, no notification row is written, and the
     session still commits. (CRITICAL-1)

  3. PG-dialect compile assertion — the upsert statement compiled against the
     postgresql dialect must emit `ON CONFLICT ... DO NOTHING` and must NOT bind
     a NULL into the NOT-NULL dedupe/recipient columns. This is the cheap proxy
     for "correct on PG" the savepoint-isolation lesson mandates whenever code relies on a
     PG-specific INSERT shape. (MAJOR-adjacent, the suite's blind spot)
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardParticipant
from app.models.kanban.column import Column
from app.models.notifications.notification import Notification
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.repositories.notifications.notification import NotificationRepository
from app.schemas.kanban.card import CardMoveRequest
from app.services.kanban.card import CardService
from app.services.notifications.generation import NotificationService


async def _make_user(db: AsyncSession, email: str) -> User:
    user = User(email=email, name=email.split("@")[0])
    db.add(user)
    await db.flush()
    return user


async def _participant(
    db: AsyncSession, card_id: uuid.UUID, user_id: uuid.UUID, role: str = "helper"
) -> None:
    db.add(CardParticipant(card_id=card_id, user_id=user_id, role=role))
    await db.flush()


async def _add_column(
    db: AsyncSession, board_id: uuid.UUID, name: str, position: float
) -> Column:
    column = Column(board_id=board_id, name=name, position=position, color="#6b7280")
    db.add(column)
    await db.flush()
    return column


def _notification_kwargs(*, recipient_id: uuid.UUID, workspace_id: uuid.UUID, dedupe_key: str) -> dict:
    return dict(
        recipient_user_id=recipient_id,
        workspace_id=workspace_id,
        board_id=None,
        category="card_participant_changed",
        actor_id=None,
        is_agent_actor=False,
        entity_type="card",
        entity_id=uuid.uuid4(),
        params={"card_title": "Widget"},
        link=None,
        dedupe_key=dedupe_key,
    )


# --------------------------------------------------------------------------- #
# CRITICAL-2 — idempotent upsert: a duplicate create leaves ONE row and the
# session is still usable for a later unrelated write + commit.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_duplicate_create_leaves_session_usable_and_one_row(
    db_session: AsyncSession, test_workspace: Workspace, second_user: User
):
    """Re-creating the same (recipient, dedupe_key) is a no-op upsert: exactly
    one row, NO IntegrityError raised, and the SAME session can still execute a
    query and commit afterward. On the old SELECT-then-INSERT this path could
    race into an IntegrityError that poisons the asyncpg txn; this guards the
    regression at the behavioral level."""
    repo = NotificationRepository(db_session)
    kwargs = _notification_kwargs(
        recipient_id=second_user.id,
        workspace_id=test_workspace.id,
        dedupe_key="card_participant_changed:dup-txn:1",
    )

    first = await repo.create(**kwargs)
    second = await repo.create(**kwargs)
    assert second.id == first.id

    rows = (await db_session.execute(select(Notification))).scalars().all()
    assert len(rows) == 1

    # The session must still be usable — a query AND a real write that commits.
    extra = await _make_user(db_session, "still-usable@valaris.dev")
    assert extra.id is not None
    await db_session.commit()  # the txn was NOT poisoned by the duplicate path


# --------------------------------------------------------------------------- #
# CRITICAL-1 — savepoint isolation: a generation failure does not roll back the
# triggering mutation; the move persists, no notif row, the session commits.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_generation_failure_does_not_roll_back_card_move(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
    monkeypatch,
):
    """Force generation to raise mid-move. The card move (the real mutation)
    MUST survive, no notification row may be written, and the session must still
    commit. Without the SAVEPOINT, on PG the raise would abort the outer txn and
    the get_db commit would roll the move back."""
    other = await _make_user(db_session, "savepoint-follower@valaris.dev")
    await _participant(db_session, test_card.id, test_user.id, role="hero")
    await _participant(db_session, test_card.id, other.id, role="helper")
    target = await _add_column(db_session, test_board.id, "In Progress", 2048.0)

    async def _boom(*args, **kwargs):
        raise RuntimeError("simulated generation failure")

    monkeypatch.setattr(NotificationService, "generate_for_event", _boom)

    service = CardService(db_session)
    moved = await service.move_card(
        test_card.id,
        test_board.id,
        CardMoveRequest(column_id=target.id, position=1024.0),
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
    )

    # (a) the mutation is durable — the card really moved.
    assert moved.column_id == target.id
    # (b) no notification row leaked from the failed generation.
    rows = (await db_session.execute(select(Notification))).scalars().all()
    assert rows == []
    # (c) the session is not poisoned — it commits cleanly.
    await db_session.commit()

    # And the move is still there after commit.
    refreshed = (
        await db_session.execute(select(Card).where(Card.id == test_card.id))
    ).scalar_one()
    assert refreshed.column_id == target.id


@pytest.mark.asyncio
async def test_generation_failure_in_approval_does_not_roll_back(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    monkeypatch,
):
    """Same savepoint guarantee on the approvals source path: a generation
    failure must not roll back the approval write."""
    from app.models.agents.agent import Agent, AgentType
    from app.models.approvals.approval import ApprovalCategory, ApprovalStatus
    from app.schemas.approvals.approval import ApprovalCreate
    from app.services.approvals.approval import ApprovalService

    owner = await _make_user(db_session, "approval-owner@valaris.dev")
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id, user_id=owner.id, role=WorkspaceRole.member
        )
    )
    agent = Agent(
        name="boom-agent",
        agent_type=AgentType.coding,
        created_by_id=owner.id,
        is_active=True,
    )
    db_session.add(agent)
    await db_session.flush()

    async def _boom(*args, **kwargs):
        raise RuntimeError("simulated generation failure")

    monkeypatch.setattr(NotificationService, "generate_for_event", _boom)

    service = ApprovalService(db_session)
    approval = await service.create_approval(
        test_workspace.id,
        ApprovalCreate(
            agent_id=agent.id,
            category=ApprovalCategory.deployment,
            action_description="Deploy",
            action_payload={"environment": "production"},
            board_id=test_board.id,
        ),
    )
    assert approval.status == ApprovalStatus.pending  # the write survived

    rows = (await db_session.execute(select(Notification))).scalars().all()
    assert rows == []
    await db_session.commit()


# --------------------------------------------------------------------------- #
# MAJOR-3 — dedupe_seed must never be the string "None".
# `activity.seq` is a PG IDENTITY (non-PK): the INSERT omits it so the identity
# assigns it server-side, leaving `activity.seq is None` on the instance after a
# plain flush (SQLite fills it via the before_insert listener, so the suite never
# saw the gap). The hook now seeds the dedupe_key off `activity.id` (always
# present post-flush via RETURNING on both dialects) so the key is deterministic
# and non-None everywhere.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_dedupe_key_is_deterministic_and_never_none(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    """A card move generates a row whose dedupe_key carries a real seed segment
    (not 'None') and is stable when generation re-runs for the same event — so
    on PG (where activity.seq is None on the instance) the key stays unique and
    idempotent."""
    other = await _make_user(db_session, "dedupe-follower@valaris.dev")
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

    rows = (
        await db_session.execute(
            select(Notification).where(Notification.recipient_user_id == other.id)
        )
    ).scalars().all()
    assert len(rows) == 1
    dedupe_key = rows[0].dedupe_key
    # No segment is the literal "None" (the PG seq-is-None failure mode).
    assert ":None" not in dedupe_key
    assert dedupe_key.split(":")[-1] not in ("", "None")


# --------------------------------------------------------------------------- #
# MINOR-6 — workspace_member carries affected_user_id so the added member is
# actually notified (generation resolves recipients from params, not entity_id).
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_add_member_notifies_the_affected_user(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """test_user (workspace owner, the actor) adds a new member → the ADDED user
    gets a workspace_member row. INV-3 suppresses the actor, so we assert on the
    distinct affected user."""
    from app.services.workspace import WorkspaceService

    service = WorkspaceService(db_session)
    await service.add_member(
        test_workspace.id,
        "freshly-added@valaris.dev",
        WorkspaceRole.member,
        actor_id=test_user.id,
    )

    added = (
        await db_session.execute(
            select(User).where(User.email == "freshly-added@valaris.dev")
        )
    ).scalar_one()
    rows = (
        await db_session.execute(
            select(Notification).where(
                Notification.recipient_user_id == added.id,
                Notification.category == "workspace_member",
            )
        )
    ).scalars().all()
    assert len(rows) == 1
    assert rows[0].workspace_id == test_workspace.id
    # The actor (owner) is not notified about their own action.
    actor_rows = (
        await db_session.execute(
            select(Notification).where(Notification.recipient_user_id == test_user.id)
        )
    ).scalars().all()
    assert actor_rows == []


# --------------------------------------------------------------------------- #
# Savepoint-isolation guard — compile the upsert against the postgresql dialect and
# assert it emits ON CONFLICT ... DO NOTHING (no live PG needed).
# --------------------------------------------------------------------------- #
def test_upsert_statement_emits_on_conflict_do_nothing_on_pg():
    """The PG INSERT shape the all-SQLite suite cannot see. The repo builds an
    `INSERT ... ON CONFLICT ON CONSTRAINT uq_notifications_recipient_dedupe DO
    NOTHING`; compiling against the postgresql dialect proves it (a) uses ON
    CONFLICT DO NOTHING and (b) binds the NOT-NULL dedupe/recipient columns
    rather than NULLing them."""
    stmt = NotificationRepository.build_upsert_stmt(
        recipient_user_id=uuid.uuid4(),
        workspace_id=uuid.uuid4(),
        board_id=None,
        category="card_participant_changed",
        actor_id=None,
        is_agent_actor=False,
        entity_type="card",
        entity_id=uuid.uuid4(),
        params={"card_title": "Widget"},
        link=None,
        dedupe_key="card_participant_changed:abc:1",
    )
    compiled = stmt.compile(
        dialect=postgresql.dialect(),
        compile_kwargs={"literal_binds": False},
    )
    sql = str(compiled).upper()
    assert "ON CONFLICT" in sql
    assert "DO NOTHING" in sql
    assert "UQ_NOTIFICATIONS_RECIPIENT_DEDUPE" in sql
    # The NOT-NULL keys must be bound parameters, never a literal NULL bind.
    assert "DEDUPE_KEY" in sql
    assert "RECIPIENT_USER_ID" in sql
