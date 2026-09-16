# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Card write endpoints reject unknown fields instead of silently dropping them.

Pydantic's default `extra="ignore"` made a misspelled or unsupported field name
indistinguishable from a successful write: the request returned 200, the response
echoed the card unchanged, and the caller had no signal the value was discarded.
An agent that misremembers a field name loses the write and never learns.

Same rationale — and same `extra="forbid"` remedy — as LoopConfigPut.
"""

from httpx import AsyncClient

from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column


BASE = "/api/workspaces/default/boards"


def _url(board: Board, suffix: str = "") -> str:
    return f"{BASE}/{board.id}/cards{suffix}"


async def test_update_card_rejects_unknown_field(
    client: AsyncClient, test_board: Board, test_card: Card
):
    response = await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={"status": "shipped", "pr_urls": "https://example.com/pr/1"},
    )

    assert response.status_code == 422
    assert "pr_urls" in response.text


async def test_update_card_rejecting_unknown_field_persists_nothing(
    client: AsyncClient, test_board: Board, test_card: Card
):
    original_status = test_card.status

    await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={"status": "shipped", "branchName": "loop4/typo"},
    )

    read = await client.get(_url(test_board, f"/{test_card.id}"))
    assert read.status_code == 200
    assert read.json()["status"] == original_status


async def test_update_card_still_accepts_every_supported_field(
    client: AsyncClient, test_board: Board, test_card: Card
):
    response = await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={
            "title": "Renamed",
            "description": "body",
            "card_type": "bug",
            "priority": "high",
            "due_date": "2026-09-01",
            "status": "shipped abc123 (PR #1)",
            "labels": ["loop-4"],
            "pr_url": "https://github.com/acme/repo/pull/1",
            "branch_name": "loop4/example",
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["pr_url"] == "https://github.com/acme/repo/pull/1"
    assert data["branch_name"] == "loop4/example"
    assert data["labels"] == ["loop-4"]


async def test_create_card_rejects_unknown_field(
    client: AsyncClient, test_board: Board, test_column: Column
):
    response = await client.post(
        _url(test_board),
        json={
            "title": "New Card",
            "column_id": str(test_column.id),
            "prioriy": "high",
        },
    )

    assert response.status_code == 422
    assert "prioriy" in response.text


async def test_move_card_rejects_unknown_field(
    client: AsyncClient, test_board: Board, test_card: Card, test_column: Column
):
    response = await client.patch(
        _url(test_board, f"/{test_card.id}/move"),
        json={"column_id": str(test_column.id), "postion": 2048.0},
    )

    assert response.status_code == 422
    assert "postion" in response.text
