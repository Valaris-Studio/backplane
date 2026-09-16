# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ResourceNotFoundError
from app.models.channels.channel import Channel
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.channels.channel import ChannelCreate, ChannelUpdate
from app.services.channels.channel import ChannelService


async def test_create_channel(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ChannelService(db_session)
    data = ChannelCreate(
        name="Support Email",
        channel_type="email",
        contact_value="support@valaris.dev",
        description="Main support",
    )

    channel = await service.create_channel(test_workspace.id, data, test_user.id)

    assert channel.name == "Support Email"
    assert channel.channel_type.value == "email"
    assert channel.contact_value == "support@valaris.dev"
    assert channel.description == "Main support"
    assert channel.workspace_id == test_workspace.id
    assert channel.created_by == test_user.id


async def test_list_channels(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ChannelService(db_session)
    await service.create_channel(
        test_workspace.id,
        ChannelCreate(name="Ch 1", channel_type="email", contact_value="a@b.com"),
        test_user.id,
    )
    await service.create_channel(
        test_workspace.id,
        ChannelCreate(name="Ch 2", channel_type="slack", contact_value="#general"),
        test_user.id,
    )

    channels = await service.list_channels(test_workspace.id)

    assert len(channels) == 2
    names = [c.name for c in channels]
    assert "Ch 1" in names
    assert "Ch 2" in names


async def test_get_channel_success(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ChannelService(db_session)
    created = await service.create_channel(
        test_workspace.id,
        ChannelCreate(name="Get Me", channel_type="phone", contact_value="+123"),
        test_user.id,
    )

    channel = await service.get_channel(created.id, test_workspace.id)

    assert channel.id == created.id
    assert channel.name == "Get Me"


async def test_get_channel_not_found(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = ChannelService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.get_channel(uuid.uuid4(), test_workspace.id)


async def test_get_channel_wrong_workspace(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ChannelService(db_session)
    created = await service.create_channel(
        test_workspace.id,
        ChannelCreate(name="Scoped", channel_type="email", contact_value="x@y.com"),
        test_user.id,
    )

    other_workspace_id = uuid.uuid4()
    with pytest.raises(ResourceNotFoundError):
        await service.get_channel(created.id, other_workspace_id)


async def test_update_channel(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ChannelService(db_session)
    created = await service.create_channel(
        test_workspace.id,
        ChannelCreate(name="Original", channel_type="email", contact_value="old@v.dev"),
        test_user.id,
    )

    updated = await service.update_channel(
        created.id, test_workspace.id, ChannelUpdate(name="Updated", contact_value="new@v.dev")
    )

    assert updated.name == "Updated"
    assert updated.contact_value == "new@v.dev"
    assert updated.id == created.id


async def test_update_channel_not_found(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = ChannelService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.update_channel(
            uuid.uuid4(), test_workspace.id, ChannelUpdate(name="Nope")
        )


async def test_delete_channel(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ChannelService(db_session)
    created = await service.create_channel(
        test_workspace.id,
        ChannelCreate(name="Delete Me", channel_type="other", contact_value="bye"),
        test_user.id,
    )

    await service.delete_channel(created.id, test_workspace.id)

    with pytest.raises(ResourceNotFoundError):
        await service.get_channel(created.id, test_workspace.id)


async def test_delete_channel_not_found(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = ChannelService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.delete_channel(uuid.uuid4(), test_workspace.id)


# --- Tests for activity recording ---


async def test_update_channel_records_activity(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    from app.models.activity import Activity, ActivityAction, ActivityEntityType
    from sqlalchemy import select

    service = ChannelService(db_session)
    created = await service.create_channel(
        test_workspace.id,
        ChannelCreate(name="Track Me", channel_type="email", contact_value="track@v.dev"),
        test_user.id,
    )

    # create_channel also records activity, count how many we have before update
    pre_result = await db_session.execute(select(Activity))
    pre_count = len(list(pre_result.scalars().all()))

    await service.update_channel(
        created.id, test_workspace.id, ChannelUpdate(name="Tracked Update"),
        actor_id=test_user.id,
    )

    result = await db_session.execute(
        select(Activity).where(Activity.action == ActivityAction.updated)
    )
    activities = list(result.scalars().all())
    assert len(activities) == 1
    a = activities[0]
    assert a.entity_type == ActivityEntityType.channel
    assert a.entity_id == created.id
    assert a.actor_id == test_user.id
    assert "updated channel" in a.summary
    assert a.changes == {"fields": ["name"]}


async def test_delete_channel_records_activity(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    from app.models.activity import Activity, ActivityAction, ActivityEntityType
    from sqlalchemy import select

    service = ChannelService(db_session)
    created = await service.create_channel(
        test_workspace.id,
        ChannelCreate(name="Delete Track", channel_type="slack", contact_value="#bye"),
        test_user.id,
    )

    await service.delete_channel(
        created.id, test_workspace.id, actor_id=test_user.id,
    )

    result = await db_session.execute(
        select(Activity).where(Activity.action == ActivityAction.deleted)
    )
    activities = list(result.scalars().all())
    assert len(activities) == 1
    a = activities[0]
    assert a.entity_type == ActivityEntityType.channel
    assert a.entity_id == created.id
    assert "deleted channel" in a.summary
    assert "Delete Track" in a.summary


# --- Shallow merge tests ---


async def test_update_channel_metadata_shallow_merge(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ChannelService(db_session)
    created = await service.create_channel(
        test_workspace.id,
        ChannelCreate(
            name="Merge Test",
            channel_type="slack",
            contact_value="#test",
            metadata_json={"slack_id": "x", "webhook": "y"},
        ),
        test_user.id,
    )

    updated = await service.update_channel(
        created.id,
        test_workspace.id,
        ChannelUpdate(metadata_json={"slack_id": "z"}),
    )

    assert updated.metadata_json["slack_id"] == "z"
    assert updated.metadata_json["webhook"] == "y"


async def test_update_channel_metadata_merge_null_deletes_key(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ChannelService(db_session)
    created = await service.create_channel(
        test_workspace.id,
        ChannelCreate(
            name="Delete Key",
            channel_type="slack",
            contact_value="#test",
            metadata_json={"slack_id": "x", "webhook": "y"},
        ),
        test_user.id,
    )

    updated = await service.update_channel(
        created.id,
        test_workspace.id,
        ChannelUpdate(metadata_json={"webhook": None}),
    )

    assert updated.metadata_json == {"slack_id": "x"}
    assert "webhook" not in updated.metadata_json
