# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Phase 3 — live-push ORDERING contract (RED). The subtle one.

Generation runs DEEP inside the triggering service's txn, scoped by a
`begin_nested()` SAVEPOINT (see app/services/activity.py `_generate_notifications`).
The contract's InAppChannel.deliver must fire `event_bus.publish("notification.
created", ...)` ONLY after the notification row is durably committed and OUTSIDE
that savepoint. Two failure modes this guards:

  - PHANTOM PUSH: if deliver publishes synchronously inside the savepoint and the
    savepoint then rolls back, the WS clients were told about a notification that
    no longer exists (a phantom badge increment with no backing row).
  - VISIBILITY RACE: even when the savepoint commits, publishing before the OUTER
    transaction commits races the row's visibility — a client refetching the
    inbox on the push can miss the not-yet-committed row.

OBSERVABLE CONTRACT ENCODED HERE (what the implementer must satisfy):

  (1) Generation ALONE — i.e. inside the savepoint, BEFORE the outer commit —
      publishes ZERO notification.created events. The push must be deferred to a
      post-commit / outside-savepoint step. (test 1 + test 2)

  (2) A rolled-back savepoint produces NO notification.created push (no phantom).
      We monkeypatch a generation that writes its row then forces the savepoint to
      roll back; the bus must never have seen a notification.created. (test 3)

  (3) After a full end-to-end mutation (a card move that generates a notification)
      COMPLETES and the session commits, EXACTLY ONE notification.created was
      published for the recipient, and its payload matches the contract shape.
      (test 4)

ASSUMPTION FOR THE IMPLEMENTER: the in-process test harness shares one
db_session and does not run the real get_db post-commit hook, so "after commit"
is approximated by "after the triggering service call returns AND db_session.commit()
is awaited". The binding assertion is the RELATIVE ordering: nothing is published
DURING generation (inside the savepoint); the single push appears only once the
mutation has completed. The implementer must therefore enqueue the push during
generation and flush it from a post-commit / after-savepoint step (e.g. a
SessionEvents 'after_commit' listener, or an explicit deferred-push buffer the
calling service drains after the outer commit) — NOT call event_bus.publish from
inside InAppChannel.deliver synchronously.

These FAIL today: InAppChannel.deliver is a no-op stub (publishes nothing), so
test 4 (a push must appear) FAILS for the right reason — the post-commit push
mechanism does not exist yet.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardParticipant
from app.models.kanban.column import Column
from app.models.notifications.notification import Notification
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.kanban.card import CardMoveRequest
from app.services.kanban.card import CardService
from app.services.notifications.channels import CHANNEL_REGISTRY, InAppChannel
from app.services.notifications.generation import NotificationService


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
async def _make_user(db: AsyncSession, email: str) -> User:
    user = User(email=email, name=email.split("@")[0])
    db.add(user)
    await db.flush()
    return user


async def _participant(
    db: AsyncSession, card_id: uuid.UUID, user_id: uuid.UUID, role: str
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


class _PublishRecorder:
    """Records every event_bus.publish call so a test can assert WHAT was
    published and WHEN, relative to generation vs the outer commit."""

    def __init__(self):
        self.calls: list[tuple[str, dict, uuid.UUID]] = []
        self._orig = None

    def install(self, monkeypatch):
        self._orig = event_bus.publish

        async def _capture(event_type, payload, workspace_id):
            self.calls.append((event_type, payload, workspace_id))
            return await self._orig(event_type, payload, workspace_id)

        monkeypatch.setattr(event_bus, "publish", _capture)

    @property
    def notification_pushes(self) -> list[tuple[str, dict, uuid.UUID]]:
        return [c for c in self.calls if c[0] == "notification.created"]


async def _seed_movable_card(
    db: AsyncSession, board: Board, card: Card, hero: User
) -> tuple[User, Column]:
    follower = await _make_user(db, f"follower-{uuid.uuid4().hex[:8]}@valaris.dev")
    await _participant(db, card.id, hero.id, role="hero")
    await _participant(db, card.id, follower.id, role="helper")
    target = await _add_column(db, board.id, "In Progress", 2048.0)
    return follower, target


# --------------------------------------------------------------------------- #
# (1) Generation INSIDE the savepoint publishes nothing — calling
#     generate_for_event directly (no surrounding outer commit) must not push.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_generate_for_event_does_not_publish_during_generation(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
    monkeypatch,
):
    """Invoking generation directly (as the hook does, inside the txn/savepoint)
    writes the durable row but must NOT publish notification.created yet — the
    push is deferred to a post-commit step. Without deferral, deliver() would
    publish synchronously here."""
    follower, _ = await _seed_movable_card(db_session, test_board, test_card, test_user)

    recorder = _PublishRecorder()
    recorder.install(monkeypatch)

    await NotificationService(db_session).generate_for_event(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        category="card_participant_changed",
        actor_id=test_user.id,
        is_agent_actor=False,
        entity_type="card",
        entity_id=test_card.id,
        dedupe_seed="seed-1",
        params={"card_title": "Widget"},
        link={"kind": "card", "card_id": str(test_card.id)},
    )

    # The durable row exists (INV-1) ...
    rows = (
        await db_session.execute(
            select(Notification).where(Notification.recipient_user_id == follower.id)
        )
    ).scalars().all()
    assert len(rows) == 1
    # ... but NOTHING was pushed during generation (push is post-commit only).
    assert recorder.notification_pushes == [], (
        "notification.created was published DURING generation (inside the "
        "savepoint) — it must be deferred until after the outer commit"
    )


# --------------------------------------------------------------------------- #
# (2) InAppChannel.deliver, called within a rolled-back savepoint, performs no
#     synchronous bus publish (no phantom push for a row that won't survive).
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_inapp_deliver_inside_rolled_back_savepoint_does_not_publish(
    db_session: AsyncSession,
    test_workspace: Workspace,
    second_user: User,
    monkeypatch,
):
    """Drive InAppChannel.deliver from WITHIN a savepoint that then rolls back.
    If deliver publishes synchronously, the bus sees a notification.created for a
    row that vanishes on rollback — a phantom badge increment. The contract
    forbids that synchronous push: deliver must enqueue, not publish."""
    recorder = _PublishRecorder()
    recorder.install(monkeypatch)

    channel = InAppChannel()
    phantom = Notification(
        recipient_user_id=second_user.id,
        workspace_id=test_workspace.id,
        board_id=None,
        category="card_participant_changed",
        actor_id=None,
        is_agent_actor=False,
        entity_type="card",
        entity_id=uuid.uuid4(),
        params={},
        link=None,
        dedupe_key=f"phantom:{uuid.uuid4()}",
    )

    async with db_session.begin_nested() as savepoint:
        db_session.add(phantom)
        await db_session.flush()
        await channel.deliver(phantom, second_user.id, db_session)
        await savepoint.rollback()

    # The savepoint rolled back → no row, and crucially NO push was emitted.
    assert recorder.notification_pushes == [], (
        "InAppChannel.deliver published notification.created synchronously inside "
        "a savepoint that rolled back — a phantom push for a non-existent row"
    )


# --------------------------------------------------------------------------- #
# (3) The InAppChannel must not call event_bus.publish synchronously from
#     deliver() at all — it enqueues; the post-commit step flushes.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_inapp_deliver_does_not_publish_synchronously(
    db_session: AsyncSession,
    test_workspace: Workspace,
    second_user: User,
    monkeypatch,
):
    """A direct deliver() outside any commit must not itself fire the bus. This
    pins the mechanism: deliver enqueues the push; a separate post-commit flush
    emits it. (Tolerates a future enqueue API; only the synchronous publish is
    forbidden.)"""
    recorder = _PublishRecorder()
    recorder.install(monkeypatch)

    row = Notification(
        recipient_user_id=second_user.id,
        workspace_id=test_workspace.id,
        board_id=None,
        category="card_participant_changed",
        actor_id=None,
        is_agent_actor=False,
        entity_type="card",
        entity_id=uuid.uuid4(),
        params={},
        link=None,
        dedupe_key=f"sync:{uuid.uuid4()}",
    )
    db_session.add(row)
    await db_session.flush()

    await InAppChannel().deliver(row, second_user.id, db_session)

    assert recorder.notification_pushes == [], (
        "InAppChannel.deliver published synchronously; it must enqueue the push "
        "for a post-commit flush instead"
    )


# --------------------------------------------------------------------------- #
# (4) End-to-end: after a card move COMPLETES and the session commits, EXACTLY
#     ONE notification.created is published for the recipient, contract-shaped.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_card_move_publishes_exactly_one_push_after_commit(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
    monkeypatch,
):
    """The full path: a card move generates a card_participant_changed
    notification for the follower. During the move (generation inside the
    savepoint) NOTHING is pushed; once the mutation has completed and the session
    commits, exactly ONE notification.created is published for the follower with
    the contract payload {notification_id, recipient_user_id, category,
    workspace_id, unread_delta}.

    RED: InAppChannel.deliver is a no-op stub and there is no post-commit flush,
    so zero pushes are emitted today (the assertion of EXACTLY ONE fails)."""
    follower, target = await _seed_movable_card(
        db_session, test_board, test_card, test_user
    )

    recorder = _PublishRecorder()
    recorder.install(monkeypatch)

    service = CardService(db_session)
    await service.move_card(
        test_card.id,
        test_board.id,
        CardMoveRequest(column_id=target.id, position=1024.0),
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
    )

    # Mid-move (generation ran inside the savepoint), no notification push yet.
    assert recorder.notification_pushes == [], (
        "a notification.created was pushed DURING the move (inside the savepoint) "
        "— the push must wait for the outer commit"
    )

    # Complete the unit of work as the request would.
    await db_session.commit()

    pushes = recorder.notification_pushes
    assert len(pushes) == 1, (
        f"expected exactly one notification.created after commit, got {len(pushes)}"
    )
    _event_type, payload, ws_id = pushes[0]
    assert ws_id == test_workspace.id
    assert payload["recipient_user_id"] == str(follower.id)
    assert payload["category"] == "card_participant_changed"
    assert payload["workspace_id"] == str(test_workspace.id)
    assert payload["unread_delta"] == 1
    # The push must carry the resolved deep-link so the client (OS notification
    # toast or any push consumer) can navigate straight to the entity without a
    # round-trip to read the row — a card move links to its card.
    #
    # "Resolved" means RESOLVABLE (card fb7c6ac2): the toast runs the same
    # linkToRoute as the inbox, and that returns null for a kind "card" link with
    # no board_id. The producer only knows card_id, so generate_for_event enriches
    # board_id + workspace_slug before the row and this push are built.
    assert payload["link"] == {
        "kind": "card",
        "card_id": str(test_card.id),
        "board_id": str(test_board.id),
        "workspace_slug": test_workspace.slug,
    }
    # the pushed id must correspond to a real, committed row
    durable = (
        await db_session.execute(
            select(Notification).where(
                Notification.recipient_user_id == follower.id,
                Notification.category == "card_participant_changed",
            )
        )
    ).scalars().all()
    assert len(durable) == 1
    assert payload["notification_id"] == str(durable[0].id)


# --------------------------------------------------------------------------- #
# registry sanity — the in_app channel is the one whose deliver must defer.
# --------------------------------------------------------------------------- #
def test_in_app_is_the_registered_channel():
    assert "in_app" in CHANNEL_REGISTRY
    assert isinstance(CHANNEL_REGISTRY["in_app"], InAppChannel)
