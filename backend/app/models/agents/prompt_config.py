# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import Boolean, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class AgentPromptConfig(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "agent_prompt_configs"
    # Slug portability: a slug identifies a prompt within its scope. Config
    # export/import relies on (scope, slug) being stable, so duplicates within
    # the same scope would make re-import ambiguous. NULL workspace_id/team_id
    # are treated as distinct by PostgreSQL (default) and SQLite — the app
    # layer (seed_defaults) already guards against double-seeding system
    # defaults where both are NULL.
    __table_args__ = (
        UniqueConstraint(
            "workspace_id", "team_id", "team_role", "stage", "slug",
            name="uq_agent_prompt_configs_scope_slug",
        ),
    )

    name: Mapped[str] = mapped_column(String(255))
    slug: Mapped[str] = mapped_column(String(255), index=True)
    # String(20) instead of Enum for SQLite test compatibility
    agent_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    team_role: Mapped[str | None] = mapped_column(String(64), nullable=True)
    stage: Mapped[str] = mapped_column(String(100))
    content: Mapped[str] = mapped_column(Text)
    is_system: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    workspace_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=True
    )
    team_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_teams.id", ondelete="SET NULL"), nullable=True
    )
    version: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id")
    )
