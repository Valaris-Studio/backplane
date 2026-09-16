# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The hand a session holds: toolset layer ∩ allowlist, mutable at runtime.

Two layers compose the set of tools a session can list and call. The toolset
layer (`VALARIS_MCP_TOOLSETS`, widened by `enable_toolsets`) is the session's
choice of slices; the allowlist (`VALARIS_MCP_ALLOWLIST`) is the runner's
stage grant. Widening only ever grows the toolset layer — the allowlist is a
ceiling it never lifts, and a session that starts unrestricted, or whose whole
hand is the allowlist, has nothing to widen.

`install_hand` (allowlist.py) reads `composed` at every list/call, so a widen
is visible on the very next request without re-installing anything.
"""
from __future__ import annotations

from dataclasses import dataclass

from valaris_mcp.allowlist import compose_hand, load_allowlist
from valaris_mcp.catalog import TOOL_META
from valaris_mcp.toolsets import load_toolsets, resolve_hand, validate_toolset_ids


def listed_layer(layer: frozenset[str] | None) -> frozenset[str]:
    # An unrestricted layer lists the whole registered surface, deprecated
    # aliases included; TOOL_META mirrors the registry (coverage-checked at
    # finalize), so no import of the server singleton is needed here.
    return frozenset(TOOL_META) if layer is None else layer


@dataclass
class HandState:
    toolset_ids: list[str] | None
    toolset_hand: frozenset[str] | None
    allowlist: frozenset[str] | None

    @property
    def composed(self) -> frozenset[str] | None:
        return compose_hand(self.toolset_hand, self.allowlist)

    def widen(self, ids: list[str]) -> frozenset[str]:
        """Union `ids` into the toolset layer; return the names newly listed.

        Validation happens before any mutation, so a rejected request (unknown
        or empty) leaves the state untouched. `all` lifts the toolset layer.
        The return value is measured after the allowlist intersection: it is
        exactly what the client will see appear on re-list.
        """
        requested = validate_toolset_ids(ids)
        if self.toolset_hand is None:
            # Toolset layer already unrestricted (or the allowlist is the whole
            # hand, the runner shape): nothing a toolset could add.
            return frozenset()
        before = self.composed
        if requested is None:
            self.toolset_ids = None
            self.toolset_hand = None
        else:
            self.toolset_ids = list(dict.fromkeys([*self.toolset_ids, *requested]))
            self.toolset_hand = resolve_hand(self.toolset_ids)
        # ∩ TOOL_META: an allowlist name this server never registered is
        # not growth (it will never be listed), so it must not notify.
        return (listed_layer(self.composed) & frozenset(TOOL_META)) - before


def load_hand() -> HandState:
    toolset_ids, toolset_hand = load_toolsets()
    return HandState(toolset_ids, toolset_hand, load_allowlist())
