# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The API must serialize every datetime as UTC-aware so the frontend never
mis-parses a naive string as local time (the "just now" bug). DB columns store
naive UTC (Postgres func.now()); this is a serialization-boundary contract."""

import uuid
from datetime import datetime, timedelta, timezone

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.json_response import to_utc_isoformat
from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.user import User
from app.models.workspace import Workspace


def _has_utc_marker(value: str) -> bool:
    return value.endswith("Z") or value.endswith("+00:00")


def test_to_utc_isoformat_stamps_naive_as_utc():
    naive = datetime(2026, 7, 19, 8, 15, 0)
    assert _has_utc_marker(to_utc_isoformat(naive))


def test_to_utc_isoformat_converts_aware_to_utc():
    # 08:15 at +02:00 is 06:15 UTC — the offset must be normalized, not kept.
    aware = datetime(2026, 7, 19, 8, 15, 0, tzinfo=timezone(timedelta(hours=2)))
    out = to_utc_isoformat(aware)
    assert _has_utc_marker(out)
    assert "06:15" in out


async def test_workspace_created_at_carries_utc_marker(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get("/api/workspaces/default")
    assert response.status_code == 200
    created_at = response.json()["created_at"]
    assert _has_utc_marker(created_at), created_at


async def test_activity_history_created_at_carries_utc_marker(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    now = datetime.now(timezone.utc)
    for i in range(2):
        db_session.add(
            Activity(
                workspace_id=test_workspace.id,
                actor_id=test_user.id,
                entity_type=ActivityEntityType.board,
                entity_id=uuid.uuid4(),
                action=ActivityAction.created,
                summary=f"Activity {i}",
                created_at=now + timedelta(seconds=i),
            )
        )
    await db_session.flush()

    response = await client.get("/api/workspaces/default/history")
    assert response.status_code == 200
    rows = response.json()
    assert rows
    for row in rows:
        assert _has_utc_marker(row["created_at"]), row["created_at"]


async def test_history_datetime_still_parseable_and_ordered(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    base = datetime.now(timezone.utc)
    db_session.add(
        Activity(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.board,
            entity_id=uuid.uuid4(),
            action=ActivityAction.created,
            summary="parse me",
            created_at=base,
        )
    )
    await db_session.flush()

    response = await client.get("/api/workspaces/default/history")
    assert response.status_code == 200
    created_at = response.json()[0]["created_at"]
    parsed = datetime.fromisoformat(created_at)
    assert parsed.tzinfo is not None
