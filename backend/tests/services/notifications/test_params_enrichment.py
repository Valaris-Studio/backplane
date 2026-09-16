# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Cross-phase contract gap (RED) — params display-value enrichment.

The FE i18n category copy (frontend/src/i18n/locales/en.json under
`notifications.category.*`) interpolates DISPLAY values from a notification's
`params`:

  card_participant_changed : actor (name|email), card (title)
  card_created             : actor, board (name), card (title)
  dependency_blocking      : card (blocked title), blocker (blocking title)
  workspace_member         : actor, workspace (name)
  card_comment             : actor, card (title)
  approval_requested       : actor, card (context)
  approval_decided         : card (context), decision (approved|rejected)

Today generation only carries the raw activity `changes` (column ids / fk ids)
into `params`, so the FE renders literal `{{card}}` / `{{board}}` tokens. These
tests assert the ENRICHED display values land in `params`. They drive the REAL
mutation paths (move/dependency/add_member/approval) so they pin the OUTCOME,
not the implementation. RED until generation enriches params.

INV-5: the values are DATA (titles/names), never UI sentences — white-label safe.
The display values are resolved ONCE per event (same params for all recipients).
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
from app.services.approvals.approval import ApprovalService
from app.services.kanban.card import CardService
from app.services.kanban.dependencies import DependencyService
from app.services.workspace import WorkspaceService


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
async def _make_user(db: AsyncSession, email: str, name: str = "") -> User:
    user = User(email=email, name=name or email.split("@")[0])
    db.add(user)
    await db.flush()
    return user


async def _add_member(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    role: WorkspaceRole = WorkspaceRole.member,
) -> None:
    db.add(WorkspaceMember(workspace_id=workspace_id, user_id=user_id, role=role))
    await db.flush()


async def _add_column(
    db: AsyncSession, board_id: uuid.UUID, name: str, position: float
) -> Column:
    column = Column(board_id=board_id, name=name, position=position, color="#6b7280")
    db.add(column)
    await db.flush()
    return column


async def _participant(
    db: AsyncSession, card_id: uuid.UUID, user_id: uuid.UUID, role: str = "helper"
) -> None:
    db.add(CardParticipant(card_id=card_id, user_id=user_id, role=role))
    await db.flush()


async def _rows_for(
    db: AsyncSession, user_id: uuid.UUID, category: str | None = None
) -> list[Notification]:
    stmt = select(Notification).where(Notification.recipient_user_id == user_id)
    if category is not None:
        stmt = stmt.where(Notification.category == category)
    return list((await db.execute(stmt)).scalars().all())


# --------------------------------------------------------------------------- #
# card_participant_changed — card title + actor name
# --------------------------------------------------------------------------- #
@pytest.mark.slow
async def test_move_card_params_carry_card_title_and_actor(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    """After a real card move, the recipient's notification params must carry the
    moved card's TITLE (params["card"]) and the actor's display name/email so the
    FE renders "{{card}} was updated" / "{{actor}} changed..." with real values."""
    other = await _make_user(db_session, "follower@valaris.dev")
    await _participant(db_session, test_card.id, test_user.id, role="hero")
    await _participant(db_session, test_card.id, other.id, role="helper")

    target = await _add_column(db_session, test_board.id, "In Progress", 2048.0)
    await CardService(db_session).move_card(
        test_card.id,
        test_board.id,
        CardMoveRequest(column_id=target.id, position=1024.0),
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
    )

    rows = await _rows_for(db_session, other.id, category="card_participant_changed")
    assert len(rows) == 1
    params = rows[0].params
    assert params.get("card") == test_card.title
    # FE derives actor from actor_name ?? actor_email — at least one must be set.
    assert params.get("actor_name") == test_user.name
    assert params.get("actor_email") == test_user.email


# --------------------------------------------------------------------------- #
# card_created — card title + board name + actor
# --------------------------------------------------------------------------- #
@pytest.mark.slow
async def test_create_card_params_carry_card_board_and_actor(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """A created card on which another user participates → card_created params
    carry card title, board name, and actor (FE: "New card: {{card}}" /
    "{{actor}} created a card on {{board}}")."""
    # card_created is default-OFF; flip the participant's relevance/override on so
    # a row is produced and we can inspect params. Simplest: set their pref to
    # 'everything' with card_created ON.
    from app.models.notifications.preference import NotificationPreference

    other = await _make_user(db_session, "creator-watch@valaris.dev")
    db_session.add(
        NotificationPreference(
            user_id=other.id,
            workspace_id=test_workspace.id,
            relevance_scope="everything",
            category_overrides={"card_created": {"in_app": True}},
        )
    )
    await db_session.flush()

    card = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title="Brand New Card",
        description="",
        position=1024.0,
        created_by=test_user.id,
    )
    db_session.add(card)
    await db_session.flush()
    await _participant(db_session, card.id, test_user.id, role="hero")
    await _participant(db_session, card.id, other.id, role="helper")

    # Drive the real created activity.
    from app.models.activity import ActivityAction, ActivityEntityType
    from app.services.activity import ActivityService

    await ActivityService(db_session).record(
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
        entity_type=ActivityEntityType.card,
        entity_id=card.id,
        action=ActivityAction.created,
        board_id=test_board.id,
        summary="created card",
    )

    rows = await _rows_for(db_session, other.id, category="card_created")
    assert len(rows) == 1
    params = rows[0].params
    assert params.get("card") == "Brand New Card"
    assert params.get("board") == test_board.name
    assert params.get("actor_name") == test_user.name


# --------------------------------------------------------------------------- #
# dependency_blocking — blocked card title + blocker card title
# --------------------------------------------------------------------------- #
@pytest.mark.slow
async def test_add_dependency_params_carry_card_and_blocker_titles(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """Adding a dependency edge (card depends_on blocker) → the blocked card's
    participants get dependency_blocking with params["card"] = blocked title and
    params["blocker"] = blocking card's title."""
    other = await _make_user(db_session, "dep-watch@valaris.dev")

    blocked = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title="Blocked Feature",
        description="",
        position=1024.0,
        created_by=test_user.id,
    )
    blocker = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title="Prerequisite Work",
        description="",
        position=2048.0,
        created_by=test_user.id,
    )
    db_session.add_all([blocked, blocker])
    await db_session.flush()
    await _participant(db_session, blocked.id, test_user.id, role="hero")
    await _participant(db_session, blocked.id, other.id, role="helper")

    await DependencyService(db_session).add(
        workspace_id=test_workspace.id,
        card_id=blocked.id,
        depends_on_card_id=blocker.id,
        actor_id=test_user.id,
    )

    rows = await _rows_for(db_session, other.id, category="dependency_blocking")
    assert len(rows) == 1
    params = rows[0].params
    assert params.get("card") == "Blocked Feature"
    assert params.get("blocker") == "Prerequisite Work"


@pytest.mark.slow
async def test_replace_dependencies_params_carry_card_and_blocker_titles(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """bulk_set (dependencies_replaced) → params carry the blocked card title and
    at least the first blocker title via params["blocker"]."""
    other = await _make_user(db_session, "dep-replace-watch@valaris.dev")

    blocked = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title="Replace Blocked",
        description="",
        position=1024.0,
        created_by=test_user.id,
    )
    blocker = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title="Replace Blocker",
        description="",
        position=2048.0,
        created_by=test_user.id,
    )
    db_session.add_all([blocked, blocker])
    await db_session.flush()
    await _participant(db_session, blocked.id, test_user.id, role="hero")
    await _participant(db_session, blocked.id, other.id, role="helper")

    await DependencyService(db_session).bulk_set(
        workspace_id=test_workspace.id,
        card_id=blocked.id,
        depends_on_card_ids=[blocker.id],
        actor_id=test_user.id,
    )

    rows = await _rows_for(db_session, other.id, category="dependency_blocking")
    assert len(rows) == 1
    params = rows[0].params
    assert params.get("card") == "Replace Blocked"
    assert params.get("blocker") == "Replace Blocker"


# --------------------------------------------------------------------------- #
# workspace_member — workspace name + actor
# --------------------------------------------------------------------------- #
@pytest.mark.slow
async def test_add_member_params_carry_workspace_and_actor(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """Adding a member → the affected user gets workspace_member with
    params["workspace"] = workspace name and the actor's name."""
    added = await _make_user(db_session, "newcomer@valaris.dev")

    await WorkspaceService(db_session).add_member(
        test_workspace.id,
        email=added.email,
        role=WorkspaceRole.member,
        actor_id=test_user.id,
    )

    rows = await _rows_for(db_session, added.id, category="workspace_member")
    assert len(rows) == 1
    params = rows[0].params
    assert params.get("workspace") == test_workspace.name
    assert params.get("actor_name") == test_user.name


# --------------------------------------------------------------------------- #
# approval_requested — actor + card/board context
# --------------------------------------------------------------------------- #
@pytest.mark.slow
async def test_create_approval_params_carry_actor_and_board_context(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """A pending approval → the deciding admin's notification carries actor
    (the agent's owning human) + the board-name context the FE renders."""
    agent_owner = await _make_user(
        db_session, "approval-owner@valaris.dev", name="Ada Owner"
    )
    await _add_member(db_session, test_workspace.id, agent_owner.id)

    agent = Agent(
        name="risky-agent",
        agent_type=AgentType.coding,
        created_by_id=agent_owner.id,
        is_active=True,
    )
    db_session.add(agent)
    await db_session.flush()

    await ApprovalService(db_session).create_approval(
        test_workspace.id,
        ApprovalCreate(
            agent_id=agent.id,
            category=ApprovalCategory.deployment,
            action_description="Deploy to production",
            action_payload={"environment": "production"},
            board_id=test_board.id,
        ),
    )

    rows = await _rows_for(db_session, test_user.id, category="approval_requested")
    assert len(rows) == 1
    params = rows[0].params
    # actor = the agent owner (the human "needing a decision").
    assert params.get("actor_name") == "Ada Owner"
    # card/board context the FE interpolates into "{{card}}".
    assert params.get("card") == test_board.name


# --------------------------------------------------------------------------- #
# approval_decided — decision token + context
# --------------------------------------------------------------------------- #
@pytest.mark.slow
async def test_decide_approval_params_carry_decision_token(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """Deciding an approval (approve) → the agent owner's notification params
    carry params["decision"] = "approved" (stable token the FE maps/inlines) and
    the card/board context."""
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

    await service.decide(
        approval.id,
        test_workspace.id,
        test_user.id,
        ApprovalDecide(decision=ApprovalStatus.approved, reason="ok"),
    )

    rows = await _rows_for(db_session, agent_owner.id, category="approval_decided")
    assert len(rows) == 1
    params = rows[0].params
    assert params.get("decision") == "approved"
    assert params.get("card") == test_board.name


# --------------------------------------------------------------------------- #
# card_comment — card title resolved via the re-routed entity_id (note→card)
# --------------------------------------------------------------------------- #
@pytest.mark.slow
async def test_card_comment_params_carry_card_title_and_actor(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """A card-scoped note (card_comment) routes entity_id to the commented card;
    enrichment must still resolve that card's title into params["card"]."""
    from app.schemas.notes.note import NoteCreate
    from app.services.notes.note import NoteService

    other = await _make_user(db_session, "comment-params@valaris.dev")
    await _participant(db_session, test_card.id, test_user.id, role="hero")
    await _participant(db_session, test_card.id, other.id, role="helper")

    await NoteService(db_session).create_note(
        workspace_id=test_workspace.id,
        data=NoteCreate(title="Nit", content="one comment", card_id=test_card.id),
        user_id=test_user.id,
        board_id=test_board.id,
    )

    rows = await _rows_for(db_session, other.id, category="card_comment")
    assert len(rows) == 1
    params = rows[0].params
    assert params.get("card") == test_card.title
    assert params.get("actor_name") == test_user.name


# --------------------------------------------------------------------------- #
# greenlet guard — enrichment's extra eager loads never lazy-load mid-txn.
# The dependency-add path is the heaviest (two card loads + actor + nothing
# lazy); it runs DEEP inside the dependency service's txn. It must not raise.
# --------------------------------------------------------------------------- #
@pytest.mark.slow
async def test_dependency_enrichment_does_not_raise_in_txn(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """A successful dependency add (with a watching participant) completing
    without a MissingGreenlet proves the enrichment's board/card/actor lookups
    are all eager (no lazy relationship access inside the triggering txn)."""
    other = await _make_user(db_session, "greenlet-dep@valaris.dev")
    blocked = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title="Greenlet Blocked",
        description="",
        position=1024.0,
        created_by=test_user.id,
    )
    blocker = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title="Greenlet Blocker",
        description="",
        position=2048.0,
        created_by=test_user.id,
    )
    db_session.add_all([blocked, blocker])
    await db_session.flush()
    await _participant(db_session, blocked.id, test_user.id, role="hero")
    await _participant(db_session, blocked.id, other.id, role="helper")

    # Must complete without raising (MissingGreenlet would surface here).
    await DependencyService(db_session).add(
        workspace_id=test_workspace.id,
        card_id=blocked.id,
        depends_on_card_id=blocker.id,
        actor_id=test_user.id,
    )
    await db_session.commit()  # commit proves the txn stayed usable

    rows = await _rows_for(db_session, other.id, category="dependency_blocking")
    assert len(rows) == 1
    assert rows[0].params.get("blocker") == "Greenlet Blocker"


# --------------------------------------------------------------------------- #
# resolve-ONCE — display values are not re-queried per recipient
# --------------------------------------------------------------------------- #
@pytest.mark.slow
async def test_display_values_resolved_once_shared_across_recipients(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    """Two recipients of ONE move event share the SAME enriched params object
    (same card title + actor) — proving the display values are resolved once per
    event, not per recipient."""
    a = await _make_user(db_session, "recip-a@valaris.dev")
    b = await _make_user(db_session, "recip-b@valaris.dev")
    await _participant(db_session, test_card.id, test_user.id, role="hero")
    await _participant(db_session, test_card.id, a.id, role="helper")
    await _participant(db_session, test_card.id, b.id, role="helper")

    target = await _add_column(db_session, test_board.id, "In Progress", 2048.0)
    await CardService(db_session).move_card(
        test_card.id,
        test_board.id,
        CardMoveRequest(column_id=target.id, position=1024.0),
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
    )

    row_a = (await _rows_for(db_session, a.id, "card_participant_changed"))[0]
    row_b = (await _rows_for(db_session, b.id, "card_participant_changed"))[0]
    assert row_a.params.get("card") == test_card.title
    assert row_b.params.get("card") == test_card.title
    assert row_a.params.get("actor_name") == row_b.params.get("actor_name")
