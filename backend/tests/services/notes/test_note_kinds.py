# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Closed-set membership tests for the platform note kinds.

The validator + scheduler consult `app.models.notes.kinds` module-level
constants as the closed set of allowed kinds. Tests guard against
typos/regressions when new kinds are added.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notes import kinds as note_kinds_module
from app.models.notes.note import Note
from app.repositories.notes.note import NoteRepository


# --- closed-set membership ---------------------------------------------------


def _known_kinds() -> set[str]:
    return {
        v for k, v in vars(note_kinds_module).items()
        if not k.startswith("_") and isinstance(v, str)
    }


def test_plan_kind_registered():
    assert "plan" in _known_kinds()
    assert note_kinds_module.PLAN == "plan"


def test_review_verdict_kind_registered():
    assert "review_verdict" in _known_kinds()
    assert note_kinds_module.REVIEW_VERDICT == "review_verdict"


def test_rework_brief_kind_registered():
    assert "rework_brief" in _known_kinds()
    assert note_kinds_module.REWORK_BRIEF == "rework_brief"


# --- repository round-trip ---------------------------------------------------


@pytest.mark.asyncio
async def test_repository_round_trips_new_kinds(db_session: AsyncSession):
    from app.models.user import User
    from app.models.workspace import Workspace

    user = User(email="kindtest@valaris.dev", name="K")
    db_session.add(user)
    await db_session.flush()
    workspace = Workspace(
        name="kt", slug=f"kt-{uuid.uuid4().hex[:8]}", created_by=user.id
    )
    db_session.add(workspace)
    await db_session.flush()

    repo = NoteRepository(db_session)
    for kind in ("plan", "review_verdict", "rework_brief"):
        note = await repo.create(
            workspace_id=workspace.id,
            board_id=None,
            title=f"{kind} note",
            content=f"body for {kind}",
            pinned=False,
            kind=kind,
            failure_class=None,
            findings=None,
            created_by=user.id,
        )
        assert note.kind == kind
        fetched = await db_session.get(Note, note.id)
        assert fetched is not None
        assert fetched.kind == kind
