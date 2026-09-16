# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Opt-in trimming of the executions LIST payload (`?summary=true`).

Every list row ships the full rendered LLM prompt (`input_prompt`, often tens
of KB) and its eager-loaded `tool_invocations[]`, while no list UI renders
either — the detail page fetches them from GET /executions/{id}, whose query
key is disjoint from the list's, so nothing is seeded from the list response.

The trim is OPT-IN for the same reason board detail's is (routers/kanban/
boards.py): the MCP `list_executions` tool and any other unaware consumer
serialize whatever the backend hands them, so the DEFAULT response must stay
byte-identical. `summary=true` is the frontend's explicit request.

`tool_calls_count` and the two summaries deliberately SURVIVE the trim:
ExecutionTimeline renders the count badge, and tool_calls_count is a scalar
column, not a derivation of the trimmed relationship.
"""

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent, AgentType
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.agents.tool_invocation import ToolInvocation
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace

PROMPT_BODY = "You are a coding agent.\n" * 500


async def _seed_execution_with_prompt_and_tools(
    db_session: AsyncSession,
    workspace: Workspace,
    board: Board,
    user: User,
) -> tuple[Agent, AgentExecution]:
    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=user.id)
    db_session.add(agent)
    await db_session.flush()

    execution = AgentExecution(
        agent_id=agent.id,
        workspace_id=workspace.id,
        board_id=board.id,
        action="implement",
        status=ExecutionStatus.completed,
        input_summary="implement card",
        output_summary="done",
        input_prompt=PROMPT_BODY,
        tool_calls_count=3,
        role="implementer",
    )
    db_session.add(execution)
    await db_session.flush()

    db_session.add_all(
        ToolInvocation(
            execution_id=execution.id,
            tool_name=f"tool_{i}",
            arguments_summary="a" * 200,
            result_summary="r" * 200,
            position=i,
        )
        for i in range(3)
    )
    await db_session.flush()
    return agent, execution


async def test_workspace_executions_summary_drops_prompt_and_invocations(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    await _seed_execution_with_prompt_and_tools(
        db_session, test_workspace, test_board, test_user
    )

    response = await client.get("/api/workspaces/default/executions?summary=true")

    assert response.status_code == 200
    row = response.json()[0]
    assert "input_prompt" not in row
    assert "tool_invocations" not in row


async def test_workspace_executions_summary_keeps_scalars(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """The trim removes the two heavy fields and NOTHING else — the timeline
    renders the tool-call badge from tool_calls_count and the row body from
    the summaries, so losing any of them would be a visible regression."""
    await _seed_execution_with_prompt_and_tools(
        db_session, test_workspace, test_board, test_user
    )

    response = await client.get("/api/workspaces/default/executions?summary=true")

    row = response.json()[0]
    assert row["tool_calls_count"] == 3
    assert row["input_summary"] == "implement card"
    assert row["output_summary"] == "done"
    assert row["status"] == "completed"
    assert row["role"] == "implementer"
    assert row["cards_affected_detail"] == []


async def test_workspace_executions_default_stays_full(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """The MCP list_executions tool and the runner see the DEFAULT response.
    An unaware consumer must not lose a field it never asked to drop."""
    await _seed_execution_with_prompt_and_tools(
        db_session, test_workspace, test_board, test_user
    )

    response = await client.get("/api/workspaces/default/executions")

    row = response.json()[0]
    assert row["input_prompt"] == PROMPT_BODY
    assert len(row["tool_invocations"]) == 3


async def test_workspace_executions_summary_false_stays_full(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    await _seed_execution_with_prompt_and_tools(
        db_session, test_workspace, test_board, test_user
    )

    response = await client.get("/api/workspaces/default/executions?summary=false")

    row = response.json()[0]
    assert row["input_prompt"] == PROMPT_BODY
    assert len(row["tool_invocations"]) == 3


async def test_workspace_executions_summary_preserves_total_count_header(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """Trimming is a response-shape concern; the pager contract is unaffected."""
    await _seed_execution_with_prompt_and_tools(
        db_session, test_workspace, test_board, test_user
    )

    response = await client.get(
        "/api/workspaces/default/executions?summary=true&limit=10"
    )

    assert response.headers["X-Total-Count"] == "1"


async def test_workspace_execution_detail_ignores_summary(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """The detail endpoint is the ONLY source of the prompt + invocations —
    it must stay full no matter what the caller passes."""
    _, execution = await _seed_execution_with_prompt_and_tools(
        db_session, test_workspace, test_board, test_user
    )

    response = await client.get(
        f"/api/workspaces/default/executions/{execution.id}?summary=true"
    )

    body = response.json()
    assert body["input_prompt"] == PROMPT_BODY
    assert len(body["tool_invocations"]) == 3


async def test_summary_skips_tool_invocation_eager_load(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """The DB win, not just the wire win: the summary path must not run the
    selectinload for tool_invocations. The relationship is lazy="raise", so an
    un-eager-loaded row raises on attribute access — asserting the trimmed
    response serializes at all proves the load was skipped AND that no
    serializer touched the relationship.
    """
    await _seed_execution_with_prompt_and_tools(
        db_session, test_workspace, test_board, test_user
    )
    db_session.expunge_all()

    response = await client.get("/api/workspaces/default/executions?summary=true")

    assert response.status_code == 200
    assert len(response.json()) == 1


async def test_agent_executions_summary_trims_rows(
    agent_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
):
    execution = AgentExecution(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="implement",
        status=ExecutionStatus.completed,
        input_summary="implement card",
        input_prompt=PROMPT_BODY,
        tool_calls_count=2,
    )
    db_session.add(execution)
    await db_session.flush()

    trimmed = await agent_client.get(
        f"/api/agents/{test_agent.id}/executions?summary=true"
    )
    full = await agent_client.get(f"/api/agents/{test_agent.id}/executions")

    assert "input_prompt" not in trimmed.json()[0]
    assert trimmed.json()[0]["tool_calls_count"] == 2
    assert full.json()[0]["input_prompt"] == PROMPT_BODY


async def test_agent_executions_paginates(
    agent_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    test_agent: Agent,
):
    """This endpoint had no paging at all — it returned the repository's
    hardcoded newest-50 with no way to reach row 51."""
    db_session.add_all(
        AgentExecution(
            agent_id=test_agent.id,
            workspace_id=test_workspace.id,
            action="implement",
            status=ExecutionStatus.completed,
            input_summary=f"run {i}",
        )
        for i in range(12)
    )
    await db_session.flush()

    first = await agent_client.get(
        f"/api/agents/{test_agent.id}/executions?limit=5&offset=0"
    )
    second = await agent_client.get(
        f"/api/agents/{test_agent.id}/executions?limit=5&offset=5"
    )

    first_ids = [r["id"] for r in first.json()]
    second_ids = [r["id"] for r in second.json()]
    assert len(first_ids) == 5
    assert len(second_ids) == 5
    assert not set(first_ids) & set(second_ids)


async def test_agent_executions_limit_is_capped(
    agent_client: AsyncClient,
    test_agent: Agent,
):
    """Mirrors the workspace endpoint's le=200 so a retry-happy agent can't
    ask for the whole append-only history in one request."""
    response = await agent_client.get(
        f"/api/agents/{test_agent.id}/executions?limit=5000"
    )

    assert response.status_code == 422
