# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.workspace import Workspace


BASE_URL = "/api/workspaces/default/approvals"

VALID_APPROVAL = {
    "category": "deletion",
    "action_description": "Delete 12 cards from Backlog column",
    "action_payload": {"endpoint": "/api/cards/bulk-delete", "card_ids": ["abc", "def"]},
}


async def test_create_approval_success(
    client: AsyncClient, test_workspace: Workspace, test_user: User
):
    # First create an agent to link
    agent_resp = await client.post(
        "/api/agents",
        json={"name": "test-bot", "agent_type": "coding", "description": "test", "allowed_workspaces": ["default"]},
    )
    agent_id = agent_resp.json()["id"]

    response = await client.post(
        BASE_URL,
        json={**VALID_APPROVAL, "agent_id": agent_id},
    )
    assert response.status_code == 201
    data = response.json()
    assert data["category"] == "deletion"
    assert data["action_description"] == "Delete 12 cards from Backlog column"
    assert data["status"] == "pending"
    assert data["risk_score"] >= 60  # deletion base score
    assert "id" in data
    assert "created_at" in data
    assert "expires_at" in data


async def test_create_approval_auto_approved(
    client: AsyncClient, test_workspace: Workspace, test_user: User
):
    agent_resp = await client.post(
        "/api/agents",
        json={"name": "low-risk-bot", "agent_type": "coding", "description": "test", "allowed_workspaces": ["default"]},
    )
    agent_id = agent_resp.json()["id"]

    response = await client.post(
        BASE_URL,
        json={
            "agent_id": agent_id,
            "category": "external_action",
            "action_description": "Push to feature branch",
            "action_payload": {"branch": "feat/my-feature"},
        },
    )
    assert response.status_code == 201
    data = response.json()
    # external_action base score is 30, which is at the threshold
    assert data["risk_score"] == 30
    assert data["status"] == "auto_approved"


async def test_create_approval_with_board(
    client: AsyncClient, test_workspace: Workspace, test_user: User, test_board
):
    agent_resp = await client.post(
        "/api/agents",
        json={"name": "board-bot", "agent_type": "manager", "description": "test", "allowed_workspaces": ["default"]},
    )
    agent_id = agent_resp.json()["id"]

    response = await client.post(
        BASE_URL,
        json={
            **VALID_APPROVAL,
            "agent_id": agent_id,
            "board_id": str(test_board.id),
        },
    )
    assert response.status_code == 201
    assert response.json()["board_id"] == str(test_board.id)


async def test_create_approval_invalid_category(
    client: AsyncClient, test_workspace: Workspace, test_user: User
):
    response = await client.post(
        BASE_URL,
        json={**VALID_APPROVAL, "category": "invalid", "agent_id": str(uuid.uuid4())},
    )
    assert response.status_code == 422


async def test_list_approvals_empty(
    client: AsyncClient, test_workspace: Workspace, test_user: User
):
    response = await client.get(BASE_URL)
    assert response.status_code == 200
    assert response.json() == []


async def test_list_approvals_with_data(
    client: AsyncClient, test_workspace: Workspace, test_user: User
):
    agent_resp = await client.post(
        "/api/agents",
        json={"name": "list-bot", "agent_type": "coding", "description": "test", "allowed_workspaces": ["default"]},
    )
    agent_id = agent_resp.json()["id"]

    await client.post(BASE_URL, json={**VALID_APPROVAL, "agent_id": agent_id})
    await client.post(
        BASE_URL,
        json={
            "agent_id": agent_id,
            "category": "bulk_change",
            "action_description": "Create 20 cards",
            "action_payload": {},
        },
    )

    response = await client.get(BASE_URL)
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 2


async def test_list_approvals_filter_status(
    client: AsyncClient, test_workspace: Workspace, test_user: User
):
    agent_resp = await client.post(
        "/api/agents",
        json={"name": "filter-bot", "agent_type": "coding", "description": "test", "allowed_workspaces": ["default"]},
    )
    agent_id = agent_resp.json()["id"]

    # Create one pending (deletion = high risk) and one auto_approved (external_action = low risk)
    await client.post(BASE_URL, json={**VALID_APPROVAL, "agent_id": agent_id})
    await client.post(
        BASE_URL,
        json={
            "agent_id": agent_id,
            "category": "external_action",
            "action_description": "Push branch",
            "action_payload": {},
        },
    )

    pending = await client.get(f"{BASE_URL}?status=pending")
    assert pending.status_code == 200
    assert len(pending.json()) == 1
    assert pending.json()[0]["status"] == "pending"


async def test_get_approval_success(
    client: AsyncClient, test_workspace: Workspace, test_user: User
):
    agent_resp = await client.post(
        "/api/agents",
        json={"name": "get-bot", "agent_type": "coding", "description": "test", "allowed_workspaces": ["default"]},
    )
    agent_id = agent_resp.json()["id"]

    create_resp = await client.post(BASE_URL, json={**VALID_APPROVAL, "agent_id": agent_id})
    approval_id = create_resp.json()["id"]

    response = await client.get(f"{BASE_URL}/{approval_id}")
    assert response.status_code == 200
    assert response.json()["id"] == approval_id


async def test_get_approval_not_found(
    client: AsyncClient, test_workspace: Workspace
):
    fake_id = uuid.uuid4()
    response = await client.get(f"{BASE_URL}/{fake_id}")
    assert response.status_code == 404


async def test_decide_approve(
    client: AsyncClient, test_workspace: Workspace, test_user: User
):
    agent_resp = await client.post(
        "/api/agents",
        json={"name": "approve-bot", "agent_type": "coding", "description": "test", "allowed_workspaces": ["default"]},
    )
    agent_id = agent_resp.json()["id"]

    create_resp = await client.post(BASE_URL, json={**VALID_APPROVAL, "agent_id": agent_id})
    approval_id = create_resp.json()["id"]

    response = await client.post(
        f"{BASE_URL}/{approval_id}/decide",
        json={"decision": "approved", "reason": "Looks safe"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "approved"
    assert data["decision_reason"] == "Looks safe"
    assert data["decided_by_id"] == str(test_user.id)
    assert data["decided_at"] is not None


async def test_decide_resolves_decided_by_name(
    client: AsyncClient, test_workspace: Workspace, test_user: User
):
    agent_resp = await client.post(
        "/api/agents",
        json={"name": "name-bot", "agent_type": "coding", "description": "test", "allowed_workspaces": ["default"]},
    )
    agent_id = agent_resp.json()["id"]

    create_resp = await client.post(BASE_URL, json={**VALID_APPROVAL, "agent_id": agent_id})
    approval_id = create_resp.json()["id"]

    response = await client.post(
        f"{BASE_URL}/{approval_id}/decide",
        json={"decision": "approved", "reason": "Looks safe"},
    )
    assert response.status_code == 200
    # Decider is surfaced by display name, not a raw UUID — the read-only
    # decided view in the UI shows who decided.
    assert response.json()["decided_by_name"] == "Dev User"


async def test_list_approvals_includes_decided_by_name(
    client: AsyncClient, test_workspace: Workspace, test_user: User
):
    agent_resp = await client.post(
        "/api/agents",
        json={"name": "listname-bot", "agent_type": "coding", "description": "test", "allowed_workspaces": ["default"]},
    )
    agent_id = agent_resp.json()["id"]

    create_resp = await client.post(BASE_URL, json={**VALID_APPROVAL, "agent_id": agent_id})
    approval_id = create_resp.json()["id"]
    await client.post(
        f"{BASE_URL}/{approval_id}/decide",
        json={"decision": "rejected", "reason": "Too risky"},
    )

    response = await client.get(BASE_URL)
    assert response.status_code == 200
    decided = next(a for a in response.json() if a["id"] == approval_id)
    assert decided["decided_by_name"] == "Dev User"


async def test_list_approvals_pending_has_null_decided_by_name(
    client: AsyncClient, test_workspace: Workspace, test_user: User
):
    agent_resp = await client.post(
        "/api/agents",
        json={"name": "pendingname-bot", "agent_type": "coding", "description": "test", "allowed_workspaces": ["default"]},
    )
    agent_id = agent_resp.json()["id"]

    await client.post(BASE_URL, json={**VALID_APPROVAL, "agent_id": agent_id})

    response = await client.get(BASE_URL)
    assert response.status_code == 200
    assert response.json()[0]["decided_by_name"] is None


async def test_decide_reject(
    client: AsyncClient, test_workspace: Workspace, test_user: User
):
    agent_resp = await client.post(
        "/api/agents",
        json={"name": "reject-bot", "agent_type": "coding", "description": "test", "allowed_workspaces": ["default"]},
    )
    agent_id = agent_resp.json()["id"]

    create_resp = await client.post(BASE_URL, json={**VALID_APPROVAL, "agent_id": agent_id})
    approval_id = create_resp.json()["id"]

    response = await client.post(
        f"{BASE_URL}/{approval_id}/decide",
        json={"decision": "rejected", "reason": "Too risky"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "rejected"


async def test_decide_already_decided(
    client: AsyncClient, test_workspace: Workspace, test_user: User
):
    agent_resp = await client.post(
        "/api/agents",
        json={"name": "double-bot", "agent_type": "coding", "description": "test", "allowed_workspaces": ["default"]},
    )
    agent_id = agent_resp.json()["id"]

    create_resp = await client.post(BASE_URL, json={**VALID_APPROVAL, "agent_id": agent_id})
    approval_id = create_resp.json()["id"]

    await client.post(
        f"{BASE_URL}/{approval_id}/decide",
        json={"decision": "approved", "reason": "OK"},
    )

    response = await client.post(
        f"{BASE_URL}/{approval_id}/decide",
        json={"decision": "rejected", "reason": "Changed mind"},
    )
    assert response.status_code == 409


async def test_risk_score_deletion_multiple_items(
    client: AsyncClient, test_workspace: Workspace, test_user: User
):
    agent_resp = await client.post(
        "/api/agents",
        json={"name": "risk-bot", "agent_type": "coding", "description": "test", "allowed_workspaces": ["default"]},
    )
    agent_id = agent_resp.json()["id"]

    response = await client.post(
        BASE_URL,
        json={
            "agent_id": agent_id,
            "category": "deletion",
            "action_description": "Delete multiple items",
            "action_payload": {"item_count": 5},
        },
    )
    assert response.status_code == 201
    # deletion(60) + multiple items modifier(+20) = 80
    assert response.json()["risk_score"] == 80


async def test_risk_score_schema_change(
    client: AsyncClient, test_workspace: Workspace, test_user: User
):
    agent_resp = await client.post(
        "/api/agents",
        json={"name": "schema-bot", "agent_type": "coding", "description": "test", "allowed_workspaces": ["default"]},
    )
    agent_id = agent_resp.json()["id"]

    response = await client.post(
        BASE_URL,
        json={
            "agent_id": agent_id,
            "category": "schema_change",
            "action_description": "Add nullable column",
            "action_payload": {},
        },
    )
    assert response.status_code == 201
    assert response.json()["risk_score"] == 80  # schema_change base
