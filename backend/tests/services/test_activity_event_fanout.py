# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Track A of M-Observability: every ActivityService.record call must land an
`activity.{entity}.{action}` event on the in-process bus, for every (entity,
action) pair that the codebase actually records. Bridge events (card.*,
column.created) continue to fire in parallel.

This test is the successor to the `WebhookEvent ⊆ events.py` canary in
tests/services/webhooks/test_event_emitter.py — strictly stronger: it asserts
a publisher exists on the activity fan-out pathway, not merely that the
constant exists.
"""
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import ActivityAction, ActivityEntityType
from app.models.kanban.board import Board
from app.models.user import User
from app.models.webhooks.webhook import WebhookEvent
from app.models.workspace import Workspace
from app.services.activity import ActivityService

# The exact pairs that live code paths pass to ActivityService.record.
# Keep this list in lock-step with real callsites in app/services/**; a
# `grep -nE "entity_type=ActivityEntityType" app/services` should round-trip.
RECORDED_PAIRS: list[tuple[ActivityEntityType, ActivityAction]] = [
    # card
    (ActivityEntityType.card, ActivityAction.created),
    (ActivityEntityType.card, ActivityAction.updated),
    (ActivityEntityType.card, ActivityAction.moved),
    (ActivityEntityType.card, ActivityAction.deleted),
    (ActivityEntityType.card, ActivityAction.dependency_added),
    (ActivityEntityType.card, ActivityAction.dependency_removed),
    (ActivityEntityType.card, ActivityAction.dependencies_replaced),
    # column
    (ActivityEntityType.column, ActivityAction.created),
    (ActivityEntityType.column, ActivityAction.updated),
    (ActivityEntityType.column, ActivityAction.deleted),
    # board
    (ActivityEntityType.board, ActivityAction.created),
    (ActivityEntityType.board, ActivityAction.updated),
    (ActivityEntityType.board, ActivityAction.deleted),
    # note
    (ActivityEntityType.note, ActivityAction.created),
    (ActivityEntityType.note, ActivityAction.updated),
    (ActivityEntityType.note, ActivityAction.deleted),
    # resource
    (ActivityEntityType.resource, ActivityAction.created),
    (ActivityEntityType.resource, ActivityAction.updated),
    (ActivityEntityType.resource, ActivityAction.deleted),
    # definition
    (ActivityEntityType.definition, ActivityAction.created),
    (ActivityEntityType.definition, ActivityAction.updated),
    # channel
    (ActivityEntityType.channel, ActivityAction.created),
    (ActivityEntityType.channel, ActivityAction.updated),
    (ActivityEntityType.channel, ActivityAction.deleted),
    # git_repo
    (ActivityEntityType.git_repo, ActivityAction.created),
    (ActivityEntityType.git_repo, ActivityAction.updated),
    (ActivityEntityType.git_repo, ActivityAction.deleted),
    # workspace
    (ActivityEntityType.workspace, ActivityAction.created),
    (ActivityEntityType.workspace, ActivityAction.updated),
    # member
    (ActivityEntityType.member, ActivityAction.added_member),
    (ActivityEntityType.member, ActivityAction.removed_member),
]

BRIDGE_EVENTS: dict[tuple[ActivityEntityType, ActivityAction], str] = {
    (ActivityEntityType.card, ActivityAction.created): "card.created",
    (ActivityEntityType.card, ActivityAction.updated): "card.updated",
    (ActivityEntityType.card, ActivityAction.moved): "card.moved",
    (ActivityEntityType.card, ActivityAction.deleted): "card.deleted",
    (ActivityEntityType.column, ActivityAction.created): "column.created",
    (ActivityEntityType.column, ActivityAction.updated): "column.updated",
    (ActivityEntityType.column, ActivityAction.deleted): "column.deleted",
}


@pytest.mark.parametrize(("entity_type", "action"), RECORDED_PAIRS)
async def test_record_publishes_activity_namespace(
    entity_type: ActivityEntityType,
    action: ActivityAction,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
):
    """Every (entity, action) pair the codebase records MUST fan out as activity.{entity}.{action}."""
    expected_event = f"activity.{entity_type.value}.{action.value}"
    with patch("app.services.activity.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        service = ActivityService(db_session)
        entity_id = uuid.uuid4()
        await service.record(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=entity_type,
            entity_id=entity_id,
            action=action,
            board_id=test_board.id,
            summary=f"{entity_type.value} {action.value}",
            changes={"field": "value"},
        )

    published_event_types = {
        call.kwargs["event_type"] for call in mock_bus.publish.await_args_list
    }
    assert expected_event in published_event_types, (
        f"Expected {expected_event} on the bus; got {sorted(published_event_types)}"
    )

    activity_call = next(
        c for c in mock_bus.publish.await_args_list
        if c.kwargs["event_type"] == expected_event
    )
    payload = activity_call.kwargs["payload"]
    assert payload["entity_type"] == entity_type.value
    assert payload["entity_id"] == str(entity_id)
    assert payload["action"] == action.value
    assert payload["actor_id"] == str(test_user.id)
    assert payload["board_id"] == str(test_board.id)
    assert payload["summary"] == f"{entity_type.value} {action.value}"
    assert payload["changes"] == {"field": "value"}
    assert activity_call.kwargs["workspace_id"] == test_workspace.id


@pytest.mark.parametrize(
    ("entity_type", "action", "bridge_event"),
    [(e, a, v) for (e, a), v in BRIDGE_EVENTS.items()],
)
async def test_record_still_publishes_bridge_event(
    entity_type: ActivityEntityType,
    action: ActivityAction,
    bridge_event: str,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
):
    """Bridge events (card.*, column.created) must continue to fire alongside activity.* twins."""
    with patch("app.services.activity.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        service = ActivityService(db_session)
        await service.record(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=entity_type,
            entity_id=uuid.uuid4(),
            action=action,
            board_id=test_board.id,
            summary="bridge",
        )

    published = {call.kwargs["event_type"] for call in mock_bus.publish.await_args_list}
    assert bridge_event in published, (
        f"Bridge event {bridge_event} missing; published={sorted(published)}"
    )
    assert f"activity.{entity_type.value}.{action.value}" in published


async def test_record_non_bridge_pair_publishes_only_activity_namespace(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    """A pair outside the 5 bridge events must publish exactly one event on the bus."""
    with patch("app.services.activity.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        service = ActivityService(db_session)
        await service.record(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.note,
            entity_id=uuid.uuid4(),
            action=ActivityAction.created,
            summary="note bridge-free",
        )

    assert mock_bus.publish.await_count == 1
    event_type = mock_bus.publish.await_args_list[0].kwargs["event_type"]
    assert event_type == "activity.note.created"


def test_webhook_event_enum_covers_all_recorded_activity_pairs():
    """Successor to the cf9d880 canary — every recorded (entity, action) pair has
    a typed WebhookEvent entry so it's externally subscribable. Drift detector."""
    expected_values = {
        f"activity.{entity.value}.{action.value}"
        for entity, action in RECORDED_PAIRS
    }
    declared_values = {e.value for e in WebhookEvent if e.value.startswith("activity.")}
    assert declared_values == expected_values, (
        "WebhookEvent activity.* entries must match the pairs emitted by "
        "ActivityService exactly. "
        f"Missing: {sorted(expected_values - declared_values)}; "
        f"unexpected: {sorted(declared_values - expected_values)}"
    )
