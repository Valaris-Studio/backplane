# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from httpx import AsyncClient

from app.models.definitions.definition import Definition
from app.models.kanban.board import Board
from app.models.workspace import Workspace


BASE_URL = "/api/workspaces/default/boards"


async def test_get_definition_success(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_definition: Definition,
):
    response = await client.get(f"{BASE_URL}/{test_board.id}/definitions")

    assert response.status_code == 200
    data = response.json()
    assert data["id"] == str(test_definition.id)
    assert data["board_id"] == str(test_board.id)
    assert data["workspace_id"] == str(test_workspace.id)
    assert data["scope"] == "Build the MVP"
    assert data["content"] == {"tech_stack": ["Python"]}
    assert "created_at" in data
    assert "updated_at" in data


async def test_get_definition_not_found(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.get(f"{BASE_URL}/{test_board.id}/definitions")

    assert response.status_code == 404


async def test_upsert_definition_create(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    payload = {
        "scope": "Build the MVP",
        "content": {"tech_stack": ["Python"]},
    }

    response = await client.put(
        f"{BASE_URL}/{test_board.id}/definitions", json=payload
    )

    assert response.status_code == 200
    data = response.json()
    assert data["scope"] == "Build the MVP"
    assert data["content"] == {"tech_stack": ["Python"]}
    assert data["board_id"] == str(test_board.id)
    assert data["workspace_id"] == str(test_workspace.id)
    assert "id" in data
    assert "created_at" in data


async def test_upsert_definition_update(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_definition: Definition,
):
    payload = {
        "scope": "Updated scope",
        "content": {"tech_stack": ["Rust"]},
    }

    response = await client.put(
        f"{BASE_URL}/{test_board.id}/definitions", json=payload
    )

    assert response.status_code == 200
    data = response.json()
    assert data["id"] == str(test_definition.id)
    assert data["scope"] == "Updated scope"
    assert data["content"] == {"tech_stack": ["Rust"]}


async def test_upsert_definition_nonexistent_workspace(
    client: AsyncClient, test_board: Board
):
    payload = {"scope": "Should fail"}

    response = await client.put(
        f"/api/workspaces/nonexistent/boards/{test_board.id}/definitions",
        json=payload,
    )

    assert response.status_code == 404


async def test_upsert_definition_with_structured_content(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    structured_content = {
        "objectives": ["Launch beta by Q2", "Onboard 10 users"],
        "milestones": [
            {"title": "Alpha release", "date": "2026-04-01", "type": "milestone"},
            {"title": "Beta release", "date": "2026-06-01", "type": "deadline"},
        ],
        "tech_stack": ["Python", "FastAPI", "React"],
        "stakeholders": [
            {"name": "Alice", "role": "Product Owner"},
            {"name": "Bob", "role": "Tech Lead"},
        ],
        "risks": ["Tight timeline", "Third-party API dependency"],
    }
    payload = {
        "scope": "Full platform launch",
        "content": structured_content,
    }

    response = await client.put(
        f"{BASE_URL}/{test_board.id}/definitions", json=payload
    )

    assert response.status_code == 200
    data = response.json()
    assert data["scope"] == "Full platform launch"
    assert len(data["content"]["objectives"]) == 2
    # bare-string objectives are coerced to the typed shape (frontend parity)
    assert data["content"]["objectives"][0] == {
        "text": "Launch beta by Q2",
        "priority": None,
    }
    assert len(data["content"]["milestones"]) == 2
    assert data["content"]["milestones"][0]["title"] == "Alpha release"
    assert data["content"]["tech_stack"] == ["Python", "FastAPI", "React"]
    assert data["content"]["stakeholders"][0]["name"] == "Alice"
    # unknown keys (e.g. legacy "risks") survive validation untouched
    assert data["content"]["risks"] == ["Tight timeline", "Third-party API dependency"]


async def test_upsert_definition_preserves_unknown_keys_round_trip(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    payload = {
        "scope": "Legacy prod definition",
        "content": {
            "tech_stack": ["Go"],
            "coding_standards": "gofmt + golangci-lint",
            "weird_custom_key": {"nested": [1, 2, 3]},
            "_overflow": {"legacy": True},
        },
    }

    put_response = await client.put(
        f"{BASE_URL}/{test_board.id}/definitions", json=payload
    )
    assert put_response.status_code == 200, put_response.text

    get_response = await client.get(f"{BASE_URL}/{test_board.id}/definitions")
    assert get_response.status_code == 200
    content = get_response.json()["content"]

    assert content["tech_stack"] == ["Go"]
    assert content["coding_standards"] == "gofmt + golangci-lint"
    assert content["weird_custom_key"] == {"nested": [1, 2, 3]}
    assert content["_overflow"] == {"legacy": True}


async def test_upsert_definition_typed_content_round_trips(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    payload = {
        "scope": "Typed",
        "content": {
            "objectives": [{"text": "Launch beta", "priority": "high"}],
            "milestones": [
                {"title": "Alpha", "date": "2026-04-01", "type": "deadline"}
            ],
            "constraints": ["Tight timeline"],
        },
    }

    response = await client.put(
        f"{BASE_URL}/{test_board.id}/definitions", json=payload
    )
    assert response.status_code == 200, response.text
    content = response.json()["content"]

    assert content["objectives"] == [{"text": "Launch beta", "priority": "high"}]
    assert content["milestones"][0]["title"] == "Alpha"
    assert content["constraints"] == ["Tight timeline"]


async def test_upsert_definition_rejects_grossly_wrong_type(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    payload = {"content": {"objectives": "this should be a list, not a string"}}

    response = await client.put(
        f"{BASE_URL}/{test_board.id}/definitions", json=payload
    )

    assert response.status_code == 422
    assert "objectives" in response.text


async def test_upsert_definition_partial_merge_keeps_untouched_keys(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await client.put(
        f"{BASE_URL}/{test_board.id}/definitions",
        json={
            "content": {
                "tech_stack": ["Python"],
                "coding_standards": "ruff",
                "constraints": ["No downtime"],
            }
        },
    )

    response = await client.put(
        f"{BASE_URL}/{test_board.id}/definitions",
        json={"content": {"tech_stack": ["Rust"]}},
    )
    assert response.status_code == 200
    content = response.json()["content"]

    assert content["tech_stack"] == ["Rust"]
    assert content["coding_standards"] == "ruff"
    assert content["constraints"] == ["No downtime"]


async def test_export_definition_success(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_definition: Definition,
):
    response = await client.get(
        f"{BASE_URL}/{test_board.id}/definitions/export"
    )
    assert response.status_code == 200, response.text

    body = response.json()
    assert body["entity_type"] == "definition"
    assert body["source_workspace_slug"] == test_workspace.slug
    assert body["source_board_slug"] == test_board.slug
    assert body["data"]["scope"] == "Build the MVP"
    assert body["data"]["content"] == {"tech_stack": ["Python"]}

    assert (
        f'filename="{test_board.slug}.valaris.definition.json"'
        in response.headers["content-disposition"]
    )


async def test_export_definition_via_board_slug(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_definition: Definition,
):
    response = await client.get(
        f"{BASE_URL}/{test_board.slug}/definitions/export"
    )
    assert response.status_code == 200
    assert response.json()["source_board_slug"] == test_board.slug


async def test_export_definition_when_missing_returns_404(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.get(
        f"{BASE_URL}/{test_board.id}/definitions/export"
    )
    assert response.status_code == 404


async def test_export_definition_unknown_workspace(client: AsyncClient):
    response = await client.get(
        f"/api/workspaces/nonexistent/boards/{uuid.uuid4()}/definitions/export"
    )
    assert response.status_code == 404
