# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Structured activity messages are additive to the immutable legacy summary."""

import uuid
from unittest.mock import AsyncMock, patch

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import ActivityAction, ActivityEntityType
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.activity import ActivityRead
from app.services.activity import ActivityService


async def test_record_persists_and_publishes_structured_message_without_changing_summary(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
):
    service = ActivityService(db_session)
    service._generate_notifications = AsyncMock()
    entity_id = uuid.uuid4()
    summary = "moved card 'Launch' from 'Backlog' to 'Review'"
    message_params = {
        "card_title": "Launch",
        "from_column_name": "Backlog",
        "to_column_name": "Review",
    }

    with patch("app.services.activity.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()
        await service.record(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.card,
            entity_id=entity_id,
            action=ActivityAction.moved,
            board_id=test_board.id,
            summary=summary,
            changes={"column_id": {"old": "old-id", "new": "new-id"}},
            message_key="activity.card.moved",
            message_params=message_params,
        )

    rows = await service.list_workspace_activity(test_workspace.id)
    assert len(rows) == 1
    stored = rows[0]
    assert stored.summary == summary
    assert stored.message_key == "activity.card.moved"
    assert stored.message_params == message_params

    serialized = ActivityRead.model_validate(stored)
    assert serialized.summary == summary
    assert serialized.message_key == "activity.card.moved"
    assert serialized.message_params == message_params

    for publish_call in mock_bus.publish.await_args_list:
        payload = publish_call.kwargs["payload"]
        assert payload["summary"] == summary
        assert payload["message_key"] == "activity.card.moved"
        assert payload["message_params"] == message_params


async def test_record_without_structured_message_keeps_legacy_fallback_contract(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    service = ActivityService(db_session)
    service._generate_notifications = AsyncMock()
    legacy_summary = "legacy activity summary"

    with patch("app.services.activity.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()
        await service.record(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.workspace,
            entity_id=test_workspace.id,
            action=ActivityAction.updated,
            summary=legacy_summary,
        )

    rows = await service.list_workspace_activity(test_workspace.id)
    assert len(rows) == 1
    stored = rows[0]
    assert stored.summary == legacy_summary
    assert stored.message_key is None
    assert stored.message_params is None

    payload = mock_bus.publish.await_args.kwargs["payload"]
    assert payload["summary"] == legacy_summary
    assert payload["message_key"] is None
    assert payload["message_params"] is None
