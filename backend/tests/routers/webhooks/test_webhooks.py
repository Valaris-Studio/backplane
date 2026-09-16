# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.webhooks.webhook import Webhook, WebhookEvent
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole


async def test_create_webhook_success(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(
        "/api/workspaces/default/webhooks",
        json={
            "url": "https://example.com/hook",
            "events": ["card.created", "card.moved"],
            "secret": "my-secret-key",
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["url"] == "https://example.com/hook"
    assert data["events"] == ["card.created", "card.moved"]
    assert data["is_active"] is True
    assert data["failure_count"] == 0
    assert "id" in data
    assert "created_at" in data


async def test_list_webhooks_empty(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get("/api/workspaces/default/webhooks")
    assert response.status_code == 200
    assert response.json() == []


async def test_list_webhooks(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    for i in range(2):
        db_session.add(Webhook(
            workspace_id=test_workspace.id,
            url=f"https://example.com/hook{i}",
            events=["card.created"],
            secret="secret",
            created_by_id=test_user.id,
        ))
    await db_session.flush()

    response = await client.get("/api/workspaces/default/webhooks")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 2


async def test_get_webhook(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    webhook = Webhook(
        workspace_id=test_workspace.id,
        url="https://example.com/hook",
        events=["card.created"],
        secret="secret",
        created_by_id=test_user.id,
    )
    db_session.add(webhook)
    await db_session.flush()

    response = await client.get(f"/api/workspaces/default/webhooks/{webhook.id}")
    assert response.status_code == 200
    data = response.json()
    assert data["url"] == "https://example.com/hook"
    assert data["id"] == str(webhook.id)


async def test_get_webhook_not_found(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get(f"/api/workspaces/default/webhooks/{uuid.uuid4()}")
    assert response.status_code == 404


async def _make_other_workspace_webhook(
    db_session: AsyncSession, test_user: User
) -> Webhook:
    """A webhook owned by a DIFFERENT workspace that test_user also belongs to.

    Membership in the other workspace is irrelevant to the IDOR: the request is
    routed through the /default/ slug, so cross-workspace access must be denied
    by the webhook's own workspace scoping, not by workspace membership.
    """
    other = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(other)
    await db_session.flush()
    db_session.add(WorkspaceMember(
        workspace_id=other.id, user_id=test_user.id, role=WorkspaceRole.owner
    ))
    webhook = Webhook(
        workspace_id=other.id,
        url="https://example.com/other-hook",
        events=["card.created"],
        secret="secret",
        created_by_id=test_user.id,
    )
    db_session.add(webhook)
    await db_session.flush()
    return webhook


async def test_get_webhook_other_workspace_not_found(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    webhook = await _make_other_workspace_webhook(db_session, test_user)

    response = await client.get(f"/api/workspaces/default/webhooks/{webhook.id}")
    assert response.status_code == 404


async def test_update_webhook_other_workspace_not_found(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    webhook = await _make_other_workspace_webhook(db_session, test_user)

    response = await client.patch(
        f"/api/workspaces/default/webhooks/{webhook.id}",
        json={"url": "https://evil.example.com/hook"},
    )
    assert response.status_code == 404


async def test_delete_webhook_other_workspace_not_found(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    webhook = await _make_other_workspace_webhook(db_session, test_user)

    response = await client.delete(f"/api/workspaces/default/webhooks/{webhook.id}")
    assert response.status_code == 404


async def test_update_webhook(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    webhook = Webhook(
        workspace_id=test_workspace.id,
        url="https://example.com/old",
        events=["card.created"],
        secret="secret",
        created_by_id=test_user.id,
    )
    db_session.add(webhook)
    await db_session.flush()

    response = await client.patch(
        f"/api/workspaces/default/webhooks/{webhook.id}",
        json={"url": "https://example.com/new", "is_active": False},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["url"] == "https://example.com/new"
    assert data["is_active"] is False


async def test_delete_webhook(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    webhook = Webhook(
        workspace_id=test_workspace.id,
        url="https://example.com/hook",
        events=["card.created"],
        secret="secret",
        created_by_id=test_user.id,
    )
    db_session.add(webhook)
    await db_session.flush()

    response = await client.delete(f"/api/workspaces/default/webhooks/{webhook.id}")
    assert response.status_code == 204

    response = await client.get(f"/api/workspaces/default/webhooks/{webhook.id}")
    assert response.status_code == 404


async def test_create_webhook_invalid_event(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(
        "/api/workspaces/default/webhooks",
        json={
            "url": "https://example.com/hook",
            "events": ["invalid.event"],
            "secret": "secret",
        },
    )
    assert response.status_code == 422
