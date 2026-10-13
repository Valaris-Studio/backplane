# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from copy import deepcopy
from uuid import UUID

import pytest

from app.services.timeline_replay import fold_events


CARD_ID = "00000000-0000-0000-0000-000000000001"
OTHER_CARD_ID = "00000000-0000-0000-0000-000000000002"
COLUMN_ID = "00000000-0000-0000-0000-000000000003"
OTHER_COLUMN_ID = "00000000-0000-0000-0000-000000000004"


def card_snapshot(**overrides):
    return {
        "id": CARD_ID,
        "title": "Recorded title",
        "card_type": "operator-defined-type",
        "priority": "operator-defined-priority",
        "column_id": COLUMN_ID,
        "position": 1024.0,
        "status": "operator-defined-status",
        "labels": ["recorded"],
        "participants": [{
            "user_id": "00000000-0000-0000-0000-000000000005",
            "agent_id": None,
            "name": "Recorded participant",
            "role": "operator-defined-role",
            "avatar_url": None,
        }],
        **overrides,
    }


def column_snapshot(**overrides):
    return {
        "id": COLUMN_ID,
        "name": "Recorded column",
        "column_type": "operator-defined-column-type",
        "position": 1024.0,
        **overrides,
    }


def event(seq, action, *, entity_type="card", entity_id=CARD_ID,
          before=None, after=None, **overrides):
    return {
        "id": str(UUID(int=seq)),
        "seq": str(seq),
        "entity_type": entity_type,
        "entity_id": entity_id,
        "action": action,
        "before_state": before,
        "after_state": after,
        "changes": None,
        "created_at": "2026-01-01T00:00:00Z",
        **overrides,
    }


def empty_known_checkpoint():
    return {
        "state": {"columns": [], "cards": []},
        "coverage": {
            "quality": "reconstructed",
            "unknown_origin": False,
            "missing_structural_snapshots": "0",
            "reasons": [],
        },
    }


def resume(checkpoint, events):
    return fold_events(events, initial_state=checkpoint["state"],
                       initial_coverage=checkpoint["coverage"])


def test_default_genesis_is_unknown_not_an_observed_empty_board():
    result = fold_events([])

    assert result == {
        "state": {"columns": [], "cards": []},
        "coverage": {
            "quality": "partial",
            "unknown_origin": True,
            "missing_structural_snapshots": "0",
            "reasons": ["unknown_origin"],
        },
    }
    assert resume(empty_known_checkpoint(), []) == empty_known_checkpoint()


def test_complete_after_snapshot_establishes_evidence_without_inventing_origin():
    recorded = card_snapshot()
    result = fold_events([event(1, "updated", after=recorded)])

    assert result["state"]["cards"] == [recorded]
    assert result["coverage"]["unknown_origin"] is True
    assert result["coverage"]["quality"] == "partial"
    assert result["coverage"]["missing_structural_snapshots"] == "0"
    assert result["coverage"]["reasons"] == ["unknown_origin"]


@pytest.mark.parametrize("after", [None, {"id": CARD_ID, "title": "Incomplete"}])
def test_missing_structural_snapshot_removes_stale_evidence_until_later_repair(after):
    checkpoint = resume(empty_known_checkpoint(), [
        event(1, "created", after=card_snapshot()),
    ])
    gap = resume(checkpoint, [event(2, "updated", after=after)])

    assert gap["state"]["cards"] == []
    assert gap["coverage"] == {
        "quality": "partial",
        "unknown_origin": False,
        "missing_structural_snapshots": "1",
        "reasons": ["missing_structural_snapshot"],
    }

    repaired = card_snapshot(title="Evidence resumes here")
    result = resume(gap, [event(3, "updated", after=repaired)])
    assert result["state"]["cards"] == [repaired]
    assert result["coverage"] == gap["coverage"]
    assert gap["state"]["cards"] == []


@pytest.mark.parametrize("action", [
    "dependency_added", "dependency_removed", "dependencies_replaced",
])
def test_dependency_activity_does_not_degrade_structural_evidence(action):
    checkpoint = resume(empty_known_checkpoint(), [
        event(1, "created", after=card_snapshot()),
    ])

    assert resume(checkpoint, [event(2, action)]) == checkpoint


def test_nonstructural_entities_leave_replay_and_coverage_unchanged():
    checkpoint = empty_known_checkpoint()
    events = [event(seq, "updated", entity_type=entity_type)
              for seq, entity_type in enumerate(["board", "note", "definition"], 1)]

    assert resume(checkpoint, events) == checkpoint


def test_delete_establishes_absence_even_without_a_before_snapshot():
    checkpoint = resume(empty_known_checkpoint(), [
        event(1, "created", after=card_snapshot()),
    ])
    deletion = event(2, "deleted")

    assert resume(checkpoint, [deletion]) == empty_known_checkpoint()
    assert resume(empty_known_checkpoint(), [deletion]) == empty_known_checkpoint()


def test_column_delete_removes_known_children_and_preserves_other_columns():
    column = column_snapshot()
    other_column = column_snapshot(id=OTHER_COLUMN_ID, position=2048.0)
    other_card = card_snapshot(id=OTHER_CARD_ID, column_id=OTHER_COLUMN_ID)
    events = [
        event(1, "created", entity_type="column", entity_id=COLUMN_ID, after=column),
        event(2, "created", entity_type="column", entity_id=OTHER_COLUMN_ID,
              after=other_column),
        event(3, "created", after=card_snapshot()),
        event(4, "created", entity_id=OTHER_CARD_ID, after=other_card),
        event(5, "deleted", entity_type="column", entity_id=COLUMN_ID),
    ]

    result = resume(empty_known_checkpoint(), events)

    assert result["state"] == {"columns": [other_column], "cards": [other_card]}
    assert result["coverage"] == empty_known_checkpoint()["coverage"]


def test_missing_column_update_does_not_keep_its_old_name_or_invent_card_deletion():
    recorded_card = card_snapshot()
    events = [
        event(1, "created", entity_type="column", entity_id=COLUMN_ID,
              after=column_snapshot()),
        event(2, "created", after=recorded_card),
        event(3, "updated", entity_type="column", entity_id=COLUMN_ID),
    ]

    result = resume(empty_known_checkpoint(), events)

    assert result["state"] == {"columns": [], "cards": [recorded_card]}
    assert result["coverage"]["missing_structural_snapshots"] == "1"
    assert result["coverage"]["quality"] == "partial"


def test_wrong_snapshot_identity_invalidates_target_without_inserting_other_entity():
    checkpoint = resume(empty_known_checkpoint(), [
        event(1, "created", after=card_snapshot()),
    ])

    result = resume(checkpoint, [event(2, "updated", after=card_snapshot(id=OTHER_CARD_ID))])

    assert result["state"]["cards"] == []
    assert result["coverage"]["quality"] == "partial"
    assert result["coverage"]["reasons"] == ["conflicting_snapshot"]
    assert result["coverage"]["missing_structural_snapshots"] == "0"


def test_conflicting_before_state_keeps_new_after_evidence_but_reports_conflict():
    after = card_snapshot(title="New recorded evidence")
    events = [
        event(1, "created", after=card_snapshot()),
        event(2, "updated", before=card_snapshot(title="Stale concurrent read"), after=after),
    ]

    result = resume(empty_known_checkpoint(), events)

    assert result["state"]["cards"] == [after]
    assert result["coverage"]["quality"] == "partial"
    assert result["coverage"]["reasons"] == ["conflicting_snapshot"]


def test_future_snapshots_cannot_fill_earlier_gaps_or_mutate_saved_checkpoint():
    earlier = [event(1, "created")]
    checkpoint = fold_events(earlier)
    saved = deepcopy(checkpoint)
    later = [event(2, "updated", before=card_snapshot(title="Inferred past"),
                   after=card_snapshot(title="Later evidence"))]

    result = resume(checkpoint, later)

    assert result["state"]["cards"][0]["title"] == "Later evidence"
    assert checkpoint == saved == fold_events(earlier)
    assert checkpoint["state"]["cards"] == []
    assert checkpoint["coverage"]["missing_structural_snapshots"] == "1"


def test_sequence_order_is_preserved_when_source_timestamps_move_backwards():
    events = [
        event(9007199254740993, "created", after=card_snapshot(title="First"),
              created_at="2026-02-02T00:00:00Z"),
        event(9007199254740994, "updated", after=card_snapshot(title="Second"),
              created_at="2026-01-01T00:00:00Z"),
    ]

    assert fold_events(events)["state"]["cards"][0]["title"] == "Second"


def test_gap_counts_stay_precise_and_reasons_bounded_across_checkpoint_resume():
    checkpoint = empty_known_checkpoint()
    checkpoint["coverage"].update(
        quality="partial", missing_structural_snapshots="9007199254740993",
        reasons=["missing_structural_snapshot"],
    )

    result = resume(checkpoint, [event(1, "updated"), event(2, "moved")])

    assert result["coverage"]["missing_structural_snapshots"] == "9007199254740995"
    assert result["coverage"]["reasons"] == ["missing_structural_snapshot"]


def test_every_checkpoint_boundary_matches_reference_forward_fold_without_aliasing():
    original = card_snapshot()
    moved = card_snapshot(column_id=OTHER_COLUMN_ID)
    events = [
        event(1, "created", entity_type="column", entity_id=COLUMN_ID,
              after=column_snapshot()),
        event(2, "created", after=original),
        event(3, "dependency_added"),
        event(4, "updated"),
        event(5, "moved", after=moved),
        event(6, "deleted", entity_type="column", entity_id=COLUMN_ID),
        event(7, "deleted"),
    ]
    expected = {"columns": [], "cards": []}
    untouched_events = deepcopy(events)
    whole = fold_events(events)
    assert whole["state"] == expected
    assert whole["coverage"]["missing_structural_snapshots"] == "1"

    for boundary in range(len(events) + 1):
        checkpoint = fold_events(events[:boundary])
        saved = deepcopy(checkpoint)
        assert resume(checkpoint, events[boundary:]) == whole
        assert resume(checkpoint, events[boundary:]) == whole
        assert checkpoint == saved

    evidenced = fold_events(events[:2])
    evidenced["state"]["cards"][0]["participants"][0]["role"] = "Changed by consumer"
    assert events == untouched_events
