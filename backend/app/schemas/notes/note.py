# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import uuid
from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import field_validator
from app.core.json_response import UTCModel

from app.models.notes.failure_class import REVIEW_FAILURE_CLASS_VALUES
from app.models.notes.finding import FindingSeverity
from app.schemas.bounded import Str500
from app.services.notes.content_normalizer import (
    InvalidContentError,
    normalize_note_content,
)


class Finding(UTCModel):
    """One reviewer finding. Severity drives the done-gate; file/function are
    optional because not every finding is line-anchored (e.g., a missing test
    file, an architectural critique)."""

    severity: FindingSeverity
    message: str
    file: str | None = None
    function: str | None = None

    model_config = {"use_enum_values": True}


def _validate_failure_class(value: Any) -> str | None:
    """Allow None or one of the five ReviewFailureClass values. Reject anything
    else so a typo at the wire boundary doesn't poison the advisor's routing."""
    if value is None:
        return None
    if isinstance(value, str) and value in REVIEW_FAILURE_CLASS_VALUES:
        return value
    raise ValueError(
        f"failure_class must be one of {sorted(REVIEW_FAILURE_CLASS_VALUES)} or null"
    )


def _coerce_content(value: Any) -> str:
    """Normalize any accepted content shape to canonical PM JSON.

    The DB stores a string; the wire accepts str | dict (PM doc). Pydantic
    runs this validator before the service layer sees the value, so every
    code path downstream can assume canonical JSON.
    """
    try:
        return normalize_note_content(value)
    except InvalidContentError as exc:
        raise ValueError(str(exc)) from exc


class NoteCreate(UTCModel):
    title: Str500
    content: Any = ""
    pinned: bool = False
    board_id: uuid.UUID | None = None
    card_id: uuid.UUID | None = None
    kind: str = "user_note"
    failure_class: str | None = None
    findings: list[Finding] | None = None
    # Set by machine note-creation paths (review verdict, system note) to the
    # execution that produced the note, so the UI can link the note → its
    # source execution. Omitted/NULL for human notes.
    source_execution_id: uuid.UUID | None = None

    @field_validator("content", mode="before")
    @classmethod
    def _normalize(cls, v: Any) -> str:
        return _coerce_content(v)

    @field_validator("failure_class", mode="before")
    @classmethod
    def _check_failure_class(cls, v: Any) -> str | None:
        return _validate_failure_class(v)


class NoteUpdate(UTCModel):
    title: Str500 | None = None
    content: Any = None
    pinned: bool | None = None
    card_id: uuid.UUID | None = None

    @field_validator("content", mode="before")
    @classmethod
    def _normalize(cls, v: Any) -> str | None:
        if v is None:
            return None
        return _coerce_content(v)


class NoteAppend(UTCModel):
    """Body for a surgical append: new blocks only, never the whole document.

    Unlike `NoteUpdate.content`, this field is required and must carry at least
    one block. An append that normalizes to an empty doc means the caller lost
    its payload — surfacing that as 422 beats a silent no-op the operator would
    have to notice by diffing the note.
    """

    content: Any

    @field_validator("content", mode="before")
    @classmethod
    def _normalize(cls, v: Any) -> str:
        # Whitespace-only strings normalize to a paragraph holding blanks, which
        # would append an invisible empty block; strip first so they land in the
        # same rejected bucket as "".
        normalized = _coerce_content(v.strip() if isinstance(v, str) else v)
        if not json.loads(normalized).get("content"):
            raise ValueError("content must contain at least one block to append")
        return normalized


class NoteSectionReplace(UTCModel):
    """Body for a surgical section replace: the anchor to find, the body to put
    under it.

    Unlike `NoteAppend`, empty content is ACCEPTED — "this section has nothing in
    it yet" is a legitimate intent for a tracker, and unlike an append it cannot
    silently lose a payload (the caller named the section it meant to clear).
    A blank anchor is rejected: it identifies nothing, and reading it as "the
    whole document" would turn a surgical tool into a full-body overwrite.
    """

    anchor_heading: str
    content: Any = ""

    @field_validator("anchor_heading", mode="before")
    @classmethod
    def _require_anchor(cls, v: Any) -> str:
        if not isinstance(v, str) or not v.strip():
            raise ValueError("anchor_heading must name a non-empty heading")
        return v

    @field_validator("content", mode="before")
    @classmethod
    def _normalize(cls, v: Any) -> str:
        return _coerce_content(v.strip() if isinstance(v, str) else v)


class NoteFormat(str, Enum):
    """Wire format for a single note read. `prosemirror` (default) returns the
    stored canonical PM JSON; `markdown` serializes it back to CommonMark."""

    prosemirror = "prosemirror"
    markdown = "markdown"


class NoteRead(UTCModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    board_id: uuid.UUID | None
    card_id: uuid.UUID | None
    title: str
    # PM JSON string by default; the markdown string when ?format=markdown.
    content: str
    pinned: bool
    kind: str
    failure_class: str | None = None
    findings: list[Finding] | None = None
    source_execution_id: uuid.UUID | None = None
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class NoteSummary(UTCModel):
    """List-view note WITHOUT the heavy `content` field.

    Returned by the list endpoints when `?summary_only=true` — cures a real
    72KB-for-4-notes payload overflow where a board view only needs titles and
    metadata, not every note's full PM document.

    `preview` gives the list back the one thing dropping `content` cost it: a
    glance at what the note says. It is the same text server-side search
    matches (see services.notes.content_text), so a search hit always shows
    the operator something recognizable.
    """

    id: uuid.UUID
    workspace_id: uuid.UUID
    board_id: uuid.UUID | None
    card_id: uuid.UUID | None
    title: str
    preview: str = ""
    pinned: bool
    kind: str
    failure_class: str | None = None
    source_execution_id: uuid.UUID | None = None
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}

    @classmethod
    def from_note(cls, note) -> "NoteSummary":
        """Build a summary, computing `preview` from the maintained
        `content_text` column and falling back to on-the-fly extraction when
        it is NULL (a row an old replica wrote during a rolling deploy)."""
        from app.services.notes.content_text import build_preview

        summary = cls.model_validate(note)
        return summary.model_copy(
            update={
                "preview": build_preview(
                    note.content, getattr(note, "content_text", None)
                )
            }
        )


class CardVerdictRead(UTCModel):
    decision: str
    note_id: uuid.UUID
    created_at: datetime
    failure_class: str | None = None
    findings: list[Finding] | None = None
    # Derived from (findings, tests_pass) when findings are present; falls back
    # to the legacy decision string ('approve' → True) when findings is NULL.
    # See app.services.notes.note.derive_approved for the predicate.
    approved: bool
