# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, JSON, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDMixin


class AgentTeam(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "agent_teams"
    __table_args__ = (
        UniqueConstraint("workspace_id", "slug", name="uq_agent_teams_workspace_slug"),
    )

    name: Mapped[str] = mapped_column(String(255))
    slug: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    board_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id")
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")

    members: Mapped[list["AgentTeamMember"]] = relationship(
        "AgentTeamMember", lazy="selectin", cascade="all, delete-orphan"
    )


class AgentTeamMember(Base):
    __tablename__ = "agent_team_members"

    team_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_teams.id", ondelete="CASCADE"), primary_key=True
    )
    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agents.id", ondelete="CASCADE"), primary_key=True
    )
    roles: Mapped[list] = mapped_column(JSON, default=list)
    added_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
