# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Board health surfaces stuck merge-queue entries.

Origin: the merge-queue worker rollback bug (2aa905f) pinned four entries at
`queued`/`attempt_count=0` for 70+ minutes with no operator-visible signal.
"""

import uuid
from datetime import timedelta
from unittest.mock import AsyncMock, patch

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.event_bus import event_bus
from app.models.agents.merge_queue import MergeQueueEntry
from app.models.git.git_repo import GitProvider, GitRepo
from app.models.kanban.board import Board
from app.models.kanban.card import Card, Priority
from app.models.kanban.column import Column
from app.models.user import User
from app.models.workspace import Workspace
from app.services.merge_queue import MERGE_QUEUE_STALE
from app.utils import utcnow


def _health_url(board_id: uuid.UUID) -> str:
    return f"/api/workspaces/default/boards/{board_id}/health"


async def _create_column(db: AsyncSession, board: Board) -> Column:
    column = Column(board_id=board.id, name="To Do", position=1024.0, color="#6b7280")
    db.add(column)
    await db.flush()
    return column


async def _create_card(
    db: AsyncSession, board: Board, column: Column, user: User, title: str = "Card"
) -> Card:
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title=title,
        description="Some description",
        priority=Priority.medium,
        position=1024.0,
        created_by=user.id,
    )
    db.add(card)
    await db.flush()
    return card


async def _create_repo(
    db: AsyncSession, board: Board, workspace: Workspace, user: User
) -> GitRepo:
    repo = GitRepo(
        board_id=board.id,
        workspace_id=workspace.id,
        name="valaris-intern",
        url="https://github.com/Valaris-Studio/valaris-intern",
        provider=GitProvider.github,
        default_branch="main",
        added_by=user.id,
    )
    db.add(repo)
    await db.flush()
    return repo


async def _enqueue(
    db: AsyncSession,
    *,
    repo: GitRepo,
    card: Card,
    workspace: Workspace,
    state: str = "queued",
    attempt_count: int = 0,
    error_message: str | None = None,
    age_seconds: int = 0,
) -> MergeQueueEntry:
    entry = MergeQueueEntry(
        repo_id=repo.id,
        integration_branch="integration",
        card_id=card.id,
        pr_url=f"https://github.com/Valaris-Studio/valaris-intern/pull/{card.title}",
        pr_branch=f"card/{card.title}",
        workspace_id=workspace.id,
        enqueued_at=utcnow() - timedelta(seconds=age_seconds),
        state=state,
        attempt_count=attempt_count,
        error_message=error_message,
    )
    db.add(entry)
    await db.flush()
    return entry


async def test_board_health_merge_queue_absent_when_queue_empty(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    """A board with no queue entries reports zeros and no stale entries."""
    await _create_column(db_session, test_board)

    response = await client.get(_health_url(test_board.id))
    assert response.status_code == 200
    merge_queue = response.json()["merge_queue"]

    assert merge_queue["active_count"] == 0
    assert merge_queue["oldest_queued_age_seconds"] is None
    assert merge_queue["stale_entries"] == []


async def test_board_health_merge_queue_classifies_worker_stalled(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    """Age past threshold with attempts frozen at 0 and no error = infra problem."""
    column = await _create_column(db_session, test_board)
    card = await _create_card(db_session, test_board, column, test_user)
    repo = await _create_repo(db_session, test_board, test_workspace, test_user)
    age = settings.MERGE_QUEUE_STALE_THRESHOLD_SECONDS + 120
    entry = await _enqueue(
        db_session,
        repo=repo,
        card=card,
        workspace=test_workspace,
        state="queued",
        attempt_count=0,
        age_seconds=age,
    )

    response = await client.get(_health_url(test_board.id))
    assert response.status_code == 200
    merge_queue = response.json()["merge_queue"]

    assert merge_queue["active_count"] == 1
    assert merge_queue["oldest_queued_age_seconds"] >= settings.MERGE_QUEUE_STALE_THRESHOLD_SECONDS
    assert len(merge_queue["stale_entries"]) == 1

    stale = merge_queue["stale_entries"][0]
    assert stale["entry_id"] == str(entry.id)
    assert stale["card_id"] == str(card.id)
    assert stale["state"] == "queued"
    assert stale["attempt_count"] == 0
    assert stale["error_message"] is None
    assert stale["classification"] == "worker_stalled"
    assert stale["age_seconds"] >= settings.MERGE_QUEUE_STALE_THRESHOLD_SECONDS


async def test_board_health_merge_queue_classifies_entry_failing(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    """Climbing attempts or a persisted error mean the entry itself is the problem."""
    column = await _create_column(db_session, test_board)
    card = await _create_card(db_session, test_board, column, test_user)
    repo = await _create_repo(db_session, test_board, test_workspace, test_user)
    await _enqueue(
        db_session,
        repo=repo,
        card=card,
        workspace=test_workspace,
        state="queued",
        attempt_count=3,
        error_message="rebase failed",
        age_seconds=settings.MERGE_QUEUE_STALE_THRESHOLD_SECONDS + 60,
    )

    response = await client.get(_health_url(test_board.id))
    assert response.status_code == 200
    stale_entries = response.json()["merge_queue"]["stale_entries"]

    assert len(stale_entries) == 1
    assert stale_entries[0]["classification"] == "entry_failing"
    assert stale_entries[0]["attempt_count"] == 3
    assert stale_entries[0]["error_message"] == "rebase failed"


async def test_board_health_merge_queue_ignores_fresh_entries(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    """An entry younger than the threshold is active but not stale."""
    column = await _create_column(db_session, test_board)
    card = await _create_card(db_session, test_board, column, test_user)
    repo = await _create_repo(db_session, test_board, test_workspace, test_user)
    await _enqueue(
        db_session,
        repo=repo,
        card=card,
        workspace=test_workspace,
        state="queued",
        age_seconds=5,
    )

    response = await client.get(_health_url(test_board.id))
    assert response.status_code == 200
    merge_queue = response.json()["merge_queue"]

    assert merge_queue["active_count"] == 1
    assert merge_queue["stale_entries"] == []


async def test_board_health_merge_queue_ignores_terminal_states(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    """merged/failed/conflict entries never surface as stale, however old."""
    column = await _create_column(db_session, test_board)
    repo = await _create_repo(db_session, test_board, test_workspace, test_user)
    old = settings.MERGE_QUEUE_STALE_THRESHOLD_SECONDS + 3600
    for index, state in enumerate(("merged", "failed", "conflict")):
        card = await _create_card(
            db_session, test_board, column, test_user, title=f"card{index}"
        )
        await _enqueue(
            db_session,
            repo=repo,
            card=card,
            workspace=test_workspace,
            state=state,
            age_seconds=old,
        )

    response = await client.get(_health_url(test_board.id))
    assert response.status_code == 200
    merge_queue = response.json()["merge_queue"]

    assert merge_queue["active_count"] == 0
    assert merge_queue["oldest_queued_age_seconds"] is None
    assert merge_queue["stale_entries"] == []


async def test_board_health_merge_queue_scoped_to_board(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    """A stuck entry on a sibling board does not leak into this board's health."""
    column = await _create_column(db_session, test_board)
    repo = await _create_repo(db_session, test_board, test_workspace, test_user)

    other_board = Board(
        workspace_id=test_workspace.id,
        name="Other",
        slug="other",
        description="",
        created_by=test_user.id,
    )
    db_session.add(other_board)
    await db_session.flush()
    other_column = await _create_column(db_session, other_board)
    other_card = await _create_card(
        db_session, other_board, other_column, test_user, title="other"
    )
    await _enqueue(
        db_session,
        repo=repo,
        card=other_card,
        workspace=test_workspace,
        state="queued",
        age_seconds=settings.MERGE_QUEUE_STALE_THRESHOLD_SECONDS + 600,
    )

    await _create_card(db_session, test_board, column, test_user)

    response = await client.get(_health_url(test_board.id))
    assert response.status_code == 200
    merge_queue = response.json()["merge_queue"]

    assert merge_queue["active_count"] == 0
    assert merge_queue["stale_entries"] == []


def _stale_events(mock_publish) -> list[tuple[str, dict, uuid.UUID]]:
    """Normalize publish calls to (event_type, payload, workspace_id), keeping
    only merge_queue.stale — board health publishes nothing else today, but
    pinning the filter keeps these assertions honest if that changes."""
    events = []
    for call in mock_publish.await_args_list:
        args, kwargs = call.args, call.kwargs
        event_type = kwargs.get("event_type", args[0] if len(args) > 0 else None)
        payload = kwargs.get("payload", args[1] if len(args) > 1 else None)
        workspace_id = kwargs.get("workspace_id", args[2] if len(args) > 2 else None)
        if event_type == MERGE_QUEUE_STALE:
            events.append((event_type, payload, workspace_id))
    return events


async def test_stale_crossing_publishes_one_event(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    """Crossing the threshold pushes the operator a WS event, not just a pull-only
    health field."""
    column = await _create_column(db_session, test_board)
    card = await _create_card(db_session, test_board, column, test_user)
    repo = await _create_repo(db_session, test_board, test_workspace, test_user)
    age = settings.MERGE_QUEUE_STALE_THRESHOLD_SECONDS + 120
    entry = await _enqueue(
        db_session,
        repo=repo,
        card=card,
        workspace=test_workspace,
        state="queued",
        attempt_count=0,
        age_seconds=age,
    )

    with patch.object(event_bus, "publish", new_callable=AsyncMock) as mock_publish:
        response = await client.get(_health_url(test_board.id))
        assert response.status_code == 200
        events = _stale_events(mock_publish)

    assert len(events) == 1
    event_type, payload, workspace_id = events[0]
    assert event_type == "merge_queue.stale"
    assert workspace_id == test_workspace.id
    assert payload["entry_id"] == str(entry.id)
    assert payload["card_id"] == str(card.id)
    assert payload["board_id"] == str(test_board.id)
    assert payload["state"] == "queued"
    assert payload["classification"] == "worker_stalled"
    assert payload["age_seconds"] >= settings.MERGE_QUEUE_STALE_THRESHOLD_SECONDS


async def test_stale_entry_does_not_re_publish_on_later_polls(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    """The wedge that motivated this card sat stuck for 70+ minutes. At a poll
    per few seconds, re-emitting per poll would bury the bus."""
    column = await _create_column(db_session, test_board)
    card = await _create_card(db_session, test_board, column, test_user)
    repo = await _create_repo(db_session, test_board, test_workspace, test_user)
    await _enqueue(
        db_session,
        repo=repo,
        card=card,
        workspace=test_workspace,
        state="queued",
        age_seconds=settings.MERGE_QUEUE_STALE_THRESHOLD_SECONDS + 600,
    )

    with patch.object(event_bus, "publish", new_callable=AsyncMock) as mock_publish:
        first = await client.get(_health_url(test_board.id))
        assert first.status_code == 200
        assert len(_stale_events(mock_publish)) == 1

    with patch.object(event_bus, "publish", new_callable=AsyncMock) as mock_publish:
        second = await client.get(_health_url(test_board.id))
        assert second.status_code == 200
        assert _stale_events(mock_publish) == []

    # The health field itself must keep reporting the entry — the latch
    # suppresses the notification, never the state.
    assert len(second.json()["merge_queue"]["stale_entries"]) == 1


async def test_fresh_entry_publishes_nothing(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    """An entry below the threshold has not crossed anything yet."""
    column = await _create_column(db_session, test_board)
    card = await _create_card(db_session, test_board, column, test_user)
    repo = await _create_repo(db_session, test_board, test_workspace, test_user)
    await _enqueue(
        db_session, repo=repo, card=card, workspace=test_workspace, age_seconds=5
    )

    with patch.object(event_bus, "publish", new_callable=AsyncMock) as mock_publish:
        response = await client.get(_health_url(test_board.id))
        assert response.status_code == 200
        assert _stale_events(mock_publish) == []


async def test_hot_retry_loop_surfaces_stale_despite_bumped_enqueued_at(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    """A churning entry is the most operator-relevant stuck state, and it was
    the one the detector could never see (proxmox Round 11): re_enqueue bumps
    `enqueued_at` to the back of the FIFO on every attempt, so age-since-enqueue
    stayed near zero for 20 minutes of ci_not_green churn. Staleness is measured
    from `first_enqueued_at` — when the entry ENTERED the queue, not when it was
    last retried.
    """
    column = await _create_column(db_session, test_board)
    card = await _create_card(db_session, test_board, column, test_user)
    repo = await _create_repo(db_session, test_board, test_workspace, test_user)
    entry = await _enqueue(
        db_session,
        repo=repo,
        card=card,
        workspace=test_workspace,
        state="queued",
        attempt_count=37,
        error_message="ci pending on PR head",
        age_seconds=8,
    )
    entry.first_enqueued_at = utcnow() - timedelta(
        seconds=settings.MERGE_QUEUE_STALE_THRESHOLD_SECONDS + 600
    )
    await db_session.flush()

    with patch.object(event_bus, "publish", new_callable=AsyncMock) as mock_publish:
        response = await client.get(_health_url(test_board.id))
        assert response.status_code == 200
        events = _stale_events(mock_publish)

    stale = response.json()["merge_queue"]["stale_entries"]
    assert len(stale) == 1, "a continuously-retrying entry must surface as stale"
    assert stale[0]["entry_id"] == str(entry.id)
    assert stale[0]["classification"] == "entry_failing"
    assert stale[0]["age_seconds"] >= settings.MERGE_QUEUE_STALE_THRESHOLD_SECONDS
    assert len(events) == 1, "notify-once semantics are unchanged for retriers"


async def test_hot_retry_stale_notifies_exactly_once_across_polls(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    """The stale_notified_at latch must hold for retry-derived staleness too."""
    column = await _create_column(db_session, test_board)
    card = await _create_card(db_session, test_board, column, test_user)
    repo = await _create_repo(db_session, test_board, test_workspace, test_user)
    entry = await _enqueue(
        db_session,
        repo=repo,
        card=card,
        workspace=test_workspace,
        attempt_count=12,
        error_message="ci pending on PR head",
        age_seconds=3,
    )
    entry.first_enqueued_at = utcnow() - timedelta(
        seconds=settings.MERGE_QUEUE_STALE_THRESHOLD_SECONDS + 60
    )
    await db_session.flush()

    with patch.object(event_bus, "publish", new_callable=AsyncMock) as mock_publish:
        assert (await client.get(_health_url(test_board.id))).status_code == 200
        assert len(_stale_events(mock_publish)) == 1

    with patch.object(event_bus, "publish", new_callable=AsyncMock) as mock_publish:
        second = await client.get(_health_url(test_board.id))
        assert second.status_code == 200
        assert _stale_events(mock_publish) == []

    assert len(second.json()["merge_queue"]["stale_entries"]) == 1


async def test_null_first_enqueued_at_falls_back_to_enqueued_at(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    """Rows written before the additive migration carry NULL; they must keep
    their existing unattended-entry staleness behavior, not lose it."""
    column = await _create_column(db_session, test_board)
    card = await _create_card(db_session, test_board, column, test_user)
    repo = await _create_repo(db_session, test_board, test_workspace, test_user)
    entry = await _enqueue(
        db_session,
        repo=repo,
        card=card,
        workspace=test_workspace,
        age_seconds=settings.MERGE_QUEUE_STALE_THRESHOLD_SECONDS + 120,
    )
    entry.first_enqueued_at = None
    await db_session.flush()

    response = await client.get(_health_url(test_board.id))
    assert response.status_code == 200
    stale = response.json()["merge_queue"]["stale_entries"]
    assert len(stale) == 1
    assert stale[0]["classification"] == "worker_stalled"
