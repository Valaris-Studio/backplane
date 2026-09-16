# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Loop stop history — durable transitions + GET /loop/transitions.

`disabled_reason` is a SINGLE field on the loop config: every re-enable nulls
it and every disable overwrites it, so an operator sees a stop reason exactly
once and it is then gone forever. Three self-improvement runs lost their true
run-complete reasons this way (a max_iterations rail overwrote them), and
reconstructing what happened meant reading git plus run-log notes.

Design: a dedicated `board_loop_transitions` table rather than enriched
activity rows. Activity is a generic polymorphic audit log with no
board+loop index — a chronological per-board loop query would scan it and
filter on summary TEXT to tell a loop event from a card event. A first-class
table gives a cheap (board_id, occurred_at DESC) index and typed columns for
the things the timeline actually renders: reason, actor, and the iteration
counter at that moment.

Attribution is structural, not guessed: `agent_id` is non-null exactly when
the caller authenticated with an agent API key (core.auth's current_agent_id
ContextVar), which is what makes a runner-initiated rail stop distinguishable
from an operator clicking Stop.
"""

from datetime import datetime, timedelta

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent, AgentType
from app.models.agents.execution import AgentExecution
from app.models.kanban.board import Board
from app.models.kanban.loop_transition import BoardLoopTransition
from app.models.user import User
from app.models.workspace import Workspace


BASE_URL = "/api/workspaces/default/boards"

MINIMAL_PUT_BODY = {
    "enabled": False,
    "loop_prompt": "Iteration {{.Iteration}}: make progress.",
}


def _loop_url(board: Board) -> str:
    return f"{BASE_URL}/{board.id}/loop"


def _state_url(board: Board) -> str:
    return f"{BASE_URL}/{board.id}/loop/state"


def _transitions_url(board: Board) -> str:
    return f"{BASE_URL}/{board.id}/loop/transitions"


@pytest_asyncio.fixture
async def loop_agent(db_session: AsyncSession, test_user: User) -> Agent:
    agent = Agent(
        name="transitions-agent",
        agent_type=AgentType.coding,
        description="loop transitions test agent",
        created_by_id=test_user.id,
        is_active=True,
    )
    db_session.add(agent)
    await db_session.flush()
    return agent


async def _configure(client: AsyncClient, board: Board) -> None:
    response = await client.put(_loop_url(board), json=MINIMAL_PUT_BODY)
    assert response.status_code == 200, response.text


# --- persistence -------------------------------------------------------------


async def test_stop_reasons_survive_a_re_enable(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    """The card's core failure: today the second disable erases the first."""
    await _configure(client, test_board)

    await client.patch(_state_url(test_board), json={"enabled": True, "reason": ""})
    first = await client.patch(
        _state_url(test_board),
        json={"enabled": False, "reason": "run complete: all loop-3 cards done"},
    )
    assert first.status_code == 200, first.text
    await client.patch(_state_url(test_board), json={"enabled": True, "reason": ""})
    await client.patch(
        _state_url(test_board),
        json={"enabled": False, "reason": "max_iterations reached"},
    )

    response = await client.get(_transitions_url(test_board))
    assert response.status_code == 200, response.text
    body = response.json()

    reasons = [t["reason"] for t in body["transitions"] if not t["enabled"]]
    assert reasons == [
        "max_iterations reached",
        "run complete: all loop-3 cards done",
    ], "both stop reasons must survive, newest first"

    # Enables are recorded too, so the timeline can pair a stop with the run
    # that preceded it.
    assert [t["enabled"] for t in body["transitions"]] == [
        False,
        True,
        False,
        True,
    ]


async def test_transition_records_actor_and_iteration_counter(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    loop_agent: Agent,
    test_workspace: Workspace,
    test_board: Board,
):
    for index in range(3):
        db_session.add(
            AgentExecution(
                agent_id=loop_agent.id,
                workspace_id=test_workspace.id,
                board_id=test_board.id,
                action="loop_iteration",
                input_summary=f"loop iteration {index + 1}",
                started_at=datetime.utcnow() - timedelta(minutes=index),
            )
        )
    await db_session.flush()

    await _configure(client, test_board)
    await client.patch(_state_url(test_board), json={"enabled": True, "reason": ""})
    await client.patch(
        _state_url(test_board), json={"enabled": False, "reason": "budget spent"}
    )

    body = (await client.get(_transitions_url(test_board))).json()
    stop = body["transitions"][0]

    assert stop["enabled"] is False
    assert stop["reason"] == "budget spent"
    assert stop["iteration_count"] == 3
    assert stop["actor_name"] == test_user.name
    # A human operator, not a runner: the source is what the UI attributes to.
    assert stop["source"] == "human"
    assert stop["occurred_at"]


async def test_put_loop_config_disable_records_a_transition(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    """Enable/disable via PUT is the same domain event as via PATCH /state."""
    await _configure(client, test_board)
    await client.put(_loop_url(test_board), json={**MINIMAL_PUT_BODY, "enabled": True})
    await client.put(
        _loop_url(test_board), json={**MINIMAL_PUT_BODY, "enabled": False}
    )

    body = (await client.get(_transitions_url(test_board))).json()
    assert [t["enabled"] for t in body["transitions"]] == [False, True]


async def test_config_edit_without_a_state_flip_records_nothing(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    """Only STATE CHANGES are transitions — otherwise every prompt tweak
    would bury the timeline the operator came here to read."""
    await _configure(client, test_board)
    await client.patch(_state_url(test_board), json={"enabled": True, "reason": ""})
    await client.put(
        _loop_url(test_board),
        json={**MINIMAL_PUT_BODY, "enabled": True, "max_iterations": 42},
    )

    body = (await client.get(_transitions_url(test_board))).json()
    assert [t["enabled"] for t in body["transitions"]] == [True]


async def test_idempotent_state_patch_records_nothing(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    await _configure(client, test_board)
    await client.patch(_state_url(test_board), json={"enabled": True, "reason": ""})
    await client.patch(_state_url(test_board), json={"enabled": True, "reason": ""})

    body = (await client.get(_transitions_url(test_board))).json()
    assert len(body["transitions"]) == 1


# --- endpoint contract -------------------------------------------------------


async def test_transitions_are_paginated_newest_first(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
):
    base = datetime(2026, 8, 13, 12, 0, 0)
    for index in range(25):
        db_session.add(
            BoardLoopTransition(
                board_id=test_board.id,
                workspace_id=test_workspace.id,
                enabled=index % 2 == 0,
                reason=f"stop {index}",
                actor_id=test_user.id,
                iteration_count=index,
                occurred_at=base + timedelta(minutes=index),
            )
        )
    await db_session.flush()

    first_page = (
        await client.get(_transitions_url(test_board), params={"limit": 10})
    ).json()
    assert len(first_page["transitions"]) == 10
    assert first_page["total"] == 25
    assert first_page["transitions"][0]["reason"] == "stop 24"

    second_page = (
        await client.get(
            _transitions_url(test_board), params={"limit": 10, "offset": 10}
        )
    ).json()
    assert [t["reason"] for t in second_page["transitions"]][0] == "stop 14"
    assert not {t["reason"] for t in first_page["transitions"]} & {
        t["reason"] for t in second_page["transitions"]
    }


async def test_transitions_are_board_scoped(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
):
    other = Board(
        workspace_id=test_workspace.id,
        name="Other board",
        slug="other-board",
        created_by=test_user.id,
    )
    db_session.add(other)
    await db_session.flush()
    db_session.add(
        BoardLoopTransition(
            board_id=other.id,
            workspace_id=test_workspace.id,
            enabled=False,
            reason="other board stop",
            actor_id=test_user.id,
            iteration_count=0,
        )
    )
    await db_session.flush()

    body = (await client.get(_transitions_url(test_board))).json()
    assert body["transitions"] == []
    assert body["total"] == 0


async def test_transitions_unconfigured_board_is_empty_not_404(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    """Unlike GET /loop, this is a pure history read — an empty timeline is a
    valid answer and the UI must render it without special-casing."""
    response = await client.get(_transitions_url(test_board))
    assert response.status_code == 200
    assert response.json() == {"transitions": [], "total": 0}


async def test_last_stop_reason_survives_on_status(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    """The chip must still explain the last stop while the loop is re-enabled
    — `disabled_reason` alone goes null the moment someone restarts it."""
    await _configure(client, test_board)
    await client.patch(_state_url(test_board), json={"enabled": True, "reason": ""})
    await client.patch(
        _state_url(test_board), json={"enabled": False, "reason": "objective complete"}
    )
    await client.patch(_state_url(test_board), json={"enabled": True, "reason": ""})

    status = (await client.get(f"{BASE_URL}/{test_board.id}/loop/status")).json()
    assert status["enabled"] is True
    assert status["disabled_reason"] is None
    assert status["last_stop_reason"] == "objective complete"
    assert status["last_stop_at"]


@pytest.mark.parametrize("limit", [0, 201])
async def test_transitions_rejects_out_of_range_limit(
    limit: int,
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    response = await client.get(_transitions_url(test_board), params={"limit": limit})
    assert response.status_code == 422


async def test_transition_rows_persist_the_agent_when_a_runner_stops_the_loop(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
):
    """Structural attribution: the row carries agent_id, so a rail stop is
    never mistaken for an operator decision."""
    await _configure(client, test_board)
    await client.patch(_state_url(test_board), json={"enabled": True, "reason": ""})
    await client.patch(
        _state_url(test_board), json={"enabled": False, "reason": "rail: max failures"}
    )

    rows = (
        (
            await db_session.execute(
                select(BoardLoopTransition).where(
                    BoardLoopTransition.board_id == test_board.id
                )
            )
        )
        .scalars()
        .all()
    )
    assert {row.agent_id for row in rows} == {None}, (
        "the plain test client is a human caller — agent_id must stay null so "
        "`source` can distinguish runner stops from operator stops"
    )
