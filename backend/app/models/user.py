# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from datetime import datetime

from sqlalchemy import DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class User(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    avatar_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # NULL = no local credential (OIDC/IAP-provisioned users) — must never verify.
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Brute-force lockout state — authoritative in the DB, not the in-process
    # rate limiter, so it holds across replicas and restarts (plan L7).
    failed_login_attempts: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0"
    )
    locked_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
