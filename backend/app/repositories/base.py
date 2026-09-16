# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from typing import Generic, TypeVar

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.base import Base

ModelT = TypeVar("ModelT", bound=Base)


class BaseRepository(Generic[ModelT]):
    model: type[ModelT]

    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_by_id(self, id: uuid.UUID) -> ModelT | None:
        result = await self.db.execute(select(self.model).where(self.model.id == id))
        return result.scalar_one_or_none()

    async def list(self, offset: int = 0, limit: int = 20) -> list[ModelT]:
        result = await self.db.execute(select(self.model).offset(offset).limit(limit))
        return list(result.scalars().all())

    async def count(self) -> int:
        result = await self.db.execute(select(func.count()).select_from(self.model))
        return result.scalar_one()

    async def create(self, **kwargs) -> ModelT:
        instance = self.model(**kwargs)
        self.db.add(instance)
        await self.db.flush()
        return instance

    async def update(self, instance: ModelT, **kwargs) -> ModelT:
        for key, value in kwargs.items():
            setattr(instance, key, value)
        await self.db.flush()
        await self.db.refresh(instance)
        return instance

    async def delete(self, instance: ModelT) -> None:
        await self.db.delete(instance)
        await self.db.flush()

    async def delete_by_id(self, id: uuid.UUID) -> None:
        # Bulk DELETE relying on the DB's ON DELETE rules. session.delete()
        # walks ORM cascades per row and force-loads lazy="raise" relationships
        # during flush (the self-referential Card.parent_card breaks board and
        # workspace deletes that way).
        await self.db.execute(delete(self.model).where(self.model.id == id))
        await self.db.flush()
