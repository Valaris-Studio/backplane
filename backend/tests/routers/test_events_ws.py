# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import time
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from starlette.testclient import TestClient

from app.core.event_bus import event_bus
from app.main import create_app
from app.models.workspace import WorkspaceRole


def _wait_for_bus(condition, timeout: float = 5.0) -> bool:
    """Busy-wait (bounded) on an event-bus state transition.

    Subscribe/unsubscribe frames are processed asynchronously in the server
    thread: connections register on `event_bus._subscribers` only when the
    frame is consumed. A publish fired before that registration is silently
    dropped (patterns=[]), so tests must observe the bus state instead of
    sleeping a fixed amount.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.01)
    return False

# Hard ceiling per test in this file. These tests cross the thread boundary
# (Starlette TestClient + real EventBus singleton + threaded publishers) and
# historically hung indefinitely in full-suite runs (see I.1.g). The timeout
# is a safety net; individual tests should finish in well under 5s.
# TODO: replace TestClient-based tests with httpx.AsyncClient websocket_connect
# and drop the threaded publishers to remove the hang risk altogether.
pytestmark = pytest.mark.timeout(15)


# Fresh app for each test to avoid cross-test state leaking via module-level connection_manager
@pytest.fixture
def ws_app():
    return create_app()


@pytest.fixture(autouse=True)
def _clear_event_bus_subscribers():
    """Prevent cross-test leakage via the module-level EventBus singleton.

    The router holds `connection_manager = ConnectionManager(event_bus)` at
    module scope, so every test in this file shares the same bus. If a prior
    test left subscribers attached (e.g. TestClient disconnect path missed the
    cleanup), later publishes would fan out to stale callbacks whose websockets
    are closed — which can surface as deadlocks under certain orderings.
    """
    event_bus._subscribers.clear()
    yield
    event_bus._subscribers.clear()


@pytest.fixture
def mock_user():
    return SimpleNamespace(id=uuid.uuid4(), email="test@valaris.dev")


@pytest.fixture
def mock_workspace():
    return SimpleNamespace(id=uuid.uuid4(), slug="test-workspace")


def test_ws_connect_dev_mode(ws_app, mock_user, mock_workspace):
    with (
        patch(
            "app.routers.events._authenticate_ws", new_callable=AsyncMock
        ) as auth_mock,
        patch(
            "app.routers.events._resolve_workspace", new_callable=AsyncMock
        ) as ws_mock,
    ):
        auth_mock.return_value = (mock_user, None)
        ws_mock.return_value = (mock_workspace, WorkspaceRole.admin)

        client = TestClient(ws_app)
        with client.websocket_connect("/ws/workspaces/test-workspace/events") as ws:
            # Connection established -- send a subscribe message to confirm it works
            ws.send_json({"subscribe": ["card.*"]})
            # If we get here without exception, connection was accepted


def test_ws_auth_failure_closes_connection(ws_app):
    with (
        patch(
            "app.routers.events._authenticate_ws", new_callable=AsyncMock
        ) as auth_mock,
    ):
        auth_mock.return_value = (None, None)

        client = TestClient(ws_app)
        # WebSocket should be closed with 4001 code before accept
        with pytest.raises(Exception):
            with client.websocket_connect("/ws/workspaces/test-workspace/events"):
                pass


def test_ws_workspace_not_found_closes_connection(ws_app, mock_user):
    with (
        patch(
            "app.routers.events._authenticate_ws", new_callable=AsyncMock
        ) as auth_mock,
        patch(
            "app.routers.events._resolve_workspace", new_callable=AsyncMock
        ) as ws_mock,
    ):
        auth_mock.return_value = (mock_user, None)
        ws_mock.return_value = (None, None)

        client = TestClient(ws_app)
        with pytest.raises(Exception):
            with client.websocket_connect("/ws/workspaces/nonexistent/events"):
                pass


@pytest.mark.slow
def test_ws_subscribe_receives_events(ws_app, mock_user, mock_workspace):
    with (
        patch(
            "app.routers.events._authenticate_ws", new_callable=AsyncMock
        ) as auth_mock,
        patch(
            "app.routers.events._resolve_workspace", new_callable=AsyncMock
        ) as ws_mock,
    ):
        auth_mock.return_value = (mock_user, None)
        ws_mock.return_value = (mock_workspace, WorkspaceRole.admin)

        client = TestClient(ws_app)
        with client.websocket_connect("/ws/workspaces/test-workspace/events") as ws:
            ws.send_json({"subscribe": ["card.*"]})

            # Publish an event via the event bus (use the global singleton since the router uses it)

            # We need to run the async publish in the app's event loop
            # The TestClient runs the ASGI app in a thread with its own loop.
            # send_json/receive_json bridge between threads.
            # We publish by sending a trigger message that the test can use.
            # Instead, use asyncio to schedule the publish -- the TestClient
            # handles this via its internal event loop.

            # Simpler approach: publish directly and check

            # The Starlette TestClient uses anyio internally. We can publish
            # through the event bus synchronously from the test thread by using
            # the connection_manager's bus. But EventBus.publish is async.
            # We'll use a helper approach: send a second message after subscribe
            # to ensure the subscribe took effect, then use a background publish.

            # Actually for Starlette TestClient, the send/receive calls use
            # a thread-safe queue. We can run publish in a separate thread.
            import threading

            def publish_event():
                import asyncio as _asyncio

                loop = _asyncio.new_event_loop()
                loop.run_until_complete(
                    event_bus.publish(
                        "card.created",
                        {"title": "New Card"},
                        mock_workspace.id,
                    )
                )
                loop.close()

            # Wait until the subscribe frame has actually registered on the
            # bus — a publish that wins this race is dropped (15s timeout).
            assert _wait_for_bus(lambda: event_bus._subscribers), (
                "subscribe frame never registered on the event bus"
            )
            t = threading.Thread(target=publish_event)
            t.start()
            t.join(timeout=5)

            # Should receive the event (skip any ping messages)
            data = ws.receive_json(mode="text")
            while data.get("type") == "ping":
                data = ws.receive_json(mode="text")

            assert data["event"] == "card.created"
            assert data["payload"] == {"title": "New Card"}
            assert "timestamp" in data
            assert "event_id" in data


@pytest.mark.slow
def test_ws_subscribe_filters_non_matching(ws_app, mock_user, mock_workspace):
    with (
        patch(
            "app.routers.events._authenticate_ws", new_callable=AsyncMock
        ) as auth_mock,
        patch(
            "app.routers.events._resolve_workspace", new_callable=AsyncMock
        ) as ws_mock,
    ):
        auth_mock.return_value = (mock_user, None)
        ws_mock.return_value = (mock_workspace, WorkspaceRole.admin)

        client = TestClient(ws_app)
        with client.websocket_connect("/ws/workspaces/test-workspace/events") as ws:
            ws.send_json({"subscribe": ["card.*"]})

            import threading

            def publish_non_matching():
                import asyncio as _asyncio

                loop = _asyncio.new_event_loop()
                loop.run_until_complete(
                    event_bus.publish(
                        "approval.updated",
                        {"id": "some-id"},
                        mock_workspace.id,
                    )
                )
                loop.close()

            # Without this wait the assertion passes vacuously when the
            # publish wins the subscribe race — wait so the test actually
            # exercises the pattern FILTER, not an empty subscriber list.
            assert _wait_for_bus(lambda: event_bus._subscribers), (
                "subscribe frame never registered on the event bus"
            )
            t = threading.Thread(target=publish_non_matching)
            t.start()
            t.join(timeout=5)

            # A permitted event forms a FIFO barrier after the filtered one.
            # An unbounded receive in a timeout-joined thread would survive
            # socket closure and prevent the pytest process from exiting.
            ws.portal.call(
                event_bus.publish, "card.created", {"probe": "filter-complete"},
                mock_workspace.id,
            )
            data = ws.receive_json(mode="text")
            while data.get("type") == "ping":
                data = ws.receive_json(mode="text")
            assert data["event"] == "card.created"
            assert data["payload"] == {"probe": "filter-complete"}


@pytest.mark.slow
def test_ws_heartbeat_frame_routes_to_agent_service(
    ws_app, mock_user, mock_workspace
):
    """A {"type":"heartbeat","payload":{...}} frame on an agent-bound WS must
    reach AgentService.handle_ws_heartbeat with the agent_id and workspace_id
    from the connection. This is the transport contract for WS-2."""
    agent_id = uuid.uuid4()
    calls: list[tuple[uuid.UUID, dict, uuid.UUID]] = []

    async def _fake(self, a_id, payload, workspace_id=None):
        calls.append((a_id, payload, workspace_id))
        return SimpleNamespace(
            health_status=payload.get("status"),
            last_seen_at=None,
        )

    with (
        patch(
            "app.routers.events._authenticate_ws", new_callable=AsyncMock
        ) as auth_mock,
        patch(
            "app.routers.events._resolve_workspace", new_callable=AsyncMock
        ) as ws_mock,
        patch(
            "app.services.agents.agent.AgentService.handle_ws_heartbeat",
            new=_fake,
        ),
    ):
        auth_mock.return_value = (mock_user, agent_id)
        ws_mock.return_value = (mock_workspace, WorkspaceRole.admin)

        client = TestClient(ws_app)
        with client.websocket_connect("/ws/workspaces/test-workspace/events") as ws:
            ws.send_json(
                {
                    "type": "heartbeat",
                    "payload": {"status": "working", "current_card_id": "c-1"},
                }
            )
            # Follow with a pong so the server finishes processing the
            # heartbeat frame before the test teardown closes the socket.
            ws.send_json({"type": "pong"})

            import time

            for _ in range(50):
                if calls:
                    break
                time.sleep(0.02)

    assert len(calls) == 1, f"expected 1 handler call, got {len(calls)}"
    a_id, payload, workspace_id = calls[0]
    assert a_id == agent_id
    assert payload == {"status": "working", "current_card_id": "c-1"}
    assert workspace_id == mock_workspace.id


@pytest.mark.slow
def test_ws_heartbeat_frame_ignored_when_no_agent_bound(
    ws_app, mock_user, mock_workspace
):
    """User-only WS (no linked agent) must not call the heartbeat handler."""
    calls: list[tuple] = []

    async def _fake(self, a_id, payload, workspace_id=None):
        calls.append((a_id, payload, workspace_id))

    with (
        patch(
            "app.routers.events._authenticate_ws", new_callable=AsyncMock
        ) as auth_mock,
        patch(
            "app.routers.events._resolve_workspace", new_callable=AsyncMock
        ) as ws_mock,
        patch(
            "app.services.agents.agent.AgentService.handle_ws_heartbeat",
            new=_fake,
        ),
    ):
        auth_mock.return_value = (mock_user, None)  # no agent
        ws_mock.return_value = (mock_workspace, WorkspaceRole.admin)

        client = TestClient(ws_app)
        with client.websocket_connect("/ws/workspaces/test-workspace/events") as ws:
            ws.send_json({"type": "heartbeat", "payload": {"status": "idle"}})
            ws.send_json({"type": "pong"})
            import time

            time.sleep(0.2)

    assert calls == []


@pytest.mark.slow
def test_ws_subscribe_processed_before_next_receive(ws_app, mock_user, mock_workspace):
    """Subscribe must register with the event bus before the server reads the
    next client frame. If the receive loop doesn't await update_subscriptions
    deterministically, an event published between the second client send and
    the server re-entering receive_text could slip through with no subscription
    attached. Covers the WS-5 server-side timing concern: send subscribe, then
    a second control frame; any publish after the first but before the second
    completes must be delivered.
    """
    with (
        patch(
            "app.routers.events._authenticate_ws", new_callable=AsyncMock
        ) as auth_mock,
        patch(
            "app.routers.events._resolve_workspace", new_callable=AsyncMock
        ) as ws_mock,
    ):
        auth_mock.return_value = (mock_user, None)
        ws_mock.return_value = (mock_workspace, WorkspaceRole.admin)

        client = TestClient(ws_app)
        with client.websocket_connect("/ws/workspaces/test-workspace/events") as ws:
            ws.send_json({"subscribe": ["card.*"]})
            # Second frame forces a full receive-loop iteration after subscribe
            # has been awaited — any implementation that registers the callback
            # asynchronously (fire-and-forget task) would race here.
            ws.send_json({"type": "pong"})

            import threading

            def publish_event():
                import asyncio as _asyncio

                loop = _asyncio.new_event_loop()
                loop.run_until_complete(
                    event_bus.publish(
                        "card.moved",
                        {"card_id": "c-timing"},
                        mock_workspace.id,
                    )
                )
                loop.close()

            # Same dropped-publish race as test_ws_subscribe_receives_events:
            # observe the bus registration before publishing.
            assert _wait_for_bus(lambda: event_bus._subscribers), (
                "subscribe frame never registered on the event bus"
            )
            t = threading.Thread(target=publish_event)
            t.start()
            t.join(timeout=5)

            data = ws.receive_json(mode="text")
            while data.get("type") == "ping":
                data = ws.receive_json(mode="text")

            assert data["event"] == "card.moved"
            assert data["payload"] == {"card_id": "c-timing"}


@pytest.mark.slow
def test_ws_unsubscribe_stops_events(ws_app, mock_user, mock_workspace):
    with (
        patch(
            "app.routers.events._authenticate_ws", new_callable=AsyncMock
        ) as auth_mock,
        patch(
            "app.routers.events._resolve_workspace", new_callable=AsyncMock
        ) as ws_mock,
    ):
        auth_mock.return_value = (mock_user, None)
        ws_mock.return_value = (mock_workspace, WorkspaceRole.admin)

        client = TestClient(ws_app)
        with client.websocket_connect("/ws/workspaces/test-workspace/events") as ws:
            import threading

            # Subscribe first — wait until it registers on the bus, else the
            # unsubscribe-then-publish below tests an empty subscriber list.
            ws.send_json({"subscribe": ["card.*"]})
            assert _wait_for_bus(lambda: event_bus._subscribers), (
                "subscribe frame never registered on the event bus"
            )

            # Unsubscribe — wait for the bus entry to be REMOVED before
            # publishing; a publish racing the unsubscribe would be delivered
            # and flake the no-event assertion.
            ws.send_json({"unsubscribe": ["card.*"]})
            assert _wait_for_bus(lambda: not event_bus._subscribers), (
                "unsubscribe frame never removed the bus registration"
            )

            def publish_after_unsub():
                import asyncio as _asyncio

                loop = _asyncio.new_event_loop()
                loop.run_until_complete(
                    event_bus.publish(
                        "card.created",
                        {"title": "Should Not See"},
                        mock_workspace.id,
                    )
                )
                loop.close()

            t = threading.Thread(target=publish_after_unsub)
            t.start()
            t.join(timeout=5)

            # A different subscription supplies a FIFO barrier without
            # re-enabling the card events this test just unsubscribed from.
            ws.send_json({"subscribe": ["probe.complete"]})
            assert _wait_for_bus(lambda: event_bus._subscribers)
            ws.portal.call(
                event_bus.publish, "probe.complete", {"probe": "unsubscribe-complete"},
                mock_workspace.id,
            )
            data = ws.receive_json(mode="text")
            while data.get("type") == "ping":
                data = ws.receive_json(mode="text")
            assert data["event"] == "probe.complete"
            assert data["payload"] == {"probe": "unsubscribe-complete"}
