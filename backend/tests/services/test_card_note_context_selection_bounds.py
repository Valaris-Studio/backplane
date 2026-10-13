# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Independent SUMMIT05 red tests: deterministic selection and bounded loads.

These assert the existing count policy, not a new normal-prompt byte budget.
No production implementation accompanies these tests.
"""

import uuid
from datetime import datetime, timedelta

import pytest
from sqlalchemy import event

from app.models.notes.note import Note
from app.services.agents.context_assembly import assemble_context

pytestmark = pytest.mark.timeout(20)


def note(workspace, board, card, user, index, created_at, *, pinned=False):
    return Note(
        id=uuid.UUID(int=index), workspace_id=workspace.id, board_id=board.id,
        card_id=card.id, created_by=user.id, kind="user_note", pinned=pinned,
        title=f"selected-note-{index:03}", content=f"literal-body-{index:03}",
        created_at=created_at, updated_at=created_at,
    )


@pytest.mark.parametrize("kind", [None, "user_note"])
async def test_equal_time_card_notes_use_stable_id_tiebreak(
    db_session, test_workspace, test_board, test_card, test_user, kind,
):
    now = datetime(2026, 10, 13, 14, 0)
    # Insert deliberately opposite to UUID order. Both timestamp peers must
    # outrank the older row, including when that older row is pinned in the
    # kind-filtered path (whose existing policy is newest-first).
    records = [
        note(test_workspace, test_board, test_card, test_user, 30, now),
        note(test_workspace, test_board, test_card, test_user, 10, now),
        note(test_workspace, test_board, test_card, test_user, 20, now),
        note(test_workspace, test_board, test_card, test_user, 40,
             now - timedelta(days=1), pinned=True),
    ]
    db_session.add_all(records)
    await db_session.flush()
    filter_ = {"limit": 2}
    if kind:
        filter_["kind"] = kind
    packet = await assemble_context(
        db_session, workspace_id=test_workspace.id, card=test_card, board=test_board,
        sources=[{"kind": "card_notes", "as": "chosen", "filter": filter_}],
    )
    rendered = packet["chosen"]
    expected = [10, 20] if kind else [40, 10]
    assert all(f"literal-body-{index:03}" in rendered for index in expected), rendered
    assert rendered.index(f"literal-body-{expected[0]:03}") < rendered.index(
        f"literal-body-{expected[1]:03}"
    )
    assert all(f"literal-body-{index:03}" not in rendered
               for index in {10, 20, 30, 40} - set(expected))


@pytest.mark.parametrize("kind", [None, "user_note"])
@pytest.mark.parametrize(("requested_limit", "expected_count"), [(2, 2), (500, 50)])
async def test_card_context_materializes_only_the_capped_selection(
    db_session, test_workspace, test_board, test_card, test_user,
    kind, requested_limit, expected_count,
):
    now = datetime(2026, 10, 13, 14, 0)
    records = [note(test_workspace, test_board, test_card, test_user, index,
                    now + timedelta(seconds=index)) for index in range(1, 55)]
    db_session.add_all(records)
    await db_session.flush()
    for record in records:
        db_session.expunge(record)
    loaded = []

    def record_load(instance, _context):
        loaded.append(instance.id)

    filter_ = {"limit": requested_limit}
    if kind:
        filter_["kind"] = kind
    event.listen(Note, "load", record_load)
    try:
        packet = await assemble_context(
            db_session, workspace_id=test_workspace.id, card=test_card, board=test_board,
            sources=[{"kind": "card_notes", "as": "bounded", "filter": filter_}],
        )
    finally:
        event.remove(Note, "load", record_load)
    rendered = packet["bounded"]
    assert rendered.count("literal-body-") == expected_count
    assert "literal-body-054" in rendered
    assert f"literal-body-{54 - expected_count:03}" not in rendered
    assert len(loaded) <= expected_count, (
        f"Loaded {len(loaded)} note bodies for a {expected_count}-note selection; "
        "limit must apply before payload materialization"
    )
