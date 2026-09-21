# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import Row, and_, func, or_, select
from sqlalchemy.orm import selectinload

from app.models.skills.skill import (
    SKILL_VERSION_MUTABLE_FIELDS,
    BoardSkill,
    Skill,
    SkillAuditEvent,
    SkillVersion,
)
from app.repositories.base import BaseRepository


MAX_HISTORY_FETCH_SIZE = 101


class SkillRepository(BaseRepository[Skill]):
    model = Skill

    async def list_by_workspace(
        self, workspace_id: uuid.UUID, include_archived: bool = False
    ) -> list[Skill]:
        # Listing items derive `toolsets` from the resolving version's
        # manifest, so the versions ride along in one extra query (workspace
        # libraries are small) — never an N+1 per skill.
        query = (
            select(Skill)
            .where(Skill.workspace_id == workspace_id)
            .options(selectinload(Skill.versions))
            .order_by(Skill.slug.asc())
        )
        if not include_archived:
            query = query.where(Skill.archived_at.is_(None))
        result = await self.db.execute(query)
        return list(result.scalars().all())

    async def get_by_slug(
        self, workspace_id: uuid.UUID, slug: str
    ) -> Skill | None:
        result = await self.db.execute(
            select(Skill).where(
                Skill.workspace_id == workspace_id, Skill.slug == slug
            )
        )
        return result.scalar_one_or_none()

    async def get_detail_by_slug(
        self, workspace_id: uuid.UUID, slug: str
    ) -> Skill | None:
        # SkillRead nests version metadata and everything is lazy="raise" —
        # the detail path must eager-load or serialization raises.
        result = await self.db.execute(
            select(Skill)
            .where(Skill.workspace_id == workspace_id, Skill.slug == slug)
            .options(selectinload(Skill.versions))
        )
        return result.scalar_one_or_none()


class SkillVersionRepository(BaseRepository[SkillVersion]):
    model = SkillVersion

    async def update(self, instance: SkillVersion, **kwargs) -> SkillVersion:
        immutable_fields = kwargs.keys() - SKILL_VERSION_MUTABLE_FIELDS
        if immutable_fields:
            raise ValueError(f"Skill revision fields are immutable: {', '.join(sorted(immutable_fields))}")
        return await super().update(instance, **kwargs)

    async def delete(self, instance: SkillVersion) -> None:
        raise ValueError("Skill revisions are immutable")

    async def delete_by_id(self, id: uuid.UUID) -> None:
        raise ValueError("Skill revisions are immutable")

    async def list_history(
        self, skill_id: uuid.UUID, *, limit: int = 50, before_version: int | None = None
    ) -> list[SkillVersion]:
        if not 1 <= limit <= MAX_HISTORY_FETCH_SIZE:
            raise ValueError(f"History limit must be between 1 and {MAX_HISTORY_FETCH_SIZE}")
        query = select(SkillVersion).where(SkillVersion.skill_id == skill_id)
        if before_version is not None:
            query = query.where(SkillVersion.version < before_version)
        result = await self.db.scalars(query.order_by(SkillVersion.version.desc()).limit(limit))
        return list(result.all())

    async def get_by_number(
        self, skill_id: uuid.UUID, version: int
    ) -> SkillVersion | None:
        result = await self.db.execute(
            select(SkillVersion).where(
                SkillVersion.skill_id == skill_id, SkillVersion.version == version
            )
        )
        return result.scalar_one_or_none()

    async def get_proposed_by_hash(
        self, skill_id: uuid.UUID, content_hash: str
    ) -> SkillVersion | None:
        result = await self.db.execute(
            select(SkillVersion)
            .where(
                SkillVersion.skill_id == skill_id,
                SkillVersion.content_hash == content_hash,
                SkillVersion.status == "proposed",
            )
            .order_by(SkillVersion.version.desc())
        )
        return result.scalars().first()

    async def max_version(self, skill_id: uuid.UUID) -> int:
        result = await self.db.execute(
            select(func.max(SkillVersion.version)).where(
                SkillVersion.skill_id == skill_id
            )
        )
        return result.scalar_one() or 0


class SkillAuditEventRepository(BaseRepository[SkillAuditEvent]):
    model = SkillAuditEvent

    async def update(self, instance: SkillAuditEvent, **kwargs) -> SkillAuditEvent:
        raise ValueError("Skill audit history is append-only")

    async def delete(self, instance: SkillAuditEvent) -> None:
        raise ValueError("Skill audit history is append-only")

    async def delete_by_id(self, id: uuid.UUID) -> None:
        raise ValueError("Skill audit history is append-only")

    async def list_history(
        self, skill_id: uuid.UUID, *, limit: int = 50, before_id: uuid.UUID | None = None
    ) -> list[SkillAuditEvent]:
        if not 1 <= limit <= MAX_HISTORY_FETCH_SIZE:
            raise ValueError(f"History limit must be between 1 and {MAX_HISTORY_FETCH_SIZE}")
        query = select(SkillAuditEvent).where(SkillAuditEvent.skill_id == skill_id)
        if before_id is not None:
            cursor = await self.db.scalar(select(SkillAuditEvent).where(
                SkillAuditEvent.skill_id == skill_id, SkillAuditEvent.id == before_id
            ))
            if cursor is None:
                return []
            query = query.where(or_(
                SkillAuditEvent.created_at < cursor.created_at,
                and_(SkillAuditEvent.created_at == cursor.created_at, SkillAuditEvent.id < cursor.id),
            ))
        result = await self.db.scalars(query.order_by(
            SkillAuditEvent.created_at.desc(), SkillAuditEvent.id.desc()
        ).limit(limit))
        return list(result.all())


class BoardSkillRepository(BaseRepository[BoardSkill]):
    model = BoardSkill

    async def get_binding(
        self, board_id: uuid.UUID, skill_id: uuid.UUID
    ) -> BoardSkill | None:
        result = await self.db.execute(
            select(BoardSkill).where(
                BoardSkill.board_id == board_id, BoardSkill.skill_id == skill_id
            )
        )
        return result.scalar_one_or_none()

    async def list_for_board(self, board_id: uuid.UUID) -> list[Row]:
        """EVERY binding row with the version it WOULD resolve to.

        The outer join is the whole point: unlike the effective set, a binding
        that resolves to nothing (draft-only, unpinned) still comes back, with
        a NULL resolved version row — an operator has to see the bind they
        made. The whole version row rides so the caller can read its manifest.
        """
        resolved = func.coalesce(
            BoardSkill.pinned_version, Skill.latest_published_version
        )
        result = await self.db.execute(
            select(Skill, BoardSkill, SkillVersion)
            .join(BoardSkill, BoardSkill.skill_id == Skill.id)
            .outerjoin(
                SkillVersion,
                and_(
                    SkillVersion.skill_id == Skill.id,
                    SkillVersion.version == resolved,
                ),
            )
            .where(BoardSkill.board_id == board_id)
            .order_by(Skill.slug.asc())
        )
        return list(result.all())

    async def list_effective_for_board(
        self, board_id: uuid.UUID
    ) -> list[Row]:
        """Enabled bindings resolved to their effective version row.

        The resolved version is `pinned_version` when set, else the skill's
        `latest_published_version`; the inner join to `skill_versions` is what
        excludes a binding that resolves to nothing (draft-only, unpinned).
        """
        resolved = func.coalesce(
            BoardSkill.pinned_version, Skill.latest_published_version
        )
        result = await self.db.execute(
            select(Skill, BoardSkill, SkillVersion)
            .join(BoardSkill, BoardSkill.skill_id == Skill.id)
            .join(
                SkillVersion,
                and_(
                    SkillVersion.skill_id == Skill.id,
                    SkillVersion.version == resolved,
                ),
            )
            .where(BoardSkill.board_id == board_id, BoardSkill.enabled.is_(True))
            .order_by(Skill.slug.asc())
        )
        return list(result.all())
