# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Role-agnostic entity snapshots for the Board Timeline (contract v1).

Pure, synchronous functions. They must NEVER trigger a lazy load: callers
guarantee that every snapshotted card already has `participants` (and each
participant's `user` / `agent`) eager-loaded — which holds for any card derived
from `CardRepository.get_by_id`. The snapshot is the minimal field set the FE
needs to render and fold forward; participant roles are passed through verbatim
(an opaque string), never enumerated against a fixed role set.
"""


def snapshot_card(card) -> dict:
    return {
        "id": str(card.id),
        "title": card.title,
        "card_type": card.card_type.value if card.card_type else None,
        "priority": card.priority.value if card.priority else None,
        "column_id": str(card.column_id) if card.column_id else None,
        "position": float(card.position) if card.position is not None else None,
        "status": card.status,
        "labels": list(card.labels) if card.labels else None,
        # Lets the timeline engine withhold cards born INSIDE the logged window
        # even when no per-card create event exists (bulk_create_cards records
        # ONE activity for N cards) — "no time travel" keyed on data, not on
        # the creation path.
        "created_at": card.created_at.isoformat() if card.created_at else None,
        "participants": [_snapshot_participant(p) for p in (card.participants or [])],
    }


def _snapshot_participant(p) -> dict:
    user = p.user  # eager-loaded; guarded for the NULL-user edge case
    return {
        "user_id": str(p.user_id),
        "agent_id": str(p.agent_id) if p.agent_id else None,
        "name": user.name if user else None,
        # Role-agnostic: the canonical pipeline-role string (the meaningful,
        # never-enumerated identifier), falling back to the legacy display role.
        "role": p.pipeline_role or p.role,
        "avatar_url": user.avatar_url if user else None,
    }


def snapshot_column(column) -> dict:
    return {
        "id": str(column.id),
        "name": column.name,
        "column_type": column.column_type.value if column.column_type else None,
        "position": float(column.position) if column.position is not None else None,
    }
