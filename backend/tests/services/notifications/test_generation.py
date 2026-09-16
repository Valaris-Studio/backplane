# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Phase 2 (RED) — NotificationService.generate_for_event.

Drives the generation service DIRECTLY (not through the activity/approval hooks
— those live in test_generation_hooks.py). Pins the contract invariants from
docs/notification-system-contract.md §"Generation flow":

  recipients = resolve_recipients(category, workspace, board, entity)  # relevance
  recipients -= {actor_id}                                             # INV-3
  for user in recipients:
      eff = resolve_prefs(user, workspace)
      if muted/off for (category, channel): skip
      upsert_notification(dedupe_key=...)                              # INV-6

INTERFACE ASSUMPTION (per the task brief, contract §"Generation flow"):
Phase 2 ships `app/services/notifications/generation.py` with a service class
exposing the keyword-only coroutine
  generate_for_event(db, *, workspace_id, board_id, category, actor_id,
                     is_agent_actor, entity_type, entity_id, dedupe_seed,
                     params, link)
We accept the class being named `NotificationService` or
`NotificationGenerationService`; the helper below resolves whichever exists.
Importing the module is the RED proof — until generation.py exists collection
fails and every test here is reported missing-implementation.

Recipient resolution for card_* categories = the card's participant user_ids
(loaded via the eager CardRepository.get_by_id). We build cards + participants
directly so the test exercises the real resolver, not a mock.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardParticipant
from app.models.kanban.column import Column
from app.models.notifications.notification import Notification
from app.models.notifications.preference import NotificationPreference
from app.models.user import User
from app.models.workspace import Workspace

# Collection-time RED: until generation.py exists this import errors.
from app.services.notifications import generation as gen_mod


def _service(db: AsyncSession):
    cls = getattr(gen_mod, "NotificationService", None) or getattr(
        gen_mod, "NotificationGenerationService"
    )
    return cls(db)


async def _generate(db, **kwargs):
    """Call generate_for_event with the contract keyword signature, filling
    sensible defaults for fields a given test doesn't care about."""
    svc = _service(db)
    payload = dict(
        board_id=None,
        is_agent_actor=False,
        entity_type="card",
        params={},
        link=None,
    )
    payload.update(kwargs)
    return await svc.generate_for_event(db, **payload)


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


async def _notifications_for(db: AsyncSession, user_id: uuid.UUID) -> list[Notification]:
    rows = await db.execute(
        select(Notification).where(Notification.recipient_user_id == user_id)
    )
    return list(rows.scalars().all())


async def _all_notifications(db: AsyncSession) -> list[Notification]:
    rows = await db.execute(select(Notification))
    return list(rows.scalars().all())


# --------------------------------------------------------------------------- #
# B. recipient resolution + INV-3 (never notify the actor)
# --------------------------------------------------------------------------- #
async def test_card_participant_changed_notifies_other_participants_not_actor(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_card: Card,
    test_user: User,
):
    """Card with participants [A(hero), B, C]; actor=C moves it → A & B get a
    card_participant_changed row, C (the actor) does NOT (INV-3)."""
    user_b = await _make_user(db_session, "b@valaris.dev")
    user_c = await _make_user(db_session, "c@valaris.dev")
    await _participant(db_session, test_card.id, test_user.id, role="hero")
    await _participant(db_session, test_card.id, user_b.id)
    await _participant(db_session, test_card.id, user_c.id)

    await _generate(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        category="card_participant_changed",
        actor_id=user_c.id,
        entity_type="card",
        entity_id=test_card.id,
        dedupe_seed="seq-1",
    )

    assert len(await _notifications_for(db_session, test_user.id)) == 1
    assert len(await _notifications_for(db_session, user_b.id)) == 1
    assert len(await _notifications_for(db_session, user_c.id)) == 0


async def test_card_assigned_notifies_added_user_not_actor(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_card: Card,
    test_user: User,
):
    """card_assigned: A (actor, hero) adds B → B gets a row, A does not."""
    user_b = await _make_user(db_session, "added@valaris.dev")
    await _participant(db_session, test_card.id, test_user.id, role="hero")
    await _participant(db_session, test_card.id, user_b.id, role="helper")

    await _generate(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        category="card_assigned",
        actor_id=test_user.id,
        entity_type="card",
        entity_id=test_card.id,
        dedupe_seed="assign-1",
    )

    assert len(await _notifications_for(db_session, user_b.id)) == 1
    assert len(await _notifications_for(db_session, test_user.id)) == 0


async def test_actor_never_notified_even_when_category_on_for_them(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_card: Card,
    test_user: User,
):
    """INV-3 hard guarantee: the actor is a participant AND has the category ON
    (default) — they still get zero rows."""
    await _participant(db_session, test_card.id, test_user.id, role="hero")

    await _generate(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        category="card_participant_changed",
        actor_id=test_user.id,
        entity_type="card",
        entity_id=test_card.id,
        dedupe_seed="self-1",
    )

    assert len(await _notifications_for(db_session, test_user.id)) == 0
    assert len(await _all_notifications(db_session)) == 0


async def test_card_with_no_other_participants_creates_zero(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_card: Card,
    test_user: User,
):
    """Only the actor participates → nobody to notify → zero rows."""
    await _participant(db_session, test_card.id, test_user.id, role="hero")

    await _generate(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        category="card_participant_changed",
        actor_id=test_user.id,
        entity_type="card",
        entity_id=test_card.id,
        dedupe_seed="lonely-1",
    )

    assert len(await _all_notifications(db_session)) == 0


# --------------------------------------------------------------------------- #
# Row shape: the generated notification carries the contract fields
# --------------------------------------------------------------------------- #
async def test_generated_row_carries_context_fields(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_card: Card,
    test_user: User,
):
    user_b = await _make_user(db_session, "shape@valaris.dev")
    await _participant(db_session, test_card.id, test_user.id, role="hero")
    await _participant(db_session, test_card.id, user_b.id)

    await _generate(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        category="card_participant_changed",
        actor_id=test_user.id,
        entity_type="card",
        entity_id=test_card.id,
        dedupe_seed="shape-1",
        params={"card_title": test_card.title},
        link={"kind": "card", "workspace_slug": test_workspace.slug, "card_id": str(test_card.id)},
    )

    rows = await _notifications_for(db_session, user_b.id)
    assert len(rows) == 1
    row = rows[0]
    assert row.workspace_id == test_workspace.id
    assert row.board_id == test_board.id
    assert row.category == "card_participant_changed"
    assert row.actor_id == test_user.id
    assert row.entity_id == test_card.id
    assert row.params.get("card_title") == test_card.title
    assert row.link.get("card_id") == str(test_card.id)
    assert row.read_at is None  # SQLite strips tz — assert NULL, not a tz value


# --------------------------------------------------------------------------- #
# C. INV-4 — agent actor must not flood a default-pref human on churn cats
# --------------------------------------------------------------------------- #
async def test_agent_actor_churn_category_stays_off_by_default(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_card: Card,
    test_user: User,
):
    """card_created is OFF-by-default (high-volume churn). An agent-driven
    card_created must NOT create a row for a default-pref participant — INV-4
    anti-flood. (Even though card_created's recipients here are the card's
    participants, the OFF default gates it.)"""
    user_b = await _make_user(db_session, "human@valaris.dev")
    await _participant(db_session, test_card.id, test_user.id, role="hero")
    await _participant(db_session, test_card.id, user_b.id)

    await _generate(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        category="card_created",
        actor_id=test_user.id,
        is_agent_actor=True,
        entity_type="card",
        entity_id=test_card.id,
        dedupe_seed="agent-churn-1",
    )

    assert len(await _notifications_for(db_session, user_b.id)) == 0
    assert len(await _all_notifications(db_session)) == 0


async def test_agent_actor_flag_recorded_on_generated_row(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_card: Card,
    test_user: User,
):
    """When an agent-driven event DOES generate (an ON category), the row marks
    is_agent_actor=True so the FE can render 'agent did X' (INV-4 bookkeeping)."""
    user_b = await _make_user(db_session, "watcher@valaris.dev")
    await _participant(db_session, test_card.id, test_user.id, role="hero")
    await _participant(db_session, test_card.id, user_b.id)

    await _generate(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        category="card_participant_changed",
        actor_id=test_user.id,
        is_agent_actor=True,
        entity_type="card",
        entity_id=test_card.id,
        dedupe_seed="agent-on-1",
    )

    rows = await _notifications_for(db_session, user_b.id)
    assert len(rows) == 1
    assert rows[0].is_agent_actor is True


# --------------------------------------------------------------------------- #
# D. INV-6 — idempotent on the same dedupe_seed for the same recipient
# --------------------------------------------------------------------------- #
async def test_generate_twice_same_seed_creates_one_row(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_card: Card,
    test_user: User,
):
    user_b = await _make_user(db_session, "idem@valaris.dev")
    await _participant(db_session, test_card.id, test_user.id, role="hero")
    await _participant(db_session, test_card.id, user_b.id)

    kwargs = dict(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        category="card_participant_changed",
        actor_id=test_user.id,
        entity_type="card",
        entity_id=test_card.id,
        dedupe_seed="dup-seed",
    )
    await _generate(db_session, **kwargs)
    await _generate(db_session, **kwargs)

    assert len(await _notifications_for(db_session, user_b.id)) == 1


# --------------------------------------------------------------------------- #
# E. preference gating — per-user mute vs default user on the same event
# --------------------------------------------------------------------------- #
async def test_per_user_override_mutes_only_that_user(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_card: Card,
    test_user: User,
):
    """B overrides card_participant_changed OFF; C is default. On the event:
    C gets a row, B gets none, actor (A) gets none."""
    user_b = await _make_user(db_session, "muted@valaris.dev")
    user_c = await _make_user(db_session, "default@valaris.dev")
    await _participant(db_session, test_card.id, test_user.id, role="hero")
    await _participant(db_session, test_card.id, user_b.id)
    await _participant(db_session, test_card.id, user_c.id)

    db_session.add(
        NotificationPreference(
            user_id=user_b.id,
            workspace_id=test_workspace.id,
            relevance_scope="watching",
            category_overrides={"card_participant_changed": {"in_app": False}},
            muted=False,
        )
    )
    await db_session.flush()

    await _generate(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        category="card_participant_changed",
        actor_id=test_user.id,
        entity_type="card",
        entity_id=test_card.id,
        dedupe_seed="gate-1",
    )

    assert len(await _notifications_for(db_session, user_c.id)) == 1
    assert len(await _notifications_for(db_session, user_b.id)) == 0
    assert len(await _notifications_for(db_session, test_user.id)) == 0


async def test_workspace_muted_user_gets_no_row(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_card: Card,
    test_user: User,
):
    """A globally-muted (muted=True) workspace pref silences even a normally-ON
    category."""
    user_b = await _make_user(db_session, "killswitch@valaris.dev")
    await _participant(db_session, test_card.id, test_user.id, role="hero")
    await _participant(db_session, test_card.id, user_b.id)

    db_session.add(
        NotificationPreference(
            user_id=user_b.id,
            workspace_id=test_workspace.id,
            muted=True,
        )
    )
    await db_session.flush()

    await _generate(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        category="card_participant_changed",
        actor_id=test_user.id,
        entity_type="card",
        entity_id=test_card.id,
        dedupe_seed="muted-ws-1",
    )

    assert len(await _notifications_for(db_session, user_b.id)) == 0
