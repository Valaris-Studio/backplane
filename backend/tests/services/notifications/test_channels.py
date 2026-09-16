# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Phase 1 — Channel / transport abstraction (unit tests, no DB).

RED-phase tests for docs/notification-system-contract.md
§"Channel / transport abstraction". v1 ships ONLY the abstraction + the in-app
channel; email/telegram drop in later as plugins. We pin:
  - NotificationChannel is an ABC (cannot be instantiated directly) exposing
    `key`, async `deliver(...)`, and `is_enabled_for(effective_prefs, category)`.
  - InAppChannel.key == "in_app".
  - CHANNEL_REGISTRY is a dict containing at least {"in_app": <InAppChannel>}.
  - is_enabled_for reads the resolved per-(category, channel) booleans the
    service hands it.

INTERFACE ASSUMPTION (documented per task brief — the heavy resolution is
Phase 2): the service passes an ALREADY-RESOLVED prefs object. The channel only
reads it, delegating to `effective_prefs.channel_enabled(category, self.key)`.
That keeps is_enabled_for dumb: the precedence (muted kill-switch ->
category_overrides[cat][channel] -> category default by relevance_scope) is the
Phase-2 resolver's job, not the channel's. We assert the delegation contract
with a tiny fake effective-prefs object; if the eventual signature differs the
test will fail loudly here (correct RED), flagging the contract mismatch.
"""

from __future__ import annotations

import inspect

import pytest

from app.services.notifications.channels import (
    CHANNEL_REGISTRY,
    InAppChannel,
    NotificationChannel,
)


class _FakeEffectivePrefs:
    """Stand-in for the Phase-2 resolved-prefs object. The channel must read it
    via `channel_enabled(category, channel_key)` and nothing else."""

    def __init__(self, table: dict[tuple[str, str], bool]):
        self._table = table
        self.calls: list[tuple[str, str]] = []

    def channel_enabled(self, category: str, channel_key: str) -> bool:
        self.calls.append((category, channel_key))
        return self._table.get((category, channel_key), False)


# --------------------------------------------------------------------------- #
# ABC shape
# --------------------------------------------------------------------------- #
def test_notification_channel_is_abstract():
    """The base class must not be instantiable — it's a pure interface."""
    assert inspect.isabstract(NotificationChannel)
    with pytest.raises(TypeError):
        NotificationChannel()


def test_notification_channel_declares_deliver_and_is_enabled_for():
    assert hasattr(NotificationChannel, "deliver")
    assert hasattr(NotificationChannel, "is_enabled_for")
    # deliver is async (it fires the live event_bus push in concrete channels)
    assert inspect.iscoroutinefunction(NotificationChannel.deliver)


# --------------------------------------------------------------------------- #
# InAppChannel
# --------------------------------------------------------------------------- #
def test_in_app_channel_key():
    assert InAppChannel().key == "in_app"


def test_in_app_channel_is_a_notification_channel():
    assert isinstance(InAppChannel(), NotificationChannel)


def test_in_app_channel_deliver_is_async():
    assert inspect.iscoroutinefunction(InAppChannel.deliver)


# --------------------------------------------------------------------------- #
# is_enabled_for — delegates to the resolved effective-prefs structure
# --------------------------------------------------------------------------- #
def test_is_enabled_for_returns_true_when_resolved_true():
    channel = InAppChannel()
    prefs = _FakeEffectivePrefs({("card_comment", "in_app"): True})
    assert channel.is_enabled_for(prefs, "card_comment") is True


def test_is_enabled_for_returns_false_when_resolved_false():
    channel = InAppChannel()
    prefs = _FakeEffectivePrefs({("card_comment", "in_app"): False})
    assert channel.is_enabled_for(prefs, "card_comment") is False


def test_is_enabled_for_returns_category_default_when_absent():
    """An absent (category, channel) entry resolves to the category default the
    service pre-computed — here modeled as the fake returning False for an
    unknown key. The channel must NOT invent its own truthy default."""
    channel = InAppChannel()
    prefs = _FakeEffectivePrefs({})  # nothing resolved for this category
    assert channel.is_enabled_for(prefs, "card_created") is False


def test_is_enabled_for_queries_its_own_channel_key():
    """The channel reads category_overrides[cat][self.key] — i.e. it asks the
    resolved prefs specifically for ITS key, never another channel's."""
    channel = InAppChannel()
    prefs = _FakeEffectivePrefs({("approval_requested", "in_app"): True})
    channel.is_enabled_for(prefs, "approval_requested")
    assert prefs.calls == [("approval_requested", "in_app")]


# --------------------------------------------------------------------------- #
# CHANNEL_REGISTRY
# --------------------------------------------------------------------------- #
def test_channel_registry_is_a_dict():
    assert isinstance(CHANNEL_REGISTRY, dict)


def test_channel_registry_contains_in_app():
    assert "in_app" in CHANNEL_REGISTRY
    assert isinstance(CHANNEL_REGISTRY["in_app"], InAppChannel)


def test_channel_registry_keyed_by_channel_key():
    """Every registry entry must be keyed by its own channel.key so the
    generator can iterate values() and the FE can render a column per key."""
    for key, channel in CHANNEL_REGISTRY.items():
        assert channel.key == key
        assert isinstance(channel, NotificationChannel)
