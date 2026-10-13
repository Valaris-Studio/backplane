# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UUIDMixin

PAIRING_STATES = ("pending", "approved", "denied", "consumed", "expired")


class CompanionPairing(Base, UUIDMixin):
    """A browser-code (RFC 8628) request to connect a device.

    Neither code is stored: only SHA-256 hashes, so a database read can neither
    approve a device nor collect its token. Approval records only who approved;
    the installation and its token are created when the device collects them.
    """

    __tablename__ = "companion_pairings"
    __table_args__ = (
        CheckConstraint(
            "state IN ('pending', 'approved', 'denied', 'consumed', 'expired')",
            name="ck_companion_pairing_state",
        ),
    )

    device_code_hash: Mapped[str] = mapped_column(String(64), unique=True)
    user_code_hash: Mapped[str] = mapped_column(String(64), unique=True)
    requested_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    platform: Mapped[str] = mapped_column(String(32))
    arch: Mapped[str] = mapped_column(String(32))
    companion_version: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(
        String(16), default="pending", server_default="pending"
    )
    approved_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    approved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Set when the device collects its token: the installation is created then,
    # so an approval nobody collects leaves no installation behind.
    installation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("companion_installations.id", ondelete="SET NULL"),
        nullable=True,
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_polled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class CompanionPairingLookupFailure(Base, UUIDMixin):
    """One user_code a signed-in user tried that matched nothing they may see;
    the per-user guessing cap counts these (DB-backed, so it holds across
    replicas and restarts)."""

    __tablename__ = "companion_pairing_lookup_failures"
    __table_args__ = (
        Index("ix_companion_pairing_failures_user_time", "user_id", "created_at"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
