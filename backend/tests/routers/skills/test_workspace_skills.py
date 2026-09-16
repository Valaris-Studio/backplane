# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Workspace skill registry — /api/workspaces/{slug}/skills.

RED phase for the Skills Registry (spec note f58cae0c, card cdcf94b7).

Pins the registry contract: SKILL.md-standard bundles stored verbatim (open
standard, zero Backplane-specific frontmatter keys), listing without file
payloads, idempotent create-by-slug, draft→published version lifecycle, and
the member-read / admin-write / no-agent-authoring gating matrix.
"""

import hashlib
import json
import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from tests.routers.skills.conftest import make_member, mint_agent_key, skill_md


SKILLS_URL = "/api/workspaces/default/skills"

# The exact wire shape of one LISTING item — set-equality catches silently
# added fields (like `files`, which must never ride the listing) as loudly as
# missing ones.
LIST_ITEM_KEYS = {
    "id",
    "slug",
    "name",
    "description",
    "latest_published_version",
    "origin",
    "updated_at",
    # Soft-archive (card 60fafca6): null for live skills, set for archived —
    # clients badge archived skills straight off the listing item.
    "archived_at",
    "toolsets",
}


def canonical_hash(files: list[dict]) -> str:
    """The pinned content-hash algorithm: sha256 over the canonical files JSON
    (entries sorted by path, sort_keys, compact separators)."""
    canonical = json.dumps(
        sorted(files, key=lambda f: f["path"]),
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


async def _create_skill(
    client: AsyncClient, files: list[dict], slug: str = "code-review-ritual"
):
    response = await client.post(SKILLS_URL, json={"slug": slug, "files": files})
    assert response.status_code == 201, response.text
    return response.json()


# --- list --------------------------------------------------------------------


async def test_list_skills_empty(client: AsyncClient, test_workspace: Workspace):
    response = await client.get(SKILLS_URL)
    assert response.status_code == 200, response.text
    assert response.json() == {"skills": [], "count": 0}


async def test_list_skills_shape_and_no_files(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    await _create_skill(client, make_files(), slug="code-review-ritual")
    await _create_skill(
        client,
        make_files(name="Release Notes", description="Writing release notes."),
        slug="release-notes",
    )

    response = await client.get(SKILLS_URL)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["count"] == 2
    assert len(data["skills"]) == 2
    for item in data["skills"]:
        assert set(item.keys()) == LIST_ITEM_KEYS, item.keys()
    # File contents are heavy and the listing must never carry them — assert
    # over the whole payload so a nested leak is caught wherever it hides.
    assert '"files"' not in response.text
    slugs = {item["slug"] for item in data["skills"]}
    assert slugs == {"code-review-ritual", "release-notes"}


async def test_list_skills_unknown_workspace(
    client: AsyncClient, test_workspace: Workspace
):
    # The known-workspace 200 first: without it this test would go green today
    # on the framework's route-missing 404 instead of the workspace lookup.
    known = await client.get(SKILLS_URL)
    assert known.status_code == 200, known.text

    response = await client.get("/api/workspaces/does-not-exist/skills")
    assert response.status_code == 404, response.text


# --- create ------------------------------------------------------------------


async def test_create_skill_success(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    files = make_files()
    data = await _create_skill(client, files)

    assert data["slug"] == "code-review-ritual"
    # name/description are MIRRORED from SKILL.md frontmatter.
    assert data["name"] == "Code Review Ritual"
    assert data["description"] == "How this workspace reviews pull requests."
    assert data["latest_published_version"] is None
    # Version 1 is created as a draft; versions ride as METADATA (no files).
    assert len(data["versions"]) == 1
    version = data["versions"][0]
    assert version["version"] == 1
    assert version["status"] == "draft"
    assert version["content_hash"] == canonical_hash(files)
    assert version["created_at"] is not None
    assert "files" not in version


async def test_create_skill_idempotent_on_slug(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    first = await _create_skill(client, make_files())

    # Same slug again: return the EXISTING skill (200), create nothing new —
    # agents retry, and a retry must not stack versions or 409.
    response = await client.post(
        SKILLS_URL,
        json={"slug": "code-review-ritual", "files": make_files(name="Different")},
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["id"] == first["id"]
    assert data["name"] == "Code Review Ritual"
    assert len(data["versions"]) == 1


async def test_create_skill_name_comes_from_frontmatter_not_request(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    response = await client.post(
        SKILLS_URL,
        json={
            "slug": "frontmatter-wins",
            "name": "WRONG — request name must be ignored",
            "description": "WRONG too",
            "files": make_files(
                name="Frontmatter Name", description="Frontmatter description."
            ),
        },
    )
    assert response.status_code == 201, response.text
    data = response.json()
    assert data["name"] == "Frontmatter Name"
    assert data["description"] == "Frontmatter description."


async def test_create_skill_allows_unknown_frontmatter_keys(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    # SKILL.md is an open standard: unknown keys pass through untouched, and
    # Backplane defines exactly one key of its own (`toolsets`, MCP #3).
    files = make_files(extra_frontmatter="license: MIT\nallowed-tools: [bash]")
    data = await _create_skill(client, files, slug="open-standard")
    assert data["name"] == "Code Review Ritual"


async def test_create_skill_with_supporting_files(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    files = make_files(
        extra_files=[
            {"path": "references/checklist.md", "content": "- [ ] tests\n"},
            {"path": "scripts/lint.sh", "content": "#!/bin/sh\n"},
        ]
    )
    data = await _create_skill(client, files, slug="with-support")
    assert data["versions"][0]["content_hash"] == canonical_hash(files)


# --- files validation --------------------------------------------------------


async def test_create_skill_missing_root_skill_md(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(
        SKILLS_URL,
        json={
            "slug": "no-manifest",
            "files": [{"path": "README.md", "content": "not a skill"}],
        },
    )
    assert response.status_code == 422, response.text


async def test_create_skill_nested_skill_md_is_not_root(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(
        SKILLS_URL,
        json={
            "slug": "nested-manifest",
            "files": [{"path": "docs/SKILL.md", "content": skill_md()}],
        },
    )
    assert response.status_code == 422, response.text


async def test_create_skill_duplicate_root_skill_md_paths(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    files = make_files(extra_files=[{"path": "SKILL.md", "content": skill_md()}])
    response = await client.post(
        SKILLS_URL, json={"slug": "dup-manifest", "files": files}
    )
    assert response.status_code == 422, response.text


async def test_create_skill_rejects_path_traversal(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    for bad_path in ("../escape.md", "/absolute.md", "win\\style.md", ""):
        files = make_files(extra_files=[{"path": bad_path, "content": "x"}])
        response = await client.post(
            SKILLS_URL, json={"slug": "bad-path", "files": files}
        )
        assert response.status_code == 422, (bad_path, response.text)


async def test_create_skill_rejects_too_many_files(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    extra = [{"path": f"references/f{i}.md", "content": "x"} for i in range(33)]
    files = make_files(extra_files=extra)
    response = await client.post(
        SKILLS_URL, json={"slug": "too-many", "files": files}
    )
    assert response.status_code == 422, response.text


async def test_create_skill_rejects_oversized_file(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    files = make_files(
        extra_files=[{"path": "references/big.md", "content": "x" * (64 * 1024 + 1)}]
    )
    response = await client.post(
        SKILLS_URL, json={"slug": "big-file", "files": files}
    )
    assert response.status_code == 413, response.text


async def test_create_skill_rejects_oversized_bundle(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    # 9 files × 60KiB ≈ 540KiB: each under the per-file cap, total over 512KiB.
    extra = [
        {"path": f"references/part{i}.md", "content": "x" * (60 * 1024)}
        for i in range(9)
    ]
    files = make_files(extra_files=extra)
    response = await client.post(
        SKILLS_URL, json={"slug": "big-bundle", "files": files}
    )
    assert response.status_code == 413, response.text


async def test_create_skill_missing_frontmatter(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(
        SKILLS_URL,
        json={
            "slug": "no-frontmatter",
            "files": [{"path": "SKILL.md", "content": "# Just a heading\n"}],
        },
    )
    assert response.status_code == 422, response.text


async def test_create_skill_frontmatter_empty_name(
    client: AsyncClient, test_workspace: Workspace
):
    content = '---\nname: ""\ndescription: Something.\n---\n\nbody\n'
    response = await client.post(
        SKILLS_URL,
        json={"slug": "empty-name", "files": [{"path": "SKILL.md", "content": content}]},
    )
    assert response.status_code == 422, response.text


async def test_create_skill_frontmatter_missing_description(
    client: AsyncClient, test_workspace: Workspace
):
    content = "---\nname: Named\n---\n\nbody\n"
    response = await client.post(
        SKILLS_URL,
        json={
            "slug": "no-description",
            "files": [{"path": "SKILL.md", "content": content}],
        },
    )
    assert response.status_code == 422, response.text


# --- get one -----------------------------------------------------------------


async def test_get_skill_success(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    created = await _create_skill(client, make_files())

    response = await client.get(f"{SKILLS_URL}/code-review-ritual")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["id"] == created["id"]
    assert data["slug"] == "code-review-ritual"
    assert len(data["versions"]) == 1
    assert '"files"' not in response.text


async def test_get_skill_unknown_slug(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    # Seed one real skill so the 404 below can only mean "unknown slug", not
    # "the route family doesn't exist yet".
    await _create_skill(client, make_files())

    response = await client.get(f"{SKILLS_URL}/does-not-exist")
    assert response.status_code == 404, response.text


async def test_get_skill_in_other_workspace_is_404(
    client: AsyncClient,
    test_user: User,
    test_workspace: Workspace,
    db_session: AsyncSession,
    make_files,
):
    # test_user owns BOTH workspaces, so membership passes everywhere and the
    # 404 can only mean tenancy scoping (a 403 would leak existence).
    other = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(other)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=other.id, user_id=test_user.id, role=WorkspaceRole.owner
        )
    )
    await db_session.flush()

    created = await client.post(
        "/api/workspaces/other/skills",
        json={"slug": "elsewhere", "files": make_files()},
    )
    assert created.status_code == 201, created.text

    response = await client.get(f"{SKILLS_URL}/elsewhere")
    assert response.status_code == 404, response.text


# --- versions ----------------------------------------------------------------


async def test_get_skill_version_with_files(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    files = make_files()
    await _create_skill(client, files)

    response = await client.get(f"{SKILLS_URL}/code-review-ritual/versions/1")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["version"] == 1
    assert data["status"] == "draft"
    assert data["content_hash"] == canonical_hash(files)
    # The version detail is the ONE place files are served — verbatim.
    assert data["files"] == files


async def test_get_skill_version_unknown_number(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    await _create_skill(client, make_files())
    response = await client.get(f"{SKILLS_URL}/code-review-ritual/versions/99")
    assert response.status_code == 404, response.text


async def test_create_skill_version_increments(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    await _create_skill(client, make_files())

    v2_files = make_files(body="## Steps\n\n1. Read the diff three times.\n")
    response = await client.post(
        f"{SKILLS_URL}/code-review-ritual/versions", json={"files": v2_files}
    )
    assert response.status_code == 201, response.text
    data = response.json()
    assert data["version"] == 2
    assert data["status"] == "draft"
    assert data["content_hash"] == canonical_hash(v2_files)


async def test_create_skill_version_validates_files(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    await _create_skill(client, make_files())
    response = await client.post(
        f"{SKILLS_URL}/code-review-ritual/versions",
        json={"files": [{"path": "README.md", "content": "no manifest"}]},
    )
    assert response.status_code == 422, response.text


async def test_publish_skill_version_success(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    await _create_skill(client, make_files())

    response = await client.post(f"{SKILLS_URL}/code-review-ritual/versions/1/publish")
    assert response.status_code == 200, response.text

    detail = await client.get(f"{SKILLS_URL}/code-review-ritual")
    data = detail.json()
    assert data["latest_published_version"] == 1
    assert data["versions"][0]["status"] == "published"


async def test_publish_skill_version_idempotent(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    await _create_skill(client, make_files())
    first = await client.post(f"{SKILLS_URL}/code-review-ritual/versions/1/publish")
    assert first.status_code == 200, first.text

    again = await client.post(f"{SKILLS_URL}/code-review-ritual/versions/1/publish")
    assert again.status_code == 200, again.text

    detail = await client.get(f"{SKILLS_URL}/code-review-ritual")
    assert detail.json()["latest_published_version"] == 1


async def test_publish_second_version_advances_latest(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    await _create_skill(client, make_files())
    await client.post(f"{SKILLS_URL}/code-review-ritual/versions/1/publish")
    v2 = await client.post(
        f"{SKILLS_URL}/code-review-ritual/versions",
        json={"files": make_files(body="v2 body\n")},
    )
    assert v2.status_code == 201, v2.text

    response = await client.post(f"{SKILLS_URL}/code-review-ritual/versions/2/publish")
    assert response.status_code == 200, response.text

    detail = await client.get(f"{SKILLS_URL}/code-review-ritual")
    assert detail.json()["latest_published_version"] == 2


async def test_publish_rejected_version_conflicts(
    client: AsyncClient,
    test_workspace: Workspace,
    db_session: AsyncSession,
    make_files,
):
    from sqlalchemy import update

    from app.models.skills.skill import SkillVersion

    created = await _create_skill(client, make_files())
    # No reject endpoint in v1 (proposals land later) — force the terminal
    # state directly to pin the transition rule now.
    await db_session.execute(
        update(SkillVersion)
        .where(
            SkillVersion.skill_id == uuid.UUID(created["id"]),
            SkillVersion.version == 1,
        )
        .values(status="rejected")
    )
    await db_session.flush()

    response = await client.post(f"{SKILLS_URL}/code-review-ritual/versions/1/publish")
    assert response.status_code == 409, response.text


async def test_publish_unknown_version_404(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    await _create_skill(client, make_files())
    response = await client.post(f"{SKILLS_URL}/code-review-ritual/versions/9/publish")
    assert response.status_code == 404, response.text


# --- activity ----------------------------------------------------------------


async def test_create_and_publish_record_skill_activity(
    client: AsyncClient,
    test_workspace: Workspace,
    db_session: AsyncSession,
    make_files,
):
    from sqlalchemy import select

    from app.models.activity import Activity, ActivityAction, ActivityEntityType

    await _create_skill(client, make_files())
    await client.post(f"{SKILLS_URL}/code-review-ritual/versions/1/publish")

    rows = (
        (
            await db_session.execute(
                select(Activity).where(
                    Activity.workspace_id == test_workspace.id,
                    Activity.entity_type == ActivityEntityType.skill,
                )
            )
        )
        .scalars()
        .all()
    )
    actions = {row.action for row in rows}
    assert ActivityAction.created in actions, actions
    assert ActivityAction.published in actions, actions


# --- gating matrix -----------------------------------------------------------


async def test_list_skills_rejects_non_member(
    client: AsyncClient,
    test_user: User,
    second_user: User,
    db_session: AsyncSession,
):
    foreign = Workspace(name="Foreign", slug="foreign", created_by=second_user.id)
    db_session.add(foreign)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=foreign.id, user_id=second_user.id, role=WorkspaceRole.owner
        )
    )
    await db_session.flush()

    response = await client.get("/api/workspaces/foreign/skills")
    assert response.status_code == 403, response.text


async def test_member_may_read_but_not_write_skills(
    role_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    make_files,
):
    member = await make_member(db_session, test_workspace)
    headers = {"X-User-Email": member.email}
    owner_headers = {"X-User-Email": test_user.email}

    seeded = await role_client.post(
        SKILLS_URL,
        json={"slug": "gate-check", "files": make_files()},
        headers=owner_headers,
    )
    assert seeded.status_code == 201, seeded.text

    listing = await role_client.get(SKILLS_URL, headers=headers)
    assert listing.status_code == 200, listing.text
    detail = await role_client.get(f"{SKILLS_URL}/gate-check", headers=headers)
    assert detail.status_code == 200, detail.text

    writes = [
        ("post", SKILLS_URL, {"slug": "member-made", "files": make_files()}),
        ("post", f"{SKILLS_URL}/gate-check/versions", {"files": make_files()}),
        ("post", f"{SKILLS_URL}/gate-check/versions/1/publish", {}),
    ]
    for method, path, body in writes:
        response = await getattr(role_client, method)(path, json=body, headers=headers)
        assert response.status_code == 403, (method, path, response.text)


async def test_every_skill_mutation_bans_agent_callers(
    role_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    make_files,
):
    """Skills steer future agent behavior; an agent must not author its own
    instructions. One unguarded route is the whole hole — assert the set."""
    raw = await mint_agent_key(db_session, test_user)
    headers = {"Authorization": f"Bearer {raw}"}
    owner_headers = {"X-User-Email": test_user.email}

    seeded = await role_client.post(
        SKILLS_URL,
        json={"slug": "agent-gate", "files": make_files()},
        headers=owner_headers,
    )
    assert seeded.status_code == 201, seeded.text

    listing = await role_client.get(SKILLS_URL, headers=headers)
    assert listing.status_code == 200, listing.text

    mutations = [
        ("post", SKILLS_URL, {"slug": "agent-made", "files": make_files()}),
        ("post", f"{SKILLS_URL}/agent-gate/versions", {"files": make_files()}),
        ("post", f"{SKILLS_URL}/agent-gate/versions/1/publish", {}),
    ]
    for method, path, body in mutations:
        response = await getattr(role_client, method)(path, json=body, headers=headers)
        assert response.status_code == 403, (method, path, response.status_code)


async def test_create_skill_rejects_malformed_slug(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    """A slug is the skill's URL segment, so it must obey the house slug rule.

    "a/b" is the sharp case: it once created a skill whose GET path resolved
    to a different (nonexistent) route — a 201 followed by a permanent 404.
    """
    for bad_slug in ("a/b", "Has Spaces", "UPPER", "a_b", "-lead", "trail-"):
        response = await client.post(
            SKILLS_URL, json={"slug": bad_slug, "files": make_files()}
        )
        assert response.status_code == 422, (bad_slug, response.text)


async def test_create_skill_accepts_kebab_slug(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    response = await client.post(
        SKILLS_URL, json={"slug": "release-notes-v2", "files": make_files()}
    )
    assert response.status_code == 201, response.text
    assert response.json()["slug"] == "release-notes-v2"

    fetched = await client.get(f"{SKILLS_URL}/release-notes-v2")
    assert fetched.status_code == 200, fetched.text


async def test_create_skill_rejects_control_and_bidi_paths(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    """Control characters and bidi overrides make a path lie about itself —
    "‮exe.md" renders as "dm.exe" — and NUL/newline break every downstream
    consumer that materializes the bundle onto a filesystem."""
    bad_paths = (
        "a\x00b.md",
        "a\nb.md",
        "a\tb.md",
        "a\x7fb.md",
        "﻿SKILL.md",
        "‮exe.md",
        "note⁦rtl.md",
    )
    for bad_path in bad_paths:
        files = make_files(extra_files=[{"path": bad_path, "content": "x"}])
        response = await client.post(
            SKILLS_URL, json={"slug": "hostile-path", "files": files}
        )
        assert response.status_code == 422, (repr(bad_path), response.text)
