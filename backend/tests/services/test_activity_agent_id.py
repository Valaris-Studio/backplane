# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.agents.agent import Agent, AgentType
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace
from app.services.activity import ActivityService


async def test_record_activity_with_agent_id(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_board: Board
):
    """ActivityService.record should capture current_agent_id when set."""
    from app.core.auth import current_agent_id

    agent = Agent(
        name="test-coder",
        agent_type=AgentType.coding,
        created_by_id=test_user.id,
    )
    db_session.add(agent)
    await db_session.flush()

    token = current_agent_id.set(agent.id)
    try:
        service = ActivityService(db_session)
        await service.record(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.card,
            entity_id=uuid.uuid4(),
            action=ActivityAction.created,
            board_id=test_board.id,
            summary="Agent created card",
        )
    finally:
        current_agent_id.reset(token)

    activities = await service.list_workspace_activity(test_workspace.id)
    assert len(activities) == 1
    assert activities[0].agent_id == agent.id


async def test_record_activity_without_agent_id(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """Activity agent_id should be None when no agent context is set."""
    service = ActivityService(db_session)
    await service.record(
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
        entity_type=ActivityEntityType.board,
        entity_id=uuid.uuid4(),
        action=ActivityAction.created,
        summary="Human created board",
    )

    activities = await service.list_workspace_activity(test_workspace.id)
    assert len(activities) == 1
    assert activities[0].agent_id is None


async def test_activity_schema_includes_agent_id(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """ActivityRead schema should expose agent_id."""
    from app.schemas.activity import ActivityRead

    agent = Agent(
        name="test-manager",
        agent_type=AgentType.manager,
        created_by_id=test_user.id,
    )
    db_session.add(agent)
    await db_session.flush()

    activity = Activity(
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
        entity_type=ActivityEntityType.board,
        entity_id=uuid.uuid4(),
        action=ActivityAction.created,
        summary="Agent activity",
        agent_id=agent.id,
    )
    db_session.add(activity)
    await db_session.flush()

    schema = ActivityRead.model_validate(activity)
    assert schema.agent_id == agent.id


async def test_activity_api_returns_agent_id(
    client, db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """GET /history should include agent_id in response."""
    from httpx import AsyncClient

    agent = Agent(
        name="test-reviewer",
        agent_type=AgentType.reviewer,
        created_by_id=test_user.id,
    )
    db_session.add(agent)
    await db_session.flush()

    db_session.add(Activity(
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
        entity_type=ActivityEntityType.card,
        entity_id=uuid.uuid4(),
        action=ActivityAction.created,
        summary="Agent review",
        agent_id=agent.id,
    ))
    await db_session.flush()

    response = await client.get("/api/workspaces/default/history")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["agent_id"] == str(agent.id)


async def test_filter_activities_by_agent_id(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """Should be able to filter activities by agent_id."""
    agent = Agent(
        name="filter-agent",
        agent_type=AgentType.coding,
        created_by_id=test_user.id,
    )
    db_session.add(agent)
    await db_session.flush()

    # Activity by agent
    db_session.add(Activity(
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
        entity_type=ActivityEntityType.card,
        entity_id=uuid.uuid4(),
        action=ActivityAction.created,
        summary="Agent activity",
        agent_id=agent.id,
    ))
    # Activity by human (no agent_id)
    db_session.add(Activity(
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
        entity_type=ActivityEntityType.card,
        entity_id=uuid.uuid4(),
        action=ActivityAction.created,
        summary="Human activity",
    ))
    await db_session.flush()

    service = ActivityService(db_session)
    results = await service.list_workspace_activity(
        test_workspace.id, agent_id=agent.id
    )
    assert len(results) == 1
    assert results[0].summary == "Agent activity"
    assert results[0].agent_id == agent.id
