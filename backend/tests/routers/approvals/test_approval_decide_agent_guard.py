# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Deciding an approval is a HUMAN act — agent callers are refused.

`decide_approval` is exposed as an MCP tool while the approvals flow exists
precisely so a human gates risky agent actions (skill proposals arrive at
risk 60, never auto-approved). Without a route guard, an agent whose
allowlist carries the tool could approve its OWN proposal: the API key
resolves to the creating user, who is a workspace member, so nothing
downstream would refuse. The guard closes the loophole at the route, same as
the skills mutation routes and agent self-administration.

Uses conftest's `agent_client`: `get_current_user` is overridden to bind the
`current_agent_id` ContextVar, which is exactly what `forbid_agent_callers`
reads — the raw-key auth plumbing has its own suite.
"""

from httpx import AsyncClient

from app.models.user import User
from app.models.workspace import Workspace

BASE_URL = "/api/workspaces/default/approvals"

VALID_APPROVAL = {
    "category": "deletion",
    "action_description": "Publish skill proposal 'debug-recipe' v1",
    "action_payload": {"endpoint": "/api/skills/proposals", "slug": "debug-recipe"},
}


async def _pending_approval(client: AsyncClient) -> str:
    agent_resp = await client.post(
        "/api/agents",
        json={
            "name": "guard-bot",
            "agent_type": "coding",
            "description": "test",
            "allowed_workspaces": ["default"],
        },
    )
    approval = await client.post(
        BASE_URL, json={**VALID_APPROVAL, "agent_id": agent_resp.json()["id"]}
    )
    assert approval.status_code == 201, approval.text
    assert approval.json()["status"] == "pending"
    return approval.json()["id"]


async def test_agent_caller_cannot_decide_an_approval(
    client: AsyncClient,
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_user: User,
):
    approval_id = await _pending_approval(client)

    response = await agent_client.post(
        f"{BASE_URL}/{approval_id}/decide",
        json={"decision": "approved", "reason": "self-service"},
    )

    assert response.status_code == 403, (
        f"an agent-bound caller decided an approval: "
        f"{response.status_code} {response.text}"
    )

    # The refusal must also have prevented the write.
    reread = await client.get(f"{BASE_URL}/{approval_id}")
    assert reread.json()["status"] == "pending", (
        f"approval left {reread.json()['status']!r} after a refused decide"
    )


async def test_human_caller_still_decides(
    client: AsyncClient,
    test_workspace: Workspace,
    test_user: User,
):
    approval_id = await _pending_approval(client)

    response = await client.post(
        f"{BASE_URL}/{approval_id}/decide",
        json={"decision": "approved", "reason": "Reviewed the diff"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "approved"
    assert response.json()["decided_by_id"] == str(test_user.id)
