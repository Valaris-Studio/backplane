# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

import pytest


@pytest.mark.anyio
async def test_get_workspace_cost_merges_agent_and_card_spend(mock_client, ctx):
    from valaris_mcp.tools.metrics import get_workspace_cost

    mock_client.get.side_effect = [
        {
            "agents": [
                {
                    "name": "intern",
                    "agent_type": "coding",
                    "tokens_used_7d": 120_000,
                    "tokens_used_30d": 480_000,
                    "executions_7d": 12,
                    "executions_30d": 48,
                }
            ]
        },
        {
            "cards": [
                {
                    "card_id": "c1",
                    "total_cost_usd": 4.25,
                    "total_tokens": 90_000,
                    "execution_count": 3,
                }
            ]
        },
    ]

    result = json.loads(await get_workspace_cost("acme", ctx=ctx))

    assert [call.args[0] for call in mock_client.get.call_args_list] == [
        "/workspaces/acme/metrics/cost",
        "/workspaces/acme/metrics/card-costs",
    ]
    assert result["agents"][0]["tokens_used_30d"] == 480_000
    assert result["cards"][0]["total_cost_usd"] == 4.25


@pytest.mark.anyio
async def test_get_workspace_velocity_merges_velocity_and_quality(mock_client, ctx):
    from valaris_mcp.tools.metrics import get_workspace_velocity

    mock_client.get.side_effect = [
        {"cards_completed_7d": 6, "cards_completed_30d": 21, "cards_completed_90d": 58},
        {"reversion_rate": 0.08, "agent_efficiency_score": 0.91},
    ]

    result = json.loads(await get_workspace_velocity("acme", ctx=ctx))

    assert [call.args[0] for call in mock_client.get.call_args_list] == [
        "/workspaces/acme/metrics/velocity",
        "/workspaces/acme/metrics/quality",
    ]
    assert result["velocity"]["cards_completed_7d"] == 6
    assert result["quality"]["reversion_rate"] == 0.08
