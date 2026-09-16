# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

import pytest
from sqlalchemy import func, select

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.column import Column
from app.models.kanban.card import Card
from app.schemas.kanban.card import CardCreate
from app.models.workspace import Workspace


BASE = "/api/workspaces/default/boards"


def _url(board: Board) -> str:
    return f"{BASE}/{board.id}/cards/bulk"


async def test_bulk_create_cards_success(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
):
    response = await client.post(
        _url(test_board),
        json={
            "cards": [
                {"title": "Card 1", "column_id": str(test_column.id)},
                {"title": "Card 2", "column_id": str(test_column.id)},
                {"title": "Card 3", "column_id": str(test_column.id)},
            ]
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["created"] == 3
    assert len(data["cards"]) == 3
    titles = [c["title"] for c in data["cards"]]
    assert titles == ["Card 1", "Card 2", "Card 3"]
    for card in data["cards"]:
        assert card["board_id"] == str(test_board.id)
        assert card["column_id"] == str(test_column.id)
        assert card["card_type"] == "task"
        assert card["priority"] == "none"

    # Positions should be sequential (each +1024 from previous max)
    positions = [c["position"] for c in data["cards"]]
    assert positions[0] < positions[1] < positions[2]


async def test_bulk_create_cards_different_columns(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    db_session: AsyncSession,
):
    second_column = Column(board_id=test_board.id, name="In Progress", position=2048.0)
    db_session.add(second_column)
    await db_session.flush()

    response = await client.post(
        _url(test_board),
        json={
            "cards": [
                {"title": "Todo Card", "column_id": str(test_column.id)},
                {"title": "WIP Card", "column_id": str(second_column.id)},
            ]
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["created"] == 2
    assert data["cards"][0]["column_id"] == str(test_column.id)
    assert data["cards"][1]["column_id"] == str(second_column.id)


async def test_bulk_create_cards_invalid_column(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
):
    fake_column_id = uuid.uuid4()
    response = await client.post(
        _url(test_board),
        json={
            "cards": [
                {"title": "Valid Card", "column_id": str(test_column.id)},
                {"title": "Bad Card", "column_id": str(fake_column_id)},
            ]
        },
    )
    assert response.status_code == 422


async def test_bulk_create_cards_empty_list(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    response = await client.post(
        _url(test_board),
        json={"cards": []},
    )
    assert response.status_code == 422


async def test_bulk_create_cards_over_limit(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
):
    cards = [
        {"title": f"Card {i}", "column_id": str(test_column.id)} for i in range(51)
    ]
    response = await client.post(
        _url(test_board),
        json={"cards": cards},
    )
    assert response.status_code == 422


async def test_bulk_create_cards_with_options(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
):
    response = await client.post(
        _url(test_board),
        json={
            "cards": [
                {
                    "title": "Feature Card",
                    "column_id": str(test_column.id),
                    "card_type": "feature",
                    "priority": "high",
                    "labels": ["frontend", "v2"],
                },
                {
                    "title": "Bug Card",
                    "column_id": str(test_column.id),
                    "card_type": "bug",
                    "priority": "urgent",
                    "status": "blocked",
                    "due_date": "2026-12-31",
                },
                {
                    "title": "Simple Task",
                    "column_id": str(test_column.id),
                },
            ]
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["created"] == 3

    feature = data["cards"][0]
    assert feature["card_type"] == "feature"
    assert feature["priority"] == "high"
    assert feature["labels"] == ["frontend", "v2"]

    bug = data["cards"][1]
    assert bug["card_type"] == "bug"
    assert bug["priority"] == "urgent"
    assert bug["status"] == "blocked"
    assert bug["due_date"] == "2026-12-31"

    simple = data["cards"][2]
    assert simple["card_type"] == "task"
    assert simple["priority"] == "none"


async def test_bulk_create_preserves_every_create_field_like_single(
    client, test_workspace, test_board, test_column, test_git_repo, db_session
):
    payload = {
        "title": "Full metadata",
        "description": "# Context\n\nKeep **this** description.",
        "card_type": "feature",
        "priority": "high",
        "column_id": str(test_column.id),
        "due_date": "2026-12-31",
        "status": "ready",
        "labels": ["metadata", "secondary-repo"],
        "git_repo_slug": test_git_repo.slug,
        "completion_mode": "source",
    }
    assert set(payload) == set(CardCreate.model_fields)
    normalized = CardCreate(**payload).model_dump(mode="json")
    single = await client.post(f"{BASE}/{test_board.id}/cards", json=payload)
    assert single.status_code == 201
    response = await client.post(_url(test_board), json={"cards": [payload] * 7})
    assert response.status_code == 201
    assert response.json()["created"] == 7
    for card in response.json()["cards"]:
        for field, value in normalized.items():
            assert card[field] == single.json()[field] == value, field
        stored = await db_session.get(Card, uuid.UUID(card["id"]))
        assert stored.git_repo_slug == test_git_repo.slug


async def test_bulk_create_null_repo_keeps_default(
    client, test_workspace, test_board, test_column
):
    response = await client.post(
        _url(test_board),
        json={
            "cards": [
                {
                    "title": "Default repo",
                    "column_id": str(test_column.id),
                    "git_repo_slug": None,
                }
            ]
        },
    )
    assert response.status_code == 201
    assert response.json()["cards"][0]["git_repo_slug"] is None


async def test_bulk_create_rejects_invalid_repo_before_any_insert(
    client, test_workspace, test_board, test_column, test_git_repo, db_session
):
    for slug in ["missing-repo", "", "   ", f" {test_git_repo.slug} "]:
        response = await client.post(
            _url(test_board),
            json={
                "cards": [
                    {
                        "title": "Batch must stay atomic",
                        "column_id": str(test_column.id),
                        "git_repo_slug": test_git_repo.slug,
                    },
                    {
                        "title": "Invalid target",
                        "column_id": str(test_column.id),
                        "git_repo_slug": slug,
                    },
                ]
            },
        )
        assert response.status_code == 422, (slug, response.text)
        assert await db_session.scalar(select(func.count()).select_from(Card)) == 0


@pytest.mark.parametrize("other_workspace", [False, True])
async def test_bulk_create_rejects_repo_from_other_board(
    client,
    test_workspace,
    test_board,
    test_column,
    test_git_repo,
    test_user,
    db_session,
    other_workspace,
):
    workspace_id = test_workspace.id
    if other_workspace:
        workspace = Workspace(
            name="Other workspace", slug="other-workspace", created_by=test_user.id
        )
        db_session.add(workspace)
        await db_session.flush()
        workspace_id = workspace.id
    other_board = Board(
        workspace_id=workspace_id,
        name="Other board",
        slug="other-board",
        created_by=test_user.id,
    )
    db_session.add(other_board)
    await db_session.flush()
    test_git_repo.board_id = other_board.id
    test_git_repo.workspace_id = workspace_id
    await db_session.flush()
    response = await client.post(
        _url(test_board),
        json={
            "cards": [
                {
                    "title": "Wrong board target",
                    "column_id": str(test_column.id),
                    "git_repo_slug": test_git_repo.slug,
                }
            ]
        },
    )
    assert response.status_code == 422
    assert await db_session.scalar(select(func.count()).select_from(Card)) == 0
