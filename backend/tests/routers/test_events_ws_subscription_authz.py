# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Server-side authorization for observer-grade WS subscriptions (card 6711c45e).

The `/ws/workspaces/{slug}/events` firehose was served to any authenticated
workspace member who asked for it: the observer's admin gate lived only in the
client, so a member could open the socket by hand and subscribe to `*`.

These tests pin the predicate itself rather than driving it through the
threaded TestClient — the rule is what carries the security weight, and the
existing TestClient tests in this file document their own hang history.
"""

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.models.workspace import WorkspaceRole
from app.routers.events import (
    PRIVILEGED_SUBSCRIPTION_PATTERNS,
    _apply_subscribe_frame,
    partition_subscriptions,
)


def _conn(agent_id=None, role=WorkspaceRole.member):
    return SimpleNamespace(
        agent_id=agent_id,
        workspace_role=role,
        user_id=uuid.uuid4(),
        workspace_id=uuid.uuid4(),
    )


class TestPrivilegedPatternSet:
    def test_observer_wildcard_is_privileged(self):
        assert "*" in PRIVILEGED_SUBSCRIPTION_PATTERNS

    def test_agentic_namespaces_are_privileged(self):
        for pattern in ("agent.*", "execution.*", "approval.*"):
            assert pattern in PRIVILEGED_SUBSCRIPTION_PATTERNS

    def test_board_sync_namespaces_are_not_privileged(self):
        # Gating these would break live board sync for ordinary members —
        # useDomainSync("card"|"column"|"activity", …) drives the kanban view.
        for pattern in ("card.*", "column.*", "activity.*"):
            assert pattern not in PRIVILEGED_SUBSCRIPTION_PATTERNS


class TestPartitionForHumanMembers:
    def test_member_is_denied_the_wildcard(self):
        allowed, denied = partition_subscriptions(_conn(), ["*"])
        assert allowed == []
        assert denied == ["*"]

    def test_member_is_denied_agentic_namespaces(self):
        allowed, denied = partition_subscriptions(
            _conn(), ["agent.*", "execution.*", "approval.*"]
        )
        assert allowed == []
        assert denied == ["agent.*", "execution.*", "approval.*"]

    def test_member_keeps_board_sync_patterns(self):
        allowed, denied = partition_subscriptions(
            _conn(), ["card.*", "column.*", "activity.*"]
        )
        assert allowed == ["card.*", "column.*", "activity.*"]
        assert denied == []

    def test_mixed_list_drops_only_the_privileged_patterns(self):
        # The browser client sends ALL registered patterns as ONE merged frame
        # (frontend/src/lib/websocket.ts sendSubscriptions), so rejecting the
        # whole frame would take board sync down with the observer.
        allowed, denied = partition_subscriptions(
            _conn(), ["card.*", "*", "column.*", "agent.*"]
        )
        assert allowed == ["card.*", "column.*"]
        assert denied == ["*", "agent.*"]

    def test_viewer_is_denied_like_a_member(self):
        allowed, denied = partition_subscriptions(
            _conn(role=WorkspaceRole.viewer), ["*"]
        )
        assert denied == ["*"]


class TestPartitionForAdmins:
    def test_admin_keeps_the_wildcard(self):
        allowed, denied = partition_subscriptions(
            _conn(role=WorkspaceRole.admin), ["*"]
        )
        assert allowed == ["*"]
        assert denied == []

    def test_owner_keeps_the_wildcard(self):
        allowed, denied = partition_subscriptions(
            _conn(role=WorkspaceRole.owner), ["*", "agent.*"]
        )
        assert allowed == ["*", "agent.*"]
        assert denied == []


class TestPartitionForAgents:
    """An agent key resolves to its CREATING USER, whose workspace role is
    arbitrary — a member-role human can own a runner key. Holding runners to
    the human role hierarchy would cut `approval.*`/`execution.*`/`agent.*` for
    the whole fleet (runner/internal/events/client.go subscribes to exactly
    those). Agents are already held to their own scope at connect time by
    enforce_agent_scope, which is the boundary that applies to them.
    """

    def test_agent_connection_keeps_agentic_namespaces_despite_member_role(self):
        conn = _conn(agent_id=uuid.uuid4(), role=WorkspaceRole.member)
        allowed, denied = partition_subscriptions(
            conn, ["card.*", "approval.*", "execution.*", "config.*", "agent.*"]
        )
        assert allowed == [
            "card.*",
            "approval.*",
            "execution.*",
            "config.*",
            "agent.*",
        ]
        assert denied == []

    def test_agent_connection_keeps_the_wildcard(self):
        conn = _conn(agent_id=uuid.uuid4(), role=WorkspaceRole.viewer)
        allowed, denied = partition_subscriptions(conn, ["*"])
        assert allowed == ["*"]
        assert denied == []


class TestUnknownRoleFailsClosed:
    def test_missing_role_denies_privileged_patterns(self):
        # A connection that predates the role capture (or a resolve path that
        # could not determine one) must not inherit observer access.
        conn = _conn(role=None)
        allowed, denied = partition_subscriptions(conn, ["*", "card.*"])
        assert allowed == ["card.*"]
        assert denied == ["*"]


class TestSubscribeFrameHandling:
    """The frame handler: what actually reaches the bus, and what the client
    is told about the patterns that did not."""

    @pytest.mark.asyncio
    async def test_denied_patterns_are_never_subscribed_on_the_bus(self):
        websocket = AsyncMock()
        manager = AsyncMock()
        conn = _conn()

        await _apply_subscribe_frame(
            websocket, conn, ["card.*", "*"], manager=manager
        )

        manager.update_subscriptions.assert_awaited_once_with(conn, ["card.*"])

    @pytest.mark.asyncio
    async def test_denial_sends_a_typed_error_frame_naming_the_patterns(self):
        websocket = AsyncMock()
        manager = AsyncMock()

        await _apply_subscribe_frame(
            websocket, _conn(), ["card.*", "*", "agent.*"], manager=manager
        )

        websocket.send_json.assert_awaited_once()
        frame = websocket.send_json.await_args.args[0]
        assert frame["type"] == "subscription_denied"
        assert frame["error_code"] == "admin_required"
        assert frame["patterns"] == ["*", "agent.*"]

    @pytest.mark.asyncio
    async def test_fully_allowed_frame_sends_no_error(self):
        websocket = AsyncMock()
        manager = AsyncMock()
        conn = _conn()

        await _apply_subscribe_frame(
            websocket, conn, ["card.*", "column.*"], manager=manager
        )

        websocket.send_json.assert_not_awaited()
        manager.update_subscriptions.assert_awaited_once_with(
            conn, ["card.*", "column.*"]
        )

    @pytest.mark.asyncio
    async def test_admin_frame_subscribes_the_wildcard_untouched(self):
        websocket = AsyncMock()
        manager = AsyncMock()
        conn = _conn(role=WorkspaceRole.admin)

        await _apply_subscribe_frame(websocket, conn, ["*"], manager=manager)

        manager.update_subscriptions.assert_awaited_once_with(conn, ["*"])
        websocket.send_json.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_all_patterns_denied_still_clears_prior_subscriptions(self):
        # A member who previously held `card.*` and now sends only `*` must end
        # up subscribed to nothing, not silently retain the earlier set.
        websocket = AsyncMock()
        manager = AsyncMock()
        conn = _conn()

        await _apply_subscribe_frame(websocket, conn, ["*"], manager=manager)

        manager.update_subscriptions.assert_awaited_once_with(conn, [])


class TestThroughTheRealSocket:
    """End-to-end over the actual WS route.

    The predicate tests above pin the RULE; these pin that the rule is
    REACHABLE — a correct predicate wired to nothing is still an open socket.
    """

    @pytest.fixture(autouse=True)
    def _clear_event_bus_subscribers(self):
        from app.core.event_bus import event_bus

        event_bus._subscribers.clear()
        yield
        event_bus._subscribers.clear()

    @staticmethod
    def _patched(role, agent_id=None):
        from unittest.mock import patch

        workspace = SimpleNamespace(id=uuid.uuid4(), slug="test-workspace")
        user = SimpleNamespace(id=uuid.uuid4(), email="member@valaris.dev")
        auth = patch(
            "app.routers.events._authenticate_ws",
            new_callable=AsyncMock,
            return_value=(user, agent_id),
        )
        resolve = patch(
            "app.routers.events._resolve_workspace",
            new_callable=AsyncMock,
            return_value=(workspace, role),
        )
        return auth, resolve

    @pytest.mark.slow
    def test_member_subscribing_to_wildcard_gets_the_denial_frame(self):
        from starlette.testclient import TestClient

        auth, resolve = self._patched(WorkspaceRole.member)
        with auth, resolve:
            client = TestClient(self.ws_app_instance())
            with client.websocket_connect(
                "/ws/workspaces/test-workspace/events"
            ) as ws:
                ws.send_json({"subscribe": ["*"]})
                frame = ws.receive_json(mode="text")
                while frame.get("type") == "ping":
                    frame = ws.receive_json(mode="text")

                assert frame["type"] == "subscription_denied"
                assert frame["error_code"] == "admin_required"
                assert frame["patterns"] == ["*"]

    @pytest.mark.slow
    def test_member_subscribing_to_card_events_is_not_denied(self):
        from starlette.testclient import TestClient

        from app.core.event_bus import event_bus

        auth, resolve = self._patched(WorkspaceRole.member)
        with auth, resolve:
            client = TestClient(self.ws_app_instance())
            with client.websocket_connect(
                "/ws/workspaces/test-workspace/events"
            ) as ws:
                ws.send_json({"subscribe": ["card.*"]})
                ws.send_json({"type": "pong"})

                import time

                deadline = time.monotonic() + 5.0
                while time.monotonic() < deadline and not event_bus._subscribers:
                    time.sleep(0.01)

                assert event_bus._subscribers, (
                    "member's card.* subscription never reached the bus"
                )

    def ws_app_instance(self):
        from app.main import create_app

        return create_app()
