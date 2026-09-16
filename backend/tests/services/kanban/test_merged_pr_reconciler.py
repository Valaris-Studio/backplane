# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Loop starvation 3/3 — merged-PR → Done reconciler.

Nothing in the platform moved a card to Done when its PR merged; the operator
merged PRs and then hand-called move_card eleven times, and forgetting the
second action silently starved loop mode (dependencies key strictly on
done-typed columns). The reconciler lands the card automatically via two
paths:

  - event: `merge_queue.merged` — the platform's own merge executor merged
    the entry's PR; its card must follow.
  - poll:  `scan_once` — cards in review-typed columns carrying a GitHub PR
    URL are checked against GitHub; merged → moved to the board's done
    column. Covers merges done directly on GitHub (the field-report case).

Gate policy (owner-aligned 2026-08-07): a merged PR is the strongest form of
landing — the human who merged IS the review. The reconciler runs with no
agent contextvar, so the done-merge gate treats it as human-driven and the
reviewer-verdict backstop does not apply. Tests are written against
`scan_once`/`_handle_event` directly — the asyncio loop in main.py only adds
scheduling (the merge-queue wiring test precedent).
"""

import uuid

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.event_bus import Event
from app.exceptions import BadGatewayError
from app.models.activity import Activity
from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardDependency
from app.models.kanban.column import Column, ColumnType
from app.models.user import User
from app.models.workspace import Workspace
from app.services.github_client import PRStatus
from app.services.kanban.card import attach_dependency_counts, compute_loop_readiness
from app.services.kanban.reconciler import MergedPRReconciler
from app.services.merge_queue import MERGE_QUEUE_MERGED


GITHUB_PR = "https://github.com/valaris/repo/pull/42"
GITEA_PR = "https://git.example.com/valaris/repo/pulls/7"


async def _new_column(
    db: AsyncSession,
    *,
    board: Board,
    name: str,
    column_type: ColumnType | None,
    position: float,
) -> Column:
    col = Column(
        board_id=board.id,
        name=name,
        position=position,
        color="#6b7280",
        column_type=column_type,
    )
    db.add(col)
    await db.flush()
    return col


async def _new_card(
    db: AsyncSession,
    *,
    board: Board,
    column: Column,
    user: User,
    title: str,
    position: float = 1024.0,
    description: str = "",
    pr_url: str | None = None,
) -> Card:
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title=title,
        description=description,
        position=position,
        created_by=user.id,
        pr_url=pr_url,
    )
    db.add(card)
    await db.flush()
    return card


class RecordingFetcher:
    """PR-status fake: url → PRStatus | Exception. Records every call."""

    def __init__(self, statuses: dict[str, PRStatus | Exception]):
        self.statuses = statuses
        self.calls: list[str] = []

    async def __call__(self, pr_url: str) -> PRStatus:
        self.calls.append(pr_url)
        result = self.statuses[pr_url]
        if isinstance(result, Exception):
            raise result
        return result


MERGED = PRStatus(merged=True, mergeable=None, state="closed")
OPEN = PRStatus(merged=False, mergeable=True, state="open")


def make_reconciler(
    statuses: dict[str, PRStatus | Exception] | None = None,
    session_factory=None,
) -> tuple[MergedPRReconciler, RecordingFetcher]:
    fetcher = RecordingFetcher(statuses or {})
    return (
        MergedPRReconciler(
            session_factory=session_factory, pr_status_fetcher=fetcher
        ),
        fetcher,
    )


@pytest.fixture
def review_setup_factory(db_session, test_board, test_user):
    async def _make():
        review = await _new_column(
            db_session, board=test_board, name="Review",
            column_type=ColumnType.review, position=2048.0,
        )
        done = await _new_column(
            db_session, board=test_board, name="Done",
            column_type=ColumnType.done, position=4096.0,
        )
        return review, done

    return _make


async def _column_of(db: AsyncSession, card_id: uuid.UUID) -> uuid.UUID:
    return (
        await db.execute(select(Card.column_id).where(Card.id == card_id))
    ).scalar_one()


async def test_scan_moves_merged_review_card_to_done(
    db_session, test_board, test_user, test_workspace, review_setup_factory
):
    review, done = await review_setup_factory()
    card = await _new_card(
        db_session, board=test_board, column=review, user=test_user,
        title="shipped work", description=f"PR: {GITHUB_PR}",
    )
    reconciler, fetcher = make_reconciler({GITHUB_PR: MERGED})

    moved = await reconciler.scan_once(db_session)

    assert moved == 1
    assert await _column_of(db_session, card.id) == done.id
    assert fetcher.calls == [GITHUB_PR]


async def test_scan_records_reconciler_activity(
    db_session, test_board, test_user, test_workspace, review_setup_factory
):
    review, done = await review_setup_factory()
    card = await _new_card(
        db_session, board=test_board, column=review, user=test_user,
        title="shipped work", pr_url=GITHUB_PR,
    )
    reconciler, _ = make_reconciler({GITHUB_PR: MERGED})

    await reconciler.scan_once(db_session)

    activity = (
        await db_session.execute(
            select(Activity).where(Activity.entity_id == card.id)
        )
    ).scalars().all()
    assert len(activity) == 1
    assert "reconciler" in activity[0].summary
    # after_state is what lets the board relocate the card without a refetch
    # (board-event-reconciler.ts) — the WS event is a side effect of this row.
    assert activity[0].after_state["column_id"] == str(done.id)


async def test_scan_leaves_open_pr_untouched(
    db_session, test_board, test_user, test_workspace, review_setup_factory
):
    review, _ = await review_setup_factory()
    card = await _new_card(
        db_session, board=test_board, column=review, user=test_user,
        title="in review", pr_url=GITHUB_PR,
    )
    reconciler, fetcher = make_reconciler({GITHUB_PR: OPEN})

    moved = await reconciler.scan_once(db_session)

    assert moved == 0
    assert await _column_of(db_session, card.id) == review.id
    assert fetcher.calls == [GITHUB_PR]


async def test_scan_skips_cards_without_pr_and_non_github_forges(
    db_session, test_board, test_user, test_workspace, review_setup_factory
):
    review, _ = await review_setup_factory()
    no_pr = await _new_card(
        db_session, board=test_board, column=review, user=test_user,
        title="no pr yet",
    )
    gitea = await _new_card(
        db_session, board=test_board, column=review, user=test_user,
        title="gitea pr", position=2048.0, pr_url=GITEA_PR,
    )
    reconciler, fetcher = make_reconciler({})

    moved = await reconciler.scan_once(db_session)

    assert moved == 0
    assert fetcher.calls == []  # neither card may reach GitHub
    assert await _column_of(db_session, no_pr.id) == review.id
    assert await _column_of(db_session, gitea.id) == review.id


async def test_scan_ignores_cards_outside_review_columns(
    db_session, test_board, test_user, test_workspace, review_setup_factory
):
    """Backlog/active/done/untyped cards are never probed — the poll path is
    strictly review-scoped (a merged PR on a backlog card is not this
    reconciler's business)."""
    review, done = await review_setup_factory()
    backlog = await _new_column(
        db_session, board=test_board, name="Backlog",
        column_type=ColumnType.backlog, position=1024.0,
    )
    in_backlog = await _new_card(
        db_session, board=test_board, column=backlog, user=test_user,
        title="backlog with pr", pr_url=GITHUB_PR,
    )
    already_done = await _new_card(
        db_session, board=test_board, column=done, user=test_user,
        title="landed", pr_url=GITHUB_PR,
    )
    reconciler, fetcher = make_reconciler({GITHUB_PR: MERGED})

    moved = await reconciler.scan_once(db_session)

    assert moved == 0
    assert fetcher.calls == []
    assert await _column_of(db_session, in_backlog.id) == backlog.id
    assert await _column_of(db_session, already_done.id) == done.id


async def test_scan_github_unreachable_skips_quietly_and_retries_next_pass(
    db_session, test_board, test_user, test_workspace, review_setup_factory
):
    review, done = await review_setup_factory()
    card = await _new_card(
        db_session, board=test_board, column=review, user=test_user,
        title="flaky github", pr_url=GITHUB_PR,
    )
    reconciler, fetcher = make_reconciler(
        {GITHUB_PR: BadGatewayError("github down")}
    )

    moved = await reconciler.scan_once(db_session)
    assert moved == 0
    assert await _column_of(db_session, card.id) == review.id

    # Next pass: GitHub is back and reports merged — the card lands.
    fetcher.statuses[GITHUB_PR] = MERGED
    moved = await reconciler.scan_once(db_session)
    assert moved == 1
    assert await _column_of(db_session, card.id) == done.id


async def test_scan_board_without_done_column_skips_safely(
    db_session, test_board, test_user, test_workspace
):
    review = await _new_column(
        db_session, board=test_board, name="Review",
        column_type=ColumnType.review, position=2048.0,
    )
    card = await _new_card(
        db_session, board=test_board, column=review, user=test_user,
        title="nowhere to land", pr_url=GITHUB_PR,
    )
    reconciler, _ = make_reconciler({GITHUB_PR: MERGED})

    moved = await reconciler.scan_once(db_session)

    assert moved == 0
    assert await _column_of(db_session, card.id) == review.id


async def test_scan_unblocks_downstream_and_flips_readiness(
    db_session, test_board, test_user, test_workspace, review_setup_factory
):
    """The whole point of the chain: merge → reconcile → dependency unblocks →
    readiness flips actionable → a parked loop would wake and work. Zero human
    board touches."""
    review, done = await review_setup_factory()
    backlog = await _new_column(
        db_session, board=test_board, name="Backlog",
        column_type=ColumnType.backlog, position=1024.0,
    )
    upstream = await _new_card(
        db_session, board=test_board, column=review, user=test_user,
        title="merged upstream", pr_url=GITHUB_PR,
    )
    downstream = await _new_card(
        db_session, board=test_board, column=backlog, user=test_user,
        title="blocked downstream",
    )
    db_session.add(
        CardDependency(
            card_id=downstream.id,
            depends_on_card_id=upstream.id,
            created_by=test_user.id,
        )
    )
    await db_session.flush()

    before = await compute_loop_readiness(db_session, test_board.id)
    assert before["actionable"] is False
    assert before["awaiting_merge_count"] == 1

    reconciler, _ = make_reconciler({GITHUB_PR: MERGED})
    await reconciler.scan_once(db_session)

    await attach_dependency_counts(db_session, [downstream])
    assert downstream.dependency_status == "unblocked"
    after = await compute_loop_readiness(db_session, test_board.id)
    assert after["actionable"] is True
    assert after["awaiting_merge_count"] == 0


async def test_land_card_rereads_row_before_already_done_check(
    db_session, test_board, test_user, test_workspace, review_setup_factory
):
    """start-prod.sh runs two gunicorn workers, each with its own poll loop.
    Worker B loads a review card, worker A lands it and commits, and B's
    identity map still says Review — trusting it double-lands the card
    (observed on a field board 2026-08-07: every landing logged twice,
    duplicate activity rows). The already-done check must re-read the row."""
    review, done = await review_setup_factory()
    card = await _new_card(
        db_session, board=test_board, column=review, user=test_user,
        title="landed by the other worker", pr_url=GITHUB_PR,
    )
    reconciler, _ = make_reconciler({GITHUB_PR: MERGED})

    # Worker A's landing as B experiences it: the row changes underneath the
    # identity map (synchronize_session=False keeps B's object stale, like a
    # concurrent connection's committed write under READ COMMITTED).
    await db_session.execute(
        update(Card)
        .where(Card.id == card.id)
        .values(column_id=done.id)
        .execution_options(synchronize_session=False)
    )
    assert card.column_id == review.id  # B's object is genuinely stale

    moved = await reconciler._land_card(db_session, card)

    assert moved is False
    activity = (
        await db_session.execute(
            select(Activity).where(Activity.entity_id == card.id)
        )
    ).scalars().all()
    assert activity == []


# --- event path: merge_queue.merged -----------------------------------------


def _merged_event(card: Card, workspace: Workspace, remote: bool = False) -> Event:
    return Event(
        event_type=MERGE_QUEUE_MERGED,
        workspace_id=workspace.id,
        payload={"card_id": str(card.id), "state": "merged"},
        remote=remote,
    )


async def test_event_lands_card_without_pr_recheck(
    db_engine,
    db_session,
    test_board,
    test_user,
    test_workspace,
    review_setup_factory,
):
    review, done = await review_setup_factory()
    card = await _new_card(
        db_session, board=test_board, column=review, user=test_user,
        title="queue-merged", pr_url=GITHUB_PR,
    )
    await db_session.commit()  # the handler opens its own session

    factory = async_sessionmaker(
        db_engine, class_=AsyncSession, expire_on_commit=False
    )
    # No PR statuses configured: the platform itself merged this PR — the
    # event is the proof, no GitHub round-trip.
    reconciler, fetcher = make_reconciler({}, session_factory=factory)

    await reconciler._handle_event(_merged_event(card, test_workspace))

    assert fetcher.calls == []
    async with factory() as check:
        assert await _column_of(check, card.id) == done.id


async def test_event_remote_replica_copy_ignored(
    db_engine,
    db_session,
    test_board,
    test_user,
    test_workspace,
    review_setup_factory,
):
    """Under the postgres event bus every replica sees every event — only the
    originating instance may act, or N replicas race the same move."""
    review, _ = await review_setup_factory()
    card = await _new_card(
        db_session, board=test_board, column=review, user=test_user,
        title="remote copy", pr_url=GITHUB_PR,
    )
    await db_session.commit()

    factory = async_sessionmaker(
        db_engine, class_=AsyncSession, expire_on_commit=False
    )
    reconciler, _ = make_reconciler({}, session_factory=factory)

    await reconciler._handle_event(
        _merged_event(card, test_workspace, remote=True)
    )

    async with factory() as check:
        assert await _column_of(check, card.id) == review.id


async def test_event_missing_card_is_noop(
    db_engine, db_session, test_workspace
):
    factory = async_sessionmaker(
        db_engine, class_=AsyncSession, expire_on_commit=False
    )
    reconciler, _ = make_reconciler({}, session_factory=factory)

    event = Event(
        event_type=MERGE_QUEUE_MERGED,
        workspace_id=test_workspace.id,
        payload={"card_id": str(uuid.uuid4()), "state": "merged"},
    )
    # Must not raise — a deleted card simply has nothing to land.
    await reconciler._handle_event(event)
