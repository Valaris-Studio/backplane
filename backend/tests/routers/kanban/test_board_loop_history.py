# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Loop cross-run continuity — GET /loop/history + the budget_epoch stamp.

A crash-restart loop previously reset the runner's process-local `spent` and
iteration counters, letting a restart loop exceed the configured caps without
tripping them, and restarting `{{.Iteration}}` at 1 (note-title collisions —
a field agent worked around it by hand).

Design (resolves the card's open budget-epoch point):
  - `budget_epoch` is a SERVER-OWNED loop-config field stamped on every
    disabled→enabled transition (PUT or PATCH /state). Config edits while
    enabled do NOT move it; disabling preserves it. Never accepted from
    clients (LoopConfigPut extra="forbid").
  - `GET /loop/history` returns {iteration_count, spent_usd, budget_epoch}:
    iteration_count counts ALL loop_iteration executions for the board
    (iteration numbering stays monotonic across the board's life);
    spent_usd sums structured cost_usd SINCE the epoch (all-time when the
    epoch is null — conservative, money-safe). Server-side aggregation
    because the executions list endpoint is limit-capped, and a lower-bound
    sum on money would under-enforce the budget rail.
"""

from datetime import datetime

import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent, AgentType
from app.models.agents.execution import AgentExecution
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace


BASE_URL = "/api/workspaces/default/boards"


def _history_url(board: Board) -> str:
    return f"{BASE_URL}/{board.id}/loop/history"


def _loop_url(board: Board) -> str:
    return f"{BASE_URL}/{board.id}/loop"


@pytest_asyncio.fixture
async def loop_agent(db_session: AsyncSession, test_user: User) -> Agent:
    agent = Agent(
        name="history-agent",
        agent_type=AgentType.coding,
        description="loop history test agent",
        created_by_id=test_user.id,
        is_active=True,
    )
    db_session.add(agent)
    await db_session.flush()
    return agent


async def _iteration(
    db: AsyncSession,
    *,
    agent: Agent,
    workspace: Workspace,
    board: Board,
    started_at: datetime,
    cost_usd: float | None,
    action: str = "loop_iteration",
) -> AgentExecution:
    execution = AgentExecution(
        agent_id=agent.id,
        workspace_id=workspace.id,
        board_id=board.id,
        action=action,
        status="completed",
        started_at=started_at,
        input_summary="loop iteration n",
        cost_usd=cost_usd,
    )
    db.add(execution)
    await db.flush()
    return execution


async def test_history_empty_board_zeroes(
    client: AsyncClient, test_board: Board
):
    resp = await client.get(_history_url(test_board))
    assert resp.status_code == 200
    assert resp.json() == {
        "iteration_count": 0,
        "spent_usd": 0.0,
        "lifetime_spent_usd": 0.0,
        "budget_epoch": None,
    }


async def test_history_counts_all_iterations_and_sums_cost(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    loop_agent: Agent,
):
    for day, cost in ((1, 1.5), (2, 2.25), (3, None)):
        await _iteration(
            db_session,
            agent=loop_agent,
            workspace=test_workspace,
            board=test_board,
            started_at=datetime(2026, 8, day, 12, 0, 0),
            cost_usd=cost,
        )
    # A non-loop execution on the same board must not count.
    await _iteration(
        db_session,
        agent=loop_agent,
        workspace=test_workspace,
        board=test_board,
        started_at=datetime(2026, 8, 2, 12, 0, 0),
        cost_usd=99.0,
        action="implement",
    )

    resp = await client.get(_history_url(test_board))
    data = resp.json()
    assert data["iteration_count"] == 3
    assert data["spent_usd"] == 3.75  # null cost_usd rows count 0


async def test_history_spent_respects_budget_epoch(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    loop_agent: Agent,
):
    """spent_usd sums SINCE the epoch; iteration_count stays all-time —
    numbering is continuity metadata, money is per-run."""
    for day, cost in ((1, 10.0), (5, 2.0), (6, 3.0)):
        await _iteration(
            db_session,
            agent=loop_agent,
            workspace=test_workspace,
            board=test_board,
            started_at=datetime(2026, 8, day, 12, 0, 0),
            cost_usd=cost,
        )
    config = {
        "enabled": True,
        "provider": "",
        "model": "mid",
        "system_prompt": "",
        "loop_prompt": "x",
        "tools": [],
        "max_iterations": 25,
        "iteration_delay_seconds": 30,
        "iteration_timeout_seconds": 3600,
        "budget_usd": 20.0,
        "max_consecutive_failures": 3,
        "starvation_policy": "park",
        "loop_landing": "human",
        "disabled_reason": None,
        "version": 1,
        "updated_at": "2026-08-04T00:00:00",
        "budget_epoch": "2026-08-04T00:00:00",
    }
    test_board.loop_config = config
    await db_session.flush()

    resp = await client.get(_history_url(test_board))
    data = resp.json()
    assert data["iteration_count"] == 3
    assert data["spent_usd"] == 5.0  # only days 5 and 6, after the epoch
    assert data["budget_epoch"] == "2026-08-04T00:00:00"


async def test_history_nonexistent_board_404(client: AsyncClient):
    resp = await client.get(
        f"{BASE_URL}/00000000-0000-0000-0000-000000000000/loop/history"
    )
    assert resp.status_code == 404


# --- budget_epoch stamping ---------------------------------------------------


async def test_enable_via_put_stamps_budget_epoch(
    client: AsyncClient, test_board: Board
):
    resp = await client.put(
        _loop_url(test_board), json={"loop_prompt": "x", "enabled": True}
    )
    assert resp.status_code in (200, 201), resp.text
    assert resp.json()["budget_epoch"] is not None


async def test_disabled_first_put_has_null_epoch(
    client: AsyncClient, test_board: Board
):
    resp = await client.put(_loop_url(test_board), json={"loop_prompt": "x"})
    assert resp.json()["budget_epoch"] is None


async def test_edit_while_enabled_preserves_epoch(
    client: AsyncClient, test_board: Board
):
    first = await client.put(
        _loop_url(test_board), json={"loop_prompt": "x", "enabled": True}
    )
    epoch = first.json()["budget_epoch"]

    edited = await client.put(
        _loop_url(test_board), json={"max_iterations": 5}
    )
    assert edited.json()["budget_epoch"] == epoch, (
        "a config edit while enabled must NOT move the epoch — that would "
        "silently reset the budget"
    )


async def test_reenable_via_state_restamps_epoch(
    client: AsyncClient, test_board: Board
):
    first = await client.put(
        _loop_url(test_board), json={"loop_prompt": "x", "enabled": True}
    )
    epoch = first.json()["budget_epoch"]

    off = await client.patch(
        f"{_loop_url(test_board)}/state",
        json={"enabled": False, "reason": "pause"},
    )
    assert off.json()["budget_epoch"] == epoch, "disable preserves the epoch"

    on = await client.patch(
        f"{_loop_url(test_board)}/state", json={"enabled": True, "reason": ""}
    )
    assert on.json()["budget_epoch"] is not None
    assert on.json()["budget_epoch"] != epoch, (
        "re-enable starts a fresh budget epoch — this is the reset lever"
    )


async def test_put_rejects_client_supplied_budget_epoch(
    client: AsyncClient, test_board: Board
):
    resp = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "budget_epoch": "2026-01-01T00:00:00"},
    )
    assert resp.status_code == 422, "budget_epoch is server-owned"
