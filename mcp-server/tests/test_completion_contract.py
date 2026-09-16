# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Public completion tools carry provenance; runner acknowledgments stay private."""

from __future__ import annotations

import json

import httpx
import pytest

from tests.conftest import make_ctx
from valaris_mcp.catalog import TOOL_META, tool_annotations
from valaris_mcp.server import mcp

pytestmark = pytest.mark.anyio

CARD_ID = "aaaaaaaa-0000-4000-8000-00000000000c"
EXECUTION_ID = "bbbbbbbb-0000-4000-8000-000000000001"
BASE = "/workspaces/test/boards/b1/completion"
PUBLIC_TOOLS = {
    "get_completion_policy": "read",
    "get_completion_status": "read",
    "submit_completion_candidate": "write",
    "request_landing": "write",
    "retry_completion": "write",
}


def _tool(name):
    registered = mcp._tool_manager._tools
    assert name in registered, f"Missing public completion tool: {name}"
    return registered[name].fn


@pytest.mark.parametrize("name,kind", PUBLIC_TOOLS.items())
def test_public_completion_tools_are_catalogued_and_visibility_safe_retries(name, kind):
    _tool(name)
    assert TOOL_META[name].kind == kind
    annotations = tool_annotations(name, TOOL_META[name])
    assert annotations.idempotentHint is True
    assert annotations.readOnlyHint is (kind == "read")


def test_model_tool_surface_has_no_completion_claim_result_or_lease_parameters():
    for name, tool in mcp._tool_manager._tools.items():
        if "completion" in name:
            assert not any(verb in name for verb in ("claim", "acknowledge", "result")), name
        properties = tool.parameters.get("properties", {})
        assert "lease_token" not in properties, name
        assert "completion_lease" not in properties, name
    for name in PUBLIC_TOOLS:
        if name in mcp._tool_manager._tools:
            properties = mcp._tool_manager._tools[name].parameters.get("properties", {})
            assert "completion_mode" not in properties, name


async def test_get_completion_policy_preserves_configured_role_and_provenance(mock_client, ctx):
    expected = {
        "origin": "workspace",
        "override": None,
        "policy_hash": "policy-a",
        "effective_policy": {
            "version": 1,
            "landing_actor": "platform",
            "review_role": "architecture_and_performance_assessor",
        },
        "capabilities": {"github": True},
        "incompatibilities": [],
    }
    mock_client.get.return_value = expected.copy()
    result = json.loads(await _tool("get_completion_policy")("test", "b1", ctx=ctx))
    mock_client.get.assert_awaited_once_with(f"{BASE}/policy")
    assert {key: result[key] for key in expected} == expected
    assert result["_hint"]


async def test_get_completion_status_reads_public_card_receipt(mock_client, ctx):
    receipt = {
        "completion_mode": "source",
        "candidate": {
            "id": "candidate-a", "status": "validation_failed",
            "source_sha": "a" * 40, "merge_sha": "b" * 40,
            "policy_hash": "policy-a", "summary": "Exact commit check failed",
        },
        "attempts": [{"kind": "validation", "status": "failed"}],
    }
    mock_client.get.return_value = receipt.copy()
    result = json.loads(await _tool("get_completion_status")("test", "b1", CARD_ID, ctx=ctx))
    mock_client.get.assert_awaited_once_with(f"{BASE}/cards/{CARD_ID}")
    assert result["candidate"] == receipt["candidate"]
    assert result["attempts"] == receipt["attempts"]
    assert result["_hint"]


async def test_submit_completion_candidate_sends_source_execution_and_exact_evidence(mock_client, ctx):
    artifacts = [{"name": "report", "uri": "https://example.test/report", "sha256": "c" * 64}]
    checks = [{"id": "report-check", "source_sha": "a" * 40, "exit_code": 0, "output": "Passed"}]
    mock_client.post.return_value = {"candidate": {"id": "candidate-a", "status": "submitted"}}
    result = json.loads(await _tool("submit_completion_candidate")(
        "test", "b1", CARD_ID, source_execution_id=EXECUTION_ID,
        source_sha="a" * 40, artifacts=artifacts, checks=checks, ctx=ctx,
    ))
    mock_client.post.assert_awaited_once_with(
        f"{BASE}/cards/{CARD_ID}/submit",
        {"source_execution_id": EXECUTION_ID, "source_sha": "a" * 40,
         "artifacts": artifacts, "checks": checks},
    )
    assert result["candidate"]["id"] == "candidate-a"
    assert result["_hint"]


async def test_submit_source_candidate_omits_optional_evidence_instead_of_inventing_it(mock_client, ctx):
    mock_client.post.return_value = {"candidate": {"id": "candidate-a", "status": "submitted"}}
    await _tool("submit_completion_candidate")(
        "test", "b1", CARD_ID, source_execution_id=EXECUTION_ID, ctx=ctx,
    )
    mock_client.post.assert_awaited_once_with(
        f"{BASE}/cards/{CARD_ID}/submit", {"source_execution_id": EXECUTION_ID},
    )


async def test_request_landing_uses_the_policy_authorized_candidate_endpoint(mock_client, ctx):
    mock_client.post.return_value = {"candidate": {"id": "candidate-a", "status": "queued"}}
    result = json.loads(await _tool("request_landing")("test", "b1", CARD_ID, ctx=ctx))
    mock_client.post.assert_awaited_once_with(
        f"{BASE}/cards/{CARD_ID}/land", {"method": "merge_queue"},
    )
    assert result["candidate"]["status"] == "queued"
    assert result["_hint"]


async def test_retry_completion_names_card_without_allowing_model_supplied_receipts(mock_client, ctx):
    mock_client.post.return_value = {"candidate": {"id": "candidate-a", "status": "awaiting_validation"}}
    result = json.loads(await _tool("retry_completion")("test", "b1", CARD_ID, ctx=ctx))
    mock_client.post.assert_awaited_once_with(f"{BASE}/cards/{CARD_ID}/retry", {})
    assert result["candidate"]["id"] == "candidate-a"
    assert result["_hint"]


async def test_completion_mutation_preserves_server_policy_denial(mock_client, ctx):
    request = httpx.Request("POST", f"https://example.test/api{BASE}/cards/{CARD_ID}/land")
    response = httpx.Response(409, request=request, json={
        "error_code": "completion_review_required", "detail": "Independent review has not passed",
    })
    mock_client.post.side_effect = httpx.HTTPStatusError("Conflict", request=request, response=response)
    result = json.loads(await _tool("request_landing")("test", "b1", CARD_ID, ctx=ctx))
    assert result["error"] is True
    assert "Independent review has not passed" in json.dumps(result)
    assert mock_client.post.await_count == 1


async def test_get_board_loop_sends_completion_protocol_as_http_header(monkeypatch):
    from valaris_mcp import client as client_module
    from valaris_mcp.tools.boards import get_board_loop

    seen = []

    def respond(request):
        seen.append(request)
        return httpx.Response(200, json={"enabled": False, "completion_policy": {"version": 1}})

    monkeypatch.setattr(client_module, "IAP_AUDIENCE", "")
    monkeypatch.setattr(client_module, "API_KEY", "")
    client = client_module.ValarisClient()
    await client._http.aclose()
    client._http = httpx.AsyncClient(base_url="https://example.test", transport=httpx.MockTransport(respond))
    try:
        result = json.loads(await get_board_loop("test", "b1", ctx=make_ctx(client)))
    finally:
        await client.close()
    assert result["completion_policy"] == {"version": 1}
    assert len(seen) == 1
    assert seen[0].url.path == "/api/workspaces/test/boards/b1/loop"
    assert seen[0].headers.get("X-Backplane-Completion-Version") == "1"
    assert not seen[0].url.query, "Protocol capability must not be serialized as a query parameter"


@pytest.mark.parametrize("column_type,satisfied", [("review", True), ("done", False)])
async def test_dependency_status_trusts_server_completion_satisfaction(mock_client, ctx, column_type, satisfied):
    from valaris_mcp.tools.card_dependencies import get_card_dependency_status

    mock_client.get.return_value = {
        "depends_on": [{
            "depends_on_card_id": EXECUTION_ID, "depends_on_title": "Prerequisite",
            "depends_on_status": "In review", "depends_on_column_type": column_type,
            "satisfied": satisfied,
        }],
        "blocks": [],
    }
    result = json.loads(await get_card_dependency_status("test", "b1", CARD_ID, ctx=ctx))
    assert result["satisfied"] is satisfied
    assert len(result["blocking"]) == (0 if satisfied else 1)
    if satisfied:
        assert "all prerequisites done" not in result["_hint"].lower()
    else:
        assert "reach a done column" not in result["_hint"].lower()


@pytest.mark.parametrize("view", ["fit", "preview"])
async def test_template_rehearsal_forwards_unsaved_values_and_published_version(mock_client, ctx, view):
    from valaris_mcp.tools.loop_templates import get_loop_template

    values = {"RUN_LABEL": "next-run", "SEED_NOTE_ID": EXECUTION_ID}
    rails = {"completion_query": {"label": "next-run"}, "provider": "codex", "model": "operator-model"}
    mock_client.post.return_value = {"checks": [], "findings": [], "autofill": {}}
    result = json.loads(await get_loop_template(
        "test", "template-a", view=view, board_id="b1", slot_values=values,
        loop_config=rails, draft=False, version=3, ctx=ctx,
    ))
    assert not result.get("error"), result
    mock_client.post.assert_awaited_once_with(
        f"/workspaces/test/boards/b1/loop-templates/template-a/{view}",
        {"slot_values": values, "loop_config": rails, "draft": False, "version": 3},
    )
    mock_client.get.assert_not_awaited()
    mock_client.put.assert_not_awaited()


async def test_source_submission_rejects_execution_identity_differing_from_runner_context(mock_client, ctx, monkeypatch):
    monkeypatch.setenv("BACKPLANE_SOURCE_EXECUTION_ID", EXECUTION_ID)
    result = json.loads(await _tool("submit_completion_candidate")(
        "test", "b1", CARD_ID, source_execution_id="different-execution", ctx=ctx,
    ))
    assert result["error"] is True
    assert "execution" in result["message"].lower()
    mock_client.post.assert_not_awaited()


async def test_source_submission_accepts_exact_code_supplied_execution_identity(mock_client, ctx, monkeypatch):
    monkeypatch.setenv("BACKPLANE_SOURCE_EXECUTION_ID", EXECUTION_ID)
    mock_client.post.return_value = {"candidate": {"id": "candidate-a"}}
    result = json.loads(await _tool("submit_completion_candidate")(
        "test", "b1", CARD_ID, source_execution_id=EXECUTION_ID, ctx=ctx,
    ))
    assert result["candidate"]["id"] == "candidate-a"
    assert mock_client.post.await_args.args[1] == {"source_execution_id": EXECUTION_ID}


def test_ship_prompt_reads_policy_before_attempting_done_or_claiming_dependency_release():
    from valaris_mcp.prompts import ship

    prompt = ship("test", "b1", CARD_ID)
    assert prompt.index("get_completion_policy") < prompt.index("move_card")
    assert "get_completion_status" in prompt
    assert "auto_complete=false" in prompt
    assert "get_card_dependency_status" in prompt


def test_mandatory_backend_context_names_the_registered_completion_tools():
    from pathlib import Path

    source = (Path(__file__).resolve().parents[2] / "backend/app/services/completion_context.py").read_text()
    assert "submit_completion_candidate" in source
    assert "get_completion_status" in source
    assert "Use submit_completion with" not in source
