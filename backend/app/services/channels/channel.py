# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ResourceNotFoundError
from app.models.activity import ActivityAction, ActivityEntityType
from app.repositories.channels.channel import ChannelRepository
from app.schemas.channels.channel import ChannelCreate, ChannelUpdate
from app.services.activity import ActivityService
from app.utils import shallow_merge_dicts


class ChannelService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = ChannelRepository(db)

    async def create_channel(
        self,
        workspace_id: uuid.UUID,
        data: ChannelCreate,
        user_id: uuid.UUID,
    ):
        channel = await self.repo.create(
            workspace_id=workspace_id,
            name=data.name,
            channel_type=data.channel_type,
            contact_value=data.contact_value,
            description=data.description,
            metadata_json=data.metadata_json,
            created_by=user_id,
        )
        activity = ActivityService(self.db)
        await activity.record(
            workspace_id=workspace_id,
            actor_id=user_id,
            entity_type=ActivityEntityType.channel,
            entity_id=channel.id,
            action=ActivityAction.created,
            summary=f"created channel '{data.name}'",
            message_key="activity.channel.created",
            message_params={"channel_name": data.name},
        )
        return channel

    async def list_channels(self, workspace_id: uuid.UUID):
        return await self.repo.list_by_workspace(workspace_id)

    async def get_channel(self, channel_id: uuid.UUID, workspace_id: uuid.UUID):
        channel = await self.repo.get_by_id(channel_id)
        if not channel or channel.workspace_id != workspace_id:
            raise ResourceNotFoundError("Channel not found")
        return channel

    async def update_channel(
        self,
        channel_id: uuid.UUID,
        workspace_id: uuid.UUID,
        data: ChannelUpdate,
        actor_id: uuid.UUID | None = None,
    ):
        channel = await self.repo.get_by_id(channel_id)
        if not channel or channel.workspace_id != workspace_id:
            raise ResourceNotFoundError("Channel not found")
        update_data = data.model_dump(exclude_unset=True)
        changed_fields = list(update_data.keys())
        if "metadata_json" in update_data and channel.metadata_json:
            update_data["metadata_json"] = shallow_merge_dicts(
                channel.metadata_json, update_data["metadata_json"]
            )
        updated = await self.repo.update(channel, **update_data)
        if actor_id and workspace_id:
            activity = ActivityService(self.db)
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.channel,
                entity_id=channel_id,
                action=ActivityAction.updated,
                summary=f"updated channel '{updated.name}'",
                message_key="activity.channel.updated",
                message_params={
                    "channel_name": updated.name,
                    "fields": changed_fields,
                },
                changes={"fields": changed_fields},
            )
        return updated

    async def delete_channel(
        self,
        channel_id: uuid.UUID,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID | None = None,
    ):
        channel = await self.repo.get_by_id(channel_id)
        if not channel or channel.workspace_id != workspace_id:
            raise ResourceNotFoundError("Channel not found")
        if actor_id and workspace_id:
            activity = ActivityService(self.db)
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.channel,
                entity_id=channel_id,
                action=ActivityAction.deleted,
                summary=f"deleted channel '{channel.name}'",
                message_key="activity.channel.deleted",
                message_params={"channel_name": channel.name},
            )
        await self.repo.delete(channel)
