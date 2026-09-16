# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, JSON, String, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDMixin


class Board(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "boards"
    __table_args__ = (
        UniqueConstraint("workspace_id", "slug", name="uq_boards_workspace_slug"),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(255))
    # Nullable in schema for rolling-deploy safety; app always writes it.
    slug: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    tags: Mapped[list | None] = mapped_column(JSON, nullable=True, server_default=text("'[]'"))
    # NOT NULL: a NULL here would three-valued-logic pre-migration rows out of
    # the scheduler's `is_frozen IS false` filter (looks like a total outage).
    is_frozen: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )
    frozen_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    frozen_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # Loop-mode config; NULL = never configured (GET /loop 404s by contract).
    # No mutable tracking — always assign a whole new dict on write.
    loop_config: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Tri-state done-merge-gate override. NULL = inherit the workspace flag
    # (the default for every pre-existing board); true/false override it for
    # this board only. Deliberately NULLABLE — unlike is_frozen, three-valued
    # logic IS the feature here, and the gate reads it as a scalar, never as a
    # filter predicate.
    enforce_done_merge_gate: Mapped[bool | None] = mapped_column(
        Boolean, nullable=True
    )

    completion_policy: Mapped[dict | None] = mapped_column(JSON(none_as_null=True), nullable=True)

    @property
    def loop_configured(self) -> bool:
        return self.loop_config is not None

    columns: Mapped[list["Column"]] = relationship(  # noqa: F821
        back_populates="board", cascade="all, delete-orphan", order_by="Column.position", lazy="raise"
    )
    creator: Mapped["User"] = relationship("User", foreign_keys=[created_by], lazy="raise")  # noqa: F821
