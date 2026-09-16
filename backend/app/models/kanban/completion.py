# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, JSON, String, Text, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class CompletionCandidate(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "completion_candidates"
    __table_args__ = (
        Index(
            "uq_completion_current_card",
            "card_id",
            unique=True,
            postgresql_where=text("is_current = true"),
            sqlite_where=text("is_current = 1"),
        ),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    board_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="CASCADE"), index=True
    )
    card_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cards.id", ondelete="CASCADE"), index=True
    )
    is_current: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default="true"
    )
    completion_mode: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(32), index=True)
    source_execution_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_executions.id")
    )
    source_agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agents.id")
    )
    submitted_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id")
    )
    repo_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("git_repos.id", ondelete="SET NULL"), nullable=True
    )
    repo_url: Mapped[str] = mapped_column(String(1000))
    source_sha: Mapped[str] = mapped_column(String(64))
    merge_sha: Mapped[str | None] = mapped_column(String(64), nullable=True)
    pr_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    branch: Mapped[str | None] = mapped_column(String(255), nullable=True)
    target_branch: Mapped[str | None] = mapped_column(String(255), nullable=True)
    card_hash: Mapped[str] = mapped_column(String(64))
    policy_hash: Mapped[str] = mapped_column(String(64))
    contract_hash: Mapped[str] = mapped_column(String(64))
    fingerprint: Mapped[str] = mapped_column(String(64))
    policy: Mapped[dict] = mapped_column(JSON)
    artifacts: Mapped[list] = mapped_column(JSON, default=list)
    checks: Mapped[list] = mapped_column(JSON, default=list)
    review_passed: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    failed_kind: Mapped[str | None] = mapped_column(String(32), nullable=True)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class CompletionAttempt(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "completion_attempts"
    __table_args__ = (
        Index(
            "uq_completion_claimed_candidate",
            "candidate_id",
            unique=True,
            postgresql_where=text("status = 'claimed'"),
            sqlite_where=text("status = 'claimed'"),
        ),
    )

    candidate_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("completion_candidates.id", ondelete="CASCADE"),
        index=True,
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    board_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="CASCADE"), index=True
    )
    execution_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_executions.id"), unique=True
    )
    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agents.id")
    )
    kind: Mapped[str] = mapped_column(String(32))
    role: Mapped[str] = mapped_column(String(64))
    provider: Mapped[str] = mapped_column(String(50))
    model: Mapped[str] = mapped_column(String(100))
    source_sha: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(
        String(32), default="claimed", server_default="claimed"
    )
    context_manifest: Mapped[list | None] = mapped_column(JSON, nullable=True)
    context_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    lease_hash: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    result_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
