# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import ast
import re
from pathlib import Path

from valaris_mcp.catalog import TOOL_META
from valaris_mcp.server import mcp


def test_private_session_readers_are_absent_from_the_complete_mcp_registry():
    registered = set(mcp._tool_manager._tools)
    assert registered == set(TOOL_META)
    assert {"search_cards", "create_note", "get_card"} <= registered
    private_readers = {
        name
        for name in registered
        if "session" in name
        and any(word in name for word in ("search", "content", "transcript", "call", "window"))
    }
    assert private_readers == set()


def test_mcp_source_has_no_route_to_private_session_search_or_content():
    package = Path(__file__).resolve().parents[1] / "src" / "valaris_mcp"
    routed_sources = []
    for source in package.rglob("*.py"):
        for node in ast.walk(ast.parse(source.read_text())):
            route = ""
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                route = node.value
            elif isinstance(node, ast.JoinedStr):
                route = "".join(part.value if isinstance(part, ast.Constant) else "{id}" for part in node.values)
            if re.search(r"/sessions/[^/]+/(?:search|contents|calls)(?:/|$)", route):
                routed_sources.append(f"{source.relative_to(package)}:{node.lineno}")
    assert routed_sources == []
