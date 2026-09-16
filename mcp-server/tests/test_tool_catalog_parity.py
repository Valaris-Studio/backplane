# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Parity between the server catalog and the in-app MCP reference data.

The frontend ToolDoc entries carry `kind`, `category`, and an optional
`danger` blurb; `categories.ts` carries the id/title/group registry and the
sidebar GROUPS. The server's `catalog.py` now owns the same facts, so the two
must agree entry for entry. Regex-parsed from TypeScript following the
precedent in test_tool_docs_params_drift.py.
"""
from __future__ import annotations

import re
from pathlib import Path

from valaris_mcp.catalog import CATEGORIES, GROUPS, TOOL_META, live_tool_names, tool_annotations

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCS_DATA_DIR = (
    REPO_ROOT / "frontend" / "src" / "pages" / "documentation" / "mcp-reference" / "data"
)
CATEGORIES_TS = DOCS_DATA_DIR / "categories.ts"

# Top-level ToolDoc entries sit at 4-space indentation inside a `ToolDoc[]`
# literal; nested param `name:` keys are deeper, prompt/resource docs carry
# `role:`/`uri:` instead of `kind:` and are filtered out by the kind check.
_ENTRY_NAME_RE = re.compile(r'^\s{4}name:\s*"([a-z0-9_]+)",\s*$', re.MULTILINE)
_CATEGORY_RE = re.compile(r'^\s{4}category:\s*"([a-z0-9-]+)",\s*$', re.MULTILINE)
_KIND_RE = re.compile(r'^\s{4}kind:\s*"(read|write|composite)",\s*$', re.MULTILINE)
_DANGER_RE = re.compile(r"^\s{4}danger:", re.MULTILINE)

_CATEGORY_ENTRY_RE = re.compile(
    r'\{\s*id:\s*"([^"]+)",\s*title:\s*"([^"]+)",\s*group:\s*"([^"]+)",',
)
_QUOTED_RE = re.compile(r'"([^"]+)"')


def _documented_tools() -> dict[str, dict]:
    docs: dict[str, dict] = {}
    for path in sorted(DOCS_DATA_DIR.glob("*.ts")):
        text = path.read_text()
        matches = list(_ENTRY_NAME_RE.finditer(text))
        for index, match in enumerate(matches):
            end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
            body = text[match.end() : end]
            kind = _KIND_RE.search(body)
            if kind is None:
                continue
            category = _CATEGORY_RE.search(body)
            docs[match.group(1)] = {
                "kind": kind.group(1),
                "category": category.group(1) if category else None,
                "danger": _DANGER_RE.search(body) is not None,
            }
    return docs


def _frontend_categories() -> list[tuple[str, str, str]]:
    text = CATEGORIES_TS.read_text()
    start = text.index("export const CATEGORIES")
    return _CATEGORY_ENTRY_RE.findall(text[start:])


def _frontend_groups() -> list[str]:
    text = CATEGORIES_TS.read_text()
    start = text.index("export const GROUPS = [")
    end = text.index("]", start)
    return _QUOTED_RE.findall(text[start:end])


def test_docs_parser_finds_the_documented_tools():
    docs = _documented_tools()
    assert len(docs) > 100, f"docs parser found only {len(docs)} tools — regex is broken"
    assert docs["get_card"] == {"kind": "read", "category": "cards", "danger": False}
    assert docs["update_workspace_config"]["danger"] is True
    assert len(_frontend_categories()) > 20
    assert len(_frontend_groups()) == 5


def test_frontend_and_catalog_document_the_same_tools():
    # Deprecated aliases are not documented as tools: the reference lists
    # them under their replacement via server-surface.json's `deprecated`.
    docs = _documented_tools()
    live = set(live_tool_names())
    assert set(docs) == live, (
        f"only in frontend docs: {sorted(set(docs) - live)}; "
        f"only in TOOL_META: {sorted(live - set(docs))}"
    )


def test_kind_and_category_match_per_tool():
    docs = _documented_tools()
    drift = []
    for name, meta in sorted(TOOL_META.items()):
        doc = docs.get(name)
        if doc is None:
            continue  # name-level parity is reported by its own test
        if doc["kind"] != meta.kind:
            drift.append(f"{name}: frontend kind={doc['kind']} server kind={meta.kind}")
        if doc["category"] != meta.category:
            drift.append(
                f"{name}: frontend category={doc['category']} server category={meta.category}"
            )
    assert not drift, "\n".join(drift)


def test_frontend_danger_tools_are_destructive_on_the_server():
    docs = _documented_tools()
    danger_tools = sorted(name for name, doc in docs.items() if doc["danger"])
    assert danger_tools, "no danger: entries found — parser regex is broken"
    not_destructive = [
        name
        for name in danger_tools
        if name in TOOL_META
        and tool_annotations(name, TOOL_META[name]).destructiveHint is not True
    ]
    assert not not_destructive, (
        f"frontend flags these as danger but the server does not annotate them "
        f"destructive: {not_destructive}"
    )


def test_categories_match_in_order():
    server_side = [(c.id, c.title, c.group) for c in CATEGORIES]
    assert server_side == _frontend_categories()


def test_groups_match_in_order():
    assert list(GROUPS) == _frontend_groups()


# ---------- group ids (MCP #2 toolsets) ----------

# Toolset ids are slugs; the GROUP_IDS literal must carry them as string
# literals (bare or inside `{ id: "..." }` objects) so parity is checkable
# statically. A computed `GROUPS.map(...)` cannot be verified from here.
_SLUG_RE = re.compile(r'"([a-z0-9]+(?:-[a-z0-9]+)*)"')


def _frontend_group_ids() -> list[str]:
    text = CATEGORIES_TS.read_text()
    marker = "export const GROUP_IDS"
    assert marker in text, (
        f"{CATEGORIES_TS.relative_to(REPO_ROOT)} does not export GROUP_IDS — "
        "the frontend must derive the toolset group ids next to GROUPS"
    )
    start = text.index(marker)
    end = text.index(";", start)
    return _SLUG_RE.findall(text[start:end])


def test_group_ids_match_in_order():
    frontend_ids = _frontend_group_ids()
    assert frontend_ids, "GROUP_IDS must be a literal list of slug strings"

    from valaris_mcp.catalog import GROUP_IDS

    assert frontend_ids == [group_id for group_id, _title in GROUP_IDS]
