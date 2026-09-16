# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import func, select

from app.models.channels.channel import Channel
from app.repositories.base import BaseRepository


class ChannelRepository(BaseRepository[Channel]):
    model = Channel

    async def count_by_workspace(self, workspace_id: uuid.UUID) -> int:
        result = await self.db.execute(
            select(func.count()).select_from(Channel).where(Channel.workspace_id == workspace_id)
        )
        return result.scalar_one()

    async def list_by_workspace(self, workspace_id: uuid.UUID) -> list[Channel]:
        result = await self.db.execute(
            select(Channel)
            .where(Channel.workspace_id == workspace_id)
            .order_by(Channel.created_at.desc())
        )
        return list(result.scalars().all())
