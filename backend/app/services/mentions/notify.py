# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Mention producer — feeds the existing notification pipeline (contract §3, §4).

`notify_new_mentions` is the SINGLE producer shared by both surfaces (card
description + note content — MEN-5). It diffs the mentioned-user sets of the
before/after content and fires one `mention` notification per genuinely-new id
(MEN-2). The whole loop runs inside ONE `begin_nested()` savepoint with a broad
except + logger.exception — IDENTICAL failure isolation to
`ActivityService._generate_notifications`: a parse or generation failure
degrades to a no-op and NEVER rolls back the triggering card/note write (MEN-4,
the savepoint-isolation lesson from a production incident: 'a try/except is false
comfort on asyncpg' — only a SAVEPOINT truly scopes an asyncpg abort).
"""

from __future__ import annotations

import logging
import uuid
from typing import Literal

from sqlalchemy.ext.asyncio import AsyncSession

from app.services.mentions.extract import extract_mention_ids

logger = logging.getLogger(__name__)


async def notify_new_mentions(
    db: AsyncSession,
    *,
    workspace_id: uuid.UUID,
    board_id: uuid.UUID | None,
    actor_id: uuid.UUID,
    entity_type: Literal["card", "note"],
    entity_id: uuid.UUID,
    card_id: uuid.UUID | None,
    before_content: str | dict | None,
    after_content: str | dict | None,
) -> None:
    """Generate a `mention` notification for each id newly present in
    `after_content` versus `before_content`. No-op (never raises) on a malformed
    doc or a generation failure — the savepoint isolates any abort so the
    card/note write that called us stays durable."""
    from app.core.auth import current_agent_id
    from app.repositories.kanban.card import CardRepository
    from app.repositories.notes.note import NoteRepository
    from app.services.notifications.generation import NotificationService

    try:
        new_ids = extract_mention_ids(after_content) - extract_mention_ids(
            before_content
        )
    except Exception:
        # extract_* is defensive and shouldn't raise, but a producer bug must
        # never surface to the caller — degrade to a no-op (MEN-4).
        logger.exception("mention extraction failed for %s %s", entity_type, entity_id)
        return
    if not new_ids:
        return

    # Resolve the deep-link card title ONCE (eager, greenlet-safe) so generation
    # needn't load the card for the mention category. card_id may be None for a
    # workspace/board-scoped note.
    display_params: dict[str, str] = {}
    link = _build_link(entity_type, entity_id, card_id, board_id)
    if card_id is not None:
        card = await CardRepository(db).get_by_id(card_id)
        if card is not None and card.title:
            display_params["card"] = card.title
    elif entity_type == "note":
        try:
            async with db.begin_nested():
                note = await NoteRepository(db).get_by_id(entity_id)
                if note is not None and note.title:
                    display_params["note"] = note.title
        except Exception:
            logger.exception("mention note title lookup failed for %s", entity_id)

    is_agent_actor = current_agent_id.get() is not None

    # ONE savepoint PER mentioned id, not one around the whole loop. begin_nested()
    # issues a SAVEPOINT so an asyncpg SQL error scopes its abort to that id's
    # nested block (the savepoint-isolation lesson from a production incident:
    # 'a plain try/except is false comfort' — only a savepoint truly contains an
    # asyncpg abort), leaving the outer
    # card/note write durable (MEN-4).
    #
    # Per-id (not whole-loop) is load-bearing for the live-push contract:
    # generate_for_event promotes that id's staged push into the NON-transactional
    # _PENDING buffer as its LAST step. A whole-loop savepoint would let id-A's
    # push reach _PENDING and then, on a LATER id's DB error, roll id-A's ROW back
    # while its push survives — a phantom notification.created for a row that no
    # longer exists. Scoping a savepoint per id keeps row-durability and
    # push-emission in lockstep: a failed id rolls back BEFORE its promotion, so
    # no push leaks; a clean id's row and push both survive. The per-id except
    # also stops one bad id from unwinding its siblings.
    service = NotificationService(db)
    for mentioned_user_id in new_ids:
        params = {"mentioned_user_id": str(mentioned_user_id), **display_params}
        try:
            async with db.begin_nested():
                await service.generate_for_event(
                    db,
                    workspace_id=workspace_id,
                    board_id=board_id,
                    category="mention",
                    actor_id=actor_id,  # the mentioner; dropped by INV-3
                    is_agent_actor=is_agent_actor,
                    entity_type=entity_type,
                    entity_id=entity_id,
                    # key = mention:{entity_id}:{user_id} — stable per
                    # (entity, mentioned-user) so remove→re-add is a no-op (INV-6).
                    dedupe_seed=str(mentioned_user_id),
                    params=params,
                    link=link,
                )
        except Exception:
            logger.exception(
                "mention notification generation failed for %s %s (user %s)",
                entity_type,
                entity_id,
                mentioned_user_id,
            )


def _build_link(
    entity_type: str,
    entity_id: uuid.UUID,
    card_id: uuid.UUID | None,
    board_id: uuid.UUID | None,
) -> dict:
    """Deep-link shape (contract §5). A card mention OR a card-scoped note
    mention links to the card; a board/workspace note with no card links to the
    note in its scope."""
    if card_id is not None:
        return {"kind": "card", "card_id": str(card_id)}
    return {
        "kind": "note",
        "note_id": str(entity_id),
        "board_id": str(board_id) if board_id is not None else None,
    }
