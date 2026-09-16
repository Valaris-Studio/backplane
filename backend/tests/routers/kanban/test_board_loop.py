# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Board loop mode — config endpoints, defaults completeness, state flips.

RED phase for `boards.loop_config` + three endpoints under
/api/workspaces/{slug}/boards/{board_id}:

  - GET   /loop        — any workspace member or agent key; 404 until configured.
  - PUT   /loop        — admin/owner; full replace, canonicalize + validate,
                         optional expected_version optimistic lock (409 on miss).
  - PATCH /loop/state  — body {"enabled": bool, "reason": str}; member or agent
                         key; idempotent; enable requires non-empty loop_prompt.

HIGHEST-RISK PIN (runner wire contract): GET must ALWAYS return the complete
object — the runner does a plain json.Unmarshal, so a missing numeric field
decodes as 0 and silently trips a safety rail. The defaults-completeness tests
below assert every field is present after a minimal PUT.

Role/agent-key coverage lives in tests/routers/test_role_matrix.py; the frozen
409 matrix in test_board_freeze_gate.py.
"""

from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.agents.agent import Agent
from app.models.kanban.board import Board
from app.models.workspace import Workspace
from app.models.workspace_config import WorkspaceConfig


BASE_URL = "/api/workspaces/default/boards"

# The complete wire object — every key the runner json.Unmarshals. A missing
# numeric field decodes as Go zero-value and trips a safety rail, so GET/PUT/
# PATCH responses must contain ALL of these, always.
ALL_LOOP_FIELDS = {
    "enabled",
    "provider",
    "model",
    "system_prompt",
    "loop_prompt",
    "tools",
    "max_iterations",
    "iteration_delay_seconds",
    "iteration_timeout_seconds",
    "budget_usd",
    "max_consecutive_failures",
    "max_blocked_on_human",
    "starvation_policy",
    "loop_landing",
    "merge_gate",
    "skills_proposal_enabled",
    "completion_query",
    "budget_epoch",
    "disabled_reason",
    "disabled_reason_code",
    "disabled_reason_params",
    "disabled_diagnostic",
    "version",
    "updated_at",
}

FULL_PUT_BODY = {
    "enabled": True,
    "provider": "codex-cli",
    "model": "premium",
    "system_prompt": "You are the maintenance agent for {{.Workspace}}.",
    "loop_prompt": "Iteration {{.Iteration}}: make progress, or turn the loop off.",
    "tools": ["mcp__valaris__get_card", "mcp__valaris__set_board_loop"],
    "max_iterations": 10,
    "iteration_delay_seconds": 5,
    "iteration_timeout_seconds": 600,
    "budget_usd": 7.5,
    "max_consecutive_failures": 2,
}


def _loop_url(board: Board) -> str:
    return f"{BASE_URL}/{board.id}/loop"


def _state_url(board: Board) -> str:
    return f"{BASE_URL}/{board.id}/loop/state"


def _assert_complete_loop_object(data: dict):
    missing = ALL_LOOP_FIELDS - set(data)
    assert not missing, (
        f"loop object missing fields {sorted(missing)} — the runner decodes "
        "absent numerics as 0 and silently trips a safety rail"
    )


def _published(mock_publish) -> list[tuple[str, dict, object]]:
    """Normalize event_bus.publish calls to (event_type, payload, workspace_id)
    regardless of positional/kwarg style."""
    events = []
    for call in mock_publish.await_args_list:
        args, kwargs = call.args, call.kwargs
        event_type = kwargs.get("event_type", args[0] if len(args) > 0 else None)
        payload = kwargs.get("payload", args[1] if len(args) > 1 else None)
        workspace_id = kwargs.get("workspace_id", args[2] if len(args) > 2 else None)
        events.append((event_type, payload, workspace_id))
    return events


def _loop_events(mock_publish):
    return [e for e in _published(mock_publish) if e[0] == "board.loop_updated"]


async def _loop_activity_count(db_session: AsyncSession, board: Board) -> int:
    return (
        await db_session.scalar(
            select(func.count())
            .select_from(Activity)
            .where(
                Activity.entity_type == ActivityEntityType.board,
                Activity.entity_id == board.id,
                Activity.action == ActivityAction.updated,
            )
        )
    ) or 0


# --- GET /loop ---------------------------------------------------------------


async def test_get_loop_unconfigured_returns_404(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """404 is reserved strictly for "unconfigured" — the app's own not-found
    shape (error_code), not the framework's route-missing default."""
    response = await client.get(_loop_url(test_board))
    assert response.status_code == 404, response.text
    assert response.json().get("error_code") == "not_found", response.text


async def test_get_loop_after_minimal_put_returns_all_fields(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """THE zero-value trap test: a minimal PUT must canonicalize to a complete
    object; GET must serve every field with its documented default."""
    put = await client.put(_loop_url(test_board), json={})
    assert put.status_code in (200, 201), put.text

    response = await client.get(_loop_url(test_board))
    assert response.status_code == 200, response.text
    data = response.json()
    _assert_complete_loop_object(data)
    assert data["enabled"] is False
    assert data["provider"] == ""
    assert data["model"] == "mid"
    assert data["system_prompt"] == ""
    assert data["loop_prompt"] == ""
    assert data["tools"] == []
    assert data["max_iterations"] == 25
    assert data["iteration_delay_seconds"] == 30
    assert data["iteration_timeout_seconds"] == 3600
    assert data["budget_usd"] == 20.0
    assert data["max_consecutive_failures"] == 3
    assert data["disabled_reason"] is None  # JSON null, never ""
    assert data["version"] == 1
    assert data["updated_at"] is not None


async def test_get_loop_resolves_board_slug(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """Board routes accept UUID-or-slug; /loop must use the same resolution."""
    put = await client.put(_loop_url(test_board), json={})
    assert put.status_code in (200, 201), put.text

    response = await client.get(f"{BASE_URL}/{test_board.slug}/loop")
    assert response.status_code == 200, response.text
    assert response.json()["version"] == 1


# --- PUT /loop ---------------------------------------------------------------


async def test_put_loop_full_body_round_trips_verbatim(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(_loop_url(test_board), json=FULL_PUT_BODY)
    assert response.status_code in (200, 201), response.text
    data = response.json()
    _assert_complete_loop_object(data)
    for field, value in FULL_PUT_BODY.items():
        assert data[field] == value, f"{field}: {data[field]!r} != {value!r}"
    # Tier alias is stored verbatim — never resolved server-side.
    assert data["model"] == "premium"
    assert data["version"] == 1


async def test_put_loop_minimal_body_response_is_complete(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(_loop_url(test_board), json={"loop_prompt": "iterate"})
    assert response.status_code in (200, 201), response.text
    data = response.json()
    _assert_complete_loop_object(data)
    assert data["loop_prompt"] == "iterate"
    assert data["max_iterations"] == 25
    assert data["budget_usd"] == 20.0


async def test_put_loop_version_increments_per_put(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    first = await client.put(_loop_url(test_board), json={"loop_prompt": "a"})
    assert first.status_code in (200, 201), first.text
    assert first.json()["version"] == 1

    second = await client.put(_loop_url(test_board), json={"loop_prompt": "b"})
    assert second.status_code == 200, second.text
    assert second.json()["version"] == 2
    assert second.json()["loop_prompt"] == "b"


async def test_put_loop_expected_version_match_succeeds(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    first = await client.put(_loop_url(test_board), json={"loop_prompt": "a"})
    assert first.status_code in (200, 201), first.text

    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "b", "expected_version": 1},
    )
    assert response.status_code == 200, response.text
    assert response.json()["version"] == 2


async def test_put_loop_expected_version_mismatch_409(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    first = await client.put(_loop_url(test_board), json={"loop_prompt": "a"})
    assert first.status_code in (200, 201), first.text

    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "stale edit", "expected_version": 99},
    )
    assert response.status_code == 409, response.text

    # The stale write must not have landed.
    current = await client.get(_loop_url(test_board))
    assert current.json()["loop_prompt"] == "a"
    assert current.json()["version"] == 1


async def test_put_loop_unknown_key_422(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """Typo protection: `max_iteration` (missing s) must be rejected, not
    silently dropped — dropping it would leave the real cap at its default."""
    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "max_iteration": 5},
    )
    assert response.status_code == 422, response.text


@pytest.mark.parametrize(
    "server_owned",
    [
        {"disabled_reason": "hax"},
        {"disabled_reason_code": "max_iterations_reached"},
        {"disabled_reason_params": {"max_iterations": 10}},
        {"disabled_diagnostic": "runner detail"},
        {"updated_at": "2026-01-01T00:00:00"},
    ],
    ids=[
        "disabled_reason",
        "disabled_reason_code",
        "disabled_reason_params",
        "disabled_diagnostic",
        "updated_at",
    ],
)
async def test_put_loop_server_owned_field_422(
    server_owned: dict,
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    """Server-owned STATE is never writable from a PUT body.

    `version` is deliberately absent from this list: it is accepted as a
    read-shaped alias for the `expected_version` optimistic lock (below), which
    reads it as a precondition and never stores it. Storing is what this test
    guards, and `version` is still never stored.
    """
    response = await client.put(
        _loop_url(test_board), json={"loop_prompt": "x", **server_owned}
    )
    assert response.status_code == 422, response.text


# GET /loop returns `version`; the natural round-trip is to send it back. Under
# extra="forbid" that 422'd, so the read shape and the write shape disagreed
# (R14 friction log, card d8cbbec6). `version` is now an accepted alias for
# `expected_version` — same optimistic lock, never a stored field.


async def test_put_loop_version_alias_match_succeeds(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """The GET-shaped round-trip: read `version`, send `version` back."""
    first = await client.put(_loop_url(test_board), json={"loop_prompt": "a"})
    assert first.status_code in (200, 201), first.text
    version = first.json()["version"]

    response = await client.put(
        _loop_url(test_board), json={"loop_prompt": "b", "version": version}
    )
    assert response.status_code == 200, response.text
    # The alias acted as a lock, not as a stored value: the server still owns
    # the counter and bumped it.
    assert response.json()["version"] == version + 1
    assert response.json()["loop_prompt"] == "b"


async def test_put_loop_version_alias_mismatch_409(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    first = await client.put(_loop_url(test_board), json={"loop_prompt": "a"})
    assert first.status_code in (200, 201), first.text

    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "stale edit", "version": 99},
    )
    assert response.status_code == 409, response.text

    current = await client.get(_loop_url(test_board))
    assert current.json()["loop_prompt"] == "a"
    assert current.json()["version"] == 1


async def test_put_loop_both_version_fields_agreeing_succeeds(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """Belt-and-braces clients that send both are not punished for agreeing."""
    first = await client.put(_loop_url(test_board), json={"loop_prompt": "a"})
    assert first.status_code in (200, 201), first.text

    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "b", "version": 1, "expected_version": 1},
    )
    assert response.status_code == 200, response.text
    assert response.json()["version"] == 2


async def test_put_loop_both_version_fields_conflicting_422(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """Two different preconditions in one body is a client bug, not a merge —
    guessing which one is authoritative could silently skip the lock."""
    first = await client.put(_loop_url(test_board), json={"loop_prompt": "a"})
    assert first.status_code in (200, 201), first.text

    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "b", "version": 1, "expected_version": 2},
    )
    assert response.status_code == 422, response.text

    current = await client.get(_loop_url(test_board))
    assert current.json()["loop_prompt"] == "a"


async def test_put_loop_version_alias_is_not_stored(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """The alias must not leak into the stored config as a settable field —
    the server's own counter stays authoritative."""
    first = await client.put(_loop_url(test_board), json={"loop_prompt": "a"})
    assert first.status_code in (200, 201), first.text

    response = await client.put(
        _loop_url(test_board), json={"loop_prompt": "b", "version": 1}
    )
    assert response.status_code == 200, response.text
    # Sending version=1 must NOT pin the stored version at 1.
    assert response.json()["version"] == 2


async def test_put_loop_enable_without_prompt_422(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(_loop_url(test_board), json={"enabled": True})
    assert response.status_code == 422, response.text

    # And the invalid config must not have been created.
    get = await client.get(_loop_url(test_board))
    assert get.status_code == 404


@pytest.mark.parametrize(
    "invalid",
    [
        {"max_iterations": 0},
        {"max_iterations": -1},
        {"iteration_delay_seconds": -1},
        {"iteration_timeout_seconds": 0},
        {"budget_usd": 0},
        {"budget_usd": -5.0},
        {"max_consecutive_failures": 0},
    ],
    ids=[
        "max_iterations_zero",
        "max_iterations_negative",
        "iteration_delay_negative",
        "iteration_timeout_zero",
        "budget_zero",
        "budget_negative",
        "max_consecutive_failures_zero",
    ],
)
async def test_put_loop_numeric_bounds_422(
    invalid: dict,
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    response = await client.put(
        _loop_url(test_board), json={"loop_prompt": "x", **invalid}
    )
    assert response.status_code == 422, response.text


async def test_put_loop_boundary_values_accepted(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    body = {
        "loop_prompt": "x",
        "max_iterations": 1,
        "iteration_delay_seconds": 0,
        "iteration_timeout_seconds": 1,
        "budget_usd": 0.01,
        "max_consecutive_failures": 1,
    }
    response = await client.put(_loop_url(test_board), json=body)
    assert response.status_code in (200, 201), response.text
    data = response.json()
    assert data["max_iterations"] == 1
    assert data["iteration_delay_seconds"] == 0
    assert data["iteration_timeout_seconds"] == 1
    assert data["budget_usd"] == 0.01
    assert data["max_consecutive_failures"] == 1


async def test_put_loop_starvation_policy_defaults_to_park(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(_loop_url(test_board), json={"loop_prompt": "x"})
    assert response.status_code in (200, 201), response.text
    assert response.json()["starvation_policy"] == "park"


async def test_put_loop_starvation_policy_always_run_round_trips(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "starvation_policy": "always_run"},
    )
    assert response.status_code in (200, 201), response.text
    assert response.json()["starvation_policy"] == "always_run"

    get_response = await client.get(_loop_url(test_board))
    assert get_response.json()["starvation_policy"] == "always_run"


async def test_put_loop_starvation_policy_invalid_value_422(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "starvation_policy": "sometimes"},
    )
    assert response.status_code == 422, response.text


async def test_put_loop_landing_defaults_to_human(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(_loop_url(test_board), json={"loop_prompt": "x"})
    assert response.status_code in (200, 201), response.text
    assert response.json()["loop_landing"] == "human"


async def test_put_loop_landing_merge_queue_round_trips(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "loop_landing": "merge_queue"},
    )
    assert response.status_code in (200, 201), response.text
    assert response.json()["loop_landing"] == "merge_queue"

    get_response = await client.get(_loop_url(test_board))
    assert get_response.json()["loop_landing"] == "merge_queue"


async def test_put_loop_landing_invalid_value_422(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "loop_landing": "yolo"},
    )
    assert response.status_code == 422, response.text


async def test_put_merge_gate_defaults_to_forge_ci(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(_loop_url(test_board), json={"loop_prompt": "x"})
    assert response.status_code in (200, 201), response.text
    assert response.json()["merge_gate"] == "forge_ci"


async def test_put_merge_gate_none_round_trips(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "merge_gate": "none"},
    )
    assert response.status_code in (200, 201), response.text
    assert response.json()["merge_gate"] == "none"

    get_response = await client.get(_loop_url(test_board))
    assert get_response.json()["merge_gate"] == "none"


async def test_put_merge_gate_invalid_value_422(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "merge_gate": "banana"},
    )
    assert response.status_code == 422, response.text
    # Must be the validation finding, not pydantic's extra="forbid" rejection
    # of an unknown key — the field has to exist on LoopConfigPut.
    assert "invalid_merge_gate" in response.text, response.text


async def test_put_merge_gate_omitted_inherits_stored_value(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """PUT merge rule: a later PUT that omits merge_gate must keep the stored
    "none", not reset it to the default."""
    first = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "merge_gate": "none"},
    )
    assert first.status_code in (200, 201), first.text

    second = await client.put(_loop_url(test_board), json={"loop_prompt": "y"})
    assert second.status_code == 200, second.text
    assert second.json()["merge_gate"] == "none"

    get_response = await client.get(_loop_url(test_board))
    assert get_response.json()["merge_gate"] == "none"


async def test_get_loop_pre_starvation_policy_stored_config_serves_park(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
):
    """A loop_config row written before starvation_policy existed must still
    serve the complete wire object — the runner decodes a missing string as ""
    and would neither park nor always_run coherently."""
    legacy = {
        "enabled": False,
        "provider": "",
        "model": "mid",
        "system_prompt": "",
        "loop_prompt": "legacy prompt",
        "tools": [],
        "max_iterations": 25,
        "iteration_delay_seconds": 30,
        "iteration_timeout_seconds": 3600,
        "budget_usd": 20.0,
        "max_consecutive_failures": 3,
        "disabled_reason": None,
        "version": 1,
        "updated_at": "2026-08-01T00:00:00",
    }
    test_board.loop_config = legacy
    await db_session.flush()

    response = await client.get(_loop_url(test_board))
    assert response.status_code == 200
    assert response.json()["starvation_policy"] == "park"


async def test_put_loop_enable_clears_disabled_reason(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    put = await client.put(_loop_url(test_board), json=FULL_PUT_BODY)
    assert put.status_code in (200, 201), put.text
    disabled = await client.patch(
        _state_url(test_board), json={"enabled": False, "reason": "budget rail"}
    )
    assert disabled.status_code == 200, disabled.text
    assert disabled.json()["disabled_reason"] == "budget rail"

    re_enabled = await client.put(_loop_url(test_board), json=FULL_PUT_BODY)
    assert re_enabled.status_code == 200, re_enabled.text
    assert re_enabled.json()["enabled"] is True
    assert re_enabled.json()["disabled_reason"] is None


async def test_put_loop_disabled_preserves_disabled_reason(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    put = await client.put(_loop_url(test_board), json=FULL_PUT_BODY)
    assert put.status_code in (200, 201), put.text
    disabled = await client.patch(
        _state_url(test_board), json={"enabled": False, "reason": "objective met"}
    )
    assert disabled.status_code == 200, disabled.text

    edited = await client.put(
        _loop_url(test_board), json={**FULL_PUT_BODY, "enabled": False}
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["enabled"] is False
    assert edited.json()["disabled_reason"] == "objective met"


# --- PATCH /loop/state -------------------------------------------------------


@pytest.mark.parametrize("enabled", [True, False], ids=["enable", "disable"])
async def test_patch_state_unconfigured_returns_404(
    enabled: bool,
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    response = await client.patch(
        _state_url(test_board), json={"enabled": enabled, "reason": ""}
    )
    assert response.status_code == 404, response.text
    assert response.json().get("error_code") == "not_found", response.text


async def test_patch_state_disable_writes_reason_and_bumps_version(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    put = await client.put(_loop_url(test_board), json=FULL_PUT_BODY)
    assert put.status_code in (200, 201), put.text

    response = await client.patch(
        _state_url(test_board),
        json={"enabled": False, "reason": "max_iterations reached (10)"},
    )
    assert response.status_code == 200, response.text
    data = response.json()
    _assert_complete_loop_object(data)
    assert data["enabled"] is False
    assert data["disabled_reason"] == "max_iterations reached (10)"
    assert data["version"] == 2
    activity = await db_session.scalar(
        select(Activity).where(
            Activity.summary == "disabled loop: max_iterations reached (10)"
        )
    )
    assert activity is not None
    assert activity.message_key is None
    assert activity.message_params is None


async def test_patch_state_disable_empty_reason_stores_null(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    put = await client.put(_loop_url(test_board), json=FULL_PUT_BODY)
    assert put.status_code in (200, 201), put.text

    response = await client.patch(
        _state_url(test_board), json={"enabled": False, "reason": ""}
    )
    assert response.status_code == 200, response.text
    assert response.json()["disabled_reason"] is None  # "" is stored as null

    get = await client.get(_loop_url(test_board))
    assert get.json()["disabled_reason"] is None
    activity = await db_session.scalar(
        select(Activity).where(Activity.summary == "disabled loop")
    )
    assert activity is not None
    assert activity.message_key == "activity.board.loop_disabled"
    assert activity.message_params == {}


async def test_patch_state_enable_without_prompt_422(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    put = await client.put(_loop_url(test_board), json={})  # loop_prompt ""
    assert put.status_code in (200, 201), put.text

    response = await client.patch(
        _state_url(test_board), json={"enabled": True, "reason": ""}
    )
    assert response.status_code == 422, response.text

    get = await client.get(_loop_url(test_board))
    assert get.json()["enabled"] is False


async def test_patch_state_enable_clears_disabled_reason(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    put = await client.put(_loop_url(test_board), json=FULL_PUT_BODY)
    assert put.status_code in (200, 201), put.text
    disabled = await client.patch(
        _state_url(test_board), json={"enabled": False, "reason": "paused"}
    )
    assert disabled.status_code == 200, disabled.text
    assert disabled.json()["version"] == 2

    response = await client.patch(
        _state_url(test_board), json={"enabled": True, "reason": ""}
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["enabled"] is True
    assert data["disabled_reason"] is None
    assert data["version"] == 3


async def test_patch_state_same_state_idempotent_no_version_bump(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    """Same-state PATCH short-circuits: 200 + current object, no version bump,
    no activity, no WS event (mirrors the freeze idempotency semantics)."""
    put = await client.put(_loop_url(test_board), json=FULL_PUT_BODY)
    assert put.status_code in (200, 201), put.text
    first = await client.patch(
        _state_url(test_board), json={"enabled": False, "reason": "done"}
    )
    assert first.status_code == 200, first.text
    assert first.json()["version"] == 2

    activities_before = await _loop_activity_count(db_session, test_board)

    with patch.object(event_bus, "publish", new_callable=AsyncMock) as mock_publish:
        second = await client.patch(
            _state_url(test_board), json={"enabled": False, "reason": "again"}
        )
        assert second.status_code == 200, second.text
        data = second.json()
        _assert_complete_loop_object(data)
        assert data["enabled"] is False
        assert data["version"] == 2  # no bump
        # No-op must not overwrite the original reason.
        assert data["disabled_reason"] == "done"
        assert _loop_events(mock_publish) == []

    activities_after = await _loop_activity_count(db_session, test_board)
    assert activities_after == activities_before


# --- activity ----------------------------------------------------------------


async def test_put_loop_records_activity_with_loop_config_field(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    response = await client.put(_loop_url(test_board), json=FULL_PUT_BODY)
    assert response.status_code in (200, 201), response.text

    activity = await db_session.scalar(
        select(Activity)
        .where(
            Activity.entity_type == ActivityEntityType.board,
            Activity.entity_id == test_board.id,
            Activity.action == ActivityAction.updated,
        )
        .order_by(Activity.created_at.desc())
    )
    assert activity is not None
    assert "loop_config" in (activity.changes or {}).get("fields", [])


async def test_patch_state_disable_records_activity_with_reason(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    put = await client.put(_loop_url(test_board), json=FULL_PUT_BODY)
    assert put.status_code in (200, 201), put.text

    response = await client.patch(
        _state_url(test_board),
        json={"enabled": False, "reason": "budget_usd exhausted ($21 of $20)"},
    )
    assert response.status_code == 200, response.text

    activity = await db_session.scalar(
        select(Activity)
        .where(
            Activity.entity_type == ActivityEntityType.board,
            Activity.entity_id == test_board.id,
            Activity.action == ActivityAction.updated,
        )
        .order_by(Activity.created_at.desc())
    )
    assert activity is not None
    assert "budget_usd exhausted" in activity.summary


# --- WS broadcast ------------------------------------------------------------


async def test_put_loop_publishes_board_loop_updated(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    with patch.object(event_bus, "publish", new_callable=AsyncMock) as mock_publish:
        response = await client.put(_loop_url(test_board), json=FULL_PUT_BODY)
        assert response.status_code in (200, 201), response.text

        loop_events = _loop_events(mock_publish)
        assert loop_events, "board.loop_updated was never published"
        event_type, payload, workspace_id = loop_events[-1]
        # No board rooms exist — the frontend filters client-side, so the thin
        # payload MUST carry the stringified board_id.
        assert payload["board_id"] == str(test_board.id)
        assert payload["workspace_id"] == str(test_workspace.id)
        assert payload["enabled"] is True
        assert payload["version"] == 1
        assert "disabled_reason" in payload
        assert workspace_id == test_workspace.id


async def test_patch_state_flip_publishes_board_loop_updated(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    put = await client.put(_loop_url(test_board), json=FULL_PUT_BODY)
    assert put.status_code in (200, 201), put.text

    with patch.object(event_bus, "publish", new_callable=AsyncMock) as mock_publish:
        response = await client.patch(
            _state_url(test_board), json={"enabled": False, "reason": "done"}
        )
        assert response.status_code == 200, response.text

        loop_events = _loop_events(mock_publish)
        assert loop_events, "board.loop_updated was never published"
        _, payload, _ = loop_events[-1]
        assert payload["board_id"] == str(test_board.id)
        assert payload["enabled"] is False
        assert payload["disabled_reason"] == "done"


# --- card-less loop_iteration executions (green pins — no code change) -------


async def test_loop_iteration_execution_cardless_accepted(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_agent: Agent,
):
    """The runner logs each iteration as an AgentExecution with action
    "loop_iteration" and NO card_id key at all. Pins that the existing
    execution endpoints accept exactly that shape."""
    started = await client.post(
        f"/api/agents/{test_agent.id}/executions",
        json={
            "workspace_slug": "default",
            "action": "loop_iteration",
            "input_summary": "loop iteration 1",
            "board_id": str(test_board.id),
        },
    )
    assert started.status_code == 201, started.text
    execution_id = started.json()["id"]

    completed = await client.patch(
        f"/api/agents/{test_agent.id}/executions/{execution_id}",
        json={"status": "completed", "output_summary": "cost=$0.01 duration=1.5s"},
    )
    assert completed.status_code == 200, completed.text
    assert completed.json()["status"] == "completed"


# --------------------------------------------------------------------------
# Card 102dc48e — max_blocked_on_human: the harness's rail for a loop whose
# sessions keep reporting they need a human. Zero disables the rail entirely
# (park-only, the pre-card behavior).


async def test_put_max_blocked_on_human_defaults_to_three(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(_loop_url(test_board), json={"loop_prompt": "x"})
    assert response.status_code in (200, 201), response.text
    assert response.json()["max_blocked_on_human"] == 3


async def test_put_max_blocked_on_human_round_trips(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "max_blocked_on_human": 5},
    )
    assert response.status_code in (200, 201), response.text
    assert response.json()["max_blocked_on_human"] == 5

    get_response = await client.get(_loop_url(test_board))
    assert get_response.json()["max_blocked_on_human"] == 5


async def test_put_max_blocked_on_human_zero_disables_the_rail(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """0 is the documented opt-out, not an out-of-bounds value."""
    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "max_blocked_on_human": 0},
    )
    assert response.status_code in (200, 201), response.text
    assert response.json()["max_blocked_on_human"] == 0


async def test_put_max_blocked_on_human_negative_422(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "max_blocked_on_human": -1},
    )
    assert response.status_code == 422, response.text
    assert "out_of_bounds" in response.text, response.text


async def test_put_max_blocked_on_human_omitted_inherits_stored_value(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "max_blocked_on_human": 7},
    )
    response = await client.put(_loop_url(test_board), json={"loop_prompt": "y"})
    assert response.status_code in (200, 201), response.text
    assert response.json()["max_blocked_on_human"] == 7


# --- raw-prompt guards + size caps (card de3bbd77) ---------------------------
#
# Unit coverage of the findings themselves lives in
# tests/services/kanban/test_loop_config_validation_guards.py; these pin the
# ROUTER contract: the 422 status, the error shape, and — for each guard — that
# the rejected config was never stored.


async def test_put_loop_unrendered_slot_422(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "Iteration {{.Iteration}} <<RUN_LABEL>>"},
    )
    assert response.status_code == 422, response.text

    detail = response.json()["detail"]
    assert [f["code"] for f in detail] == ["unrendered_slot"], detail
    assert detail[0]["field"] == "loop_prompt", detail
    assert "RUN_LABEL" in detail[0]["message"], detail

    get = await client.get(_loop_url(test_board))
    assert get.status_code == 404


@pytest.mark.parametrize(
    "prompt",
    ["cat <<EOF\nbody\nEOF", "run 2>>log", "<<lowercase>>"],
    ids=["heredoc", "stderr_append", "lowercase"],
)
async def test_put_loop_shell_syntax_in_prompt_is_accepted(
    prompt: str, client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """The grammar is uppercase-only precisely so real prompts keep working."""
    response = await client.put(_loop_url(test_board), json={"loop_prompt": prompt})
    assert response.status_code in (200, 201), response.text
    assert response.json()["loop_prompt"] == prompt


async def test_put_loop_enabled_without_off_switch_tool_422(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(
        _loop_url(test_board),
        json={
            "loop_prompt": "x",
            "enabled": True,
            "tools": ["mcp__valaris__get_card"],
        },
    )
    assert response.status_code == 422, response.text

    detail = response.json()["detail"]
    assert [f["code"] for f in detail] == ["off_switch_removed"], detail
    assert detail[0]["field"] == "tools", detail

    get = await client.get(_loop_url(test_board))
    assert get.status_code == 404


async def test_put_loop_disabled_without_off_switch_tool_accepted(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(
        _loop_url(test_board),
        json={
            "loop_prompt": "x",
            "enabled": False,
            "tools": ["mcp__valaris__get_card"],
        },
    )
    assert response.status_code in (200, 201), response.text
    assert response.json()["tools"] == ["mcp__valaris__get_card"]


async def test_put_loop_enabled_with_empty_tools_accepted(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """Empty tools = full platform surface, off switch included."""
    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "enabled": True, "tools": []},
    )
    assert response.status_code in (200, 201), response.text
    assert response.json()["enabled"] is True


async def test_patch_state_enable_without_off_switch_tool_422(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """set_loop_state validates {**stored, enabled} — an allowlist staged while
    disabled must be rejected at the moment it would go live."""
    put = await client.put(
        _loop_url(test_board),
        json={
            "loop_prompt": "x",
            "enabled": False,
            "tools": ["mcp__valaris__get_card"],
        },
    )
    assert put.status_code in (200, 201), put.text

    response = await client.patch(
        _state_url(test_board), json={"enabled": True, "reason": ""}
    )
    assert response.status_code == 422, response.text
    assert [f["code"] for f in response.json()["detail"]] == ["off_switch_removed"]

    get = await client.get(_loop_url(test_board))
    assert get.json()["enabled"] is False


async def test_patch_state_enable_with_off_switch_tool_succeeds(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    put = await client.put(
        _loop_url(test_board),
        json={
            "loop_prompt": "x",
            "enabled": False,
            "tools": ["mcp__valaris__get_card", "mcp__valaris__set_board_loop"],
        },
    )
    assert put.status_code in (200, 201), put.text

    response = await client.patch(
        _state_url(test_board), json={"enabled": True, "reason": ""}
    )
    assert response.status_code == 200, response.text
    assert response.json()["enabled"] is True


async def test_put_loop_prompt_one_byte_over_cap_422(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    from app.services.loop_config_validation import PROMPT_MAX_BYTES

    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "a" * (PROMPT_MAX_BYTES + 1)},
    )
    assert response.status_code == 422, response.text

    detail = response.json()["detail"]
    assert [f["code"] for f in detail] == ["prompt_too_large"], detail
    assert detail[0]["field"] == "loop_prompt", detail

    get = await client.get(_loop_url(test_board))
    assert get.status_code == 404


async def test_put_loop_prompt_exactly_at_cap_accepted(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    from app.services.loop_config_validation import PROMPT_MAX_BYTES

    prompt = "a" * PROMPT_MAX_BYTES
    response = await client.put(_loop_url(test_board), json={"loop_prompt": prompt})
    assert response.status_code in (200, 201), response.text
    assert len(response.json()["loop_prompt"]) == PROMPT_MAX_BYTES


# --- unknown_runner_var (card 22386875) --------------------------------------
#
# Unit coverage of the finding lives in
# tests/services/kanban/test_loop_config_validation_guards.py; these pin the
# ROUTER contract: the 422 status, the error shape, and that the rejected
# config was never stored.


async def test_put_loop_pipeline_only_runner_var_422(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """{{.CardID}} is a real PromptContext field, so the runner would render it
    as "" and never report anything. Save time is the only place to catch it."""
    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "Work card {{.CardID}} on {{.BoardID}}"},
    )
    assert response.status_code == 422, response.text

    detail = response.json()["detail"]
    assert [f["code"] for f in detail] == ["unknown_runner_var"], detail
    assert detail[0]["field"] == "loop_prompt", detail
    assert detail[0]["value"] == ["CardID"], detail
    assert "CardID" in detail[0]["message"], detail

    get = await client.get(_loop_url(test_board))
    assert get.status_code == 404


async def test_put_loop_var_absent_from_the_runner_struct_422(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(
        _loop_url(test_board), json={"loop_prompt": "{{.Bogus}}"}
    )
    assert response.status_code == 422, response.text

    detail = response.json()["detail"]
    assert [f["code"] for f in detail] == ["unknown_runner_var"], detail
    assert detail[0]["value"] == ["Bogus"], detail

    get = await client.get(_loop_url(test_board))
    assert get.status_code == 404


async def test_put_loop_system_prompt_runner_var_is_guarded_too(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """A guard on loop_prompt alone would leave the other half of the wire
    payload unchecked — the runner renders BOTH strings every iteration."""
    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "ok {{.Iteration}}", "system_prompt": "{{.Branch}}"},
    )
    assert response.status_code == 422, response.text

    detail = response.json()["detail"]
    assert [f["code"] for f in detail] == ["unknown_runner_var"], detail
    assert detail[0]["field"] == "system_prompt", detail


async def test_put_loop_all_five_runner_vars_accepted(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    from app.services.loop_config_validation import LOOP_RUNNER_VARS

    prompt = " ".join(f"{{{{.{name}}}}}" for name in LOOP_RUNNER_VARS)
    response = await client.put(_loop_url(test_board), json={"loop_prompt": prompt})

    assert response.status_code in (200, 201), response.text
    assert response.json()["loop_prompt"] == prompt


async def test_put_loop_disabled_cannot_stage_an_unsupported_runner_var(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """AC4. PATCH /loop/state re-validates {**stored, enabled}, but it can only
    reject what a PUT already accepted — so the staging route is closed at the
    PUT, disabled or not. Nothing is stored, so there is nothing to enable."""
    put = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "{{.CardID}}", "enabled": False},
    )
    assert put.status_code == 422, put.text
    assert [f["code"] for f in put.json()["detail"]] == ["unknown_runner_var"]

    get = await client.get(_loop_url(test_board))
    assert get.status_code == 404

    # `reason` is a required body field on this route; omitting it would make
    # the 404 below a Pydantic 422 instead and prove nothing.
    patch = await client.patch(
        _state_url(test_board), json={"enabled": True, "reason": ""}
    )
    assert patch.status_code == 404, patch.text


async def test_put_loop_landing_self_merge_round_trips(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """Card B9: the mode Loops #6–#8 actually ran finally has a value."""
    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "loop_landing": "self_merge"},
    )
    assert response.status_code in (200, 201), response.text
    assert response.json()["loop_landing"] == "self_merge"

    get_response = await client.get(_loop_url(test_board))
    assert get_response.json()["loop_landing"] == "self_merge"


async def test_put_loop_landing_invalid_value_422_names_all_three(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "loop_landing": "banana"},
    )
    assert response.status_code == 422, response.text
    assert "invalid_loop_landing" in response.text, response.text
    for mode in ("human", "merge_queue", "self_merge"):
        assert mode in response.text, response.text


# --- B10: done-gate auto-relax — landing IS the consent, self_merge-scoped,
# board-only. relax_done_merge_gate=false is the decline lever. ---


async def test_put_loop_relax_stamps_the_board_override_false(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo,
    db_session: AsyncSession,
):
    """AC1. The relax signal is the ONLY thing that flips the board override,
    and it writes the BOARD column, never the workspace flag."""
    response = await client.put(
        _loop_url(test_board),
        json={
            "loop_prompt": "x",
            "loop_landing": "self_merge",
            "relax_done_merge_gate": True,
        },
    )
    assert response.status_code in (200, 201), response.text

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is False

    workspace_config = (
        await db_session.execute(
            select(WorkspaceConfig).where(
                WorkspaceConfig.workspace_id == test_workspace.id
            )
        )
    ).scalar_one_or_none()
    assert (
        workspace_config is None
        or workspace_config.enforce_done_merge_gate is not False
    )


async def test_put_loop_relax_is_never_stored_in_the_loop_config(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo,
    db_session: AsyncSession,
):
    """The signal is request-scoped: a board-column write, not a loop knob.

    Asserts the STORED config as well as both responses. The wire object is a
    fixed shape the runner json.Unmarshals, and a config key would additionally
    be inherited by every later PUT that omits it — turning a one-shot consent
    into a standing one.
    """
    response = await client.put(
        _loop_url(test_board),
        json={
            "loop_prompt": "x",
            "loop_landing": "self_merge",
            "relax_done_merge_gate": True,
        },
    )
    assert "relax_done_merge_gate" not in response.json()

    get_response = await client.get(_loop_url(test_board))
    assert "relax_done_merge_gate" not in get_response.json()

    await db_session.refresh(test_board)
    assert "relax_done_merge_gate" not in test_board.loop_config
    # The stored object is exactly the canonical key set — pinning the
    # allowlist itself, which is what actually keeps non-config keys out.
    assert set(test_board.loop_config) == set(ALL_LOOP_FIELDS) | {
        "version",
        "updated_at",
        "budget_epoch",
    }


async def test_put_loop_self_merge_auto_relaxes_the_board_override(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo,
    db_session: AsyncSession,
):
    """AC2 (reversed 2026-08-27): a human self_merge save relaxes the gate by
    default — choosing the landing IS the consent. A self_merge loop can never
    satisfy the gate (no reviewed PR exists by construction), so saving one
    with the gate armed was a dead-end the operator had to discover at
    runtime. The stamp still writes the BOARD column only."""
    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "loop_landing": "self_merge"},
    )
    assert response.status_code in (200, 201), response.text

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is False

    workspace_config = (
        await db_session.execute(
            select(WorkspaceConfig).where(
                WorkspaceConfig.workspace_id == test_workspace.id
            )
        )
    ).scalar_one_or_none()
    assert (
        workspace_config is None
        or workspace_config.enforce_done_merge_gate is not False
    )


async def test_put_loop_relax_false_declines_the_auto_relax(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo,
    db_session: AsyncSession,
):
    """Explicit false is the decline lever: the save succeeds, the override is
    untouched, and the operator has knowingly kept a gate their loop cannot
    satisfy."""
    response = await client.put(
        _loop_url(test_board),
        json={
            "loop_prompt": "x",
            "loop_landing": "self_merge",
            "relax_done_merge_gate": False,
        },
    )
    assert response.status_code in (200, 201), response.text

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is None


async def test_put_loop_inherited_landing_never_auto_relaxes(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo,
    db_session: AsyncSession,
):
    """Reversed 2026-08-27 (security review): the stamp requires the landing
    to be EXPRESSED in the request (body field or a template bind in the same
    PUT). An inherited stored self_merge must never stamp — otherwise a party
    who staged the landing earlier converts any later innocent human save
    (a budget tweak, a prompt edit) into the consent it never was."""
    first = await client.put(
        _loop_url(test_board),
        json={
            "loop_prompt": "x",
            "loop_landing": "self_merge",
            "relax_done_merge_gate": False,
        },
    )
    assert first.status_code in (200, 201), first.text

    response = await client.put(_loop_url(test_board), json={"loop_prompt": "y"})
    assert response.status_code in (200, 201), response.text

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is None


async def test_put_loop_agent_staged_landing_cannot_arm_a_human_save(
    client: AsyncClient,
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo,
    db_session: AsyncSession,
):
    """The attack the request-expressed rule exists to close: an agent stores
    loop_landing=self_merge (allowed, no stamp), then a human saves an
    unrelated knob. The human never chose the landing, so nothing stamps."""
    staged = await agent_client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "loop_landing": "self_merge", "enabled": False},
    )
    assert staged.status_code in (200, 201), staged.text

    response = await client.put(_loop_url(test_board), json={"loop_prompt": "y"})
    assert response.status_code in (200, 201), response.text

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is None


async def test_put_loop_auto_relax_never_softens_an_enforced_override(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo,
    db_session: AsyncSession,
):
    """An explicit True override is an admin-only hardening act ("this board
    gates even if the workspace opts out"). Choosing a landing must not
    silently erase it — only the explicit relax signal can (test below)."""
    test_board.enforce_done_merge_gate = True
    await db_session.flush()

    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "loop_landing": "self_merge"},
    )
    assert response.status_code in (200, 201), response.text

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is True

    relax_activity = await db_session.scalar(
        select(Activity).where(
            Activity.entity_id == test_board.id,
            Activity.message_key == "activity.board.done_gate_auto_relaxed",
        )
    )
    assert relax_activity is None


async def test_put_loop_explicit_relax_overrides_an_enforced_board(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo,
    db_session: AsyncSession,
):
    """The explicit signal keeps its pre-existing unconditional semantics: a
    human asking for the relax by name un-hardens even an enforced board."""
    test_board.enforce_done_merge_gate = True
    await db_session.flush()

    response = await client.put(
        _loop_url(test_board),
        json={
            "loop_prompt": "x",
            "loop_landing": "self_merge",
            "relax_done_merge_gate": True,
        },
    )
    assert response.status_code in (200, 201), response.text

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is False


async def test_put_loop_auto_relax_requires_a_linked_repo(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    """No repo, no gate to relax: the done gate structurally exempts repo-less
    boards, and the dialog never shows the notice there — a stamp would be a
    silent, unconsented write that only becomes load-bearing when a repo is
    linked later."""
    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "loop_landing": "self_merge"},
    )
    assert response.status_code in (200, 201), response.text

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is None

    relax_activity = await db_session.scalar(
        select(Activity).where(
            Activity.entity_id == test_board.id,
            Activity.message_key == "activity.board.done_gate_auto_relaxed",
        )
    )
    assert relax_activity is None


async def test_put_loop_auto_relax_requires_the_workspace_gate_on(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo,
    db_session: AsyncSession,
):
    """A workspace that opted out has no armed gate to relax. Stamping False
    anyway would pre-neutralize a future workspace-wide re-enable — a write
    the notice never advertised."""
    db_session.add(
        WorkspaceConfig(workspace_id=test_workspace.id, enforce_done_merge_gate=False)
    )
    await db_session.flush()

    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "loop_landing": "self_merge"},
    )
    assert response.status_code in (200, 201), response.text

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is None


async def test_put_loop_explicit_relax_does_not_require_a_repo(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    """The visibility conditions narrow only the IMPLICIT stamp. The explicit
    signal predates them and keeps its shape: asked for by name, it stamps."""
    response = await client.put(
        _loop_url(test_board),
        json={
            "loop_prompt": "x",
            "loop_landing": "self_merge",
            "relax_done_merge_gate": True,
        },
    )
    assert response.status_code in (200, 201), response.text

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is False


async def test_put_loop_template_bind_with_self_merge_rails_auto_relaxes(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo,
    db_session: AsyncSession,
):
    """The guided path is the one that trapped operators: coding-loop-easy
    rails default to self_merge, so the landing arrives via the template bind,
    not the request body. A bind in THIS request is the operator expressing
    the choice, so it stamps — unlike a landing merely inherited from the
    stored config."""
    response = await client.put(
        _loop_url(test_board),
        json={
            "template": {
                "source": "system",
                "ref": "coding-loop-easy",
                "slot_values": {"RUN_LABEL": "run-1"},
            }
        },
    )
    assert response.status_code in (200, 201), response.text
    assert response.json()["loop_landing"] == "self_merge"

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is False


async def test_put_loop_agent_self_merge_save_never_auto_relaxes(
    agent_client: AsyncClient,
    test_board: Board,
    test_git_repo,
    db_session: AsyncSession,
):
    """Un-arming the gate stays a human act: an agent save of a self_merge
    config succeeds (the off-switch contract below) but never stamps."""
    response = await agent_client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "loop_landing": "self_merge", "enabled": False},
    )
    assert response.status_code in (200, 201), response.text

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is None


async def test_put_loop_landing_move_off_self_merge_rearms_the_gate(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo,
    db_session: AsyncSession,
):
    """The relax follows the landing: any save that moves a stored self_merge
    landing elsewhere restores the override to NULL (inherit), so the gate
    re-arms for the landing that can satisfy it."""
    first = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "loop_landing": "self_merge"},
    )
    assert first.status_code in (200, 201), first.text
    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is False

    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "loop_landing": "human"},
    )
    assert response.status_code in (200, 201), response.text

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is None


async def test_put_loop_agent_landing_move_also_rearms_the_gate(
    client: AsyncClient,
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo,
    db_session: AsyncSession,
):
    """Re-arming is caller-agnostic (security review 2026-08-27): restoring
    the gate is the SAFE direction, and a human-only rule would let an agent
    carry a relaxed gate into a landing the gate should cover."""
    first = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "loop_landing": "self_merge"},
    )
    assert first.status_code in (200, 201), first.text
    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is False

    response = await agent_client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "loop_landing": "human", "enabled": False},
    )
    assert response.status_code in (200, 201), response.text

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is None

    rearm_activity = await db_session.scalar(
        select(Activity).where(
            Activity.entity_id == test_board.id,
            Activity.message_key == "activity.board.done_gate_rearmed",
        )
    )
    assert rearm_activity is not None


async def test_put_loop_rearm_needs_a_stored_self_merge_landing(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo,
    db_session: AsyncSession,
):
    """A manual override on a board that never stored a self_merge landing is
    not ours to clear — the first human save under another landing leaves it."""
    test_board.enforce_done_merge_gate = False
    await db_session.flush()

    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "loop_landing": "human"},
    )
    assert response.status_code in (200, 201), response.text

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is False


async def test_put_loop_rearm_only_touches_a_false_override(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo,
    db_session: AsyncSession,
):
    """An enforced (True) override outranks the restore: moving the landing
    off self_merge must not soften a gate someone explicitly hardened."""
    first = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "loop_landing": "self_merge"},
    )
    assert first.status_code in (200, 201), first.text

    test_board.enforce_done_merge_gate = True
    await db_session.flush()

    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "loop_landing": "human"},
    )
    assert response.status_code in (200, 201), response.text

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is True


async def test_put_loop_auto_relax_records_a_dedicated_activity_once(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo,
    db_session: AsyncSession,
):
    """Flipping an admin-tier safety control deserves its own timeline entry —
    a generic "updated loop config" would bury it. Idempotent saves on an
    already-relaxed board must not repeat it."""
    first = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "loop_landing": "self_merge"},
    )
    assert first.status_code in (200, 201), first.text
    second = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "y", "loop_landing": "self_merge"},
    )
    assert second.status_code in (200, 201), second.text

    relax_activities = (
        (
            await db_session.execute(
                select(Activity).where(
                    Activity.entity_id == test_board.id,
                    Activity.message_key == "activity.board.done_gate_auto_relaxed",
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(relax_activities) == 1


async def test_put_loop_rearm_records_a_dedicated_activity(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo,
    db_session: AsyncSession,
):
    first = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "loop_landing": "self_merge"},
    )
    assert first.status_code in (200, 201), first.text
    second = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "loop_landing": "merge_queue"},
    )
    assert second.status_code in (200, 201), second.text

    rearm_activity = await db_session.scalar(
        select(Activity).where(
            Activity.entity_id == test_board.id,
            Activity.message_key == "activity.board.done_gate_rearmed",
        )
    )
    assert rearm_activity is not None


@pytest.mark.parametrize("landing", ["human", "merge_queue"])
async def test_put_loop_relax_under_a_non_self_merge_landing_is_422(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo,
    db_session: AsyncSession,
    landing: str,
):
    """AC3, and the contract this run pins: REJECT rather than ignore. A
    silently-dropped relax leaves the operator believing the gate is off."""
    response = await client.put(
        _loop_url(test_board),
        json={
            "loop_prompt": "x",
            "loop_landing": landing,
            "relax_done_merge_gate": True,
        },
    )
    assert response.status_code == 422, response.text
    body = response.json()
    assert body["error_code"] == "relax_gate_requires_self_merge"
    assert body["error_params"]["loop_landing"] == landing

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is None


async def test_put_loop_relax_under_the_inherited_default_landing_is_422(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo,
    db_session: AsyncSession,
):
    """The scope check reads the CANONICAL landing, not the request body. A
    body that omits loop_landing inherits `human` — relaxing there is the same
    refusal, and a check written against `data.loop_landing` would miss it."""
    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "relax_done_merge_gate": True},
    )
    assert response.status_code == 422, response.text
    assert response.json()["error_code"] == "relax_gate_requires_self_merge"

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is None


async def test_put_loop_relax_inherits_a_stored_self_merge_landing(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo,
    db_session: AsyncSession,
):
    """Mirror of the test above: a board already saved as self_merge may relax
    on a later PUT that does not re-send the landing."""
    first = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "loop_landing": "self_merge"},
    )
    assert first.status_code in (200, 201), first.text

    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "y", "relax_done_merge_gate": True},
    )
    assert response.status_code in (200, 201), response.text

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is False


async def test_put_loop_relax_is_idempotent_on_an_already_relaxed_board(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo,
    db_session: AsyncSession,
):
    test_board.enforce_done_merge_gate = False
    await db_session.flush()

    response = await client.put(
        _loop_url(test_board),
        json={
            "loop_prompt": "x",
            "loop_landing": "self_merge",
            "relax_done_merge_gate": True,
        },
    )
    assert response.status_code in (200, 201), response.text

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is False


async def test_put_loop_relax_is_refused_for_agent_callers(
    agent_client: AsyncClient,
    test_board: Board,
    test_git_repo,
    db_session: AsyncSession,
):
    """Consent to drop the done-merge gate is a HUMAN act.

    PUT /loop deliberately admits agent keys (the loop's own off-switch), and
    an agent key inherits its creating admin's role — so without an explicit
    check the very agent the gate constrains could un-arm it in one call.
    """
    response = await agent_client.put(
        _loop_url(test_board),
        json={
            "loop_prompt": "x",
            "loop_landing": "self_merge",
            "relax_done_merge_gate": True,
        },
    )
    assert response.status_code == 403, response.text
    assert response.json()["error_code"] == "admin_required"

    await db_session.refresh(test_board)
    assert test_board.enforce_done_merge_gate is not False
    assert not test_board.loop_config, "a refused relax must not save the loop"


async def test_put_loop_without_relax_still_admits_agent_callers(
    agent_client: AsyncClient,
    test_board: Board,
    test_git_repo,
):
    """The refusal is scoped to the relax signal — agents keep the off-switch."""
    response = await agent_client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "loop_landing": "self_merge", "enabled": False},
    )
    assert response.status_code in (200, 201), response.text
