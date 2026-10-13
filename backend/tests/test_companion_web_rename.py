# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""DK-WEB B8: the owner renames a device from the web."""

from unittest.mock import AsyncMock, patch

import pytest

from app.core.event_bus import event_bus
from tests.test_agent_sessions import as_user
from tests.test_companion import ME, enroll, installation

__all__ = ["installation"]  # fixture re-export


def rename(client, installation_id, body):
    return client.patch(f"{ME}/{installation_id}", json=body)


async def test_owner_renames_a_device_and_everyone_watching_hears_it(
    client, installation, test_workspace
):
    sibling = (await enroll(client, name="Other laptop")).json()
    installation_id = installation["installation_id"]
    with patch.object(event_bus, "publish", new_callable=AsyncMock) as publish:
        renamed = await rename(client, installation_id, {"name": "  Work MacBook  "})
        assert renamed.status_code == 200, renamed.text
        assert renamed.headers["cache-control"] == "no-store"
        body = renamed.json()
        assert body["installation_id"] == installation_id
        assert body["name"] == "Work MacBook"
        assert "device_token" not in body and "token_hash" not in body
        [call] = [
            call
            for call in publish.await_args_list
            if call.kwargs["event_type"] == "companion_installation.updated"
        ]
        assert call.kwargs["payload"]["reason"] == "renamed"

        publish.reset_mock()
        again = await rename(client, installation_id, {"name": "Work MacBook"})
        assert again.status_code == 200
        assert publish.await_args_list == []

    names = {
        item["installation_id"]: item["name"] for item in (await client.get(ME)).json()
    }
    assert names == {
        installation_id: "Work MacBook",
        sibling["installation_id"]: "Other laptop",
    }


@pytest.mark.parametrize(
    "body",
    [
        {"name": ""},
        {"name": "   "},
        {"name": "x" * 201},
        {"name": "tab\tname"},
        {},
        {"name": "ok", "platform": "linux"},
    ],
)
async def test_rename_rejects_a_bad_name(client, installation, body):
    response = await rename(client, installation["installation_id"], body)
    assert response.status_code == 422


async def test_only_the_owner_can_rename_and_never_an_agent_key(
    client,
    agent_client,
    installation_key_client,
    db_session,
    installation,
    second_user,
):
    installation_id = installation["installation_id"]
    async with as_user(db_session, second_user) as other:
        response = await rename(other, installation_id, {"name": "Mine now"})
        assert response.status_code == 404
    for key_client in (agent_client, installation_key_client):
        response = await rename(key_client, installation_id, {"name": "Agent"})
        assert response.status_code == 403
    response = await rename(
        client, "00000000-0000-0000-0000-000000000000", {"name": "x"}
    )
    assert response.status_code == 404
    names = {
        item["installation_id"]: item["name"] for item in (await client.get(ME)).json()
    }
    assert names[installation_id] == "Synthetic laptop"


async def test_a_signed_out_device_cannot_be_renamed(client, installation):
    installation_id = installation["installation_id"]
    assert (await client.delete(f"{ME}/{installation_id}")).status_code == 200
    response = await rename(client, installation_id, {"name": "Too late"})
    assert response.status_code == 409
