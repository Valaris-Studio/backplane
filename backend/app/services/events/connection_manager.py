# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

from fastapi import WebSocket

from app.core.event_bus import Event, EventBus, event_bus
from app.core.events import AGENT_RESTART_ACK, AGENT_RESTART_PROBE
from app.models.workspace import WorkspaceRole

logger = logging.getLogger(__name__)


@dataclass
class WebSocketConnection:
    websocket: WebSocket
    workspace_id: uuid.UUID
    user_id: uuid.UUID
    agent_id: uuid.UUID | None = None
    # Captured at connect so subscription authorization does not re-read the
    # membership per frame. None means "could not be determined" and fails
    # closed for observer-grade patterns (app.routers.events._may_observe).
    workspace_role: WorkspaceRole | None = None
    patterns: list[str] = field(default_factory=list)
    connected_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    _unsubscribe_fns: list[Callable] = field(default_factory=list, repr=False)


class ConnectionManager:
    def __init__(self, bus: EventBus):
        self._bus = bus
        self._connections: list[WebSocketConnection] = []

    async def connect(
        self,
        websocket: WebSocket,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID,
        agent_id: uuid.UUID | None = None,
        workspace_role: WorkspaceRole | None = None,
    ) -> WebSocketConnection:
        conn = WebSocketConnection(
            websocket=websocket,
            workspace_id=workspace_id,
            user_id=user_id,
            agent_id=agent_id,
            workspace_role=workspace_role,
        )
        self._connections.append(conn)
        return conn

    async def disconnect(self, conn: WebSocketConnection) -> None:
        for unsub in conn._unsubscribe_fns:
            unsub()
        conn._unsubscribe_fns.clear()
        if conn in self._connections:
            self._connections.remove(conn)

    async def update_subscriptions(
        self, conn: WebSocketConnection, patterns: list[str]
    ) -> None:
        for unsub in conn._unsubscribe_fns:
            unsub()
        conn._unsubscribe_fns.clear()
        conn.patterns = patterns

        for pattern in patterns:
            unsub = self._bus.subscribe(
                callback=lambda event, c=conn: self._deliver(c, event),
                workspace_id=conn.workspace_id,
                event_pattern=pattern,
            )
            conn._unsubscribe_fns.append(unsub)

    # Event types that are addressed to one user rather than broadcast to the
    # workspace, mapped to the payload field naming that user. A payload missing
    # the field is NOT delivered — failing closed keeps a malformed event from
    # leaking one user's activity to every co-member's socket.
    _PER_USER_PAYLOAD_KEYS = {
        "notification.created": "recipient_user_id",
        "api_key.first_used": "user_id",
    }

    # Worker-to-worker plumbing that happens to live in the agent.* namespace,
    # which runners and admin observers legitimately subscribe to. These carry no
    # meaning for any client and must never reach the wire.
    _INTERNAL_EVENT_TYPES = frozenset({AGENT_RESTART_PROBE, AGENT_RESTART_ACK})

    @classmethod
    def _should_deliver(cls, conn: WebSocketConnection, event: Event) -> bool:
        """Per-user targeting for user-addressed events (contract §"WS event shape").

        A `notification.created` is published with the recipient's workspace_id,
        so without this filter it fans out to EVERY socket subscribed to that
        workspace+pattern. `api_key.first_used` has the same shape: it is
        published once per workspace its owner belongs to, and only that owner
        should see it. All other event types are workspace-broadcast and pass
        through unchanged (no regression to the existing card.*/activity.*
        fan-out)."""
        if event.event_type in cls._INTERNAL_EVENT_TYPES:
            return False
        payload_key = cls._PER_USER_PAYLOAD_KEYS.get(event.event_type)
        if payload_key is None:
            return True
        return event.payload.get(payload_key) == str(conn.user_id)

    async def _deliver(self, conn: WebSocketConnection, event: Event) -> None:
        if not self._should_deliver(conn, event):
            return
        try:
            await conn.websocket.send_json(
                {
                    "event": event.event_type,
                    "payload": event.payload,
                    "timestamp": event.timestamp.isoformat(),
                    "event_id": str(event.event_id),
                }
            )
        except Exception:
            logger.warning("Failed to deliver event to WebSocket, disconnecting")
            await self.disconnect(conn)

    async def shutdown(self) -> None:
        for conn in list(self._connections):
            try:
                await conn.websocket.close()
            except Exception:
                pass
            await self.disconnect(conn)

    @property
    def active_count(self) -> int:
        return len(self._connections)

    def get_connection_by_agent_id(
        self, agent_id: uuid.UUID
    ) -> WebSocketConnection | None:
        """Return the first active connection bound to the given agent_id, or None."""
        for conn in self._connections:
            if conn.agent_id == agent_id:
                return conn
        return None

    def listen_for_restart_probes(self) -> Callable[[], None]:
        """Answer restart probes for sockets this process holds. Returns unsubscribe.

        The probe is workspace-agnostic: the probing worker has no connection, so
        it cannot know the agent's workspace. Only the worker that actually holds
        the socket knows it, and it echoes it back on the ack so the caller can
        publish the operator-visible restart on the right workspace channel.
        """
        return self._bus.subscribe(
            callback=self._answer_restart_probe,
            workspace_id=None,
            event_pattern=AGENT_RESTART_PROBE,
        )

    async def _answer_restart_probe(self, event: Event) -> None:
        target = event.payload.get("target_agent_id")
        correlation_id = event.payload.get("correlation_id")
        if not target or not correlation_id:
            return
        try:
            agent_id = uuid.UUID(target)
        except (ValueError, TypeError):
            return

        conn = self.get_connection_by_agent_id(agent_id)
        if conn is None:
            # Silence is the negative answer: every worker would otherwise have
            # to be counted to distinguish "not here" from "nowhere", and the
            # caller's timeout already means exactly "nobody holds this socket".
            return

        await self._bus.publish(
            event_type=AGENT_RESTART_ACK,
            payload={
                "target_agent_id": target,
                "correlation_id": correlation_id,
                "workspace_id": str(conn.workspace_id),
            },
            workspace_id=conn.workspace_id,
        )


# Module-level singleton. Services publish/query here; routers read this
# same instance. Services must NOT import from routers (layer violation);
# putting the singleton next to its class keeps the layering honest.
connection_manager = ConnectionManager(event_bus)
