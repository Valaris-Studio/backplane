# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.models.agents.agent import Agent
from tests.runner_fixture_database import sealed_database
from tests.test_agent_workspace_scope import _make_agent_with_key


@pytest.mark.slow
async def test_artifact_fixture_websocket_auth_uses_same_disposable_database(
    db_engine, db_session, test_user, test_workspace, monkeypatch
):
    from app import database
    from app.routers import events
    from app.services import api_key

    raw = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=["default"]
    )
    agent = await db_session.scalar(select(Agent).where(Agent.name == "scoped-agent"))
    await db_session.commit()
    with sealed_database(monkeypatch, db_engine) as factory:
        assert (
            database.async_session
            is events.async_session
            is api_key.async_session
            is factory
        )
        assert factory.kw["bind"] is db_engine
        user, agent_id = await events._authenticate_ws(
            SimpleNamespace(headers={"authorization": "Bearer " + raw}, query_params={})
        )
        assert user.id == test_user.id
        assert agent_id == agent.id


async def test_artifact_fixture_rejects_other_engine_before_driver_connect(
    db_engine, monkeypatch
):
    import asyncpg

    connect = AsyncMock(side_effect=AssertionError("driver must never be reached"))
    monkeypatch.setattr(asyncpg, "connect", connect)
    foreign = create_async_engine("postgresql+asyncpg://fixture@127.0.0.1:1/never")
    try:
        with sealed_database(monkeypatch, db_engine):
            with pytest.raises(
                AssertionError, match="refused a foreign database connection"
            ):
                async with AsyncSession(foreign) as session:
                    await session.execute(text("SELECT 1"))
        connect.assert_not_called()
    finally:
        await foreign.dispose()
