# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The MCP server's toolset taxonomy, as the backend sees it.

The backend never imports the mcp-server package; it reads the generated copy
`app/data/mcp_toolsets.json` written by
`mcp-server/scripts/export-tool-catalog.py` (the same objects as the frontend's
server-surface.json). Loaded once at import — the taxonomy only changes with a
deploy.
"""

import json
from collections.abc import Iterable
from pathlib import Path

from app.exceptions import ValidationError

_FIXTURE_PATH = Path(__file__).resolve().parents[2] / "data" / "mcp_toolsets.json"


def _load_fixture() -> dict:
    return json.loads(_FIXTURE_PATH.read_text(encoding="utf-8"))


_FIXTURE = _load_fixture()

_TOOLS_BY_ID: dict[str, frozenset[str]] = {
    toolset["id"]: frozenset(toolset["tools"]) for toolset in _FIXTURE["toolsets"]
}

TOOLSET_IDS: tuple[str, ...] = tuple(_TOOLS_BY_ID)

# Groups partition the surface, so their union IS the registered tool set.
ALL_TOOLS: frozenset[str] = frozenset().union(
    *(
        frozenset(toolset["tools"])
        for toolset in _FIXTURE["toolsets"]
        if toolset["kind"] == "group"
    )
)

DEFAULT_TOOLSET_IDS: tuple[str, ...] = tuple(_FIXTURE["default"]["ids"])


def tools_for(toolset_ids: Iterable[str]) -> frozenset[str]:
    """Union of the tools in the given toolsets; ValueError names an unknown id."""
    tools: set[str] = set()
    for toolset_id in toolset_ids:
        if toolset_id not in _TOOLS_BY_ID:
            raise ValueError(f"Unknown toolset id: {toolset_id}")
        tools |= _TOOLS_BY_ID[toolset_id]
    return frozenset(tools)


def tools_for_known(toolset_ids: Iterable[str]) -> frozenset[str]:
    """Like tools_for, but an unknown id contributes nothing instead of
    raising — for READ paths over rows whose frontmatter predates validation."""
    return frozenset().union(
        *(_TOOLS_BY_ID[t] for t in toolset_ids if t in _TOOLS_BY_ID)
    )


def validate_toolset_ids(toolset_ids: Iterable[str]) -> list[str]:
    """De-duplicate preserving order; unknown ids are a 422 that lists every
    valid id so the error is self-explanatory on the wire."""
    deduped = list(dict.fromkeys(toolset_ids))
    unknown = [toolset_id for toolset_id in deduped if toolset_id not in _TOOLS_BY_ID]
    if unknown:
        raise ValidationError(
            f"Unknown toolset id(s): {unknown}; valid ids: {list(TOOLSET_IDS)}"
        )
    return deduped


def toolsets_of_tool(tool_name: str) -> list[str]:
    """Every toolset (group and category) containing the tool, in taxonomy order."""
    return [
        toolset_id for toolset_id, tools in _TOOLS_BY_ID.items() if tool_name in tools
    ]
