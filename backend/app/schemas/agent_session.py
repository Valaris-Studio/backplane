# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import ConfigDict, Field

from app.core.json_response import UTCModel
from app.schemas.companion import ContentLevel

SessionStatus = Literal["active", "idle", "ended"]
DisplayState = Literal[
    "active", "idle", "ended", "incomplete", "paused", "disconnected"
]
LinkRelation = Literal["changed", "consulted"]
# exact: matched on the harness's own tool call id. correlated: the harness
# sent none (Pi), so matched on tool, arguments and time alone.
LinkProvenance = Literal["exact", "correlated"]
AuthKind = Literal["subscription", "api", "enterprise", "unknown"]
CostSource = Literal["reported", "estimated", "mixed"]
CostBasis = Literal["spend", "api_equivalent"]
SessionCoverage = Literal["activity", "usage_only", "empty"]
SessionSort = Literal["recent", "started", "duration", "tokens", "cost"]

_COST_USD = (
    "Effective USD cost: per usage report the agent-reported cost when it "
    "reported one, otherwise Backplane's API list-price estimate; null when "
    "neither exists (never 0 for unknown)."
)
_COST_SOURCE = "Where cost_usd came from: all agent-reported, all estimated, or mixed."
_COST_BASIS = (
    "spend when an API key (or enterprise contract) paid; api_equivalent for "
    "a subscription or unknown login, where the cost is what the same usage "
    "would cost at API list price, not money spent. Null without a cost."
)


class AgentSessionRead(UTCModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    owner_id: uuid.UUID
    installation_id: uuid.UUID
    harness: str
    harness_display_name: str
    native_session_id: str
    parent_session_id: uuid.UUID | None
    mapping_id: uuid.UUID | None
    board_id: uuid.UUID | None
    status: SessionStatus = Field(
        description="The session's own lifecycle, from its timestamps alone (the "
        "`status` list filter): active, idle after 15 min of silence, ended on a "
        "session end event or after 24 h of silence (`ended_reason` tells which)."
    )
    started_at: datetime
    last_event_at: datetime
    ended_at: datetime | None
    cwd: str | None = Field(
        description="The working directory, never a path of the device: the "
        "bound folder's name plus the path inside it (`backplane/packages/api`), "
        "only a folder's own name outside the mapping or at the metadata level."
    )
    repository: str | None
    branch: str | None
    model: str | None
    harness_version: str | None
    title: str | None
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_creation_tokens: int
    reasoning_tokens: int = Field(
        description="Part of output_tokens spent reasoning; not added to totals."
    )
    cost_usd: float | None = Field(description=_COST_USD)
    cost_reported_usd: float | None = Field(
        description="Sum of the costs the agent itself reported."
    )
    cost_estimated_usd: float | None = Field(
        description="Sum of Backplane's list-price estimates from vendored price tables."
    )
    cost_source: CostSource | None = Field(description=_COST_SOURCE)
    cost_basis: CostBasis | None = Field(description=_COST_BASIS)
    cost_complete: bool = Field(
        description="False when any usage report could be neither reported nor priced."
    )
    auth_kind: AuthKind = Field(
        description="How the agent was paid for, as last seen on the session."
    )
    provider: str | None
    service_tier: str | None
    event_count: int
    prompt_count: int
    tool_call_count: int
    error_count: int
    capture_gaps: int = Field(
        description="Records for this session that ingest rejected; the timeline has holes."
    )
    activity_event_count: int = Field(
        description="Stored events that say what the agent did: every event "
        "except token usage reports and session start or end markers."
    )
    coverage: SessionCoverage = Field(
        description="activity when any activity event was captured; usage_only "
        "when the agent reported token usage or cost but no activity (the Codex "
        "app, for one), which does not mean nothing happened; empty with "
        "neither. Gaps are capture_gaps and display_state, not coverage."
    )
    capture_levels: list[ContentLevel] = Field(
        description="The distinct content levels Backplane applied when it stored "
        "this session's events, least recently applied first: the last is the "
        "level of the latest capture, more than one means the level changed "
        "mid-session. A level is an upper bound on what was kept. Empty when "
        "any of the session was captured before levels were recorded; no level "
        "is claimed for it then."
    )
    display_state: DisplayState = Field(
        description="Derived at read time: ended (session end event, no gaps); paused "
        "(capture switched off for this device, agent or mapping); disconnected "
        "(device revoked or silent past the heartbeat limit); otherwise active, "
        "idle after 15 min of silence, incomplete after 24 h or with capture gaps."
    )
    ended_reason: Literal["session_end_event", "abandoned"] | None = Field(
        description="Set exactly when `status` is ended, whatever `display_state` "
        "shows: `session_end_event`, or `abandoned` after 24 h of silence."
    )
    idle_since: datetime | None = Field(
        description="When the current silence began (the last event), once the "
        "session has been quiet for more than 15 minutes and has not ended."
    )
    child_count: int | None = Field(
        None,
        description="Subagent sessions that named this one as their parent. Null "
        "where it is not computed (the device API).",
    )
    link_count: int | None = Field(
        None,
        description="Distinct cards and notes this session changed or consulted "
        "that still exist where you can see them. Null where it is not computed.",
    )
    link_preview: "list[SessionLinkPreview] | None" = Field(
        None,
        description="Up to two of those cards and notes: changed before consulted, "
        "then the most recently touched; one entry per card or note. Null where "
        "it is not computed.",
    )


class SessionLinkPreview(UTCModel):
    entity_type: Literal["card", "note"]
    entity_id: uuid.UUID
    board_id: uuid.UUID | None
    title: str
    relation: LinkRelation = Field(
        description="changed when the session changed it at least once."
    )
    provenance: LinkProvenance


AgentSessionRead.model_rebuild()


class AgentSessionPage(UTCModel):
    items: list[AgentSessionRead]
    next_cursor: str | None


class AgentSessionEventRead(UTCModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    event_id: str
    capture_id: str
    occurred_at: datetime
    received_at: datetime
    action: str
    kind: str | None
    category: str | None
    fidelity: str | None
    collection_method: str
    tool_name: str | None
    native_tool_call_id: str | None
    mcp_server: str | None
    mcp_tool: str | None
    outcome: str | None
    capture_level: ContentLevel | None = Field(
        description="The content level this event was stored at; null when it "
        "was captured before levels were recorded."
    )
    data: dict[str, Any] = Field(
        description="The stored Beacon event, reduced to its capture_level. "
        "`backplane_redactions` maps each withheld path to the sha256 and bytes "
        "Backplane received, and `original_bytes`: the content's size before "
        "Backplane or the companion withheld it, null when unknown, absent on "
        "events stored before it was recorded."
    )


class AgentSessionEventPage(UTCModel):
    items: list[AgentSessionEventRead]
    next_cursor: str | None


class SessionWorkLinkRead(UTCModel):
    model_config = ConfigDict(from_attributes=True)

    entity_type: Literal["card", "note"]
    entity_id: uuid.UUID
    workspace_id: uuid.UUID
    board_id: uuid.UUID | None
    relation: LinkRelation
    first_seen_at: datetime
    last_seen_at: datetime
    invocation_count: int
    provenance: LinkProvenance


class SessionWorkLinkList(UTCModel):
    items: list[SessionWorkLinkRead]


class AgentSessionList(UTCModel):
    items: list[AgentSessionRead]


class LinkedSessionRead(UTCModel):
    session: AgentSessionRead
    relations: list[LinkRelation]
    provenance: LinkProvenance = Field(
        description="exact when any of the session's links to this entity is exact."
    )
    first_seen_at: datetime
    last_seen_at: datetime


class SessionPeriodSummary(UTCModel):
    """Totals across your sessions matching the list filters it was asked for."""

    session_count: int
    live_count: int = Field(
        description="Sessions whose display_state is active right now."
    )
    wall_duration_seconds: float = Field(
        description="Elapsed time covered by at least one session: the union of "
        "each session's span from first to last event, cut to start at `since`, "
        "so overlapping sessions and subagent threads count once."
    )
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_creation_tokens: int
    reasoning_tokens: int = Field(
        description="Part of output_tokens spent reasoning; not added to totals."
    )
    cost_api_equivalent_usd: float | None = Field(
        description="Summed effective cost of sessions under a subscription or an "
        "unknown login: what the usage would cost at API list price, not money "
        "spent. Null when none of them has a cost. Never added to cost_spend_usd."
    )
    cost_spend_usd: float | None = Field(
        description="Summed effective cost of sessions an API key or enterprise "
        "contract paid for. Null when none of them has a cost."
    )
    cost_complete: bool = Field(
        description="False when any session that used tokens has no cost or an "
        "unpriced usage report, so the costs are a lower bound."
    )


class LinkedWorkSummary(UTCModel):
    """Totals across the caller's own sessions linked to one card or note."""

    session_count: int
    first_seen_at: datetime | None
    last_seen_at: datetime | None
    total_duration_seconds: float = Field(
        description="Sum of each session's span from first to last event; a "
        "subagent thread overlapping its parent is counted in both. Prefer "
        "wall_duration_seconds for elapsed time."
    )
    wall_duration_seconds: float = Field(
        description="Elapsed time covered by at least one linked session: the "
        "union of each session's span from first to last event, so a subagent "
        "thread overlapping its parent is counted once."
    )
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_creation_tokens: int
    reasoning_tokens: int
    cost_usd: float | None = Field(
        description="Sum of the sessions' effective costs; null when none has one."
    )
    cost_reported_usd: float | None
    cost_estimated_usd: float | None
    cost_source: CostSource | None = Field(description=_COST_SOURCE)
    cost_basis: CostBasis | Literal["mixed"] | None = Field(
        description=_COST_BASIS + " mixed when the sessions differ."
    )
    cost_complete: bool = Field(
        description="False when any linked session has no cost or an unpriced usage report."
    )


class SessionModelUsage(UTCModel):
    """A session's usage reports for one model, provider, service tier and
    auth kind. Token buckets are disjoint except reasoning_tokens, which is
    part of output_tokens."""

    model: str | None
    provider: str | None
    service_tier: str | None
    auth_kind: AuthKind
    pricing_status: Literal["priced", "unknown_model", "no_model", "no_tokens"]
    usage_count: int
    input_uncached_tokens: int
    cache_read_tokens: int
    cache_write_5m_tokens: int
    cache_write_1h_tokens: int
    output_tokens: int
    reasoning_tokens: int
    cost_usd: float | None = Field(description=_COST_USD)
    cost_reported_usd: float | None
    cost_estimated_usd: float | None
    cost_source: CostSource | None = Field(description=_COST_SOURCE)
    cost_basis: CostBasis | None = Field(description=_COST_BASIS)
    unpriced_usage_count: int
    stale_usage_count: int = Field(
        description="Rows estimated under an older price table than "
        "price_table_version, awaiting a reprice."
    )


class SessionUsageList(UTCModel):
    items: list[SessionModelUsage]
    price_table_version: str = Field(
        description="Version of the vendored price tables estimates are made from."
    )


class LinkedSessionList(UTCModel):
    items: list[LinkedSessionRead]
    summary: LinkedWorkSummary


CallKind = Literal["prompt", "tool", "mcp", "subagent"]
CallFilter = Literal["all", "work", "failures"]
WithheldField = Literal["prompt", "arguments", "output", "error", "diff"]


class WithheldContent(UTCModel):
    field: WithheldField
    bytes: int | None = Field(
        description="Size of what was not sent, when the device or server recorded it."
    )


class CallWorkRef(UTCModel):
    entity_type: Literal["card", "note"]
    entity_id: uuid.UUID
    workspace_id: uuid.UUID
    board_id: uuid.UUID | None
    title: str
    relation: LinkRelation
    provenance: LinkProvenance


class SessionCallItem(UTCModel):
    """One timeline entry: a prompt, a tool call (every event sharing its
    native call id), or a subagent session placed at its start."""

    key: str = Field(description="Opaque; pass to GET …/calls/{key} to expand.")
    kind: CallKind
    turn_index: int = Field(
        description="0 before the first prompt; each prompt opens the next turn."
    )
    call_id: str | None
    name: str | None = Field(description="Tool name, or the event action without one.")
    mcp_server: str | None
    mcp_tool: str | None
    started_at: datetime
    ended_at: datetime
    duration_ms: int | None = Field(
        description="From the call's first to last event, or as the agent reported "
        "it; null for a call captured as a single event."
    )
    event_count: int
    outcome: Literal["succeeded", "failed", "running", "unknown"] | None = Field(
        description="From the call's own completion signals only: failed when any "
        "event failed, succeeded when one completed; otherwise running while the "
        "session is still open, or unknown once it has ended. Null for prompts "
        "and subagents."
    )
    exit_code: int | None
    args_preview: str | None = Field(
        description="The command or arguments as sent, cut to 300 characters; "
        "null when not sent (see withheld) or absent."
    )
    prompt_preview: str | None = Field(
        description="A prompt's text as sent, cut to 1000 characters."
    )
    output: Literal["sent", "withheld", "none"] = Field(
        description="Whether the call's output reached Backplane. Output is never "
        "in this page; expand the call to read it."
    )
    withheld: list[WithheldContent] = Field(
        description="Content this call had but its capture level did not send."
    )
    work_refs: list[CallWorkRef] = Field(
        description="Cards and notes this MCP call changed or consulted that "
        "still exist where you can see them."
    )
    subagent: AgentSessionRead | None = Field(
        description="The child session, for kind subagent."
    )


class SessionTurn(UTCModel):
    turn_index: int
    started_at: datetime
    ended_at: datetime
    call_count: int
    failure_count: int
    reasoning_count: int


class SessionCallPage(UTCModel):
    items: list[SessionCallItem] = Field(description="In occurrence order.")
    turns: list[SessionTurn] = Field(
        description="Totals for each turn that has an item on this page, counted "
        "over the whole turn."
    )
    next_cursor: str | None = Field(
        description="The page of earlier items; the first page is the newest."
    )


class RhythmBucket(UTCModel):
    """Timeline entries that began in [t, t + bucket_seconds), each counted
    once as one kind, in this order of precedence: prompt, error (a failed
    call), work (an MCP call that touched a card or note you can see), file
    (an edit, write or patch), tool (any other call)."""

    t: datetime
    prompt: int
    tool: int
    file: int
    work: int
    error: int


class TimeSpan(UTCModel):
    start: datetime
    end: datetime


class RhythmLane(UTCModel):
    """A subagent session, drawn from its first to its last event."""

    session_id: uuid.UUID
    harness: str
    harness_display_name: str
    title: str | None
    start: datetime
    end: datetime
    display_state: DisplayState


class SessionRhythm(UTCModel):
    start: datetime = Field(description="The session's first event.")
    end: datetime = Field(
        description="Now while the session is open (`live`), else its last event."
    )
    live: bool
    bucket_seconds: float = Field(
        description="Width of each bucket; 0 for a session with a single instant."
    )
    buckets: list[RhythmBucket] = Field(description="Contiguous, oldest first.")
    idle_spans: list[TimeSpan] = Field(
        description="Silences longer than 5 minutes between activity events, plus "
        "the current one up to `end` while the session is live."
    )
    children: list[RhythmLane]
    capture_gaps: int = Field(
        description="Records ingest rejected; where in time they fell is unknown."
    )


class SessionCallDetail(UTCModel):
    key: str
    events: list[AgentSessionEventRead]
