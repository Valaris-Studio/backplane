# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator, model_validator
from app.core.json_response import UTCModel

from app.models.agents.agent import AgentType
from app.schemas.bounded import Str255


class AgentCreate(UTCModel):
    name: Str255
    agent_type: AgentType
    description: str = ""
    allowed_workspaces: list[str]
    allowed_actions: list[str] | None = None
    max_requests_per_minute: int = 100
    budget_usd: float | None = None

    @field_validator("allowed_workspaces")
    @classmethod
    def _require_non_empty_allowlist(cls, v: list[str]) -> list[str]:
        # B3/B4 (Option B): a runner with an empty allowlist is invisible to
        # every workspace — every visibility filter excludes it. Fail loudly
        # at the API boundary so the caller supplies a slug instead of
        # silently producing an orphan. See memory/plan.md §3.1b Thread B.
        if not v:
            raise ValueError(
                "allowed_workspaces must include at least one workspace slug; "
                "a runner with no allowlist is invisible to every workspace"
            )
        return v


class AgentUpdate(UTCModel):
    name: Str255 | None = None
    description: str | None = None
    allowed_workspaces: list[str] | None = None
    allowed_actions: list[str] | None = None
    max_requests_per_minute: int | None = None
    budget_usd: float | None = None
    is_active: bool | None = None

    @field_validator("allowed_workspaces")
    @classmethod
    def _reject_empty_allowlist(cls, v: list[str] | None) -> list[str] | None:
        # PATCH semantics: null = "don't change this field" (allowed), empty
        # list = "strip all access" (rejected — same orphan trap as AgentCreate).
        if v is not None and len(v) == 0:
            raise ValueError(
                "allowed_workspaces cannot be set to an empty list; "
                "pass null to leave it unchanged, or supply at least one slug"
            )
        return v


class HeartbeatBody(UTCModel):
    version: str | None = None
    go_version: str | None = None
    hostname: str | None = None
    started_at: str | None = None
    uptime_seconds: int | None = None
    cards_processed: int | None = None
    cards_failed: int | None = None
    cards_skipped: int | None = None
    status: str | None = None
    current_card_id: str | None = None
    current_board_id: str | None = None
    last_error: str | None = None
    last_error_at: str | None = None
    poll_interval: str | None = None
    card_timeout: str | None = None
    health_port: int | None = None
    config_errors: list[dict] | None = None
    sensor_catalog: list[dict] | None = None
    loop_board_id: str | None = None
    # "idle_waiting" (card 5ffe97cf) is a keep-alive runner sitting on a board
    # whose loop an operator switched OFF — distinct from "parked", which means
    # the loop is running and found nothing actionable. Additive: the column is
    # String(16) and the value is 12, so no migration; the vocabulary stays
    # CLOSED because the runner's fallback keys off the 422 an older backend
    # returns to detect that it must downgrade to "parked".
    loop_state: Literal["ticking", "parked", "idle_waiting"] | None = None
    loop_park_reason: str | None = None
    loop_parked_since: str | None = None

    @field_validator("current_card_id", "current_board_id", mode="before")
    @classmethod
    def _blank_id_is_no_id(cls, value):
        """A blank id means "no card", so store None rather than "".

        `""` is falsy, so it already reads as "no card" in branches like the
        hard-delete mid-card guard, while still occupying a column other code
        treats as an id. Normalized instead of rejected because both transports
        parse through this model and the WS handler logs-and-drops a
        ValidationError (routers/events.py) — rejecting would discard the whole
        frame, stalling last_seen_at and drifting a healthy runner toward
        "offline" over one cosmetic field.
        """
        if isinstance(value, str) and not value.strip():
            return None
        return value


class TeamMembershipInfoCompat(UTCModel):
    """Backward-compat: singular role for legacy consumers."""
    team_id: uuid.UUID
    team_name: str
    role: str


class TeamMembershipInfo(UTCModel):
    team_id: uuid.UUID
    team_name: str
    roles: list[str]


class AgentRead(UTCModel):
    id: uuid.UUID
    name: str
    agent_type: AgentType
    description: str
    created_by_id: uuid.UUID
    is_active: bool
    is_paused: bool = False
    allowed_workspaces: list[str] | None
    allowed_actions: list[str] | None
    max_requests_per_minute: int
    budget_usd: float | None = None
    api_key_prefix: str | None = None
    last_key_rotated_at: datetime | None = None
    last_seen_at: datetime | None = None
    # Derived from last_seen_at on read. Tri-state + unknown:
    # alive | stale | offline | unknown. Backend has authority on the
    # thresholds (see app.services.agents.liveness).
    liveness: str = "unknown"
    health_status: str | None = None
    health_version: str | None = None
    health_uptime_seconds: int | None = None
    health_cards_processed: int | None = None
    health_cards_failed: int | None = None
    health_current_card_id: str | None = None
    health_last_error: str | None = None
    health_last_error_at: datetime | None = None
    health_go_version: str | None = None
    health_hostname: str | None = None
    health_started_at: datetime | None = None
    health_cards_skipped: int | None = None
    health_current_board_id: str | None = None
    health_poll_interval: str | None = None
    health_card_timeout: str | None = None
    health_port: int | None = None
    health_config_errors: list | None = None
    health_loop_board_id: str | None = None
    health_loop_state: str | None = None
    health_loop_park_reason: str | None = None
    health_loop_parked_since: datetime | None = None
    sensor_catalog: list | None = None
    team_membership: TeamMembershipInfoCompat | None = None
    team_memberships: list[TeamMembershipInfo] = []
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}

    @model_validator(mode="after")
    def _derive_liveness(self):
        # Liveness is computed from last_seen_at on every read so we never
        # serve a stale persisted state. Import is local to avoid a circular
        # import at module load (services -> schemas).
        from app.services.agents.liveness import compute_liveness

        self.liveness = compute_liveness(self.last_seen_at)
        return self


class AgentListRead(AgentRead):
    """`?summary=true` shape for the agents list: AgentRead without
    `sensor_catalog`, the per-heartbeat sensor manifest the runner WRITES and
    no list surface renders (the frontend reads it from its own
    /workspace-config sensor endpoint). Scoped to the list — /agents/me,
    /agents/{id} and the heartbeat response still carry it.

    Subclassed rather than redeclared: AgentRead is ~50 fields with a liveness
    validator, and a hand-copied twin would drift on the next field added.
    Excluding the field keeps it out of the response AND out of the OpenAPI
    schema for this endpoint.
    """

    sensor_catalog: list | None = Field(default=None, exclude=True)


class BudgetStatus(UTCModel):
    budget_usd: float | None
    spent_usd: float
    remaining_usd: float | None
    percentage_used: float | None
    is_exceeded: bool


class PromptConfigSummary(UTCModel):
    """Lightweight prompt config for the composite response."""
    id: uuid.UUID
    slug: str
    stage: str
    content: str
    # Derived: content + matching post_process imperative. Same semantics as
    # PromptConfigRead.resolved_content — runners must prefer this over content.
    resolved_content: str
    version: int

    model_config = {"from_attributes": True}


class AgentConfigResponse(UTCModel):
    """Composite config returned by GET /api/agents/me/config."""
    # Identity
    agent_id: uuid.UUID
    name: str
    agent_type: str
    description: str
    is_active: bool

    # Authorization
    allowed_workspaces: list[str] | None
    allowed_actions: list[str] | None
    max_requests_per_minute: int

    # Budget
    budget_usd: float | None
    spent_usd: float
    remaining_usd: float | None
    budget_exceeded: bool

    # Team
    team_id: uuid.UUID | None = None
    team_name: str | None = None
    team_role: str | None = None
    team_roles: list[str] = []
    board_id: uuid.UUID | None = None

    # Prompt configs (filtered by agent's team role)
    prompt_configs: list[PromptConfigSummary] = []

    # Workspace config (platform-managed parameters)
    workspace_config: dict = {}

    model_config = {"from_attributes": True}


class AgentCreated(AgentRead):
    # None when returned via an idempotent re-create hit — the original raw
    # key can't be recovered, so the client must rotate-key if they lost it.
    raw_api_key: str | None = None
