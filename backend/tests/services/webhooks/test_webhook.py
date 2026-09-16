# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.webhooks.webhook import WebhookEvent
from app.models.workspace import Workspace
from app.schemas.webhooks.webhook import WebhookCreate, WebhookUpdate
from app.services.webhooks.webhook import WebhookService


def test_webhook_schema_accepts_all_card_dependency_activity_events():
    expected = [
        "activity.card.dependency_added",
        "activity.card.dependency_removed",
        "activity.card.dependencies_replaced",
    ]

    payload = WebhookCreate.model_validate(
        {
            "url": "https://example.com/hook",
            "events": expected,
            "secret": "test-secret",
        }
    )

    assert [event.value for event in payload.events] == expected


async def test_create_webhook(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    service = WebhookService(db_session)
    data = WebhookCreate(
        url="https://example.com/hook",
        events=[WebhookEvent.card_created, WebhookEvent.card_moved],
        secret="test-secret-123",
    )

    webhook = await service.create(test_workspace.id, test_user.id, data)

    assert webhook.url == "https://example.com/hook"
    assert webhook.events == ["card.created", "card.moved"]
    assert webhook.secret == "test-secret-123"
    assert webhook.workspace_id == test_workspace.id
    assert webhook.created_by_id == test_user.id
    assert webhook.is_active is True
    assert webhook.failure_count == 0


async def test_get_webhook(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    service = WebhookService(db_session)
    data = WebhookCreate(
        url="https://example.com/hook",
        events=[WebhookEvent.card_created],
        secret="secret",
    )
    created = await service.create(test_workspace.id, test_user.id, data)

    fetched = await service.get(created.id)
    assert fetched.id == created.id
    assert fetched.url == "https://example.com/hook"


async def test_get_webhook_not_found(db_session: AsyncSession):
    import pytest
    from app.exceptions import ResourceNotFoundError

    service = WebhookService(db_session)
    with pytest.raises(ResourceNotFoundError):
        await service.get(uuid.uuid4())


async def test_list_webhooks(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    service = WebhookService(db_session)
    for i in range(3):
        await service.create(
            test_workspace.id,
            test_user.id,
            WebhookCreate(
                url=f"https://example.com/hook{i}",
                events=[WebhookEvent.card_created],
                secret=f"secret-{i}",
            ),
        )

    webhooks = await service.list(test_workspace.id)
    assert len(webhooks) == 3


async def test_list_webhooks_filter_active(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    service = WebhookService(db_session)
    active = await service.create(
        test_workspace.id,
        test_user.id,
        WebhookCreate(
            url="https://example.com/active",
            events=[WebhookEvent.card_created],
            secret="secret",
        ),
    )
    inactive = await service.create(
        test_workspace.id,
        test_user.id,
        WebhookCreate(
            url="https://example.com/inactive",
            events=[WebhookEvent.card_created],
            secret="secret",
        ),
    )
    await service.update(
        inactive.id, test_workspace.id, WebhookUpdate(is_active=False)
    )

    active_webhooks = await service.list(test_workspace.id, is_active=True)
    assert len(active_webhooks) == 1
    assert active_webhooks[0].url == "https://example.com/active"


async def test_update_webhook(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    service = WebhookService(db_session)
    webhook = await service.create(
        test_workspace.id,
        test_user.id,
        WebhookCreate(
            url="https://example.com/old",
            events=[WebhookEvent.card_created],
            secret="old-secret",
        ),
    )

    updated = await service.update(
        webhook.id,
        test_workspace.id,
        WebhookUpdate(url="https://example.com/new", is_active=False),
    )

    assert updated.url == "https://example.com/new"
    assert updated.is_active is False
    assert updated.events == ["card.created"]  # unchanged


async def test_update_webhook_events(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    service = WebhookService(db_session)
    webhook = await service.create(
        test_workspace.id,
        test_user.id,
        WebhookCreate(
            url="https://example.com/hook",
            events=[WebhookEvent.card_created],
            secret="secret",
        ),
    )

    updated = await service.update(
        webhook.id,
        test_workspace.id,
        WebhookUpdate(events=[WebhookEvent.card_moved, WebhookEvent.card_deleted]),
    )

    assert updated.events == ["card.moved", "card.deleted"]


async def test_delete_webhook(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    import pytest
    from app.exceptions import ResourceNotFoundError

    service = WebhookService(db_session)
    webhook = await service.create(
        test_workspace.id,
        test_user.id,
        WebhookCreate(
            url="https://example.com/hook",
            events=[WebhookEvent.card_created],
            secret="secret",
        ),
    )

    await service.delete(webhook.id, test_workspace.id)

    with pytest.raises(ResourceNotFoundError):
        await service.get(webhook.id)
