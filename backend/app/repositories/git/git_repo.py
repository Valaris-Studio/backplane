# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import select

from app.models.git.git_repo import GitRepo
from app.repositories.base import BaseRepository


class GitRepoRepository(BaseRepository[GitRepo]):
    model = GitRepo

    async def list_by_board(self, board_id: uuid.UUID) -> list[GitRepo]:
        result = await self.db.execute(
            select(GitRepo)
            .where(GitRepo.board_id == board_id)
            .order_by(GitRepo.created_at.desc())
        )
        return list(result.scalars().all())

    async def get_by_slug(self, board_id: uuid.UUID, slug: str) -> GitRepo | None:
        result = await self.db.execute(
            select(GitRepo).where(
                GitRepo.board_id == board_id, GitRepo.slug == slug
            )
        )
        return result.scalar_one_or_none()

    async def exists_for_board(self, board_id: uuid.UUID) -> bool:
        result = await self.db.execute(
            select(GitRepo.id).where(GitRepo.board_id == board_id).limit(1)
        )
        return result.first() is not None

    async def slug_exists(
        self,
        board_id: uuid.UUID,
        slug: str,
        exclude_id: uuid.UUID | None = None,
    ) -> bool:
        stmt = select(GitRepo.id).where(
            GitRepo.board_id == board_id, GitRepo.slug == slug
        )
        if exclude_id is not None:
            stmt = stmt.where(GitRepo.id != exclude_id)
        result = await self.db.execute(stmt)
        return result.first() is not None
