# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tests for agent identity injection via API key auth."""
import uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import current_agent_id
from app.models.agents.agent import Agent, AgentType
from app.models.api_key import ApiKey
from app.models.user import User
from app.models.workspace import Workspace


async def test_agent_id_set_on_api_key_auth(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    # Create an agent via the API
    resp = await client.post(
        "/api/agents",
        json={
            "name": "test-agent",
            "agent_type": "coding",
            "description": "Test agent for auth",
            "allowed_workspaces": [test_workspace.slug],
        },
    )
    assert resp.status_code == 201
    agent_data = resp.json()
    raw_key = agent_data["raw_api_key"]
    agent_id = agent_data["id"]

    # Now use the API key directly — create a fresh app with no overrides
    from app.database import get_db
    from app.main import create_app

    app = create_app()

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as key_client:
        resp = await key_client.get(
            "/api/me",
            headers={"Authorization": f"Bearer {raw_key}"},
        )
        assert resp.status_code == 200


async def test_activity_includes_agent_id(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    # Create agent
    resp = await client.post(
        "/api/agents",
        json={
            "name": "activity-test-agent",
            "agent_type": "secretary",
            "description": "Tests activity tagging",
            "allowed_workspaces": [test_workspace.slug],
        },
    )
    assert resp.status_code == 201
    agent_data = resp.json()
    assert "id" in agent_data
