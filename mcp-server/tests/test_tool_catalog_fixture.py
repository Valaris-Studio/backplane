# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json
from pathlib import Path

# Drift guard: the runner (Go, no Python interpreter at build/test time) can't
# introspect FastMCP's tool registry directly, so it reads a checked-in JSON
# fixture instead — see runner/internal/workloop/mcp_tool_catalog_test.go. This
# test is the other half of that contract: it fails the moment a tool is
# added, renamed, or removed here without regenerating the fixture via
# scripts/export-tool-catalog.py, so the two sides can never silently diverge.

FIXTURE_PATH = (
    Path(__file__).resolve().parent.parent.parent
    / "runner"
    / "internal"
    / "workloop"
    / "testdata"
    / "mcp_tool_catalog.json"
)


def test_tool_catalog_fixture_matches_server():
    from valaris_mcp.server import mcp

    live_names = sorted(mcp._tool_manager._tools.keys())
    fixture_names = json.loads(FIXTURE_PATH.read_text())

    assert fixture_names == live_names, (
        "runner/internal/workloop/testdata/mcp_tool_catalog.json is stale — "
        "regenerate it with: python mcp-server/scripts/export-tool-catalog.py"
    )
