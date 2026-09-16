# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Freshness guard for the frontend's copy of the server surface.

`scripts/export-tool-catalog.py` writes server-surface.json next to the
hand-written ToolDoc prose so a docstring rewrite shows up as a reviewable
diff in the docs data directory (and the in-app reference renders the wire
text from it). This test fails the moment the checked-in fixture no longer
matches what the live server would export.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from valaris_mcp.catalog import TOOL_META, build_server_surface, live_tool_names
from valaris_mcp.server import mcp

pytestmark = pytest.mark.anyio

REGEN_COMMAND = "python mcp-server/scripts/export-tool-catalog.py"

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


def _fixture() -> dict:
    assert FIXTURE_PATH.exists(), (
        f"{FIXTURE_PATH.relative_to(REPO_ROOT)} is missing — "
        f"generate it with: {REGEN_COMMAND}"
    )
    return json.loads(FIXTURE_PATH.read_text())


def test_server_surface_fixture_matches_live_server():
    assert _fixture() == build_server_surface(mcp), (
        "frontend/src/pages/documentation/mcp-reference/data/server-surface.json is "
        f"stale — regenerate it with: {REGEN_COMMAND}"
    )


def test_server_surface_fixture_is_canonically_formatted():
    # Sorted keys, 2-space indent, trailing newline: a deterministic file so
    # regeneration on a clean tree is a no-op diff.
    text = FIXTURE_PATH.read_text()
    canonical = json.dumps(json.loads(text), indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    assert text == canonical, f"server-surface.json is not canonical — regenerate with: {REGEN_COMMAND}"


def test_server_surface_tool_count_is_derived_from_the_catalog():
    fixture = _fixture()
    assert fixture["tool_count"] == len(live_tool_names())
    assert fixture["tool_count"] == len(fixture["tools"])
    assert set(fixture["tools"]) == set(live_tool_names())


async def test_server_surface_listing_bytes_equals_the_compact_wire_size():
    fixture = _fixture()
    live = set(live_tool_names())
    compact = sum(
        len(tool.model_dump_json(exclude_none=True, by_alias=True))
        for tool in await mcp.list_tools()
        if tool.name in live
    )
    assert fixture["listing_bytes"] == compact


def test_server_surface_entries_carry_the_documented_shape():
    fixture = _fixture()
    for name, entry in fixture["tools"].items():
        assert set(entry) == {
            "title",
            "category",
            "kind",
            "annotations",
            "description",
            "params",
        }, f"{name}: unexpected keys {sorted(entry)}"
        assert set(entry["annotations"]) == {"readOnlyHint", "destructiveHint", "idempotentHint"}
        assert all(isinstance(v, bool) for v in entry["annotations"].values()), name
        assert entry["category"] == TOOL_META[name].category
        assert entry["kind"] == TOOL_META[name].kind
        assert entry["title"]
        assert isinstance(entry["params"], dict)


def test_server_surface_params_mirror_live_schema_descriptions():
    fixture = _fixture()
    drift = []
    for name in live_tool_names():
        tool = mcp._tool_manager._tools[name]
        live = {
            prop: spec.get("description")
            for prop, spec in tool.parameters.get("properties", {}).items()
        }
        if fixture["tools"][name]["params"] != live:
            drift.append(name)
    assert not drift, f"fixture params drifted from live schemas for: {drift} — {REGEN_COMMAND}"


# ---------- toolsets + default_toolset (MCP #2, card 176b4503) ----------


def test_build_server_surface_exports_toolsets_and_the_default_toolset():
    surface = build_server_surface(mcp)
    assert "toolsets" in surface, "build_server_surface does not export toolsets"
    assert "default_toolset" in surface, "build_server_surface does not export default_toolset"
    fixture = _fixture()
    assert fixture["toolsets"] == surface["toolsets"], f"toolsets stale — {REGEN_COMMAND}"
    assert fixture["default_toolset"] == surface["default_toolset"], (
        f"default_toolset stale — {REGEN_COMMAND}"
    )


def test_server_surface_toolsets_follow_the_taxonomy_order_and_shape():
    from valaris_mcp.toolsets import toolset_ids, tools_in_toolset

    toolsets = _fixture()["toolsets"]
    assert isinstance(toolsets, list)
    assert [entry["id"] for entry in toolsets] == toolset_ids()
    for entry in toolsets:
        assert set(entry) == {"id", "kind", "title", "group", "tools"}, entry
        assert entry["kind"] in ("group", "category")
        assert entry["title"] and entry["group"]
        assert entry["tools"] == sorted(entry["tools"]), f"{entry['id']}: tools not sorted"
        assert entry["tools"] == sorted(tools_in_toolset(entry["id"]))


def test_server_surface_group_toolsets_partition_the_registered_tools():
    group_toolsets = [entry for entry in _fixture()["toolsets"] if entry["kind"] == "group"]
    assert group_toolsets
    seen: dict[str, list[str]] = {name: [] for name in live_tool_names()}
    for entry in group_toolsets:
        for name in entry["tools"]:
            assert name in seen, f"{entry['id']} lists unregistered tool {name}"
            seen[name].append(entry["id"])
    wrong = {name: groups for name, groups in seen.items() if len(groups) != 1}
    assert not wrong, f"tools not in exactly one group toolset: {wrong}"


def test_server_surface_default_toolset_pins_the_default_hand():
    from valaris_mcp.toolsets import (
        DEFAULT_EXCLUSIONS,
        DEFAULT_INCLUSIONS,
        DEFAULT_TOOLSET_IDS,
        default_hand,
    )

    default_toolset = _fixture()["default_toolset"]
    assert set(default_toolset) == {"ids", "exclusions", "inclusions", "tools"}
    assert default_toolset["ids"] == list(DEFAULT_TOOLSET_IDS)
    assert default_toolset["exclusions"] == DEFAULT_EXCLUSIONS
    assert default_toolset["inclusions"] == DEFAULT_INCLUSIONS
    assert default_toolset["tools"] == sorted(default_hand())
    assert not set(default_toolset["tools"]) & set(default_toolset["exclusions"])
    assert set(default_toolset["inclusions"]) <= set(default_toolset["tools"])
