# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Starter skill catalog — /api/workspaces/{slug}/skill-catalog.

RED phase for the Skills Registry (spec note f58cae0c).

The catalog is static and versioned with the app, served workspace-scoped for
auth consistency (same pattern as loop-templates). Activation COPIES a catalog
entry into the workspace registry as an already-published version 1 — after
that the workspace copy is independent. Also pins the catalog data rails:
every entry is a valid SKILL.md bundle, and the vocabulary rule that skills
are never called by the t-word this codebase claims 3× elsewhere.
"""

import re

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.workspace import Workspace

from tests.routers.skills.conftest import make_member, mint_agent_key


CATALOG_URL = "/api/workspaces/default/skill-catalog"
SKILLS_URL = "/api/workspaces/default/skills"

ENTRY_KEYS = {"catalog_id", "catalog_version", "name", "description", "toolsets"}

KEBAB_CASE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def _get(entry, field):
    """Catalog entries may be dataclasses or plain dicts — the contract is the
    field set, not the container."""
    return entry[field] if isinstance(entry, dict) else getattr(entry, field)


# --- listing -----------------------------------------------------------------


async def test_list_skill_catalog_shape(client: AsyncClient, test_workspace: Workspace):
    response = await client.get(CATALOG_URL)
    assert response.status_code == 200, response.text
    data = response.json()
    entries = data["entries"]
    assert len(entries) >= 4
    for entry in entries:
        assert set(entry.keys()) == ENTRY_KEYS, entry.keys()
    # File contents never ride the catalog listing.
    assert '"files"' not in response.text


async def test_list_skill_catalog_member_readable(
    role_client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    member = await make_member(db_session, test_workspace)
    response = await role_client.get(CATALOG_URL, headers={"X-User-Email": member.email})
    assert response.status_code == 200, response.text


async def test_list_skill_catalog_unknown_workspace(
    client: AsyncClient, test_workspace: Workspace
):
    # The known-workspace 200 first: without it this test would go green today
    # on the framework's route-missing 404 instead of the workspace lookup.
    known = await client.get(CATALOG_URL)
    assert known.status_code == 200, known.text

    response = await client.get("/api/workspaces/does-not-exist/skill-catalog")
    assert response.status_code == 404, response.text


# --- activation --------------------------------------------------------------


async def _first_catalog_entry(client: AsyncClient) -> dict:
    response = await client.get(CATALOG_URL)
    assert response.status_code == 200, response.text
    return response.json()["entries"][0]


async def test_activate_catalog_skill_success(
    client: AsyncClient, test_workspace: Workspace
):
    entry = await _first_catalog_entry(client)
    catalog_id = entry["catalog_id"]

    response = await client.post(f"{CATALOG_URL}/{catalog_id}/activate")
    assert response.status_code == 201, response.text
    data = response.json()
    assert data["slug"] == catalog_id
    # Catalog skills arrive ready to use: version 1 is already published.
    assert data["latest_published_version"] == 1
    assert data["origin"] == f"catalog:{catalog_id}@{entry['catalog_version']}"
    assert len(data["versions"]) == 1
    assert data["versions"][0]["status"] == "published"

    # The activated skill is a real workspace skill, listable and fetchable.
    listing = await client.get(SKILLS_URL)
    assert listing.json()["count"] == 1
    detail = await client.get(f"{SKILLS_URL}/{catalog_id}")
    assert detail.status_code == 200, detail.text


async def test_activate_catalog_skill_idempotent(
    client: AsyncClient, test_workspace: Workspace
):
    entry = await _first_catalog_entry(client)
    catalog_id = entry["catalog_id"]

    first = await client.post(f"{CATALOG_URL}/{catalog_id}/activate")
    assert first.status_code == 201, first.text

    again = await client.post(f"{CATALOG_URL}/{catalog_id}/activate")
    assert again.status_code == 200, again.text
    assert again.json()["id"] == first.json()["id"]

    listing = await client.get(SKILLS_URL)
    assert listing.json()["count"] == 1


async def test_activate_catalog_skill_unknown_id(
    client: AsyncClient, test_workspace: Workspace
):
    # Prove the route family exists (a real entry activates) so the 404 below
    # can only mean "unknown catalog_id", not "no such route".
    entry = await _first_catalog_entry(client)
    activated = await client.post(f"{CATALOG_URL}/{entry['catalog_id']}/activate")
    assert activated.status_code == 201, activated.text

    response = await client.post(f"{CATALOG_URL}/does-not-exist/activate")
    assert response.status_code == 404, response.text


async def test_activate_catalog_skill_member_forbidden(
    role_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    member = await make_member(db_session, test_workspace)
    entry = await _first_catalog_entry_as(role_client, test_user.email)

    response = await role_client.post(
        f"{CATALOG_URL}/{entry['catalog_id']}/activate",
        headers={"X-User-Email": member.email},
    )
    assert response.status_code == 403, response.text


async def test_activate_catalog_skill_rejects_agent_callers(
    role_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    raw = await mint_agent_key(db_session, test_user)
    entry = await _first_catalog_entry_as(role_client, test_user.email)

    response = await role_client.post(
        f"{CATALOG_URL}/{entry['catalog_id']}/activate",
        headers={"Authorization": f"Bearer {raw}"},
    )
    assert response.status_code == 403, response.text


async def _first_catalog_entry_as(role_client: AsyncClient, email: str) -> dict:
    response = await role_client.get(CATALOG_URL, headers={"X-User-Email": email})
    assert response.status_code == 200, response.text
    return response.json()["entries"][0]


# --- static catalog data rails ----------------------------------------------


def _parse_frontmatter(content: str) -> dict:
    """Minimal SKILL.md frontmatter reader — enough to assert name/description
    without a YAML dependency in tests."""
    assert content.startswith("---\n"), "SKILL.md must open with YAML frontmatter"
    _, frontmatter, _body = content.split("---", 2)
    fields = {}
    for line in frontmatter.strip().splitlines():
        if ":" in line and not line.startswith((" ", "\t")):
            key, _, value = line.partition(":")
            fields[key.strip()] = value.strip().strip("\"'")
    return fields


def test_skill_catalog_has_at_least_four_valid_entries():
    from app.services.skills.catalog import SKILL_CATALOG

    assert len(SKILL_CATALOG) >= 4
    for entry in SKILL_CATALOG:
        catalog_id = _get(entry, "catalog_id")
        assert KEBAB_CASE.match(catalog_id), catalog_id
        files = _get(entry, "files")
        manifests = [f for f in files if _get(f, "path") == "SKILL.md"]
        assert len(manifests) == 1, f"{catalog_id}: exactly one root SKILL.md"
        frontmatter = _parse_frontmatter(_get(manifests[0], "content"))
        assert frontmatter.get("name"), f"{catalog_id}: frontmatter name required"
        assert frontmatter.get("description"), (
            f"{catalog_id}: frontmatter description required"
        )
        assert _get(entry, "name"), catalog_id
        assert _get(entry, "description"), catalog_id


def test_skill_catalog_never_says_the_t_word():
    """Vocabulary rail: 'template' is claimed 3× in this codebase (loop
    templates, config templates, pipeline templates) — skills are never
    called that, anywhere in catalog data."""
    from app.services.skills.catalog import SKILL_CATALOG

    for entry in SKILL_CATALOG:
        catalog_id = _get(entry, "catalog_id")
        surfaces = [
            catalog_id,
            _get(entry, "name"),
            _get(entry, "description"),
        ]
        for f in _get(entry, "files"):
            surfaces.append(_get(f, "path"))
            surfaces.append(_get(f, "content"))
        for text in surfaces:
            assert "template" not in text.lower(), (catalog_id, text[:120])
