# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import JSON, Boolean, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class Note(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "notes"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    board_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="CASCADE"), nullable=True, index=True
    )
    card_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cards.id", ondelete="SET NULL"), nullable=True, index=True
    )
    title: Mapped[str] = mapped_column(String(500))
    content: Mapped[str] = mapped_column(Text, default="")
    # Plain-text projection of `content`, maintained by NoteService on every
    # write. Search ILIKEs this instead of `content` — the raw column is
    # ProseMirror JSON, so a LIKE over it matches node names ("paragraph",
    # "heading") on every note. Also serves the list preview without parsing
    # each document per row. NULLABLE: rows written by pre-migration-099 code
    # during a rolling deploy have no value yet, and readers fall back to
    # extracting from `content` (see services.notes.content_text.build_preview).
    content_text: Mapped[str | None] = mapped_column(Text, nullable=True, default=None)
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    # See app.models.notes.kinds — kept as a free String (not Enum) so the set
    # of kinds is operator-extensible without a schema change.
    kind: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default="user_note", default="user_note"
    )
    # Reviewer-only field. NULL on every other kind and on approving verdicts.
    # See app.models.notes.failure_class.ReviewFailureClass for the closed set
    # of values; the column is a plain string so old code (pre SWE-AF #5) keeps
    # working — NULL just means "no classification recorded".
    failure_class: Mapped[str | None] = mapped_column(
        String(32), nullable=True, default=None
    )
    # Reviewer-only field (SWE-AF #3). Structured severity-tiered findings.
    # Shape: list[{severity, message, file?, function?}] where severity is one
    # of BLOCKING / SHOULD_FIX / SUGGESTION (see app.models.notes.finding).
    # NULL on every other kind and on legacy verdicts pre SWE-AF #3 — the
    # derivation helper (services.notes.note.derive_approved) treats NULL as
    # "no structured findings, fall back to the legacy decision string".
    findings: Mapped[list | None] = mapped_column(JSON, nullable=True, default=None)
    # The execution that produced this note, for machine-generated notes
    # (review verdicts, system notes). Lets the UI link a note to its source
    # execution (the "link the mentioned element" rule). NULL for human notes
    # and pre-rollout rows. ondelete=SET NULL so reaping an execution doesn't
    # delete the verdict it wrote.
    source_execution_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_executions.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id")
    )
