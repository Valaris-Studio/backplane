# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""SQLite type affinity vs UUID primary keys (card 74c2485b).

`UUIDMixin.id` uses postgresql.UUID; on SQLite the DDL type renders literally
as `UUID`, which matches no affinity substring and lands on NUMERIC affinity.
SQLAlchemy stores UUIDs as 32 undashed hex chars on non-native backends — and
a UUID whose hex happens to be ALL DECIMAL DIGITS (~1 in 3.3M uuid4s) is
silently coerced to a REAL, after which the Uuid result processor crashes:
`AttributeError: 'float' object has no attribute 'replace'`. That is the CI
"flake" in test_get_card_verdict_returns_latest_approve (Cloud Build
f2eb2729): a deterministic bug on an unlucky id, affecting every UUID PK/FK
in the suite.

The pins are fix-agnostic: they insert explicit all-digit-hex UUIDs and
assert the round-trip, on two unrelated models so the fix must live at the
mixin/dialect level, not per-table.
"""

import uuid

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.notes.note import Note
from app.models.user import User
from app.models.workspace import Workspace

# 32 hex chars that are all decimal digits — the id class SQLite's NUMERIC
# affinity coerces to REAL. The first is the shape from the CI traceback.
ALL_DIGIT_BOARD_ID = uuid.UUID("40917271388888888888888888888888")
ALL_DIGIT_NOTE_ID = uuid.UUID("11111111111111112222222222222222")


async def test_board_with_all_digit_hex_id_round_trips(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    board = Board(
        id=ALL_DIGIT_BOARD_ID,
        workspace_id=test_workspace.id,
        name="Unlucky Board",
        slug="unlucky-board",
        created_by=test_user.id,
    )
    db_session.add(board)
    await db_session.flush()
    db_session.expunge(board)

    # resolve_board_id's exact query shape (app/core/workspace.py) — the read
    # that produced the CI AttributeError.
    fetched_id = (
        await db_session.execute(
            select(Board.id).where(
                Board.id == ALL_DIGIT_BOARD_ID,
                Board.workspace_id == test_workspace.id,
            )
        )
    ).scalar_one_or_none()
    assert fetched_id == ALL_DIGIT_BOARD_ID


async def test_note_with_all_digit_hex_id_round_trips(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """Same bug on an unrelated model: the fix must be mixin-wide, not a
    board special case."""
    note = Note(
        id=ALL_DIGIT_NOTE_ID,
        workspace_id=test_workspace.id,
        title="Unlucky Note",
        content="all-digit hex id",
        created_by=test_user.id,
    )
    db_session.add(note)
    await db_session.flush()
    db_session.expunge(note)

    fetched = (
        await db_session.execute(select(Note).where(Note.id == ALL_DIGIT_NOTE_ID))
    ).scalar_one_or_none()
    assert fetched is not None
    assert fetched.id == ALL_DIGIT_NOTE_ID


async def test_all_digit_hex_id_stored_value_is_the_uuid(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """Breadth pin below the ORM: whatever the column stores must parse back
    to the SAME uuid. Today the raw value is the REAL 4.0917...e+31."""
    board = Board(
        id=ALL_DIGIT_BOARD_ID,
        workspace_id=test_workspace.id,
        name="Raw Probe",
        slug="raw-probe",
        created_by=test_user.id,
    )
    db_session.add(board)
    await db_session.flush()

    raw = (
        await db_session.execute(
            text("SELECT id FROM boards WHERE slug = 'raw-probe'")
        )
    ).scalar_one()
    assert uuid.UUID(str(raw)) == ALL_DIGIT_BOARD_ID, (
        f"stored value {raw!r} does not round-trip to the inserted uuid"
    )
