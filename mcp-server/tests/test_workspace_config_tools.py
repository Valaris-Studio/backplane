# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

import httpx
import pytest


@pytest.mark.anyio
async def test_get_workspace_config(mock_client, ctx):
    from valaris_mcp.tools.workspace_config import get_workspace_config

    mock_client.get.return_value = {
        "max_rework_attempts": 3,
        "card_cooldown_hours": 1.0,
        "commit_message_template": "{title}",
        "pr_description_template": "{body}",
        "model_pricing": None,
        "pipeline_config": {"stages": []},
        "cost_circuit_breaker": None,
        "role_labels": {},
        "version": 7,
    }
    result = json.loads(await get_workspace_config("acme", ctx=ctx))
    mock_client.get.assert_called_once_with("/workspaces/acme/config")
    assert result["version"] == 7
    assert result["pipeline_config"] == {"stages": []}


@pytest.mark.anyio
async def test_update_workspace_config(mock_client, ctx):
    from valaris_mcp.tools.workspace_config import update_workspace_config

    pipeline = {
        "stages": [
            {
                "role": "implementer",
                "discover": {"strategy": "unassigned_or_rework"},
                "claim": {"participant_role": "hero"},
                "git": {"action": "create_branch"},
                "llm": {
                    "enabled": True,
                    "stage": "implement",
                    "context_sources": [
                        {"kind": "card_notes", "as": "notes"},
                        {"kind": "board_definition"},
                    ],
                },
                "on_success": {"move_to_column_type": "review"},
            }
        ]
    }
    mock_client.patch.return_value = {
        "pipeline_config": pipeline,
        "max_rework_attempts": 3,
        "card_cooldown_hours": 1.0,
        "commit_message_template": "{title}",
        "pr_description_template": "{body}",
        "model_pricing": None,
        "cost_circuit_breaker": None,
        "role_labels": {},
        "version": 8,
    }
    result = json.loads(
        await update_workspace_config("acme", pipeline_config=pipeline, ctx=ctx)
    )
    mock_client.patch.assert_called_once_with(
        "/workspaces/acme/config", {"pipeline_config": pipeline}
    )
    assert result["version"] == 8
    assert result["pipeline_config"]["stages"][0]["llm"]["context_sources"][0]["kind"] == "card_notes"


@pytest.mark.anyio
async def test_update_workspace_config_partial_does_not_send_unset_fields(mock_client, ctx):
    from valaris_mcp.tools.workspace_config import update_workspace_config

    mock_client.patch.return_value = {
        "max_rework_attempts": 5,
        "card_cooldown_hours": 1.0,
        "commit_message_template": "",
        "pr_description_template": "",
        "model_pricing": None,
        "pipeline_config": None,
        "cost_circuit_breaker": None,
        "role_labels": {},
        "version": 9,
    }
    await update_workspace_config("acme", max_rework_attempts=5, ctx=ctx)
    sent_path, sent_body = mock_client.patch.call_args[0]
    assert sent_path == "/workspaces/acme/config"
    assert sent_body == {"max_rework_attempts": 5}


@pytest.mark.anyio
async def test_update_workspace_config_passes_through_validation_error(mock_client, ctx):
    from valaris_mcp.tools.workspace_config import update_workspace_config

    error_body = {
        "detail": [
            {
                "code": "unknown_context_source_kind",
                "field": "stages[0].llm.context_sources[0].kind",
                "message": "unknown context_sources.kind 'bogus'",
                "value": "bogus",
            }
        ]
    }
    resp = httpx.Response(
        422, json=error_body, request=httpx.Request("PATCH", "http://test")
    )
    mock_client.patch.side_effect = httpx.HTTPStatusError(
        "Unprocessable Entity", request=resp.request, response=resp
    )
    raw = await update_workspace_config(
        "acme",
        pipeline_config={
            "stages": [
                {"llm": {"context_sources": [{"kind": "bogus"}]}}
            ]
        },
        ctx=ctx,
    )
    parsed = json.loads(raw)
    assert parsed["error"] is True
    assert parsed["status"] == 422
    assert "unknown context_sources.kind" in json.dumps(parsed["message"])


@pytest.mark.anyio
async def test_update_workspace_config_no_fields_returns_error_without_calling_backend(
    mock_client, ctx
):
    from valaris_mcp.tools.workspace_config import update_workspace_config

    raw = await update_workspace_config("acme", ctx=ctx)
    parsed = json.loads(raw)
    assert parsed["error"] is True
    assert "no fields" in parsed["message"].lower()
    mock_client.patch.assert_not_called()


@pytest.mark.anyio
async def test_get_pipeline_sensors(mock_client, ctx):
    from valaris_mcp.tools.workspace_config import get_pipeline_sensors

    mock_client.get.return_value = [
        {"name": "ci_status", "kind": "build", "agent_id": "abc"},
    ]
    result = json.loads(await get_pipeline_sensors("acme", ctx=ctx))
    mock_client.get.assert_called_once_with("/workspaces/acme/sensors")
    assert isinstance(result, list)
    assert result[0]["name"] == "ci_status"


@pytest.mark.anyio
async def test_resume_cost_breaker(mock_client, ctx):
    from valaris_mcp.tools.workspace_config import resume_cost_breaker

    mock_client.post.return_value = {
        "status": "resumed",
        "workspace_id": "11111111-2222-3333-4444-555555555555",
    }
    result = json.loads(await resume_cost_breaker("acme", ctx=ctx))
    mock_client.post.assert_called_once_with("/workspaces/acme/cost-breaker/resume")
    assert result["status"] == "resumed"
    assert result["workspace_id"] == "11111111-2222-3333-4444-555555555555"


@pytest.mark.anyio
async def test_resume_cost_breaker_non_admin_surfaces_403(mock_client, ctx):
    from valaris_mcp.tools.workspace_config import resume_cost_breaker

    resp = httpx.Response(
        403,
        json={"detail": "Admin access required"},
        request=httpx.Request("POST", "http://test"),
    )
    mock_client.post.side_effect = httpx.HTTPStatusError(
        "Forbidden", request=resp.request, response=resp
    )
    parsed = json.loads(await resume_cost_breaker("acme", ctx=ctx))
    assert parsed["error"] is True
    assert parsed["status"] == 403
    assert parsed["message"] == "Admin access required"
