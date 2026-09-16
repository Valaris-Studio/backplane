# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import JSON, Boolean, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class NotificationPreference(Base, UUIDMixin, TimestampMixin):
    """One row per (user, workspace) — a user can be loud in one workspace,
    quiet in another. A missing row means "all defaults"; the effective-prefs
    resolver (muted -> override -> category default by relevance_scope) is the
    Phase-2 service's job, not this model's. See
    docs/notification-system-contract.md §"Table notification_preferences"."""

    __tablename__ = "notification_preferences"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "workspace_id", name="uq_notif_prefs_user_workspace"
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        index=True,
    )
    relevance_scope: Mapped[str] = mapped_column(
        String(16), server_default="watching", default="watching"
    )
    category_overrides: Mapped[dict] = mapped_column(JSON, default=dict)
    muted: Mapped[bool] = mapped_column(Boolean, server_default="false", default=False)
