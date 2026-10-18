# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import CHAR, DateTime, ForeignKey, SmallInteger, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UUIDMixin


class NoteSaveReceipt(Base, UUIDMixin):
    """One person's retryable note save, keyed by the client's request id.

    Written in the same transaction as the note it names, so a committed
    receipt always had a note: `note_id` NULL afterwards is the tombstone a
    deleted note leaves, and a retry answers 410 instead of saving again."""

    __tablename__ = "note_save_receipts"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "client_request_id", name="uq_note_save_receipts_request"
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE")
    )
    client_request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        index=True,
    )
    board_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="CASCADE")
    )
    card_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cards.id", ondelete="SET NULL"), nullable=True
    )
    # sha256 of the canonical request: destination, title, document, source.
    fingerprint: Mapped[str] = mapped_column(CHAR(64))
    note_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("notes.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # The note as saved, digested by the versioned note_revision algorithm and
    # never rewritten by a replay. Both NULL on receipts from before migration
    # 123, and on any a 122 replica writes during the rollout.
    published_note_revision_sha256: Mapped[str | None] = mapped_column(
        CHAR(64), nullable=True
    )
    published_note_revision_version: Mapped[int | None] = mapped_column(
        SmallInteger, nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
