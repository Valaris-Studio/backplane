# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Stuck-loop detector — flips `needs-advisor` after 3 same-feedback cycles.

SWE-AF #2. Called by NoteService.create_note whenever a `review_verdict`
note lands on a card. Maintains a 3-slot sliding window of feedback hashes
on the card row; flips the `needs-advisor` label as soon as the window
contains >=2 collisions (i.e. the same feedback repeated). After the flip
the scheduler stops handing the card to reviewer/coder roles — it parks
until a human or future advisor unblocks it.
"""

from __future__ import annotations

import hashlib
import re
import uuid

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.card import Card

NEEDS_ADVISOR_LABEL = "needs-advisor"
_WINDOW_SIZE = 3
_WHITESPACE_RE = re.compile(r"\s+")


def compute_feedback_hash(feedback: str) -> str:
    """SHA-256 of normalized feedback.

    Normalization: lowercase, strip ends, collapse internal whitespace to a
    single space. Two LLM retries posting structurally identical feedback
    with cosmetic whitespace drift hash to the same value — that's the
    point: retry storms are themselves a stuck-loop signal.
    """
    normalized = _WHITESPACE_RE.sub(" ", (feedback or "").strip()).lower()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def is_stuck_loop(window: list[str]) -> bool:
    """A 3-slot window is 'stuck' when any hash appears >=2 times.

    Boundary cases:
        H1 H1 H1 -> stuck (collisions on H1)
        H1 H2 H1 -> stuck (2x H1 inside the window)
        H1 H2 H3 -> not stuck
    """
    if len(window) < 2:
        return False
    return any(window.count(h) >= 2 for h in set(window))


async def record_review_iteration(
    db: AsyncSession, card_id: uuid.UUID, feedback: str
) -> None:
    """Increment the iteration counter, slide the hash window, flip label
    if the window now signals a stuck loop.

    Uses an atomic `UPDATE ... SET review_iterations = review_iterations + 1`
    so two near-simultaneous verdicts increment correctly without a read-
    modify-write race. The hash window and label, however, require a
    read-modify-write because they are JSON; we accept the narrower race
    window there — the worst case is one missed flip that the next verdict
    will catch.
    """
    card = await db.get(Card, card_id)
    if card is None:
        return

    feedback_hash = compute_feedback_hash(feedback)
    window = list(card.recent_feedback_hashes or [])
    window.append(feedback_hash)
    # Slide: only keep the last `_WINDOW_SIZE` entries.
    if len(window) > _WINDOW_SIZE:
        window = window[-_WINDOW_SIZE:]

    labels = list(card.labels or [])
    if is_stuck_loop(window) and NEEDS_ADVISOR_LABEL not in labels:
        labels.append(NEEDS_ADVISOR_LABEL)

    # Atomic counter bump; JSON columns get a normal assignment.
    await db.execute(
        update(Card)
        .where(Card.id == card_id)
        .values(review_iterations=Card.review_iterations + 1)
    )
    card.recent_feedback_hashes = window
    card.labels = labels
    await db.flush()
    await db.refresh(card)
