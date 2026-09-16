# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Phase-0 mention producer — generation-service `mention` recipient branch
(contract §3 "Recipient resolution").

`mention` resolves to EXACTLY the explicitly-mentioned user (params
["mentioned_user_id"]) — NOT the subject card's participants. The branch sits
BEFORE the card-participant fallback, and `mention` is removed from
`_CARD_PARTICIPANT_CATEGORIES` so the shared card-load path never runs for it
(a card mention must not silently fan out to everyone on the card).

Drives the generator directly (no activity hook) to pin the branch in isolation.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardParticipant
from app.models.notifications.notification import Notification
from app.models.user import User
from app.models.workspace import Workspace
from app.services.notifications.generation import NotificationService


async def _make_user(db: AsyncSession, email: str) -> User:
    user = User(email=email, name=email.split("@")[0])
    db.add(user)
    await db.flush()
    return user


async def _participant(
    db: AsyncSession, card_id: uuid.UUID, user_id: uuid.UUID
) -> None:
    db.add(CardParticipant(card_id=card_id, user_id=user_id, role="helper"))
    await db.flush()


async def _rows_for(db: AsyncSession, user_id: uuid.UUID) -> list[Notification]:
    res = await db.execute(
        select(Notification).where(Notification.recipient_user_id == user_id)
    )
    return list(res.scalars().all())


@pytest.mark.asyncio
async def test_mention_resolves_to_exactly_the_mentioned_user(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """A card mention notifies ONLY the mentioned user — not card participants.
    A bystander participant who was NOT mentioned must get zero rows."""
    mentioned = await _make_user(db_session, "mentioned@valaris.dev")
    bystander = await _make_user(db_session, "bystander@valaris.dev")
    # Both are participants on the card; only `mentioned` is in params.
    await _participant(db_session, test_card.id, mentioned.id)
    await _participant(db_session, test_card.id, bystander.id)

    await NotificationService(db_session).generate_for_event(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        category="mention",
        actor_id=test_user.id,
        is_agent_actor=False,
        entity_type="card",
        entity_id=test_card.id,
        dedupe_seed=str(mentioned.id),
        params={"mentioned_user_id": str(mentioned.id)},
        link={"kind": "card", "card_id": str(test_card.id)},
    )

    assert len(await _rows_for(db_session, mentioned.id)) == 1
    # The bystanding card participant is NOT notified — mention is not a
    # card-participant category.
    assert await _rows_for(db_session, bystander.id) == []


@pytest.mark.asyncio
async def test_mention_with_no_mentioned_user_id_is_a_noop(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """An absent mentioned_user_id resolves to an empty recipient set — zero
    rows, no card-participant fallback."""
    participant = await _make_user(db_session, "p@valaris.dev")
    await _participant(db_session, test_card.id, participant.id)

    await NotificationService(db_session).generate_for_event(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        category="mention",
        actor_id=test_user.id,
        is_agent_actor=False,
        entity_type="card",
        entity_id=test_card.id,
        dedupe_seed="x",
        params={},
        link=None,
    )

    all_rows = (await db_session.execute(select(Notification))).scalars().all()
    assert list(all_rows) == []


@pytest.mark.asyncio
async def test_mention_does_not_load_card_participants_when_card_absent(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """mention must resolve from params alone — entity_id pointing at a
    non-existent card must still deliver to the mentioned user (proves the
    card-participant load path is bypassed for mention)."""
    mentioned = await _make_user(db_session, "ghost-card-mention@valaris.dev")

    await NotificationService(db_session).generate_for_event(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        category="mention",
        actor_id=test_user.id,
        is_agent_actor=False,
        entity_type="card",
        entity_id=uuid.uuid4(),  # no such card
        dedupe_seed=str(mentioned.id),
        params={"mentioned_user_id": str(mentioned.id)},
        link=None,
    )

    assert len(await _rows_for(db_session, mentioned.id)) == 1
