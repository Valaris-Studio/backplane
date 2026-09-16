# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Effective notification-preference resolution (Phase 2).

The resolver is a pure function over a NotificationPreference row (or None for a
new user, all defaults) yielding an EffectivePrefs object the channels query via
`channel_enabled(category, channel_key)`. Precedence (contract
§"Table notification_preferences"):

    muted (kill-switch) -> category_overrides[cat][channel] -> CATEGORY_DEFAULTS[cat][scope]

An unknown category fails closed (OFF) — generation must never invent noise for
a category the backend doesn't recognize.
"""

from __future__ import annotations

from app.models.notifications.preference import NotificationPreference

WATCHING = "watching"
EVERYTHING = "everything"

# Per-category default for the in_app channel, keyed by relevance_scope. The two
# columns transcribe the contract's "relevant-to-me default" (watching) and
# "workspace-wide default" (everything) table verbatim. board_run_finished has
# no v1 producer but its defaults are defined so the grid/resolver stay total.
CATEGORY_DEFAULTS: dict[str, dict[str, bool]] = {
    "mention": {WATCHING: True, EVERYTHING: True},
    "card_assigned": {WATCHING: True, EVERYTHING: True},
    "card_participant_changed": {WATCHING: True, EVERYTHING: False},
    "card_comment": {WATCHING: True, EVERYTHING: False},
    "dependency_blocking": {WATCHING: True, EVERYTHING: False},
    "approval_requested": {WATCHING: True, EVERYTHING: True},
    "approval_decided": {WATCHING: True, EVERYTHING: False},
    "board_run_finished": {WATCHING: True, EVERYTHING: False},
    "card_created": {WATCHING: False, EVERYTHING: False},
    "workspace_member": {WATCHING: True, EVERYTHING: False},
    "resource_note_shared": {WATCHING: False, EVERYTHING: False},
}


class EffectivePrefs:
    """Resolved per-(user, workspace) prefs. The precedence chain is baked in at
    construction; channels only ask `channel_enabled(category, channel_key)`."""

    def __init__(
        self,
        *,
        relevance_scope: str,
        category_overrides: dict,
        muted: bool,
    ):
        self.relevance_scope = relevance_scope
        self.category_overrides = category_overrides or {}
        self.muted = muted

    def channel_enabled(self, category: str, channel_key: str) -> bool:
        if self.muted:
            return False
        override = self.category_overrides.get(category)
        if override is not None and channel_key in override:
            return bool(override[channel_key])
        category_default = CATEGORY_DEFAULTS.get(category)
        if category_default is None:
            return False  # fail-closed for unrecognized categories
        return bool(category_default.get(self.relevance_scope, False))


class PreferenceResolver:
    def resolve(
        self,
        row: NotificationPreference | None,
        *,
        relevance_scope: str | None = None,
    ) -> EffectivePrefs:
        if row is None:
            return EffectivePrefs(
                relevance_scope=relevance_scope or WATCHING,
                category_overrides={},
                muted=False,
            )
        return EffectivePrefs(
            relevance_scope=relevance_scope or row.relevance_scope or WATCHING,
            category_overrides=row.category_overrides,
            muted=row.muted,
        )


def resolve_effective_prefs(
    row: NotificationPreference | None,
    *,
    relevance_scope: str | None = None,
) -> EffectivePrefs:
    return PreferenceResolver().resolve(row, relevance_scope=relevance_scope)
