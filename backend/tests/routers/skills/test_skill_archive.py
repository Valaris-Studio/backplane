# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Skill soft-archive — POST /skills/{slug}/archive + /unarchive.

RED phase for card 60fafca6: skills are never hard-deleted (house rule from
loop-templates). Archive stamps `archived_at`/`archived_by`, hides the skill
from the default listing, and blocks NEW attachment points (fresh board binds,
agent proposals) — while everything already attached keeps working: existing
bindings still resolve in the board effective set, the detail endpoint keeps
serving history, and updates/unbinds of existing bindings stay allowed.

Only catalog activation unarchives implicitly; plain create-on-archived-slug
returns the still-archived skill so the client can SEE it is archived.

Trap note (same as test_workspace_skills.py): the app wraps route-missing
404s, so negative tests anchor on a known-good success first — a missing
/archive route can never go green on the wrong 404.
"""

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.skills.skill import Skill
from app.models.user import User
from app.models.workspace import Workspace
from tests.routers.skills.conftest import make_member, mint_agent_key, skill_md


SKILLS_URL = "/api/workspaces/default/skills"
CATALOG_URL = "/api/workspaces/default/skill-catalog"
PROPOSALS_URL = "/api/workspaces/default/skills/proposals"


def board_skills_url(board: Board) -> str:
    return f"/api/workspaces/default/boards/{board.id}/skills"


async def _create_skill(
    client: AsyncClient, files: list[dict], slug: str = "code-review-ritual"
) -> dict:
    response = await client.post(SKILLS_URL, json={"slug": slug, "files": files})
    assert response.status_code == 201, response.text
    return response.json()


async def _seed_published_skill(client: AsyncClient, slug: str) -> dict:
    """A workspace skill with version 1 published — bindable and resolvable."""
    files = [{"path": "SKILL.md", "content": skill_md(name=slug)}]
    await _create_skill(client, files, slug=slug)
    published = await client.post(f"{SKILLS_URL}/{slug}/versions/1/publish")
    assert published.status_code == 200, published.text
    detail = await client.get(f"{SKILLS_URL}/{slug}")
    assert detail.status_code == 200, detail.text
    return detail.json()


async def _archive(client: AsyncClient, slug: str):
    return await client.post(f"{SKILLS_URL}/{slug}/archive")


async def _unarchive(client: AsyncClient, slug: str):
    return await client.post(f"{SKILLS_URL}/{slug}/unarchive")


# --- archive / unarchive lifecycle -------------------------------------------


async def test_archive_skill_success(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    await _create_skill(client, make_files())

    response = await _archive(client, "code-review-ritual")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["slug"] == "code-review-ritual"
    # The archive response is a full SkillRead — versions still ride.
    assert len(data["versions"]) == 1
    assert data["archived_at"] is not None


async def test_archive_skill_sets_archived_by(
    client: AsyncClient,
    test_workspace: Workspace,
    test_user: User,
    db_session: AsyncSession,
    make_files,
):
    await _create_skill(client, make_files())
    response = await _archive(client, "code-review-ritual")
    assert response.status_code == 200, response.text

    skill = (
        await db_session.execute(
            select(Skill).where(
                Skill.workspace_id == test_workspace.id,
                Skill.slug == "code-review-ritual",
            )
        )
    ).scalar_one()
    assert skill.archived_at is not None
    assert skill.archived_by == test_user.id


async def test_archive_skill_idempotent(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    await _create_skill(client, make_files())

    first = await _archive(client, "code-review-ritual")
    assert first.status_code == 200, first.text

    # Agents/operators retry: a second archive returns the skill (200, never
    # 409) with the FIRST archive timestamp preserved verbatim.
    again = await _archive(client, "code-review-ritual")
    assert again.status_code == 200, again.text
    assert again.json()["archived_at"] == first.json()["archived_at"]


async def test_unarchive_skill_success(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    await _create_skill(client, make_files())
    archived = await _archive(client, "code-review-ritual")
    assert archived.status_code == 200, archived.text

    response = await _unarchive(client, "code-review-ritual")
    assert response.status_code == 200, response.text
    assert response.json()["archived_at"] is None

    # Back in the default listing.
    listing = await client.get(SKILLS_URL)
    assert listing.json()["count"] == 1


async def test_unarchive_non_archived_skill_idempotent(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    await _create_skill(client, make_files())

    response = await _unarchive(client, "code-review-ritual")
    assert response.status_code == 200, response.text
    assert response.json()["archived_at"] is None


async def test_archive_unknown_slug_404(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    # Known-good archive first, so the 404 below can only mean "unknown
    # slug", not "the route doesn't exist yet".
    await _create_skill(client, make_files())
    known = await _archive(client, "code-review-ritual")
    assert known.status_code == 200, known.text

    response = await _archive(client, "does-not-exist")
    assert response.status_code == 404, response.text


async def test_archive_skill_member_forbidden(
    role_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    make_files,
):
    owner_headers = {"X-User-Email": test_user.email}
    seeded = await role_client.post(
        SKILLS_URL,
        json={"slug": "member-gate", "files": make_files()},
        headers=owner_headers,
    )
    assert seeded.status_code == 201, seeded.text
    member = await make_member(db_session, test_workspace)
    headers = {"X-User-Email": member.email}

    for path in (
        f"{SKILLS_URL}/member-gate/archive",
        f"{SKILLS_URL}/member-gate/unarchive",
    ):
        response = await role_client.post(path, headers=headers)
        assert response.status_code == 403, (path, response.text)


async def test_archive_skill_rejects_agent_callers(
    role_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    make_files,
):
    owner_headers = {"X-User-Email": test_user.email}
    seeded = await role_client.post(
        SKILLS_URL,
        json={"slug": "agent-gate", "files": make_files()},
        headers=owner_headers,
    )
    assert seeded.status_code == 201, seeded.text
    raw = await mint_agent_key(db_session, test_user)
    headers = {"Authorization": f"Bearer {raw}"}

    for path in (
        f"{SKILLS_URL}/agent-gate/archive",
        f"{SKILLS_URL}/agent-gate/unarchive",
    ):
        response = await role_client.post(path, headers=headers)
        assert response.status_code == 403, (path, response.status_code)


# --- listing ------------------------------------------------------------------


async def test_list_skills_excludes_archived_by_default(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    await _create_skill(client, make_files(), slug="kept")
    await _create_skill(client, make_files(), slug="retired")
    archived = await _archive(client, "retired")
    assert archived.status_code == 200, archived.text

    response = await client.get(SKILLS_URL)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["count"] == 1
    assert [item["slug"] for item in data["skills"]] == ["kept"]
    # Live skills badge as live: archived_at rides the listing item as null.
    assert data["skills"][0]["archived_at"] is None


async def test_list_skills_include_archived_param(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    await _create_skill(client, make_files(), slug="kept")
    await _create_skill(client, make_files(), slug="retired")
    archived = await _archive(client, "retired")
    assert archived.status_code == 200, archived.text

    response = await client.get(SKILLS_URL, params={"include_archived": True})
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["count"] == 2
    by_slug = {item["slug"]: item for item in data["skills"]}
    assert by_slug["retired"]["archived_at"] is not None
    assert by_slug["kept"]["archived_at"] is None


async def test_get_archived_skill_detail_still_serves(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    created = await _create_skill(client, make_files())
    archived = await _archive(client, "code-review-ritual")
    assert archived.status_code == 200, archived.text

    # History stays reachable — archive hides, never severs.
    response = await client.get(f"{SKILLS_URL}/code-review-ritual")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["id"] == created["id"]
    assert data["archived_at"] is not None
    assert len(data["versions"]) == 1


# --- create-on-archived -------------------------------------------------------


async def test_create_skill_archived_slug_returns_archived_skill(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    created = await _create_skill(client, make_files())
    archived = await _archive(client, "code-review-ritual")
    assert archived.status_code == 200, archived.text

    # The idempotent-on-slug path returns the EXISTING skill still archived —
    # plain create never silently unarchives (only catalog activation does),
    # and archived_at rides the 200 so the client can see the state.
    response = await client.post(
        SKILLS_URL, json={"slug": "code-review-ritual", "files": make_files()}
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["id"] == created["id"]
    assert data["archived_at"] is not None
    assert len(data["versions"]) == 1


# --- board bindings (decision 1) ---------------------------------------------


async def test_effective_set_keeps_archived_bound_skill(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await _seed_published_skill(client, "still-running")
    bound = await client.put(
        f"{board_skills_url(test_board)}/still-running", json={}
    )
    assert bound.status_code == 200, bound.text

    archived = await _archive(client, "still-running")
    assert archived.status_code == 200, archived.text

    # Boards that already adopted the skill keep materializing it.
    response = await client.get(board_skills_url(test_board))
    assert response.status_code == 200, response.text
    items = response.json()["skills"]
    assert [item["slug"] for item in items] == ["still-running"]
    assert items[0]["version"] == 1


async def test_bind_archived_skill_new_binding_422(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await _seed_published_skill(client, "retired")
    archived = await _archive(client, "retired")
    assert archived.status_code == 200, archived.text

    # No binding row exists yet: a FRESH bind of an archived skill is a
    # validation error, not a 404 (the skill exists) and not a silent bind.
    response = await client.put(f"{board_skills_url(test_board)}/retired", json={})
    assert response.status_code == 422, response.text

    assert (await client.get(board_skills_url(test_board))).json()["skills"] == []


async def test_update_existing_binding_of_archived_skill_allowed(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await _seed_published_skill(client, "adjustable")
    url = f"{board_skills_url(test_board)}/adjustable"
    bound = await client.put(url, json={})
    assert bound.status_code == 200, bound.text
    archived = await _archive(client, "adjustable")
    assert archived.status_code == 200, archived.text

    # The binding row exists: toggling and pinning stay allowed post-archive.
    disabled = await client.put(url, json={"enabled": False})
    assert disabled.status_code == 200, disabled.text
    repinned = await client.put(url, json={"enabled": True, "pinned_version": 1})
    assert repinned.status_code == 200, repinned.text

    items = (await client.get(board_skills_url(test_board))).json()["skills"]
    assert [item["slug"] for item in items] == ["adjustable"]
    assert items[0]["pinned_version"] == 1


async def test_unbind_archived_skill_allowed(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await _seed_published_skill(client, "detachable")
    url = f"{board_skills_url(test_board)}/detachable"
    bound = await client.put(url, json={})
    assert bound.status_code == 200, bound.text
    archived = await _archive(client, "detachable")
    assert archived.status_code == 200, archived.text

    response = await client.delete(url)
    assert response.status_code == 204, response.text
    assert (await client.get(board_skills_url(test_board))).json()["skills"] == []


# --- catalog activation (decision 2) -----------------------------------------


async def test_activate_catalog_skill_unarchives_archived_skill(
    client: AsyncClient, test_workspace: Workspace
):
    listing = await client.get(CATALOG_URL)
    assert listing.status_code == 200, listing.text
    catalog_id = listing.json()["entries"][0]["catalog_id"]

    first = await client.post(f"{CATALOG_URL}/{catalog_id}/activate")
    assert first.status_code == 201, first.text
    archived = await _archive(client, catalog_id)
    assert archived.status_code == 200, archived.text

    # Re-activating is the ONE implicit unarchive: the existing skill comes
    # back live (200, not 409, not still-archived) with no version stacked.
    again = await client.post(f"{CATALOG_URL}/{catalog_id}/activate")
    assert again.status_code == 200, again.text
    data = again.json()
    assert data["id"] == first.json()["id"]
    assert data["archived_at"] is None
    assert len(data["versions"]) == 1
    assert data["latest_published_version"] == 1

    # And it is back in the default listing.
    skills = (await client.get(SKILLS_URL)).json()
    assert skills["count"] == 1


async def test_activate_catalog_unarchive_records_activity(
    client: AsyncClient,
    test_workspace: Workspace,
    db_session: AsyncSession,
):
    from app.models.activity import Activity, ActivityAction, ActivityEntityType

    listing = await client.get(CATALOG_URL)
    catalog_id = listing.json()["entries"][0]["catalog_id"]
    assert (await client.post(f"{CATALOG_URL}/{catalog_id}/activate")).status_code == 201
    assert (await _archive(client, catalog_id)).status_code == 200
    assert (await client.post(f"{CATALOG_URL}/{catalog_id}/activate")).status_code == 200

    # The implicit unarchive must leave the same audit trail as the explicit
    # endpoint — a skill silently reappearing in the listing with no activity
    # row is an audit hole.
    rows = (
        (
            await db_session.execute(
                select(Activity).where(
                    Activity.workspace_id == test_workspace.id,
                    Activity.entity_type == ActivityEntityType.skill,
                    Activity.action == ActivityAction.unarchived,
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1, [r.summary for r in rows]


async def test_publish_version_on_archived_skill_allowed(
    client: AsyncClient, test_workspace: Workspace, make_files
):
    """Decision 4 (pinned deliberately, flagged for owner review): archive
    closes ATTACHMENT points (new binds, new proposals, default listing), not
    admin authoring. Publishing on an archived skill stays allowed — blocking
    it would also wedge pre-archive proposals whose approval publishes later.
    Existing unpinned bindings deliberately keep resolving (decision 1), so a
    publish here does flow content to them; that is the admin's explicit,
    admin-gated act."""
    await _create_skill(client, make_files())
    assert (await _archive(client, "code-review-ritual")).status_code == 200

    published = await client.post(
        f"{SKILLS_URL}/code-review-ritual/versions/1/publish"
    )
    assert published.status_code == 200, published.text
    assert published.json()["status"] == "published"


# --- proposals (decision 3) ---------------------------------------------------


async def test_propose_skill_archived_slug_422(
    client: AsyncClient,
    agent_client: AsyncClient,
    test_workspace: Workspace,
    make_files,
):
    await _create_skill(client, make_files())
    archived = await _archive(client, "code-review-ritual")
    assert archived.status_code == 200, archived.text

    response = await agent_client.post(
        PROPOSALS_URL,
        json={"slug": "code-review-ritual", "files": make_files()},
    )
    assert response.status_code == 422, response.text
    assert "archived" in str(response.json()["detail"]).lower()


# --- activity -----------------------------------------------------------------


async def test_archive_and_unarchive_record_skill_activity(
    client: AsyncClient,
    test_workspace: Workspace,
    db_session: AsyncSession,
    make_files,
):
    from app.models.activity import Activity, ActivityAction, ActivityEntityType

    await _create_skill(client, make_files())
    assert (await _archive(client, "code-review-ritual")).status_code == 200
    assert (await _unarchive(client, "code-review-ritual")).status_code == 200

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
    assert ActivityAction.archived in actions, actions
    assert ActivityAction.unarchived in actions, actions
