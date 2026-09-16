# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from app.core.json_response import UTCModel

from app.models.activity import ActivityAction, ActivityEntityType


class ActivityRead(UTCModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    board_id: uuid.UUID | None
    actor_id: uuid.UUID
    agent_id: uuid.UUID | None = None
    entity_type: ActivityEntityType
    entity_id: uuid.UUID
    action: ActivityAction
    summary: str
    # Nullable for historical rows and intentionally unstructured events.
    # Consumers must fall back to `summary` when message_key is absent/unknown.
    message_key: str | None = None
    message_params: dict | None = None
    changes: dict | None
    # Board Timeline (contract v1): role-agnostic entity snapshot before/after.
    # Default None so the existing /history response gains two always-present
    # nullable keys without breaking — additive only.
    before_state: dict | None = None
    after_state: dict | None = None
    via_api_key: str | None = None
    created_at: datetime
    actor_name: str | None = None
    actor_email: str | None = None
    # Resolved title of entity_id for entity types that have one AND a route
    # (card, note) — populated by ActivityService._attach_entity_titles, read via
    # from_attributes (mirrors actor_name). None for title-less types and for a
    # deleted entity; the FE then renders the summary prose non-linked.
    entity_title: str | None = None

    model_config = {"from_attributes": True}


class ActivityListRead(UTCModel):
    """`?summary=true` shape for the activity HISTORY endpoints.

    ActivityRead minus the three JSONB blobs — `changes`, `before_state`,
    `after_state` — which together dominate the row while the activity feed
    renders only the prose. The board TIMELINE replay engine does fold the
    snapshots, but it reads /timeline, which has no trimmed mode.

    A separate model rather than an exclude-set so the omission shows up in
    the OpenAPI schema and a future heavy field can't silently ride along.
    """

    id: uuid.UUID
    workspace_id: uuid.UUID
    board_id: uuid.UUID | None
    actor_id: uuid.UUID
    agent_id: uuid.UUID | None = None
    entity_type: ActivityEntityType
    entity_id: uuid.UUID
    action: ActivityAction
    summary: str
    message_key: str | None = None
    message_params: dict | None = None
    via_api_key: str | None = None
    created_at: datetime
    actor_name: str | None = None
    actor_email: str | None = None
    entity_title: str | None = None

    model_config = {"from_attributes": True}


class BoardBaseline(UTCModel):
    """The board's CURRENT state, used by the timeline engine to SEED the fold
    (contract v1.1). Columns/cards are the role-agnostic snapshot dicts produced
    by snapshot_column / snapshot_card — columns ordered by position, cards the
    flat list across every column."""

    columns: list[dict]
    cards: list[dict]


class TimelineResponse(UTCModel):
    board_id: uuid.UUID
    generated_at: datetime
    truncated: bool
    events: list[ActivityRead]
    # v1.1 — current-state baseline so legacy boards (null event snapshots) still
    # render real titles/columns. Optional + default None for backward compat.
    baseline: BoardBaseline | None = None
