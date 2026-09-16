# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import Enum, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from app.models.base import Base, UUIDMixin

# `cards_affected` is queried with card-id containment on every card-detail open
# (ExecutionRepository.list_by_card). On Postgres that runs as the `@>` operator
# served by a GIN index (migration 075) — JSONB is required for both. SQLite (the
# test backend) has no JSONB, so this variant keeps plain-JSON behavior there and
# the repo falls back to a portable text-cast prefilter.
CardsAffectedJSON = JSON().with_variant(JSONB, "postgresql")

if TYPE_CHECKING:
    from app.models.agents.tool_invocation import ToolInvocation


class ExecutionStatus(str, enum.Enum):
    started = "started"
    running = "running"
    completed = "completed"
    failed = "failed"
    aborted = "aborted"
    # Terminal graceful-skip: the tick ran but no LLM work was done because
    # the user hasn't authored a prompt for this pipeline stage yet. Used by
    # runner's runLLMStage when the prompt cache misses and no Go fallback
    # exists for the stage. Frontend surfaces these as "this stage needs a
    # prompt" prompts so the user can author one.
    skipped = "skipped"


class AgentExecution(Base, UUIDMixin):
    __tablename__ = "agent_executions"

    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agents.id", ondelete="CASCADE"), index=True
    )
    session_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    board_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="SET NULL"), nullable=True
    )

    action: Mapped[str] = mapped_column(String(255))
    status: Mapped[ExecutionStatus] = mapped_column(
        Enum(ExecutionStatus), default=ExecutionStatus.started
    )
    started_at: Mapped[datetime] = mapped_column(server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(nullable=True)

    input_summary: Mapped[str] = mapped_column(Text, default="")
    output_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    tools_used: Mapped[list | None] = mapped_column(JSON, nullable=True)
    cards_affected: Mapped[list | None] = mapped_column(
        CardsAffectedJSON, nullable=True
    )
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    tool_calls_count: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0"
    )
    tokens_used: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Non-fatal issues captured during the stage (e.g. auto-merge arming
    # failed because branch protection isn't configured). Backend-authoritative
    # surface: runners report warnings here so the UI can flag them on the
    # execution entry. NULL = never reported (old code or no issues).
    ship_warnings: Mapped[list | None] = mapped_column(JSON, nullable=True)

    # Skills Registry W3: the skills manifest the runner actually materialized
    # for this stage (list of {slug,name,description,version,content_hash}).
    # NULL = never reported (old runner / no skills), the ship_warnings
    # precedent. Plain JSON — never queried by containment.
    skills: Mapped[list | None] = mapped_column(JSON, nullable=True)

    role: Mapped[str | None] = mapped_column(String(64), nullable=True)
    input_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Wave 2 / CRIT-2 (per-role provider/model): runner stamps the prompt slug
    # it rendered AND the LLM model it executed on. NULL = pre-rollout runner
    # never reported these (frontend renders em-dash placeholder).
    #
    # provider/model are the RESOLVED coding agent — what actually ran after the
    # runner applied its tier_providers remap, NOT the backend's suggestion. The
    # backend resolves a tier to a hint (e.g. premium→claude-cli/opus) but a host
    # may run codex-cli/gpt-5.5 locally; these columns record the truth so the
    # activity feed doesn't show the suggestion. NULL provider = pre-rollout runner.
    prompt_slug: Mapped[str | None] = mapped_column(String(255), nullable=True)
    model: Mapped[str | None] = mapped_column(String(100), nullable=True)
    provider: Mapped[str | None] = mapped_column(String(50), nullable=True)

    parent_execution_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_executions.id", ondelete="SET NULL"),
        nullable=True,
    )
    prompt_config_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_prompt_configs.id", ondelete="SET NULL"),
        nullable=True,
    )

    tool_invocations: Mapped[list[ToolInvocation]] = relationship(
        "ToolInvocation", cascade="all, delete-orphan", lazy="raise"
    )
