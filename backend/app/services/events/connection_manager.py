# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from fnmatch import fnmatch
from typing import Awaitable, Callable

from fastapi import WebSocket

from app.core.event_bus import Event, EventBus, event_bus
from app.core.events import AGENT_RESTART_ACK, AGENT_RESTART_PROBE
from app.models.workspace import WorkspaceRole
from app.services.events.authority import (
    CLOSE_CREDENTIAL,
    CLOSE_REASONS,
    CLOSE_TRY_AGAIN,
    DeliveryAuthority,
    DeliveryPrincipal,
    is_observer_event,
    read_delivery_authority,
    valid_receipt_payload,
)
from app.core.events import EXECUTION_CONTEXT_RECEIPT_CREATED

logger = logging.getLogger(__name__)


@dataclass
class WebSocketConnection:
    websocket: WebSocket
    workspace_id: uuid.UUID
    user_id: uuid.UUID
    agent_id: uuid.UUID | None = None
    # Last role observed by connect or a delivery authority read. Only used for
    # the typed subscription-admission feedback; delivery re-reads authority.
    # None fails closed for observer-grade patterns.
    workspace_role: WorkspaceRole | None = None
    # The authenticating API key by id (never the raw bearer); None for
    # cookie/IAP/dev principals, which have no key to revoke.
    api_key_id: uuid.UUID | None = None
    patterns: list[str] = field(default_factory=list)
    connected_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    _unsubscribe_fns: list[Callable] = field(default_factory=list, repr=False)
    _outbox: asyncio.Queue | None = field(default=None, repr=False)
    _sender: asyncio.Task | None = field(default=None, repr=False)
    # At most one backlog close per socket, however many publishes overflow.
    _closer: asyncio.Task | None = field(default=None, repr=False)

    @property
    def principal(self) -> DeliveryPrincipal:
        return DeliveryPrincipal(
            workspace_id=self.workspace_id,
            user_id=self.user_id,
            agent_id=self.agent_id,
            api_key_id=self.api_key_id,
        )


AuthorityReader = Callable[[DeliveryPrincipal], Awaitable[DeliveryAuthority]]

# Per-socket backlog bound. Each queued event is authorized with one short
# read, so a socket that falls this far behind (seconds of a busy workspace's
# events) is closed with 1013 "try again later" and reconnects to refetch,
# instead of growing memory without limit. Comfortably above a normal burst
# (one card move fans out to a handful of events).
OUTBOX_LIMIT = 1000
# A send or close that does not complete within these is treated as a stalled
# client: the socket is closed (retryable) and its resources released anyway.
SEND_TIMEOUT_SECONDS = 5
CLOSE_TIMEOUT_SECONDS = 2


class ConnectionManager:
    """Fans workspace events out to sockets without making publishers wait.

    Publishers often run inside a caller-owned request transaction. The bus
    callback therefore only matches patterns and enqueues; each socket's own
    sender task authorizes every event individually against current state (a
    short, process-bounded read whose session ends before the send) and sends
    in FIFO order. A publisher never waits on a socket or on an authority read.
    """

    def __init__(self, bus: EventBus, authority: AuthorityReader = read_delivery_authority):
        self._bus = bus
        self._authority = authority
        self._connections: list[WebSocketConnection] = []

    async def connect(
        self,
        websocket: WebSocket,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID,
        agent_id: uuid.UUID | None = None,
        workspace_role: WorkspaceRole | None = None,
        api_key_id: uuid.UUID | None = None,
    ) -> WebSocketConnection:
        conn = WebSocketConnection(
            websocket=websocket,
            workspace_id=workspace_id,
            user_id=user_id,
            agent_id=agent_id,
            workspace_role=workspace_role,
            api_key_id=api_key_id,
            _outbox=asyncio.Queue(maxsize=OUTBOX_LIMIT),
        )
        conn._sender = asyncio.create_task(self._send_loop(conn))
        self._connections.append(conn)
        return conn

    async def disconnect(self, conn: WebSocketConnection) -> None:
        for unsub in conn._unsubscribe_fns:
            unsub()
        conn._unsubscribe_fns.clear()
        if conn in self._connections:
            self._connections.remove(conn)
        sender = conn._sender
        if sender is not None and sender is not asyncio.current_task():
            sender.cancel()
            try:
                await sender
            except asyncio.CancelledError:
                pass
        self._discard_outbox(conn)

    @staticmethod
    def _discard_outbox(conn: WebSocketConnection) -> None:
        # Undelivered events of a closed socket are dropped, and marked done so
        # nothing waiting on the queue's join() is left hanging.
        outbox = conn._outbox
        while outbox is not None and not outbox.empty():
            outbox.get_nowait()
            outbox.task_done()

    async def update_subscriptions(
        self, conn: WebSocketConnection, patterns: list[str]
    ) -> None:
        for unsub in conn._unsubscribe_fns:
            unsub()
        conn._unsubscribe_fns.clear()
        conn.patterns = patterns
        if not patterns:
            return
        # One registration per socket, however many patterns overlap: an event
        # is matched, authorized and sent at most once.
        unsub = self._bus.subscribe(
            callback=lambda event, c=conn: self._enqueue(c, event),
            workspace_id=conn.workspace_id,
            event_pattern="*",
        )
        conn._unsubscribe_fns.append(unsub)

    # Event types that are addressed to one user rather than broadcast to the
    # workspace, mapped to the payload field naming that user. A payload missing
    # the field is NOT delivered — failing closed keeps a malformed event from
    # leaking one user's activity to every co-member's socket.
    _PER_USER_PAYLOAD_KEYS = {
        "notification.created": "recipient_user_id",
        "api_key.first_used": "user_id",
        # Captured sessions and devices are private to their owner.
        "agent_session.updated": "owner_id",
        "companion_installation.updated": "owner_id",
    }

    _HUMAN_ONLY_EVENT_TYPES = frozenset(
        {"agent_session.updated", "companion_installation.updated"}
    )

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
        # An agent key resolves to its creator but must never see that
        # person's private sessions or devices.
        if event.event_type in cls._HUMAN_ONLY_EVENT_TYPES and getattr(
            conn, "agent_id", None
        ):
            return False
        return event.payload.get(payload_key) == str(conn.user_id)

    @staticmethod
    def _authorized_for(
        conn: WebSocketConnection, event: Event, authority: DeliveryAuthority
    ) -> bool:
        # Classified by the event actually delivered, never by the pattern
        # that matched it, so a glob spelling cannot widen access.
        if event.event_type == EXECUTION_CONTEXT_RECEIPT_CREATED:
            return valid_receipt_payload(event.payload, conn.workspace_id)
        if is_observer_event(event.event_type):
            return authority.observer
        return True

    async def refresh_authority(self, conn: WebSocketConnection) -> bool:
        """Re-read the socket's current authority (e.g. before subscription
        admission) and record its current role. A revoked or unreadable
        principal is closed opaquely and False is returned. The read's session
        is closed before anything is sent."""
        authority = await self._read_authority(conn)
        if authority.close_code is not None:
            await self._close(conn, authority.close_code, CLOSE_REASONS[authority.close_code])
            return False
        conn.workspace_role = authority.role
        return True

    async def _read_authority(self, conn: WebSocketConnection) -> DeliveryAuthority:
        try:
            return await self._authority(conn.principal)
        except Exception:
            logger.exception("WS authority read failed; closing the socket")
            return DeliveryAuthority(close_code=CLOSE_CREDENTIAL)

    @staticmethod
    def _matches(conn: WebSocketConnection, event: Event) -> bool:
        return any(fnmatch(event.event_type, pattern) for pattern in conn.patterns)

    async def _enqueue(self, conn: WebSocketConnection, event: Event) -> None:
        if conn._outbox is None or conn._closer is not None or not self._matches(conn, event):
            return
        try:
            conn._outbox.put_nowait(event)
        except asyncio.QueueFull:
            logger.warning("WebSocket outbox full; closing user=%s", conn.user_id)
            conn._closer = asyncio.create_task(
                self._close(conn, CLOSE_TRY_AGAIN, CLOSE_REASONS[CLOSE_TRY_AGAIN])
            )

    async def _send_loop(self, conn: WebSocketConnection) -> None:
        outbox = conn._outbox
        while True:
            event = await outbox.get()
            try:
                delivering = await self._send_one(conn, event)
            finally:
                outbox.task_done()
            if not delivering:
                self._discard_outbox(conn)
                return

    async def _send_one(self, conn: WebSocketConnection, event: Event) -> bool:
        """Authorize this one event against current state, then send it if
        admitted. False when the socket was closed and the loop must stop."""
        # Payload-only filters first: they need no database read. Patterns are
        # re-checked so an unsubscribe also covers events already queued.
        if (
            not self._matches(conn, event)
            or not self._should_deliver(conn, event)
            or (
                event.event_type == EXECUTION_CONTEXT_RECEIPT_CREATED
                and not valid_receipt_payload(event.payload, conn.workspace_id)
            )
        ):
            return True
        # The read's session is closed when this returns: nothing is held
        # across the socket send, and nothing is reused for the next event.
        authority = await self._read_authority(conn)
        if authority.close_code is not None:
            await self._close(conn, authority.close_code, CLOSE_REASONS[authority.close_code])
            return False
        conn.workspace_role = authority.role
        if not self._authorized_for(conn, event, authority):
            return True
        try:
            async with asyncio.timeout(SEND_TIMEOUT_SECONDS):
                await conn.websocket.send_json(
                    {
                        "event": event.event_type,
                        "payload": event.payload,
                        "timestamp": event.timestamp.isoformat(),
                        "event_id": str(event.event_id),
                    }
                )
        except TimeoutError:
            logger.warning("WebSocket send stalled; closing user=%s (retryable)", conn.user_id)
            await self._close(conn, CLOSE_TRY_AGAIN, CLOSE_REASONS[CLOSE_TRY_AGAIN])
            return False
        except Exception:
            logger.warning("Failed to deliver event to WebSocket, disconnecting")
            await self.disconnect(conn)
            return False
        return True

    async def _close(self, conn: WebSocketConnection, code: int, reason: str) -> None:
        await self._close_socket(conn.websocket, code=code, reason=reason)
        await self.disconnect(conn)

    @staticmethod
    async def _close_socket(websocket: WebSocket, **close_args) -> None:
        # Bounded: a client that never acknowledges must not keep the
        # disconnect cleanup (sender, outbox, bus subscription) from running.
        try:
            async with asyncio.timeout(CLOSE_TIMEOUT_SECONDS):
                await websocket.close(**close_args)
        except Exception:
            pass

    async def shutdown(self) -> None:
        # Closed concurrently, each bounded by CLOSE_TIMEOUT_SECONDS, so N
        # stalled clients do not add up to N times the close deadline.
        connections = list(self._connections)
        await asyncio.gather(*(self._close_socket(c.websocket) for c in connections))
        for conn in connections:
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
