# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""update_board's per-board done-merge-gate override.

The tri-state travels as a string ('inherit'/'enforced'/'off') because the
backend distinguishes an OMITTED key (leave the override alone) from an
explicit null (clear it back to inheriting the workspace flag) — a bool
parameter cannot express that third state.
"""

from __future__ import annotations

import json

import pytest


@pytest.mark.anyio
async def test_done_merge_gate_off_sends_false(mock_client, ctx):
    from valaris_mcp.tools.boards import update_board

    mock_client.patch.return_value = {"id": "b1", "enforce_done_merge_gate": False}
    await update_board("test", "b1", done_merge_gate="off", ctx=ctx)

    body = mock_client.patch.call_args[0][1]
    assert body["enforce_done_merge_gate"] is False


@pytest.mark.anyio
async def test_done_merge_gate_enforced_sends_true(mock_client, ctx):
    from valaris_mcp.tools.boards import update_board

    mock_client.patch.return_value = {"id": "b1", "enforce_done_merge_gate": True}
    await update_board("test", "b1", done_merge_gate="enforced", ctx=ctx)

    body = mock_client.patch.call_args[0][1]
    assert body["enforce_done_merge_gate"] is True


@pytest.mark.anyio
async def test_done_merge_gate_inherit_sends_explicit_null(mock_client, ctx):
    """'inherit' must PUT the key with a null value, not drop it."""
    from valaris_mcp.tools.boards import update_board

    mock_client.patch.return_value = {"id": "b1", "enforce_done_merge_gate": None}
    await update_board("test", "b1", done_merge_gate="inherit", ctx=ctx)

    body = mock_client.patch.call_args[0][1]
    assert "enforce_done_merge_gate" in body
    assert body["enforce_done_merge_gate"] is None


@pytest.mark.anyio
async def test_done_merge_gate_omitted_omits_key(mock_client, ctx):
    from valaris_mcp.tools.boards import update_board

    mock_client.patch.return_value = {"id": "b1", "name": "Renamed"}
    await update_board("test", "b1", name="Renamed", ctx=ctx)

    body = mock_client.patch.call_args[0][1]
    assert "enforce_done_merge_gate" not in body
    assert body["name"] == "Renamed"


@pytest.mark.anyio
async def test_done_merge_gate_invalid_value_errors_before_http(mock_client, ctx):
    from valaris_mcp.tools.boards import update_board

    result = json.loads(await update_board("test", "b1", done_merge_gate="on", ctx=ctx))

    assert result["error"] is True
    assert "inherit" in result["message"] and "enforced" in result["message"]
    mock_client.patch.assert_not_called()


@pytest.mark.anyio
async def test_done_merge_gate_combines_with_other_fields(mock_client, ctx):
    from valaris_mcp.tools.boards import update_board

    mock_client.patch.return_value = {"id": "b1"}
    await update_board(
        "test", "b1", name="Ops", done_merge_gate="off", ctx=ctx
    )

    body = mock_client.patch.call_args[0][1]
    assert body == {"name": "Ops", "enforce_done_merge_gate": False}
