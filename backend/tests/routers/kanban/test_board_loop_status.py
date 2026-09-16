# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Loop status truth layer — GET /loop/status (card a32550aa). RED phase.

Sibling of /loop/readiness and /loop/history: one endpoint that answers
"what is the loop actually doing right now?" without the frontend having to
stitch config + executions + agent liveness itself. Unlike GET /loop, this
endpoint NEVER 404s for an unconfigured loop — unconfigured IS a state
(`off`), and 404 stays reserved for board-not-found.

State derivation pinned here:

  off        — loop_config absent OR enabled=false. Precedence: off WINS even
               while an iteration is in-flight (has_inflight_iteration still
               reports the in-flight fact truthfully).
  running    — enabled + an in-flight execution for THIS board:
               action='loop_iteration', status in (started, running),
               completed_at IS NULL.
  waiting    — enabled, no in-flight iteration, and at least one BOUND agent
               whose liveness is `alive`. Bound = member of an AgentTeam with
               board_id = this board — NEVER derived from
               health_current_board_id.
  unattended — enabled, no in-flight iteration, zero bound agents alive
               (no teams, or every bound agent stale/unknown).

Counters: bound_agent_count counts ALL team-bound agents regardless of
liveness; alive_agent_count only the heartbeat-alive ones (≤90s, the
compute_liveness threshold). `actionable` comes from the existing readiness
computation (ready_count > 0). spent/budget passthrough mirrors /loop/history.
"""

from datetime import datetime, timedelta

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.main import create_app
from app.models.agents.agent import Agent, AgentType
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.agents.team import AgentTeam, AgentTeamMember
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column, ColumnType
from app.models.user import User
from app.models.workspace import Workspace
from app.utils import utcnow


BASE = "/api/workspaces/default/boards"

# The complete wire object — pinned as a set so a field silently dropped from
# the response fails loudly (same doctrine as ALL_LOOP_FIELDS in
# test_board_loop.py).
STATUS_KEYS = {
    "state",
    "enabled",
    "disabled_reason",
    # The last stop off the durable transition timeline (card 6f3ca6e5).
    # Unlike disabled_reason these SURVIVE a re-enable, which is what lets the
    # chip still explain the previous run while the next one is turning.
    # Pinned in test_board_loop_transitions.py.
    "last_stop_reason",
    "last_stop_at",
    # Runner-reported park reason (card 442ff0f2); null in every non-parked
    # state. The parked state itself is pinned in test_board_loop_parked_state.
    "park_reason",
    "actionable",
    "has_inflight_iteration",
    "last_iteration_at",
    "last_iteration_status",
    "bound_agent_count",
    "alive_agent_count",
    "spent_usd",
    "budget_usd",
}

# Mirrors FULL_PUT_BODY in test_board_loop.py — enabled with budget_usd 7.5.
ENABLED_PUT_BODY = {
    "enabled": True,
    "provider": "codex-cli",
    "model": "premium",
    "system_prompt": "You are the maintenance agent.",
    "loop_prompt": "Iteration {{.Iteration}}: make progress.",
    "tools": [],
    "max_iterations": 10,
    "iteration_delay_seconds": 5,
    "iteration_timeout_seconds": 600,
    "budget_usd": 7.5,
    "max_consecutive_failures": 2,
}


def _status_url(board: Board) -> str:
    return f"{BASE}/{board.id}/loop/status"


async def _enable_loop(client: AsyncClient, board: Board) -> None:
    resp = await client.put(f"{BASE}/{board.id}/loop", json=ENABLED_PUT_BODY)
    assert resp.status_code in (200, 201), resp.text


async def _disable_loop(client: AsyncClient, board: Board, reason: str) -> None:
    resp = await client.patch(
        f"{BASE}/{board.id}/loop/state", json={"enabled": False, "reason": reason}
    )
    assert resp.status_code == 200, resp.text


async def _make_team(
    db: AsyncSession, workspace: Workspace, board: Board, user: User
) -> AgentTeam:
    team = AgentTeam(
        name="loop crew",
        workspace_id=workspace.id,
        board_id=board.id,
        created_by_id=user.id,
    )
    db.add(team)
    await db.flush()
    return team


async def _bind_agent(
    db: AsyncSession,
    team: AgentTeam,
    user: User,
    *,
    name: str,
    last_seen_at: datetime | None,
) -> Agent:
    agent = Agent(
        name=name,
        agent_type=AgentType.coding,
        created_by_id=user.id,
        is_active=True,
        last_seen_at=last_seen_at,
    )
    db.add(agent)
    await db.flush()
    db.add(AgentTeamMember(team_id=team.id, agent_id=agent.id))
    await db.flush()
    return agent


async def _unbound_agent(
    db: AsyncSession, user: User, *, name: str, **kwargs
) -> Agent:
    agent = Agent(
        name=name,
        agent_type=AgentType.coding,
        created_by_id=user.id,
        is_active=True,
        **kwargs,
    )
    db.add(agent)
    await db.flush()
    return agent


def _iteration(
    agent: Agent,
    workspace: Workspace,
    board: Board,
    *,
    status: ExecutionStatus,
    started_at: datetime,
    completed_at: datetime | None = None,
    cost_usd: float | None = None,
    action: str = "loop_iteration",
) -> AgentExecution:
    return AgentExecution(
        agent_id=agent.id,
        workspace_id=workspace.id,
        board_id=board.id,
        action=action,
        status=status,
        started_at=started_at,
        completed_at=completed_at,
        cost_usd=cost_usd,
        input_summary="loop iteration",
    )


# --- unconfigured / off ------------------------------------------------------


async def test_get_loop_status_unconfigured_returns_off_not_404(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """Unconfigured IS a state. 404 stays reserved for board-not-found — the
    dashboard must be able to render every board's loop state, configured or
    not, without special-casing."""
    assert test_board.loop_config is None
    resp = await client.get(_status_url(test_board))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert set(data) == STATUS_KEYS, (
        f"contract drift: {sorted(set(data) ^ STATUS_KEYS)}"
    )
    assert data["state"] == "off"
    assert data["enabled"] is False
    assert data["disabled_reason"] is None
    assert data["has_inflight_iteration"] is False
    assert data["last_iteration_at"] is None
    assert data["last_iteration_status"] is None
    assert data["bound_agent_count"] == 0
    assert data["alive_agent_count"] == 0
    assert data["spent_usd"] == 0.0
    assert data["budget_usd"] is None


async def test_get_loop_status_disabled_config_returns_off_with_reason(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await _enable_loop(client, test_board)
    await _disable_loop(client, test_board, "budget rail")

    resp = await client.get(_status_url(test_board))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["state"] == "off"
    assert data["enabled"] is False
    assert data["disabled_reason"] == "budget rail"
    # Config exists — budget is known even while off.
    assert data["budget_usd"] == 7.5


async def test_get_loop_status_off_wins_over_inflight_iteration(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """Precedence pin: a disabled loop reads `off` even while an iteration is
    still in-flight — but the in-flight FACT is reported truthfully so the UI
    can say "off (an iteration is still draining)"."""
    await _enable_loop(client, test_board)
    await _disable_loop(client, test_board, "operator stop")
    agent = await _unbound_agent(db_session, test_user, name="drainer")
    db_session.add(
        _iteration(
            agent, test_workspace, test_board,
            status=ExecutionStatus.running, started_at=utcnow(),
        )
    )
    await db_session.flush()

    resp = await client.get(_status_url(test_board))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["state"] == "off"
    assert data["has_inflight_iteration"] is True


# --- running -----------------------------------------------------------------


@pytest.mark.parametrize(
    "inflight_status",
    [ExecutionStatus.started, ExecutionStatus.running],
    ids=["started", "running"],
)
async def test_get_loop_status_running_with_inflight_iteration(
    inflight_status: ExecutionStatus,
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    await _enable_loop(client, test_board)
    agent = await _unbound_agent(db_session, test_user, name="looper")
    db_session.add(
        _iteration(
            agent, test_workspace, test_board,
            status=inflight_status, started_at=utcnow(),
        )
    )
    await db_session.flush()

    resp = await client.get(_status_url(test_board))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["state"] == "running"
    assert data["enabled"] is True
    assert data["has_inflight_iteration"] is True


async def test_get_loop_status_completed_iteration_is_not_inflight(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """A terminal iteration (completed_at set) must not read as running — it
    becomes the last_iteration_* history instead."""
    await _enable_loop(client, test_board)
    team = await _make_team(db_session, test_workspace, test_board, test_user)
    agent = await _bind_agent(
        db_session, team, test_user, name="looper", last_seen_at=utcnow()
    )
    started = utcnow() + timedelta(seconds=1)  # after the PUT's budget_epoch
    db_session.add(
        _iteration(
            agent, test_workspace, test_board,
            status=ExecutionStatus.completed,
            started_at=started,
            completed_at=started + timedelta(seconds=30),
        )
    )
    await db_session.flush()

    resp = await client.get(_status_url(test_board))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["state"] == "waiting"
    assert data["has_inflight_iteration"] is False
    assert data["last_iteration_status"] == "completed"
    assert data["last_iteration_at"] is not None


async def test_get_loop_status_inflight_on_other_board_ignored(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """In-flight detection is board-scoped: another board's iteration must not
    light this board up as running."""
    await _enable_loop(client, test_board)
    other_board = Board(
        workspace_id=test_workspace.id,
        name="Other Board",
        slug="other-board",
        created_by=test_user.id,
    )
    db_session.add(other_board)
    await db_session.flush()
    agent = await _unbound_agent(db_session, test_user, name="elsewhere")
    db_session.add(
        _iteration(
            agent, test_workspace, other_board,
            status=ExecutionStatus.running, started_at=utcnow(),
        )
    )
    await db_session.flush()

    resp = await client.get(_status_url(test_board))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["has_inflight_iteration"] is False
    assert data["state"] == "unattended"  # no bound agents on this board


async def test_get_loop_status_non_iteration_inflight_not_running(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """Only action='loop_iteration' counts: a card-pipeline execution on the
    same board (implement_card) is not a loop iteration."""
    await _enable_loop(client, test_board)
    team = await _make_team(db_session, test_workspace, test_board, test_user)
    agent = await _bind_agent(
        db_session, team, test_user, name="card-worker", last_seen_at=utcnow()
    )
    db_session.add(
        _iteration(
            agent, test_workspace, test_board,
            status=ExecutionStatus.running, started_at=utcnow(),
            action="implement_card",
        )
    )
    await db_session.flush()

    resp = await client.get(_status_url(test_board))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["has_inflight_iteration"] is False
    assert data["state"] == "waiting"


# --- waiting / unattended ----------------------------------------------------


async def test_get_loop_status_waiting_with_alive_bound_agent(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    await _enable_loop(client, test_board)
    team = await _make_team(db_session, test_workspace, test_board, test_user)
    await _bind_agent(
        db_session, team, test_user, name="attentive", last_seen_at=utcnow()
    )

    resp = await client.get(_status_url(test_board))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["state"] == "waiting"
    assert data["bound_agent_count"] == 1
    assert data["alive_agent_count"] == 1
    # Empty board -> readiness ready_count == 0 -> not actionable.
    assert data["actionable"] is False


async def test_get_loop_status_waiting_actionable_with_ready_card(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """`actionable` is the existing readiness computation (ready_count > 0),
    not a new derivation."""
    await _enable_loop(client, test_board)
    team = await _make_team(db_session, test_workspace, test_board, test_user)
    await _bind_agent(
        db_session, team, test_user, name="attentive", last_seen_at=utcnow()
    )
    backlog = Column(
        board_id=test_board.id,
        name="Backlog",
        position=1024.0,
        color="#6b7280",
        column_type=ColumnType.backlog,
    )
    db_session.add(backlog)
    await db_session.flush()
    db_session.add(
        Card(
            board_id=test_board.id,
            column_id=backlog.id,
            title="ready work",
            position=1024.0,
            created_by=test_user.id,
        )
    )
    await db_session.flush()

    resp = await client.get(_status_url(test_board))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["state"] == "waiting"
    assert data["actionable"] is True


async def test_get_loop_status_unattended_no_bound_agents(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await _enable_loop(client, test_board)

    resp = await client.get(_status_url(test_board))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["state"] == "unattended"
    assert data["enabled"] is True
    assert data["bound_agent_count"] == 0
    assert data["alive_agent_count"] == 0


async def test_get_loop_status_unattended_all_bound_agents_stale(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """Bound but heartbeat-silent past the 90s alive threshold: the loop is
    enabled and nobody is actually there to run it."""
    await _enable_loop(client, test_board)
    team = await _make_team(db_session, test_workspace, test_board, test_user)
    await _bind_agent(
        db_session, team, test_user,
        name="ghost", last_seen_at=utcnow() - timedelta(minutes=5),
    )

    resp = await client.get(_status_url(test_board))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["state"] == "unattended"
    assert data["bound_agent_count"] == 1
    assert data["alive_agent_count"] == 0


async def test_get_loop_status_bound_and_alive_counts_diverge(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """3 bound / 1 alive: bound_agent_count counts ALL team members regardless
    of liveness, alive_agent_count only heartbeat-alive ones."""
    await _enable_loop(client, test_board)
    team = await _make_team(db_session, test_workspace, test_board, test_user)
    await _bind_agent(
        db_session, team, test_user, name="fresh", last_seen_at=utcnow()
    )
    await _bind_agent(
        db_session, team, test_user,
        name="stale", last_seen_at=utcnow() - timedelta(minutes=5),
    )
    await _bind_agent(
        db_session, team, test_user, name="never-seen", last_seen_at=None
    )

    resp = await client.get(_status_url(test_board))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["bound_agent_count"] == 3
    assert data["alive_agent_count"] == 1
    assert data["state"] == "waiting"  # one alive is enough


async def test_get_loop_status_health_board_binding_ignored(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """Binding comes from AgentTeam.board_id ONLY. An alive agent that merely
    reports health_current_board_id = this board is passing through, not
    bound — it must not count."""
    await _enable_loop(client, test_board)
    await _unbound_agent(
        db_session, test_user,
        name="passerby",
        last_seen_at=utcnow(),
        health_current_board_id=str(test_board.id),
    )

    resp = await client.get(_status_url(test_board))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["bound_agent_count"] == 0
    assert data["alive_agent_count"] == 0
    assert data["state"] == "unattended"


# --- spent / budget / last iteration ----------------------------------------


async def test_get_loop_status_spent_and_budget_passthrough(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    await _enable_loop(client, test_board)
    agent = await _unbound_agent(db_session, test_user, name="spender")
    # After the PUT's budget_epoch so both iterations land inside the window.
    base = utcnow() + timedelta(seconds=1)
    for offset, cost in [(0, 0.30), (60, 0.20)]:
        started = base + timedelta(seconds=offset)
        db_session.add(
            _iteration(
                agent, test_workspace, test_board,
                status=ExecutionStatus.completed,
                started_at=started,
                completed_at=started + timedelta(seconds=30),
                cost_usd=cost,
            )
        )
    await db_session.flush()

    resp = await client.get(_status_url(test_board))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["budget_usd"] == 7.5
    assert data["spent_usd"] == pytest.approx(0.50, abs=0.001)


async def test_get_loop_status_last_iteration_reflects_most_recent(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    await _enable_loop(client, test_board)
    agent = await _unbound_agent(db_session, test_user, name="looper")
    older_start = utcnow() - timedelta(hours=2)
    newer_start = utcnow() - timedelta(hours=1)
    newer_end = newer_start + timedelta(minutes=5)
    db_session.add(
        _iteration(
            agent, test_workspace, test_board,
            status=ExecutionStatus.completed,
            started_at=older_start,
            completed_at=older_start + timedelta(minutes=5),
        )
    )
    db_session.add(
        _iteration(
            agent, test_workspace, test_board,
            status=ExecutionStatus.failed,
            started_at=newer_start,
            completed_at=newer_end,
        )
    )
    await db_session.flush()

    resp = await client.get(_status_url(test_board))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["last_iteration_status"] == "failed"
    # SQLite strips tz: compare naive datetimes. Pin only that the timestamp
    # belongs to the NEWER iteration (started_at..completed_at window) so the
    # test doesn't over-constrain started-vs-completed semantics.
    reported = datetime.fromisoformat(data["last_iteration_at"]).replace(
        tzinfo=None
    )
    assert newer_start <= reported <= newer_end, (
        f"last_iteration_at {reported} is not from the newest iteration "
        f"({newer_start}..{newer_end})"
    )


# --- authz / not-found -------------------------------------------------------


async def test_get_loop_status_nonexistent_board_404(
    client: AsyncClient, test_workspace: Workspace
):
    resp = await client.get(
        f"{BASE}/00000000-0000-0000-0000-000000000000/loop/status"
    )
    assert resp.status_code == 404


@pytest_asyncio.fixture
async def raw_client(db_session: AsyncSession) -> AsyncClient:
    """No get_current_user override — dev-tier X-User-Email runs through
    app.core.auth as in prod (same shape as the readiness authz tests)."""
    app = create_app()

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


async def test_get_loop_status_non_member_403(
    raw_client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """Mirrors test_readiness_non_member_403: workspace membership gates the
    whole /loop family the same way."""
    resp = await raw_client.get(
        _status_url(test_board), headers={"X-User-Email": "stranger@valaris.dev"}
    )
    assert resp.status_code == 403
