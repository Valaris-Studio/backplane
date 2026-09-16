# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Phase 2 (RED) — PreferenceResolver unit tests.

Pins the effective-prefs resolution the contract describes in
docs/notification-system-contract.md §"Category taxonomy",
§"Relevance filter" and §"Table notification_preferences":

    effective = muted-kill-switch
                -> category_overrides[cat][channel]
                -> CATEGORY_DEFAULTS[cat] keyed by relevance_scope

The resolver is a pure function over a NotificationPreference row (or None) +
the category + channel + relevance_scope. No DB needed: we hand it a tiny
stand-in prefs object (the resolver must only read .relevance_scope,
.category_overrides, .muted — the same attribute surface the real model
exposes) or None for "new user, all defaults".

INTERFACE ASSUMPTION (documented per the task brief): Phase 2 ships
`app/services/notifications/preferences.py` exposing
  - CATEGORY_DEFAULTS: the (relevant-to-me / workspace-wide) default table,
  - a resolver — either a `PreferenceResolver` class or a
    `resolve_effective_prefs(prefs_row_or_none, *, relevance_scope=None)`
    function returning an object with `.channel_enabled(category, channel_key)`.
We accept EITHER shape (class or function) and skip nothing — if neither
exists the import fails and the whole module is RED, which is the correct
"missing implementation" signal.

DOCUMENTED ASSUMPTIONS for the contract's under-specified corners:
  - relevance_scope default is "watching" (per the model server_default).
  - an UNKNOWN category resolves OFF (fail-closed: never invent noise for a
    category the backend doesn't recognize).
  - the only channel in v1 is "in_app".
"""

from __future__ import annotations

import pytest

# Importing the Phase-2 module is itself part of the RED proof: until
# preferences.py exists this collection-time import errors and every test
# below is reported as failing for the right reason (missing implementation).
from app.services.notifications import preferences as prefs_mod


CHANNEL = "in_app"


class _FakePrefsRow:
    """Stand-in for a NotificationPreference row — only the three columns the
    resolver is allowed to read."""

    def __init__(
        self,
        *,
        relevance_scope: str = "watching",
        category_overrides: dict | None = None,
        muted: bool = False,
    ):
        self.relevance_scope = relevance_scope
        self.category_overrides = category_overrides or {}
        self.muted = muted


def _resolve(row, *, relevance_scope: str | None = None):
    """Call the resolver regardless of whether Phase 2 shipped it as a class
    (`PreferenceResolver`) or a module-level function
    (`resolve_effective_prefs`). Returns the effective-prefs object exposing
    `.channel_enabled(category, channel_key)`."""
    if hasattr(prefs_mod, "PreferenceResolver"):
        resolver = prefs_mod.PreferenceResolver()
        # The resolver may accept relevance_scope as an explicit override (for
        # a None row) or derive it from the row. Try the richer signature first.
        try:
            return resolver.resolve(row, relevance_scope=relevance_scope)
        except TypeError:
            return resolver.resolve(row)
    func = prefs_mod.resolve_effective_prefs
    try:
        return func(row, relevance_scope=relevance_scope)
    except TypeError:
        return func(row)


def _enabled(eff, category: str) -> bool:
    return eff.channel_enabled(category, CHANNEL)


# --------------------------------------------------------------------------- #
# CATEGORY_DEFAULTS table is exported and matches the contract
# --------------------------------------------------------------------------- #
def test_category_defaults_table_exists():
    assert hasattr(prefs_mod, "CATEGORY_DEFAULTS")
    assert isinstance(prefs_mod.CATEGORY_DEFAULTS, dict)


def test_category_defaults_cover_the_v1_taxonomy():
    """Every non-deferred v1 category from the contract table is present."""
    expected = {
        "mention",
        "card_assigned",
        "card_participant_changed",
        "card_comment",
        "dependency_blocking",
        "approval_requested",
        "approval_decided",
        "card_created",
        "workspace_member",
        "resource_note_shared",
    }
    assert expected.issubset(set(prefs_mod.CATEGORY_DEFAULTS.keys()))


# --------------------------------------------------------------------------- #
# A. defaults — no prefs row, relevance_scope = watching (the new-user state)
# --------------------------------------------------------------------------- #
def test_resolve_no_row_watching_card_assigned_on():
    eff = _resolve(None, relevance_scope="watching")
    assert _enabled(eff, "card_assigned") is True


def test_resolve_no_row_watching_card_created_off():
    eff = _resolve(None, relevance_scope="watching")
    assert _enabled(eff, "card_created") is False


def test_resolve_no_row_watching_approval_requested_on():
    eff = _resolve(None, relevance_scope="watching")
    assert _enabled(eff, "approval_requested") is True


def test_resolve_no_row_watching_participant_changed_on():
    """card_participant_changed = the core 'card I follow changed' — ON under
    the watching (relevant-to-me) default."""
    eff = _resolve(None, relevance_scope="watching")
    assert _enabled(eff, "card_participant_changed") is True


def test_resolve_no_row_defaults_to_watching_scope():
    """A None row with no explicit scope must behave as 'watching' (the model
    server_default) — participant_changed ON, card_created OFF."""
    eff = _resolve(None)
    assert _enabled(eff, "card_participant_changed") is True
    assert _enabled(eff, "card_created") is False


# --------------------------------------------------------------------------- #
# A. relevance_scope = everything flips to the workspace-wide default column
# --------------------------------------------------------------------------- #
def test_resolve_everything_participant_changed_off():
    """workspace-wide default for card_participant_changed is OFF (contract
    table) — switching to `everything` does NOT make it noisier here."""
    row = _FakePrefsRow(relevance_scope="everything")
    eff = _resolve(row, relevance_scope="everything")
    assert _enabled(eff, "card_participant_changed") is False


def test_resolve_everything_card_created_off():
    row = _FakePrefsRow(relevance_scope="everything")
    eff = _resolve(row, relevance_scope="everything")
    assert _enabled(eff, "card_created") is False


def test_resolve_everything_card_assigned_on():
    """card_assigned is ON in BOTH columns — everything keeps it on."""
    row = _FakePrefsRow(relevance_scope="everything")
    eff = _resolve(row, relevance_scope="everything")
    assert _enabled(eff, "card_assigned") is True


def test_resolve_everything_approval_requested_on():
    row = _FakePrefsRow(relevance_scope="everything")
    eff = _resolve(row, relevance_scope="everything")
    assert _enabled(eff, "approval_requested") is True


# --------------------------------------------------------------------------- #
# A. category_overrides win over the relevance default
# --------------------------------------------------------------------------- #
def test_override_enables_a_default_off_category():
    """{card_created: {in_app: True}} flips a default-OFF category ON."""
    row = _FakePrefsRow(category_overrides={"card_created": {"in_app": True}})
    eff = _resolve(row, relevance_scope="watching")
    assert _enabled(eff, "card_created") is True


def test_override_disables_a_default_on_category():
    """{card_assigned: {in_app: False}} force-disables a default-ON category."""
    row = _FakePrefsRow(category_overrides={"card_assigned": {"in_app": False}})
    eff = _resolve(row, relevance_scope="watching")
    assert _enabled(eff, "card_assigned") is False


def test_override_for_other_channel_does_not_affect_in_app():
    """An override that names a different channel key leaves in_app on its
    category default (override is per-channel, sparse)."""
    row = _FakePrefsRow(category_overrides={"card_assigned": {"email": False}})
    eff = _resolve(row, relevance_scope="watching")
    # card_assigned default ON; the email override must not touch in_app.
    assert _enabled(eff, "card_assigned") is True


def test_override_under_everything_scope_still_wins():
    """An override beats even the everything-column default."""
    row = _FakePrefsRow(
        relevance_scope="everything",
        category_overrides={"card_participant_changed": {"in_app": True}},
    )
    eff = _resolve(row, relevance_scope="everything")
    assert _enabled(eff, "card_participant_changed") is True


# --------------------------------------------------------------------------- #
# A. muted = global kill-switch (beats overrides)
# --------------------------------------------------------------------------- #
def test_muted_disables_everything():
    row = _FakePrefsRow(muted=True)
    eff = _resolve(row, relevance_scope="watching")
    assert _enabled(eff, "card_assigned") is False
    assert _enabled(eff, "approval_requested") is False
    assert _enabled(eff, "card_participant_changed") is False


def test_muted_beats_a_truthy_override():
    """muted is the top of the precedence chain — an explicit ON override under
    a muted workspace still resolves OFF."""
    row = _FakePrefsRow(
        muted=True,
        category_overrides={"card_created": {"in_app": True}},
    )
    eff = _resolve(row, relevance_scope="watching")
    assert _enabled(eff, "card_created") is False


# --------------------------------------------------------------------------- #
# A. unknown category — fail-closed (OFF)
# --------------------------------------------------------------------------- #
def test_unknown_category_resolves_off():
    """A category with no entry in CATEGORY_DEFAULTS resolves OFF — generation
    must never invent noise for an unrecognized key (documented assumption)."""
    eff = _resolve(None, relevance_scope="watching")
    assert _enabled(eff, "totally_made_up_category") is False
