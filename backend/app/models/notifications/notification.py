# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin
from app.utils import utcnow


class Notification(Base, UUIDMixin, TimestampMixin):
    """Durable per-recipient notification row (INV-1: written in-txn with its
    triggering event; the event_bus only live-pushes it). See
    docs/notification-system-contract.md §"Table notifications"."""

    __tablename__ = "notifications"
    __table_args__ = (
        Index(
            "ix_notifications_recipient_created",
            "recipient_user_id",
            "created_at",
        ),
        Index(
            "ix_notifications_recipient_workspace_unread",
            "recipient_user_id",
            "workspace_id",
            "read_at",
        ),
        # INV-6 backstop: dedupe is per recipient, so the same fanned-out event
        # yields one row per recipient but never two for the same recipient.
        UniqueConstraint(
            "recipient_user_id",
            "dedupe_key",
            name="uq_notifications_recipient_dedupe",
        ),
    )

    recipient_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        index=True,
    )
    # SET NULL (not CASCADE): a deleted board orphans the deep-link context but
    # the notification itself stays in the recipient's history.
    board_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("boards.id", ondelete="SET NULL"),
        nullable=True,
    )
    category: Mapped[str] = mapped_column(String(48), index=True)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=True,
    )
    is_agent_actor: Mapped[bool] = mapped_column(
        Boolean, server_default="false", default=False
    )
    entity_type: Mapped[str] = mapped_column(String(32))
    entity_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    link: Mapped[dict | None] = mapped_column(JSON, nullable=True, default=None)
    read_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True, default=None
    )
    dedupe_key: Mapped[str] = mapped_column(String(255))

    # Override TimestampMixin's server-only default with a Python `default` too:
    # SQLite's func.now() is whole-second resolution, so rows created in the same
    # second tie and the keyset `created_at < before` cursor can't strictly
    # exclude the cursor row. utcnow() (naive UTC, house style for our TIMESTAMP
    # WITHOUT TIME ZONE columns) gives each insert a distinct microsecond stamp;
    # Postgres still uses func.now() (microsecond) via server_default.
    created_at: Mapped[datetime] = mapped_column(
        default=utcnow, server_default=func.now()
    )
