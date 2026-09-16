# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import Row, and_, func, select
from sqlalchemy.orm import selectinload

from app.models.skills.skill import BoardSkill, Skill, SkillVersion
from app.repositories.base import BaseRepository


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
