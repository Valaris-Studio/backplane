# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Enforce the unified config.changed payload contract across all four publishers.

Contract: every config.changed event carries
    {entity: str, action: "created"|"updated"|"deleted", entity_id: str}

Previously each publisher used its own id field name (agent_id, team_id,
config_id, workspace_id) and WorkspaceConfigService omitted `action` entirely,
so consumers could not rely on a uniform shape. Yesterday's events taxonomy
audit (docs/events.md) flagged this divergence.
"""
import uuid
from unittest.mock import AsyncMock, patch

from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.models.agents.agent import Agent, AgentType
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.agents.prompt_config import (
    PromptConfigCreate,
    PromptConfigUpdate,
)
from app.services.agents.agent import AgentService
from app.services.agents.prompt_config import PromptConfigService
from app.services.agents.team import TeamService
from app.services.workspace_config import WorkspaceConfigService


def _event_type(call) -> str:
    return call.kwargs.get("event_type") or (call.args[0] if call.args else "")


def _payload(call) -> dict:
    return call.kwargs.get("payload") or (call.args[1] if len(call.args) > 1 else {})


def _config_changed_calls(mock_bus):
    return [
        c for c in mock_bus.publish.await_args_list
        if _event_type(c) == events.CONFIG_CHANGED
    ]


async def test_agent_deactivate_publishes_unified_config_changed(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    agent = Agent(
        name="unified-agent",
        agent_type=AgentType.coding,
        description="",
        created_by_id=test_user.id,
        is_active=True,
        allowed_workspaces=[test_workspace.slug],
    )
    db_session.add(agent)
    await db_session.flush()

    with patch("app.services.agents.agent.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()
        service = AgentService(db_session)
        await service.deactivate_agent(agent.id, test_user.id)

        calls = _config_changed_calls(mock_bus)
        assert len(calls) == 1
        payload = _payload(calls[0])
        assert payload == {
            "entity": "agent",
            "action": "updated",
            "entity_id": str(agent.id),
        }


async def test_team_update_publishes_unified_config_changed(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    from app.schemas.agents.team import TeamCreate, TeamUpdate

    service = TeamService(db_session)
    team, _ = await service.create_team(
        test_workspace.id,
        TeamCreate(name="original", slug="original"),
        test_user.id,
    )

    with patch("app.services.agents.team.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()
        await service.update_team(team.id, TeamUpdate(name="renamed"))

        calls = _config_changed_calls(mock_bus)
        assert len(calls) == 1
        payload = _payload(calls[0])
        assert payload == {
            "entity": "team",
            "action": "updated",
            "entity_id": str(team.id),
        }


async def test_prompt_config_create_update_delete_publish_unified_payloads(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    service = PromptConfigService(db_session)
    data = PromptConfigCreate(
        name="Discover",
        slug="discover",
        stage="discover",
        content="Initial",
        team_role="orchestrator",
    )

    with patch("app.services.agents.prompt_config.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()
        created = await service.create_config(test_workspace.id, data, test_user.id)
        calls = _config_changed_calls(mock_bus)
        assert len(calls) == 1
        assert _payload(calls[0]) == {
            "entity": "prompt_config",
            "action": "created",
            "entity_id": str(created.id),
        }

    with patch("app.services.agents.prompt_config.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()
        await service.update_config(
            created.id,
            PromptConfigUpdate(content="Updated"),
            workspace_id=test_workspace.id,
        )
        calls = _config_changed_calls(mock_bus)
        assert len(calls) == 1
        assert _payload(calls[0]) == {
            "entity": "prompt_config",
            "action": "updated",
            "entity_id": str(created.id),
        }

    with patch("app.services.agents.prompt_config.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()
        await service.delete_config(created.id, workspace_id=test_workspace.id)
        calls = _config_changed_calls(mock_bus)
        assert len(calls) == 1
        assert _payload(calls[0]) == {
            "entity": "prompt_config",
            "action": "deleted",
            "entity_id": str(created.id),
        }


async def test_workspace_config_update_publishes_unified_config_changed(
    db_session: AsyncSession,
    test_workspace: Workspace,
):
    from app.schemas.workspace_config import WorkspaceConfigUpdate

    service = WorkspaceConfigService(db_session)

    with patch("app.services.workspace_config.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()
        await service.update_config(
            test_workspace.id,
            WorkspaceConfigUpdate(pipeline_config={"stages": []}),
        )

        calls = _config_changed_calls(mock_bus)
        assert len(calls) == 1
        payload = _payload(calls[0])
        assert payload == {
            "entity": "workspace_config",
            "action": "updated",
            "entity_id": str(test_workspace.id),
        }
