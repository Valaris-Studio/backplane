# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Catalog entries declare their toolsets (MCP #3, card 3c690fb6).

RED phase. Every starter skill ships with a `toolsets:` declaration in its
SKILL.md, exposed as a DERIVED property on CatalogEntry (parsed, never a
second hand-typed field), and its prose names no tool outside that hand —
the lint that only WARNS for workspace skills BLOCKS here. The MCP
Coordination Rulebook is the canonical guide and gains the "Which hand for
which job" section with the env one-liner.
"""

import re

import pytest


def _catalog():
    from app.services.skills.catalog import SKILL_CATALOG

    return list(SKILL_CATALOG)


def _catalog_ids() -> list[str]:
    return [entry.catalog_id for entry in _catalog()]


def _entry(catalog_id: str):
    return next(e for e in _catalog() if e.catalog_id == catalog_id)


def _files(entry) -> list[dict]:
    return [{"path": f.path, "content": f.content} for f in entry.files]


def _manifest_content(entry) -> str:
    return next(f.content for f in entry.files if f.path == "SKILL.md")


@pytest.mark.parametrize("catalog_id", _catalog_ids())
def test_catalog_entry_declares_at_least_one_valid_toolset(catalog_id: str):
    from app.services.skills.toolsets import TOOLSET_IDS

    entry = _entry(catalog_id)
    toolsets = entry.toolsets
    assert isinstance(toolsets, list), catalog_id
    assert toolsets, f"{catalog_id}: SKILL.md declares no toolsets"
    unknown = [t for t in toolsets if t not in TOOLSET_IDS]
    assert not unknown, f"{catalog_id}: unknown toolset ids {unknown}"
    assert len(toolsets) == len(set(toolsets)), f"{catalog_id}: duplicate ids"


@pytest.mark.parametrize("catalog_id", _catalog_ids())
def test_catalog_entry_toolsets_is_derived_from_its_manifest(catalog_id: str):
    """The property IS the frontmatter — no second source that can drift."""
    from app.services.skills.skill_service import parse_manifest

    entry = _entry(catalog_id)
    assert entry.toolsets == parse_manifest(_manifest_content(entry)).toolsets


@pytest.mark.parametrize("catalog_id", _catalog_ids())
def test_catalog_entry_prose_names_no_tool_outside_its_toolsets(catalog_id: str):
    from app.services.skills.skill_service import lint_prose_against_toolsets

    entry = _entry(catalog_id)
    outside = lint_prose_against_toolsets(_files(entry), entry.toolsets)
    assert outside == [], (
        f"{catalog_id}: prose references tools outside {entry.toolsets}: {outside} "
        "— widen the declaration or drop the reference"
    )


def test_catalog_entry_toolsets_validate_as_a_workspace_skill_would():
    """The exact validation path a workspace create runs, over every bundle —
    an entry that could not be activated is a broken catalog."""
    from app.services.skills.skill_service import validate_manifest

    for entry in _catalog():
        manifest = validate_manifest(_files(entry))
        assert manifest.toolsets == entry.toolsets, entry.catalog_id


def test_rulebook_has_the_which_hand_for_which_job_section():
    content = _manifest_content(_entry("mcp-coordination-rulebook"))
    headings = [line for line in content.splitlines() if line.startswith("#")]
    assert any(
        re.search(r"which hand for which job", h, re.IGNORECASE) for h in headings
    ), headings
    # The env one-liner is the operator's lever — the guide must name it.
    assert "VALARIS_MCP_TOOLSETS" in content


def test_rulebook_declares_every_group_it_teaches():
    """The rulebook teaches the whole interactive surface (get_project_context,
    cards, notes, dependencies, search) — its declaration must span the
    default hand's groups, not a single category."""
    from app.services.skills.toolsets import TOOLSET_IDS

    entry = _entry("mcp-coordination-rulebook")
    default_ids = _default_toolset_ids()
    assert set(default_ids) <= set(entry.toolsets), (
        entry.toolsets,
        default_ids,
    )
    assert set(entry.toolsets) <= set(TOOLSET_IDS)


def _default_toolset_ids() -> list[str]:
    import json
    from pathlib import Path

    fixture = Path(__file__).resolve().parents[3] / "app" / "data" / "mcp_toolsets.json"
    return json.loads(fixture.read_text())["default"]["ids"]
