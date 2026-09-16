# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import logging
import uuid

import pytest

from unittest.mock import AsyncMock

from app.core.event_bus import EventBus, Event


async def test_publish_delivers_to_subscriber():
    bus = EventBus()
    callback = AsyncMock()
    workspace_id = uuid.uuid4()

    bus.subscribe(callback, event_pattern="*")
    await bus.publish("card.created", {"title": "New"}, workspace_id)

    callback.assert_awaited_once()
    event: Event = callback.call_args[0][0]
    assert event.event_type == "card.created"
    assert event.workspace_id == workspace_id
    assert event.payload == {"title": "New"}
    assert event.event_id is not None
    assert event.timestamp is not None


async def test_publish_filters_by_workspace():
    bus = EventBus()
    callback = AsyncMock()
    workspace_a = uuid.uuid4()
    workspace_b = uuid.uuid4()

    bus.subscribe(callback, workspace_id=workspace_a, event_pattern="*")
    await bus.publish("card.created", {}, workspace_b)

    callback.assert_not_awaited()


async def test_publish_filters_by_event_pattern():
    bus = EventBus()
    callback = AsyncMock()

    bus.subscribe(callback, event_pattern="card.*")
    await bus.publish("card.created", {}, uuid.uuid4())
    assert callback.await_count == 1

    await bus.publish("approval.updated", {}, uuid.uuid4())
    assert callback.await_count == 1  # still 1, not called for approval


async def test_subscribe_returns_unsubscribe_callable():
    bus = EventBus()
    callback = AsyncMock()

    unsub = bus.subscribe(callback, event_pattern="*")
    unsub()

    await bus.publish("card.created", {}, uuid.uuid4())
    callback.assert_not_awaited()


async def test_publish_swallows_subscriber_errors():
    bus = EventBus()
    failing_callback = AsyncMock(side_effect=RuntimeError("boom"))
    healthy_callback = AsyncMock()

    bus.subscribe(failing_callback, event_pattern="*")
    bus.subscribe(healthy_callback, event_pattern="*")

    await bus.publish("card.created", {}, uuid.uuid4())

    failing_callback.assert_awaited_once()
    healthy_callback.assert_awaited_once()


async def test_publish_concurrent_delivery():
    bus = EventBus()
    callbacks = [AsyncMock() for _ in range(3)]
    workspace_id = uuid.uuid4()

    for cb in callbacks:
        bus.subscribe(cb, event_pattern="*")

    await bus.publish("card.updated", {"field": "title"}, workspace_id)

    for cb in callbacks:
        cb.assert_awaited_once()
        event: Event = cb.call_args[0][0]
        assert event.event_type == "card.updated"
        assert event.workspace_id == workspace_id


async def test_publish_no_subscribers_no_error():
    bus = EventBus()
    # Should not raise
    await bus.publish("card.deleted", {}, uuid.uuid4())


async def test_dispatch_local_delivers_a_prebuilt_event():
    # §6.1 seam: the local-only fan-out path that the Postgres adapter reuses
    # for remote events (so a re-injected event is NOT re-NOTIFYed). It takes a
    # fully-formed Event and runs the exact same workspace/pattern matching as
    # publish, but never constructs a new event or touches any transport.
    bus = EventBus()
    callback = AsyncMock()
    workspace_id = uuid.uuid4()
    bus.subscribe(callback, workspace_id=workspace_id, event_pattern="card.*")

    event = Event(event_type="card.moved", workspace_id=workspace_id, payload={"id": "x"})
    await bus._dispatch_local(event)

    callback.assert_awaited_once()
    delivered: Event = callback.call_args[0][0]
    # Same identity, not a re-wrapped copy — preserves event_id across instances.
    assert delivered is event
    assert delivered.event_id == event.event_id


async def test_dispatch_local_respects_workspace_and_pattern_filters():
    bus = EventBus()
    cb_match = AsyncMock()
    cb_wrong_ws = AsyncMock()
    cb_wrong_pattern = AsyncMock()
    ws_a = uuid.uuid4()
    ws_b = uuid.uuid4()
    bus.subscribe(cb_match, workspace_id=ws_a, event_pattern="card.*")
    bus.subscribe(cb_wrong_ws, workspace_id=ws_b, event_pattern="card.*")
    bus.subscribe(cb_wrong_pattern, workspace_id=ws_a, event_pattern="approval.*")

    await bus._dispatch_local(Event(event_type="card.created", workspace_id=ws_a, payload={}))

    cb_match.assert_awaited_once()
    cb_wrong_ws.assert_not_awaited()
    cb_wrong_pattern.assert_not_awaited()


async def test_dispatch_local_swallows_subscriber_errors():
    bus = EventBus()
    failing = AsyncMock(side_effect=RuntimeError("boom"))
    healthy = AsyncMock()
    bus.subscribe(failing, event_pattern="*")
    bus.subscribe(healthy, event_pattern="*")

    await bus._dispatch_local(Event(event_type="card.created", workspace_id=uuid.uuid4(), payload={}))

    failing.assert_awaited_once()
    healthy.assert_awaited_once()


@pytest.mark.parametrize("truthy", ["1", "true", "TRUE", "True", "yes", "Yes", "YES"])
async def test_publish_logs_event_when_VALARIS_EVENT_LOG_truthy(monkeypatch, caplog, truthy):
    monkeypatch.setenv("VALARIS_EVENT_LOG", truthy)
    bus = EventBus()
    workspace_id = uuid.uuid4()

    with caplog.at_level(logging.INFO, logger="app.core.event_bus"):
        await bus.publish("card.created", {"title": "New"}, workspace_id)

    matching = [r for r in caplog.records if r.message == "event_bus"]
    assert len(matching) == 1
    event = getattr(matching[0], "event")
    assert event["event_type"] == "card.created"
    assert event["workspace_id"] == str(workspace_id)
    assert event["payload"] == {"title": "New"}
    assert "event_id" in event
    assert "timestamp" in event


@pytest.mark.parametrize("falsy", ["", "0", "false", "FALSE", "no", "off", "2"])
async def test_publish_does_not_log_when_VALARIS_EVENT_LOG_falsy(monkeypatch, caplog, falsy):
    monkeypatch.setenv("VALARIS_EVENT_LOG", falsy)
    bus = EventBus()

    with caplog.at_level(logging.INFO, logger="app.core.event_bus"):
        await bus.publish("card.created", {}, uuid.uuid4())

    assert not any(r.message == "event_bus" for r in caplog.records)


async def test_publish_does_not_log_when_VALARIS_EVENT_LOG_unset(monkeypatch, caplog):
    monkeypatch.delenv("VALARIS_EVENT_LOG", raising=False)
    bus = EventBus()

    with caplog.at_level(logging.INFO, logger="app.core.event_bus"):
        await bus.publish("card.created", {}, uuid.uuid4())

    assert not any(r.message == "event_bus" for r in caplog.records)


def test_app_import_installs_root_logger_handler():
    # WS-6.1: uvicorn --reload does not configure handlers for the root
    # logger, so app-level logger.info() calls (including VALARIS_EVENT_LOG
    # event-bus records) were silently dropped. Importing app.main must
    # ensure the root logger has at least one handler so INFO diagnostics
    # reach stdout under dev uvicorn.
    import app.main  # noqa: F401

    root = logging.getLogger()
    assert root.handlers, "root logger must have a handler after app.main import (WS-6.1)"
    assert root.level <= logging.INFO, "root logger level must allow INFO records"
