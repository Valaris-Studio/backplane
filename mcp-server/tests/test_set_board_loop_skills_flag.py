# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import pytest


@pytest.mark.anyio
async def test_set_board_loop_skills_proposal_enabled_false_survives(mock_client, ctx):
    """False must reach the PUT body — the config body filter has to be
    is-not-None, not truthiness."""
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.put.return_value = {"enabled": False, "version": 2}
    await set_board_loop("test", "b1", skills_proposal_enabled=False, ctx=ctx)
    mock_client.put.assert_called_once()
    sent = mock_client.put.call_args[0][1]
    assert sent["skills_proposal_enabled"] is False


@pytest.mark.anyio
async def test_set_board_loop_skills_proposal_enabled_true_passes_through(
    mock_client, ctx
):
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.put.return_value = {"enabled": False, "version": 2}
    await set_board_loop("test", "b1", skills_proposal_enabled=True, ctx=ctx)
    sent = mock_client.put.call_args[0][1]
    assert sent["skills_proposal_enabled"] is True


@pytest.mark.anyio
async def test_set_board_loop_skills_proposal_omitted_stays_out_of_payload(
    mock_client, ctx
):
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.put.return_value = {"enabled": False, "version": 2}
    await set_board_loop("test", "b1", loop_prompt="go", ctx=ctx)
    sent = mock_client.put.call_args[0][1]
    assert "skills_proposal_enabled" not in sent
