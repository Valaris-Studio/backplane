# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import date, datetime

from pydantic import Field

from app.core.json_response import UTCModel
from app.core.password import MIN_PASSWORD_LENGTH

from app.models.workspace import WorkspaceRole
from app.schemas.activity import ActivityListRead, ActivityRead
from app.schemas.bounded import Str255


class WorkspaceCreate(UTCModel):
    name: Str255
    slug: Str255


class WorkspaceUpdate(UTCModel):
    name: Str255 | None = None


class WorkspaceRead(UTCModel):
    id: uuid.UUID
    name: str
    slug: str
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime
    # Batched aggregates for the workspace list (welcome screen). Optional so the
    # single-workspace endpoints (which don't compute them) can omit them and so
    # an older frontend ignores them — no migration impact (computed, not stored).
    board_count: int | None = None
    card_count: int | None = None
    # Newest activity timestamp for the workspace (MAX over the activities log).
    # The real "recently active" sort key — unlike updated_at it moves on every
    # board/card edit. NULL when the workspace has no activity yet.
    last_activity_at: datetime | None = None

    model_config = {"from_attributes": True}


class WorkspaceMemberRead(UTCModel):
    user_id: uuid.UUID
    email: str
    name: str
    role: WorkspaceRole
    joined_at: datetime


class AddMemberRequest(UTCModel):
    email: str
    role: WorkspaceRole = WorkspaceRole.member
    # Applied only when the account has no local credential yet — adding an
    # existing user never overwrites their password (that is the explicit,
    # audited temporary-password endpoint's job).
    initial_password: str | None = Field(default=None, min_length=MIN_PASSWORD_LENGTH)


class UpdateMemberRoleRequest(UTCModel):
    role: WorkspaceRole


class TemporaryPasswordRequest(UTCModel):
    # Omitted -> the server generates one and returns it (shown once).
    password: str | None = Field(default=None, min_length=MIN_PASSWORD_LENGTH)


class TemporaryPasswordResponse(UTCModel):
    temporary_password: str


class BoardCardDistribution(UTCModel):
    """Cards per column_type. `untyped` holds cards in columns with no
    column_type set, so the buckets always sum to the board's card_count."""

    backlog: int = 0
    active: int = 0
    review: int = 0
    done: int = 0
    blocked: int = 0
    untyped: int = 0


class BoardStats(UTCModel):
    board_id: uuid.UUID
    name: str
    slug: str | None = None
    card_count: int
    overdue_count: int
    distribution: BoardCardDistribution


class ActivityTrendPoint(UTCModel):
    """One calendar day of the activity sparkline. Zero-count days are present
    as real points — the chart is fixed-width, so a gap would misread as a dip
    in a shorter series rather than a quiet day."""

    day: date
    count: int


class WorkspaceSummary(UTCModel):
    board_count: int
    card_count: int
    note_count: int
    channel_count: int
    recent_activity: list[ActivityRead]
    # Per-board breakdown for the dashboard. Defaulted rather than required so
    # existing consumers (MCP get_workspace_summary passes the payload through
    # verbatim) are unaffected by the addition.
    board_stats: list[BoardStats] = Field(default_factory=list)
    # Per-day activity volume, oldest day first. Defaulted for the same reason
    # as board_stats: MCP passes the payload through verbatim.
    activity_trend: list[ActivityTrendPoint] = Field(default_factory=list)


class WorkspaceSummaryTrimmedActivity(WorkspaceSummary):
    """`?summary_activity=true` variant: the same digest with the embedded
    activity rows stripped of their JSONB snapshots. The dashboard renders
    id/entity_type/summary only, but MCP get_workspace_summary forwards this
    payload verbatim to an agent, so the trim is opt-in like everywhere else.
    """

    recent_activity: list[ActivityListRead]
