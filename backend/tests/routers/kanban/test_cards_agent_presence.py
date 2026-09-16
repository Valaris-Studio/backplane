# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Card-level agent-presence state.

Four-state derived enum attached to every CardRead:
- "none": no signal
- "eligible": a card participant has agent_id (a runner is assigned/watching)
- "touched": an activity row logged by an agent exists for the card
- "active": an AgentExecution with status in ('started','running') references
  the card via cards_affected

Precedence: active > touched > eligible > none.
`last_agent_activity_at` is populated from the activity log independently of the
state enum so sort-by-agent-activity works even on currently-active cards.
"""
from datetime import datetime

from httpx import AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.agents.agent import Agent, AgentType
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardParticipant
from app.models.kanban.column import Column
from app.models.user import User
from app.models.workspace import Workspace


BASE = "/api/workspaces/default/boards"


def _url(board: Board, suffix: str = "") -> str:
    return f"{BASE}/{board.id}/cards{suffix}"


async def _make_agent(db_session: AsyncSession, user: User, name: str = "presence-agent") -> Agent:
    agent = Agent(name=name, agent_type=AgentType.coding, created_by_id=user.id)
    db_session.add(agent)
    await db_session.flush()
    return agent


async def _make_activity(
    db_session: AsyncSession,
    *,
    workspace: Workspace,
    board: Board,
    card: Card,
    actor: User,
    agent: Agent,
    created_at: datetime | None = None,
) -> Activity:
    row = Activity(
        workspace_id=workspace.id,
        board_id=board.id,
        actor_id=actor.id,
        entity_type=ActivityEntityType.card,
        entity_id=card.id,
        action=ActivityAction.updated,
        summary="agent activity",
        agent_id=agent.id,
    )
    db_session.add(row)
    await db_session.flush()
    if created_at is not None:
        # `created_at` is server_default=func.now(); override explicitly for
        # deterministic ordering in tests.
        row.created_at = created_at
        await db_session.flush()
    return row


async def test_card_agent_presence_defaults_none(
    client: AsyncClient,
    test_board: Board,
    test_card: Card,
):
    response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 200
    data = response.json()
    assert data["agent_presence"] == "none"
    assert data["active_execution_id"] is None
    assert data["last_agent_activity_at"] is None


async def test_card_agent_presence_eligible_when_participant_has_agent_id(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    agent = await _make_agent(db_session, test_user)
    db_session.add(CardParticipant(
        card_id=test_card.id, user_id=test_user.id, role="helper", agent_id=agent.id,
    ))
    await db_session.flush()

    response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 200
    data = response.json()
    assert data["agent_presence"] == "eligible"
    assert data["active_execution_id"] is None
    assert data["last_agent_activity_at"] is None


async def test_card_agent_presence_touched_when_activity_log_has_agent_entry(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    agent = await _make_agent(db_session, test_user)
    stamp = datetime(2026, 4, 17, 12, 0, 0)
    await _make_activity(
        db_session,
        workspace=test_workspace, board=test_board, card=test_card,
        actor=test_user, agent=agent, created_at=stamp,
    )

    response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 200
    data = response.json()
    assert data["agent_presence"] == "touched"
    assert data["active_execution_id"] is None
    assert data["last_agent_activity_at"] is not None
    assert data["last_agent_activity_at"].startswith("2026-04-17")


async def test_card_agent_presence_active_when_execution_status_is_running(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    agent = await _make_agent(db_session, test_user)
    execution = AgentExecution(
        agent_id=agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="implement",
        status=ExecutionStatus.running,
        cards_affected=[str(test_card.id)],
    )
    db_session.add(execution)
    await db_session.flush()

    response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 200
    data = response.json()
    assert data["agent_presence"] == "active"
    assert data["active_execution_id"] == str(execution.id)


async def test_card_agent_presence_state_precedence_active_beats_touched_beats_eligible(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """Card with participant + activity + running execution resolves to 'active'."""
    agent = await _make_agent(db_session, test_user)
    db_session.add(CardParticipant(
        card_id=test_card.id, user_id=test_user.id, role="helper", agent_id=agent.id,
    ))
    await _make_activity(
        db_session,
        workspace=test_workspace, board=test_board, card=test_card,
        actor=test_user, agent=agent,
        created_at=datetime(2026, 4, 10, 9, 0, 0),
    )
    execution = AgentExecution(
        agent_id=agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="implement",
        status=ExecutionStatus.started,
        cards_affected=[str(test_card.id)],
    )
    db_session.add(execution)
    await db_session.flush()

    response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 200
    data = response.json()
    assert data["agent_presence"] == "active"
    assert data["active_execution_id"] == str(execution.id)


async def test_card_last_agent_activity_at_set_independently_of_state(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """A currently-active card still surfaces past activity for sort ordering."""
    agent = await _make_agent(db_session, test_user)
    past_stamp = datetime(2026, 3, 1, 10, 30, 0)
    await _make_activity(
        db_session,
        workspace=test_workspace, board=test_board, card=test_card,
        actor=test_user, agent=agent, created_at=past_stamp,
    )
    execution = AgentExecution(
        agent_id=agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="implement",
        status=ExecutionStatus.running,
        cards_affected=[str(test_card.id)],
    )
    db_session.add(execution)
    await db_session.flush()

    response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 200
    data = response.json()
    assert data["agent_presence"] == "active"
    assert data["active_execution_id"] == str(execution.id)
    assert data["last_agent_activity_at"] is not None
    assert data["last_agent_activity_at"].startswith("2026-03-01")


async def test_board_detail_agent_presence_enrichment_is_single_query_per_source(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """N cards -> 1 executions SELECT + 1 activities SELECT. No N+1."""
    agent = await _make_agent(db_session, test_user)

    cards: list[Card] = []
    for i in range(5):
        c = Card(
            board_id=test_board.id,
            column_id=test_column.id,
            title=f"Card {i}",
            description="",
            position=1024.0 * (i + 1),
            created_by=test_user.id,
        )
        db_session.add(c)
        cards.append(c)
    await db_session.flush()

    # Sprinkle one activity per card so the activities query has work to do.
    for c in cards:
        await _make_activity(
            db_session,
            workspace=test_workspace, board=test_board, card=c,
            actor=test_user, agent=agent,
        )
    # One running execution covering two cards.
    execution = AgentExecution(
        agent_id=agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="implement",
        status=ExecutionStatus.running,
        cards_affected=[str(cards[0].id), str(cards[1].id)],
    )
    db_session.add(execution)
    await db_session.flush()

    executions_query_count = 0
    activities_query_count = 0
    # the session is bound to this test's private engine (see conftest.db_engine)
    sync_engine = db_session.get_bind()

    def _count(conn, cursor, statement, parameters, context, executemany):
        nonlocal executions_query_count, activities_query_count
        lowered = statement.lower()
        # Only count SELECTs so INSERTs during the request (activity log)
        # don't inflate the tally.
        if not lowered.lstrip().startswith("select"):
            return
        if "from agent_executions" in lowered:
            executions_query_count += 1
        if "from activities" in lowered:
            activities_query_count += 1

    event.listen(sync_engine, "before_cursor_execute", _count)
    try:
        response = await client.get(
            f"/api/workspaces/default/boards/{test_board.id}",
        )
    finally:
        event.remove(sync_engine, "before_cursor_execute", _count)

    assert response.status_code == 200
    assert executions_query_count <= 1, (
        f"expected 1 executions query, got {executions_query_count} (N+1)"
    )
    assert activities_query_count <= 1, (
        f"expected 1 activities query, got {activities_query_count} (N+1)"
    )

    detail = response.json()
    all_cards = [c for col in detail["columns"] for c in col["cards"]]
    by_id = {c["id"]: c for c in all_cards}
    assert by_id[str(cards[0].id)]["agent_presence"] == "active"
    assert by_id[str(cards[0].id)]["active_execution_id"] == str(execution.id)
    assert by_id[str(cards[2].id)]["agent_presence"] == "touched"


async def test_card_goes_active_via_start_execution_card_binding(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """End-to-end: the runner's real path (start_execution with card_id) must
    flip the card to 'active' on the very next GET — no separate
    log_execution_update(cards_affected=...) call required. This is the chain
    that fixes the board's blindness to in-flight runner work."""
    from app.schemas.agents.execution import ExecutionCreate
    from app.services.agents.execution import ExecutionService

    agent = await _make_agent(db_session, test_user)
    service = ExecutionService(db_session)
    execution = await service.start_execution(
        agent.id,
        ExecutionCreate(
            workspace_slug=test_workspace.slug,
            board_id=test_board.id,
            card_id=test_card.id,
            action="implement_card",
            input_summary="work the card",
        ),
    )
    await db_session.flush()

    response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 200
    data = response.json()
    assert data["agent_presence"] == "active"
    assert data["active_execution_id"] == str(execution.id)


async def test_card_agent_presence_stale_execution_does_not_force_active(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """A crashed runner leaves a started/running row with completed_at=NULL
    forever (reaped only on the next reservation, past 45min). Such a stuck
    execution must NOT keep the card pinned 'active' indefinitely — past a
    recency horizon it falls back so heartbeat-derived staleness shows through.
    Here the only signal is a long-stale execution → presence must be below
    'active' (no agent activity/participant → 'none')."""
    from datetime import timedelta

    from app.utils import utcnow

    agent = await _make_agent(db_session, test_user)
    execution = AgentExecution(
        agent_id=agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="implement",
        status=ExecutionStatus.running,
        cards_affected=[str(test_card.id)],
    )
    db_session.add(execution)
    await db_session.flush()
    # Backdate started_at well past the active-recency horizon.
    execution.started_at = utcnow() - timedelta(hours=2)
    await db_session.flush()

    response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 200
    data = response.json()
    assert data["agent_presence"] != "active", (
        "a 2h-old stuck execution must not pin the card 'active' — heartbeat "
        "staleness should show through"
    )


async def test_card_agent_presence_suspended_when_budget_suspended_label_and_no_execution(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """A budget-suspended card with no live execution is PARKED, not working.
    It derives the first-class `suspended` presence so the board shows a
    paused badge instead of a `touched`/`eligible` robot the operator has to
    decode. The card keeps an activity row (the suspend stamped labels) and may
    still carry a stale hero from the re-claim race — neither should win over
    `suspended`."""
    agent = await _make_agent(db_session, test_user)
    # The re-claim race leaves a lingering hero participant; a touched-class
    # activity row exists from the suspend. Neither must mask `suspended`.
    db_session.add(CardParticipant(
        card_id=test_card.id, user_id=test_user.id, role="hero", agent_id=agent.id,
    ))
    await _make_activity(
        db_session,
        workspace=test_workspace, board=test_board, card=test_card,
        actor=test_user, agent=agent, created_at=datetime(2026, 4, 1, 0, 27, 0),
    )
    test_card.labels = ["Epic C", "budget-pass-1", "budget-suspended"]
    await db_session.flush()

    response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 200
    data = response.json()
    assert data["agent_presence"] == "suspended"
    assert data["active_execution_id"] is None


async def test_card_agent_presence_active_beats_suspended_when_execution_live(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """A budget-suspended card that got re-claimed and is mid-tick RIGHT NOW
    (live execution) is genuinely working again — `active` must beat
    `suspended`. The truth (a live execution) always wins; `suspended` only
    surfaces when the parked card is idle."""
    agent = await _make_agent(db_session, test_user)
    test_card.labels = ["budget-suspended"]
    execution = AgentExecution(
        agent_id=agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="implement",
        status=ExecutionStatus.running,
        cards_affected=[str(test_card.id)],
    )
    db_session.add(execution)
    await db_session.flush()

    response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 200
    data = response.json()
    assert data["agent_presence"] == "active"
    assert data["active_execution_id"] == str(execution.id)


async def test_card_agent_presence_recent_execution_still_active(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """A genuinely recent in-flight execution stays 'active' — the horizon must
    not suppress real work."""
    agent = await _make_agent(db_session, test_user)
    execution = AgentExecution(
        agent_id=agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="implement",
        status=ExecutionStatus.running,
        cards_affected=[str(test_card.id)],
    )
    db_session.add(execution)
    await db_session.flush()  # started_at defaults to now()

    response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 200
    assert response.json()["agent_presence"] == "active"
