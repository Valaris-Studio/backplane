# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import Boolean, Float, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSON, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class WorkspaceConfig(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "workspace_configs"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        unique=True,
        index=True,
    )
    max_rework_attempts: Mapped[int] = mapped_column(Integer, default=3)
    card_cooldown_hours: Mapped[float] = mapped_column(Float, default=1.0)
    commit_message_template: Mapped[str] = mapped_column(
        String(500), default="feat({{.CardID}}): {{.Title}}"
    )
    pr_description_template: Mapped[str] = mapped_column(Text, default="")
    model_pricing: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    pipeline_config: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # NULL = circuit breaker disabled. When populated, expected shape:
    # {"enabled": bool, "threshold_usd_per_15min": float, "action": "alert"|"pause"|"kill_runner"}
    cost_circuit_breaker: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Role display registry (card 86ca1421 Phase A). NULL = platform defaults.
    # Shape: {"<role>": {"display_name": str, "color": "#hex"}}. Per
    # feedback_extensibility_no_limits.md, there is no allow-list — any role
    # string is acceptable, including ones not present in pipeline_config.
    role_labels: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # PAR-3a: per-workspace conflict-consolidator settings consumed by PAR-3c
    # when a merge fails. Shape (validated at use-time, not at the DB layer):
    # {"enabled": bool, "board_id": uuid, "column_id": uuid, "label": str}.
    conflict_consolidator: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Card dad09e90: agent moves into a Done-typed column require a merged PR.
    # True = enforce (historical default). False = trust the move; skip GitHub.
    # The opt-out exists for workspaces where the gate's GitHub dependency is
    # the wrong tradeoff (e.g. self-hosted git provider not wired to the gate).
    enforce_done_merge_gate: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    completion_policy: Mapped[dict | None] = mapped_column(JSON(none_as_null=True), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
