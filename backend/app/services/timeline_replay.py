# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from collections.abc import Iterable
from copy import deepcopy
from typing import Any


_SNAPSHOT_FIELDS = {
    "card": frozenset({
        "id", "title", "card_type", "priority", "column_id", "position",
        "status", "labels", "participants",
    }),
    "column": frozenset({"id", "name", "column_type", "position"}),
}
_STRUCTURAL_ACTIONS = frozenset({"created", "updated", "moved", "deleted"})
_COVERAGE_REASONS = (
    "unknown_origin", "missing_structural_snapshot", "conflicting_snapshot",
)


def fold_events(
    events: Iterable[dict[str, Any]],
    initial_state: dict[str, Any] | None = None,
    initial_coverage: dict[str, Any] | None = None,
) -> dict[str, Any]:
    state = deepcopy(initial_state) if initial_state is not None else {}
    columns = {column["id"]: column for column in state.get("columns", [])}
    cards = {card["id"]: card for card in state.get("cards", [])}
    entities = {"column": columns, "card": cards}
    coverage = initial_coverage or {}
    unknown_origin = coverage.get("unknown_origin", True)
    missing_snapshots = int(coverage.get("missing_structural_snapshots", "0"))
    reasons = set(coverage.get("reasons", []))
    if unknown_origin:
        reasons.add("unknown_origin")
    if missing_snapshots:
        reasons.add("missing_structural_snapshot")

    # The caller supplies a generation-visible sequence prefix, never timestamp order.
    for event in events:
        entity_type = event["entity_type"]
        action = event["action"]
        if entity_type not in entities or action not in _STRUCTURAL_ACTIONS:
            continue
        entity_id = event["entity_id"]
        known_entities = entities[entity_type]
        previous = known_entities.get(entity_id)
        before = event.get("before_state")
        after = event.get("after_state")

        if isinstance(before, dict):
            if before.get("id", entity_id) != entity_id or (
                previous is not None
                and any(previous[key] != value for key, value in before.items() if key in previous)
            ):
                reasons.add("conflicting_snapshot")

        if action == "deleted":
            known_entities.pop(entity_id, None)
            if entity_type == "column":
                for card_id in [key for key, card in cards.items() if card["column_id"] == entity_id]:
                    del cards[card_id]
            continue

        if isinstance(after, dict) and "id" in after and after["id"] != entity_id:
            reasons.add("conflicting_snapshot")
            known_entities.pop(entity_id, None)
        elif not isinstance(after, dict) or not _SNAPSHOT_FIELDS[entity_type].issubset(after):
            missing_snapshots += 1
            reasons.add("missing_structural_snapshot")
            known_entities.pop(entity_id, None)
        else:
            known_entities[entity_id] = deepcopy(after)

    bounded_reasons = [reason for reason in _COVERAGE_REASONS if reason in reasons]
    return {
        "state": {"columns": list(columns.values()), "cards": list(cards.values())},
        "coverage": {
            "quality": "partial" if bounded_reasons else "reconstructed",
            "unknown_origin": unknown_origin,
            "missing_structural_snapshots": str(missing_snapshots),
            "reasons": bounded_reasons,
        },
    }
