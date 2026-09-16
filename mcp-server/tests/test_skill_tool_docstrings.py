# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The three skill-reading tools tell the model that skills declare toolsets (MCP #3, card 3c690fb6).

list_skills / get_skill / list_skill_catalog pass the backend JSON through, so
`toolsets`, `uncovered_toolsets` and `lint_warnings` surface without a tool
change — but the wire description has to say so, or the model never looks for
them. One clause each; the per-tool cap from test_wire_budget still applies.
"""
from __future__ import annotations

import pytest

from valaris_mcp.server import mcp

from .test_wire_budget import DESCRIPTION_CHAR_CAP

pytestmark = pytest.mark.anyio

SKILL_READ_TOOLS = ("list_skills", "get_skill", "list_skill_catalog")


async def _wire_descriptions() -> dict[str, str]:
    return {tool.name: tool.description or "" for tool in await mcp.list_tools()}


@pytest.mark.parametrize("tool_name", SKILL_READ_TOOLS)
async def test_skill_read_tool_description_mentions_toolsets(tool_name: str):
    description = (await _wire_descriptions())[tool_name]
    assert "toolsets" in description.lower(), (
        f"{tool_name}: wire description never mentions toolsets, so a model has no "
        f"reason to read the `toolsets` field it now returns:\n{description!r}"
    )


@pytest.mark.parametrize("tool_name", SKILL_READ_TOOLS)
async def test_skill_read_tool_description_stays_under_the_char_cap(tool_name: str):
    description = (await _wire_descriptions())[tool_name]
    assert len(description) <= DESCRIPTION_CHAR_CAP, (
        f"{tool_name}: {len(description)} chars > {DESCRIPTION_CHAR_CAP}"
    )


async def test_skill_read_tool_descriptions_keep_the_args_block_off_the_wire():
    # The toolsets clause belongs in the summary, not smuggled in via Args.
    descriptions = await _wire_descriptions()
    leaking = [name for name in SKILL_READ_TOOLS if "Args:" in descriptions[name]]
    assert not leaking, f"Args block inside the wire description: {leaking}"
