# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Budget for the `tools/list` payload the model pays for on every session.

Baseline before the slimming pass (2026-09-03): 145 tools, 189,659 bytes of
compact JSON. 0.9.1 then sat at 109,995 B against a 110,000 B ceiling, and
every addition meant shaving real gotchas off the wire. 0.9.2 moved usage
guidance into the in-app reference ("See docs: <slug>#<anchor>", read with
read_documentation) so the listing carries contracts only.

Two thresholds: past the WARNING the suite warns, so the next addition moves
prose to the docs instead of the wire; past the CEILING it fails. Keep the gap
between the measured size and the ceiling; never raise the ceiling to meet it.
The per-description cap keeps any single tool from re-growing into a manual.

The budget covers the LIVE surface — the most any toolset hand can list.
Deprecated aliases ride only on `all` (or a runner allowlist that still
names one) for one minor version, so they are capped per alias instead of
counted against the ceiling; the alias window is not a licence to regrow.
"""
from __future__ import annotations

import json
import re
import warnings
from pathlib import Path

import pytest

from valaris_mcp.catalog import deprecated_aliases, live_tool_names
from valaris_mcp.server import mcp
from valaris_mcp.toolsets import default_hand

pytestmark = pytest.mark.anyio

FULL_LISTING_BYTE_CEILING = 100_000
FULL_LISTING_WARNING_BYTES = 95_000
# The interactive default hand is what most sessions pay for; 0.9.2 measured
# 43,278 B. Same rule as the full surface: move prose to docs, never raise.
DEFAULT_HAND_BYTE_CEILING = 46_000
DESCRIPTION_CHAR_CAP = 1_000
ALIAS_BYTE_CAP = 1_200


def _compact_bytes(tool) -> int:
    return len(tool.model_dump_json(exclude_none=True, by_alias=True))


async def test_full_listing_fits_the_byte_budget():
    live = set(live_tool_names())
    tools = [tool for tool in await mcp.list_tools() if tool.name in live]
    sizes = sorted(((_compact_bytes(tool), tool.name) for tool in tools), reverse=True)
    total = sum(size for size, _ in sizes)
    heaviest = "\n".join(f"  {name}: {size} B" for size, name in sizes[:10])
    assert total <= FULL_LISTING_BYTE_CEILING, (
        f"tools/list is {total} B over {len(tools)} live tools "
        f"(ceiling {FULL_LISTING_BYTE_CEILING} B). Move usage guidance into the "
        f"tool's in-app reference and point at it. Heaviest tools:\n{heaviest}"
    )
    if total > FULL_LISTING_WARNING_BYTES:
        warnings.warn(
            f"tools/list is {total} B, past the {FULL_LISTING_WARNING_BYTES} B "
            f"warning line (fails at {FULL_LISTING_BYTE_CEILING} B). Heaviest:\n{heaviest}",
            stacklevel=1,
        )


async def test_default_hand_fits_its_byte_budget():
    hand = default_hand()
    sizes = sorted(
        ((_compact_bytes(tool), tool.name) for tool in await mcp.list_tools() if tool.name in hand),
        reverse=True,
    )
    total = sum(size for size, _ in sizes)
    heaviest = "\n".join(f"  {name}: {size} B" for size, name in sizes[:10])
    assert total <= DEFAULT_HAND_BYTE_CEILING, (
        f"default hand tools/list is {total} B over {len(sizes)} tools "
        f"(ceiling {DEFAULT_HAND_BYTE_CEILING} B). Heaviest tools:\n{heaviest}"
    )


async def test_each_deprecated_alias_stays_under_its_byte_cap():
    aliases = set(deprecated_aliases())
    assert aliases
    heavy = sorted(
        (_compact_bytes(tool), tool.name)
        for tool in await mcp.list_tools()
        if tool.name in aliases and _compact_bytes(tool) > ALIAS_BYTE_CAP
    )
    assert not heavy, f"deprecated aliases over {ALIAS_BYTE_CAP} B: {heavy}"


async def test_no_wire_description_exceeds_the_char_cap():
    tools = await mcp.list_tools()
    offenders = sorted(
        ((len(tool.description or ""), tool.name) for tool in tools if len(tool.description or "") > DESCRIPTION_CHAR_CAP),
        reverse=True,
    )
    listing = "\n".join(f"  {name}: {length} chars" for length, name in offenders)
    assert not offenders, (
        f"wire descriptions over {DESCRIPTION_CHAR_CAP} chars:\n{listing}"
    )


REPO_ROOT = Path(__file__).resolve().parents[2]
PRODUCT_DOCS = REPO_ROOT / "backend" / "app" / "data" / "product-documentation.json"
DOCS_MARKER = "See docs."
TOOL_REFERENCE_SLUG = "mcp-tool-catalog"


def _tool_reference_slug(tool_name: str) -> str:
    return f"{TOOL_REFERENCE_SLUG}#tool-{tool_name}"


async def test_every_docs_marker_resolves_in_every_locale():
    # "See docs." is only a relocation if read_documentation(slug=
    # "mcp-tool-catalog#tool-<name>") finds that tool's entry; a dangling
    # marker silently deletes the guidance it replaced.
    catalog = json.loads(PRODUCT_DOCS.read_text())
    marked = sorted(
        tool.name for tool in await mcp.list_tools() if DOCS_MARKER in (tool.description or "")
    )
    assert marked, "no wire description points at the docs"
    dangling = [
        f"{name} ({locale})"
        for name in marked
        for locale, sections in catalog["locales"].items()
        if not any(
            section["slug"] == TOOL_REFERENCE_SLUG
            and f'<a id="tool-{name}"></a>' in section["markdown"]
            for section in sections
        )
    ]
    assert not dangling, "docs markers with no tool entry:\n" + "\n".join(dangling)


async def test_read_documentation_explains_the_docs_marker():
    tool = next(t for t in await mcp.list_tools() if t.name == "read_documentation")
    wire_text = json.dumps(tool.inputSchema) + (tool.description or "")
    assert DOCS_MARKER in wire_text
    assert _tool_reference_slug("<name>") in wire_text
