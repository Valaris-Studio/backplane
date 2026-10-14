# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from contextlib import asynccontextmanager
from types import SimpleNamespace

from sqlalchemy import select

from app.models.agents.agent import Agent
from app.routers import events
from tests.test_agent_workspace_scope import _make_agent_with_key


async def test_websocket_denies_a_deactivated_agents_key_like_http(
    db_session, test_user, monkeypatch
):
    """A deactivated agent's key must not fall back to its creator's identity:
    it would then receive the creator's private session events."""
    raw = await _make_agent_with_key(db_session, test_user, allowed_workspaces=None)

    @asynccontextmanager
    async def session():
        yield db_session

    monkeypatch.setattr(events, "async_session", session)
    handshake = SimpleNamespace(
        headers={"authorization": "Bearer " + raw}, query_params={}, cookies={}
    )
    user, agent_id = await events._authenticate_ws(handshake)
    assert user.id == test_user.id and agent_id is not None

    agent = await db_session.scalar(select(Agent).where(Agent.id == agent_id))
    agent.is_active = False
    await db_session.flush()
    assert await events._authenticate_ws(handshake) == (None, None)
