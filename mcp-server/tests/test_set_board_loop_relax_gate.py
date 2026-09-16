# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import pytest


@pytest.mark.anyio
async def test_set_board_loop_relax_gate_false_survives_to_the_put(mock_client, ctx):
    """False is the decline lever for the backend's self_merge auto-relax —
    it must reach the PUT body, so the filter has to be is-not-None."""
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.put.return_value = {"enabled": False, "version": 2}
    await set_board_loop(
        "test", "b1", loop_landing="self_merge", relax_done_merge_gate=False, ctx=ctx
    )
    mock_client.put.assert_called_once()
    sent = mock_client.put.call_args[0][1]
    assert sent["relax_done_merge_gate"] is False


@pytest.mark.anyio
async def test_set_board_loop_relax_gate_true_passes_through(mock_client, ctx):
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.put.return_value = {"enabled": False, "version": 2}
    await set_board_loop(
        "test", "b1", loop_landing="self_merge", relax_done_merge_gate=True, ctx=ctx
    )
    sent = mock_client.put.call_args[0][1]
    assert sent["relax_done_merge_gate"] is True


@pytest.mark.anyio
async def test_set_board_loop_relax_gate_omitted_stays_out_of_payload(
    mock_client, ctx
):
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.put.return_value = {"enabled": False, "version": 2}
    await set_board_loop("test", "b1", loop_landing="self_merge", ctx=ctx)
    sent = mock_client.put.call_args[0][1]
    assert "relax_done_merge_gate" not in sent


@pytest.mark.anyio
async def test_set_board_loop_relax_gate_never_rides_the_state_patch(
    mock_client, ctx
):
    """The flag belongs to the config PUT only — a state-only call must stay
    PATCH-only (the off-switch contract) even when the flag is passed."""
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.patch.return_value = {"enabled": False}
    mock_client.put.return_value = {"enabled": False, "version": 2}
    await set_board_loop(
        "test", "b1", enabled=False, reason="done", relax_done_merge_gate=False, ctx=ctx
    )
    for call in mock_client.patch.call_args_list:
        assert "relax_done_merge_gate" not in call[0][1]
    # Not just "flag absent from the PATCH": the flag must never PROMOTE a
    # state-only call into a config PUT.
    mock_client.put.assert_not_called()
