# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UUIDMixin


class TimelineGeneration(Base, UUIDMixin):
    __tablename__ = "timeline_generations"
    __table_args__ = (
        UniqueConstraint(
            "board_id", "request_id", name="uq_timeline_generation_request"
        ),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    board_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="CASCADE"), index=True
    )
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    first_seq: Mapped[int | None] = mapped_column(BigInteger)
    head_seq: Mapped[int | None] = mapped_column(BigInteger)
    event_count: Mapped[int] = mapped_column(BigInteger)
    first_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    source_snapshot: Mapped[str] = mapped_column(Text)
    actor_labels: Mapped[dict] = mapped_column(JSON, default=dict)
    observed_state: Mapped[dict] = mapped_column(JSON, deferred=True)
    known_empty_genesis: Mapped[bool] = mapped_column(Boolean, default=False)
    schema_version: Mapped[int] = mapped_column(Integer, default=1)
    cursor_secret: Mapped[str] = mapped_column(String(64))


class TimelineCheckpoint(Base, UUIDMixin):
    __tablename__ = "timeline_checkpoints"
    __table_args__ = (
        UniqueConstraint(
            "generation_id", "through_seq", name="uq_timeline_checkpoint_boundary"
        ),
    )

    generation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("timeline_generations.id", ondelete="CASCADE"),
        index=True,
    )
    through_seq: Mapped[int] = mapped_column(BigInteger)
    processed_events: Mapped[int] = mapped_column(BigInteger)
    state: Mapped[dict] = mapped_column(JSON)
    coverage: Mapped[dict] = mapped_column(JSON)


class TimelinePreparation(Base, UUIDMixin):
    __tablename__ = "timeline_preparations"
    __table_args__ = (
        UniqueConstraint(
            "generation_id", "target_seq", name="uq_timeline_preparation_target"
        ),
        Index("ix_timeline_preparation_status", "status", "updated_at"),
    )

    generation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("timeline_generations.id", ondelete="CASCADE"),
        index=True,
    )
    requested_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE")
    )
    agent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    target_seq: Mapped[int] = mapped_column(BigInteger)
    through_seq: Mapped[int] = mapped_column(BigInteger, default=0)
    processed_events: Mapped[int] = mapped_column(BigInteger, default=0)
    status: Mapped[str] = mapped_column(String(16), default="preparing")
    retryable: Mapped[bool] = mapped_column(Boolean, default=True)
    error: Mapped[dict | None] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
