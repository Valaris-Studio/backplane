# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""get_workspace_metrics(view=all|velocity|cost) folds the velocity and cost
reads; get_workspace_velocity and get_workspace_cost stay as deprecated
aliases and the default hand carries the folded tool instead of the pair."""

from __future__ import annotations

import json

import pytest

from valaris_mcp.catalog import TOOL_META, deprecated_aliases, tool_annotations
from valaris_mcp.server import mcp
from valaris_mcp.toolsets import DEFAULT_INCLUSIONS, default_hand

pytestmark = pytest.mark.anyio


def test_metrics_aliases_point_at_the_folded_views():
    aliases = deprecated_aliases()
    assert "get_workspace_metrics(view='velocity')" in aliases["get_workspace_velocity"]
    assert "get_workspace_metrics(view='cost')" in aliases["get_workspace_cost"]


def test_get_workspace_metrics_is_a_read_only_agents_executions_tool():
    meta = TOOL_META["get_workspace_metrics"]
    assert meta.category == "agents-executions" and meta.kind == "read"
    assert tool_annotations("get_workspace_metrics", meta).readOnlyHint is True


def test_default_hand_pulls_in_the_folded_metrics_tool_not_the_pair():
    assert "get_workspace_metrics" in DEFAULT_INCLUSIONS
    assert "get_workspace_metrics" in default_hand()
    assert not {"get_workspace_velocity", "get_workspace_cost"} & set(DEFAULT_INCLUSIONS)


def test_get_workspace_metrics_schema_documents_the_views():
    props = mcp._tool_manager._tools["get_workspace_metrics"].parameters["properties"]
    assert props["view"].get("default") == "all"
    for view in ("all", "velocity", "cost"):
        assert view in props["view"]["description"]


async def test_get_workspace_metrics_all_fetches_the_four_endpoints_in_order(mock_client, ctx):
    from valaris_mcp.tools.metrics import get_workspace_metrics

    mock_client.get.side_effect = [
        {"cards_completed_7d": 6},
        {"reversion_rate": 0.08},
        {"agents": [{"name": "intern"}]},
        {"cards": [{"card_id": "c1", "total_cost_usd": 4.25}]},
    ]
    out = json.loads(await get_workspace_metrics("acme", ctx=ctx))
    assert [call.args[0] for call in mock_client.get.call_args_list] == [
        "/workspaces/acme/metrics/velocity",
        "/workspaces/acme/metrics/quality",
        "/workspaces/acme/metrics/cost",
        "/workspaces/acme/metrics/card-costs",
    ]
    assert out["velocity"]["cards_completed_7d"] == 6
    assert out["quality"]["reversion_rate"] == 0.08
    assert out["cost"] == {"agents": [{"name": "intern"}], "cards": [{"card_id": "c1", "total_cost_usd": 4.25}]}


async def test_get_workspace_metrics_velocity_view_skips_the_cost_endpoints(mock_client, ctx):
    from valaris_mcp.tools.metrics import get_workspace_metrics

    mock_client.get.side_effect = [{"cards_completed_7d": 6}, {"reversion_rate": 0.08}]
    out = json.loads(await get_workspace_metrics("acme", view="velocity", ctx=ctx))
    assert [call.args[0] for call in mock_client.get.call_args_list] == [
        "/workspaces/acme/metrics/velocity",
        "/workspaces/acme/metrics/quality",
    ]
    assert set(out) == {"velocity", "quality"}


async def test_get_workspace_metrics_cost_view_skips_the_velocity_endpoints(mock_client, ctx):
    from valaris_mcp.tools.metrics import get_workspace_metrics

    mock_client.get.side_effect = [{"agents": []}, {"cards": []}]
    out = json.loads(await get_workspace_metrics("acme", view="cost", ctx=ctx))
    assert [call.args[0] for call in mock_client.get.call_args_list] == [
        "/workspaces/acme/metrics/cost",
        "/workspaces/acme/metrics/card-costs",
    ]
    assert out == {"cost": {"agents": [], "cards": []}}


async def test_get_workspace_metrics_rejects_an_unknown_view_before_any_request(mock_client, ctx):
    from valaris_mcp.tools.metrics import get_workspace_metrics

    out = json.loads(await get_workspace_metrics("acme", view="spend", ctx=ctx))
    assert out["error"] is True
    assert "velocity" in out["message"] and "cost" in out["message"]
    mock_client.get.assert_not_called()


async def test_velocity_alias_keeps_its_shape_and_stamps_deprecation(mock_client, ctx):
    from valaris_mcp.tools.metrics import get_workspace_velocity

    mock_client.get.side_effect = [{"cards_completed_7d": 6}, {"reversion_rate": 0.08}]
    out = json.loads(await get_workspace_velocity("acme", ctx=ctx))
    assert out["velocity"]["cards_completed_7d"] == 6
    assert out["quality"]["reversion_rate"] == 0.08
    assert "get_workspace_metrics" in out["_deprecated"]


async def test_cost_alias_keeps_its_shape_and_stamps_deprecation(mock_client, ctx):
    from valaris_mcp.tools.metrics import get_workspace_cost

    mock_client.get.side_effect = [{"agents": [{"name": "intern"}]}, {"cards": []}]
    out = json.loads(await get_workspace_cost("acme", ctx=ctx))
    assert out["agents"] == [{"name": "intern"}] and out["cards"] == []
    assert "get_workspace_metrics" in out["_deprecated"]


def test_server_instructions_name_the_folded_metrics_tool_only():
    text = mcp.instructions
    assert "get_workspace_metrics" in text
    assert "get_workspace_velocity" not in text
    assert "get_workspace_cost" not in text
