# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Every notification's `link` must resolve to a navigable route (card fb7c6ac2).

The owner's contract, adopted verbatim: *every notification event carries a link
to its affected entity*. A stored `link` is not enough — it must carry the fields
the frontend resolver actually requires, or the CTA is hidden and the row is a
dead end ("Jordan changed a card you're following." — which card?).

The frontend resolver (`frontend/src/features/notifications/utils/link-to-route.ts`)
imposes the requirements these tests pin:

    kind "card"  -> needs board_id (returns null without it), card_id optional
    kind "note"  -> needs note_id
    kind "approval" / "workspace" -> need only the workspace slug

and the slug itself comes from `link.workspace_slug`, falling back to the inbox's
current scope. In the "All workspaces" rollup there IS no fallback scope, so a
link without `workspace_slug` is unresolvable there no matter what else it holds.

Producers only ever knew their own local ids, so they emitted partial links
({"kind": "card", "card_id": ...} with no board_id/workspace_slug). Enrichment
therefore belongs at the single choke point every producer funnels through —
`generate_for_event` — which already holds board_id and resolves the workspace
for display params. These tests drive that choke point directly.
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
from app.services.notifications import generation as gen_mod


def _service(db: AsyncSession):
    return gen_mod.NotificationService(db)


async def _generate(db, **kwargs):
    payload = dict(
        board_id=None,
        is_agent_actor=False,
        entity_type="card",
        params={},
        link=None,
    )
    payload.update(kwargs)
    return await _service(db).generate_for_event(db, **payload)


async def _make_user(db: AsyncSession, email: str) -> User:
    user = User(email=email, name=email.split("@")[0])
    db.add(user)
    await db.flush()
    return user


async def _participant(db: AsyncSession, card_id, user_id, role="helper") -> None:
    db.add(CardParticipant(card_id=card_id, user_id=user_id, role=role))
    await db.flush()


async def _one_notification(db: AsyncSession, user_id) -> Notification:
    rows = await db.execute(
        select(Notification).where(Notification.recipient_user_id == user_id)
    )
    found = list(rows.scalars().all())
    assert len(found) == 1, f"expected exactly 1 notification, got {len(found)}"
    return found[0]


async def _card_notification_link(
    db, workspace, board, card, recipient, actor, *, link, category
) -> dict | None:
    """Generate one card-category notification and return its stored link."""
    await _participant(db, card.id, recipient.id, role="hero")
    await _participant(db, card.id, actor.id)
    await _generate(
        db,
        workspace_id=workspace.id,
        board_id=board.id,
        category=category,
        actor_id=actor.id,
        entity_type="card",
        entity_id=card.id,
        dedupe_seed=f"link-{uuid.uuid4()}",
        link=link,
    )
    return (await _one_notification(db, recipient.id)).link


# --------------------------------------------------------------------------- #
# AC2 — the reported case: a card-change notification links to THAT card.
# --------------------------------------------------------------------------- #
async def test_card_link_is_enriched_with_board_id(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """A producer's partial {"kind","card_id"} link gains board_id.

    Without board_id `linkToRoute` returns null for kind "card" and the inbox
    hides the CTA — the exact dead end the owner reported.
    """
    actor = await _make_user(db_session, "actor-board@valaris.dev")
    link = await _card_notification_link(
        db_session,
        test_workspace,
        test_board,
        test_card,
        test_user,
        actor,
        link={"kind": "card", "card_id": str(test_card.id)},
        category="card_participant_changed",
    )

    assert link is not None
    assert link["kind"] == "card"
    assert link["card_id"] == str(test_card.id)
    assert link["board_id"] == str(test_board.id), (
        "kind 'card' without board_id is unresolvable — linkToRoute returns null"
    )


async def test_card_link_is_enriched_with_workspace_slug(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """The link carries its OWN workspace slug.

    The inbox's "All workspaces" rollup passes no fallback slug, so a link
    without workspace_slug is unresolvable there even when board_id is present.
    """
    actor = await _make_user(db_session, "actor-slug@valaris.dev")
    link = await _card_notification_link(
        db_session,
        test_workspace,
        test_board,
        test_card,
        test_user,
        actor,
        link={"kind": "card", "card_id": str(test_card.id)},
        category="card_participant_changed",
    )

    assert link["workspace_slug"] == test_workspace.slug


# --------------------------------------------------------------------------- #
# Enrichment must not overwrite what a producer deliberately set.
# --------------------------------------------------------------------------- #
async def test_enrichment_preserves_producer_supplied_board_id(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """A producer that already knows the target board wins over the event's.

    A note mention on a board-scoped note names its own board; enrichment fills
    gaps, it does not relocate targets.
    """
    actor = await _make_user(db_session, "actor-keep@valaris.dev")
    explicit = str(uuid.uuid4())
    link = await _card_notification_link(
        db_session,
        test_workspace,
        test_board,
        test_card,
        test_user,
        actor,
        link={"kind": "card", "card_id": str(test_card.id), "board_id": explicit},
        category="card_participant_changed",
    )

    assert link["board_id"] == explicit


async def test_note_link_keeps_null_board_id_for_workspace_scoped_notes(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_card: Card,
    test_user: User,
):
    """A workspace-scoped note link has board_id=None BY DESIGN.

    `linkToRoute` routes those to /{slug}/notes rather than a board's notes tab,
    so enrichment must leave the explicit None alone — filling it from the event
    would misroute the link to a board the note does not live on.
    """
    actor = await _make_user(db_session, "actor-note@valaris.dev")
    note_id = str(uuid.uuid4())
    await _participant(db_session, test_card.id, test_user.id, role="hero")
    await _participant(db_session, test_card.id, actor.id)

    await _generate(
        db_session,
        workspace_id=test_workspace.id,
        board_id=None,
        category="card_participant_changed",
        actor_id=actor.id,
        entity_type="card",
        entity_id=test_card.id,
        dedupe_seed="note-scope",
        link={"kind": "note", "note_id": note_id, "board_id": None},
    )

    link = (await _one_notification(db_session, test_user.id)).link
    assert link["board_id"] is None
    assert link["note_id"] == note_id
    assert link["workspace_slug"] == test_workspace.slug


# --------------------------------------------------------------------------- #
# AC1 — no notification kind is left link-less.
# --------------------------------------------------------------------------- #
async def test_linkless_producer_still_gets_a_workspace_link(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """workspace_member passes link=None; it must not render as a dead end.

    There is no per-entity destination for "you were added to a workspace", so
    the floor is the workspace itself — every notification carries SOME link.
    """
    actor = await _make_user(db_session, "actor-ws@valaris.dev")

    await _generate(
        db_session,
        workspace_id=test_workspace.id,
        board_id=None,
        category="workspace_member",
        actor_id=actor.id,
        entity_type="member",
        entity_id=test_user.id,
        dedupe_seed="ws-1",
        params={"affected_user_id": str(test_user.id)},
        link=None,
    )

    link = (await _one_notification(db_session, test_user.id)).link
    assert link is not None, "a linkless notification is the dead end being fixed"
    assert link["kind"] == "workspace"
    assert link["workspace_slug"] == test_workspace.slug
