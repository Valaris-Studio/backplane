# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Toolset fixture loader — app.services.skills.toolsets (MCP #3, card 3c690fb6).

RED phase. The backend needs the MCP server's toolset taxonomy at runtime
(to validate a skill's `toolsets:` declaration and lint its prose) without
importing the mcp-server package. The export script writes a THIRD generated
copy, backend/app/data/mcp_toolsets.json, and this module loads it once.

Every expected id/tool below is DERIVED from the already-generated
frontend fixture (server-surface.json) — nothing is hand-typed, so the
taxonomy can grow without touching this file; only the two generated copies
must agree.
"""

import json
from pathlib import Path

import pytest


BACKEND_ROOT = Path(__file__).resolve().parents[3]
REPO_ROOT = BACKEND_ROOT.parent
BACKEND_FIXTURE = BACKEND_ROOT / "app" / "data" / "mcp_toolsets.json"
SERVER_SURFACE = (
    REPO_ROOT
    / "frontend/src/pages/documentation/mcp-reference/data/server-surface.json"
)


def _surface() -> dict:
    return json.loads(SERVER_SURFACE.read_text())


def _surface_toolset(toolset_id: str) -> dict:
    return next(t for t in _surface()["toolsets"] if t["id"] == toolset_id)


def _group_id_of(category: dict) -> str:
    """Category entries name their group by TITLE (`group: "Work management"`);
    resolve that back to the group entry's id."""
    return next(
        t["id"]
        for t in _surface()["toolsets"]
        if t["kind"] == "group" and t["title"] == category["group"]
    )


# --- fixture file freshness --------------------------------------------------


def test_backend_toolsets_fixture_exists():
    assert BACKEND_FIXTURE.is_file(), (
        f"{BACKEND_FIXTURE} missing — regenerate with "
        "`python mcp-server/scripts/export-tool-catalog.py`"
    )


def test_backend_toolsets_fixture_matches_server_surface():
    """Two generated copies of one taxonomy: the frontend's server-surface.json
    and the backend's mcp_toolsets.json must be byte-for-byte the same objects
    (toolsets[] and the default hand), or a skill validated server-side will
    disagree with the picker the docs render."""
    backend = json.loads(BACKEND_FIXTURE.read_text())
    surface = _surface()
    assert backend["toolsets"] == surface["toolsets"]
    assert backend["default"] == surface["default_toolset"]
    assert backend["tool_count"] == surface["tool_count"]


def test_backend_toolsets_fixture_is_canonically_serialized():
    """Same dump contract as the other generated copies: indent=2, sorted
    keys, non-ASCII preserved, trailing newline — so a regen is a no-op diff."""
    raw = BACKEND_FIXTURE.read_text()
    expected = (
        json.dumps(json.loads(raw), indent=2, sort_keys=True, ensure_ascii=False)
        + "\n"
    )
    assert raw == expected


# --- module surface ----------------------------------------------------------


def test_toolset_ids_match_fixture_in_taxonomy_order():
    from app.services.skills.toolsets import TOOLSET_IDS

    expected = tuple(t["id"] for t in _surface()["toolsets"])
    assert isinstance(TOOLSET_IDS, tuple)
    assert TOOLSET_IDS == expected


def test_all_tools_is_the_union_of_group_toolsets():
    from app.services.skills.toolsets import ALL_TOOLS

    surface = _surface()
    expected: set[str] = set()
    for toolset in surface["toolsets"]:
        if toolset["kind"] == "group":
            expected.update(toolset["tools"])
    assert isinstance(ALL_TOOLS, frozenset)
    assert ALL_TOOLS == expected
    # The groups partition the whole surface — nothing lives outside them.
    assert len(ALL_TOOLS) == surface["tool_count"]


def test_tools_for_single_category():
    from app.services.skills.toolsets import tools_for

    assert tools_for(["cards"]) == frozenset(_surface_toolset("cards")["tools"])


def test_tools_for_union_of_group_and_category():
    from app.services.skills.toolsets import tools_for

    expected = set(_surface_toolset("work-management")["tools"]) | set(
        _surface_toolset("notes")["tools"]
    )
    result = tools_for(["work-management", "notes"])
    assert isinstance(result, frozenset)
    assert result == expected


def test_tools_for_empty_is_empty():
    from app.services.skills.toolsets import tools_for

    assert tools_for([]) == frozenset()


def test_tools_for_unknown_id_raises_value_error_naming_it():
    from app.services.skills.toolsets import tools_for

    with pytest.raises(ValueError) as excinfo:
        tools_for(["bogus"])
    assert "bogus" in str(excinfo.value)


def test_validate_toolset_ids_dedupes_preserving_order():
    from app.services.skills.toolsets import validate_toolset_ids

    assert validate_toolset_ids(["cards", "cards", "notes"]) == ["cards", "notes"]
    assert validate_toolset_ids(["notes", "cards", "notes"]) == ["notes", "cards"]
    assert validate_toolset_ids([]) == []


def test_validate_toolset_ids_unknown_raises_422_naming_id_and_valid_ids():
    # Same exception class validate_files raises for a 422 (app.exceptions).
    from app.exceptions import ValidationError
    from app.services.skills.toolsets import TOOLSET_IDS, validate_toolset_ids

    with pytest.raises(ValidationError) as excinfo:
        validate_toolset_ids(["nope"])
    message = str(excinfo.value.detail)
    assert "nope" in message
    assert "valid" in message
    # The valid list rides in the message so a 422 is self-explanatory.
    for toolset_id in TOOLSET_IDS:
        assert toolset_id in message, toolset_id


def test_validate_toolset_ids_reports_every_unknown_id():
    from app.exceptions import ValidationError
    from app.services.skills.toolsets import validate_toolset_ids

    with pytest.raises(ValidationError) as excinfo:
        validate_toolset_ids(["cards", "nope", "also-nope"])
    message = str(excinfo.value.detail)
    assert "nope" in message
    assert "also-nope" in message


def test_toolsets_of_tool_lists_category_and_its_group():
    from app.services.skills.toolsets import toolsets_of_tool

    cards = _surface_toolset("cards")
    result = toolsets_of_tool("get_card")
    assert isinstance(result, list)
    assert "cards" in result
    assert _group_id_of(cards) in result
    # Membership is exact: every listed toolset really contains the tool.
    for toolset_id in result:
        assert "get_card" in _surface_toolset(toolset_id)["tools"], toolset_id


def test_toolsets_of_tool_covers_every_registered_tool():
    from app.services.skills.toolsets import ALL_TOOLS, toolsets_of_tool

    for tool in sorted(ALL_TOOLS):
        owners = toolsets_of_tool(tool)
        kinds = {_surface_toolset(t)["kind"] for t in owners}
        # Every tool belongs to exactly one group (the groups partition the
        # surface) and at least one category.
        assert "group" in kinds, tool
        assert "category" in kinds, tool


def test_toolsets_of_tool_unknown_is_empty():
    from app.services.skills.toolsets import toolsets_of_tool

    assert toolsets_of_tool("not_a_tool") == []
