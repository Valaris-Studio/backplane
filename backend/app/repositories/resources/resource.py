# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import func, select

from app.models.resources.resource import Resource, ResourceType
from app.repositories.base import BaseRepository


class ResourceRepository(BaseRepository[Resource]):
    model = Resource

    async def list_by_workspace(self, workspace_id: uuid.UUID) -> list[Resource]:
        result = await self.db.execute(
            select(Resource)
            .where(Resource.workspace_id == workspace_id, Resource.board_id.is_(None))
            .order_by(Resource.resource_type.desc(), Resource.name.asc())
        )
        return list(result.scalars().all())

    async def list_by_board(self, board_id: uuid.UUID) -> list[Resource]:
        result = await self.db.execute(
            select(Resource)
            .where(Resource.board_id == board_id)
            .order_by(Resource.resource_type.desc(), Resource.name.asc())
        )
        return list(result.scalars().all())

    async def list_by_parent(self, parent_id: uuid.UUID) -> list[Resource]:
        result = await self.db.execute(
            select(Resource)
            .where(Resource.parent_id == parent_id)
            .order_by(Resource.resource_type.desc(), Resource.name.asc())
        )
        return list(result.scalars().all())

    async def list_root_by_workspace(self, workspace_id: uuid.UUID) -> list[Resource]:
        result = await self.db.execute(
            select(Resource)
            .where(
                Resource.workspace_id == workspace_id,
                Resource.board_id.is_(None),
                Resource.parent_id.is_(None),
            )
            .order_by(Resource.resource_type.desc(), Resource.name.asc())
        )
        return list(result.scalars().all())

    async def list_root_by_board(self, board_id: uuid.UUID) -> list[Resource]:
        result = await self.db.execute(
            select(Resource)
            .where(Resource.board_id == board_id, Resource.parent_id.is_(None))
            .order_by(Resource.resource_type.desc(), Resource.name.asc())
        )
        return list(result.scalars().all())

    async def search(
        self,
        workspace_id: uuid.UUID,
        q: str | None = None,
        resource_type: str | None = None,
        tag: str | None = None,
        board_id: uuid.UUID | None = None,
        parent_id: uuid.UUID | None = None,
    ) -> list[Resource]:
        stmt = select(Resource).where(Resource.workspace_id == workspace_id)

        if board_id is not None:
            stmt = stmt.where(Resource.board_id == board_id)
        else:
            stmt = stmt.where(Resource.board_id.is_(None))

        if q:
            # Search across all resources in scope (ignore parent_id when searching)
            stmt = stmt.where(Resource.name.ilike(f"%{q}%"))
        else:
            # Normal folder navigation
            if parent_id:
                stmt = stmt.where(Resource.parent_id == parent_id)
            else:
                stmt = stmt.where(Resource.parent_id.is_(None))

        if resource_type:
            stmt = stmt.where(Resource.resource_type == ResourceType(resource_type))

        if tag:
            # JSON contains check — works with SQLite and PostgreSQL
            stmt = stmt.where(
                Resource.meta["tags"].as_string().contains(tag)
            )

        stmt = stmt.order_by(Resource.resource_type.desc(), Resource.name.asc())
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def list_tags(
        self, workspace_id: uuid.UUID, board_id: uuid.UUID | None = None
    ) -> list[str]:
        stmt = select(Resource.meta).where(
            Resource.workspace_id == workspace_id
        )
        if board_id is not None:
            stmt = stmt.where(Resource.board_id == board_id)
        else:
            stmt = stmt.where(Resource.board_id.is_(None))

        result = await self.db.execute(stmt)
        rows = result.scalars().all()

        tags: set[str] = set()
        for meta in rows:
            if isinstance(meta, dict) and "tags" in meta:
                tags.update(meta["tags"])
        return sorted(tags)

    async def count_workspace_resources(self, workspace_id: uuid.UUID) -> int:
        result = await self.db.execute(
            select(func.count()).select_from(Resource).where(
                Resource.workspace_id == workspace_id, Resource.board_id.is_(None)
            )
        )
        return result.scalar_one()
