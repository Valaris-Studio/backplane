# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Drift guard: the in-app MCP reference docs must document the real params.

The existing guards cover tool *names* only (toolDocs.parity.test.ts,
backend/tests/test_mcp_catalog_drift.py, test_tool_catalog_fixture.py). Nothing
compared each ToolDoc's `params` block to the live FastMCP input schema, so a
param added, renamed, or flipped between optional and required left the
ParamsGrid silently wrong while every gate stayed green.

This test lives on the mcp-server side because FastMCP is not a backend
dependency — only here can the live tool schemas be introspected. It parses the
TypeScript docs data with a targeted regex sweep, following the
Python-parses-TS precedent in backend/tests/test_mcp_catalog_drift.py, rather
than introducing a checked-in params fixture that would itself need a
freshness guard.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCS_DATA_DIR = (
    REPO_ROOT / "frontend" / "src" / "pages" / "documentation" / "mcp-reference" / "data"
)

# Params intentionally absent from the docs, with the reason. Adding an entry
# here is a deliberate editorial decision — never a way to silence real drift.
UNDOCUMENTED_PARAMS: dict[str, set[str]] = {}

_ENTRY_NAME_RE = re.compile(r'^\s{4}name:\s*"([a-z0-9_]+)",\s*$', re.MULTILINE)
_PARAM_RE = re.compile(
    r'\{\s*name:\s*"([A-Za-z0-9_]+)",\s*required:\s*(true|false)\s*,',
)


def _params_block(entry_body: str) -> str:
    """Slice the `params: [...]` array, honoring brackets inside string literals.

    Param descriptions routinely embed JSON-shape hints like `[{"text"}]`, so a
    naive search for the first `]` truncates the block mid-array and silently
    under-reports the documented params — a false-positive drift generator.
    Depth counting outside of quotes is what makes the slice trustworthy.
    """
    start = entry_body.find("params: [")
    if start == -1:
        return ""
    open_bracket = entry_body.index("[", start)
    depth = 0
    quote: str | None = None
    escaped = False
    for index in range(open_bracket, len(entry_body)):
        char = entry_body[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in "\"'":
            quote = char
        elif char == "[":
            depth += 1
        elif char == "]":
            depth -= 1
            if depth == 0:
                return entry_body[open_bracket : index + 1]
    raise AssertionError("unterminated params array in mcp-reference docs data")


def _documented_params_by_tool() -> dict[str, dict[str, bool]]:
    """Map each documented tool to {param_name: required}.

    Tool entries are top-level objects in a `ToolDoc[]` literal, so their `name:`
    key sits at exactly 4-space indentation while nested param `name:` keys are
    deeper — that indentation is what separates the two without a real TS parser.
    """
    docs: dict[str, dict[str, bool]] = {}
    for path in sorted(DOCS_DATA_DIR.glob("*.ts")):
        text = path.read_text()
        matches = list(_ENTRY_NAME_RE.finditer(text))
        for index, match in enumerate(matches):
            end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
            params_block = _params_block(text[match.end() : end])
            docs[match.group(1)] = {
                name: required == "true"
                for name, required in _PARAM_RE.findall(params_block)
            }
    return docs


def _live_params_by_tool() -> dict[str, dict[str, bool]]:
    from valaris_mcp.server import mcp

    live: dict[str, dict[str, bool]] = {}
    for name, tool in mcp._tool_manager._tools.items():
        schema = tool.parameters
        required = set(schema.get("required", []))
        live[name] = {param: param in required for param in schema.get("properties", {})}
    return live


def test_docs_parser_finds_the_documented_tools():
    # Guards the parser itself: a regex that silently matches nothing would
    # false-green every assertion below.
    docs = _documented_params_by_tool()
    assert len(docs) > 40, f"docs parser found only {len(docs)} tools — regex is broken"
    assert docs["add_card_dependency"] == {
        "workspace_slug": True,
        "board_id": True,
        "card_id": True,
        "depends_on_card_id": True,
    }


def test_params_block_survives_brackets_inside_descriptions():
    # create_board documents JSON-shape hints like [{"text", "priority"?}] in its
    # param descriptions; a depth-blind slice stops there and drops every later
    # param, reporting drift that does not exist.
    entry = """
    params: [
      { name: "objectives", required: false, description: 'Goals, as [{"text"}].' },
      { name: "coding_standards", required: false, description: "Standards." },
    ],
    """
    assert dict(_PARAM_RE.findall(_params_block(entry))) == {
        "objectives": "false",
        "coding_standards": "false",
    }


def test_tool_docs_params_match_live_schemas():
    docs = _documented_params_by_tool()
    live = _live_params_by_tool()

    drift: list[str] = []
    for tool_name, live_params in sorted(live.items()):
        documented = docs.get(tool_name)
        if documented is None:
            # Name-level parity is guarded elsewhere; skip so a name gap is
            # reported by its own test rather than doubled up here.
            continue
        exempt = UNDOCUMENTED_PARAMS.get(tool_name, set())
        missing = sorted(set(live_params) - set(documented) - exempt)
        extra = sorted(set(documented) - set(live_params))
        mismatched = sorted(
            f"{param} (docs says required={documented[param]}, "
            f"server says required={live_params[param]})"
            for param in set(documented) & set(live_params)
            if documented[param] != live_params[param]
        )
        if missing or extra or mismatched:
            drift.append(
                f"{tool_name}:\n"
                f"  missing in docs: {missing}\n"
                f"  extra in docs (no such server param): {extra}\n"
                f"  required-flag mismatch: {mismatched}"
            )

    assert not drift, (
        "MCP reference docs params are out of sync with the live tool schemas.\n"
        "Fix frontend/src/pages/documentation/mcp-reference/data/*.ts:\n\n"
        + "\n".join(drift)
    )
