# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Service-level tests for the PAR-2 merge queue.

Asserts:
  - enqueue is idempotent — re-enqueue of the same card returns the existing
    entry, not 409 (idempotent_mutations).
  - tick(executor) drives queued -> merging -> merged with ws events.
  - tick reports conflict back to the entry + emits ws event.
  - tick is a no-op when nothing is queued.

The git/GitHub side is stubbed via a fake MergeExecutor so the queue
mechanics are testable without real network or repo state.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Awaitable, Callable

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.merge_queue import MergeQueueEntry
from app.models.git.git_repo import GitProvider, GitRepo
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.user import User
from app.models.workspace import Workspace
from app.services import merge_queue as merge_queue_module
from app.services.merge_queue import (
    MergeQueueService,
    MergeResult,
)


async def _make_repo(db: AsyncSession, board: Board, user: User) -> GitRepo:
    repo = GitRepo(
        board_id=board.id,
        workspace_id=board.workspace_id,
        name="acme",
        slug="acme",
        url="https://github.com/acme/acme",
        provider=GitProvider.github,
        default_branch="main",
        integration_branch="develop",
        added_by=user.id,
    )
    db.add(repo)
    await db.flush()
    return repo


async def _make_card(
    db: AsyncSession,
    board: Board,
    column: Column,
    user: User,
    title: str = "card",
    position: float = 1024.0,
) -> Card:
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title=title,
        description="",
        position=position,
        created_by=user.id,
    )
    db.add(card)
    await db.flush()
    return card


class _RecordingBus:
    """Test double that records all publish() calls."""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict, uuid.UUID]] = []

    async def publish(
        self, *, event_type: str, payload: dict, workspace_id: uuid.UUID
    ) -> None:
        self.events.append((event_type, payload, workspace_id))


def _executor_returns(result: MergeResult) -> Callable[..., Awaitable[MergeResult]]:
    async def _go(_entry):
        return result

    return _go


@pytest.mark.asyncio
async def test_enqueue_creates_new_entry(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    bus = _RecordingBus()
    service = MergeQueueService(db_session, event_bus=bus)
    entry, created = await service.enqueue(
        card_id=card.id,
        repo_id=repo.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )

    assert created is True
    assert entry.state == "queued"
    assert any(e[0] == "merge_queue.enqueued" for e in bus.events)


@pytest.mark.asyncio
async def test_enqueue_is_idempotent_for_same_card(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    bus = _RecordingBus()
    service = MergeQueueService(db_session, event_bus=bus)
    first, created_first = await service.enqueue(
        card_id=card.id,
        repo_id=repo.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )
    second, created_second = await service.enqueue(
        card_id=card.id,
        repo_id=repo.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )

    assert created_first is True
    assert created_second is False
    assert first.id == second.id
    enqueue_events = [e for e in bus.events if e[0] == "merge_queue.enqueued"]
    assert len(enqueue_events) == 1, "second enqueue must not re-emit event"


@pytest.mark.asyncio
async def test_tick_processes_merged_entry_emits_ws_events(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    bus = _RecordingBus()
    service = MergeQueueService(db_session, event_bus=bus)
    entry, _ = await service.enqueue(
        card_id=card.id,
        repo_id=repo.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )

    await service.tick(executor=_executor_returns(("merged", datetime.utcnow())))

    refreshed = await service.repo.get(entry.id)
    assert refreshed.state == "merged"
    assert refreshed.merged_at is not None
    event_types = [e[0] for e in bus.events]
    assert "merge_queue.merged" in event_types


@pytest.mark.asyncio
async def test_tick_marks_conflict_and_emits_ws_event(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    bus = _RecordingBus()
    service = MergeQueueService(db_session, event_bus=bus)
    entry, _ = await service.enqueue(
        card_id=card.id,
        repo_id=repo.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )

    await service.tick(
        executor=_executor_returns(("conflict", "merge conflict on file.py"))
    )

    refreshed = await service.repo.get(entry.id)
    assert refreshed.state == "conflict"
    assert refreshed.error_message == "merge conflict on file.py"
    event_types = [e[0] for e in bus.events]
    assert "merge_queue.conflict" in event_types


@pytest.mark.asyncio
async def test_tick_marks_failed_and_emits_ws_event(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    bus = _RecordingBus()
    service = MergeQueueService(db_session, event_bus=bus)
    entry, _ = await service.enqueue(
        card_id=card.id,
        repo_id=repo.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )

    await service.tick(executor=_executor_returns(("failed", "transient github 500")))

    refreshed = await service.repo.get(entry.id)
    assert refreshed.state == "failed"
    assert refreshed.error_message == "transient github 500"
    event_types = [e[0] for e in bus.events]
    assert "merge_queue.failed" in event_types


@pytest.mark.asyncio
async def test_tick_with_no_queued_entries_is_noop(
    db_session: AsyncSession,
):
    bus = _RecordingBus()
    service = MergeQueueService(db_session, event_bus=bus)

    async def _exploding_executor(_entry):  # pragma: no cover
        raise AssertionError("executor must not be called when queue is empty")

    await service.tick(executor=_exploding_executor)
    assert bus.events == []


@pytest.mark.asyncio
async def test_run_tick_persists_state_across_sessions(
    db_engine,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """The worker entry point must commit. The main.py loop opened a bare
    session (no begin/commit), so every tick's state transitions rolled back
    at session close — entries pinned at queued/attempt_count=0 with no
    error_message while the executor silently retried forever (field
    report 2026-08-07). Asserting from a SEPARATE session is the pin:
    only committed state is visible there."""
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.services.merge_queue import run_merge_queue_tick

    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)
    service = MergeQueueService(db_session, event_bus=_RecordingBus())
    entry, _ = await service.enqueue(
        card_id=card.id,
        repo_id=repo.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )
    await db_session.commit()  # the worker runs in its own sessions

    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    bus = _RecordingBus()
    merged_at = datetime(2026, 8, 7, 12, 0)
    processed = await run_merge_queue_tick(
        factory, event_bus=bus, executor=_executor_returns(("merged", merged_at))
    )

    assert processed == 1
    assert any(e[0] == "merge_queue.merged" for e in bus.events)
    async with factory() as check:
        persisted = await check.get(MergeQueueEntry, entry.id)
        assert persisted.state == "merged"
        assert persisted.attempt_count == 1


# ---------------------------------------------------------------------------
# PAR-3c — consolidator-card wiring + re-enqueue path
# ---------------------------------------------------------------------------


async def _set_consolidator_config(
    db: AsyncSession,
    *,
    workspace: Workspace,
    enabled: bool,
    board_id,
    column_id,
    label: str = "consolidate-merge-conflict",
):
    from app.models.workspace_config import WorkspaceConfig

    cfg = WorkspaceConfig(
        workspace_id=workspace.id,
        conflict_consolidator={
            "enabled": enabled,
            "board_id": str(board_id),
            "column_id": str(column_id),
            "label": label,
        },
    )
    db.add(cfg)
    await db.flush()
    return cfg


@pytest.mark.asyncio
async def test_process_entry_conflict_creates_consolidator_when_configured(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    from app.services.conflict_consolidator import ConsolidatorCardCreator
    from app.services.kanban.card import CardService

    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)
    await _set_consolidator_config(
        db_session,
        workspace=test_workspace,
        enabled=True,
        board_id=test_board.id,
        column_id=test_column.id,
    )

    bus = _RecordingBus()
    consolidator = ConsolidatorCardCreator(
        db_session, card_service=CardService(db_session), event_bus=bus
    )
    service = MergeQueueService(db_session, event_bus=bus, consolidator=consolidator)

    entry, _ = await service.enqueue(
        card_id=card.id,
        repo_id=repo.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )
    await service.tick(
        executor=_executor_returns(("conflict", "rebase conflict in: foo.py"))
    )

    event_types = [e[0] for e in bus.events]
    assert "merge_queue.conflict" in event_types
    assert "merge_queue.conflict_consolidator_created" in event_types

    refreshed = await service.repo.get(entry.id)
    assert refreshed.state == "blocked_pending_consolidation"


@pytest.mark.asyncio
async def test_process_entry_conflict_skips_consolidator_when_no_creator_injected(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    bus = _RecordingBus()
    # Note: consolidator kwarg omitted (back-compat with PAR-2 callers).
    service = MergeQueueService(db_session, event_bus=bus)
    entry, _ = await service.enqueue(
        card_id=card.id,
        repo_id=repo.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )
    await service.tick(
        executor=_executor_returns(("conflict", "rebase conflict in: foo.py"))
    )

    event_types = [e[0] for e in bus.events]
    assert "merge_queue.conflict" in event_types
    assert "merge_queue.conflict_consolidator_created" not in event_types
    refreshed = await service.repo.get(entry.id)
    assert refreshed.state == "conflict"


@pytest.mark.asyncio
async def test_process_entry_conflict_transitions_to_blocked_when_consolidator_created(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    from app.services.conflict_consolidator import ConsolidatorCardCreator
    from app.services.kanban.card import CardService

    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)
    await _set_consolidator_config(
        db_session,
        workspace=test_workspace,
        enabled=True,
        board_id=test_board.id,
        column_id=test_column.id,
    )

    consolidator = ConsolidatorCardCreator(
        db_session, card_service=CardService(db_session)
    )
    service = MergeQueueService(db_session, consolidator=consolidator)
    entry, _ = await service.enqueue(
        card_id=card.id,
        repo_id=repo.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )
    await service.tick(
        executor=_executor_returns(("conflict", "rebase conflict in: foo.py"))
    )

    refreshed = await service.repo.get(entry.id)
    # The conflict outcome lands the entry in the blocked-pending-consolidation
    # state once a consolidator card is on file — the original `conflict` row
    # is intentionally a brief, intermediate stop.
    assert refreshed.state == "blocked_pending_consolidation"


@pytest.mark.asyncio
async def test_re_enqueue_parent_resets_state_and_increments_attempt(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    bus = _RecordingBus()
    service = MergeQueueService(db_session, event_bus=bus)
    entry, _ = await service.enqueue(
        card_id=card.id,
        repo_id=repo.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )
    # Force entry to a non-queued state to prove re_enqueue resets it.
    await service.repo.mark_failed(entry.id, error_message="prior failure")

    re_enqueued = await service.re_enqueue_parent(card.id)

    assert re_enqueued.id == entry.id
    assert re_enqueued.state == "queued"
    assert re_enqueued.attempt_count == 1
    assert re_enqueued.error_message is None
    re_events = [
        e
        for e in bus.events
        if e[0] == "merge_queue.enqueued" and e[1].get("re_enqueue") is True
    ]
    assert len(re_events) == 1


@pytest.mark.asyncio
async def test_re_enqueue_parent_idempotent_when_already_queued(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    bus = _RecordingBus()
    service = MergeQueueService(db_session, event_bus=bus)
    entry, _ = await service.enqueue(
        card_id=card.id,
        repo_id=repo.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )
    bus.events.clear()

    re_enqueued = await service.re_enqueue_parent(card.id)
    assert re_enqueued.id == entry.id
    assert re_enqueued.state == "queued"
    # Already-queued path must not emit a duplicate re-enqueue event.
    re_events = [
        e
        for e in bus.events
        if e[0] == "merge_queue.enqueued" and e[1].get("re_enqueue") is True
    ]
    assert len(re_events) == 0


@pytest.mark.asyncio
async def test_re_enqueue_parent_404_when_no_entry(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    from app.exceptions import ResourceNotFoundError

    service = MergeQueueService(db_session)
    bogus_card_id = uuid.uuid4()
    with pytest.raises(ResourceNotFoundError):
        await service.re_enqueue_parent(bogus_card_id)


# --- ci_not_green outcome (card 51810501) -----------------------------------


@pytest.mark.asyncio
async def test_tick_ci_not_green_re_enqueues_and_retries(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """A ci_not_green outcome is retryable WITHOUT human intervention: the
    entry returns to `queued` (never conflict/failed), the transition is
    published, and the very next tick pops it again."""
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    bus = _RecordingBus()
    service = MergeQueueService(db_session, event_bus=bus)
    entry, _ = await service.enqueue(
        card_id=card.id,
        repo_id=repo.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )

    calls = []

    async def executor(e):
        calls.append(e.id)
        return ("ci_not_green", "ci pending on PR head")

    await service.tick(executor=executor)

    refreshed = await service.repo.get(entry.id)
    assert (
        refreshed.state == "queued"
    ), "ci_not_green must be retryable — back to queued, not conflict/failed"
    assert "merge_queue.ci_not_green" in [e[0] for e in bus.events]

    await service.tick(executor=executor)
    assert len(calls) == 2, "the next tick must re-pop the entry"


@pytest.mark.asyncio
async def test_tick_ci_not_green_persists_retry_reason_while_queued(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """Field report round 2: entries churned ci_not_green for 70+
    minutes with error_message null — the reason lived only in the transient
    event, so operators saw a healthy-looking queue. A churning entry must
    carry its latest retry reason while queued."""
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    service = MergeQueueService(db_session, event_bus=_RecordingBus())
    entry, _ = await service.enqueue(
        card_id=card.id,
        repo_id=repo.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )

    await service.tick(
        executor=_executor_returns(
            ("ci_not_green", "ci state unreadable: 403 on check-runs")
        )
    )

    refreshed = await service.repo.get(entry.id)
    assert refreshed.state == "queued"
    assert "ci state unreadable: 403 on check-runs" in (
        refreshed.error_message or ""
    ), "the retry reason must be visible on the queued entry"


@pytest.mark.asyncio
async def test_tick_ci_not_green_requeue_goes_to_back_of_fifo(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """Field report round 2: two churning entries head-of-line
    blocked two fresh ones (attempt_count 6/6/0/0) because re_enqueue kept
    the original enqueued_at. Re-entering the queue must mean the back of
    it: after A churns, the next tick must pop B."""
    repo = await _make_repo(db_session, test_board, test_user)
    card_a = await _make_card(db_session, test_board, test_column, test_user)
    card_b = await _make_card(
        db_session,
        test_board,
        test_column,
        test_user,
        title="fresh behind the churner",
        position=2048.0,
    )

    service = MergeQueueService(db_session, event_bus=_RecordingBus())
    entry_a, _ = await service.enqueue(
        card_id=card_a.id,
        repo_id=repo.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/churner",
        workspace_id=test_workspace.id,
    )
    entry_b, _ = await service.enqueue(
        card_id=card_b.id,
        repo_id=repo.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/2",
        pr_branch="feat/fresh",
        workspace_id=test_workspace.id,
    )
    # A must be strictly older so the first tick provably pops A.
    entry_a.enqueued_at = datetime(2026, 8, 7, 20, 0, 0)
    entry_b.enqueued_at = datetime(2026, 8, 7, 20, 1, 0)
    await db_session.flush()

    async def executor(e):
        if e.pr_url.endswith("/1"):
            return ("ci_not_green", "ci pending on PR head")
        return ("merged", datetime(2026, 8, 7, 21, 0, 0))

    await service.tick(executor=executor)  # pops A, churns it
    await service.tick(executor=executor)  # must pop B, not A again

    refreshed_b = await service.repo.get(entry_b.id)
    assert (
        refreshed_b.state == "merged"
    ), "a churning entry must not starve fresh entries behind it"
    refreshed_a = await service.repo.get(entry_a.id)
    assert refreshed_a.state == "queued"
    assert refreshed_a.enqueued_at > entry_b.enqueued_at


@pytest.mark.asyncio
async def test_tick_ci_not_green_gives_up_after_attempt_bound(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    from app.services.merge_queue import CI_GIVE_UP_ATTEMPTS

    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    bus = _RecordingBus()
    service = MergeQueueService(db_session, event_bus=bus)
    entry, _ = await service.enqueue(
        card_id=card.id,
        repo_id=repo.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )
    # Simulate a long-churning entry one attempt away from the bound.
    entry.attempt_count = CI_GIVE_UP_ATTEMPTS
    await db_session.flush()

    await service.tick(
        executor=_executor_returns(("ci_not_green", "ci pending on PR head"))
    )

    refreshed = await service.repo.get(entry.id)
    assert (
        refreshed.state == "failed"
    ), "past the attempt bound the entry must fail terminally, not churn forever"
    assert "gave up" in (refreshed.error_message or "")
    assert "merge_queue.failed" in [e[0] for e in bus.events]


# --- resolve_board_merge_gate (per-board forge-CI opt-out) -------------------
#
# Joins GitRepo.board_id -> Board.loop_config to answer "does this board gate
# merges on forge CI?". Imported inside each test so the RED-phase missing
# symbol fails these three tests alone instead of erroring the whole module
# at collection.


@pytest.mark.asyncio
async def test_resolve_board_merge_gate_reads_none_from_loop_config(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    from app.services.merge_executor import resolve_board_merge_gate

    repo = await _make_repo(db_session, test_board, test_user)
    test_board.loop_config = {"loop_prompt": "x", "merge_gate": "none"}
    await db_session.flush()

    assert await resolve_board_merge_gate(db_session, repo.id) == "none"


@pytest.mark.asyncio
async def test_resolve_board_merge_gate_missing_key_defaults_to_forge_ci(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """A loop_config stored before merge_gate existed has no key — the gate
    must resolve to the fail-closed default, never KeyError."""
    from app.services.merge_executor import resolve_board_merge_gate

    repo = await _make_repo(db_session, test_board, test_user)
    test_board.loop_config = {"loop_prompt": "x"}
    await db_session.flush()

    assert await resolve_board_merge_gate(db_session, repo.id) == "forge_ci"


@pytest.mark.asyncio
async def test_resolve_board_merge_gate_no_loop_config_defaults_to_forge_ci(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    from app.services.merge_executor import resolve_board_merge_gate

    repo = await _make_repo(db_session, test_board, test_user)
    test_board.loop_config = None
    await db_session.flush()

    assert await resolve_board_merge_gate(db_session, repo.id) == "forge_ci"


@pytest.mark.asyncio
async def test_resolve_board_merge_gate_unknown_repo_defaults_to_forge_ci(
    db_session: AsyncSession,
):
    from app.services.merge_executor import resolve_board_merge_gate

    # Zero-row join (repo deleted mid-flight, or a stale entry): the last
    # fail-closed branch — must resolve to the checking default, never skip.
    assert await resolve_board_merge_gate(db_session, uuid.uuid4()) == "forge_ci"


# --- in-flight visibility (card 2eb2cb76) -----------------------------------


@pytest.mark.asyncio
async def test_process_entry_publishes_merging_before_terminal_event(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """Observers must see the queued -> merging transition, not just the
    terminal outcome: `enqueued` followed by a jump straight to `merged`
    leaves the in-flight window invisible to the Observer panel and the
    merge-queue UI."""
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    bus = _RecordingBus()
    service = MergeQueueService(db_session, event_bus=bus)
    await service.enqueue(
        card_id=card.id,
        repo_id=repo.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )

    await service.tick(executor=_executor_returns(("merged", datetime.utcnow())))

    event_types = [e[0] for e in bus.events]
    assert "merge_queue.merging" in event_types
    assert event_types.index("merge_queue.merging") < event_types.index(
        "merge_queue.merged"
    ), "the in-flight event must precede the terminal one"

    merging_payload = next(
        payload for name, payload, _ in bus.events if name == "merge_queue.merging"
    )
    assert merging_payload["state"] == "merging"
    assert merging_payload["card_id"] == str(card.id)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "outcome",
    [
        ("merged", datetime(2026, 1, 1)),
        ("conflict", "merge conflict on file.py"),
        ("failed", "transient github 500"),
        ("ci_not_green", "ci pending on PR head"),
    ],
    ids=["merged", "conflict", "failed", "ci_not_green"],
)
async def test_every_outcome_publishes_merging_first(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    outcome: MergeResult,
):
    """mark_merging happens before the executor runs, so the in-flight event
    is owed on EVERY path out of process_entry — including the retryable
    ci_not_green one."""
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    bus = _RecordingBus()
    service = MergeQueueService(db_session, event_bus=bus)
    await service.enqueue(
        card_id=card.id,
        repo_id=repo.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )

    await service.tick(executor=_executor_returns(outcome))

    assert "merge_queue.merging" in [e[0] for e in bus.events]


@pytest.mark.asyncio
async def test_every_declared_merge_queue_event_constant_is_reachable(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """Gap-class guard for the defect this card fixes: a constant can be
    declared and never published (or a transition can exist with no constant).
    Drive every outcome through the service and assert the union of emitted
    event types covers every MERGE_QUEUE_* constant the module declares."""
    declared = {
        value
        for name, value in vars(merge_queue_module).items()
        if name.startswith("MERGE_QUEUE_") and isinstance(value, str)
    }

    emitted: set[str] = set()
    outcomes: list[MergeResult] = [
        ("merged", datetime.utcnow()),
        ("conflict", "merge conflict on file.py"),
        ("failed", "transient github 500"),
        ("ci_not_green", "ci pending on PR head"),
    ]
    repo = await _make_repo(db_session, test_board, test_user)
    for index, outcome in enumerate(outcomes):
        card = await _make_card(
            db_session,
            test_board,
            test_column,
            test_user,
            title=f"card-{index}",
            position=1024.0 * (index + 1),
        )
        bus = _RecordingBus()
        service = MergeQueueService(db_session, event_bus=bus)
        await service.enqueue(
            card_id=card.id,
            repo_id=repo.id,
            integration_branch="develop",
            pr_url="https://github.com/acme/acme/pull/1",
            pr_branch="feat/widget",
            workspace_id=test_workspace.id,
        )
        await service.tick(executor=_executor_returns(outcome))
        emitted.update(e[0] for e in bus.events)

    # Members of the family whose publisher is NOT MergeQueueService. Each one
    # must be pinned by its own owner's suite -- listing it here moves the
    # guard, it does not remove it.
    published_elsewhere = {
        # BoardHealthService._notify_newly_stale; pinned by
        # tests/routers/kanban/test_board_health_merge_queue.py
        merge_queue_module.MERGE_QUEUE_STALE,
    }

    assert declared - published_elsewhere <= emitted, (
        "these merge-queue event constants are declared but never published: "
        f"{sorted(declared - published_elsewhere - emitted)}"
    )


@pytest.mark.asyncio
async def test_re_enqueue_preserves_first_enqueued_at(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """`enqueued_at` is FIFO position and must keep moving to the back on every
    retry; `first_enqueued_at` is how long the entry has been stuck and must
    NOT. Conflating the two made hot retry loops invisible to the stale
    detector (proxmox Round 11)."""
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    service = MergeQueueService(db_session, event_bus=_RecordingBus())
    entry, _ = await service.enqueue(
        card_id=card.id,
        repo_id=repo.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/churner",
        workspace_id=test_workspace.id,
    )
    original_first_enqueued = entry.first_enqueued_at
    assert original_first_enqueued is not None, "enqueue must stamp the origin time"

    entry.state = "conflict"
    entry.enqueued_at = datetime(2026, 8, 7, 20, 0, 0)
    await db_session.flush()

    requeued = await service.repo.re_enqueue(entry.id, retry_reason="ci_not_green")

    assert requeued.enqueued_at > datetime(2026, 8, 7, 20, 0, 0)
    assert requeued.first_enqueued_at == original_first_enqueued


@pytest.mark.asyncio
async def test_re_enqueue_backfills_first_enqueued_at_for_legacy_rows(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """Rows predating the additive migration carry NULL. The first retry after
    the deploy adopts their existing `enqueued_at` as the origin, so a legacy
    churner does not restart its stale clock from the deploy moment."""
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    service = MergeQueueService(db_session, event_bus=_RecordingBus())
    entry, _ = await service.enqueue(
        card_id=card.id,
        repo_id=repo.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/legacy",
        workspace_id=test_workspace.id,
    )
    legacy_enqueued_at = datetime(2026, 8, 7, 20, 0, 0)
    entry.state = "conflict"
    entry.enqueued_at = legacy_enqueued_at
    entry.first_enqueued_at = None
    await db_session.flush()

    requeued = await service.repo.re_enqueue(entry.id, retry_reason="ci_not_green")

    assert requeued.first_enqueued_at == legacy_enqueued_at
