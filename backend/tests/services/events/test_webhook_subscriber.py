# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from unittest.mock import AsyncMock, MagicMock, patch

from app.core.event_bus import Event, EventBus
from app.services.events.webhook_subscriber import WebhookSubscriber


async def test_start_subscribes_to_event_bus():
    bus = EventBus()
    factory = AsyncMock()
    subscriber = WebhookSubscriber(bus, factory)

    assert len(bus._subscribers) == 0
    subscriber.start()
    assert len(bus._subscribers) == 1


async def test_handle_event_creates_session_and_emits():
    bus = EventBus()

    mock_session = AsyncMock()

    # async_sessionmaker() returns a sync callable that yields an async context manager
    mock_begin_ctx = AsyncMock()
    mock_begin_ctx.__aenter__ = AsyncMock()
    mock_begin_ctx.__aexit__ = AsyncMock(return_value=False)
    mock_session.begin = MagicMock(return_value=mock_begin_ctx)

    mock_session_ctx = AsyncMock()
    mock_session_ctx.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session_ctx.__aexit__ = AsyncMock(return_value=False)

    mock_session_factory = MagicMock(return_value=mock_session_ctx)

    subscriber = WebhookSubscriber(bus, mock_session_factory)
    subscriber.start()

    workspace_id = uuid.uuid4()

    with patch("app.services.events.webhook_subscriber.EventEmitter") as MockEmitter:
        mock_emitter = AsyncMock()
        MockEmitter.return_value = mock_emitter

        await bus.publish("card.created", {"title": "Test"}, workspace_id)

        MockEmitter.assert_called_once_with(mock_session)
        mock_emitter.emit.assert_awaited_once_with(
            workspace_id=workspace_id,
            event="card.created",
            payload={"title": "Test"},
        )


async def test_stop_unsubscribes():
    bus = EventBus()
    factory = AsyncMock()
    subscriber = WebhookSubscriber(bus, factory)

    subscriber.start()
    assert len(bus._subscribers) == 1

    subscriber.stop()
    assert len(bus._subscribers) == 0


async def test_handle_event_error_does_not_propagate():
    bus = EventBus()

    mock_session_factory = MagicMock(side_effect=RuntimeError("DB down"))

    subscriber = WebhookSubscriber(bus, mock_session_factory)
    subscriber.start()

    # Should not raise despite session_factory failing
    await bus.publish("card.created", {}, uuid.uuid4())
