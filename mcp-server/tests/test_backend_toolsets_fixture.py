# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Freshness guard for the backend's copy of the toolset taxonomy (MCP #3, card 3c690fb6).

`scripts/export-tool-catalog.py` writes backend/app/data/mcp_toolsets.json so the
backend can validate a skill's `toolsets:` declaration against the same ids the
live server enforces, without importing the MCP package at runtime. This test
fails the moment the checked-in fixture no longer matches what the live server
would export.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from valaris_mcp.catalog import build_server_surface
from valaris_mcp.server import mcp

REGEN_COMMAND = "python mcp-server/scripts/export-tool-catalog.py"

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_PATH = REPO_ROOT / "backend" / "app" / "data" / "mcp_toolsets.json"
FIXTURE_REL = "backend/app/data/mcp_toolsets.json"


def _expected_from_surface() -> dict:
    surface = build_server_surface(mcp)
    return {
        "toolsets": surface["toolsets"],
        "default": surface["default_toolset"],
        "tool_count": surface["tool_count"],
    }


def _fixture() -> dict:
    assert FIXTURE_PATH.exists(), (
        f"{FIXTURE_REL} is missing — generate it with: {REGEN_COMMAND}"
    )
    return json.loads(FIXTURE_PATH.read_text())


def test_build_backend_toolsets_helper_returns_the_surface_projection():
    from valaris_mcp import catalog

    assert hasattr(catalog, "build_backend_toolsets"), (
        "catalog.build_backend_toolsets(server) is missing — it is the single "
        f"source the export script writes to {FIXTURE_REL}"
    )
    assert catalog.build_backend_toolsets(mcp) == _expected_from_surface()


def test_build_backend_toolsets_exposes_exactly_three_keys():
    from valaris_mcp.catalog import build_backend_toolsets

    assert set(build_backend_toolsets(mcp)) == {"toolsets", "default", "tool_count"}


def test_backend_toolsets_fixture_matches_live_server():
    assert _fixture() == _expected_from_surface(), (
        f"{FIXTURE_REL} is stale — regenerate it with: {REGEN_COMMAND}"
    )


def test_backend_toolsets_fixture_is_canonically_formatted():
    # Sorted keys, 2-space indent, trailing newline: a deterministic file so
    # regeneration on a clean tree is a no-op diff.
    text = FIXTURE_PATH.read_text()
    canonical = json.dumps(json.loads(text), indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    assert text == canonical, (
        f"{FIXTURE_REL} is not canonical — regenerate with: {REGEN_COMMAND}"
    )


def test_backend_toolsets_fixture_carries_the_documented_shape():
    from valaris_mcp.toolsets import toolset_ids, tools_in_toolset

    fixture = _fixture()
    assert set(fixture) == {"toolsets", "default", "tool_count"}, sorted(fixture)
    assert [entry["id"] for entry in fixture["toolsets"]] == toolset_ids()
    for entry in fixture["toolsets"]:
        assert set(entry) == {"id", "kind", "title", "group", "tools"}, entry
        assert entry["tools"] == sorted(tools_in_toolset(entry["id"])), entry["id"]
    assert set(fixture["default"]) == {"ids", "exclusions", "inclusions", "tools"}
    assert fixture["tool_count"] == build_server_surface(mcp)["tool_count"]


def test_backend_toolsets_fixture_mirrors_the_frontend_surface_fixture():
    # Both generated files come from one build_server_surface call; they must
    # never disagree about the taxonomy.
    frontend_surface = (
        REPO_ROOT
        / "frontend"
        / "src"
        / "pages"
        / "documentation"
        / "mcp-reference"
        / "data"
        / "server-surface.json"
    )
    surface = json.loads(frontend_surface.read_text())
    fixture = _fixture()
    assert fixture["toolsets"] == surface["toolsets"], f"toolsets diverged — {REGEN_COMMAND}"
    assert fixture["default"] == surface["default_toolset"], f"default diverged — {REGEN_COMMAND}"
    assert fixture["tool_count"] == surface["tool_count"]


def test_export_script_names_the_backend_fixture():
    # The regen command must actually produce the file the tests above pin.
    script = (REPO_ROOT / "mcp-server" / "scripts" / "export-tool-catalog.py").read_text()
    assert "mcp_toolsets.json" in script, (
        "scripts/export-tool-catalog.py does not write backend/app/data/mcp_toolsets.json"
    )
    assert "build_backend_toolsets" in script, (
        "scripts/export-tool-catalog.py must build the backend fixture via "
        "catalog.build_backend_toolsets so the script and the freshness test share one source"
    )
