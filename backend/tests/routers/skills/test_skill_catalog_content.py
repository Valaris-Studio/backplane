# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Skill catalog CONTENT pins — card 19ebc953 (catalog grows 4 → 12).

RED phase: the eight new entries below don't exist yet. These tests pin the
exact roster (drift guard), the metadata rails every entry must honor
(frontmatter parity, human-titled names, card-sized descriptions, flat
references/ layout), and that EVERY entry — not just entries[0] — activates
into a workspace as a published v1 with all of its files.

Reuses the helpers and auth idiom of test_skill_catalog.py; the >=4 structural
test there stays authoritative for bundle shape.
"""

import re

import pytest
from httpx import AsyncClient

from app.models.workspace import Workspace

from tests.routers.skills.test_skill_catalog import (
    CATALOG_URL,
    SKILLS_URL,
    _get,
    _parse_frontmatter,
)


EXISTING_CATALOG_IDS = {
    "commit-message-conventions",
    "pr-description-conventions",
    "board-hygiene-for-agents",
    "release-checklist",
}

NEW_CATALOG_IDS = {
    "mcp-coordination-rulebook",
    "project-bootstrap",
    "agentic-board-setup",
    "autonomous-run-monitoring",
    "run-postmortem-audit",
    "plan-authoring",
    "coding-principles",
    "visual-testing",
}

EXPECTED_CATALOG_IDS = EXISTING_CATALOG_IDS | NEW_CATALOG_IDS

LOWERCASE_KEBAB = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")

FLAT_REFERENCE_PATH = re.compile(r"^references/[^/]+$")


def _catalog_by_id() -> dict:
    from app.services.skills.catalog import SKILL_CATALOG

    return {_get(entry, "catalog_id"): entry for entry in SKILL_CATALOG}


def _manifest_content(entry) -> str:
    manifests = [f for f in _get(entry, "files") if _get(f, "path") == "SKILL.md"]
    assert len(manifests) == 1, f"{_get(entry, 'catalog_id')}: exactly one root SKILL.md"
    return _get(manifests[0], "content")


# --- roster drift guard ------------------------------------------------------


def test_catalog_contains_exactly_the_twelve_entries():
    from app.services.skills.catalog import SKILL_CATALOG

    actual_ids = {_get(entry, "catalog_id") for entry in SKILL_CATALOG}
    assert actual_ids == EXPECTED_CATALOG_IDS, (
        f"missing: {sorted(EXPECTED_CATALOG_IDS - actual_ids)}, "
        f"unexpected: {sorted(actual_ids - EXPECTED_CATALOG_IDS)}"
    )
    # No duplicate catalog_ids hiding behind the set comparison.
    assert len(SKILL_CATALOG) == 12


# --- metadata rails over ALL entries -----------------------------------------


def test_every_entry_name_and_description_match_frontmatter():
    """Activation reads frontmatter — an entry whose name/description drift
    from SKILL.md ships silently wrong metadata to every workspace."""
    for catalog_id, entry in _catalog_by_id().items():
        frontmatter = _parse_frontmatter(_manifest_content(entry))
        assert _get(entry, "name") == frontmatter.get("name"), catalog_id
        assert _get(entry, "description") == frontmatter.get("description"), catalog_id


def test_every_entry_name_is_a_human_title():
    for catalog_id, entry in _catalog_by_id().items():
        name = _get(entry, "name")
        assert name != catalog_id, f"{catalog_id}: name must not echo the slug"
        assert not LOWERCASE_KEBAB.match(name), f"{catalog_id}: name is kebab-case"
        assert " " in name or name[0].isupper(), (catalog_id, name)


def test_every_entry_description_is_catalog_card_sized():
    """The UI renders the description as a single small line."""
    for catalog_id, entry in _catalog_by_id().items():
        description = _get(entry, "description")
        assert 1 <= len(description) <= 300, (catalog_id, len(description))


def test_every_entry_reference_files_are_one_level_deep():
    for catalog_id, entry in _catalog_by_id().items():
        for f in _get(entry, "files"):
            path = _get(f, "path")
            if path == "SKILL.md":
                continue
            assert FLAT_REFERENCE_PATH.match(path), (catalog_id, path)


# --- activation of every entry -----------------------------------------------


@pytest.mark.parametrize("catalog_id", sorted(EXPECTED_CATALOG_IDS))
async def test_activate_every_catalog_entry_succeeds(
    client: AsyncClient, test_workspace: Workspace, catalog_id: str
):
    """Today only entries[0] is exercised; every entry must survive the copy
    into a workspace — activation validates each bundle for real."""
    entry = _catalog_by_id().get(catalog_id)
    assert entry is not None, f"{catalog_id} missing from SKILL_CATALOG"

    response = await client.post(f"{CATALOG_URL}/{catalog_id}/activate")
    assert response.status_code == 201, response.text
    data = response.json()
    assert data["origin"] == f"catalog:{catalog_id}@{_get(entry, 'catalog_version')}"
    assert data["latest_published_version"] == 1

    # Every file made the copy — count via the version detail (file contents
    # never ride listings or the skill detail).
    detail = await client.get(f"{SKILLS_URL}/{catalog_id}/versions/1")
    assert detail.status_code == 200, detail.text
    assert len(detail.json()["files"]) == len(_get(entry, "files")), catalog_id


# sha256 over each entry's canonical file list (compute_content_hash). The
# distillation sources were session-scoped; these pins are the durable
# byte-parity record. Editing embedded content is a deliberate two-place
# change: update the hash here AND bump the entry's catalog_version so
# `catalog:{id}@{version}` provenance keeps telling the truth.
EXPECTED_CONTENT_HASHES = {
    "commit-message-conventions": "78c1bbc0182b386774098b34d316ad6c44798c73771d1fdd4ab0fcdc7d962a2b",
    "pr-description-conventions": "fc6095b011dd02a92a97301eb97df6cfe3471225656a22dd3e70bd85fbda3ca6",
    "board-hygiene-for-agents": "d0fcbe7e9875e96839054831e827350360ebb8f7220b2a46038d155bcadaa19e",
    "release-checklist": "0552bb5bac89141e25b59290099e4a9bf32b9cbc274fddfeef8625d0d8aebf86",
    "mcp-coordination-rulebook": "94352f5b247b9b337e1cd9afeb5fada520b52a117bf8517bc86b615f0a1f6144",
    "project-bootstrap": "41aadb0ff386cb9e66e3c4515b562c679475d27e92aa950e970a8bbd23f55ece",
    "agentic-board-setup": "c26d3d93e410e6d633f40dd07d392ea53c2e252c10f0752f6731b08dcfd528ec",
    "autonomous-run-monitoring": "e7260b082dcb39e03217452b1fbfa9e59260ae5c03752e55b0afa66fe885e7c3",
    "run-postmortem-audit": "0bb03f895d44a5b040cf4a2a04374d5b718b73e10350ecf1601bca40b81a3074",
    "plan-authoring": "6bc29c4a16e8dc514ac372f2e0777cf07b7aeb31e2e463c8e53369eeb0fed71d",
    "coding-principles": "66d29e1b9b467180dc26afe07ce4eba55cf48d7fbefc7230b29cb06cbb4e4e54",
    "visual-testing": "7eb33965333f3f49f49718985e7dd037455af38882e24bbddcd6ab62ca832572",
}


def test_every_entry_content_hash_is_pinned():
    from app.services.skills.catalog import SKILL_CATALOG
    from app.services.skills.skill_service import compute_content_hash

    actual = {
        _get(entry, "catalog_id"): compute_content_hash(
            [{"path": f.path, "content": f.content} for f in _get(entry, "files")]
        )
        for entry in SKILL_CATALOG
    }
    assert actual == EXPECTED_CONTENT_HASHES
