# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from typing import Literal

from sqlalchemy import String, cast, func, or_, select

from app.models.notes.note import Note
from app.models.user import User
from app.repositories.base import BaseRepository

NoteOrderBy = Literal["updated_at", "created_at", "title", "author"]
SortDirection = Literal["asc", "desc"]


class NoteRepository(BaseRepository[Note]):
    model = Note

    async def find_by_id_prefix(
        self,
        workspace_id: uuid.UUID,
        prefix: str,
        *,
        board_id: uuid.UUID | None = None,
        limit: int = 10,
    ) -> list[Note]:
        """Notes whose UUID starts with `prefix`, scoped to a board or workspace.

        Mirrors CardRepository.find_by_id_prefix. Hyphens are stripped from BOTH
        the needle and the cast id: Postgres renders `uuid::text` hyphenated
        while SQLite stores a hyphen-less 32-hex string, and callers may pass a
        fragment either way. `board_id=None` scopes to workspace-level notes
        (board_id IS NULL), matching list_by_workspace.
        """
        needle = prefix.lower().replace("-", "")
        id_text = func.replace(cast(Note.id, String), "-", "")
        scope = (
            Note.board_id == board_id if board_id else Note.board_id.is_(None)
        )
        result = await self.db.execute(
            select(Note)
            .where(Note.workspace_id == workspace_id, scope, id_text.like(f"{needle}%"))
            .order_by(Note.created_at.desc())
            .limit(limit)
        )
        return list(result.scalars().all())

    async def count_workspace_notes(self, workspace_id: uuid.UUID) -> int:
        result = await self.db.execute(
            select(func.count()).select_from(Note).where(
                Note.workspace_id == workspace_id, Note.board_id.is_(None)
            )
        )
        return result.scalar_one()

    async def list_by_board(self, board_id: uuid.UUID) -> list[Note]:
        result = await self.db.execute(
            select(Note)
            .where(Note.board_id == board_id)
            .order_by(Note.pinned.desc(), Note.created_at.desc(), Note.id.asc())
        )
        return list(result.scalars().all())

    async def list_by_card(self, card_id: uuid.UUID, workspace_id: uuid.UUID) -> list[Note]:
        result = await self.db.execute(
            select(Note)
            .where(Note.card_id == card_id, Note.workspace_id == workspace_id)
            .order_by(Note.pinned.desc(), Note.created_at.desc(), Note.id.asc())
        )
        return list(result.scalars().all())

    async def list_by_workspace(self, workspace_id: uuid.UUID) -> list[Note]:
        result = await self.db.execute(
            select(Note)
            .where(Note.workspace_id == workspace_id, Note.board_id.is_(None))
            .order_by(Note.pinned.desc(), Note.created_at.desc(), Note.id.asc())
        )
        return list(result.scalars().all())

    async def get_titles_by_ids(
        self, note_ids: set[uuid.UUID]
    ) -> dict[uuid.UUID, str]:
        """Batch-resolve {note_id: title} for activity entity_title enrichment.

        Mirrors CardRepository.get_refs_by_ids — a scalar tuple-select, one query
        per request. Missing ids are omitted (deleted note).
        """
        if not note_ids:
            return {}
        result = await self.db.execute(
            select(Note.id, Note.title).where(Note.id.in_(note_ids))
        )
        return {row[0]: row[1] for row in result.all()}

    async def list_card_notes_by_kind(
        self, card_id: uuid.UUID, workspace_id: uuid.UUID, kind: str
    ) -> list[Note]:
        result = await self.db.execute(
            select(Note)
            .where(
                Note.card_id == card_id,
                Note.workspace_id == workspace_id,
                Note.kind == kind,
            )
            .order_by(Note.created_at.desc())
        )
        return list(result.scalars().all())

    def _list_filters(
        self,
        *,
        q: str | None = None,
        pinned_only: bool = False,
        authors: list[uuid.UUID] | None = None,
        kinds: list[str] | None = None,
    ) -> list:
        """The WHERE clauses shared by the page query and its unpaged count.

        Kept in one place so `X-Total-Count` stays honest — a second
        hand-written filter list would drift and the UI would render
        "showing 20 of <wrong>" (the executions-list precedent).
        """
        filters = []
        if q:
            # ILIKE the extracted text, never `content`: the raw column is PM
            # JSON, so a substring search over it matches node names on every
            # note. content_text is NULL only for rows a pre-099 replica wrote
            # mid-deploy; those stay matchable by title until the backfill.
            term = f"%{q}%"
            filters.append(or_(Note.title.ilike(term), Note.content_text.ilike(term)))
        if pinned_only:
            filters.append(Note.pinned.is_(True))
        if authors:
            filters.append(Note.created_by.in_(authors))
        if kinds:
            filters.append(Note.kind.in_(kinds))
        return filters

    def _order_clauses(self, order_by: NoteOrderBy, direction: SortDirection) -> list:
        """Sort keys for an explicitly-ordered list.

        `author` sorts by the DISPLAY name the UI renders (name, falling back
        to email when name is blank) rather than the created_by UUID — sorting
        by a random-looking id reads as "no sort at all" to the operator.
        `title` is case-folded for the same reason: an "Apple/banana/Cherry"
        list must not split into two alphabets.
        """
        descending = direction == "desc"

        if order_by == "title":
            key = func.lower(Note.title)
        elif order_by == "author":
            key = func.lower(
                func.coalesce(func.nullif(User.name, ""), User.email)
            )
        elif order_by == "created_at":
            key = Note.created_at
        else:
            key = Note.updated_at

        # id is the deterministic tiebreaker: without it, rows sharing a sort
        # key can land on two different pages or on none, which is how paging
        # silently drops records.
        return [key.desc() if descending else key.asc(), Note.id.asc()]

    async def list_page(
        self,
        *,
        workspace_id: uuid.UUID | None = None,
        board_id: uuid.UUID | None = None,
        card_id: uuid.UUID | None = None,
        workspace_level_only: bool = False,
        q: str | None = None,
        pinned_only: bool = False,
        authors: list[uuid.UUID] | None = None,
        kinds: list[str] | None = None,
        order_by: NoteOrderBy | None = None,
        direction: SortDirection = "desc",
        limit: int | None = None,
        offset: int = 0,
    ) -> tuple[list[Note], int]:
        """Filtered + optionally paged notes, plus the unpaged match count.

        `order_by=None` reproduces the legacy list order exactly (pinned first,
        then newest-created, with id breaking ties) so a param-less call keeps the
        list ordering from before search/paging existed — the MCP tools
        depend on that. Any explicit order_by opts out of pinned-first: the
        operator asked for one sort key, not two.
        """
        scope = []
        if workspace_id is not None:
            scope.append(Note.workspace_id == workspace_id)
        if board_id is not None:
            scope.append(Note.board_id == board_id)
        elif workspace_level_only:
            scope.append(Note.board_id.is_(None))

        if card_id is not None:
            scope.append(Note.card_id == card_id)

        filters = scope + self._list_filters(
            q=q, pinned_only=pinned_only, authors=authors, kinds=kinds
        )

        needs_author_join = order_by == "author"

        count_stmt = select(func.count()).select_from(Note).where(*filters)
        total = (await self.db.execute(count_stmt)).scalar_one()

        stmt = select(Note).where(*filters)
        if needs_author_join:
            # outer join: a note whose author row was deleted must still list.
            stmt = stmt.outerjoin(User, Note.created_by == User.id)

        if order_by is None:
            stmt = stmt.order_by(Note.pinned.desc(), Note.created_at.desc(), Note.id.asc())
        else:
            stmt = stmt.order_by(*self._order_clauses(order_by, direction))

        if limit is not None:
            stmt = stmt.limit(limit).offset(offset)
        elif offset:
            stmt = stmt.offset(offset)

        result = await self.db.execute(stmt)
        return list(result.scalars().all()), total
