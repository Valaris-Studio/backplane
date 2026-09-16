# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Contract tests for the tool catalog seam (`valaris_mcp.catalog`).

The catalog is the ONE table describing every registered tool: category,
kind, MCP annotations, and title. `finalize_tool_surface` applies it to the
FastMCP registry at import time and slims the wire payload (docstring split
into description + per-param descriptions, structured output off, redundant
schema `title`s stripped). These tests pin that contract so a tool added
without a catalog entry, or a docstring that drifts from its schema, fails
loudly instead of shipping a silently degraded listing.
"""
from __future__ import annotations

import inspect
import re

import pytest
from mcp.server.fastmcp import FastMCP

from valaris_mcp.catalog import (
    CATEGORIES,
    GROUPS,
    TOOL_META,
    ToolMeta,
    finalize_tool_surface,
    split_docstring,
    tool_annotations,
    tool_title,
)
from valaris_mcp.server import mcp

pytestmark = pytest.mark.anyio

DESTRUCTIVE_PREFIXES = ("delete_", "hard_delete_", "remove_", "cancel_", "archive_")

IDEMPOTENT_PINS = ("add_card_participant", "set_board_loop", "move_card", "update_card")
NON_IDEMPOTENT_PINS = (
    "create_card",
    "bulk_create_cards",
    "append_note",
    "log_execution_start",
    "restart_agent",
    "rotate_agent_key",
)

# Independent Google-style `Args:` parser so the test does not trust the
# implementation's own split. After `inspect.cleandoc`, the section header sits
# at column 0, entries at exactly 4 spaces, continuation lines deeper.
_ARGS_HEADER_RE = re.compile(r"^Args:\s*$")
_ARG_ENTRY_RE = re.compile(r"^ {4}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$")
_CONTINUATION_RE = re.compile(r"^ {5,}(\S.*)$")


def _documented_args(doc: str) -> dict[str, str]:
    lines = inspect.cleandoc(doc).splitlines()
    args: dict[str, str] = {}
    current: str | None = None
    in_block = False
    for line in lines:
        if not in_block:
            in_block = bool(_ARGS_HEADER_RE.match(line))
            continue
        if line.strip() == "":
            continue
        if not line.startswith(" "):
            break  # a new section header (`Returns:`) or trailing prose ends the block
        entry = _ARG_ENTRY_RE.match(line)
        if entry:
            current = entry.group(1)
            args[current] = entry.group(2).strip()
            continue
        continuation = _CONTINUATION_RE.match(line)
        if continuation and current is not None:
            args[current] = f"{args[current]} {continuation.group(1).strip()}".strip()
    return args


def _registered() -> dict:
    return mcp._tool_manager._tools


# ---------- TOOL_META shape ----------


def test_tool_meta_covers_exactly_the_registered_tools():
    registered = set(_registered())
    catalogued = set(TOOL_META)
    assert catalogued == registered, (
        f"missing from TOOL_META: {sorted(registered - catalogued)}; "
        f"orphans in TOOL_META: {sorted(catalogued - registered)}"
    )


def test_every_tool_meta_category_is_a_registered_category():
    category_ids = {category.id for category in CATEGORIES}
    unknown = sorted(
        f"{name}: {meta.category}"
        for name, meta in TOOL_META.items()
        if meta.category not in category_ids
    )
    assert not unknown, f"tools pointing at unknown categories: {unknown}"


def test_every_category_group_is_in_groups():
    unknown = sorted(
        f"{category.id}: {category.group}"
        for category in CATEGORIES
        if category.group not in GROUPS
    )
    assert not unknown, f"categories pointing at unknown groups: {unknown}"


def test_category_ids_are_unique():
    ids = [category.id for category in CATEGORIES]
    assert len(ids) == len(set(ids))


def test_tool_meta_kind_is_one_of_the_three():
    bad = sorted(
        f"{name}: {meta.kind!r}"
        for name, meta in TOOL_META.items()
        if meta.kind not in ("read", "write", "composite")
    )
    assert not bad, bad


# ---------- annotations ----------


def _annotations_for(name: str):
    return tool_annotations(name, TOOL_META[name])


def test_destructive_verb_prefixes_carry_destructive_hint():
    verb_tools = [name for name in TOOL_META if name.startswith(DESTRUCTIVE_PREFIXES)]
    assert verb_tools, "no destructive-verb tools found — prefix list or registry broken"
    not_flagged = [
        name for name in verb_tools if _annotations_for(name).destructiveHint is not True
    ]
    assert not not_flagged, f"destructive verbs without destructiveHint=True: {not_flagged}"


@pytest.mark.parametrize("name", IDEMPOTENT_PINS)
def test_idempotent_pinned_tools_carry_idempotent_hint(name: str):
    assert _annotations_for(name).idempotentHint is True


@pytest.mark.parametrize("name", NON_IDEMPOTENT_PINS)
def test_non_idempotent_pinned_tools_do_not_carry_idempotent_hint(name: str):
    assert _annotations_for(name).idempotentHint is False


def test_read_kind_tools_are_read_only_safe_and_idempotent():
    read_tools = [name for name, meta in TOOL_META.items() if meta.kind == "read"]
    assert read_tools
    wrong = [
        name
        for name in read_tools
        if not (
            _annotations_for(name).readOnlyHint is True
            and _annotations_for(name).destructiveHint is False
            and _annotations_for(name).idempotentHint is True
        )
    ]
    assert not wrong, f"read tools with non-read-only annotations: {wrong}"


def test_write_and_composite_tools_are_not_read_only():
    # Composite tools that only read (briefings, exports) opt in via read_only=True.
    mutating = [
        name for name, meta in TOOL_META.items() if meta.kind != "read" and not meta.read_only
    ]
    wrong = [name for name in mutating if _annotations_for(name).readOnlyHint is not False]
    assert not wrong, f"mutating tools flagged read-only: {wrong}"


def test_every_registered_tool_has_annotations_with_all_three_hints():
    missing = []
    for name, tool in sorted(_registered().items()):
        annotations = tool.annotations
        if annotations is None or any(
            hint is None
            for hint in (
                annotations.readOnlyHint,
                annotations.destructiveHint,
                annotations.idempotentHint,
            )
        ):
            missing.append(name)
    assert not missing, f"tools without complete annotations: {missing}"


def test_every_registered_tool_has_a_non_empty_title():
    untitled = [name for name, tool in sorted(_registered().items()) if not tool.title]
    assert not untitled, f"tools without a title: {untitled}"


def test_tool_title_defaults_to_humanised_name():
    assert tool_title("get_card", ToolMeta(category="cards", kind="read")) == "Get card"


def test_tool_title_honours_override():
    meta = ToolMeta(category="server-info", kind="read", title="Who am I")
    assert tool_title("whoami", meta) == "Who am I"


def test_whoami_registered_title_is_the_override():
    assert _registered()["whoami"].title == "Who am I"


# ---------- structured output off ----------


def test_no_registered_tool_has_an_output_schema():
    with_schema = [
        name
        for name, tool in sorted(_registered().items())
        if tool.fn_metadata.output_schema is not None
    ]
    assert not with_schema, f"tools still advertising an output schema: {with_schema}"


async def test_listing_shows_no_output_schema():
    with_schema = [tool.name for tool in await mcp.list_tools() if tool.outputSchema is not None]
    assert not with_schema, f"outputSchema still on the wire for: {with_schema}"


# ---------- schema dead weight ----------


def test_no_title_key_in_input_schema_root_or_properties():
    offenders = []
    for name, tool in sorted(_registered().items()):
        schema = tool.parameters
        if "title" in schema:
            offenders.append(f"{name}: root")
        for prop_name, prop in schema.get("properties", {}).items():
            if "title" in prop:
                offenders.append(f"{name}: {prop_name}")
    assert not offenders, f"redundant schema titles: {offenders}"


# ---------- docstring split landed on the wire ----------


def test_every_documented_arg_is_the_property_description():
    drift = []
    for name, tool in sorted(_registered().items()):
        documented = _documented_args(tool.fn.__doc__ or "")
        properties = tool.parameters.get("properties", {})
        for arg, text in documented.items():
            if arg not in properties:
                drift.append(f"{name}.{arg}: documented but not in schema")
            elif properties[arg].get("description") != text:
                drift.append(
                    f"{name}.{arg}: schema says {properties[arg].get('description')!r}, "
                    f"docstring says {text!r}"
                )
    assert not drift, "\n".join(drift)


def test_every_schema_property_has_a_non_empty_description():
    undocumented = [
        f"{name}.{prop_name}"
        for name, tool in sorted(_registered().items())
        for prop_name, prop in tool.parameters.get("properties", {}).items()
        if not prop.get("description")
    ]
    assert not undocumented, f"schema properties without a description: {undocumented}"


def test_wire_description_excludes_the_args_block():
    leaking = [
        name for name, tool in sorted(_registered().items()) if "Args:" in tool.description
    ]
    assert not leaking, f"Args block still inside the wire description: {leaking}"


def test_function_docstrings_are_left_untouched():
    # Other tests pin substrings of `__doc__`; the split must read, not rewrite.
    still_documented = [
        name
        for name, tool in _registered().items()
        if "Args:" in (tool.fn.__doc__ or "")
    ]
    assert len(still_documented) > 100, (
        "tool function __doc__ strings lost their Args blocks — "
        "finalize must not mutate __doc__"
    )


# ---------- split_docstring unit tests ----------


def test_split_docstring_prose_only():
    doc = """Get one thing.

    Second paragraph with detail.
    """
    description, args = split_docstring(doc)
    assert description == "Get one thing.\n\nSecond paragraph with detail."
    assert args == {}


def test_split_docstring_args_with_continuation_lines():
    doc = """Move a card.

    Omit position to append.

    Args:
        workspace_slug: The URL slug identifying
            the workspace.
        position: Optional fractional position;
            omitted appends
            to the column.
    """
    description, args = split_docstring(doc)
    assert description == "Move a card.\n\nOmit position to append."
    assert args == {
        "workspace_slug": "The URL slug identifying the workspace.",
        "position": "Optional fractional position; omitted appends to the column.",
    }


def test_split_docstring_keeps_returns_in_description_not_args():
    doc = """Report server info.

    Args:
        verbose: Include everything.

    Returns:
        version: the package version.
        tools: every tool.
    """
    description, args = split_docstring(doc)
    assert args == {"verbose": "Include everything."}
    assert description.startswith("Report server info.\n\nReturns:")
    assert "version: the package version." in description
    assert "tools: every tool." in description
    assert "Args:" not in description
    assert "Include everything." not in description


def test_split_docstring_empty_doc():
    assert split_docstring("") == ("", {})


# ---------- finalize_tool_surface fail-loud checks ----------


def test_finalize_raises_when_an_args_entry_names_an_unknown_param(monkeypatch):
    fake = FastMCP("t")

    @fake.tool()
    def ping(host: str) -> str:
        """Ping a host.

        Args:
            host: Hostname.
            timeout_ms: Not a real parameter.
        """
        return host

    monkeypatch.setattr(
        "valaris_mcp.catalog.TOOL_META", {"ping": ToolMeta(category="health", kind="read")}
    )
    with pytest.raises(RuntimeError) as excinfo:
        finalize_tool_surface(fake)
    assert "ping" in str(excinfo.value)
    assert "timeout_ms" in str(excinfo.value)


def test_finalize_raises_when_a_tool_is_missing_from_tool_meta(monkeypatch):
    fake = FastMCP("t")

    @fake.tool()
    def orphan_tool(value: str) -> str:
        """Do a thing.

        Args:
            value: Something.
        """
        return value

    monkeypatch.setattr("valaris_mcp.catalog.TOOL_META", {})
    with pytest.raises(RuntimeError, match="orphan_tool"):
        finalize_tool_surface(fake)


def test_finalize_raises_when_tool_meta_has_an_orphan_entry(monkeypatch):
    fake = FastMCP("t")

    @fake.tool()
    def real_tool(value: str) -> str:
        """Do a thing.

        Args:
            value: Something.
        """
        return value

    monkeypatch.setattr(
        "valaris_mcp.catalog.TOOL_META",
        {
            "real_tool": ToolMeta(category="health", kind="read"),
            "ghost_tool": ToolMeta(category="health", kind="read"),
        },
    )
    with pytest.raises(RuntimeError, match="ghost_tool"):
        finalize_tool_surface(fake)


async def test_finalize_applies_the_full_seam_to_a_fake_server(monkeypatch):
    fake = FastMCP("t")

    @fake.tool()
    def delete_widget(widget_id: str, force: bool = False) -> str:
        """Delete a widget.

        Hard-deletes; there is no undo.

        Args:
            widget_id: Widget UUID.
            force: Skip the safety check.
        """
        return widget_id

    monkeypatch.setattr(
        "valaris_mcp.catalog.TOOL_META",
        {"delete_widget": ToolMeta(category="cards", kind="write", destructive=True)},
    )
    finalize_tool_surface(fake)

    (listed,) = await fake.list_tools()
    assert listed.title == "Delete widget"
    assert listed.description == "Delete a widget.\n\nHard-deletes; there is no undo."
    assert listed.outputSchema is None
    assert listed.annotations is not None
    assert listed.annotations.readOnlyHint is False
    assert listed.annotations.destructiveHint is True
    assert listed.annotations.idempotentHint is False
    assert "title" not in listed.inputSchema
    properties = listed.inputSchema["properties"]
    assert properties["widget_id"] == {"type": "string", "description": "Widget UUID."}
    assert properties["force"]["description"] == "Skip the safety check."
    assert "title" not in properties["force"]
    assert properties["force"]["default"] is False
    assert listed.inputSchema["required"] == ["widget_id"]
    assert delete_widget.__doc__.lstrip().startswith("Delete a widget.")
    assert "Args:" in delete_widget.__doc__
