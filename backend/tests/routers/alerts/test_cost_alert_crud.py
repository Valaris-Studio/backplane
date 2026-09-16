# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.workspace import Workspace


async def test_create_alert_with_cost_usd_7d_metric(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
):
    response = await client.post(
        "/api/workspaces/default/alerts/thresholds",
        json={
            "name": "Weekly cost limit",
            "metric": "cost_usd_7d",
            "operator": "gt",
            "value": 25.0,
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "Weekly cost limit"
    assert data["metric"] == "cost_usd_7d"
    assert data["operator"] == "gt"
    assert data["value"] == 25.0
    assert data["board_id"] is None


async def test_create_alert_with_cost_usd_30d_metric(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
):
    response = await client.post(
        "/api/workspaces/default/alerts/thresholds",
        json={
            "name": "Monthly cost limit",
            "metric": "cost_usd_30d",
            "operator": "gte",
            "value": 100.0,
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["metric"] == "cost_usd_30d"
    assert data["value"] == 100.0


async def test_list_alerts_includes_cost_metrics(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
):
    await client.post(
        "/api/workspaces/default/alerts/thresholds",
        json={
            "name": "Health alert",
            "metric": "health_score",
            "operator": "lt",
            "value": 50.0,
        },
    )
    await client.post(
        "/api/workspaces/default/alerts/thresholds",
        json={
            "name": "Cost alert",
            "metric": "cost_usd_7d",
            "operator": "gt",
            "value": 10.0,
        },
    )

    response = await client.get("/api/workspaces/default/alerts/thresholds")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 2
    metrics = {a["metric"] for a in data}
    assert "health_score" in metrics
    assert "cost_usd_7d" in metrics
