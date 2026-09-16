# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Legacy ActivityService event-emission tests — pre-dates the activity.{entity}.{action}
fan-out of M-Observability Track A. Retained and updated so the bridge-event
contract (card.* + column.created twins) stays enforced while the broader
fan-out behavior is covered by test_activity_event_fanout.py.
"""
import uuid
from unittest.mock import AsyncMock, patch

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import ActivityAction, ActivityEntityType
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace
from app.services.activity import ActivityService


def _published_events(mock_bus) -> set[str]:
    return {call.kwargs["event_type"] for call in mock_bus.publish.await_args_list}


async def test_record_emits_card_created_event(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_board: Board
):
    """card.created remains a bridge event; activity.card.created is the primary twin."""
    with patch("app.services.activity.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        service = ActivityService(db_session)
        entity_id = uuid.uuid4()
        await service.record(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.card,
            entity_id=entity_id,
            action=ActivityAction.created,
            board_id=test_board.id,
            summary="Card created",
        )

        assert {"activity.card.created", "card.created"} <= _published_events(mock_bus)
        bridge_call = next(
            c for c in mock_bus.publish.await_args_list
            if c.kwargs["event_type"] == "card.created"
        )
        assert bridge_call.kwargs["workspace_id"] == test_workspace.id
        assert bridge_call.kwargs["payload"]["entity_id"] == str(entity_id)
        assert bridge_call.kwargs["payload"]["entity_type"] == "card"
        assert bridge_call.kwargs["payload"]["action"] == "created"


async def test_record_emits_card_updated_event(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_board: Board
):
    with patch("app.services.activity.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        service = ActivityService(db_session)
        await service.record(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.card,
            entity_id=uuid.uuid4(),
            action=ActivityAction.updated,
            board_id=test_board.id,
            summary="Card updated",
        )

        assert {"activity.card.updated", "card.updated"} <= _published_events(mock_bus)


async def test_record_emits_card_moved_event(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_board: Board
):
    with patch("app.services.activity.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        service = ActivityService(db_session)
        await service.record(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.card,
            entity_id=uuid.uuid4(),
            action=ActivityAction.moved,
            board_id=test_board.id,
            summary="Card moved",
        )

        assert {"activity.card.moved", "card.moved"} <= _published_events(mock_bus)


async def test_record_emits_card_deleted_event(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_board: Board
):
    with patch("app.services.activity.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        service = ActivityService(db_session)
        await service.record(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.card,
            entity_id=uuid.uuid4(),
            action=ActivityAction.deleted,
            board_id=test_board.id,
            summary="Card deleted",
        )

        assert {"activity.card.deleted", "card.deleted"} <= _published_events(mock_bus)


async def test_record_emits_column_created_event(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_board: Board
):
    """column.created is a bridge event; activity.column.created is the primary twin."""
    with patch("app.services.activity.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        service = ActivityService(db_session)
        await service.record(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.column,
            entity_id=uuid.uuid4(),
            action=ActivityAction.created,
            board_id=test_board.id,
            summary="Column created",
        )

        assert {"activity.column.created", "column.created"} <= _published_events(mock_bus)


async def test_record_emits_column_updated_bridge_and_activity(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_board: Board
):
    with patch("app.services.activity.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        service = ActivityService(db_session)
        await service.record(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.column,
            entity_id=uuid.uuid4(),
            action=ActivityAction.updated,
            board_id=test_board.id,
            summary="Column updated",
        )

        assert {"activity.column.updated", "column.updated"} <= _published_events(mock_bus)


async def test_record_emits_column_deleted_bridge_and_activity(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_board: Board
):
    with patch("app.services.activity.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        service = ActivityService(db_session)
        await service.record(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.column,
            entity_id=uuid.uuid4(),
            action=ActivityAction.deleted,
            board_id=test_board.id,
            summary="Column deleted",
        )

        assert {"activity.column.deleted", "column.deleted"} <= _published_events(mock_bus)


async def test_record_always_emits_activity_event_for_previously_unmapped_pairs(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """Post-Track-A every record publishes activity.{entity}.{action} — no silent pairs."""
    with patch("app.services.activity.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        service = ActivityService(db_session)
        await service.record(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.note,
            entity_id=uuid.uuid4(),
            action=ActivityAction.created,
            summary="Note created",
        )

        assert _published_events(mock_bus) == {"activity.note.created"}


async def test_record_still_persists_activity_when_emission_fails(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_board: Board
):
    """Event bus publish failure should not prevent the activity from being recorded."""
    with patch("app.services.activity.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock(side_effect=Exception("Bus failure"))

        service = ActivityService(db_session)
        await service.record(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.card,
            entity_id=uuid.uuid4(),
            action=ActivityAction.created,
            board_id=test_board.id,
            summary="Card created despite bus failure",
        )

        activities = await service.list_workspace_activity(test_workspace.id)
        assert len(activities) == 1
        assert activities[0].summary == "Card created despite bus failure"


async def test_record_payload_includes_board_id_and_summary(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_board: Board
):
    """Published payload should include board_id and summary when present."""
    with patch("app.services.activity.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        service = ActivityService(db_session)
        await service.record(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.card,
            entity_id=uuid.uuid4(),
            action=ActivityAction.created,
            board_id=test_board.id,
            summary="New feature card",
            changes={"title": "Feature X"},
        )

        activity_call = next(
            c for c in mock_bus.publish.await_args_list
            if c.kwargs["event_type"] == "activity.card.created"
        )
        payload = activity_call.kwargs["payload"]
        assert payload["board_id"] == str(test_board.id)
        assert payload["summary"] == "New feature card"
        assert payload["changes"] == {"title": "Feature X"}
        assert payload["actor_id"] == str(test_user.id)
