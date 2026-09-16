# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Deprecation aliases: a retired or renamed tool stays callable for one minor
version, is hidden from every toolset, is flagged on the wire, and is counted
separately from the live surface everywhere a count is derived."""

from __future__ import annotations

import json
import logging

import pytest

from valaris_mcp.catalog import (
    DEPRECATION_REMOVAL_VERSION,
    TOOL_META,
    deprecated_aliases,
    live_tool_names,
)
from valaris_mcp.deprecation import DEPRECATED_MARKER, with_deprecation_notice
from valaris_mcp.server import mcp
from valaris_mcp.toolsets import (
    DEFAULT_EXCLUSIONS,
    default_hand,
    resolve_hand,
    toolset_ids,
    tools_in_toolset,
)

pytestmark = pytest.mark.anyio


def _registered() -> dict:
    return mcp._tool_manager._tools


# ---------- the table ----------


def test_deprecated_aliases_are_a_subset_of_the_registry_with_replacements():
    aliases = deprecated_aliases()
    assert aliases, "no deprecated alias registered — the mechanism has nothing to prove"
    assert set(aliases) <= set(_registered())
    for name, replacement in aliases.items():
        assert TOOL_META[name].deprecated_for == replacement
        assert replacement and replacement != name


def test_live_tool_names_exclude_every_deprecated_alias():
    live = set(live_tool_names())
    assert live | set(deprecated_aliases()) == set(_registered())
    assert not live & set(deprecated_aliases())


def test_claim_card_is_a_deprecated_alias():
    assert "claim_card" in deprecated_aliases()
    assert "next_assignment" in deprecated_aliases()["claim_card"]


def test_removal_version_is_the_next_minor():
    major, minor, patch = DEPRECATION_REMOVAL_VERSION.split(".")
    assert (major, minor, patch) == ("0", "9", "0")


# ---------- registration marker ----------


def test_every_alias_is_registered_through_the_deprecated_tool_decorator():
    for name in deprecated_aliases():
        assert getattr(_registered()[name].fn, DEPRECATED_MARKER, False), (
            f"{name} is in TOOL_META as deprecated but was not registered via deprecated_tool()"
        )


def test_no_live_tool_carries_the_deprecated_marker():
    leaked = sorted(
        name
        for name in live_tool_names()
        if getattr(_registered()[name].fn, DEPRECATED_MARKER, False)
    )
    assert not leaked


# ---------- wire shape ----------


def test_alias_description_opens_with_the_deprecation_line():
    for name, replacement in deprecated_aliases().items():
        description = _registered()[name].description
        assert description.startswith("DEPRECATED"), description
        assert replacement in description
        assert DEPRECATION_REMOVAL_VERSION in description


def test_alias_title_says_deprecated():
    for name in deprecated_aliases():
        assert _registered()[name].title.endswith("(deprecated)")


async def test_alias_carries_machine_readable_meta_on_the_wire():
    listed = {tool.name: tool for tool in await mcp.list_tools()}
    for name, replacement in deprecated_aliases().items():
        meta = listed[name].meta
        assert meta == {
            "deprecated": {
                "replacement": replacement,
                "removed_in": DEPRECATION_REMOVAL_VERSION,
            }
        }


async def test_live_tools_carry_no_meta():
    listed = {tool.name: tool for tool in await mcp.list_tools()}
    for name in live_tool_names():
        assert listed[name].meta is None, name


# ---------- call behaviour ----------


def test_with_deprecation_notice_injects_into_json_objects():
    out = json.loads(with_deprecation_notice("claim_card", '{"id": "c1"}'))
    assert out["id"] == "c1"
    assert "claim_card" in out["_deprecated"]
    assert deprecated_aliases()["claim_card"] in out["_deprecated"]


def test_with_deprecation_notice_prefixes_plain_text():
    out = with_deprecation_notice("claim_card", "Card claimed.")
    assert out.startswith("DEPRECATED")
    assert out.endswith("Card claimed.")


def test_with_deprecation_notice_leaves_json_arrays_as_prefixed_text():
    out = with_deprecation_notice("claim_card", "[1, 2]")
    assert out.startswith("DEPRECATED")
    assert out.endswith("[1, 2]")


async def test_calling_an_alias_logs_a_warning_and_stamps_the_result(mock_client, ctx, caplog):
    from valaris_mcp.tools.cards import claim_card

    mock_client.post.return_value = {"id": "c1"}
    with caplog.at_level(logging.WARNING, logger="valaris_mcp.deprecation"):
        result = json.loads(await claim_card("ws", "b1", "c1", "a1", ctx=ctx))
    assert "_deprecated" in result
    assert any("claim_card" in record.getMessage() for record in caplog.records)


# ---------- toolsets ----------


@pytest.mark.parametrize("toolset_id", toolset_ids())
def test_no_toolset_lists_a_deprecated_alias(toolset_id: str):
    assert not tools_in_toolset(toolset_id) & set(deprecated_aliases())


def test_default_hand_excludes_deprecated_aliases_without_naming_them():
    assert not default_hand() & set(deprecated_aliases())
    # A deprecated alias in DEFAULT_EXCLUSIONS is dead configuration: the
    # deprecation already hides it from every hand.
    assert not set(DEFAULT_EXCLUSIONS) & set(deprecated_aliases())


def test_explicit_hands_never_resolve_a_deprecated_alias():
    hand = resolve_hand(toolset_ids())
    assert hand is not None
    assert not hand & set(deprecated_aliases())


def test_unrestricted_hand_keeps_aliases_callable():
    # `all` (None) lists the whole registry, aliases included, so a runner
    # grant that still names the old tool keeps working for one minor version.
    assert resolve_hand(None) is None


# ---------- server info ----------


async def test_server_info_counts_live_tools_and_lists_aliases_separately(mock_client, monkeypatch):
    from tests.conftest import make_ctx
    from valaris_mcp.tools.server_info import get_server_info

    monkeypatch.delenv("VALARIS_MCP_ALLOWLIST", raising=False)
    monkeypatch.delenv("VALARIS_MCP_TOOLSETS", raising=False)
    mock_client.get.return_value = {"status": "ok"}
    info = json.loads(await get_server_info(ctx=make_ctx(mock_client)))

    assert info["tool_count"] == len(live_tool_names())
    assert info["tools"] == sorted(live_tool_names())
    assert info["deprecated_aliases"] == deprecated_aliases()
    assert info["deprecated_removed_in"] == DEPRECATION_REMOVAL_VERSION
    assert "allowlist_deprecated" not in info


async def test_server_info_flags_allowlist_entries_naming_deprecated_aliases(mock_client, monkeypatch):
    from tests.conftest import make_ctx
    from valaris_mcp.hand import load_hand
    from valaris_mcp.tools.server_info import get_server_info

    monkeypatch.setenv("VALARIS_MCP_ALLOWLIST", "claim_card,get_card,no_such_tool")
    monkeypatch.delenv("VALARIS_MCP_TOOLSETS", raising=False)
    mock_client.get.return_value = {"status": "ok"}
    info = json.loads(await get_server_info(ctx=make_ctx(mock_client, hand=load_hand())))

    assert info["allowlist_deprecated"] == {"claim_card": deprecated_aliases()["claim_card"]}
    assert info["allowlist_unknown"] == ["no_such_tool"]
    # Granted aliases stay callable, hence listed under the composed hand.
    assert "claim_card" in info["enabled_tools"]


# ---------- exported fixtures ----------


def test_server_surface_separates_live_tools_from_deprecated_aliases():
    from valaris_mcp.catalog import build_server_surface

    surface = build_server_surface(mcp)
    assert surface["tool_count"] == len(live_tool_names())
    assert set(surface["tools"]) == set(live_tool_names())
    assert surface["deprecated"] == {
        name: {"replacement": replacement, "removed_in": DEPRECATION_REMOVAL_VERSION}
        for name, replacement in deprecated_aliases().items()
    }
    for toolset in surface["toolsets"]:
        assert not set(toolset["tools"]) & set(deprecated_aliases())


def test_backend_toolsets_projection_carries_no_alias():
    from valaris_mcp.catalog import build_backend_toolsets

    projection = build_backend_toolsets(mcp)
    assert projection["tool_count"] == len(live_tool_names())
    for toolset in projection["toolsets"]:
        assert not set(toolset["tools"]) & set(deprecated_aliases())
