# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import enum
import uuid
from datetime import datetime

from sqlalchemy import Enum, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDMixin


class WorkspaceRole(str, enum.Enum):
    owner = "owner"
    admin = "admin"
    member = "member"
    viewer = "viewer"


class Workspace(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "workspaces"

    name: Mapped[str] = mapped_column(String(255))
    slug: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))

    creator: Mapped["User"] = relationship("User", foreign_keys=[created_by], lazy="raise")  # noqa: F821
    members: Mapped[list["WorkspaceMember"]] = relationship(back_populates="workspace", cascade="all, delete-orphan", lazy="raise")


class WorkspaceMember(Base):
    __tablename__ = "workspace_members"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[WorkspaceRole] = mapped_column(Enum(WorkspaceRole), default=WorkspaceRole.member)
    joined_at: Mapped[datetime] = mapped_column(server_default=func.now())

    workspace: Mapped["Workspace"] = relationship(back_populates="members", lazy="raise")
    user: Mapped["User"] = relationship("User", lazy="raise")  # noqa: F821
