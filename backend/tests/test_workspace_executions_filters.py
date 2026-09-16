# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from datetime import datetime

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent, AgentType
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole


# ---------------------------------------------------------------------------
# Card ea43b848 — loop-mode live telemetry.
#
# BoardLoopDialog currently fetches ALL workspace executions and filters
# client-side on `action === "loop_iteration" && board_id === board.id`
# (see BoardLoopDialog.tsx). That's wasteful and, more importantly, it can
# never back a live WS-driven feed scoped to one board's loop iterations
# without shipping every other board's execution history to the client.
#
# The locked design adds OPTIONAL `board_id` and `action` query params to
# GET /api/workspaces/{slug}/executions, applied server-side alongside the
# existing status/agent_id/role/card_id filters and the same backward-compat
# guarantee: omitting them must not change today's behavior.
# ---------------------------------------------------------------------------


async def _seed_two_boards(
    db_session: AsyncSession,
    workspace: Workspace,
    board_a: Board,
    user: User,
) -> tuple[Agent, Board, list[AgentExecution]]:
    """One agent, board_a (the fixture board) plus a second board_b, with a
    mix of loop_iteration and other actions split across both."""
    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=user.id)
    db_session.add(agent)
    await db_session.flush()

    board_b = Board(
        workspace_id=workspace.id,
        name="Board B",
        slug="board-b",
        created_by=user.id,
    )
    db_session.add(board_b)
    await db_session.flush()

    executions = [
        AgentExecution(
            agent_id=agent.id,
            workspace_id=workspace.id,
            board_id=board_a.id,
            action="loop_iteration",
            status=ExecutionStatus.completed,
            input_summary="iterate a-1",
            started_at=datetime(2026, 6, 1, 0, 0, 0),
        ),
        AgentExecution(
            agent_id=agent.id,
            workspace_id=workspace.id,
            board_id=board_a.id,
            action="loop_iteration",
            status=ExecutionStatus.running,
            input_summary="iterate a-2",
            started_at=datetime(2026, 6, 1, 1, 0, 0),
        ),
        AgentExecution(
            agent_id=agent.id,
            workspace_id=workspace.id,
            board_id=board_a.id,
            action="implement",
            status=ExecutionStatus.completed,
            input_summary="board a non-loop work",
            started_at=datetime(2026, 6, 1, 2, 0, 0),
        ),
        AgentExecution(
            agent_id=agent.id,
            workspace_id=workspace.id,
            board_id=board_b.id,
            action="loop_iteration",
            status=ExecutionStatus.completed,
            input_summary="iterate b-1",
            started_at=datetime(2026, 6, 1, 3, 0, 0),
        ),
        # A RUNNING loop_iteration on board_b — same action+status as board_a's
        # running row. Without a working board_id filter, `action=loop_iteration
        # &status=running` alone would still (wrongly) narrow to exactly one row
        # by coincidence; this second running row on the OTHER board forces the
        # composition test to actually depend on board_id doing real work.
        AgentExecution(
            agent_id=agent.id,
            workspace_id=workspace.id,
            board_id=board_b.id,
            action="loop_iteration",
            status=ExecutionStatus.running,
            input_summary="iterate b-2 running",
            started_at=datetime(2026, 6, 1, 3, 30, 0),
        ),
        AgentExecution(
            agent_id=agent.id,
            workspace_id=workspace.id,
            board_id=None,
            action="loop_iteration",
            status=ExecutionStatus.completed,
            input_summary="board-less loop row (shouldn't exist in practice, but pin it anyway)",
            started_at=datetime(2026, 6, 1, 4, 0, 0),
        ),
    ]
    db_session.add_all(executions)
    await db_session.flush()
    return agent, board_b, executions


async def test_list_workspace_executions_filter_by_board_id(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    await _seed_two_boards(db_session, test_workspace, test_board, test_user)

    response = await client.get(
        f"/api/workspaces/default/executions?board_id={test_board.id}"
    )
    assert response.status_code == 200
    data = response.json()
    actions = sorted(e["action"] for e in data)
    # board_a has 2 loop_iteration + 1 implement row = 3 total; board_b's and
    # the board-less row must not leak in.
    assert actions == [
        "implement",
        "loop_iteration",
        "loop_iteration",
    ], f"board_id filter must return exactly board_a's 3 rows, got {actions}"
    assert all(e["board_id"] == str(test_board.id) for e in data)


async def test_list_workspace_executions_filter_by_action(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    await _seed_two_boards(db_session, test_workspace, test_board, test_user)

    response = await client.get(
        "/api/workspaces/default/executions?action=loop_iteration"
    )
    assert response.status_code == 200
    data = response.json()
    # 2 on board_a + 2 on board_b + 1 board-less = 5 loop_iteration rows total
    # in the workspace; the "implement" row must be excluded.
    assert len(data) == 5, f"expected 5 loop_iteration rows, got {len(data)}"
    assert all(e["action"] == "loop_iteration" for e in data)


async def test_list_workspace_executions_filter_by_board_id_and_action(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    await _seed_two_boards(db_session, test_workspace, test_board, test_user)

    response = await client.get(
        f"/api/workspaces/default/executions"
        f"?board_id={test_board.id}&action=loop_iteration"
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 2, (
        f"board_id+action must return exactly board_a's 2 loop_iteration rows, "
        f"got {len(data)} ({[e['action'] for e in data]})"
    )
    assert all(e["action"] == "loop_iteration" for e in data)
    assert all(e["board_id"] == str(test_board.id) for e in data)


async def test_list_workspace_executions_no_params_unchanged(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """Backward compat: omitting board_id/action must return every row in the
    workspace exactly as before these filters existed — 6 rows total across
    both boards + the board-less row."""
    await _seed_two_boards(db_session, test_workspace, test_board, test_user)

    response = await client.get("/api/workspaces/default/executions")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 6, f"expected all 6 unfiltered rows, got {len(data)}"


async def test_list_workspace_executions_board_id_composes_with_status(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    await _seed_two_boards(db_session, test_workspace, test_board, test_user)

    response = await client.get(
        f"/api/workspaces/default/executions"
        f"?board_id={test_board.id}&action=loop_iteration&status=running"
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1, (
        f"board_id+action+status must narrow to the single running loop "
        f"iteration on board_a, got {len(data)}"
    )
    assert data[0]["status"] == "running"


async def test_list_workspace_executions_filter_by_board_id_excludes_other_workspace(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """No cross-workspace leak: a board_id that belongs to another workspace
    the caller is ALSO a member of must not surface via this workspace's
    endpoint — the workspace_id scope from get_workspace, not just board_id,
    must gate the query."""
    other_ws = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(other_ws)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=other_ws.id,
            user_id=test_user.id,
            role=WorkspaceRole.owner,
        )
    )
    other_board = Board(
        workspace_id=other_ws.id,
        name="Other WS Board",
        slug="other-board",
        created_by=test_user.id,
    )
    db_session.add(other_board)
    await db_session.flush()

    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    db_session.add_all(
        [
            AgentExecution(
                agent_id=agent.id,
                workspace_id=test_workspace.id,
                board_id=test_board.id,
                action="loop_iteration",
                status=ExecutionStatus.completed,
                input_summary="mine",
            ),
            AgentExecution(
                agent_id=agent.id,
                workspace_id=other_ws.id,
                board_id=other_board.id,
                action="loop_iteration",
                status=ExecutionStatus.completed,
                input_summary="theirs",
            ),
        ]
    )
    await db_session.flush()

    # Querying the `default` workspace's executions endpoint with the OTHER
    # workspace's board_id must not return that board's rows — the endpoint
    # is scoped to `default` via get_workspace regardless of what board_id
    # is passed.
    response = await client.get(
        f"/api/workspaces/default/executions?board_id={other_board.id}"
    )
    assert response.status_code == 200
    assert response.json() == [], (
        "board_id belonging to a different workspace must return empty, "
        "not that workspace's rows"
    )
