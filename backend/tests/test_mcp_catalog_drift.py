# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Drift guards: frontend catalogs must match the MCP server's decorators.

- VALARIS_MCP_NAMES in toolCatalog.ts <-> `@mcp.tool()` in tools/*.py
- PROMPT_NAMES in mcp-reference data <-> `@mcp.prompt()` in prompts.py
- RESOURCE_DOCS uris in mcp-reference data <-> `@mcp.resource(uri)` in resources.py

When a tool/prompt/resource is added/removed/renamed, the matching test fails
with a diff — the operator knows which frontend list to update.
"""
import ast
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MCP_TOOLS_DIR = REPO_ROOT / "mcp-server" / "src" / "valaris_mcp" / "tools"
MCP_PROMPTS_FILE = REPO_ROOT / "mcp-server" / "src" / "valaris_mcp" / "prompts.py"
MCP_RESOURCES_FILE = REPO_ROOT / "mcp-server" / "src" / "valaris_mcp" / "resources.py"
FRONTEND_CATALOG = (
    REPO_ROOT / "frontend" / "src" / "features" / "agents" / "lib" / "toolCatalog.ts"
)
FRONTEND_PROMPT_CATALOG = (
    REPO_ROOT
    / "frontend"
    / "src"
    / "pages"
    / "documentation"
    / "mcp-reference"
    / "data"
    / "prompts-resources.ts"
)


def collect_decorated_names(path: Path, decorator_attr: str) -> set[str]:
    names: set[str] = set()
    tree = ast.parse(path.read_text(), filename=str(path))
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for dec in node.decorator_list:
            # Matches @mcp.<attr>() and @mcp.<attr>.
            target = dec.func if isinstance(dec, ast.Call) else dec
            if (
                isinstance(target, ast.Attribute)
                and target.attr == decorator_attr
                and isinstance(target.value, ast.Name)
                and target.value.id == "mcp"
            ):
                names.add(node.name)
    return names


def collect_mcp_tool_names() -> set[str]:
    names: set[str] = set()
    for path in MCP_TOOLS_DIR.glob("*.py"):
        if path.name.startswith("_"):
            continue
        names |= collect_decorated_names(path, "tool")
    return names


def _collect_quoted_names(path: Path, array_name: str) -> set[str]:
    text = path.read_text()
    match = re.search(
        rf"const {array_name} = \[(.*?)\] as const;", text, re.DOTALL,
    )
    assert match, f"{array_name} block not found in {path.name}"
    # Charset must include digits — a bare [a-z_] would silently drop
    # digit-bearing names, false-greening the extra-in-frontend direction.
    return set(re.findall(r'"([a-z0-9_]+)"', match.group(1)))


def collect_frontend_tool_names() -> set[str]:
    return _collect_quoted_names(FRONTEND_CATALOG, "VALARIS_MCP_NAMES")


def collect_frontend_prompt_names() -> set[str]:
    return _collect_quoted_names(FRONTEND_PROMPT_CATALOG, "PROMPT_NAMES")


def collect_mcp_resource_uris() -> set[str]:
    # A resource's identity is the URI passed to @mcp.resource(...), not the
    # function name, so this walks Call decorators unlike collect_decorated_names.
    uris: set[str] = set()
    tree = ast.parse(MCP_RESOURCES_FILE.read_text(), filename=str(MCP_RESOURCES_FILE))
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for dec in node.decorator_list:
            if (
                isinstance(dec, ast.Call)
                and isinstance(dec.func, ast.Attribute)
                and dec.func.attr == "resource"
                and isinstance(dec.func.value, ast.Name)
                and dec.func.value.id == "mcp"
                and dec.args
                and isinstance(dec.args[0], ast.Constant)
            ):
                uris.add(dec.args[0].value)
    return uris


def collect_frontend_resource_uris() -> set[str]:
    text = FRONTEND_PROMPT_CATALOG.read_text()
    match = re.search(r"const RESOURCE_DOCS[^=]*=\s*\[(.*?)\];", text, re.DOTALL)
    assert match, "RESOURCE_DOCS block not found in prompts-resources.ts"
    return set(re.findall(r'uri:\s*"([^"]+)"', match.group(1)))


def test_valaris_mcp_catalog_matches_decorators():
    backend = collect_mcp_tool_names()
    frontend = collect_frontend_tool_names()
    missing_in_frontend = sorted(backend - frontend)
    extra_in_frontend = sorted(frontend - backend)
    assert not missing_in_frontend and not extra_in_frontend, (
        "Frontend tool catalog is out of sync with MCP @mcp.tool() decorators.\n"
        f"Missing in frontend (add to VALARIS_MCP_NAMES): {missing_in_frontend}\n"
        f"Extra in frontend (remove from VALARIS_MCP_NAMES): {extra_in_frontend}"
    )


def test_prompt_catalog_matches_decorators():
    backend = collect_decorated_names(MCP_PROMPTS_FILE, "prompt")
    frontend = collect_frontend_prompt_names()
    missing_in_frontend = sorted(backend - frontend)
    extra_in_frontend = sorted(frontend - backend)
    assert not missing_in_frontend and not extra_in_frontend, (
        "Frontend prompt catalog is out of sync with MCP @mcp.prompt() decorators.\n"
        f"Missing in frontend (add to PROMPT_NAMES): {missing_in_frontend}\n"
        f"Extra in frontend (remove from PROMPT_NAMES): {extra_in_frontend}"
    )


def test_resource_catalog_matches_decorators():
    backend = collect_mcp_resource_uris()
    frontend = collect_frontend_resource_uris()
    missing_in_frontend = sorted(backend - frontend)
    extra_in_frontend = sorted(frontend - backend)
    assert not missing_in_frontend and not extra_in_frontend, (
        "Frontend resource catalog is out of sync with @mcp.resource() uris.\n"
        f"Missing in frontend (add to RESOURCE_DOCS): {missing_in_frontend}\n"
        f"Extra in frontend (remove from RESOURCE_DOCS): {extra_in_frontend}"
    )
