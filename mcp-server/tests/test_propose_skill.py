# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

import httpx
import pytest

PROPOSAL_RESPONSE = {
    "approval_id": "ap-77",
    "status": "pending",
    "skill_slug": "pdf-tools",
}


@pytest.mark.anyio
async def test_propose_skill_success(mock_client, ctx):
    from valaris_mcp.tools.skills import propose_skill

    mock_client.post.return_value = PROPOSAL_RESPONSE
    result = json.loads(
        await propose_skill(
            workspace_slug="test",
            slug="pdf-tools",
            files=[{"path": "SKILL.md", "content": "# PDF Tools"}],
            ctx=ctx,
        )
    )
    mock_client.post.assert_called_once()
    path, body = mock_client.post.call_args[0][0], mock_client.post.call_args[0][1]
    assert path == "/workspaces/test/skills/proposals"
    assert body["slug"] == "pdf-tools"
    assert body["files"] == [{"path": "SKILL.md", "content": "# PDF Tools"}]
    assert result["approval_id"] == "ap-77"
    assert "_hint" in result


@pytest.mark.anyio
async def test_propose_skill_optional_fields_omitted_stay_out_of_body(mock_client, ctx):
    """Frontmatter is authoritative on the backend — name/description/board_id
    must not appear in the POST body unless explicitly provided."""
    from valaris_mcp.tools.skills import propose_skill

    mock_client.post.return_value = PROPOSAL_RESPONSE
    await propose_skill(
        workspace_slug="test",
        slug="pdf-tools",
        files=[{"path": "SKILL.md", "content": "# PDF Tools"}],
        ctx=ctx,
    )
    body = mock_client.post.call_args[0][1]
    assert "board_id" not in body
    assert "name" not in body
    assert "description" not in body


@pytest.mark.anyio
async def test_propose_skill_optional_fields_passed_through(mock_client, ctx):
    from valaris_mcp.tools.skills import propose_skill

    mock_client.post.return_value = PROPOSAL_RESPONSE
    await propose_skill(
        workspace_slug="test",
        slug="pdf-tools",
        name="PDF Tools",
        description="Extract and merge PDFs",
        files=[{"path": "SKILL.md", "content": "# PDF Tools"}],
        board_id="b1",
        ctx=ctx,
    )
    body = mock_client.post.call_args[0][1]
    assert body["board_id"] == "b1"
    assert body["name"] == "PDF Tools"
    assert body["description"] == "Extract and merge PDFs"


@pytest.mark.anyio
async def test_propose_skill_hint_pending_approval_no_waiting(
    mock_client, ctx
):
    from valaris_mcp.tools.skills import propose_skill

    mock_client.post.return_value = PROPOSAL_RESPONSE
    result = json.loads(
        await propose_skill(
            workspace_slug="test",
            slug="pdf-tools",
            files=[{"path": "SKILL.md", "content": "# PDF Tools"}],
            ctx=ctx,
        )
    )
    assert "pending human approval" in result["_hint"]
    # The hint must NOT tell the agent to wait or poll — loop templates
    # forbid blocking on human decisions, and get_approval_status is not
    # granted to the templates that carry propose_skill.
    assert "Do NOT wait" in result["_hint"]
    assert "get_approval_status" not in result["_hint"]


@pytest.mark.anyio
async def test_propose_skill_idempotent_retry_returns_existing_proposal(
    mock_client, ctx
):
    """Backend answers a duplicate propose with 200 + the same approval_id —
    the tool passes it through unchanged with the same hint, no error."""
    from valaris_mcp.tools.skills import propose_skill

    mock_client.post.return_value = PROPOSAL_RESPONSE
    result = json.loads(
        await propose_skill(
            workspace_slug="test",
            slug="pdf-tools",
            files=[{"path": "SKILL.md", "content": "# PDF Tools"}],
            ctx=ctx,
        )
    )
    assert result["approval_id"] == "ap-77"
    assert "error" not in result
    assert "pending human approval" in result["_hint"]
    # The hint must NOT tell the agent to wait or poll — loop templates
    # forbid blocking on human decisions, and get_approval_status is not
    # granted to the templates that carry propose_skill.
    assert "Do NOT wait" in result["_hint"]
    assert "get_approval_status" not in result["_hint"]


@pytest.mark.anyio
async def test_propose_skill_large_file_content_untruncated_in_body(mock_client, ctx):
    """WRITE path never truncates: a >6000-char file body must arrive in the
    POST payload verbatim."""
    from valaris_mcp.tools.skills import propose_skill

    large_content = "# PDF Tools\n" + ("x" * 7000)
    assert len(large_content) > 6000
    mock_client.post.return_value = PROPOSAL_RESPONSE
    await propose_skill(
        workspace_slug="test",
        slug="pdf-tools",
        files=[{"path": "SKILL.md", "content": large_content}],
        ctx=ctx,
    )
    body = mock_client.post.call_args[0][1]
    assert body["files"][0]["content"] == large_content


@pytest.mark.anyio
async def test_propose_skill_api_error_surfaced_as_json(mock_client, ctx):
    from valaris_mcp.tools.skills import propose_skill

    resp = httpx.Response(
        403,
        json={"detail": "Skill proposals are disabled for this board"},
        request=httpx.Request("POST", "http://test"),
    )
    mock_client.post.side_effect = httpx.HTTPStatusError(
        "Forbidden", request=resp.request, response=resp
    )
    result = json.loads(
        await propose_skill(
            workspace_slug="test",
            slug="pdf-tools",
            files=[{"path": "SKILL.md", "content": "# PDF Tools"}],
            ctx=ctx,
        )
    )
    assert result["error"] is True
    assert result["status"] == 403
    assert result["message"] == "Skill proposals are disabled for this board"
