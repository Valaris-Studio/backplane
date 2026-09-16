# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Toolsets: named slices of the tool surface selected by `VALARIS_MCP_TOOLSETS`.

A toolset id is any group id (slugified GROUPS title) or category id from
`catalog.py`; `all` and `default` are reserved words. The env var takes
`all`, or a comma list of ids where `default` expands to the default hand.

Why a default hand exists: several MCP clients cap the number of tools a
server may list (VS Code, Windsurf), and every listed schema is a fixed
token cost paid on each session whether or not the tool is used. An
interactive session therefore lists three groups (start here, work
management, knowledge & content) minus a short exclusion table, plus a short
inclusion table of read-only helpers from the other groups; the rest is
opt-in by naming the toolset. `DEFAULT_EXCLUSIONS` and `DEFAULT_INCLUSIONS`
only shape the `default` alias: an explicitly named toolset always carries
every tool in it, and every explicit hand also carries the `server-info`
category so a model on a narrow hand can learn what else exists.

Runner compatibility: a runner launch sets `VALARIS_MCP_ALLOWLIST` and, until
every binary pins `all`, nothing else. That allowlist is the session's whole
hand, so a present allowlist with no toolsets env resolves to `all` instead of
narrowing the stage grant to the interactive default.

The env selection is only the INITIAL hand: `enable_toolsets` widens the
toolset layer at runtime (hand.HandState.widen) and the server then emits
tools/list_changed. The allowlist it composes with (allowlist.compose_hand)
stays fixed for the process — a ceiling widening never lifts.
"""
from __future__ import annotations

import os

from valaris_mcp.allowlist import ALLOWLIST_ENV
from valaris_mcp.catalog import CATEGORIES, GROUP_IDS, TOOL_META

TOOLSETS_ENV = "VALARIS_MCP_TOOLSETS"
ALL, DEFAULT = "all", "default"
# Listed under every explicit hand: how a model discovers and widens the hand.
SERVER_INFO_TOOLSET = "server-info"

DEFAULT_TOOLSET_IDS: tuple[str, ...] = ("start-here", "work-management", "knowledge-content")

# Excluded from the default hand: destroying/cascading verbs, workspace-admin
# pairs, and the runner-only pickup path. Deprecated aliases need no entry —
# they are outside every toolset already.
DEFAULT_EXCLUSIONS: dict[str, str] = {
    "delete_workspace": "destroys the whole workspace",
    "delete_board": "destroys a board and every card on it",
    "delete_column": "cascade-deletes every card in the column",
    "remove_workspace_member": "workspace admin",
    "add_workspace_member": "workspace admin, pairs with remove_workspace_member",
    "update_workspace_member": "workspace admin, pairs with remove_workspace_member",
    "freeze_board": "workspace admin",
    "unfreeze_board": "workspace admin, pairs with freeze_board",
    "next_assignment": "runner-only pickup path; interactive sessions claim by move_card",
}

# Pulled into the default hand from outside its groups. Read-only or at worst
# non-destructive only — a test pins that against the catalog annotations.
DEFAULT_INCLUSIONS: dict[str, str] = {
    "list_git_repos": "read-only; boards are linked to repos",
    "list_skills": "the server instructions tell interactive agents to install the board's skills",
    "get_skill": "the server instructions tell interactive agents to install the board's skills",
    "get_workspace_metrics": "read-only reporting used by the standup workflow",
}

_GROUP_TITLE_BY_ID: dict[str, str] = dict(GROUP_IDS)
_GROUP_TITLE_BY_CATEGORY: dict[str, str] = {c.id: c.group for c in CATEGORIES}
_CATEGORY_BY_ID = {c.id: c for c in CATEGORIES}


def toolset_ids() -> list[str]:
    """Group ids then category ids, in taxonomy order."""
    return [group_id for group_id, _ in GROUP_IDS] + [c.id for c in CATEGORIES]


def tools_in_toolset(toolset_id: str) -> frozenset[str]:
    """Live tools only: a deprecated alias belongs to no toolset, so only the
    unrestricted `all` hand (or a runner allowlist naming it) ever lists it."""
    live = ((name, meta) for name, meta in TOOL_META.items() if not meta.deprecated_for)
    if toolset_id in _GROUP_TITLE_BY_ID:
        title = _GROUP_TITLE_BY_ID[toolset_id]
        return frozenset(
            name for name, meta in live if _GROUP_TITLE_BY_CATEGORY[meta.category] == title
        )
    if toolset_id in _CATEGORY_BY_ID:
        return frozenset(name for name, meta in live if meta.category == toolset_id)
    raise ValueError(f"unknown toolset id: {toolset_id!r}; valid: {toolset_ids()}")


def default_hand() -> frozenset[str]:
    union: set[str] = set()
    for toolset_id in DEFAULT_TOOLSET_IDS:
        union |= tools_in_toolset(toolset_id)
    return frozenset((union - set(DEFAULT_EXCLUSIONS)) | set(DEFAULT_INCLUSIONS))


def validate_toolset_ids(tokens: list[str]) -> list[str] | None:
    """Requested ids → stripped, de-duplicated ids (first occurrence wins), or None for `all`.

    Case-sensitive; `all` anywhere means unrestricted. An empty request or an
    unknown id raises ValueError naming the offenders and the valid ids.
    Shared by the env parser and `enable_toolsets`, so both reject the same
    inputs with the same message.
    """
    ids = list(dict.fromkeys(token.strip() for token in tokens if token.strip()))
    valid_ids = f"valid: {ALL}, {DEFAULT}, {', '.join(toolset_ids())}"
    if not ids:
        raise ValueError(f"no toolset ids given; {valid_ids}")
    if ALL in ids:
        return None
    valid = set(toolset_ids())
    unknown = [token for token in ids if token != DEFAULT and token not in valid]
    if unknown:
        raise ValueError(f"unknown toolset ids: {unknown!r}; {valid_ids}")
    return ids


def parse_toolsets(raw: str | None) -> list[str] | None:
    """Env value → configured ids ([DEFAULT] when unset/blank), or None for `all`.

    Tokens are stripped and validated by `validate_toolset_ids`; unknown ids
    fail closed with a RuntimeError naming the env var.
    """
    tokens = (raw or "").split(",")
    if not "".join(tokens).strip():
        return [DEFAULT]
    try:
        return validate_toolset_ids(tokens)
    except ValueError as exc:
        raise RuntimeError(f"{TOOLSETS_ENV} contains {exc}") from exc


def resolve_hand(ids: list[str] | None) -> frozenset[str] | None:
    if ids is None:
        return None
    hand: set[str] = set(tools_in_toolset(SERVER_INFO_TOOLSET))
    for toolset_id in ids:
        hand |= default_hand() if toolset_id == DEFAULT else tools_in_toolset(toolset_id)
    return frozenset(hand)


def allowlist_is_the_hand() -> bool:
    """`VALARIS_MCP_ALLOWLIST` present (any value) with `VALARIS_MCP_TOOLSETS` unset/blank.

    The runner launch shape: the allowlist alone picks the hand, so the
    toolsets resolve to `all` rather than the interactive default.
    """
    toolsets_blank = not (os.environ.get(TOOLSETS_ENV) or "").strip()
    return toolsets_blank and os.environ.get(ALLOWLIST_ENV) is not None


def load_toolsets() -> tuple[list[str] | None, frozenset[str] | None]:
    """(ids as configured, resolved hand) from the env; (None, None) means unrestricted."""
    if allowlist_is_the_hand():
        return None, None
    ids = parse_toolsets(os.environ.get(TOOLSETS_ENV))
    return ids, resolve_hand(ids)


def toolset_catalog() -> list[dict]:
    """Every toolset as {id, kind, title, group, tool_count}, in taxonomy order."""
    entries: list[dict] = [
        {
            "id": group_id,
            "kind": "group",
            "title": title,
            "group": title,
            "tool_count": len(tools_in_toolset(group_id)),
        }
        for group_id, title in GROUP_IDS
    ]
    entries.extend(
        {
            "id": category.id,
            "kind": "category",
            "title": category.title,
            "group": category.group,
            "tool_count": len(tools_in_toolset(category.id)),
        }
        for category in CATEGORIES
    )
    return entries
