# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Shared card-label mutation helper.

Lives in its own module so both CardService (done-merge gate) and NoteService
(verdict-driven routing) can stamp labels without importing each other.
"""


def stamp_label(card, label: str) -> None:
    """Append `label` to card.labels if not already present.

    SQLAlchemy's JSON column tracks mutation by identity, so we reassign the
    list rather than mutating in place. Idempotent — duplicate calls no-op.
    """
    existing = list(card.labels or [])
    if label not in existing:
        existing.append(label)
        card.labels = existing
