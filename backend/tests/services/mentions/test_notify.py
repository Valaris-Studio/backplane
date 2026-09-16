# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Phase-0 mention producer — `notify_new_mentions` (contract §3, §4 + MEN-2/3/4).

The single producer shared by both surfaces. It diffs `extract(after) -
extract(before)`, and for each NEW id calls `generate_for_event(category=
"mention", dedupe_seed=str(user_id), params={mentioned_user_id, card?}, link)`.
The whole loop is wrapped in ONE `begin_nested()` savepoint + broad except +
logger.exception (mirrors ActivityService._generate_notifications) so a parse or
generation failure degrades to a no-op and NEVER rolls back the card/note write.

Pins:
  - create fires for ALL new mentions (before="")
  - edit fires for only NEW mentions (diff vs prior content)
  - re-add stays silent (same dedupe_key — INV-6 idempotency backstop)
  - self-mention dropped (INV-3, actor == mentioned)
  - malformed after_content → no-op, no raise (MEN-4)
  - a generation error inside the savepoint does NOT roll back a sentinel row
    written before the call (savepoint isolation — a production incident lesson)
  - in a MULTI-mention loop, one id's generation failure neither rolls back a
    sibling's row NOR leaks a phantom live-push for the rolled-back id
    (per-id savepoint scoping — the live-push contract)
"""

from __future__ import annotations

import json
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.notifications.notification import Notification
from app.models.user import User
from app.models.workspace import Workspace
from app.core.event_bus import event_bus
from app.services.mentions.notify import notify_new_mentions
from app.services.notifications.generation import NotificationService


async def _make_user(db: AsyncSession, email: str) -> User:
    user = User(email=email, name=email.split("@")[0])
    db.add(user)
    await db.flush()
    return user


def _doc_with_mentions(*user_ids: uuid.UUID) -> str:
    content = [
        {"type": "mention", "attrs": {"id": str(uid), "label": "X"}} for uid in user_ids
    ]
    return json.dumps(
        {"type": "doc", "content": [{"type": "paragraph", "content": content}]}
    )


async def _rows_for(db: AsyncSession, user_id: uuid.UUID) -> list[Notification]:
    res = await db.execute(
        select(Notification).where(Notification.recipient_user_id == user_id)
    )
    return list(res.scalars().all())


@pytest.mark.asyncio
async def test_create_fires_for_all_new_mentions(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    a = await _make_user(db_session, "mention-a@valaris.dev")
    b = await _make_user(db_session, "mention-b@valaris.dev")

    await notify_new_mentions(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        actor_id=test_user.id,
        entity_type="card",
        entity_id=test_card.id,
        card_id=test_card.id,
        before_content="",
        after_content=_doc_with_mentions(a.id, b.id),
    )

    assert len(await _rows_for(db_session, a.id)) == 1
    assert len(await _rows_for(db_session, b.id)) == 1


@pytest.mark.asyncio
async def test_edit_fires_only_for_newly_added_mentions(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    a = await _make_user(db_session, "edit-a@valaris.dev")
    b = await _make_user(db_session, "edit-b@valaris.dev")

    await notify_new_mentions(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        actor_id=test_user.id,
        entity_type="card",
        entity_id=test_card.id,
        card_id=test_card.id,
        before_content=_doc_with_mentions(a.id),
        after_content=_doc_with_mentions(a.id, b.id),
    )

    # a was already mentioned (not new) → no row; b is new → one row.
    assert await _rows_for(db_session, a.id) == []
    assert len(await _rows_for(db_session, b.id)) == 1


@pytest.mark.asyncio
async def test_re_add_stays_silent_same_dedupe_key(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """Remove then re-add the same mention. Even though the diff sees it as
    "new" the second time (before had no mention), the dedupe_key
    mention:{entity_id}:{user_id} is stable → the re-add is a no-op upsert
    (INV-6, contract decision #2)."""
    a = await _make_user(db_session, "readd@valaris.dev")

    # 1) initial add → one row
    await notify_new_mentions(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        actor_id=test_user.id,
        entity_type="card",
        entity_id=test_card.id,
        card_id=test_card.id,
        before_content="",
        after_content=_doc_with_mentions(a.id),
    )
    # 2) removal (after has no mention — produces nothing)
    await notify_new_mentions(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        actor_id=test_user.id,
        entity_type="card",
        entity_id=test_card.id,
        card_id=test_card.id,
        before_content=_doc_with_mentions(a.id),
        after_content="",
    )
    # 3) re-add (diff sees it as new, but dedupe_key collides)
    await notify_new_mentions(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        actor_id=test_user.id,
        entity_type="card",
        entity_id=test_card.id,
        card_id=test_card.id,
        before_content="",
        after_content=_doc_with_mentions(a.id),
    )

    assert len(await _rows_for(db_session, a.id)) == 1


@pytest.mark.asyncio
async def test_self_mention_is_dropped(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """INV-3: mentioning yourself never notifies you."""
    await notify_new_mentions(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        actor_id=test_user.id,
        entity_type="card",
        entity_id=test_card.id,
        card_id=test_card.id,
        before_content="",
        after_content=_doc_with_mentions(test_user.id),
    )
    assert await _rows_for(db_session, test_user.id) == []


@pytest.mark.asyncio
async def test_malformed_after_content_is_noop_no_raise(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """A malformed after_content must NOT raise and must create zero rows."""
    await notify_new_mentions(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        actor_id=test_user.id,
        entity_type="card",
        entity_id=test_card.id,
        card_id=test_card.id,
        before_content="",
        after_content="{not valid json at all",
    )
    all_rows = (await db_session.execute(select(Notification))).scalars().all()
    assert list(all_rows) == []


@pytest.mark.asyncio
async def test_generation_error_inside_savepoint_does_not_roll_back_sentinel(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
    monkeypatch,
):
    """A generation failure inside the producer's begin_nested savepoint must
    degrade to a no-op: a sentinel row written BEFORE the producer call survives
    and the session is still committable (the 'try/except is false comfort on
    asyncpg' lesson — only a savepoint truly isolates the abort)."""
    mentioned = await _make_user(db_session, "savepoint-target@valaris.dev")

    # The sentinel: a real row flushed before generation runs. If the producer
    # let the abort escape its savepoint, this row would be rolled back.
    sentinel = await _make_user(db_session, "sentinel-survives@valaris.dev")

    async def _boom(*args, **kwargs):
        raise RuntimeError("simulated generation failure")

    monkeypatch.setattr(NotificationService, "generate_for_event", _boom)

    await notify_new_mentions(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        actor_id=test_user.id,
        entity_type="card",
        entity_id=test_card.id,
        card_id=test_card.id,
        before_content="",
        after_content=_doc_with_mentions(mentioned.id),
    )

    # No notification leaked.
    all_rows = (await db_session.execute(select(Notification))).scalars().all()
    assert list(all_rows) == []
    # The sentinel survived the savepoint rollback…
    survived = (
        await db_session.execute(select(User).where(User.id == sentinel.id))
    ).scalar_one_or_none()
    assert survived is not None
    # …and the session is not poisoned — it commits cleanly.
    await db_session.commit()


@pytest.mark.asyncio
async def test_one_id_failure_does_not_roll_back_sibling_or_leak_its_push(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
    monkeypatch,
):
    """Multi-mention loop, per-id savepoint scoping (live-push contract).

    Two genuinely-new mentions; generation for the SECOND target raises a real
    failure. With a per-id savepoint:
      - the FIRST target's row survives (its savepoint committed) and its
        live-push is emitted after commit;
      - the SECOND target's row is rolled back AND its staged push never
        promotes, so NO phantom notification.created leaks for it.
    A whole-loop savepoint would roll the first target's ROW back while its push
    (already promoted to the non-transactional pending buffer) still fires — the
    phantom this test forbids.
    """
    good = await _make_user(db_session, "loop-good@valaris.dev")
    bad = await _make_user(db_session, "loop-bad@valaris.dev")

    captured: list[tuple[str, dict, uuid.UUID]] = []
    orig_publish = event_bus.publish

    async def _capture(event_type, payload, workspace_id):
        captured.append((event_type, payload, workspace_id))
        return await orig_publish(event_type, payload, workspace_id)

    monkeypatch.setattr(event_bus, "publish", _capture)

    real_generate = NotificationService.generate_for_event

    async def _selective(self, db, *args, **kwargs):
        if kwargs.get("params", {}).get("mentioned_user_id") == str(bad.id):
            raise RuntimeError("simulated generation failure for the bad id")
        return await real_generate(self, db, *args, **kwargs)

    monkeypatch.setattr(NotificationService, "generate_for_event", _selective)

    await notify_new_mentions(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        actor_id=test_user.id,
        entity_type="card",
        entity_id=test_card.id,
        card_id=test_card.id,
        before_content="",
        after_content=_doc_with_mentions(good.id, bad.id),
    )
    # Commit the outer txn so the after_commit listener drains the pending pushes.
    await db_session.commit()

    # The good target's row survived the bad target's failure…
    assert len(await _rows_for(db_session, good.id)) == 1
    # …the bad target's row was rolled back…
    assert await _rows_for(db_session, bad.id) == []
    # …and EXACTLY ONE live-push fired — for the good target, never the bad one
    # (no phantom push for a rolled-back row).
    pushes = [c for c in captured if c[0] == "notification.created"]
    assert len(pushes) == 1
    assert pushes[0][1]["recipient_user_id"] == str(good.id)


@pytest.mark.asyncio
async def test_card_title_enriched_into_params(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """When card_id resolves a card, params['card'] carries its title so the
    deep-link copy can render the card name without a generation-time load."""
    a = await _make_user(db_session, "title-target@valaris.dev")

    await notify_new_mentions(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        actor_id=test_user.id,
        entity_type="card",
        entity_id=test_card.id,
        card_id=test_card.id,
        before_content="",
        after_content=_doc_with_mentions(a.id),
    )

    rows = await _rows_for(db_session, a.id)
    assert len(rows) == 1
    assert rows[0].params.get("card") == test_card.title
