# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import Field

from app.core.json_response import UTCModel

Sequence = Annotated[str, Field(pattern=r"^(0|[1-9][0-9]*)$")]


class GenerationCreate(UTCModel):
    request_id: uuid.UUID


class GenerationRead(UTCModel):
    id: uuid.UUID
    board_id: uuid.UUID
    created_at: datetime
    expires_at: datetime
    first_seq: Sequence | None
    head_seq: Sequence | None
    event_count: Sequence


class ReplayCoverage(UTCModel):
    quality: Literal["reconstructed", "partial"]
    unknown_origin: bool
    missing_structural_snapshots: Sequence
    reasons: list[
        Literal["unknown_origin", "missing_structural_snapshot", "conflicting_snapshot"]
    ]


class ReplayState(UTCModel):
    columns: list[dict]
    cards: list[dict]


class ReplayAnchor(UTCModel):
    through_seq: Sequence | None
    state: ReplayState
    coverage: ReplayCoverage


class TimelineEventRead(UTCModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    board_id: uuid.UUID
    seq: Sequence
    entity_type: str
    entity_id: uuid.UUID
    action: str
    actor_id: uuid.UUID
    actor_name: str | None
    actor_email: str | None
    agent_id: uuid.UUID | None
    summary: str
    message_key: str | None
    message_params: dict | None
    changes: dict | None
    before_state: dict | None
    after_state: dict | None
    via_api_key: str | None
    created_at: datetime
    entity_title: str | None


class OverviewBucket(UTCModel):
    start_at: datetime
    end_at: datetime
    count: Sequence
    first_seq: Sequence | None
    last_seq: Sequence | None


class OverviewRead(UTCModel):
    generation_id: uuid.UUID
    first_seq: Sequence | None
    head_seq: Sequence | None
    first_at: datetime | None
    last_at: datetime | None
    event_count: Sequence
    buckets: list[OverviewBucket]


class WindowBounds(UTCModel):
    first_seq: Sequence | None
    last_seq: Sequence | None
    previous_cursor: str | None
    next_cursor: str | None


class WindowReady(UTCModel):
    status: Literal["ready"]
    generation_id: uuid.UUID
    anchor: ReplayAnchor
    events: list[TimelineEventRead]
    window: WindowBounds
    coverage: ReplayCoverage


class PreparationProgress(UTCModel):
    through_seq: Sequence | None
    target_seq: Sequence | None
    processed_events: Sequence


class PreparationError(UTCModel):
    code: str
    message: str


class PreparationRead(UTCModel):
    status: Literal["preparing", "failed"]
    generation_id: uuid.UUID
    preparation_id: uuid.UUID
    progress: PreparationProgress
    retryable: bool
    error: PreparationError | None


class LiveHeadRead(UTCModel):
    generation_id: uuid.UUID
    observed_at: datetime
    head_seq: Sequence | None
    state: ReplayState


class SearchMatch(UTCModel):
    id: uuid.UUID
    seq: Sequence
    created_at: datetime
    summary: str


class SearchRead(UTCModel):
    generation_id: uuid.UUID
    scope: Literal["generation"]
    matches: list[SearchMatch]
    next_cursor: str | None
