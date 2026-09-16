# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tier-1 in-process cache: TTL bound, bus-driven eviction, and the
single-instance gate (docs/caching-policy.md §Backend tiers)."""

import uuid

import pytest

from app.core.cache import TtlCache, WorkspaceSlugCache
from app.core.event_bus import Event, EventBus, PostgresEventBus


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def test_entry_hits_before_ttl_and_misses_after():
    clock = FakeClock()
    cache = TtlCache(ttl_seconds=30.0, clock=clock)

    cache.set("acme", "value")

    clock.advance(29.0)
    assert cache.get("acme") == "value"

    clock.advance(2.0)
    assert cache.get("acme") is None


def test_expired_entry_is_dropped_not_merely_hidden():
    """A stale entry can never outlive its TTL even if its eviction event was
    missed — expiry must reclaim the slot, not just fail the read."""
    clock = FakeClock()
    cache = TtlCache(ttl_seconds=30.0, clock=clock)

    cache.set("acme", "value")
    clock.advance(31.0)
    cache.get("acme")

    assert len(cache) == 0


def test_evict_matching_removes_only_selected_entries():
    clock = FakeClock()
    cache = TtlCache(ttl_seconds=30.0, clock=clock)
    doomed = uuid.uuid4()
    spared = uuid.uuid4()

    cache.set("acme", doomed)
    cache.set("globex", spared)

    cache.evict_matching(lambda _slug, value: value == doomed)

    assert cache.get("acme") is None
    assert cache.get("globex") == spared


class _StubTransport:
    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    async def listen(self, channel, callback) -> None: ...
    async def notify(self, channel, payload) -> None: ...


def _postgres_bus() -> PostgresEventBus:
    return PostgresEventBus(transport=_StubTransport())


def test_memory_bus_without_opt_in_is_pass_through():
    """An eviction fired on instance A never reaches instance B's memory bus,
    so an ungated cache would serve silently-stale cross-instance reads."""
    cache = WorkspaceSlugCache(bus=EventBus(), single_instance_opt_in=False)

    cache.remember("acme", uuid.uuid4())

    assert cache.enabled is False
    assert cache.lookup("acme") is None


def test_memory_bus_with_explicit_opt_in_caches():
    clock = FakeClock()
    cache = WorkspaceSlugCache(bus=EventBus(), single_instance_opt_in=True, clock=clock)
    workspace_id = uuid.uuid4()

    cache.remember("acme", workspace_id)

    assert cache.enabled is True
    assert cache.lookup("acme") == workspace_id


def test_postgres_bus_caches_without_opt_in():
    cache = WorkspaceSlugCache(bus=_postgres_bus(), single_instance_opt_in=False)
    workspace_id = uuid.uuid4()

    cache.remember("acme", workspace_id)

    assert cache.enabled is True
    assert cache.lookup("acme") == workspace_id


@pytest.mark.asyncio
async def test_workspace_updated_event_evicts_that_workspace_entry():
    bus = EventBus()
    cache = WorkspaceSlugCache(bus=bus, single_instance_opt_in=True)
    changed = uuid.uuid4()
    untouched = uuid.uuid4()
    cache.remember("acme", changed)
    cache.remember("globex", untouched)

    await bus.publish(
        event_type="activity.workspace.updated",
        payload={"entity_type": "workspace", "action": "updated"},
        workspace_id=changed,
    )

    assert cache.lookup("acme") is None
    assert cache.lookup("globex") == untouched


@pytest.mark.asyncio
async def test_workspace_created_event_evicts_stale_negative_free_entry():
    """A rename frees a slug for reuse: `created` must evict too, or the old
    slug keeps resolving to the workspace that no longer owns it."""
    bus = EventBus()
    cache = WorkspaceSlugCache(bus=bus, single_instance_opt_in=True)
    workspace_id = uuid.uuid4()
    cache.remember("acme", workspace_id)

    await bus.publish(
        event_type="activity.workspace.created",
        payload={"entity_type": "workspace", "action": "created"},
        workspace_id=workspace_id,
    )

    assert cache.lookup("acme") is None


@pytest.mark.asyncio
async def test_unrelated_activity_event_does_not_evict():
    bus = EventBus()
    cache = WorkspaceSlugCache(bus=bus, single_instance_opt_in=True)
    workspace_id = uuid.uuid4()
    cache.remember("acme", workspace_id)

    await bus.publish(
        event_type="activity.card.updated",
        payload={"entity_type": "card", "action": "updated"},
        workspace_id=workspace_id,
    )

    assert cache.lookup("acme") == workspace_id


@pytest.mark.asyncio
async def test_eviction_handler_never_raises_into_the_bus():
    bus = EventBus()
    cache = WorkspaceSlugCache(bus=bus, single_instance_opt_in=True)
    cache.remember("acme", uuid.uuid4())

    handler = cache._on_workspace_activity
    await handler(
        Event(event_type="activity.workspace.updated", workspace_id=None, payload={})
    )


def test_disabled_cache_subscribes_nothing():
    """No subscription while gated off — a pass-through cache must not leave a
    live handler mutating state nobody reads."""
    bus = EventBus()

    WorkspaceSlugCache(bus=bus, single_instance_opt_in=False)

    assert bus._subscribers == []
