# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import CHAR, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.models.base import Base, UUIDMixin

RECEIPT_STATUS_PREPARED = "prepared"
USE_NOT_VERIFIED = "not_verified"


class ExecutionContextBinding(Base, UUIDMixin):
    """The assignment identity an execution was started under, promoted once
    from an unexpired scheduler hold and never rewritten.

    `reservation_id` is evidence, not a foreign key: the hold expires or is
    swept long before slow setup or a later model call ends, and neither may
    invalidate the bound work. Its uniqueness is what lets one hold promote
    to exactly one execution."""

    __tablename__ = "execution_context_bindings"
    __table_args__ = (
        UniqueConstraint("execution_id", name="uq_execution_context_bindings_execution"),
        UniqueConstraint(
            "reservation_id", name="uq_execution_context_bindings_reservation"
        ),
    )

    execution_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_executions.id", ondelete="CASCADE")
    )
    reservation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    agent_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    board_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    card_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    role: Mapped[str] = mapped_column(String(64))
    # sha256 of the canonical start request: an identical retry replays, any
    # other payload reusing the hold conflicts.
    start_request_sha256: Mapped[str] = mapped_column(CHAR(64))
    # The context-dispatch floor negotiated at start. NULL for legacy starts;
    # never rewritten, so a later policy removal cannot downgrade this work.
    context_dispatch_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    context_dispatch_mode: Mapped[str | None] = mapped_column(String(16), nullable=True)
    context_dispatch_policy_revision: Mapped[str | None] = mapped_column(
        CHAR(64), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    @property
    def context_dispatch(self) -> dict | None:
        if self.context_dispatch_version is None:
            return None
        return {
            "version": self.context_dispatch_version,
            "mode": self.context_dispatch_mode,
            "policy_revision": self.context_dispatch_policy_revision,
        }


class ExecutionContextReceipt(Base, UUIDMixin):
    """Append-only snapshot of one prepared model invocation: the exact prompt
    bytes the caller declared and the server's manifest of the context they
    were built from."""

    __tablename__ = "execution_context_receipts"
    __table_args__ = (
        UniqueConstraint(
            "execution_id", "client_request_id",
            name="uq_execution_context_receipts_request",
        ),
        UniqueConstraint(
            "execution_id", "ordinal", name="uq_execution_context_receipts_ordinal"
        ),
    )

    execution_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_executions.id", ondelete="CASCADE")
    )
    ordinal: Mapped[int] = mapped_column(Integer)
    client_request_id: Mapped[str] = mapped_column(String(255))
    context_revision: Mapped[str] = mapped_column(CHAR(64))
    context_manifest: Mapped[dict] = mapped_column(JSON)
    input_prompt: Mapped[str] = mapped_column(Text)
    system_prompt: Mapped[str] = mapped_column(Text)
    prompt_sha256: Mapped[str] = mapped_column(CHAR(64))
    prompt_bytes: Mapped[int] = mapped_column(Integer)
    system_prompt_sha256: Mapped[str] = mapped_column(CHAR(64))
    system_prompt_bytes: Mapped[int] = mapped_column(Integer)
    provider: Mapped[str] = mapped_column(String(255))
    model: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(32))
    use_verification: Mapped[str] = mapped_column(String(32))
    # Context-dispatch v1 evidence; NULL on A1 receipts, never backfilled.
    # The summary is stored apart so history pages never load the detail.
    dispatch: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    dispatch_summary: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
