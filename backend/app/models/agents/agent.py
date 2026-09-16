# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, Float, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.models.base import Base, TimestampMixin, UUIDMixin


class AgentType(str, enum.Enum):
    coding = "coding"
    manager = "manager"
    reviewer = "reviewer"
    secretary = "secretary"
    improver = "improver"


class Agent(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "agents"

    name: Mapped[str] = mapped_column(String(255))
    agent_type: Mapped[AgentType] = mapped_column(Enum(AgentType))
    description: Mapped[str] = mapped_column(Text, default="")
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id")
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    is_paused: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    api_key_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("api_keys.id", ondelete="SET NULL"), nullable=True
    )
    last_key_rotated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    allowed_workspaces: Mapped[list | None] = mapped_column(JSON, nullable=True)
    allowed_actions: Mapped[list | None] = mapped_column(JSON, nullable=True)
    max_requests_per_minute: Mapped[int] = mapped_column(Integer, default=100, server_default="100")
    budget_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    health_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    health_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    health_uptime_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    health_cards_processed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    health_cards_failed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    health_current_card_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    health_last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    health_last_error_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    health_go_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    health_hostname: Mapped[str | None] = mapped_column(String(255), nullable=True)
    health_started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    health_cards_skipped: Mapped[int | None] = mapped_column(Integer, nullable=True)
    health_current_board_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    health_poll_interval: Mapped[str | None] = mapped_column(String(32), nullable=True)
    health_card_timeout: Mapped[str | None] = mapped_column(String(32), nullable=True)
    health_port: Mapped[int | None] = mapped_column(Integer, nullable=True)
    health_config_errors: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # Loop-mode attribution and state, reported per heartbeat tick. Distinct
    # from health_current_board_id (a card the agent is passing through):
    # health_loop_board_id is the board this process is BOUND to for its
    # lifetime. NULL everywhere means "never reported" — a pre-086 runner.
    health_loop_board_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    health_loop_state: Mapped[str | None] = mapped_column(String(16), nullable=True)
    health_loop_park_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    health_loop_parked_since: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )
    # Sensor catalog reported by the agent via heartbeat. Lets the platform
    # discover which sensors this build supports without hard-coding the list.
    sensor_catalog: Mapped[list | None] = mapped_column(JSON, nullable=True)
