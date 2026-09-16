# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The history API exposes structured messages without dropping legacy copy."""

import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.user import User
from app.models.workspace import Workspace


async def test_history_serializes_structured_and_legacy_activity_rows(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    db_session.add_all(
        [
            Activity(
                workspace_id=test_workspace.id,
                actor_id=test_user.id,
                entity_type=ActivityEntityType.workspace,
                entity_id=test_workspace.id,
                action=ActivityAction.created,
                summary="created workspace 'Intern'",
                message_key="activity.workspace.created",
                message_params={"workspace_name": "Intern"},
            ),
            Activity(
                workspace_id=test_workspace.id,
                actor_id=test_user.id,
                entity_type=ActivityEntityType.card,
                entity_id=uuid.uuid4(),
                action=ActivityAction.created,
                summary="legacy card event",
            ),
        ]
    )
    await db_session.flush()

    response = await client.get("/api/workspaces/default/history")

    assert response.status_code == 200
    by_summary = {row["summary"]: row for row in response.json()}
    structured = by_summary["created workspace 'Intern'"]
    assert structured["message_key"] == "activity.workspace.created"
    assert structured["message_params"] == {"workspace_name": "Intern"}
    legacy = by_summary["legacy card event"]
    assert legacy["message_key"] is None
    assert legacy["message_params"] is None
