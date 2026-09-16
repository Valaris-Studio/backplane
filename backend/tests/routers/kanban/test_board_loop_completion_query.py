# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Declarative `completion_query` on the board loop config (card d223a0ec).

RED phase: the loop config has no notion of a completion condition, so every
curated run's "are we done?" check costs a full LLM session per tick. The
field is an OPTIONAL, server-validated `{label, exclude_column_type}` object —
deliberately the same contract as the cards-search endpoint the runner already
calls — and null/absent keeps today's behavior exactly.

Persistence semantics follow the rest of the config: omitted means unchanged
(test_board_loop_partial_put.py), and an explicit `{}` is the documented way to
CLEAR the field back to off, since LoopConfigPut cannot distinguish an omitted
key from an explicit null.

Conventions follow tests/routers/kanban/test_board_loop.py.
"""

from httpx import AsyncClient

from app.models.kanban.board import Board
from app.models.workspace import Workspace


BASE_URL = "/api/workspaces/default/boards"

VALID_QUERY = {"label": "loop-3", "exclude_column_type": "done"}


def _loop_url(board: Board) -> str:
    return f"{BASE_URL}/{board.id}/loop"


async def test_put_persists_completion_query(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    created = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "work a card", "completion_query": VALID_QUERY},
    )
    assert created.status_code in (200, 201), created.text
    assert created.json()["completion_query"] == VALID_QUERY

    served = await client.get(_loop_url(test_board))
    assert served.json()["completion_query"] == VALID_QUERY


async def test_completion_query_defaults_to_null(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """Absent = feature off. The key must still be PRESENT on the wire: the
    runner json.Unmarshals the served object without defaults."""
    created = await client.put(_loop_url(test_board), json={"loop_prompt": "x"})
    assert created.status_code in (200, 201), created.text
    body = created.json()
    assert "completion_query" in body
    assert body["completion_query"] is None


async def test_partial_put_preserves_completion_query(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    created = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "completion_query": VALID_QUERY},
    )
    version = created.json()["version"]

    partial = await client.put(
        _loop_url(test_board),
        json={"enabled": True, "expected_version": version},
    )
    assert partial.status_code == 200, partial.text
    assert partial.json()["completion_query"] == VALID_QUERY


async def test_empty_object_clears_completion_query(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """`{}` is the clear lever — an explicit null is indistinguishable from an
    omitted key on LoopConfigPut, so it cannot mean "turn this off"."""
    await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "completion_query": VALID_QUERY},
    )
    cleared = await client.put(_loop_url(test_board), json={"completion_query": {}})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["completion_query"] is None


async def test_rejects_completion_query_without_label(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "completion_query": {"exclude_column_type": "done"}},
    )
    assert response.status_code == 422, response.text
    assert "invalid_completion_query" in response.text, response.text


async def test_rejects_unknown_completion_query_key(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """Out of scope by card contract: label + exclude_column_type only. An
    unknown key is a silently-ignored filter, i.e. a wrong completion verdict."""
    response = await client.put(
        _loop_url(test_board),
        json={
            "loop_prompt": "x",
            "completion_query": {**VALID_QUERY, "priority": "high"},
        },
    )
    assert response.status_code == 422, response.text
    assert "invalid_completion_query" in response.text, response.text


async def test_rejects_non_done_exclude_column_type(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(
        _loop_url(test_board),
        json={
            "loop_prompt": "x",
            "completion_query": {"label": "loop-3", "exclude_column_type": "active"},
        },
    )
    assert response.status_code == 422, response.text


async def test_rejects_non_object_completion_query(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "x", "completion_query": "loop-3"},
    )
    assert response.status_code == 422, response.text


async def test_state_patch_survives_stored_config_without_completion_query(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """set_loop_state validates {**stored, enabled} WITHOUT canonicalizing, so
    a row written before this field existed has no key to index — the exact
    KeyError shape that 500'd every loop flip when max_blocked_on_human landed
    (iteration 101). Simulated by validating a config dict missing the key."""
    from app.services.loop_config_validation import (
        LOOP_CONFIG_DEFAULTS,
        validate_loop_config,
    )

    legacy = {k: v for k, v in LOOP_CONFIG_DEFAULTS.items() if k != "completion_query"}
    assert validate_loop_config({**legacy, "enabled": False}) == []


async def test_label_only_query_is_canonicalized_with_done_exclusion(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """Validation accepts a label-only query by ASSUMING exclude_column_type
    "done" — the stored config must carry that assumption. The runner treats a
    missing key as no-exclusion, so an uncanonicalized label-only save can
    never reach zero matches and the run is uncompletable in code (Round 13
    Proxmox finding, card 3446dc0f)."""
    created = await client.put(
        _loop_url(test_board),
        json={"loop_prompt": "work a card", "completion_query": {"label": "r13-loop"}},
    )
    assert created.status_code in (200, 201), created.text
    canonical = {"label": "r13-loop", "exclude_column_type": "done"}
    assert created.json()["completion_query"] == canonical

    served = await client.get(_loop_url(test_board))
    assert served.json()["completion_query"] == canonical
