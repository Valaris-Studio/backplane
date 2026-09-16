# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Heartbeat accepts loop_state="idle_waiting" (card 5ffe97cf).

A keep-alive runner sitting on a board whose loop an operator switched OFF is
not `parked` — parked means the loop is running and found nothing actionable,
and the operator's next move differs (flip the loop back on vs. unblock a
card). It gets its own state.

Strictly additive: `health_loop_state` is String(16) and "idle_waiting" is 12,
so no migration. The two pre-existing values keep working unchanged — a runner
built before this card must not start 422ing.
"""

from httpx import AsyncClient

from app.models.agents.agent import Agent


BASE_URL = "/api/agents"

BOARD_ID = "22222222-2222-2222-2222-222222222222"


async def test_heartbeat_accepts_idle_waiting_and_stores_the_wait_story(
    agent_client: AsyncClient, test_agent: Agent
):
    """An idle runner reports the same "asleep since X because Y" shape a parked
    one does — the operator's question is identical either way."""
    resp = await agent_client.post(
        f"{BASE_URL}/me/heartbeat",
        json={
            "status": "idle",
            "loop_board_id": BOARD_ID,
            "loop_state": "idle_waiting",
            "loop_park_reason": "loop disabled on the board",
            "loop_parked_since": "2026-08-16T10:00:00Z",
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["health_loop_state"] == "idle_waiting"
    assert data["health_loop_board_id"] == BOARD_ID
    assert data["health_loop_park_reason"] == "loop disabled on the board"
    assert data["health_loop_parked_since"].startswith("2026-08-16T10:00:00")


async def test_heartbeat_ticking_after_idle_waiting_clears_the_wait_story(
    agent_client: AsyncClient, test_agent: Agent
):
    """Re-enabling the loop is a wake: the runner's next tick is `ticking`, and
    that transition must clear the reason it was waiting — else the console
    shows a live runner annotated with an hour-old excuse."""
    await agent_client.post(
        f"{BASE_URL}/me/heartbeat",
        json={
            "loop_board_id": BOARD_ID,
            "loop_state": "idle_waiting",
            "loop_park_reason": "loop disabled on the board",
            "loop_parked_since": "2026-08-16T10:00:00Z",
        },
    )

    resp = await agent_client.post(
        f"{BASE_URL}/me/heartbeat",
        json={"loop_board_id": BOARD_ID, "loop_state": "ticking"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["health_loop_state"] == "ticking"
    assert data["health_loop_park_reason"] is None
    assert data["health_loop_parked_since"] is None


async def test_heartbeat_still_accepts_the_pre_existing_loop_states(
    agent_client: AsyncClient, test_agent: Agent
):
    """Widening a Literal must not narrow it. A runner built before this card
    sends only ticking/parked and has to keep working across the deploy."""
    for state in ("ticking", "parked"):
        resp = await agent_client.post(
            f"{BASE_URL}/me/heartbeat",
            json={"loop_board_id": BOARD_ID, "loop_state": state},
        )
        assert resp.status_code == 200, f"{state}: {resp.text}"
        assert resp.json()["health_loop_state"] == state


async def test_heartbeat_rejects_an_unknown_loop_state(
    agent_client: AsyncClient, test_agent: Agent
):
    """The vocabulary stays CLOSED. The runner's latching fallback keys off
    exactly this 422 to detect a backend older than the value it is sending, so
    a schema that silently accepted anything would break that detection."""
    resp = await agent_client.post(
        f"{BASE_URL}/me/heartbeat",
        json={"loop_board_id": BOARD_ID, "loop_state": "napping"},
    )
    assert resp.status_code == 422, resp.text
