# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Opt-in trimming of two smaller list payloads: channel `metadata_json` and
agent `sensor_catalog`.

Both are unbounded JSON columns that no list surface renders. `sensor_catalog`
in particular is written BY the runner on every heartbeat and echoed back in
the heartbeat's own AgentRead response, so the trim is scoped to the LIST
endpoint only — /agents/me, /agents/{id} and the heartbeat response keep it.
"""

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent
from app.models.channels.channel import Channel, ChannelType
from app.models.user import User
from app.models.workspace import Workspace

BIG_METADATA = {"transcript": "z" * 4000, "webhook": {"url": "https://example.test"}}
SENSOR_CATALOG = [
    {"name": f"sensor_{i}", "description": "d" * 300, "params": {"a": 1}}
    for i in range(10)
]


async def _seed_channel(
    db_session: AsyncSession, workspace: Workspace, user: User
) -> Channel:
    channel = Channel(
        workspace_id=workspace.id,
        name="support",
        channel_type=ChannelType.email,
        contact_value="support@example.test",
        description="inbound",
        metadata_json=BIG_METADATA,
        created_by=user.id,
    )
    db_session.add(channel)
    await db_session.flush()
    return channel


async def test_channels_list_summary_drops_metadata(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    await _seed_channel(db_session, test_workspace, test_user)

    response = await client.get("/api/workspaces/default/channels?summary=true")

    assert response.status_code == 200
    row = response.json()[0]
    assert "metadata_json" not in row
    assert row["name"] == "support"
    assert row["contact_value"] == "support@example.test"


async def test_channels_list_default_stays_full(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """MCP list_channels forwards this response to an agent verbatim."""
    await _seed_channel(db_session, test_workspace, test_user)

    response = await client.get("/api/workspaces/default/channels")

    assert response.json()[0]["metadata_json"] == BIG_METADATA


async def test_channel_detail_keeps_metadata(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    channel = await _seed_channel(db_session, test_workspace, test_user)

    response = await client.get(
        f"/api/workspaces/default/channels/{channel.id}?summary=true"
    )

    assert response.json()["metadata_json"] == BIG_METADATA


async def test_agents_list_summary_drops_sensor_catalog(
    client: AsyncClient,
    db_session: AsyncSession,
    test_agent: Agent,
):
    test_agent.sensor_catalog = SENSOR_CATALOG
    await db_session.flush()

    response = await client.get("/api/agents?summary=true")

    assert response.status_code == 200
    row = next(r for r in response.json() if r["id"] == str(test_agent.id))
    assert "sensor_catalog" not in row
    assert row["name"] == "test-agent"


async def test_agents_list_default_stays_full(
    client: AsyncClient,
    db_session: AsyncSession,
    test_agent: Agent,
):
    test_agent.sensor_catalog = SENSOR_CATALOG
    await db_session.flush()

    response = await client.get("/api/agents")

    row = next(r for r in response.json() if r["id"] == str(test_agent.id))
    assert row["sensor_catalog"] == SENSOR_CATALOG


async def test_agent_detail_keeps_sensor_catalog(
    client: AsyncClient,
    db_session: AsyncSession,
    test_agent: Agent,
):
    """The runner's own reads (/agents/me, /agents/{id}, heartbeat response)
    resolve through the untrimmed schema — the trim is list-scoped."""
    test_agent.sensor_catalog = SENSOR_CATALOG
    await db_session.flush()

    response = await client.get(f"/api/agents/{test_agent.id}?summary=true")

    assert response.json()["sensor_catalog"] == SENSOR_CATALOG
