# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ResourceNotFoundError
from app.repositories.skills.skill import SkillAuditEventRepository
from app.schemas.skills.skill import (
    SkillAuditEventRead,
    SkillAuditPageRead,
    SkillDiffRead,
    SkillFileDiffRead,
    SkillVersionPageRead,
)
from app.services.skills.skill_service import SkillService, build_version_read


class SkillHistoryService:
    def __init__(self, db: AsyncSession):
        self.skills = SkillService(db)
        self.events = SkillAuditEventRepository(db)

    async def list_versions(
        self,
        workspace_id: uuid.UUID,
        slug: str,
        *,
        limit: int = 50,
        before_version: int | None = None,
    ) -> SkillVersionPageRead:
        skill = await self.skills._get_skill(workspace_id, slug)
        versions = await self.skills.versions.list_history(
            skill.id, limit=limit + 1, before_version=before_version
        )
        page = versions[:limit]
        return SkillVersionPageRead(
            items=[build_version_read(version) for version in page],
            next_before_version=page[-1].version if len(versions) > limit else None,
        )

    async def diff(
        self,
        workspace_id: uuid.UUID,
        slug: str,
        from_version: int,
        to_version: int,
    ) -> SkillDiffRead:
        before = await self.skills.get_version(workspace_id, slug, from_version)
        after = await self.skills.get_version(workspace_id, slug, to_version)
        before_files = {file["path"]: file["content"] for file in before.files}
        after_files = {file["path"]: file["content"] for file in after.files}
        changes = []
        for path in sorted(before_files.keys() | after_files.keys()):
            old_content = before_files.get(path)
            new_content = after_files.get(path)
            if old_content == new_content:
                continue
            if path not in before_files:
                change = "added"
            elif path not in after_files:
                change = "deleted"
            else:
                change = "modified"
            changes.append(
                SkillFileDiffRead(
                    path=path, change=change, before=old_content, after=new_content
                )
            )
        return SkillDiffRead(
            from_version=from_version, to_version=to_version, files=changes
        )

    async def list_events(
        self,
        workspace_id: uuid.UUID,
        slug: str,
        *,
        limit: int = 50,
        before_id: uuid.UUID | None = None,
    ) -> SkillAuditPageRead:
        skill = await self.skills._get_skill(workspace_id, slug)
        if before_id is not None:
            cursor = await self.events.get_by_id(before_id)
            if cursor is None or cursor.skill_id != skill.id:
                raise ResourceNotFoundError("Skill history cursor not found")
        events = await self.events.list_history(
            skill.id, limit=limit + 1, before_id=before_id
        )
        page = events[:limit]
        return SkillAuditPageRead(
            items=[SkillAuditEventRead.model_validate(event) for event in page],
            next_before_id=page[-1].id if len(events) > limit else None,
        )
