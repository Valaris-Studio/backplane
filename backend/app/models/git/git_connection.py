# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    LargeBinary,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.models.base import Base, TimestampMixin, UUIDMixin
from app.models.git.git_repo import GitProvider


class GitConnection(Base, UUIDMixin, TimestampMixin):
    """Per-workspace OAuth connection to a git provider account.

    LAYER: integrations (provider-agnostic, OAuth, multi-provider). The legacy
    single-token GITHUB_TOKEN path lives in app/services/github_client.py and
    is still used by hot paths (Done-gate, card service); git_repos.connection_id
    is nullable so existing repos keep working unchanged.

    Tokens are stored encrypted at rest by FernetTokenVault — never read
    `encrypted_access_token` directly; go through GitConnectionService.
    """

    __tablename__ = "git_connections"
    __table_args__ = (
        UniqueConstraint(
            "workspace_id",
            "provider",
            "account_login",
            name="uq_git_connections_workspace_provider_login",
        ),
        CheckConstraint(
            "provider IN ('github','gitlab','bitbucket','gitea','other')",
            name="ck_git_connections_provider",
        ),
        CheckConstraint(
            "account_type IN ('user','organization')",
            name="ck_git_connections_account_type",
        ),
        Index(
            "ix_git_connections_workspace_provider",
            "workspace_id",
            "provider",
        ),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
    )
    provider: Mapped[GitProvider] = mapped_column(String(32), nullable=False)
    account_login: Mapped[str] = mapped_column(String(255), nullable=False)
    account_type: Mapped[str] = mapped_column(String(32), nullable=False)
    encrypted_access_token: Mapped[bytes] = mapped_column(
        LargeBinary, nullable=False
    )
    encrypted_refresh_token: Mapped[bytes | None] = mapped_column(
        LargeBinary, nullable=True
    )
    scopes: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )
    base_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # 'oauth' (the OAuth dance minted it) vs 'pat' (an operator pasted a
    # personal access token). Server default 'oauth' so rows written before this
    # column existed keep their true origin.
    auth_kind: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="oauth", default="oauth"
    )
    # Health of the credential as of the last probe against the forge. NULL
    # means never verified; last_error holds the most recent probe failure and
    # is cleared on success, so the pair reads as a single status.
    last_verified_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )
    last_error: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    # Whether the last probe substantiated the scopes the platform needs.
    # NULL is a third answer, not a default: it means no probe has ever
    # assessed this row. False covers both "the forge disclosed nothing"
    # (every GitHub fine-grained PAT) and "a required scope is missing" —
    # from the operator's side those are the same warning, that nobody has
    # proven this credential can push and merge.
    scopes_confirmed: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    connected_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
