# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Float, ForeignKey, Index, String, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class MCPInvocation(Base):
    __tablename__ = "mcp_invocations"
    __table_args__ = (
        Index("ix_mcp_invocations_owner", "owner_id", "created_at", "id"),
        Index("ix_mcp_invocations_native_call", "owner_id", "native_call_id"),
        Index(
            "ix_mcp_invocations_correlatable",
            "owner_id",
            "completed_at",
            postgresql_where=text("arguments_fingerprint IS NOT NULL"),
            sqlite_where=text("arguments_fingerprint IS NOT NULL"),
        ),
        CheckConstraint(
            "status IN ('completed', 'failed', 'aborted')",
            name="ck_mcp_invocation_status",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE")
    )
    agent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agents.id", ondelete="CASCADE")
    )
    workspace_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    workspace_slug: Mapped[str | None] = mapped_column(String(200))
    scope_status: Mapped[str] = mapped_column(String(16))
    tool_name: Mapped[str] = mapped_column(String(200))
    arguments_summary: Mapped[str | None] = mapped_column(String(200))
    result_summary: Mapped[str | None] = mapped_column(String(500))
    error_message: Mapped[str | None] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(16))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    duration_seconds: Mapped[float] = mapped_column(Float)
    # Client-reported context that lets a captured session claim this call:
    # the harness and the harness's own id for the tool call.
    harness: Mapped[str | None] = mapped_column(String(64))
    native_call_id: Mapped[str | None] = mapped_column(String(200))
    client_name: Mapped[str | None] = mapped_column(String(200))
    client_version: Mapped[str | None] = mapped_column(String(64))
    server_instance_id: Mapped[str | None] = mapped_column(String(200))
    # Sent instead of a native call id by harnesses that cannot supply one.
    arguments_fingerprint: Mapped[str | None] = mapped_column(String(64))
    payload_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class MCPConsultation(Base):
    """An authorized card/note read performed under an MCP invocation."""

    __tablename__ = "mcp_consultations"
    # Outcome recording follows the read and may never arrive. No invocation
    # FK: an observed read never manufactures a canonical client outcome.
    invocation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True
    )
    actor_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    principal_key: Mapped[str] = mapped_column(String(36), primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        primary_key=True,
    )
    entity_type: Mapped[str] = mapped_column(String(16), primary_key=True)
    entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
