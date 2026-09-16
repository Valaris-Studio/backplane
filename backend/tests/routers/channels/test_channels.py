# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from httpx import AsyncClient

from app.models.channels.channel import Channel
from app.models.workspace import Workspace


BASE_URL = "/api/workspaces/default/channels"

VALID_CHANNEL = {
    "name": "Support Email",
    "channel_type": "email",
    "contact_value": "support@valaris.dev",
    "description": "Main support channel",
}


async def test_list_channels_empty(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get(BASE_URL)
    assert response.status_code == 200
    assert response.json() == []


async def test_list_channels_with_data(
    client: AsyncClient, test_workspace: Workspace, test_channel: Channel
):
    response = await client.get(BASE_URL)
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["name"] == "Test Channel"
    assert data[0]["channel_type"] == "email"
    assert data[0]["contact_value"] == "test@valaris.dev"


async def test_create_channel_success(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(BASE_URL, json=VALID_CHANNEL)
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "Support Email"
    assert data["channel_type"] == "email"
    assert data["contact_value"] == "support@valaris.dev"
    assert data["description"] == "Main support channel"
    assert "id" in data
    assert "created_at" in data


async def test_create_channel_missing_name(
    client: AsyncClient, test_workspace: Workspace
):
    payload = {
        "channel_type": "email",
        "contact_value": "test@valaris.dev",
    }
    response = await client.post(BASE_URL, json=payload)
    assert response.status_code == 422


async def test_get_channel_success(
    client: AsyncClient, test_workspace: Workspace, test_channel: Channel
):
    response = await client.get(f"{BASE_URL}/{test_channel.id}")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == str(test_channel.id)
    assert data["name"] == "Test Channel"


async def test_get_channel_not_found(
    client: AsyncClient, test_workspace: Workspace
):
    fake_id = uuid.uuid4()
    response = await client.get(f"{BASE_URL}/{fake_id}")
    assert response.status_code == 404


async def test_update_channel_success(
    client: AsyncClient, test_workspace: Workspace, test_channel: Channel
):
    response = await client.put(
        f"{BASE_URL}/{test_channel.id}",
        json={"name": "Updated Channel", "channel_type": "slack"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "Updated Channel"
    assert data["channel_type"] == "slack"
    assert data["contact_value"] == "test@valaris.dev"


async def test_update_channel_not_found(
    client: AsyncClient, test_workspace: Workspace
):
    fake_id = uuid.uuid4()
    response = await client.put(
        f"{BASE_URL}/{fake_id}",
        json={"name": "Nope"},
    )
    assert response.status_code == 404


async def test_delete_channel_success(
    client: AsyncClient, test_workspace: Workspace, test_channel: Channel
):
    response = await client.delete(f"{BASE_URL}/{test_channel.id}")
    assert response.status_code == 204

    get_resp = await client.get(f"{BASE_URL}/{test_channel.id}")
    assert get_resp.status_code == 404


async def test_delete_channel_not_found(
    client: AsyncClient, test_workspace: Workspace
):
    fake_id = uuid.uuid4()
    response = await client.delete(f"{BASE_URL}/{fake_id}")
    assert response.status_code == 404
