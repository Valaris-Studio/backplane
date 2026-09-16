# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import asyncio
import json
import logging
import os
import random
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from fnmatch import fnmatch
from typing import Awaitable, Callable, Protocol

logger = logging.getLogger(__name__)

# Postgres caps a NOTIFY payload at ~8000 bytes (8KB incl. overhead). Stay
# safely under it; oversized envelopes fall back to a thin form (plan §6.3).
_NOTIFY_PAYLOAD_LIMIT = 7900

# Entity-id (and activity-key) fields worth preserving in a thin notification so
# a receiving instance can refetch and, crucially, so consumers that FILTER on
# these fields still see them: a frontend per-card filter (entity_id/card_id),
# the Go runner's self-suppression (actor_id/agent_id/target_agent_id), and
# activity fan-out patterns (entity_type/action). Dropping any of these from the
# thin form silently no-ops the consumer. Order-independent allow-list.
_THIN_ID_KEYS = (
    "card_id",
    "board_id",
    "column_id",
    "workspace_id",
    "note_id",
    "resource_id",
    "agent_id",
    "execution_id",
    "approval_id",
    "team_id",
    "channel_id",
    "recipient_user_id",
    # merge_queue.stale can carry an unbounded error_message, so it is the
    # family member most likely to hit the thin fallback -- and the entry id is
    # what an operator needs to act on the wedged row.
    "entry_id",
    # api_key.first_used is filtered per-user on this field; dropping it would
    # make the thin form undeliverable rather than merely thin.
    "user_id",
    "entity_id",
    "actor_id",
    "target_agent_id",
    "entity_type",
    "action",
    "id",
)


def _event_log_enabled() -> bool:
    # Read on every publish so the flag can be toggled without restart during debug sessions.
    # Dev-only: when enabled, full event payloads (card titles, note bodies, resource metadata,
    # user emails) land in stdout logs. Never enable in prod.
    return os.environ.get("VALARIS_EVENT_LOG", "").lower() in ("1", "true", "yes")


@dataclass(frozen=True)
class Event:
    event_type: str
    workspace_id: uuid.UUID
    payload: dict
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    event_id: uuid.UUID = field(default_factory=uuid.uuid4)
    # True when reconstructed from another instance's NOTIFY. Origin-only
    # subscribers (external webhook delivery) skip these -- the originating
    # process already delivered them; only WS fan-out wants the cross-instance
    # copy. Default False keeps every existing constructor unchanged.
    remote: bool = False


Subscriber = Callable[[Event], Awaitable[None]]


class EventBus:
    def __init__(self):
        self._subscribers: list[tuple[uuid.UUID | None, str, Subscriber]] = []

    async def publish(self, event_type: str, payload: dict, workspace_id: uuid.UUID) -> None:
        """Publish event to all matching subscribers. Fire-and-forget -- errors logged, never propagated."""
        event = Event(event_type=event_type, workspace_id=workspace_id, payload=payload)
        if _event_log_enabled():
            logger.info(
                "event_bus",
                extra={
                    "event": {
                        "event_id": str(event.event_id),
                        "event_type": event.event_type,
                        "workspace_id": str(event.workspace_id),
                        "payload": event.payload,
                        "timestamp": event.timestamp.isoformat(),
                    }
                },
            )
        await self._dispatch_local(event)

    async def _dispatch_local(self, event: Event) -> None:
        """Deliver a fully-formed event to local in-process subscribers only.

        This is the local fan-out (workspace filter + fnmatch + gather). Cross-
        instance backends (PostgresEventBus) call this directly when re-injecting
        an event received over the wire, so a remote event is delivered locally
        WITHOUT being re-broadcast -- the echo-suppression seam (plan §6.1)."""
        tasks = []
        for ws_id, pattern, callback in self._subscribers:
            if ws_id is not None and ws_id != event.workspace_id:
                continue
            if not fnmatch(event.event_type, pattern):
                continue
            tasks.append(callback(event))
        if tasks:
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for result in results:
                if isinstance(result, Exception):
                    logger.error("EventBus subscriber error: %s", result)

    def subscribe(
        self,
        callback: Subscriber,
        workspace_id: uuid.UUID | None = None,
        event_pattern: str = "*",
    ) -> Callable[[], None]:
        """Subscribe to events. Returns unsubscribe callable."""
        entry = (workspace_id, event_pattern, callback)
        self._subscribers.append(entry)

        def unsubscribe():
            try:
                self._subscribers.remove(entry)
            except ValueError:
                pass

        return unsubscribe


class NotifyTransport(Protocol):
    """The cross-instance wire under PostgresEventBus. A real implementation
    wraps an asyncpg LISTEN/NOTIFY connection; tests inject an in-memory fake."""

    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    async def listen(self, channel: str, callback: Callable[[str], Awaitable[None]]) -> None: ...
    async def notify(self, channel: str, payload: str) -> None: ...


def _thin_payload(payload: dict) -> dict:
    """Shrink a payload to just the entity ids a receiver needs to refetch.

    Marked with `_thin` so subscribers (and the frontend reconciler) treat it as
    a 'something changed, go refetch' signal rather than a full snapshot."""
    thin = {k: payload[k] for k in _THIN_ID_KEYS if k in payload}
    thin["_thin"] = True
    return thin


class PostgresEventBus(EventBus):
    """Cross-instance EventBus over Postgres LISTEN/NOTIFY.

    Reuses the inherited local fan-out unchanged (`_dispatch_local`). `publish`
    delivers to local subscribers AND broadcasts to other instances via NOTIFY;
    a long-lived LISTEN connection re-injects remote events into local fan-out
    only (never re-NOTIFYing -- no echo loop). Adds nothing to the WS layer or
    to any of the existing event_bus consumers' call sites (plan §4)."""

    def __init__(
        self,
        *,
        transport: NotifyTransport,
        channel: str = "valaris_events",
        origin_id: str | None = None,
    ):
        super().__init__()
        self._transport = transport
        self._channel = channel
        # Per-instance origin: a NOTIFY tagged with it is one WE sent, so its
        # echo through our own LISTEN is skipped (already delivered locally).
        # Distinct per instance so two buses in one process (tests, or a future
        # multi-bus setup) never suppress each OTHER's events (plan §6.1).
        self._origin_id = origin_id or str(uuid.uuid4())

    @property
    def listener_connected(self) -> bool:
        """LISTEN liveness for the /health probe. False while the supervisor is
        reconnecting; the memory bus has no such property (returns None there)."""
        return getattr(self._transport, "is_connected", False)

    async def start(self) -> None:
        await self._transport.start()
        await self._transport.listen(self._channel, self._on_notification)

    async def stop(self) -> None:
        await self._transport.stop()

    async def publish(self, event_type: str, payload: dict, workspace_id: uuid.UUID) -> None:
        event = Event(event_type=event_type, workspace_id=workspace_id, payload=payload)
        if _event_log_enabled():
            logger.info(
                "event_bus",
                extra={
                    "event": {
                        "event_id": str(event.event_id),
                        "event_type": event.event_type,
                        "workspace_id": str(event.workspace_id),
                        "payload": event.payload,
                        "timestamp": event.timestamp.isoformat(),
                    }
                },
            )
        await self._dispatch_local(event)
        await self._notify(event)

    async def _notify(self, event: Event) -> None:
        # Encoding is INSIDE the try: a payload carrying a non-serializable value
        # must never raise into the caller (publish is fire-and-forget). Both the
        # json.dumps and the transport NOTIFY only affect cross-instance liveness.
        try:
            wire = self._encode(event, thin=False)
            if len(wire) > _NOTIFY_PAYLOAD_LIMIT:
                # Snapshot fields (after_state/before_state) blew the NOTIFY cap;
                # send a thin form and let the other instance refetch (plan §6.3).
                wire = self._encode(event, thin=True)
            await self._transport.notify(self._channel, wire)
        except Exception:
            # A failed NOTIFY only costs cross-instance liveness; local delivery
            # already happened and clients refetch. Never propagate to callers.
            logger.exception("PostgresEventBus NOTIFY failed")

    def _encode(self, event: Event, *, thin: bool) -> str:
        payload = _thin_payload(event.payload) if thin else event.payload
        # default=str: entity-id UUIDs / datetimes in payloads serialize instead
        # of raising -- the receiver refetches by id anyway, so a str id is enough.
        return json.dumps(
            {
                "event_type": event.event_type,
                "workspace_id": str(event.workspace_id),
                "payload": payload,
                "timestamp": event.timestamp.isoformat(),
                "event_id": str(event.event_id),
                "origin_id": self._origin_id,
                "thin": thin,
            },
            default=str,
        )

    async def _on_notification(self, raw: str) -> None:
        try:
            data = json.loads(raw)
            origin = data.get("origin_id")
            if origin == self._origin_id:
                return  # our own NOTIFY echoing back; already delivered locally
            event = Event(
                event_type=data["event_type"],
                workspace_id=uuid.UUID(data["workspace_id"]),
                payload=data["payload"],
                timestamp=datetime.fromisoformat(data["timestamp"]),
                event_id=uuid.UUID(data["event_id"]),
                remote=True,
            )
        except (ValueError, KeyError, TypeError):
            # Malformed NOTIFY (decode/shape error) must never stop the listener.
            logger.warning("PostgresEventBus dropped malformed notification")
            return
        # LOCAL fan-out only -- re-publishing here would re-NOTIFY and loop (§6.1).
        await self._dispatch_local(event)


# _supervise backoff: fast first retry (loss-window minimization) growing to a
# cap so a long DB outage neither hammers connect nor spams logs.
_SUPERVISE_BACKOFF_CAP_SECONDS = 30.0
# Bound the receiver-side notification queue: at-most-once is the documented
# contract, so a burst past this cap drops rather than growing memory unbounded.
_NOTIFY_QUEUE_MAXSIZE = 1000


class AsyncpgNotifyTransport:
    """Real LISTEN/NOTIFY over dedicated long-lived asyncpg connections.

    Two SEPARATE connections by design: a LISTEN connection that receives
    cross-instance notifications, and a NOTIFY connection that emits them. They
    must stay independent so a wedged LISTEN socket never blocks emits (plan
    §6.2). The LISTEN connection outlives requests and auto-reconnects on a
    supervisor task; a silently dropped one would otherwise stop ALL
    cross-instance delivery with no error surfaced.

    asyncpg delivers notifications on its own reader task (a sync callback); we
    hand them to a bounded queue drained FIFO by one long-lived consumer, so
    ordering, strong task references, and bounded concurrency are all preserved."""

    def __init__(
        self,
        dsn: str,
        *,
        reconnect_backoff_seconds: float = 1.0,
        max_pending_notifications: int = _NOTIFY_QUEUE_MAXSIZE,
    ):
        # SQLAlchemy DSNs carry a `+asyncpg` dialect tag that raw asyncpg rejects.
        self._dsn = dsn.replace("postgresql+asyncpg://", "postgresql://").replace(
            "postgres+asyncpg://", "postgresql://"
        )
        self._backoff = reconnect_backoff_seconds
        self._conn = None
        self._channel: str | None = None
        self._callback: Callable[[str], Awaitable[None]] | None = None
        self._reconnect_task: asyncio.Task | None = None
        self._closed = False

        # NOTIFY side: one persistent connection guarded by a lock (asyncpg
        # connections are not safe for concurrent use), lazily opened.
        self._notify_conn = None
        self._notify_lock = asyncio.Lock()

        # LISTEN receive side: bounded queue + single consumer (see class docstring).
        self._queue: asyncio.Queue[str] = asyncio.Queue(maxsize=max_pending_notifications)
        self._consumer_task: asyncio.Task | None = None

        # State-change logging for the supervisor: only log when liveness flips,
        # not once per retry tick while the DB is down.
        self._was_connected = True
        # Injectable clock so backoff tests stay instant.
        self._sleep = asyncio.sleep

    @property
    def is_connected(self) -> bool:
        return self._conn is not None and not self._conn.is_closed()

    async def start(self) -> None:
        self._closed = False

    async def stop(self) -> None:
        self._closed = True
        if self._reconnect_task is not None:
            self._reconnect_task.cancel()
        if self._consumer_task is not None:
            self._consumer_task.cancel()
            self._consumer_task = None
        for conn in (self._conn, self._notify_conn):
            if conn is not None:
                try:
                    await conn.close()
                except Exception:
                    pass
        self._conn = None
        self._notify_conn = None

    async def listen(self, channel: str, callback: Callable[[str], Awaitable[None]]) -> None:
        if self._reconnect_task is not None:
            # listen() is once-per-transport; a second call would leak the prior
            # supervisor task and LISTEN connection. Reconnects go through
            # _supervise, never through here.
            raise RuntimeError("AsyncpgNotifyTransport.listen() already active")
        self._channel = channel
        self._callback = callback
        if self._consumer_task is None:
            self._consumer_task = asyncio.create_task(self._drain_queue())
        try:
            await self._connect_and_listen()
        except Exception:
            # The initial connect may fail (DB not up yet). The supervisor is
            # created unconditionally below and performs the connect on a later
            # tick -- a first-connect failure must not leave us permanently
            # degraded with no reconnect loop running (plan §6.2).
            logger.error("PostgresEventBus initial LISTEN connect failed; supervisor will retry")
            self._was_connected = False
        self._reconnect_task = asyncio.create_task(self._supervise())

    async def notify(self, channel: str, payload: str) -> None:
        # One persistent NOTIFY connection reused across emits (never a fresh
        # connect per event -- that is unbounded churn against a small pool and
        # caused a prod connection-exhaustion outage). Serialized by a lock;
        # reconnect once on a dropped connection, then swallow (a failed NOTIFY
        # only costs cross-instance liveness -- never propagate to callers).
        async with self._notify_lock:
            for attempt in range(2):
                try:
                    conn = await self._ensure_notify_conn()
                    await conn.execute("SELECT pg_notify($1, $2)", channel, payload)
                    return
                except Exception:
                    # Drop the (possibly dead) connection so the retry reconnects.
                    await self._close_notify_conn()
                    if attempt == 1:
                        logger.exception("PostgresEventBus NOTIFY failed after reconnect")

    async def _ensure_notify_conn(self):
        import asyncpg

        if self._notify_conn is None or self._notify_conn.is_closed():
            self._notify_conn = await asyncpg.connect(self._dsn)
        return self._notify_conn

    async def _close_notify_conn(self) -> None:
        if self._notify_conn is not None:
            try:
                await self._notify_conn.close()
            except Exception:
                pass
            self._notify_conn = None

    async def _connect_and_listen(self) -> None:
        import asyncpg

        self._conn = await asyncpg.connect(self._dsn)
        await self._conn.add_listener(self._channel, self._on_pg_notify)

    def _on_pg_notify(self, _conn, _pid, _channel, payload):
        # asyncpg calls this SYNCHRONOUSLY from its reader task. Enqueue without
        # blocking (the reader must never stall); a full queue drops the incoming
        # notification (at-most-once contract) rather than growing unbounded.
        try:
            self._queue.put_nowait(payload)
        except asyncio.QueueFull:
            logger.warning("PostgresEventBus notification queue full; dropping notification")

    async def _drain_queue(self) -> None:
        """Single consumer draining the notify queue FIFO. Awaiting the callback
        here (rather than create_task per notification) restores per-connection
        ordering and keeps a strong reference so events aren't GC'd mid-flight."""
        while True:
            payload = await self._queue.get()
            try:
                if self._callback is not None:
                    await self._callback(payload)
            except Exception:
                logger.exception("PostgresEventBus notification handler failed")
            finally:
                self._queue.task_done()

    async def _supervise(self) -> None:
        """Keep the LISTEN connection alive; reconnect with growing backoff.

        Fast first retry, then exponential backoff to a 30s cap with jitter so a
        long outage neither hammers connect nor spams logs. Logs only on state
        change (down at ERROR once, recovery at INFO once)."""
        backoff = self._backoff
        while not self._closed:
            await self._sleep(backoff)
            if self.is_connected:
                backoff = self._backoff  # healthy: keep the fast-retry base ready
                continue
            try:
                await self._connect_and_listen()
                backoff = self._backoff
                if not self._was_connected:
                    logger.info("PostgresEventBus LISTEN connection re-established")
                self._was_connected = True
            except Exception:
                if self._was_connected:
                    logger.error("PostgresEventBus LISTEN connection lost; reconnecting")
                self._was_connected = False
                # Exponential growth to the cap, plus jitter to de-synchronize a
                # fleet all reconnecting after the same DB blip.
                backoff = min(backoff * 2, _SUPERVISE_BACKOFF_CAP_SECONDS)
                backoff += random.uniform(0, backoff * 0.1)


def _make_event_bus() -> EventBus:
    """Select the EventBus backend from EVENT_BUS_BACKEND (default `memory`).

    `memory` is the zero-config, single-instance default -- identical to the
    historical behaviour. `postgres` fans events across Cloud Run instances via
    LISTEN/NOTIFY using the database we already require (no new dependency).
    `redis` is reserved for a future scale-tier adapter (plan §8 follow-up)."""
    backend = os.environ.get("EVENT_BUS_BACKEND", "memory").strip().lower()
    if backend == "postgres":
        from app.config import settings

        return PostgresEventBus(
            transport=AsyncpgNotifyTransport(settings.DATABASE_URL),
            channel="valaris_events",
        )
    if backend == "redis":
        raise NotImplementedError(
            "EVENT_BUS_BACKEND=redis is not implemented yet; use 'memory' (default) "
            "or 'postgres'. The redis scale-tier adapter is a tracked follow-up."
        )
    return EventBus()


async def start_event_bus(bus: EventBus) -> None:
    """Open a cross-instance backend's transport on app startup. No-op for the
    memory default (no start()). A failed connect must not abort startup -- the
    supervisor reconnects and local delivery is unaffected (plan §6.2)."""
    start = getattr(bus, "start", None)
    if start is None:
        return
    try:
        await start()
    except Exception:
        logger.exception("event bus start failed; cross-instance delivery degraded")


async def stop_event_bus(bus: EventBus) -> None:
    """Close a cross-instance backend's transport on app shutdown. No-op for memory."""
    stop = getattr(bus, "stop", None)
    if stop is None:
        return
    try:
        await stop()
    except Exception:
        logger.exception("event bus stop failed")


def event_bus_health() -> dict:
    """Cheap, never-raising health view of the module singleton for /health.

    `backend` is the selected adapter name; `listener_connected` is the postgres
    LISTEN liveness (None for the memory bus, which has no cross-instance link)."""
    try:
        backend = "postgres" if isinstance(event_bus, PostgresEventBus) else "memory"
        return {
            "backend": backend,
            "listener_connected": getattr(event_bus, "listener_connected", None),
        }
    except Exception:
        # A health probe must never fail on the observability read itself.
        return {"backend": "unknown", "listener_connected": None}


# Module-level singleton. Backend selected by EVENT_BUS_BACKEND; defaults to the
# in-memory bus so every existing consumer and the ConnectionManager singleton
# keep working unchanged.
event_bus = _make_event_bus()
