# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Phase 1 — Notification model + NotificationRepository (pure data access).

RED-phase tests for the notification-system contract
(docs/notification-system-contract.md §"Table notifications"). No generation
logic, no API, no fan-out — those are later phases. These pin:
  - the durable row shape (columns, defaults, nullability)
  - keyset DESC listing with workspace filter + before-cursor + unread-only
  - unread_count with the all-workspaces rollup (workspace_id=None)
  - read-state transitions (read_at NULL = unread; mark_read / mark_all_read)
  - INV-6 idempotency: a second create with the same
    (recipient_user_id, dedupe_key) must NOT create a duplicate
  - the unique constraint (recipient_user_id, dedupe_key)

Mirrors tests/repositories/test_merge_queue.py for style.

SQLite test DB strips timezone — assert read_at is None / is not None rather
than comparing tz-aware datetimes.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notifications.notification import Notification
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.repositories.notifications.notification import NotificationRepository


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
async def _make_workspace(db: AsyncSession, owner: User, slug: str) -> Workspace:
    ws = Workspace(name=slug.title(), slug=slug, created_by=owner.id)
    db.add(ws)
    await db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=owner.id, role=WorkspaceRole.owner))
    await db.flush()
    return ws


def _notification_kwargs(
    *,
    recipient: User,
    workspace: Workspace,
    category: str = "card_participant_changed",
    dedupe_key: str = "card_participant_changed:abc:1",
    actor: User | None = None,
    board_id: uuid.UUID | None = None,
    is_agent_actor: bool = False,
) -> dict:
    return dict(
        recipient_user_id=recipient.id,
        workspace_id=workspace.id,
        board_id=board_id,
        category=category,
        actor_id=actor.id if actor else None,
        is_agent_actor=is_agent_actor,
        entity_type="card",
        entity_id=uuid.uuid4(),
        params={"card_title": "Widget"},
        link={"kind": "card", "workspace_slug": workspace.slug},
        dedupe_key=dedupe_key,
    )


# --------------------------------------------------------------------------- #
# create / get_by_id / column shape + defaults
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_create_notification_persists_with_defaults(
    db_session: AsyncSession, test_workspace: Workspace, second_user: User, test_user: User
):
    repo = NotificationRepository(db_session)
    row = await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=test_workspace, actor=test_user)
    )

    assert row.id is not None
    assert row.recipient_user_id == second_user.id
    assert row.workspace_id == test_workspace.id
    assert row.category == "card_participant_changed"
    assert row.actor_id == test_user.id
    # read_at NULL == unread; server_default false for is_agent_actor
    assert row.read_at is None
    assert row.is_agent_actor is False
    assert row.params == {"card_title": "Widget"}
    assert row.link == {"kind": "card", "workspace_slug": test_workspace.slug}
    assert row.created_at is not None


@pytest.mark.asyncio
async def test_create_notification_accepts_board_and_agent_actor(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board,
    second_user: User,
    test_user: User,
):
    repo = NotificationRepository(db_session)
    row = await repo.create(
        **_notification_kwargs(
            recipient=second_user,
            workspace=test_workspace,
            actor=test_user,
            board_id=test_board.id,
            is_agent_actor=True,
        )
    )
    assert row.board_id == test_board.id
    assert row.is_agent_actor is True


@pytest.mark.asyncio
async def test_create_notification_allows_null_actor_and_entity_id(
    db_session: AsyncSession, test_workspace: Workspace, second_user: User
):
    repo = NotificationRepository(db_session)
    row = await repo.create(
        recipient_user_id=second_user.id,
        workspace_id=test_workspace.id,
        board_id=None,
        category="board_run_finished",
        actor_id=None,
        is_agent_actor=False,
        entity_type="board",
        entity_id=None,
        params={},
        link=None,
        dedupe_key="board_run_finished:none:1",
    )
    assert row.actor_id is None
    assert row.entity_id is None
    assert row.link is None


@pytest.mark.asyncio
async def test_get_by_id_returns_row(
    db_session: AsyncSession, test_workspace: Workspace, second_user: User
):
    repo = NotificationRepository(db_session)
    created = await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=test_workspace)
    )
    found = await repo.get_by_id(created.id)
    assert found is not None
    assert found.id == created.id


@pytest.mark.asyncio
async def test_get_by_id_returns_none_for_unknown(db_session: AsyncSession):
    repo = NotificationRepository(db_session)
    assert await repo.get_by_id(uuid.uuid4()) is None


# --------------------------------------------------------------------------- #
# INV-6 idempotency + unique (recipient_user_id, dedupe_key)
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_create_idempotent_on_same_recipient_and_dedupe_key(
    db_session: AsyncSession, test_workspace: Workspace, second_user: User, test_user: User
):
    """INV-6: re-running generation for the same (event, recipient) must not
    create a duplicate. The repo's upsert-on-create keys on
    (recipient_user_id, dedupe_key) and returns the existing row."""
    repo = NotificationRepository(db_session)
    kwargs = _notification_kwargs(
        recipient=second_user,
        workspace=test_workspace,
        actor=test_user,
        dedupe_key="card_participant_changed:dup:1",
    )
    first = await repo.create(**kwargs)
    second = await repo.create(**kwargs)

    assert second.id == first.id
    rows = (
        (await db_session.execute(select(Notification))).scalars().all()
    )
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_create_same_dedupe_key_different_recipients_creates_two_rows(
    db_session: AsyncSession, test_workspace: Workspace, second_user: User, test_user: User
):
    """The dedupe key is scoped per recipient — the same event fanned out to
    two recipients yields two rows (one each)."""
    repo = NotificationRepository(db_session)
    shared_key = "card_participant_changed:shared:1"
    await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=test_workspace, dedupe_key=shared_key)
    )
    await repo.create(
        **_notification_kwargs(recipient=test_user, workspace=test_workspace, dedupe_key=shared_key)
    )

    rows = (await db_session.execute(select(Notification))).scalars().all()
    assert len(rows) == 2


@pytest.mark.asyncio
async def test_unique_constraint_recipient_dedupe_rejects_raw_duplicate(
    db_session: AsyncSession, test_workspace: Workspace, second_user: User
):
    """The DB-level unique (recipient_user_id, dedupe_key) backstops INV-6:
    a raw model insert bypassing the repo's upsert still violates the
    constraint."""
    db_session.add(
        Notification(**_notification_kwargs(recipient=second_user, workspace=test_workspace, dedupe_key="k:1"))
    )
    await db_session.flush()
    db_session.add(
        Notification(**_notification_kwargs(recipient=second_user, workspace=test_workspace, dedupe_key="k:1"))
    )
    with pytest.raises(IntegrityError):
        await db_session.flush()


# --------------------------------------------------------------------------- #
# list_for_recipient — keyset DESC, workspace filter, before-cursor, unread-only
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_list_for_recipient_orders_newest_first(
    db_session: AsyncSession, test_workspace: Workspace, second_user: User
):
    repo = NotificationRepository(db_session)
    older = await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=test_workspace, dedupe_key="k:older")
    )
    newer = await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=test_workspace, dedupe_key="k:newer")
    )

    rows = await repo.list_for_recipient(second_user.id, limit=50)
    ids = [r.id for r in rows]
    assert ids.index(newer.id) < ids.index(older.id)


@pytest.mark.asyncio
async def test_list_for_recipient_isolates_by_recipient(
    db_session: AsyncSession, test_workspace: Workspace, second_user: User, test_user: User
):
    repo = NotificationRepository(db_session)
    mine = await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=test_workspace, dedupe_key="k:mine")
    )
    await repo.create(
        **_notification_kwargs(recipient=test_user, workspace=test_workspace, dedupe_key="k:theirs")
    )

    rows = await repo.list_for_recipient(second_user.id, limit=50)
    assert [r.id for r in rows] == [mine.id]


@pytest.mark.asyncio
async def test_list_for_recipient_filters_by_workspace(
    db_session: AsyncSession, test_workspace: Workspace, second_user: User, test_user: User
):
    repo = NotificationRepository(db_session)
    ws_b = await _make_workspace(db_session, test_user, "workspace-b")
    in_a = await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=test_workspace, dedupe_key="k:a")
    )
    await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=ws_b, dedupe_key="k:b")
    )

    rows = await repo.list_for_recipient(
        second_user.id, workspace_id=test_workspace.id, limit=50
    )
    assert [r.id for r in rows] == [in_a.id]


@pytest.mark.asyncio
async def test_list_for_recipient_workspace_none_returns_all_workspaces(
    db_session: AsyncSession, test_workspace: Workspace, second_user: User, test_user: User
):
    """workspace_id=None is the all-workspaces rollup tab — both rows return."""
    repo = NotificationRepository(db_session)
    ws_b = await _make_workspace(db_session, test_user, "workspace-b")
    await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=test_workspace, dedupe_key="k:a")
    )
    await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=ws_b, dedupe_key="k:b")
    )

    rows = await repo.list_for_recipient(second_user.id, workspace_id=None, limit=50)
    assert len(rows) == 2


@pytest.mark.asyncio
async def test_list_for_recipient_respects_limit(
    db_session: AsyncSession, test_workspace: Workspace, second_user: User
):
    repo = NotificationRepository(db_session)
    for i in range(3):
        await repo.create(
            **_notification_kwargs(
                recipient=second_user, workspace=test_workspace, dedupe_key=f"k:{i}"
            )
        )

    rows = await repo.list_for_recipient(second_user.id, limit=2)
    assert len(rows) == 2


@pytest.mark.asyncio
async def test_list_for_recipient_before_cursor_excludes_at_and_after(
    db_session: AsyncSession, test_workspace: Workspace, second_user: User
):
    """Keyset pagination: passing `before=<created_at>` returns only rows
    strictly older than the cursor."""
    repo = NotificationRepository(db_session)
    first = await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=test_workspace, dedupe_key="k:1")
    )
    await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=test_workspace, dedupe_key="k:2")
    )
    await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=test_workspace, dedupe_key="k:3")
    )

    full = await repo.list_for_recipient(second_user.id, limit=50)
    # cursor at the newest row -> page back should drop it and return older rows
    page = await repo.list_for_recipient(
        second_user.id, before=full[0].created_at, limit=50
    )
    assert full[0].id not in [r.id for r in page]
    assert first.id in [r.id for r in page]


@pytest.mark.asyncio
async def test_list_for_recipient_unread_only_excludes_read(
    db_session: AsyncSession, test_workspace: Workspace, second_user: User
):
    repo = NotificationRepository(db_session)
    read_row = await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=test_workspace, dedupe_key="k:read")
    )
    unread_row = await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=test_workspace, dedupe_key="k:unread")
    )
    await repo.mark_read(read_row)

    rows = await repo.list_for_recipient(second_user.id, unread_only=True, limit=50)
    ids = [r.id for r in rows]
    assert unread_row.id in ids
    assert read_row.id not in ids


# --------------------------------------------------------------------------- #
# unread_count
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_unread_count_counts_only_unread(
    db_session: AsyncSession, test_workspace: Workspace, second_user: User
):
    repo = NotificationRepository(db_session)
    a = await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=test_workspace, dedupe_key="k:a")
    )
    await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=test_workspace, dedupe_key="k:b")
    )
    assert await repo.unread_count(second_user.id) == 2

    await repo.mark_read(a)
    assert await repo.unread_count(second_user.id) == 1


@pytest.mark.asyncio
async def test_unread_count_filters_by_workspace(
    db_session: AsyncSession, test_workspace: Workspace, second_user: User, test_user: User
):
    """A notification in workspace A is not counted when filtering workspace B;
    counted under its own workspace; both counted with workspace=None."""
    repo = NotificationRepository(db_session)
    ws_b = await _make_workspace(db_session, test_user, "workspace-b")
    await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=test_workspace, dedupe_key="k:a")
    )
    await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=ws_b, dedupe_key="k:b")
    )

    assert await repo.unread_count(second_user.id, workspace_id=test_workspace.id) == 1
    assert await repo.unread_count(second_user.id, workspace_id=ws_b.id) == 1
    assert await repo.unread_count(second_user.id, workspace_id=None) == 2


@pytest.mark.asyncio
async def test_unread_count_isolated_per_recipient(
    db_session: AsyncSession, test_workspace: Workspace, second_user: User, test_user: User
):
    repo = NotificationRepository(db_session)
    await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=test_workspace, dedupe_key="k:a")
    )
    assert await repo.unread_count(second_user.id) == 1
    assert await repo.unread_count(test_user.id) == 0


# --------------------------------------------------------------------------- #
# mark_read / mark_all_read
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_mark_read_sets_read_at(
    db_session: AsyncSession, test_workspace: Workspace, second_user: User
):
    repo = NotificationRepository(db_session)
    row = await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=test_workspace)
    )
    assert row.read_at is None

    updated = await repo.mark_read(row)
    assert updated.read_at is not None


@pytest.mark.asyncio
async def test_mark_read_is_idempotent(
    db_session: AsyncSession, test_workspace: Workspace, second_user: User
):
    repo = NotificationRepository(db_session)
    row = await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=test_workspace)
    )
    first = await repo.mark_read(row)
    stamp = first.read_at
    second = await repo.mark_read(row)
    # marking an already-read row keeps it read (does not error / un-read it)
    assert second.read_at is not None
    assert second.read_at == stamp


@pytest.mark.asyncio
async def test_mark_all_read_clears_unread_for_workspace_only(
    db_session: AsyncSession, test_workspace: Workspace, second_user: User, test_user: User
):
    repo = NotificationRepository(db_session)
    ws_b = await _make_workspace(db_session, test_user, "workspace-b")
    await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=test_workspace, dedupe_key="k:a")
    )
    await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=ws_b, dedupe_key="k:b")
    )

    await repo.mark_all_read(second_user.id, workspace_id=test_workspace.id)

    assert await repo.unread_count(second_user.id, workspace_id=test_workspace.id) == 0
    assert await repo.unread_count(second_user.id, workspace_id=ws_b.id) == 1


@pytest.mark.asyncio
async def test_mark_all_read_workspace_none_clears_all_workspaces(
    db_session: AsyncSession, test_workspace: Workspace, second_user: User, test_user: User
):
    repo = NotificationRepository(db_session)
    ws_b = await _make_workspace(db_session, test_user, "workspace-b")
    await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=test_workspace, dedupe_key="k:a")
    )
    await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=ws_b, dedupe_key="k:b")
    )

    await repo.mark_all_read(second_user.id, workspace_id=None)
    assert await repo.unread_count(second_user.id, workspace_id=None) == 0


@pytest.mark.asyncio
async def test_mark_all_read_does_not_touch_other_recipients(
    db_session: AsyncSession, test_workspace: Workspace, second_user: User, test_user: User
):
    repo = NotificationRepository(db_session)
    await repo.create(
        **_notification_kwargs(recipient=second_user, workspace=test_workspace, dedupe_key="k:a")
    )
    await repo.create(
        **_notification_kwargs(recipient=test_user, workspace=test_workspace, dedupe_key="k:b")
    )

    await repo.mark_all_read(second_user.id, workspace_id=test_workspace.id)
    assert await repo.unread_count(test_user.id, workspace_id=test_workspace.id) == 1
