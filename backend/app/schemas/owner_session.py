# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Safe discovery metadata, separate from the private session-reader schema."""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import Field

from app.core.json_response import UTCModel
from app.schemas.agent_session import (
    DisplayState,
    SessionCoverage,
    SessionLinkPreview,
    SessionStatus,
)
from app.schemas.companion import ContentLevel

OwnerSessionSort = Literal["recent", "started"]


class OwnerSessionLinkPreview(SessionLinkPreview):
    workspace_id: uuid.UUID
    workspace_slug: str
    workspace_name: str
    board_name: str | None


class OwnerSessionRead(UTCModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    workspace_slug: str
    workspace_name: str
    board_id: uuid.UUID | None
    board_name: str | None
    parent_session_id: uuid.UUID | None
    harness: str
    harness_display_name: str
    title: str | None
    repository: str | None
    branch: str | None
    status: SessionStatus
    display_state: DisplayState = Field(
        description="Capture state at the page's evaluation time; not runner execution."
    )
    started_at: datetime
    last_event_at: datetime
    ended_at: datetime | None
    ended_reason: Literal["session_end_event", "abandoned"] | None
    idle_since: datetime | None
    event_count: int
    activity_event_count: int | None
    coverage: SessionCoverage | None = Field(
        description="Null for older sessions without a stored activity count; discovery never reads their events."
    )
    capture_gaps: int
    capture_levels: list[ContentLevel]
    child_count: int
    link_count: int
    link_preview: list[OwnerSessionLinkPreview]


class OwnerSessionPage(UTCModel):
    items: list[OwnerSessionRead]
    next_cursor: str | None


class OwnerSessionOverview(UTCModel):
    active: list[OwnerSessionRead]
    recent: list[OwnerSessionRead]
    active_more: bool
    recent_more: bool
    generated_at: datetime
