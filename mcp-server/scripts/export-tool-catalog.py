#!/usr/bin/env python3
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Export the MCP tool surface to its two checked-in fixtures.

1. runner/internal/workloop/testdata/mcp_tool_catalog.json — tool names only
   (the Go side's drift guard).
2. frontend/src/pages/documentation/mcp-reference/data/server-surface.json —
   title/category/kind/annotations/wire description/param descriptions per
   tool, rendered by the in-app MCP reference and guarded by
   mcp-server/tests/test_server_surface_fixture.py.

Run with the mcp-server virtualenv active:

    cd mcp-server && source .venv/bin/activate && cd ..
    python mcp-server/scripts/export-tool-catalog.py

The runner (Go, no Python interpreter at build time) can't introspect
FastMCP's tool registry directly, so this fixture is the checked-in bridge:
runner/internal/workloop/mcp_tool_catalog_test.go asserts every MCP tool name
the Go dispatch table references exists in it, and
mcp-server/tests/test_tool_catalog_fixture.py asserts the fixture itself
matches the live server — catching drift from either side.
"""

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / "mcp-server" / "src"))


def main() -> None:
    from valaris_mcp.catalog import build_backend_toolsets, build_server_surface
    from valaris_mcp.server import mcp

    out = REPO_ROOT / "runner" / "internal" / "workloop" / "testdata" / "mcp_tool_catalog.json"
    names = sorted(mcp._tool_manager._tools.keys())
    out.write_text(json.dumps(names, indent=2) + "\n")
    print(f"{out.relative_to(REPO_ROOT)}: {len(names)} tools")

    surface_out = (
        REPO_ROOT
        / "frontend"
        / "src"
        / "pages"
        / "documentation"
        / "mcp-reference"
        / "data"
        / "server-surface.json"
    )
    surface = build_server_surface(mcp)
    surface_out.write_text(
        json.dumps(surface, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    )
    print(
        f"{surface_out.relative_to(REPO_ROOT)}: {surface['tool_count']} tools, "
        f"{surface['listing_bytes']} listing bytes"
    )

    # The backend validates SKILL.md `toolsets:` and computes board coverage
    # from this projection; it cannot import the mcp package.
    backend_out = REPO_ROOT / "backend" / "app" / "data" / "mcp_toolsets.json"
    backend_out.parent.mkdir(parents=True, exist_ok=True)
    backend_toolsets = build_backend_toolsets(mcp)
    backend_out.write_text(
        json.dumps(backend_toolsets, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    )
    print(
        f"{backend_out.relative_to(REPO_ROOT)}: {len(backend_toolsets['toolsets'])} toolsets"
    )

if __name__ == "__main__":
    main()
