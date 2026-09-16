# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import enum
import uuid

from sqlalchemy import Boolean, Enum, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class GitProvider(str, enum.Enum):
    github = "github"
    gitlab = "gitlab"
    bitbucket = "bitbucket"
    gitea = "gitea"
    other = "other"


class GitRepo(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "git_repos"
    __table_args__ = (
        UniqueConstraint("board_id", "slug", name="uq_git_repos_board_slug"),
    )

    board_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="CASCADE"), index=True
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(String(255))
    # Nullable for rolling deploys; backfilled by migration and always set by service.
    slug: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    url: Mapped[str] = mapped_column(String(1024))
    provider: Mapped[GitProvider] = mapped_column(Enum(GitProvider))
    default_branch: Mapped[str] = mapped_column(String(255), default="main")
    # PAR-1: optional staging branch parallel runners base new work on. NULL
    # means "use default_branch" — preserves pre-PAR-1 behavior bit-for-bit.
    integration_branch: Mapped[str | None] = mapped_column(
        String(255), nullable=True
    )
    description: Mapped[str] = mapped_column(Text, default="")
    added_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id")
    )
    # Policy flag read by runner at clone time; runner applies provider-neutral
    # EnsureBranchProtection against default_branch. Default True so auto-merge
    # has something to arm against; operators opt out on legacy/human-owned repos.
    require_branch_protection: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="true", default=True
    )
    # Sprint 1 of integrations layer: opt-in OAuth path. NULL means
    # "use the legacy GITHUB_TOKEN env-var path in app/services/github_client.py".
    # Existing repos stay on the legacy path; only new repos created against an
    # OAuth account get a connection_id.
    connection_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("git_connections.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
