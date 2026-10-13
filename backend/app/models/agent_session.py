# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    CHAR,
    JSON,
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UUIDMixin

EventJSON = JSON().with_variant(JSONB, "postgresql")

# Event actions that say nothing about what the agent did: usage reports and
# session lifecycle markers. Any other action, including one Beacon adds
# later, counts as activity, so an unknown action never hides a timeline.
NON_ACTIVITY_ACTIONS = frozenset(
    {"token.usage", "api.request", "session.started", "session.ended"}
)


class AgentSession(Base, UUIDMixin):
    """One coding-agent session, private to the user whose machine captured it.

    Identity includes the installation: the same native session id captured
    on two of the owner's machines is two sessions, by design.

    The summary columns are maintained at ingest from newly stored events only,
    so replayed or cross-channel duplicate events never count twice.
    """

    __tablename__ = "agent_sessions"
    __table_args__ = (
        UniqueConstraint(
            "workspace_id",
            "owner_id",
            "installation_id",
            "harness",
            "native_session_id",
            name="uq_agent_session_identity",
        ),
        Index(
            "ix_agent_sessions_owner_recent",
            "owner_id",
            "workspace_id",
            "last_event_at",
            "id",
        ),
        Index(
            "ix_agent_sessions_owner_started",
            "owner_id",
            "workspace_id",
            "started_at",
            "id",
        ),
        Index("ix_agent_sessions_board_recent", "board_id", "last_event_at"),
        # The retention purge scans by age across every owner.
        Index("ix_agent_sessions_last_event_at", "last_event_at"),
        CheckConstraint(
            "status IN ('active', 'ended')", name="ck_agent_session_status"
        ),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE")
    )
    installation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("companion_installations.id", ondelete="CASCADE"),
    )
    harness: Mapped[str] = mapped_column(String(64))
    native_session_id: Mapped[str] = mapped_column(String(200))
    # A subagent thread names its root thread by native id; the FK is filled
    # in whichever of the two sessions arrives second, and only within the
    # same (workspace, owner, installation, harness).
    parent_native_session_id: Mapped[str | None] = mapped_column(
        String(200), nullable=True
    )
    parent_session_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_sessions.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    mapping_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("companion_project_mappings.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    board_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="SET NULL"), nullable=True
    )
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_event_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    status: Mapped[str] = mapped_column(
        String(16), default="active", server_default="active"
    )
    cwd: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    repository: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    branch: Mapped[str | None] = mapped_column(String(255), nullable=True)
    model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    harness_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    input_tokens: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    output_tokens: Mapped[int] = mapped_column(
        BigInteger, default=0, server_default="0"
    )
    cache_read_tokens: Mapped[int] = mapped_column(
        BigInteger, default=0, server_default="0"
    )
    cache_creation_tokens: Mapped[int] = mapped_column(
        BigInteger, default=0, server_default="0"
    )
    # Subset of output_tokens; never added to totals.
    reasoning_tokens: Mapped[int] = mapped_column(
        BigInteger, default=0, server_default="0"
    )
    # Effective cost: per usage row the agent-reported cost when there is
    # one, otherwise our list-price estimate. NULL means neither exists,
    # never "free". Rows are the source of truth (agent_session_usage).
    cost_usd: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    cost_reported_usd: Mapped[Decimal | None] = mapped_column(
        Numeric(18, 6), nullable=True
    )
    cost_estimated_usd: Mapped[Decimal | None] = mapped_column(
        Numeric(18, 6), nullable=True
    )
    # Where cost_usd came from, counted over rows: reported, estimated, mixed.
    cost_source: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # Usage rows with tokens but neither a reported nor an estimated cost.
    unpriced_usage_count: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0"
    )
    # Latest billing and routing facts seen on any event of the session; a
    # usage row that does not state its own inherits them.
    auth_kind: Mapped[str | None] = mapped_column(String(16), nullable=True)
    provider: Mapped[str | None] = mapped_column(String(64), nullable=True)
    service_tier: Mapped[str | None] = mapped_column(String(32), nullable=True)
    event_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    prompt_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    tool_call_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    error_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Records addressed to this session that ingest rejected (invalid,
    # too large, conflicting): the timeline is known to have holes.
    capture_gaps: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Stored events that are activity (see NON_ACTIVITY_ACTIONS). NULL for
    # sessions the previous release wrote: counted from events on read and
    # filled at the next ingest; no server default, so old code leaves NULL.
    activity_event_count: Mapped[int | None] = mapped_column(
        Integer, default=0, nullable=True
    )
    # The distinct content levels ingest applied to stored events, least
    # recently applied first. NULL when any event was stored before levels
    # were recorded: those events' level is unknown, so none is claimed.
    capture_levels: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # Body bytes reserved by this session's content items (pending uploads
    # included), and how many items it has; content never counts as activity.
    content_bytes: Mapped[int] = mapped_column(
        BigInteger, default=0, server_default="0"
    )
    content_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AgentSessionTombstone(Base, UUIDMixin):
    """A deleted session's identity and how far its deleted history reaches:
    anything the device observed at or before `history_cutoff` is acknowledged
    and dropped, so queued retries and transcript re-reads never bring it
    back; later activity of the same native session is captured afresh."""

    __tablename__ = "agent_session_tombstones"
    __table_args__ = (
        UniqueConstraint(
            "workspace_id",
            "owner_id",
            "installation_id",
            "harness",
            "native_session_id",
            name="uq_agent_session_tombstone_identity",
        ),
        CheckConstraint(
            "reason IN ('owner', 'retention')", name="ck_agent_session_tombstone_reason"
        ),
        # Ingest looks a device's native session up in every workspace.
        Index(
            "ix_agent_session_tombstones_installation_native",
            "installation_id",
            "native_session_id",
        ),
    )

    # The deleted session's id, so repeating the owner's DELETE stays a 204.
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    installation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("companion_installations.id", ondelete="CASCADE"),
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE")
    )
    harness: Mapped[str] = mapped_column(String(64))
    native_session_id: Mapped[str] = mapped_column(String(200))
    reason: Mapped[str] = mapped_column(String(16))
    deleted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    # On the device's clock, which stamps every record and event. NULL on
    # tombstones written before cutoffs existed (see session_history_cutoff).
    history_cutoff: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # The deleted_at the cutoff was computed for. The previous release
    # re-deleting moves deleted_at only; a mismatch marks the cutoff stale.
    history_cutoff_deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class AgentSessionCapture(Base, UUIDMixin):
    """Receipt for one uploaded capture record, the unit of upload retry."""

    __tablename__ = "agent_session_captures"
    __table_args__ = (
        UniqueConstraint(
            "installation_id", "capture_id", name="uq_agent_session_capture"
        ),
        # A device's latest receipts measure its clock lead at deletion.
        Index(
            "ix_agent_session_captures_installation_received",
            "installation_id",
            "received_at",
        ),
    )

    installation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("companion_installations.id", ondelete="CASCADE"),
    )
    capture_id: Mapped[str] = mapped_column(String(32))
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_sessions.id", ondelete="CASCADE"),
        index=True,
    )
    content_hash: Mapped[str] = mapped_column(String(64))
    collection_method: Mapped[str] = mapped_column(String(16))
    beacon_commit: Mapped[str | None] = mapped_column(String(64), nullable=True)
    beacon_schema_version: Mapped[str | None] = mapped_column(String(16), nullable=True)
    event_count: Mapped[int] = mapped_column(Integer)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # The mapping's content level ingest applied to this record's events;
    # NULL for records received before levels were recorded.
    content_level: Mapped[str | None] = mapped_column(String(16), nullable=True)


class AgentSessionEvent(Base, UUIDMixin):
    __tablename__ = "agent_session_events"
    __table_args__ = (
        UniqueConstraint("session_id", "event_id", name="uq_agent_session_event"),
        Index("ix_agent_session_events_timeline", "session_id", "occurred_at", "id"),
        Index("ix_agent_session_events_native_call", "native_tool_call_id"),
        Index(
            "ix_agent_session_events_call_signature",
            "tool_call_signature",
            postgresql_where=text("tool_call_signature IS NOT NULL"),
            sqlite_where=text("tool_call_signature IS NOT NULL"),
        ),
    )

    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_sessions.id", ondelete="CASCADE")
    )
    # Beacon's content-derived event.id, so the hook and OTLP copies of one
    # observation collapse into a single row.
    event_id: Mapped[str] = mapped_column(String(64))
    capture_id: Mapped[str] = mapped_column(String(32))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    action: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str | None] = mapped_column(String(64), nullable=True)
    category: Mapped[str | None] = mapped_column(String(64), nullable=True)
    fidelity: Mapped[str | None] = mapped_column(String(16), nullable=True)
    collection_method: Mapped[str] = mapped_column(String(16))
    tool_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    native_tool_call_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    mcp_server: Mapped[str | None] = mapped_column(String(200), nullable=True)
    mcp_tool: Mapped[str | None] = mapped_column(String(200), nullable=True)
    outcome: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # Only for harnesses whose MCP calls may carry no native call id: what the
    # call looked like, for fuzzy correlation (app/core/call_correlation.py).
    tool_call_signature: Mapped[str | None] = mapped_column(String(64), nullable=True)
    event: Mapped[dict] = mapped_column(EventJSON)


AUTH_KINDS = ("subscription", "api", "enterprise", "unknown")
COST_SOURCES = ("reported", "estimated", "none")
PRICING_STATUSES = ("priced", "unknown_model", "no_model", "no_tokens")


class AgentSessionUsage(Base, UUIDMixin):
    """One usage report (a model response or turn) of a session, per model.

    Token buckets are disjoint except `reasoning_tokens`, the part of
    `output_tokens` spent thinking. One row per stored event, so a replayed
    upload never counts twice.
    """

    __tablename__ = "agent_session_usage"
    __table_args__ = (
        UniqueConstraint("session_id", "event_id", name="uq_agent_session_usage_event"),
        Index("ix_agent_session_usage_price_version", "price_table_version"),
        CheckConstraint(
            "auth_kind IN ('subscription', 'api', 'enterprise', 'unknown')",
            name="ck_agent_session_usage_auth_kind",
        ),
        CheckConstraint(
            "cost_source IN ('reported', 'estimated', 'none')",
            name="ck_agent_session_usage_cost_source",
        ),
        CheckConstraint(
            "pricing_status IN ('priced', 'unknown_model', 'no_model', 'no_tokens')",
            name="ck_agent_session_usage_pricing_status",
        ),
    )

    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_sessions.id", ondelete="CASCADE")
    )
    event_id: Mapped[str] = mapped_column(String(64))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    provider: Mapped[str | None] = mapped_column(String(64), nullable=True)
    model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    service_tier: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # The response speed when not standard (Claude Code's fast mode), which
    # no price table rates yet; kept so those rows can be repriced.
    speed: Mapped[str | None] = mapped_column(String(16), nullable=True)
    auth_kind: Mapped[str] = mapped_column(
        String(16), default="unknown", server_default="unknown"
    )
    input_uncached_tokens: Mapped[int] = mapped_column(
        BigInteger, default=0, server_default="0"
    )
    cache_read_tokens: Mapped[int] = mapped_column(
        BigInteger, default=0, server_default="0"
    )
    cache_write_5m_tokens: Mapped[int] = mapped_column(
        BigInteger, default=0, server_default="0"
    )
    cache_write_1h_tokens: Mapped[int] = mapped_column(
        BigInteger, default=0, server_default="0"
    )
    output_tokens: Mapped[int] = mapped_column(
        BigInteger, default=0, server_default="0"
    )
    reasoning_tokens: Mapped[int] = mapped_column(
        BigInteger, default=0, server_default="0"
    )
    # One request's prompt size, which selects long-context rates; NULL when
    # the row sums several requests (a Codex turn).
    context_tokens: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    cost_reported_usd: Mapped[Decimal | None] = mapped_column(
        Numeric(18, 9), nullable=True
    )
    cost_estimated_usd: Mapped[Decimal | None] = mapped_column(
        Numeric(18, 9), nullable=True
    )
    cost_source: Mapped[str] = mapped_column(String(16))
    pricing_status: Mapped[str] = mapped_column(String(16))
    pricing_model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    price_table_version: Mapped[str | None] = mapped_column(String(64), nullable=True)


class AgentSessionInvocation(Base):
    """A matched (session, MCP invocation) pair; materializes work links once.

    `exact` matched on the harness's native call id; `correlated` on tool,
    arguments and time alone, and names the captured call it claimed.
    """

    __tablename__ = "agent_session_invocations"
    __table_args__ = (
        CheckConstraint(
            "provenance IN ('exact', 'correlated')",
            name="ck_agent_session_invocation_provenance",
        ),
    )

    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_sessions.id", ondelete="CASCADE"),
        primary_key=True,
    )
    invocation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("mcp_invocations.id", ondelete="CASCADE"),
        primary_key=True,
        index=True,
    )
    matched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    provenance: Mapped[str] = mapped_column(
        String(16), default="exact", server_default="exact"
    )
    matched_call_id: Mapped[str | None] = mapped_column(String(200), nullable=True)


class SessionWorkLink(Base, UUIDMixin):
    __tablename__ = "session_work_links"
    __table_args__ = (
        UniqueConstraint(
            "session_id",
            "entity_type",
            "entity_id",
            "relation",
            name="uq_session_work_link",
        ),
        Index("ix_session_work_links_entity", "entity_type", "entity_id"),
        CheckConstraint(
            "entity_type IN ('card', 'note')", name="ck_session_work_link_entity"
        ),
        CheckConstraint(
            "relation IN ('changed', 'consulted')",
            name="ck_session_work_link_relation",
        ),
    )

    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_sessions.id", ondelete="CASCADE")
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        index=True,
    )
    entity_type: Mapped[str] = mapped_column(String(16))
    # No FK: cards and notes live in different tables; visibility is rechecked
    # against the live entity on every read.
    entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    board_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("boards.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    relation: Mapped[str] = mapped_column(String(16))
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    invocation_count: Mapped[int] = mapped_column(Integer, default=1)
    # How many of those invocations were only correlated, never matched exactly.
    correlated_count: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0"
    )

    @property
    def provenance(self) -> str:
        return (
            "correlated" if self.correlated_count >= self.invocation_count else "exact"
        )


CONTENT_STATES = ("pending", "available", "recorded")


class AgentSessionCaptureGeneration(Base, UUIDMixin):
    """A device's forward-only capture generation (an unbroken run of capture
    windows with unchanged settings), as it first declared it. Its facts are
    kept for audit and must not change under a reused key."""

    __tablename__ = "agent_session_capture_generations"
    __table_args__ = (
        UniqueConstraint(
            "installation_id",
            "generation_key",
            name="uq_agent_session_capture_generation",
        ),
    )

    installation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("companion_installations.id", ondelete="CASCADE"),
    )
    mapping_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("companion_project_mappings.id", ondelete="SET NULL"),
        nullable=True,
    )
    harness: Mapped[str] = mapped_column(String(64))
    generation_key: Mapped[str] = mapped_column(CHAR(32))
    # Opaque to the server: a digest of the device's settings for the window.
    policy_revision: Mapped[str] = mapped_column(CHAR(64))
    # On the device's clock.
    admitted_from: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AgentSessionContent(Base, UUIDMixin):
    """One content item of a session: its metadata always, its body inline
    (small text) or in the content store once uploaded and verified.

    `coverage` is what readers see; `declared_coverage` and `delivery` are the
    device's own declaration, kept to answer its replays identically."""

    __tablename__ = "agent_session_contents"
    __table_args__ = (
        UniqueConstraint("session_id", "content_key", name="uq_agent_session_content"),
        Index(
            "ix_agent_session_contents_timeline",
            "session_id",
            "occurred_at",
            "source_order",
            "id",
        ),
        Index(
            "ix_agent_session_contents_call",
            "session_id",
            "call_key",
            postgresql_where=text("call_key IS NOT NULL"),
            sqlite_where=text("call_key IS NOT NULL"),
        ),
        Index(
            "ix_agent_session_contents_pending_expiry",
            "upload_expires_at",
            postgresql_where=text("state = 'pending'"),
            sqlite_where=text("state = 'pending'"),
        ),
        Index("ix_agent_session_contents_receipt", "installation_id", "capture_id"),
        CheckConstraint(
            "state IN ('pending', 'available', 'recorded')",
            name="ck_agent_session_content_state",
        ),
    )

    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_sessions.id", ondelete="CASCADE")
    )
    # Denormalized from the session, so every lookup is scoped in one row.
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE")
    )
    installation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("companion_installations.id", ondelete="CASCADE"),
    )
    # No ON DELETE: a generation cannot go while its contents stay, yet one
    # statement cascading through both still succeeds (checked at its end).
    generation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_session_capture_generations.id")
    )
    capture_id: Mapped[str] = mapped_column(String(32))
    content_key: Mapped[str] = mapped_column(CHAR(64))
    event_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    call_key: Mapped[str | None] = mapped_column(String(200), nullable=True)
    parent_call_key: Mapped[str | None] = mapped_column(String(200), nullable=True)
    turn_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    display_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    role: Mapped[str] = mapped_column(String(16))
    channel: Mapped[str] = mapped_column(String(32))
    media_type: Mapped[str] = mapped_column(String(127))
    source_kind: Mapped[str] = mapped_column(String(32))
    native_ref: Mapped[str | None] = mapped_column(String(200), nullable=True)
    source_order: Mapped[int] = mapped_column(BigInteger)
    body_from: Mapped[str | None] = mapped_column(String(32), nullable=True)
    parser_version: Mapped[str] = mapped_column(String(64))
    source_schema_version: Mapped[str] = mapped_column(String(64))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    content_level: Mapped[str] = mapped_column(String(16))
    policy_revision: Mapped[str] = mapped_column(CHAR(64))
    filter_version: Mapped[str] = mapped_column(String(64))
    # How often the device's secret filter replaced text.
    redactions: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    byte_count: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    original_byte_count: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    sha256: Mapped[str | None] = mapped_column(CHAR(64), nullable=True)
    inline_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Of an uploaded text body; an inline body is its own preview.
    preview: Mapped[str | None] = mapped_column(Text, nullable=True)
    storage_backend: Mapped[str | None] = mapped_column(String(16), nullable=True)
    storage_key: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    state: Mapped[str] = mapped_column(String(16))
    coverage: Mapped[str] = mapped_column(String(32))
    coverage_reason: Mapped[str | None] = mapped_column(String(32), nullable=True)
    declared_coverage: Mapped[str] = mapped_column(String(32))
    declared_coverage_reason: Mapped[str | None] = mapped_column(
        String(32), nullable=True
    )
    delivery: Mapped[str] = mapped_column(String(16))
    chunk_count: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    # Chunk index (as text) -> its sha256, for the upload in progress.
    received_chunks: Mapped[dict] = mapped_column(
        JSON, default=dict, server_default=text("'{}'")
    )
    finalize_failures: Mapped[int] = mapped_column(
        SmallInteger, default=0, server_default="0"
    )
    upload_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    available_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class AgentSessionContentDeletion(Base, UUIDMixin):
    """Stored objects to delete: a session's, a content's or a failed
    attempt's key prefix. Rows go once the store confirms; failures back off."""

    __tablename__ = "agent_session_content_deletions"
    __table_args__ = (
        Index("ix_agent_session_content_deletions_due", "next_attempt_at"),
    )

    storage_backend: Mapped[str] = mapped_column(String(16))
    storage_prefix: Mapped[str] = mapped_column(String(1024))
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(String(1024), nullable=True)
