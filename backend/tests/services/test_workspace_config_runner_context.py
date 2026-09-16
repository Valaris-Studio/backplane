# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

from app.services.workspace_config import WorkspaceConfigService


async def test_runner_agent_context_reads_agents_and_teams_through_repositories():
    agent_id = UUID("390240a4-360a-4374-981a-61afb70aeb21")
    user_id = UUID("2af39fca-b932-44f5-ac36-83f5f4048501")
    workspace_id = UUID("4e90114c-4e19-4e62-a5d5-e295186747c4")
    db = SimpleNamespace(
        execute=AsyncMock(side_effect=AssertionError("service issued SQL"))
    )
    service = WorkspaceConfigService(db)  # type: ignore[arg-type]
    service.agent_repo.get_by_owner_and_id = AsyncMock(
        return_value=SimpleNamespace(
            id=agent_id,
            name="Runner",
            allowed_workspaces=["internal-projects"],
        )
    )
    service.team_repo.list_active_workspace_ids_for_agent = AsyncMock(
        return_value=[workspace_id]
    )

    context = await service.resolve_runner_agent_context(
        agent_id=agent_id,
        user_id=user_id,
        workspace_id=workspace_id,
        workspace_slug="internal-projects",
    )

    assert context.name == "Runner"
    assert context.has_workspace_binding is True
    service.agent_repo.get_by_owner_and_id.assert_awaited_once_with(user_id, agent_id)
    service.team_repo.list_active_workspace_ids_for_agent.assert_awaited_once_with(
        agent_id
    )
    db.execute.assert_not_awaited()
