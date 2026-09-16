# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from datetime import datetime

from sqlalchemy import delete, or_, select, update

from app.models.config_template import (
    BoardLoopTemplateBinding,
    ConfigTemplate,
    ConfigTemplateVersion,
)
from app.models.kanban import Board
from app.repositories.base import BaseRepository


class ConfigTemplateRepository(BaseRepository[ConfigTemplate]):
    model = ConfigTemplate

    async def get_by_slug(
        self, workspace_id: uuid.UUID, kind: str, slug: str
    ) -> ConfigTemplate | None:
        """Scoped by kind as well as workspace: loops and pipelines share this
        table but are different runner features, so a pipeline template must
        never answer a loop lookup."""
        result = await self.db.execute(
            select(ConfigTemplate).where(
                ConfigTemplate.workspace_id == workspace_id,
                ConfigTemplate.kind == kind,
                ConfigTemplate.slug == slug,
            )
        )
        return result.scalar_one_or_none()

    @staticmethod
    def build_search_filter(q: str):
        """Name-or-slug match, case-insensitive on every engine.

        `ilike`, not `like`: PostgreSQL's LIKE is case-sensitive, so `like`
        would make prod search miss "Coding Loop" for the query "coding" while
        the SQLite test DB — whose LIKE ignores ASCII case — stayed green.
        """
        pattern = f"%{q}%"
        return or_(
            ConfigTemplate.name.ilike(pattern),
            ConfigTemplate.slug.ilike(pattern),
        )

    async def list_by_workspace(
        self,
        workspace_id: uuid.UUID,
        kind: str,
        *,
        include_archived: bool = False,
        q: str | None = None,
        sort: str = "name",
    ) -> list[ConfigTemplate]:
        """Archived templates are hidden unless asked for — archiving is the
        only removal v1 has, so the default listing is the live set.

        `sort="recent"` orders by the last DRAFT write rather than
        `updated_at`: a publish also touches the row, and the library's
        "recently worked on" reading is about editing, not releasing.
        """
        statement = select(ConfigTemplate).where(
            ConfigTemplate.workspace_id == workspace_id,
            ConfigTemplate.kind == kind,
        )
        if not include_archived:
            statement = statement.where(ConfigTemplate.is_archived.is_(False))
        if q:
            statement = statement.where(self.build_search_filter(q))
        if sort == "recent":
            # NULLs last without a dialect-specific NULLS LAST: a template
            # never drafted since creation sorts below every drafted one.
            statement = statement.order_by(
                ConfigTemplate.draft_updated_at.is_(None),
                ConfigTemplate.draft_updated_at.desc(),
                ConfigTemplate.name.asc(),
            )
        else:
            statement = statement.order_by(ConfigTemplate.name.asc())

        result = await self.db.execute(statement)
        return list(result.scalars().all())

    async def update_draft_if_unchanged(
        self,
        template_id: uuid.UUID,
        *,
        expected_draft_updated_at: datetime | None,
        values: dict,
    ) -> bool:
        """Write the draft only while it still carries the caller's token.

        The token goes in the WHERE clause, so the compare and the write are
        ONE statement and concurrent autosaves race in the database instead of
        in Python: exactly one UPDATE matches, and the loser's rowcount of 0 is
        what raises `stale_draft`. A read-then-compare-then-write lets two
        editors that loaded the same token both pass the check and the second
        silently overwrite the first (card ff930e62).

        `expected_draft_updated_at` is None for callers that opt out of the
        lock; that path still scopes the UPDATE by id, matching the row
        unconditionally the way it always did.
        """
        statement = update(ConfigTemplate).where(ConfigTemplate.id == template_id)
        if expected_draft_updated_at is not None:
            statement = statement.where(
                ConfigTemplate.draft_updated_at == expected_draft_updated_at
            )
        result = await self.db.execute(statement.values(**values))
        await self.db.flush()
        return (result.rowcount or 0) == 1

    async def add_version(
        self,
        template_id: uuid.UUID,
        version: int,
        profile: dict,
        content: dict,
        published_by_id: uuid.UUID | None = None,
        note: str | None = None,
    ) -> ConfigTemplateVersion:
        snapshot = ConfigTemplateVersion(
            template_id=template_id,
            version=version,
            profile=profile,
            content=content,
            published_by_id=published_by_id,
            note=note,
        )
        self.db.add(snapshot)
        await self.db.flush()
        return snapshot

    async def list_versions(
        self, template_id: uuid.UUID
    ) -> list[ConfigTemplateVersion]:
        """Newest first — history is read backwards from the current release."""
        result = await self.db.execute(
            select(ConfigTemplateVersion)
            .where(ConfigTemplateVersion.template_id == template_id)
            .order_by(ConfigTemplateVersion.version.desc())
        )
        return list(result.scalars().all())

    async def get_version(
        self, template_id: uuid.UUID, version: int
    ) -> ConfigTemplateVersion | None:
        result = await self.db.execute(
            select(ConfigTemplateVersion).where(
                ConfigTemplateVersion.template_id == template_id,
                ConfigTemplateVersion.version == version,
            )
        )
        return result.scalar_one_or_none()


class BoardLoopTemplateBindingRepository(BaseRepository[BoardLoopTemplateBinding]):
    model = BoardLoopTemplateBinding

    async def get_by_board(
        self, board_id: uuid.UUID
    ) -> BoardLoopTemplateBinding | None:
        result = await self.db.execute(
            select(BoardLoopTemplateBinding).where(
                BoardLoopTemplateBinding.board_id == board_id
            )
        )
        return result.scalar_one_or_none()

    async def list_for_workspace(
        self, workspace_id: uuid.UUID
    ) -> list[BoardLoopTemplateBinding]:
        """Every binding whose board lives in this workspace.

        Joined through boards rather than filtered in Python because the
        binding row has no workspace of its own — counting without the join
        would report another tenant's boards in this workspace's usage stats.
        """
        result = await self.db.execute(
            select(BoardLoopTemplateBinding)
            .join(Board, Board.id == BoardLoopTemplateBinding.board_id)
            .where(Board.workspace_id == workspace_id)
        )
        return list(result.scalars().all())

    async def upsert(
        self,
        board_id: uuid.UUID,
        template_ref: dict,
        version: int,
        slot_values: dict,
        rendered_by_id: uuid.UUID | None = None,
        rendered_hash: str | None = None,
    ) -> BoardLoopTemplateBinding:
        """Rebinding a board overwrites its one row rather than inserting a
        second — board_id is the PK, so an insert-only path would turn every
        rebind into an IntegrityError.
        """
        existing = await self.get_by_board(board_id)
        if existing is not None:
            return await self.update(
                existing,
                template_ref=template_ref,
                version=version,
                slot_values=slot_values,
                rendered_by_id=rendered_by_id,
                rendered_hash=rendered_hash,
            )

        binding = BoardLoopTemplateBinding(
            board_id=board_id,
            template_ref=template_ref,
            version=version,
            slot_values=slot_values,
            rendered_by_id=rendered_by_id,
            rendered_hash=rendered_hash,
        )
        self.db.add(binding)
        await self.db.flush()
        return binding

    async def delete_for_board(self, board_id: uuid.UUID) -> None:
        """Idempotent: detaching an already-detached board is a retry, not an
        error. Bulk DELETE rather than session.delete() so the no-row case
        costs one statement instead of a load plus a branch."""
        await self.db.execute(
            delete(BoardLoopTemplateBinding).where(
                BoardLoopTemplateBinding.board_id == board_id
            )
        )
        await self.db.flush()
