# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UUIDMixin


class ApiKey(Base, UUIDMixin):
    __tablename__ = "api_keys"
    # One live key per installation: a rotation racing another one fails here
    # rather than leaving two keys behind.
    __table_args__ = (
        Index(
            "ix_api_keys_installation_id",
            "installation_id",
            unique=True,
            postgresql_where=text("installation_id IS NOT NULL"),
            sqlite_where=text("installation_id IS NOT NULL"),
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(255))
    key_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    key_prefix: Mapped[str] = mapped_column(String(12))
    # Set on the key a companion minted for the agents it launches. Revoking
    # the installation soft-deletes it, so the revoke paths delete these keys
    # explicitly; the CASCADE only covers hard deletes.
    installation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("companion_installations.id", ondelete="CASCADE"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    # NULL means "never used". Stamped by ApiKeyService.touch on the
    # authenticating session, throttled — never a write per authenticated request.
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
