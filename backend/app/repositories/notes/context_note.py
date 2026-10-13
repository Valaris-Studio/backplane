# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Budgeted note reads for context assembly: scalar projections only.

Neither query selects a `Note` entity, `content_text` or `findings`. Headers
never carry `content`; a body is returned only by a query that repeats the
scope predicates and its SQL UTF-8 size guard. These bound the bytes that
cross into the application, not the database's own scan/TOAST work, which
must still read a stored value to measure it.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import Integer, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.sql.functions import FunctionElement

from app.models.notes.note import Note


class utf8_octet_length(FunctionElement):  # noqa: N801 — SQL function name
    type = Integer()
    inherit_cache = True
    name = "utf8_octet_length"


@compiles(utf8_octet_length)
def _postgresql_utf8_octet_length(element, compiler, **kw):
    # convert_to measures the UTF-8 wire unit whatever the database encoding.
    return (
        f"octet_length(convert_to({compiler.process(element.clauses, **kw)}, 'UTF8'))"
    )


@compiles(utf8_octet_length, "sqlite")
def _sqlite_utf8_octet_length(element, compiler, **kw):
    # length(TEXT) counts characters; a BLOB cast counts the UTF-8 database's bytes.
    return f"length(CAST({compiler.process(element.clauses, **kw)} AS BLOB))"


@dataclass(frozen=True)
class ContextNoteScope:
    """The eligibility predicate of one note-backed source, applied in SQL
    before the window limit and repeated on every body read."""

    workspace_id: uuid.UUID
    card_id: uuid.UUID | None = None
    board_id: uuid.UUID | None = None
    workspace_level: bool = False
    kind: str | None = None
    pinned_only: bool = False
    nonempty_only: bool = False


@dataclass(frozen=True)
class ContextNoteHeader:
    id: uuid.UUID
    title: str
    kind: str
    pinned: bool
    created_at: datetime
    raw_bytes: int


@dataclass(frozen=True)
class ContextNoteBody:
    id: uuid.UUID
    title: str
    kind: str
    pinned: bool
    created_at: datetime
    updated_at: datetime
    workspace_id: uuid.UUID
    board_id: uuid.UUID | None
    card_id: uuid.UUID | None
    raw_bytes: int
    content: str


_HEADER_COLUMNS = (Note.id, Note.title, Note.kind, Note.pinned, Note.created_at)


def _scope_predicates(scope: ContextNoteScope) -> list:
    predicates = [Note.workspace_id == scope.workspace_id]
    if scope.card_id is not None:
        predicates.append(Note.card_id == scope.card_id)
    if scope.board_id is not None:
        predicates.append(Note.board_id == scope.board_id)
    if scope.workspace_level:
        predicates.append(Note.board_id.is_(None))
    if scope.kind is not None:
        predicates.append(Note.kind == scope.kind)
    if scope.pinned_only:
        predicates.append(Note.pinned.is_(True))
    if scope.nonempty_only:
        predicates.append(utf8_octet_length(Note.content) > 0)
    return predicates


def _window_order(scope: ContextNoteScope) -> list:
    # The legacy selectors' orders: kind-filtered lists ignore pinning.
    if scope.kind is not None:
        return [Note.created_at.desc(), Note.id.asc()]
    return [Note.pinned.desc(), Note.created_at.desc(), Note.id.asc()]


class ContextNoteRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def list_headers(
        self, scope: ContextNoteScope, *, limit: int
    ) -> tuple[list[ContextNoteHeader], bool]:
        """At most `limit` eligible headers plus whether a further eligible
        row exists; that sentinel row is read as metadata and discarded."""
        result = await self.db.execute(
            select(*_HEADER_COLUMNS, utf8_octet_length(Note.content).label("raw_bytes"))
            .where(*_scope_predicates(scope))
            .order_by(*_window_order(scope))
            .limit(limit + 1)
        )
        rows = result.all()
        headers = [ContextNoteHeader(*row) for row in rows[:limit]]
        return headers, len(rows) > limit

    async def get_guarded_body(
        self, note_id: uuid.UUID, scope: ContextNoteScope, *, max_bytes: int
    ) -> ContextNoteBody | None:
        """None when the note left the scope, was deleted or now exceeds
        `max_bytes`: the guard is evaluated on the row actually read."""
        raw_bytes = utf8_octet_length(Note.content)
        result = await self.db.execute(
            select(
                *_HEADER_COLUMNS,
                Note.updated_at,
                Note.workspace_id,
                Note.board_id,
                Note.card_id,
                raw_bytes.label("raw_bytes"),
                Note.content,
            ).where(
                Note.id == note_id, *_scope_predicates(scope), raw_bytes <= max_bytes
            )
        )
        row = result.one_or_none()
        return None if row is None else ContextNoteBody(*row)
