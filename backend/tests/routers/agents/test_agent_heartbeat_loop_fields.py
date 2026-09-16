# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Heartbeat carries loop state (card 442ff0f2). RED phase.

Loop-mode runners heartbeat on every tick INCLUDING parked ones, but the body
had no way to say "I am parked on board X because Y". These fields are that
channel, and they are strictly additive: the whole point of the rolling-deploy
contract is that a runner built before this card keeps heartbeating exactly as
it did — no 422, no field clobbered.

`health_loop_parked_since` is sent by the runner as the ISO instant the CURRENT
park streak began (not the instant of this tick), so the operator can read "how
long has it been asleep" straight off the record rather than diffing ticks.
"""

from httpx import AsyncClient

from app.models.agents.agent import Agent


BASE_URL = "/api/agents"


async def test_heartbeat_stores_parked_loop_fields(
    agent_client: AsyncClient, test_agent: Agent
):
    body = {
        "status": "idle",
        "loop_board_id": "22222222-2222-2222-2222-222222222222",
        "loop_state": "parked",
        "loop_park_reason": "nothing actionable",
        "loop_parked_since": "2026-08-12T10:00:00Z",
    }
    resp = await agent_client.post(f"{BASE_URL}/me/heartbeat", json=body)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["health_loop_board_id"] == "22222222-2222-2222-2222-222222222222"
    assert data["health_loop_state"] == "parked"
    assert data["health_loop_park_reason"] == "nothing actionable"
    assert data["health_loop_parked_since"].startswith("2026-08-12T10:00:00")


async def test_heartbeat_ticking_clears_park_reason_and_since(
    agent_client: AsyncClient, test_agent: Agent
):
    """Waking up must not leave the park story behind. A `ticking` tick is the
    only signal the runner sends on wake, so the state transition itself has to
    clear the reason — otherwise the console shows a live runner annotated with
    the excuse it used an hour ago."""
    parked = {
        "loop_board_id": "22222222-2222-2222-2222-222222222222",
        "loop_state": "parked",
        "loop_park_reason": "nothing actionable",
        "loop_parked_since": "2026-08-12T10:00:00Z",
    }
    await agent_client.post(f"{BASE_URL}/me/heartbeat", json=parked)

    resp = await agent_client.post(
        f"{BASE_URL}/me/heartbeat",
        json={
            "loop_board_id": "22222222-2222-2222-2222-222222222222",
            "loop_state": "ticking",
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["health_loop_state"] == "ticking"
    assert data["health_loop_park_reason"] is None
    assert data["health_loop_parked_since"] is None


async def test_heartbeat_without_loop_fields_is_unchanged(
    agent_client: AsyncClient, test_agent: Agent
):
    """The rolling-deploy contract: an old runner's body is accepted verbatim
    and leaves the loop fields untouched rather than nulling them."""
    await agent_client.post(
        f"{BASE_URL}/me/heartbeat",
        json={
            "loop_board_id": "22222222-2222-2222-2222-222222222222",
            "loop_state": "parked",
            "loop_park_reason": "nothing actionable",
        },
    )

    resp = await agent_client.post(
        f"{BASE_URL}/me/heartbeat",
        json={"status": "idle", "version": "1.0.0", "cards_processed": 3},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["health_version"] == "1.0.0"
    assert data["health_loop_state"] == "parked"
    assert data["health_loop_park_reason"] == "nothing actionable"


async def test_heartbeat_with_empty_body_still_succeeds(
    agent_client: AsyncClient, test_agent: Agent
):
    resp = await agent_client.post(f"{BASE_URL}/me/heartbeat")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["health_loop_state"] is None
    assert data["health_loop_board_id"] is None


async def test_heartbeat_rejects_unknown_loop_state(
    agent_client: AsyncClient, test_agent: Agent
):
    """`loop_state` is a closed vocabulary — a typo'd value must not become a
    third state that the /loop/status ladder silently treats as not-parked."""
    resp = await agent_client.post(
        f"{BASE_URL}/me/heartbeat",
        json={"loop_state": "snoozing"},
    )
    assert resp.status_code == 422, resp.text
