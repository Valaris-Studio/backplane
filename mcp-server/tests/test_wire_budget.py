# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Budget for the `tools/list` payload the model pays for on every session.

Baseline before the slimming pass (2026-09-03): 145 tools, 189,659 bytes of
compact JSON. The ceiling below is the target the seam plus the editorial
docstring pass must land under; the per-description cap keeps any single
tool from re-growing into a manual.

The budget covers the LIVE surface — the most any toolset hand can list.
Deprecated aliases ride only on `all` (or a runner allowlist that still
names one) for one minor version, so they are capped per alias instead of
counted against the ceiling; the alias window is not a licence to regrow.
"""
from __future__ import annotations

import pytest

from valaris_mcp.catalog import deprecated_aliases, live_tool_names
from valaris_mcp.server import mcp

pytestmark = pytest.mark.anyio

FULL_LISTING_BYTE_CEILING = 110_000
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
        f"(ceiling {FULL_LISTING_BYTE_CEILING} B). Heaviest tools:\n{heaviest}"
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
