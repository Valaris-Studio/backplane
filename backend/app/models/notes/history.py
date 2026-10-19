# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import (
    CHAR,
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    LargeBinary,
    SmallInteger,
    String,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class NoteRevision(Base):
    __tablename__ = "note_revisions"
    __table_args__ = (
        CheckConstraint("revision > 0", name="ck_note_revisions_sequence"),
        CheckConstraint("content_bytes >= 0", name="ck_note_revisions_content_bytes"),
        CheckConstraint("chunk_count >= 0", name="ck_note_revisions_chunk_count"),
    )

    note_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True
    )
    revision: Mapped[int] = mapped_column(Integer, primary_key=True)
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    capture_kind: Mapped[str] = mapped_column(String(32))
    operation: Mapped[str] = mapped_column(String(32))
    changed_fields: Mapped[list[str]] = mapped_column(JSON)
    content_bytes: Mapped[int] = mapped_column(BigInteger)
    content_sha256: Mapped[str] = mapped_column(CHAR(64))
    revision_digest: Mapped[str] = mapped_column(CHAR(64))
    storage_version: Mapped[int] = mapped_column(SmallInteger, default=1, server_default="1")
    chunk_count: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(500))
    pinned: Mapped[bool] = mapped_column(Boolean)
    # Historical identities survive live card/execution detachment unchanged.
    card_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    kind: Mapped[str] = mapped_column(String(32))
    source_execution_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    failure_class: Mapped[str | None] = mapped_column(String(32), nullable=True)
    findings: Mapped[list | None] = mapped_column(JSON, nullable=True, deferred=True)
    actor: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Outcomes arrive after writes and can be absent. This is correlation, not a FK
    # or evidence that a particular client/model performed the mutation.
    invocation_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)


class NoteRevisionChunk(Base):
    __tablename__ = "note_revision_chunks"
    __table_args__ = (
        CheckConstraint(
            "content_bytes > 0 AND content_bytes <= 16384",
            name="ck_note_revision_chunks_size",
        ),
    )

    note_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True
    )
    sha256: Mapped[str] = mapped_column(CHAR(64), primary_key=True)
    content_bytes: Mapped[int] = mapped_column(Integer)
    payload: Mapped[bytes] = mapped_column(LargeBinary)


class NoteRevisionManifest(Base):
    __tablename__ = "note_revision_manifest"
    __table_args__ = (
        ForeignKeyConstraint(
            ["note_id", "revision"],
            ["note_revisions.note_id", "note_revisions.revision"],
            ondelete="CASCADE",
            name="fk_note_revision_manifest_revision",
        ),
        ForeignKeyConstraint(
            ["note_id", "sha256"],
            ["note_revision_chunks.note_id", "note_revision_chunks.sha256"],
            ondelete="CASCADE",
            name="fk_note_revision_manifest_chunk",
        ),
        CheckConstraint("position >= 0", name="ck_note_revision_manifest_position"),
        Index("ix_note_revision_manifest_note_chunk", "note_id", "sha256"),
    )

    note_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, primary_key=True)
    position: Mapped[int] = mapped_column(Integer, primary_key=True)
    sha256: Mapped[str] = mapped_column(CHAR(64))


class NoteMutationReceipt(Base):
    __tablename__ = "note_mutation_receipts"
    __table_args__ = (
        ForeignKeyConstraint(
            ["note_id", "applied_revision"],
            ["note_revisions.note_id", "note_revisions.revision"],
            ondelete="CASCADE",
            name="fk_note_mutation_receipts_revision",
        ),
    )

    note_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True
    )
    principal_key: Mapped[str] = mapped_column(String(256), primary_key=True)
    client_request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    fingerprint: Mapped[str] = mapped_column(CHAR(64))
    applied_revision: Mapped[int | None] = mapped_column(Integer, nullable=True)
    changed: Mapped[bool] = mapped_column(Boolean)
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
