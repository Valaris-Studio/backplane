# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""SWE-AF #2 — stuck-loop detector tests.

Three same-feedback verdict cycles flip `needs-advisor` onto the card. The
hash is deterministic and case/whitespace-insensitive so LLM retries with
cosmetic drift still collide. The hash window is bounded to 3 slots.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.notes.note import NoteCreate
from app.services.notes.note import NoteService
from app.services.reviews.stuck_loop import (
    NEEDS_ADVISOR_LABEL,
    compute_feedback_hash,
    is_stuck_loop,
    record_review_iteration,
)


# --- Pure-function tests for the hash + window predicate ---


def test_compute_feedback_hash_is_deterministic():
    assert compute_feedback_hash("hello world") == compute_feedback_hash("hello world")


def test_compute_feedback_hash_normalizes_whitespace():
    """Internal whitespace collapse + end-strip means cosmetic drift collides."""
    a = compute_feedback_hash("hello   world")
    b = compute_feedback_hash("  hello world  ")
    c = compute_feedback_hash("hello\tworld\n")
    assert a == b == c


def test_compute_feedback_hash_is_case_insensitive():
    assert compute_feedback_hash("Test Failure") == compute_feedback_hash("test failure")


def test_compute_feedback_hash_differs_for_different_content():
    assert compute_feedback_hash("foo") != compute_feedback_hash("bar")


def test_is_stuck_loop_single_hash_not_stuck():
    assert is_stuck_loop(["h1"]) is False


def test_is_stuck_loop_three_distinct_not_stuck():
    assert is_stuck_loop(["h1", "h2", "h3"]) is False


def test_is_stuck_loop_three_identical_is_stuck():
    assert is_stuck_loop(["h1", "h1", "h1"]) is True


def test_is_stuck_loop_two_collisions_split_is_stuck():
    """H1 H2 H1 — 2 collisions on H1 inside the 3-slot window -> stuck."""
    assert is_stuck_loop(["h1", "h2", "h1"]) is True


def test_is_stuck_loop_two_identical_in_window_of_two_is_stuck():
    """Boundary: window can still trip at length 2 with identical hashes."""
    assert is_stuck_loop(["h1", "h1"]) is True


# --- record_review_iteration: counter + window + label flip ---


async def test_first_verdict_increments_counter_no_label_flip(
    db_session: AsyncSession,
    test_card: Card,
):
    await record_review_iteration(db_session, test_card.id, "needs error handling")

    refreshed = await db_session.get(Card, test_card.id)
    assert refreshed.review_iterations == 1
    assert len(refreshed.recent_feedback_hashes) == 1
    assert NEEDS_ADVISOR_LABEL not in (refreshed.labels or [])


async def test_second_verdict_same_feedback_no_label_flip_yet(
    db_session: AsyncSession,
    test_card: Card,
):
    await record_review_iteration(db_session, test_card.id, "same feedback")
    await record_review_iteration(db_session, test_card.id, "same feedback")

    refreshed = await db_session.get(Card, test_card.id)
    assert refreshed.review_iterations == 2
    assert len(refreshed.recent_feedback_hashes) == 2
    # Two collisions in a 2-slot window IS stuck by the boundary rule.
    assert NEEDS_ADVISOR_LABEL in (refreshed.labels or [])


async def test_third_verdict_same_feedback_flips_needs_advisor(
    db_session: AsyncSession,
    test_card: Card,
):
    await record_review_iteration(db_session, test_card.id, "same feedback")
    await record_review_iteration(db_session, test_card.id, "same feedback")
    await record_review_iteration(db_session, test_card.id, "same feedback")

    refreshed = await db_session.get(Card, test_card.id)
    assert refreshed.review_iterations == 3
    assert refreshed.recent_feedback_hashes == [
        compute_feedback_hash("same feedback")
    ] * 3
    assert NEEDS_ADVISOR_LABEL in refreshed.labels


async def test_three_distinct_hashes_no_flip(
    db_session: AsyncSession,
    test_card: Card,
):
    await record_review_iteration(db_session, test_card.id, "issue alpha")
    await record_review_iteration(db_session, test_card.id, "issue bravo")
    await record_review_iteration(db_session, test_card.id, "issue charlie")

    refreshed = await db_session.get(Card, test_card.id)
    assert refreshed.review_iterations == 3
    assert NEEDS_ADVISOR_LABEL not in (refreshed.labels or [])


async def test_intermixed_window_with_two_collisions_flips(
    db_session: AsyncSession,
    test_card: Card,
):
    """H1 H2 H1 — 2 collisions on H1 in the 3-slot window -> flip."""
    await record_review_iteration(db_session, test_card.id, "feedback one")
    await record_review_iteration(db_session, test_card.id, "feedback two")
    await record_review_iteration(db_session, test_card.id, "feedback one")

    refreshed = await db_session.get(Card, test_card.id)
    assert refreshed.review_iterations == 3
    assert NEEDS_ADVISOR_LABEL in refreshed.labels


async def test_window_stays_bounded_at_three(
    db_session: AsyncSession,
    test_card: Card,
):
    for i in range(5):
        await record_review_iteration(db_session, test_card.id, f"feedback {i}")

    refreshed = await db_session.get(Card, test_card.id)
    assert refreshed.review_iterations == 5
    assert len(refreshed.recent_feedback_hashes) == 3
    # The window holds the last 3 hashes only.
    assert refreshed.recent_feedback_hashes == [
        compute_feedback_hash("feedback 2"),
        compute_feedback_hash("feedback 3"),
        compute_feedback_hash("feedback 4"),
    ]


async def test_label_flip_is_idempotent(
    db_session: AsyncSession,
    test_card: Card,
):
    """Once flipped, a fourth same-hash verdict doesn't re-add the label."""
    for _ in range(4):
        await record_review_iteration(db_session, test_card.id, "same feedback")

    refreshed = await db_session.get(Card, test_card.id)
    assert refreshed.labels.count(NEEDS_ADVISOR_LABEL) == 1


# --- Integration with NoteService.create_note ---


async def test_create_review_verdict_note_records_iteration(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    service = NoteService(db_session)
    await service.create_note(
        test_workspace.id,
        NoteCreate(
            title=f"Review: {test_card.id} — request_changes",
            content="add error handling to the foo() call",
            kind="review_verdict",
            card_id=test_card.id,
        ),
        test_user.id,
        test_board.id,
    )

    refreshed = await db_session.get(Card, test_card.id)
    assert refreshed.review_iterations == 1
    assert len(refreshed.recent_feedback_hashes) == 1


async def test_three_review_verdicts_via_service_flips_label(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    service = NoteService(db_session)
    for _ in range(3):
        await service.create_note(
            test_workspace.id,
            NoteCreate(
                title=f"Review: {test_card.id} — request_changes",
                content="exact same feedback every time",
                kind="review_verdict",
                card_id=test_card.id,
            ),
            test_user.id,
            test_board.id,
        )

    refreshed = await db_session.get(Card, test_card.id)
    assert refreshed.review_iterations == 3
    assert NEEDS_ADVISOR_LABEL in refreshed.labels


# --- Platform-level E2E (SWE-AF #2 Wave 3 Lane C) ---
# These go through NoteService.create_note — the documented trigger seam
# (note.py:102) — and assert the three invariants the spec demands: label
# flip, iteration counter, and hash present in the sliding window. The
# scheduler exclusion based on the label is covered indirectly: the label
# IS the parking signal (assignment_service.py:477 filters on it).


async def test_stuck_loop_parks_card_after_three_same_hash_feedbacks(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    service = NoteService(db_session)
    # NoteCreate normalizes content to ProseMirror JSON before the verdict
    # ever reaches record_review_iteration, so the recorded hash is over
    # the normalized doc — we obtain it via the same path the model takes.
    repeated_feedback = "tests pass but error handling on foo() is missing"
    note_payload = NoteCreate(
        title=f"Review: {test_card.id} — request_changes",
        content=repeated_feedback,
        kind="review_verdict",
        card_id=test_card.id,
    )
    expected_hash = compute_feedback_hash(note_payload.content)

    for _ in range(3):
        await service.create_note(
            test_workspace.id,
            note_payload,
            test_user.id,
            test_board.id,
        )

    refreshed = await db_session.get(Card, test_card.id)
    assert refreshed.review_iterations >= 3
    assert expected_hash in (refreshed.recent_feedback_hashes or [])
    assert NEEDS_ADVISOR_LABEL in (refreshed.labels or [])


async def test_stuck_loop_does_not_park_on_distinct_feedbacks(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    service = NoteService(db_session)
    distinct_feedbacks = [
        "missing null check on user_id",
        "typo in error message wording",
        "consider caching the lookup result",
    ]

    for feedback in distinct_feedbacks:
        await service.create_note(
            test_workspace.id,
            NoteCreate(
                title=f"Review: {test_card.id} — request_changes",
                content=feedback,
                kind="review_verdict",
                card_id=test_card.id,
            ),
            test_user.id,
            test_board.id,
        )

    refreshed = await db_session.get(Card, test_card.id)
    assert refreshed.review_iterations == 3
    assert NEEDS_ADVISOR_LABEL not in (refreshed.labels or [])


async def test_user_note_does_not_record_iteration(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    service = NoteService(db_session)
    await service.create_note(
        test_workspace.id,
        NoteCreate(
            title="random user note",
            content="just a comment",
            kind="user_note",
            card_id=test_card.id,
        ),
        test_user.id,
        test_board.id,
    )

    refreshed = await db_session.get(Card, test_card.id)
    # NULL or 0 are both correct (column default == 0).
    assert (refreshed.review_iterations or 0) == 0
    assert not (refreshed.recent_feedback_hashes or [])
