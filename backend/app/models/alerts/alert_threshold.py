# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import enum
import uuid

from sqlalchemy import Boolean, Enum, Float, ForeignKey, Index, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class AlertMetric(str, enum.Enum):
    health_score = "health_score"
    stale_card_count = "stale_card_count"
    overdue_card_count = "overdue_card_count"
    agent_efficiency = "agent_efficiency"
    reversion_rate = "reversion_rate"
    handoff_friction = "handoff_friction"
    cost_usd_7d = "cost_usd_7d"
    cost_usd_30d = "cost_usd_30d"


class AlertOperator(str, enum.Enum):
    gt = "gt"
    gte = "gte"
    lt = "lt"
    lte = "lte"
    eq = "eq"


class AlertThreshold(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "alert_thresholds"
    __table_args__ = (
        Index("ix_alert_thresholds_workspace", "workspace_id"),
        Index("ix_alert_thresholds_board", "board_id"),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    board_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="CASCADE"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(255))
    metric: Mapped[AlertMetric] = mapped_column(Enum(AlertMetric))
    operator: Mapped[AlertOperator] = mapped_column(Enum(AlertOperator))
    value: Mapped[float] = mapped_column(Float)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id")
    )
