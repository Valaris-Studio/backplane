# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Partial PUT /loop must merge onto the STORED config, not defaults (card
622a4645, api-safety).

RED phase for the fix: canonicalize_loop_config today overlays every PUT body
onto LOOP_CONFIG_DEFAULTS regardless of what's already saved. A PUT that only
sends {"enabled": false} silently resets max_iterations/budget_usd/loop_prompt
(and every other omitted operator field) to their defaults — a 40x budget
widening reported back as a 200. Omitted key and explicit JSON null are
indistinguishable on LoopConfigPut (both decode to None) and both MUST mean
"leave the stored value unchanged". See docs/loop-mode-contract.md.

Conventions follow tests/routers/kanban/test_board_loop.py — same fixtures,
BASE_URL, and helpers (duplicated locally to keep this file independently
readable; see that module for the canonical field-completeness pin).
"""

from app.models.kanban.board import Board
from app.models.workspace import Workspace
from app.services.loop_config_validation import LOOP_CONFIG_DEFAULTS
from httpx import AsyncClient


BASE_URL = "/api/workspaces/default/boards"

TIGHT_RAILS_BODY = {
    "loop_prompt": "x",
    "max_iterations": 2,
    "budget_usd": 0.5,
}


def _loop_url(board: Board) -> str:
    return f"{BASE_URL}/{board.id}/loop"


async def test_partial_put_preserves_omitted_rails(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    created = await client.put(_loop_url(test_board), json=TIGHT_RAILS_BODY)
    assert created.status_code in (200, 201), created.text
    version = created.json()["version"]

    partial = await client.put(
        _loop_url(test_board),
        json={"enabled": False, "expected_version": version},
    )
    assert partial.status_code == 200, partial.text
    data = partial.json()
    assert data["enabled"] is False
    assert data["version"] == version + 1

    current = await client.get(_loop_url(test_board))
    body = current.json()
    assert body["max_iterations"] == 2, (
        "omitted max_iterations must stay at the stored value, not reset to "
        f"the default {LOOP_CONFIG_DEFAULTS['max_iterations']}"
    )
    assert body["budget_usd"] == 0.5, (
        "omitted budget_usd must stay at the stored value, not widen to the "
        f"default {LOOP_CONFIG_DEFAULTS['budget_usd']} — the exact silent "
        "40x budget widening this card reports"
    )
    assert body["loop_prompt"] == "x"


async def test_partial_put_preserves_loop_prompt_reenable(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """The reported symptom: loop_prompt reset to "" by the partial PUT then
    blocks re-enabling (enabled=true requires non-empty loop_prompt)."""
    created = await client.put(_loop_url(test_board), json=TIGHT_RAILS_BODY)
    assert created.status_code in (200, 201), created.text
    version = created.json()["version"]

    disabled = await client.put(
        _loop_url(test_board),
        json={"enabled": False, "expected_version": version},
    )
    assert disabled.status_code == 200, disabled.text
    version = disabled.json()["version"]

    re_enabled = await client.put(
        _loop_url(test_board),
        json={"enabled": True, "expected_version": version},
    )
    assert re_enabled.status_code == 200, re_enabled.text
    assert re_enabled.json()["enabled"] is True
    assert re_enabled.json()["loop_prompt"] == "x"


async def test_first_put_applies_defaults(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """No stored config yet: the partial-merge base falls back to
    LOOP_CONFIG_DEFAULTS exactly as it does today."""
    response = await client.put(
        _loop_url(test_board), json={"loop_prompt": "x"}
    )
    assert response.status_code in (200, 201), response.text
    data = response.json()
    assert data["loop_prompt"] == "x"
    assert data["max_iterations"] == LOOP_CONFIG_DEFAULTS["max_iterations"]
    assert data["budget_usd"] == LOOP_CONFIG_DEFAULTS["budget_usd"]
    assert data["iteration_delay_seconds"] == (
        LOOP_CONFIG_DEFAULTS["iteration_delay_seconds"]
    )
    assert data["max_consecutive_failures"] == (
        LOOP_CONFIG_DEFAULTS["max_consecutive_failures"]
    )


async def test_full_put_roundtrips_identically(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """Pins the BoardLoopDialog path: a full 11-field PUT must be unaffected
    by the merge-onto-stored change — every field is explicit, so there's
    nothing to inherit from either base."""
    full_body = {
        "enabled": True,
        "provider": "codex-cli",
        "model": "premium",
        "system_prompt": "You are the maintenance agent.",
        "loop_prompt": "Iteration {{.Iteration}}: make progress.",
        "tools": ["mcp__valaris__get_card", "mcp__valaris__set_board_loop"],
        "max_iterations": 10,
        "iteration_delay_seconds": 5,
        "iteration_timeout_seconds": 600,
        "budget_usd": 7.5,
        "max_consecutive_failures": 2,
    }
    put = await client.put(_loop_url(test_board), json=full_body)
    assert put.status_code in (200, 201), put.text

    current = await client.get(_loop_url(test_board))
    data = current.json()
    for field, value in full_body.items():
        assert data[field] == value, f"{field}: {data[field]!r} != {value!r}"


async def test_rejected_put_leaves_version_and_rails_untouched(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """Regression pin for the optimistic lock: Finding B (a rejected PUT
    mutating stored state) does NOT reproduce at HEAD and must stay that
    way through this fix — a 422 must never land any part of the config."""
    created = await client.put(_loop_url(test_board), json=TIGHT_RAILS_BODY)
    assert created.status_code in (200, 201), created.text
    version = created.json()["version"]

    rejected = await client.put(
        _loop_url(test_board),
        json={"max_iterations": 0, "expected_version": version},
    )
    assert rejected.status_code == 422, rejected.text

    current = await client.get(_loop_url(test_board))
    body = current.json()
    assert body["version"] == version
    assert body["max_iterations"] == 2
    assert body["budget_usd"] == 0.5
    assert body["loop_prompt"] == "x"


async def test_partial_put_expected_version_mismatch_still_409(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """Stale expected_version behavior is unchanged for a partial body."""
    created = await client.put(_loop_url(test_board), json=TIGHT_RAILS_BODY)
    assert created.status_code in (200, 201), created.text

    stale = await client.put(
        _loop_url(test_board),
        json={"enabled": False, "expected_version": 99},
    )
    assert stale.status_code == 409, stale.text

    current = await client.get(_loop_url(test_board))
    body = current.json()
    assert body["max_iterations"] == 2
    assert body["enabled"] is False  # TIGHT_RAILS_BODY never set enabled=true
