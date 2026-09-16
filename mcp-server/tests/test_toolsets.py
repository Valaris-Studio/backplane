# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Contract tests for toolsets (`valaris_mcp.toolsets`, MCP #2, card 176b4503).

A toolset id is any group id (slugified GROUPS title) or category id from
the catalog; `all` and `default` are reserved. `VALARIS_MCP_TOOLSETS` picks
the hand an interactive session lists, the default hand is three groups
minus a short exclusion table, and the result composes with the runner's
allowlist by intersection so a stage grant is never narrowed twice.

Every count below is derived from `catalog.TOOL_META` — nothing is typed.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
from mcp.server.fastmcp import FastMCP

from valaris_mcp.allowlist import (
    ALLOWLIST_ENV,
    compose_hand,
    install_allowlist,
    listed_tools,
    load_allowlist,
)
from valaris_mcp.catalog import (
    CATEGORIES,
    GROUP_IDS,
    GROUPS,
    TOOL_META,
    live_tool_names,
    slugify,
    tool_annotations,
)
from valaris_mcp.server import mcp
from valaris_mcp.toolsets import (
    ALL,
    DEFAULT,
    DEFAULT_EXCLUSIONS,
    DEFAULT_INCLUSIONS,
    DEFAULT_TOOLSET_IDS,
    TOOLSETS_ENV,
    default_hand,
    load_toolsets,
    parse_toolsets,
    resolve_hand,
    toolset_catalog,
    toolset_ids,
    tools_in_toolset,
)

pytestmark = pytest.mark.anyio

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_PATH = (
    REPO_ROOT
    / "frontend"
    / "src"
    / "pages"
    / "documentation"
    / "mcp-reference"
    / "data"
    / "server-surface.json"
)

AUTONOMOUS_GROUP = "Autonomous operations"
DEFAULT_HAND_MAX = 60
DEFAULT_HAND_PINS = (
    "get_card",
    "move_card",
    "create_card",
    "get_project_context",
    "search_cards",
    "set_board_loop",
)
DENY_ALL_SENTINEL = "__none__"
SERVER_INFO_TOOLSET = "server-info"
MCP_SERVER_DIR = Path(__file__).resolve().parents[1]
# Kept out of the default hand: destroying/cascading verbs, workspace-admin
# pairs, and the runner-only and legacy claim paths.
DEFAULT_EXCLUSION_PINS = (
    "delete_workspace",
    "delete_board",
    "delete_column",
    "remove_workspace_member",
    "add_workspace_member",
    "update_workspace_member",
    "freeze_board",
    "unfreeze_board",
    "next_assignment",
)
# Pulled into the default hand from outside the default groups.
DEFAULT_INCLUSION_PINS = (
    "list_git_repos",
    "list_skills",
    "get_skill",
    "get_workspace_metrics",
)

_SLUG_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


# ---------- independent derivations (do not trust the implementation) ----------


def _group_of_category() -> dict[str, str]:
    return {category.id: category.group for category in CATEGORIES}


def _tools_by_group(group_title: str) -> frozenset[str]:
    group_of = _group_of_category()
    return frozenset(
        name
        for name, meta in TOOL_META.items()
        if group_of[meta.category] == group_title and not meta.deprecated_for
    )


def _tools_by_category(category_id: str) -> frozenset[str]:
    return frozenset(
        name
        for name, meta in TOOL_META.items()
        if meta.category == category_id and not meta.deprecated_for
    )


def _group_ids() -> list[str]:
    return [group_id for group_id, _title in GROUP_IDS]


def _expected_default_hand() -> frozenset[str]:
    titles = dict(GROUP_IDS)
    union: set[str] = set()
    for toolset_id in DEFAULT_TOOLSET_IDS:
        union |= _tools_by_group(titles[toolset_id])
    return frozenset((union - set(DEFAULT_EXCLUSIONS)) | set(DEFAULT_INCLUSIONS))


def _server_info_tools() -> frozenset[str]:
    return _tools_by_category(SERVER_INFO_TOOLSET)


def _registered_names() -> set[str]:
    # The live surface: deprecated aliases are registered but belong to no
    # toolset (tests/test_deprecation.py pins that side).
    return set(live_tool_names())


# ---------- slugify / GROUP_IDS ----------


def test_slugify_lowercases_and_collapses_non_alphanumerics_to_dashes():
    assert slugify("Knowledge & content") == "knowledge-content"
    assert slugify("Start here") == "start-here"
    assert slugify("Autonomous operations") == "autonomous-operations"


def test_slugify_trims_leading_and_trailing_dashes():
    assert slugify("  --Trim  me!  ") == "trim-me"


def test_group_ids_derive_from_groups_in_order():
    assert GROUP_IDS == tuple((slugify(title), title) for title in GROUPS)
    assert _group_ids() == [
        "start-here",
        "work-management",
        "knowledge-content",
        "collaboration",
        "autonomous-operations",
    ]


# ---------- toolset ids ----------


def test_toolset_ids_are_group_ids_then_category_ids_in_taxonomy_order():
    assert toolset_ids() == _group_ids() + [category.id for category in CATEGORIES]


def test_toolset_ids_are_unique_slugs():
    ids = toolset_ids()
    assert len(ids) == len(set(ids)), "toolset ids collide between groups and categories"
    not_slugs = [toolset_id for toolset_id in ids if not _SLUG_RE.match(toolset_id)]
    assert not not_slugs, not_slugs


def test_reserved_words_are_not_toolset_ids():
    assert (ALL, DEFAULT) == ("all", "default")
    assert ALL not in toolset_ids()
    assert DEFAULT not in toolset_ids()


def test_toolsets_env_name_is_pinned():
    assert TOOLSETS_ENV == "VALARIS_MCP_TOOLSETS"


# ---------- tools_in_toolset ----------


@pytest.mark.parametrize("group_id,group_title", GROUP_IDS)
def test_tools_in_group_toolset_match_the_catalog(group_id: str, group_title: str):
    tools = tools_in_toolset(group_id)
    assert isinstance(tools, frozenset)
    assert tools == _tools_by_group(group_title)
    assert tools, f"group toolset {group_id} is empty"


@pytest.mark.parametrize("category", CATEGORIES, ids=lambda category: category.id)
def test_tools_in_category_toolset_match_the_catalog(category):
    tools = tools_in_toolset(category.id)
    assert isinstance(tools, frozenset)
    assert tools == _tools_by_category(category.id)
    assert tools, f"category toolset {category.id} is empty"


def test_tools_in_unknown_toolset_raises_value_error():
    with pytest.raises(ValueError, match="no-such-toolset"):
        tools_in_toolset("no-such-toolset")


# ---------- coverage / uniqueness over the registered surface ----------


def test_every_registered_tool_is_in_exactly_one_group_toolset():
    membership = {
        name: [group_id for group_id in _group_ids() if name in tools_in_toolset(group_id)]
        for name in sorted(_registered_names())
    }
    wrong = {name: groups for name, groups in membership.items() if len(groups) != 1}
    assert not wrong, f"tools not in exactly one group toolset: {wrong}"


def test_every_registered_tool_is_in_exactly_one_category_toolset():
    category_ids = [category.id for category in CATEGORIES]
    membership = {
        name: [cid for cid in category_ids if name in tools_in_toolset(cid)]
        for name in sorted(_registered_names())
    }
    wrong = {name: cats for name, cats in membership.items() if len(cats) != 1}
    assert not wrong, f"tools not in exactly one category toolset: {wrong}"


def test_group_toolsets_union_is_the_whole_registered_surface():
    union: set[str] = set()
    for group_id in _group_ids():
        union |= tools_in_toolset(group_id)
    assert union == _registered_names()


# ---------- default hand ----------


def test_default_toolset_ids_are_the_three_interactive_groups():
    assert DEFAULT_TOOLSET_IDS == ("start-here", "work-management", "knowledge-content")
    assert set(DEFAULT_TOOLSET_IDS) <= set(toolset_ids())


def test_default_hand_is_the_group_union_minus_exclusions():
    hand = default_hand()
    assert isinstance(hand, frozenset)
    assert hand == _expected_default_hand()


def test_default_hand_matches_the_frontend_fixture_pin():
    fixture = json.loads(FIXTURE_PATH.read_text())
    assert "default_toolset" in fixture, (
        "server-surface.json has no default_toolset — regenerate it with: "
        "python mcp-server/scripts/export-tool-catalog.py"
    )
    assert sorted(default_hand()) == fixture["default_toolset"]["tools"]


def test_default_hand_size_is_within_the_interactive_bound():
    assert 1 <= len(default_hand()) <= DEFAULT_HAND_MAX


@pytest.mark.parametrize("name", DEFAULT_HAND_PINS)
def test_default_hand_contains_the_interactive_essentials(name: str):
    assert name in default_hand()


def test_default_hand_excludes_every_default_exclusion():
    leaked = sorted(set(DEFAULT_EXCLUSIONS) & default_hand())
    assert not leaked, f"DEFAULT_EXCLUSIONS present in the default hand: {leaked}"


def test_default_exclusions_name_registered_tools_inside_the_default_groups():
    # An exclusion naming a tool outside the default groups (or a tool that
    # does not exist) is dead configuration.
    titles = dict(GROUP_IDS)
    in_default_groups: set[str] = set()
    for toolset_id in DEFAULT_TOOLSET_IDS:
        in_default_groups |= _tools_by_group(titles[toolset_id])
    dead = sorted(set(DEFAULT_EXCLUSIONS) - in_default_groups)
    assert not dead, f"exclusions that would never bite: {dead}"
    assert all(isinstance(reason, str) and reason for reason in DEFAULT_EXCLUSIONS.values())


def test_default_hand_excludes_every_autonomous_operations_tool_not_explicitly_included():
    leaked = sorted(_tools_by_group(AUTONOMOUS_GROUP) & default_hand() - set(DEFAULT_INCLUSIONS))
    assert not leaked, f"autonomous-operations tools in the default hand: {leaked}"


def test_default_hand_excludes_the_collaboration_group_except_explicit_inclusions():
    leaked = sorted(_tools_by_group("Collaboration") & default_hand() - set(DEFAULT_INCLUSIONS))
    assert not leaked, f"collaboration tools in the default hand: {leaked}"


def test_default_hand_only_names_registered_tools():
    assert default_hand() <= _registered_names()


@pytest.mark.parametrize("name", DEFAULT_EXCLUSION_PINS)
def test_default_exclusions_pin_the_admin_and_claim_verbs(name: str):
    assert name in DEFAULT_EXCLUSIONS
    assert name not in default_hand()


def test_default_inclusions_are_exactly_the_pinned_read_only_helpers():
    assert set(DEFAULT_INCLUSIONS) == set(DEFAULT_INCLUSION_PINS)
    assert all(isinstance(reason, str) and reason for reason in DEFAULT_INCLUSIONS.values())


def test_default_inclusions_name_registered_tools_outside_the_default_groups():
    # An inclusion naming a tool already inside the default groups (or one
    # that does not exist) is dead configuration.
    titles = dict(GROUP_IDS)
    in_default_groups: set[str] = set()
    for toolset_id in DEFAULT_TOOLSET_IDS:
        in_default_groups |= _tools_by_group(titles[toolset_id])
    assert set(DEFAULT_INCLUSIONS) <= _registered_names()
    dead = sorted(set(DEFAULT_INCLUSIONS) & in_default_groups)
    assert not dead, f"inclusions already inside the default groups: {dead}"
    assert not set(DEFAULT_INCLUSIONS) & set(DEFAULT_EXCLUSIONS)


@pytest.mark.parametrize("name", sorted(DEFAULT_INCLUSIONS))
def test_default_inclusions_are_never_destructive(name: str):
    # The default hand pulls tools in from outside its groups only when they
    # cannot destroy anything: read-only or, at worst, non-destructive.
    annotations = tool_annotations(name, TOOL_META[name])
    assert annotations.destructiveHint is False


@pytest.mark.parametrize("name", DEFAULT_INCLUSION_PINS)
def test_default_hand_contains_every_default_inclusion(name: str):
    assert name in default_hand()


# ---------- parse_toolsets ----------


@pytest.mark.parametrize("raw", [None, "", "   ", "\t\n"])
def test_parse_toolsets_unset_or_blank_means_default(raw):
    assert parse_toolsets(raw) == [DEFAULT]


@pytest.mark.parametrize("raw", ["all", " all ", "all,cards", "cards,all,notes"])
def test_parse_toolsets_all_anywhere_means_unrestricted(raw):
    assert parse_toolsets(raw) is None


def test_parse_toolsets_returns_ids_in_given_order():
    assert parse_toolsets("default,cards") == ["default", "cards"]
    assert parse_toolsets("cards,default") == ["cards", "default"]


def test_parse_toolsets_strips_whitespace_and_empty_tokens():
    assert parse_toolsets(" default , cards ,, notes ") == ["default", "cards", "notes"]


def test_parse_toolsets_dedupes_ids_preserving_first_occurrence_order():
    assert parse_toolsets("default,default") == ["default"]
    assert parse_toolsets("cards,default,cards,notes") == ["cards", "default", "notes"]


def test_parse_toolsets_unknown_id_raises_naming_the_ids():
    with pytest.raises(RuntimeError) as excinfo:
        parse_toolsets("cards,bogus,also-bogus")
    message = str(excinfo.value)
    assert TOOLSETS_ENV in message
    assert "bogus" in message
    assert "also-bogus" in message
    # The fail-closed message lists the valid ids so the operator can fix it.
    assert "cards" in message


def test_parse_toolsets_is_case_sensitive():
    with pytest.raises(RuntimeError):
        parse_toolsets("Cards")


def test_parse_toolsets_rejects_tool_names_that_are_not_toolsets():
    # A user pasting an allowlist into the toolsets var must be told, not
    # silently given the default hand.
    with pytest.raises(RuntimeError, match="get_card"):
        parse_toolsets("get_card")


# ---------- resolve_hand ----------


def test_resolve_hand_none_is_unrestricted():
    assert resolve_hand(None) is None


def test_resolve_hand_default_expands_to_the_default_hand():
    assert resolve_hand([DEFAULT]) == default_hand()


def test_resolve_hand_category_id_resolves_to_its_tools_plus_server_info():
    assert resolve_hand(["cards"]) == _tools_by_category("cards") | _server_info_tools()


def test_resolve_hand_group_id_resolves_to_its_tools_plus_server_info():
    assert resolve_hand(["work-management"]) == (
        _tools_by_group("Work management") | _server_info_tools()
    )


def test_resolve_hand_unions_multiple_ids():
    assert resolve_hand(["cards", "notes"]) == (
        _tools_by_category("cards") | _tools_by_category("notes") | _server_info_tools()
    )


@pytest.mark.parametrize("toolset_id", toolset_ids() + [DEFAULT])
def test_resolve_hand_always_carries_the_server_info_tools(toolset_id: str):
    # get_server_info is how a model on a narrow hand learns what else exists
    # and how to widen it, so every explicit hand lists it.
    assert _server_info_tools()
    assert _server_info_tools() <= resolve_hand([toolset_id])


def test_server_info_toolset_is_discovery_identity_and_widening():
    # "Who am I, what does this server expose, and how do I get more of it":
    # all three ride on every hand.
    assert _server_info_tools() == frozenset({"get_server_info", "whoami", "enable_toolsets"})
    assert TOOL_META["whoami"].category == SERVER_INFO_TOOLSET
    assert TOOL_META["enable_toolsets"].category == SERVER_INFO_TOOLSET


def test_tools_in_toolset_stays_pure_of_the_server_info_union():
    # The union happens at resolve time only; a toolset's own membership (and
    # the exported fixture built from it) is exactly its catalog slice.
    assert tools_in_toolset("cards") == _tools_by_category("cards")
    assert not _server_info_tools() & tools_in_toolset("cards")


def test_resolve_hand_default_plus_group_widens_the_default():
    resolved = resolve_hand([DEFAULT, "autonomous-operations"])
    assert resolved == default_hand() | _tools_by_group(AUTONOMOUS_GROUP)
    assert isinstance(resolved, frozenset)


def test_resolve_hand_default_plus_excluded_category_reinstates_the_exclusion():
    # Explicitly asking for `boards` puts delete_board back: exclusions only
    # shape the DEFAULT alias, never an id the operator named.
    assert "delete_board" in resolve_hand([DEFAULT, "boards"])
    assert "delete_board" not in resolve_hand([DEFAULT])


# ---------- load_toolsets (env) ----------


def test_load_toolsets_unset_env_yields_default(monkeypatch):
    monkeypatch.delenv(TOOLSETS_ENV, raising=False)
    monkeypatch.delenv(ALLOWLIST_ENV, raising=False)
    assert load_toolsets() == ([DEFAULT], default_hand())


def test_load_toolsets_all_yields_unrestricted(monkeypatch):
    monkeypatch.setenv(TOOLSETS_ENV, "all")
    assert load_toolsets() == (None, None)


def test_load_toolsets_explicit_list_yields_ids_and_union(monkeypatch):
    monkeypatch.setenv(TOOLSETS_ENV, "cards, notes")
    monkeypatch.delenv(ALLOWLIST_ENV, raising=False)
    ids, hand = load_toolsets()
    assert ids == ["cards", "notes"]
    assert hand == _tools_by_category("cards") | _tools_by_category("notes") | _server_info_tools()


def test_load_toolsets_dedupes_repeated_ids(monkeypatch):
    monkeypatch.setenv(TOOLSETS_ENV, "default,default")
    ids, hand = load_toolsets()
    assert ids == [DEFAULT]
    assert hand == default_hand()


def test_load_toolsets_unknown_id_fails_closed(monkeypatch):
    monkeypatch.setenv(TOOLSETS_ENV, "cards,bogus")
    with pytest.raises(RuntimeError, match="bogus"):
        load_toolsets()


# Runner compatibility: a runner launch sets the allowlist and (until the
# binaries that pin `all` roll out) nothing else. The allowlist IS its hand,
# so a present allowlist with no toolsets env must never be narrowed to the
# interactive default.
@pytest.mark.parametrize("allowlist", ["get_card,delete_workspace", DENY_ALL_SENTINEL, "*", ""])
@pytest.mark.parametrize("raw_toolsets", [None, "", "  "])
def test_load_toolsets_allowlist_present_and_toolsets_unset_loads_all(
    monkeypatch, allowlist: str, raw_toolsets: str | None
):
    if raw_toolsets is None:
        monkeypatch.delenv(TOOLSETS_ENV, raising=False)
    else:
        monkeypatch.setenv(TOOLSETS_ENV, raw_toolsets)
    monkeypatch.setenv(ALLOWLIST_ENV, allowlist)
    assert load_toolsets() == (None, None)


def test_load_toolsets_explicit_ids_still_compose_with_a_present_allowlist(monkeypatch):
    monkeypatch.setenv(TOOLSETS_ENV, "cards")
    monkeypatch.setenv(ALLOWLIST_ENV, "get_card,delete_workspace")
    ids, hand = load_toolsets()
    assert ids == ["cards"]
    assert hand == _tools_by_category("cards") | _server_info_tools()
    assert compose_hand(hand, load_allowlist()) == frozenset({"get_card"})


# ---------- main() fails fast on a bad toolsets env ----------


def _run_main(env_overrides: dict[str, str]) -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        "VALARIS_API_URL": "http://127.0.0.1:9",
        "VALARIS_API_KEY": "vlr_test",
        "PYTHONPATH": str(MCP_SERVER_DIR / "src"),
        **env_overrides,
    }
    return subprocess.run(
        [sys.executable, "-c", "from valaris_mcp.server import main; main()"],
        env=env,
        cwd=MCP_SERVER_DIR,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_main_exits_2_with_one_stderr_line_on_unknown_toolset_id():
    result = _run_main({TOOLSETS_ENV: "cards,bogus"})
    assert result.returncode == 2, result.stderr
    lines = result.stderr.strip().splitlines()
    assert len(lines) == 1, result.stderr
    assert lines[0].startswith(
        "backplane-mcp: VALARIS_MCP_TOOLSETS contains unknown toolset ids: ['bogus']; valid: "
    ), lines[0]
    assert "cards" in lines[0]
    assert "Traceback" not in result.stderr


# ---------- compose_hand ----------


def test_compose_hand_none_none_is_unrestricted():
    assert compose_hand(None, None) is None


def test_compose_hand_toolsets_only_is_the_toolset_hand():
    hand = frozenset({"get_card", "move_card"})
    assert compose_hand(hand, None) == hand


def test_compose_hand_allowlist_only_is_the_allowlist():
    allowlist = frozenset({"get_card", "create_note"})
    assert compose_hand(None, allowlist) == allowlist


def test_compose_hand_both_set_intersects():
    hand = frozenset({"get_card", "move_card", "create_card"})
    allowlist = frozenset({"move_card", "create_note"})
    assert compose_hand(hand, allowlist) == frozenset({"move_card"})


def test_compose_hand_disjoint_sets_is_empty_not_unrestricted():
    composed = compose_hand(frozenset({"get_card"}), frozenset({"create_note"}))
    assert composed == frozenset()
    assert composed is not None


def test_compose_hand_deny_all_sentinel_empties_any_toolset(monkeypatch):
    monkeypatch.setenv("VALARIS_MCP_ALLOWLIST", DENY_ALL_SENTINEL)
    allowlist = load_allowlist()
    assert allowlist == frozenset({DENY_ALL_SENTINEL})
    composed = compose_hand(default_hand(), allowlist)
    assert composed == frozenset()
    assert composed is not None


def test_compose_hand_returns_a_frozenset():
    assert isinstance(compose_hand(frozenset({"a"}), frozenset({"a"})), frozenset)


# ---------- composed hand on a fresh FastMCP ----------


def _three_tool_server() -> FastMCP:
    server = FastMCP("t")

    @server.tool()
    def alpha(value: str) -> str:
        """Alpha."""
        return f"alpha:{value}"

    @server.tool()
    def beta(value: str) -> str:
        """Beta."""
        return f"beta:{value}"

    @server.tool()
    def gamma(value: str) -> str:
        """Gamma."""
        return f"gamma:{value}"

    return server


async def _listed_names(server: FastMCP) -> list[str]:
    return [tool.name for tool in await server.list_tools()]


async def test_composed_hand_lists_only_the_intersection():
    server = _three_tool_server()
    composed = compose_hand(frozenset({"alpha", "beta"}), frozenset({"beta", "gamma"}))
    install_allowlist(server, composed)
    assert await _listed_names(server) == ["beta"]
    assert await server._tool_manager.call_tool("beta", {"value": "x"}) == "beta:x"
    with pytest.raises(PermissionError):
        await server._tool_manager.call_tool("alpha", {"value": "x"})


async def test_composed_hand_with_toolsets_only_lists_the_toolset():
    server = _three_tool_server()
    install_allowlist(server, compose_hand(frozenset({"gamma", "alpha"}), None))
    assert await _listed_names(server) == ["alpha", "gamma"]


async def test_composed_hand_unrestricted_lists_everything():
    server = _three_tool_server()
    install_allowlist(server, compose_hand(None, None))
    assert await _listed_names(server) == ["alpha", "beta", "gamma"]


async def test_composed_hand_deny_all_sentinel_lists_nothing_and_denies_all():
    server = _three_tool_server()
    install_allowlist(
        server, compose_hand(frozenset({"alpha", "beta"}), frozenset({DENY_ALL_SENTINEL}))
    )
    assert await _listed_names(server) == []
    with pytest.raises(PermissionError):
        await server._tool_manager.call_tool("alpha", {"value": "x"})


async def test_env_toolset_and_allowlist_compose_over_real_tools(monkeypatch):
    from valaris_mcp.tools.cards import create_card, get_card, move_card
    from valaris_mcp.tools.notes import create_note

    monkeypatch.setenv(TOOLSETS_ENV, "cards")
    monkeypatch.setenv("VALARIS_MCP_ALLOWLIST", "get_card,create_note")
    server = FastMCP("t")
    for fn in (get_card, move_card, create_card, create_note):
        server.add_tool(fn)

    _ids, toolset_hand = load_toolsets()
    install_allowlist(server, compose_hand(toolset_hand, load_allowlist()))

    # create_note is allowlisted but outside `cards`; move_card is in `cards`
    # but not allowlisted. Only the intersection survives.
    assert await _listed_names(server) == ["get_card"]
    with pytest.raises(PermissionError):
        await server._tool_manager.call_tool("create_note", {})
    with pytest.raises(PermissionError):
        await server._tool_manager.call_tool("move_card", {})


async def test_listed_tools_over_the_default_hand_matches_the_singleton_registry():
    hand = listed_tools(await mcp.list_tools(), default_hand())
    assert {tool.name for tool in hand} == default_hand()


# ---------- toolset_catalog ----------


def test_toolset_catalog_lists_every_toolset_in_taxonomy_order():
    catalog = toolset_catalog()
    assert isinstance(catalog, list)
    assert [entry["id"] for entry in catalog] == toolset_ids()


def test_toolset_catalog_entries_carry_the_documented_shape():
    for entry in toolset_catalog():
        assert set(entry) == {"id", "kind", "title", "group", "tool_count"}, entry
        assert entry["kind"] in ("group", "category")
        assert isinstance(entry["tool_count"], int)
        assert entry["tool_count"] == len(tools_in_toolset(entry["id"]))


def test_toolset_catalog_group_entries_are_titled_by_their_group():
    by_id = {entry["id"]: entry for entry in toolset_catalog()}
    for group_id, title in GROUP_IDS:
        entry = by_id[group_id]
        assert entry["kind"] == "group"
        assert entry["title"] == title
        assert entry["group"] == title


def test_toolset_catalog_category_entries_point_at_their_group():
    by_id = {entry["id"]: entry for entry in toolset_catalog()}
    for category in CATEGORIES:
        entry = by_id[category.id]
        assert entry["kind"] == "category"
        assert entry["title"] == category.title
        assert entry["group"] == category.group


def test_toolset_catalog_group_counts_sum_to_the_whole_surface():
    catalog = toolset_catalog()
    group_total = sum(entry["tool_count"] for entry in catalog if entry["kind"] == "group")
    category_total = sum(
        entry["tool_count"] for entry in catalog if entry["kind"] == "category"
    )
    assert group_total == len(live_tool_names()) == len(_registered_names())
    assert category_total == len(live_tool_names())
