# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from app.core.json_response import UTCModel

from app.models.agents.execution import ExecutionStatus


class ExecutionCreate(UTCModel):
    workspace_slug: str
    board_id: uuid.UUID | None = None
    # The card this execution is working, when card-bound. Persisted as the
    # first cards_affected entry so agent_presence='active' is authoritative
    # from the moment work starts (the runner reserves a card per stage).
    # Optional: non-card stages (planning/triage) omit it.
    card_id: uuid.UUID | None = None
    action: str
    input_summary: str
    session_id: str | None = None
    parent_execution_id: uuid.UUID | None = None
    role: str | None = None
    input_prompt: str | None = None
    # Wave 2 / CRIT-2: runner reports which prompt slug + LLM model it used.
    # All optional so legacy callers (older runners, internal tools) still
    # post against this endpoint without modification. provider/model are the
    # RESOLVED coding agent the runner actually ran (post tier_providers remap),
    # not the backend's tier suggestion.
    prompt_slug: str | None = None
    model: str | None = None
    provider: str | None = None
    # Skills Registry W3: the manifest of skills the runner materialized for
    # this stage. Optional so old runners keep posting unmodified.
    skills: list[dict] | None = None


class ExecutionWarningCreate(UTCModel):
    # `kind` is a stable enum string set by the runner (e.g.
    # "approval_poll_deadline"). The frontend HealthCard /
    # AgentStatusBar switches on it to render an icon + i18n string.
    kind: str
    message: str
    card_id: uuid.UUID | None = None


class ExecutionUpdate(UTCModel):
    status: ExecutionStatus | None = None
    output_summary: str | None = None
    tools_used: list[str] | None = None
    cards_affected: list[str] | None = None
    error_message: str | None = None
    tool_calls_count: int | None = None
    tokens_used: int | None = None
    cost_usd: float | None = None
    duration_seconds: float | None = None
    input_prompt: str | None = None
    ship_warnings: list[str] | None = None
    # Skills Registry W3: a late manifest report. Only lands on a row whose
    # skills are still NULL — a recorded manifest is never cleared or replaced
    # (see update_execution).
    skills: list[dict] | None = None


class ToolInvocationCreate(UTCModel):
    tool_name: str
    arguments_summary: str = ""
    result_summary: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    duration_seconds: float | None = None
    status: str = "completed"
    error_message: str | None = None
    position: int = 0


class ToolInvocationRead(UTCModel):
    id: uuid.UUID
    tool_name: str
    arguments_summary: str
    result_summary: str | None
    started_at: datetime
    completed_at: datetime | None
    duration_seconds: float | None
    status: str
    error_message: str | None
    position: int

    model_config = {"from_attributes": True}


class CardRef(UTCModel):
    # Stringified UUIDs to match cards_affected's existing str convention and
    # Execution.board_id serialization. board_id is the CARD's board (an
    # execution can touch cards on another board), so the FE deep-link opens
    # the right board.
    id: str
    title: str
    board_id: str | None


class ExecutionRead(UTCModel):
    id: uuid.UUID
    agent_id: uuid.UUID
    workspace_id: uuid.UUID
    board_id: uuid.UUID | None
    session_id: str | None
    action: str
    status: ExecutionStatus
    started_at: datetime
    completed_at: datetime | None
    input_summary: str
    output_summary: str | None
    tools_used: list[str] | None
    cards_affected: list[str] | None
    # Resolved {id,title,board_id} for each RESOLVABLE card in cards_affected —
    # populated by ExecutionService._attach_card_refs, read via from_attributes.
    # Deleted cards drop from here but stay in raw cards_affected for the FE's
    # truncated-id fallback. Additive: defaults to [] for old clients / paths
    # that never pass through the enricher.
    cards_affected_detail: list[CardRef] = []
    error_message: str | None
    tool_calls_count: int
    tokens_used: int | None
    cost_usd: float | None
    duration_seconds: float | None
    parent_execution_id: uuid.UUID | None = None
    prompt_config_id: uuid.UUID | None = None
    role: str | None = None
    input_prompt: str | None = None
    ship_warnings: list[str] | None = None
    prompt_slug: str | None = None
    model: str | None = None
    provider: str | None = None
    tool_invocations: list[ToolInvocationRead] = []

    model_config = {"from_attributes": True}


class ExecutionListRead(UTCModel):
    """`?summary=true` shape for the executions LIST endpoints.

    Identical to ExecutionRead minus `input_prompt` (the full rendered LLM
    prompt) and `tool_invocations` — the two fields no list UI renders and
    which dominate the payload. Declared as its own model rather than an
    exclude-set on ExecutionRead so the omission is visible in the OpenAPI
    schema and a new heavy field can't silently join the trimmed response.

    `tool_calls_count` stays: it is a scalar column on the execution, not a
    length of the dropped relationship, and the timeline renders it.
    """

    id: uuid.UUID
    agent_id: uuid.UUID
    workspace_id: uuid.UUID
    board_id: uuid.UUID | None
    session_id: str | None
    action: str
    status: ExecutionStatus
    started_at: datetime
    completed_at: datetime | None
    input_summary: str
    output_summary: str | None
    tools_used: list[str] | None
    cards_affected: list[str] | None
    cards_affected_detail: list[CardRef] = []
    error_message: str | None
    tool_calls_count: int
    tokens_used: int | None
    cost_usd: float | None
    duration_seconds: float | None
    parent_execution_id: uuid.UUID | None = None
    prompt_config_id: uuid.UUID | None = None
    role: str | None = None
    ship_warnings: list[str] | None = None
    prompt_slug: str | None = None
    model: str | None = None
    provider: str | None = None

    model_config = {"from_attributes": True}
