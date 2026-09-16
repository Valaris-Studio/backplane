# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""SKILL.md manifest: the `toolsets:` key and the guidance-vs-hand lint
(MCP #3, card 3c690fb6).

RED phase. Backplane defines exactly ONE frontmatter key of its own,
`toolsets`, an optional list of toolset ids from the MCP fixture. Every other
key still passes through verbatim (the allowed-tools passthrough pin lives in
the router suite and stays untouched). The lint scans a bundle's prose for
tool references outside the declared hand and reports names, never a 4xx.

Expected tool/toolset ids are derived from the generated server-surface.json —
the only hand-picked facts here are which toolset a probe tool is NOT in, and
each such choice is asserted against the fixture before it is relied on.
"""

import json
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[4]
SERVER_SURFACE = (
    REPO_ROOT
    / "frontend/src/pages/documentation/mcp-reference/data/server-surface.json"
)


def _surface_toolset(toolset_id: str) -> dict:
    surface = json.loads(SERVER_SURFACE.read_text())
    return next(t for t in surface["toolsets"] if t["id"] == toolset_id)


def _skill_md(frontmatter_extra: str = "", body: str = "## Steps\n\n1. Go.\n") -> str:
    frontmatter = "name: Manifest Probe\ndescription: Probes the manifest parser.\n"
    if frontmatter_extra:
        frontmatter += frontmatter_extra.rstrip("\n") + "\n"
    return f"---\n{frontmatter}---\n\n{body}"


def _files(frontmatter_extra: str = "", body: str = "## Steps\n\n1. Go.\n") -> list[dict]:
    return [{"path": "SKILL.md", "content": _skill_md(frontmatter_extra, body)}]


@pytest.fixture(autouse=True)
def _probe_tools_are_placed_where_the_tests_assume():
    """The lint cases below lean on three facts about the taxonomy; pin them
    against the fixture so a re-grouping fails HERE with a clear message, not
    inside an unrelated lint assertion."""
    cards = set(_surface_toolset("cards")["tools"])
    assert "get_card" in cards
    assert "move_card" in cards
    assert "delete_workspace" not in cards  # workspaces category
    assert "search_cards" not in cards  # search category (start-here group)
    assert "whoami" not in cards  # server-info category (start-here group)


# --- parse_manifest ----------------------------------------------------------


def test_parse_manifest_flow_style_list():
    from app.services.skills.skill_service import parse_manifest

    manifest = parse_manifest(_skill_md("toolsets: [cards, notes]"))
    assert manifest.name == "Manifest Probe"
    assert manifest.description == "Probes the manifest parser."
    assert manifest.toolsets == ["cards", "notes"]


def test_parse_manifest_comma_style_list():
    from app.services.skills.skill_service import parse_manifest

    manifest = parse_manifest(_skill_md("toolsets: cards, notes"))
    assert manifest.toolsets == ["cards", "notes"]


def test_parse_manifest_block_style_list():
    from app.services.skills.skill_service import parse_manifest

    manifest = parse_manifest(_skill_md("toolsets:\n  - cards\n  - notes"))
    assert manifest.toolsets == ["cards", "notes"]


def test_parse_manifest_single_scalar_value():
    from app.services.skills.skill_service import parse_manifest

    manifest = parse_manifest(_skill_md("toolsets: cards"))
    assert manifest.toolsets == ["cards"]


def test_parse_manifest_absent_toolsets_is_empty_list():
    from app.services.skills.skill_service import parse_manifest

    manifest = parse_manifest(_skill_md())
    assert manifest.toolsets == []


def test_parse_manifest_strips_quotes_from_ids():
    from app.services.skills.skill_service import parse_manifest

    flow = parse_manifest(_skill_md('toolsets: ["cards", \'notes\']'))
    assert flow.toolsets == ["cards", "notes"]
    block = parse_manifest(_skill_md('toolsets:\n  - "cards"\n  - \'notes\''))
    assert block.toolsets == ["cards", "notes"]


def test_parse_manifest_keeps_unknown_keys_verbatim_in_raw():
    from app.services.skills.skill_service import parse_manifest

    manifest = parse_manifest(
        _skill_md("license: MIT\nallowed-tools: [bash]\ntoolsets: [cards]")
    )
    assert manifest.raw["allowed-tools"] == "[bash]"
    assert manifest.raw["license"] == "MIT"
    assert manifest.raw["name"] == "Manifest Probe"
    assert manifest.toolsets == ["cards"]


def test_parse_manifest_does_not_validate_ids():
    """Parsing is syntax only — an unknown id survives to validate_manifest,
    which owns the 422. Catalog tests read entries through parse_manifest and
    must not blow up on the parse step."""
    from app.services.skills.skill_service import parse_manifest

    manifest = parse_manifest(_skill_md("toolsets: [not-a-toolset]"))
    assert manifest.toolsets == ["not-a-toolset"]


def test_parse_manifest_missing_frontmatter_is_422():
    from app.exceptions import ValidationError
    from app.services.skills.skill_service import parse_manifest

    with pytest.raises(ValidationError):
        parse_manifest("# no frontmatter\n")


# --- validate_manifest -------------------------------------------------------


def test_validate_manifest_returns_manifest_with_toolsets():
    from app.services.skills.skill_service import validate_manifest

    manifest = validate_manifest(_files("toolsets: [cards, notes]"))
    assert manifest.name == "Manifest Probe"
    assert manifest.description == "Probes the manifest parser."
    assert manifest.toolsets == ["cards", "notes"]


def test_validate_manifest_dedupes_toolsets_preserving_order():
    from app.services.skills.skill_service import validate_manifest

    manifest = validate_manifest(_files("toolsets: [notes, cards, notes, cards]"))
    assert manifest.toolsets == ["notes", "cards"]


def test_validate_manifest_unknown_toolset_is_422_naming_id_and_valid_ids():
    from app.exceptions import ValidationError
    from app.services.skills.skill_service import validate_manifest
    from app.services.skills.toolsets import TOOLSET_IDS

    with pytest.raises(ValidationError) as excinfo:
        validate_manifest(_files("toolsets: [cards, not-a-toolset]"))
    message = str(excinfo.value.detail)
    assert "not-a-toolset" in message
    assert "valid" in message
    for toolset_id in TOOLSET_IDS:
        assert toolset_id in message, toolset_id


def test_validate_manifest_still_enforces_bundle_rails():
    """validate_manifest is validate_files plus toolsets — the structural 422s
    (no root SKILL.md, missing description) must not be lost on the new path."""
    from app.exceptions import ValidationError
    from app.services.skills.skill_service import validate_manifest

    with pytest.raises(ValidationError):
        validate_manifest([{"path": "README.md", "content": "no manifest"}])
    with pytest.raises(ValidationError):
        validate_manifest(
            [{"path": "SKILL.md", "content": "---\nname: Named\n---\n\nbody\n"}]
        )


def test_validate_files_keeps_its_two_tuple_for_existing_callers():
    from app.services.skills.skill_service import validate_files

    assert validate_files(_files("toolsets: [cards]")) == (
        "Manifest Probe",
        "Probes the manifest parser.",
    )


# --- skill_toolsets (derived at read time) ------------------------------------


def test_skill_toolsets_reads_the_version_manifest():
    from app.models.skills.skill import SkillVersion
    from app.services.skills.skill_service import skill_toolsets

    version = SkillVersion(files=_files("toolsets: [cards, notes]"))
    assert skill_toolsets(version) == ["cards", "notes"]


def test_skill_toolsets_absent_declaration_is_empty():
    from app.models.skills.skill import SkillVersion
    from app.services.skills.skill_service import skill_toolsets

    assert skill_toolsets(SkillVersion(files=_files())) == []


# --- lint_prose_against_toolsets ---------------------------------------------


def test_lint_reports_prefixed_and_bare_tools_outside_declared_toolsets():
    from app.services.skills.skill_service import lint_prose_against_toolsets

    files = _files(
        "toolsets: [cards]",
        body=(
            "Never call mcp__valaris__delete_workspace from a card playbook.\n"
            "Use search_cards before creating a duplicate.\n"
        ),
    )
    assert lint_prose_against_toolsets(files, ["cards"]) == [
        "delete_workspace",
        "search_cards",
    ]


def test_lint_result_is_sorted_and_deduplicated():
    from app.services.skills.skill_service import lint_prose_against_toolsets

    files = _files(
        "toolsets: [cards]",
        body=(
            "search_cards, then search_cards again; whoami first.\n"
            "mcp__valaris__search_cards is the same tool.\n"
        ),
    )
    assert lint_prose_against_toolsets(files, ["cards"]) == ["search_cards", "whoami"]


def test_lint_scans_every_file_in_the_bundle():
    from app.services.skills.skill_service import lint_prose_against_toolsets

    files = _files("toolsets: [cards]", body="Only get_card here.\n")
    files.append(
        {"path": "references/map.md", "content": "Also mcp__valaris__delete_workspace.\n"}
    )
    assert lint_prose_against_toolsets(files, ["cards"]) == ["delete_workspace"]


def test_lint_skipped_when_no_toolsets_declared():
    from app.services.skills.skill_service import lint_prose_against_toolsets

    files = _files(body="mcp__valaris__delete_workspace and search_cards and whoami.\n")
    # Nothing declared, nothing to check — an undeclared skill is never noisy.
    assert lint_prose_against_toolsets(files, []) == []


def test_lint_ignores_tools_inside_declared_toolsets():
    from app.services.skills.skill_service import lint_prose_against_toolsets

    files = _files(
        "toolsets: [cards]",
        body="Call get_card, then mcp__valaris__move_card into the column.\n",
    )
    assert lint_prose_against_toolsets(files, ["cards"]) == []


def test_lint_union_of_declared_toolsets_covers_each_members_tools():
    from app.services.skills.skill_service import lint_prose_against_toolsets

    files = _files(
        "toolsets: [cards, search]",
        body="search_cards first, then get_card.\n",
    )
    assert lint_prose_against_toolsets(files, ["cards", "search"]) == []


def test_lint_ignores_plain_words_that_are_not_tool_names():
    from app.services.skills.skill_service import lint_prose_against_toolsets

    files = _files(
        "toolsets: [cards]",
        body=(
            "Search the board before you create; a card is a card.\n"
            "The workspace and its notes are context, not tools.\n"
        ),
    )
    assert lint_prose_against_toolsets(files, ["cards"]) == []


def test_lint_matches_whole_words_only():
    from app.services.skills.skill_service import lint_prose_against_toolsets

    # `whoami` is the only single-word tool; it must not fire inside a longer
    # identifier, and a bare tool name must not fire as a substring either.
    files = _files(
        "toolsets: [cards]",
        body="See whoami_helper and my_search_cards_wrapper (not tools).\n",
    )
    assert lint_prose_against_toolsets(files, ["cards"]) == []


def test_lint_reports_bare_single_word_tool():
    from app.services.skills.skill_service import lint_prose_against_toolsets

    files = _files("toolsets: [cards]", body="Run whoami to confirm identity.\n")
    assert lint_prose_against_toolsets(files, ["cards"]) == ["whoami"]
