# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tier-1 in-process caches: short TTL plus EventBus-driven eviction.

The tier and its rules live in `docs/caching-policy.md`. Two of them shape this
module and are not obvious from the code alone:

1. **A cache must name its eviction event before it exists.** Every cache here
   subscribes to the bus event that invalidates it; TTL is the backstop for a
   missed event, never the freshness mechanism.
2. **Cross-instance correctness is gated on the bus backend.** Under the default
   `memory` bus an eviction fired on instance A never reaches instance B, so a
   cache would serve silently-stale reads on every other instance. Under
   `EVENT_BUS_BACKEND=postgres` the same subscriber becomes cross-instance-correct
   via LISTEN/NOTIFY. So: postgres bus, or an explicit single-instance opt-in, or
   the cache is pass-through.

Nothing on the DO-NOT-CACHE list may be cached here — notably membership and
role checks, which stay on the database because a stale role is a security
boundary violation.
"""

import logging
import time
import uuid
from typing import Callable, Generic, Hashable, TypeVar

from app.core.event_bus import EventBus, PostgresEventBus, event_bus

logger = logging.getLogger(__name__)

K = TypeVar("K", bound=Hashable)
V = TypeVar("V")

WORKSPACE_SLUG_TTL_SECONDS = 45.0

# Both workspace mutations evict: `updated` covers a rename (the old slug must
# stop resolving) and `created` covers a slug freed by a rename being taken by a
# new workspace. There is no activity.workspace.deleted event — a delete is
# caught by TTL expiry plus the id-load miss at the call site.
WORKSPACE_ACTIVITY_PATTERN = "activity.workspace.*"


class TtlCache(Generic[K, V]):
    """Dict with a per-entry deadline. Not thread-safe by design: the backend is
    single-threaded asyncio, and a lock here would cost more than it protects."""

    def __init__(self, ttl_seconds: float, clock: Callable[[], float] = time.monotonic):
        self._ttl = ttl_seconds
        self._clock = clock
        self._entries: dict[K, tuple[float, V]] = {}

    def __len__(self) -> int:
        return len(self._entries)

    def get(self, key: K) -> V | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        expires_at, value = entry
        if self._clock() >= expires_at:
            # Drop rather than merely report a miss: an expired entry that stays
            # resident is a leak in a cache keyed by user-supplied slugs.
            del self._entries[key]
            return None
        return value

    def set(self, key: K, value: V) -> None:
        self._entries[key] = (self._clock() + self._ttl, value)

    def evict_matching(self, predicate: Callable[[K, V], bool]) -> None:
        for key in [k for k, (_, v) in self._entries.items() if predicate(k, v)]:
            del self._entries[key]

    def clear(self) -> None:
        self._entries.clear()


def _bus_is_cross_instance(bus: EventBus) -> bool:
    return isinstance(bus, PostgresEventBus)


class WorkspaceSlugCache:
    """slug → workspace id, evicted by `activity.workspace.*`.

    Caches the id and not the ORM instance: a `Workspace` loaded in one request's
    session is detached once that session closes, so handing it to a later
    request would be a use-after-free with extra steps. The id is a plain value,
    and re-loading by primary key is an indexed point lookup — the query this
    spares is the slug resolution on every workspace-scoped endpoint.
    """

    def __init__(
        self,
        bus: EventBus | None = None,
        single_instance_opt_in: bool = False,
        ttl_seconds: float = WORKSPACE_SLUG_TTL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._bus = bus if bus is not None else event_bus
        self.enabled = _bus_is_cross_instance(self._bus) or single_instance_opt_in
        self._entries: TtlCache[str, uuid.UUID] = TtlCache(ttl_seconds, clock=clock)
        self._unsubscribe: Callable[[], None] | None = None
        if self.enabled:
            self._unsubscribe = self._bus.subscribe(
                self._on_workspace_activity,
                event_pattern=WORKSPACE_ACTIVITY_PATTERN,
            )

    def lookup(self, slug: str) -> uuid.UUID | None:
        if not self.enabled:
            return None
        return self._entries.get(slug)

    def remember(self, slug: str, workspace_id: uuid.UUID) -> None:
        if not self.enabled:
            return
        self._entries.set(slug, workspace_id)

    def forget(self, slug: str) -> None:
        self._entries.evict_matching(lambda cached_slug, _id: cached_slug == slug)

    async def _on_workspace_activity(self, event) -> None:
        # Evicts by id, not by slug: a rename changes the slug, so the event's
        # workspace_id is the only field that still identifies the stale entry.
        try:
            self._entries.evict_matching(
                lambda _slug, cached_id: cached_id == event.workspace_id
            )
        except Exception:
            # Bus subscribers are fire-and-forget; a raise here would surface as
            # an error log per publish and evict nothing anyway.
            logger.exception("workspace slug cache eviction failed")


def _single_instance_opt_in() -> bool:
    from app.config import settings

    return settings.CACHE_SINGLE_INSTANCE


workspace_slug_cache = WorkspaceSlugCache(
    single_instance_opt_in=_single_instance_opt_in()
)
