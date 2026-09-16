# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace


async def test_create_alert_threshold(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
):
    response = await client.post(
        "/api/workspaces/default/alerts/thresholds",
        json={
            "name": "Low health score",
            "metric": "health_score",
            "operator": "lt",
            "value": 50.0,
            "board_id": str(test_board.id),
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "Low health score"
    assert data["metric"] == "health_score"
    assert data["operator"] == "lt"
    assert data["value"] == 50.0
    assert data["board_id"] == str(test_board.id)
    assert data["is_active"] is True


async def test_create_alert_threshold_workspace_level(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
):
    response = await client.post(
        "/api/workspaces/default/alerts/thresholds",
        json={
            "name": "High stale count",
            "metric": "stale_card_count",
            "operator": "gt",
            "value": 10.0,
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["board_id"] is None


async def test_list_alert_thresholds(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
):
    for i in range(3):
        await client.post(
            "/api/workspaces/default/alerts/thresholds",
            json={
                "name": f"Alert {i}",
                "metric": "health_score",
                "operator": "lt",
                "value": 50.0 + i,
            },
        )

    response = await client.get("/api/workspaces/default/alerts/thresholds")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 3


async def test_list_alert_thresholds_filter_by_board(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
):
    # Board-scoped
    await client.post(
        "/api/workspaces/default/alerts/thresholds",
        json={
            "name": "Board alert",
            "metric": "health_score",
            "operator": "lt",
            "value": 40.0,
            "board_id": str(test_board.id),
        },
    )
    # Workspace-level
    await client.post(
        "/api/workspaces/default/alerts/thresholds",
        json={
            "name": "Workspace alert",
            "metric": "stale_card_count",
            "operator": "gt",
            "value": 5.0,
        },
    )

    response = await client.get(
        f"/api/workspaces/default/alerts/thresholds?board_id={test_board.id}"
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["name"] == "Board alert"


async def test_get_alert_threshold(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
):
    create_resp = await client.post(
        "/api/workspaces/default/alerts/thresholds",
        json={
            "name": "Test threshold",
            "metric": "overdue_card_count",
            "operator": "gte",
            "value": 3.0,
        },
    )
    threshold_id = create_resp.json()["id"]

    response = await client.get(
        f"/api/workspaces/default/alerts/thresholds/{threshold_id}"
    )
    assert response.status_code == 200
    assert response.json()["name"] == "Test threshold"


async def test_get_alert_threshold_not_found(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
):
    fake_id = uuid.uuid4()
    response = await client.get(
        f"/api/workspaces/default/alerts/thresholds/{fake_id}"
    )
    assert response.status_code == 404


async def test_update_alert_threshold(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
):
    create_resp = await client.post(
        "/api/workspaces/default/alerts/thresholds",
        json={
            "name": "Original",
            "metric": "health_score",
            "operator": "lt",
            "value": 50.0,
        },
    )
    threshold_id = create_resp.json()["id"]

    response = await client.patch(
        f"/api/workspaces/default/alerts/thresholds/{threshold_id}",
        json={"name": "Updated", "value": 30.0, "is_active": False},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "Updated"
    assert data["value"] == 30.0
    assert data["is_active"] is False


async def test_delete_alert_threshold(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
):
    create_resp = await client.post(
        "/api/workspaces/default/alerts/thresholds",
        json={
            "name": "To delete",
            "metric": "health_score",
            "operator": "lt",
            "value": 50.0,
        },
    )
    threshold_id = create_resp.json()["id"]

    response = await client.delete(
        f"/api/workspaces/default/alerts/thresholds/{threshold_id}"
    )
    assert response.status_code == 204

    # Verify deleted
    response = await client.get(
        f"/api/workspaces/default/alerts/thresholds/{threshold_id}"
    )
    assert response.status_code == 404
