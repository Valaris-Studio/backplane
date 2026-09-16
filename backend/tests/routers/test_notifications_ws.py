# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Phase 3 — Targeted WS live push for notifications (RED).

Mirrors tests/routers/test_events_ws.py (Starlette TestClient + the real
EventBus singleton + a threaded publisher). These tests pin the PER-USER
delivery filter the contract requires (§"WS event shape"):

    "The connection_manager delivers only to sockets whose
     user_id == recipient_user_id (new targeted delivery — today delivery is
     workspace-pattern based; add a per-user filter)."

Today a `notification.created` event published with a workspace_id fans out to
EVERY socket subscribed to that workspace+pattern, regardless of recipient. So
the userB-must-NOT-receive test FAILS until the per-user filter is added — that
is the RED proof for the implementation seam. The userA-receives + payload-shape
tests also exercise the new "notification.*" subscription path.

PAYLOAD CONTRACT (contract §"WS event shape"):
    { "notification_id": str, "recipient_user_id": str, "category": str,
      "workspace_id": str, "unread_delta": 1 }
"""

from __future__ import annotations

import threading
import time
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from starlette.testclient import TestClient

from app.core.event_bus import event_bus
from app.main import create_app
from app.models.workspace import WorkspaceRole

# Same hard ceiling rationale as test_events_ws.py: these cross the thread
# boundary and have historically hung in full-suite runs.
pytestmark = [pytest.mark.timeout(15), pytest.mark.slow]


def _wait_for_bus(condition, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.01)
    return False


@pytest.fixture
def ws_app():
    return create_app()


@pytest.fixture(autouse=True)
def _clear_event_bus_subscribers():
    event_bus._subscribers.clear()
    yield
    event_bus._subscribers.clear()


@pytest.fixture
def user_a():
    return SimpleNamespace(id=uuid.uuid4(), email="a@valaris.dev")


@pytest.fixture
def user_b():
    return SimpleNamespace(id=uuid.uuid4(), email="b@valaris.dev")


@pytest.fixture
def mock_workspace():
    return SimpleNamespace(id=uuid.uuid4(), slug="test-workspace")


def _publish_notification_created(workspace_id, recipient_user_id):
    """Publish a contract-shaped notification.created in a fresh loop/thread,
    mirroring the threaded publisher idiom in test_events_ws.py."""
    import asyncio as _asyncio

    payload = {
        "notification_id": str(uuid.uuid4()),
        "recipient_user_id": str(recipient_user_id),
        "category": "card_participant_changed",
        "workspace_id": str(workspace_id),
        "unread_delta": 1,
    }

    def _run():
        loop = _asyncio.new_event_loop()
        loop.run_until_complete(
            event_bus.publish("notification.created", payload, workspace_id)
        )
        loop.close()

    t = threading.Thread(target=_run)
    t.start()
    t.join(timeout=5)
    return payload


def test_ws_notification_delivered_to_recipient_socket(
    ws_app, user_a, mock_workspace
):
    """A socket authenticated as userA, subscribed to "notification.*", receives
    a notification.created whose recipient_user_id == userA, with the contract
    payload shape."""
    with (
        patch(
            "app.routers.events._authenticate_ws", new_callable=AsyncMock
        ) as auth_mock,
        patch(
            "app.routers.events._resolve_workspace", new_callable=AsyncMock
        ) as ws_mock,
    ):
        auth_mock.return_value = (user_a, None)
        ws_mock.return_value = (mock_workspace, WorkspaceRole.admin)

        client = TestClient(ws_app)
        with client.websocket_connect(
            "/ws/workspaces/test-workspace/events"
        ) as ws:
            ws.send_json({"subscribe": ["notification.*"]})
            assert _wait_for_bus(lambda: event_bus._subscribers), (
                "subscribe frame never registered on the event bus"
            )

            published = _publish_notification_created(
                mock_workspace.id, recipient_user_id=user_a.id
            )

            data = ws.receive_json(mode="text")
            while data.get("type") == "ping":
                data = ws.receive_json(mode="text")

            assert data["event"] == "notification.created"
            payload = data["payload"]
            assert payload["recipient_user_id"] == str(user_a.id)
            assert payload["notification_id"] == published["notification_id"]
            assert payload["category"] == "card_participant_changed"
            assert payload["workspace_id"] == str(mock_workspace.id)
            assert payload["unread_delta"] == 1


def test_ws_notification_not_delivered_to_non_recipient_socket(
    ws_app, user_a, user_b, mock_workspace
):
    """The per-user delivery filter: userB's socket, subscribed to the SAME
    workspace + "notification.*", must NOT receive a notification.created whose
    recipient_user_id == userA. RED until connection_manager filters on
    user_id == recipient_user_id (today it delivers to every workspace socket)."""
    with (
        patch(
            "app.routers.events._authenticate_ws", new_callable=AsyncMock
        ) as auth_mock,
        patch(
            "app.routers.events._resolve_workspace", new_callable=AsyncMock
        ) as ws_mock,
    ):
        # userB is the connected/authenticated socket; the event targets userA.
        auth_mock.return_value = (user_b, None)
        ws_mock.return_value = (mock_workspace, WorkspaceRole.admin)

        client = TestClient(ws_app)
        with client.websocket_connect(
            "/ws/workspaces/test-workspace/events"
        ) as ws:
            ws.send_json({"subscribe": ["notification.*"]})
            assert _wait_for_bus(lambda: event_bus._subscribers), (
                "subscribe frame never registered on the event bus"
            )

            _publish_notification_created(
                mock_workspace.id, recipient_user_id=user_a.id
            )

            # The next deliverable event is a FIFO barrier. Receiving userA's
            # event first fails the privacy assertion without leaving a
            # background receiver blocked after socket shutdown.
            barrier = _publish_notification_created(
                mock_workspace.id, recipient_user_id=user_b.id,
            )
            data = ws.receive_json(mode="text")
            while data.get("type") == "ping":
                data = ws.receive_json(mode="text")
            assert data["event"] == "notification.created"
            assert data["payload"]["notification_id"] == barrier["notification_id"], (
                "userB received a notification targeted at userA — the per-user "
                "delivery filter is missing"
            )
            assert data["payload"]["recipient_user_id"] == str(user_b.id)
