# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent
from app.models.skills.skill import Skill, SkillVersion
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from tests.routers.skills.conftest import make_member
from tests.routers.skills.test_workspace_skills import canonical_hash

SKILLS_URL = "/api/workspaces/default/skills"
SKILL_URL = f"{SKILLS_URL}/review-history"
AUDIT_FIELDS = {
    "created_by_user_id",
    "created_by_agent_id",
    "approval_id",
    "base_version",
    "reason",
    "provenance",
}


async def create_skill(client: AsyncClient, files: list[dict]) -> dict:
    response = await client.post(
        SKILLS_URL, json={"slug": "review-history", "files": files}
    )
    assert response.status_code == 201, response.text
    return response.json()


async def create_version(client: AsyncClient, files: list[dict]) -> dict:
    response = await client.post(f"{SKILL_URL}/versions", json={"files": files})
    assert response.status_code == 201, response.text
    return response.json()


async def test_history_pages_newest_first_without_duplicate_or_skipped_revisions(
    client: AsyncClient,
    test_workspace: Workspace,
    make_files,
):
    await create_skill(client, make_files())
    for number in range(2, 5):
        await create_version(client, make_files(body=f"Revision {number}\n"))

    first = await client.get(f"{SKILL_URL}/versions", params={"limit": 2})
    assert first.status_code == 200, first.text
    assert [item["version"] for item in first.json()["items"]] == [4, 3]
    assert first.json()["next_before_version"] == 3
    assert all("files" not in item for item in first.json()["items"])
    assert all(AUDIT_FIELDS <= item.keys() for item in first.json()["items"])

    await create_version(client, make_files(body="Revision 5\n"))
    second = await client.get(
        f"{SKILL_URL}/versions", params={"limit": 2, "before_version": 3}
    )
    assert second.status_code == 200, second.text
    assert [item["version"] for item in second.json()["items"]] == [2, 1]
    assert second.json()["next_before_version"] is None

    exhausted = await client.get(f"{SKILL_URL}/versions", params={"before_version": 1})
    assert exhausted.status_code == 200, exhausted.text
    assert exhausted.json() == {"items": [], "next_before_version": None}


@pytest.mark.parametrize(
    "params", [{"limit": 0}, {"limit": 101}, {"before_version": 0}]
)
async def test_history_rejects_invalid_pagination(
    client: AsyncClient,
    test_workspace: Workspace,
    make_files,
    params,
):
    await create_skill(client, make_files())
    response = await client.get(f"{SKILL_URL}/versions", params=params)
    assert response.status_code == 422, response.text


async def test_diff_returns_full_changed_files_in_path_order_and_supports_reverse(
    client: AsyncClient,
    test_workspace: Workspace,
    make_files,
):
    original = make_files(
        extra_files=[
            {"path": "z-deleted.md", "content": "Removed\n"},
            {"path": "m-modified.md", "content": "Before\n"},
            {"path": "unchanged.md", "content": "Stable\n"},
        ]
    )
    revised = make_files(
        extra_files=[
            {"path": "unchanged.md", "content": "Stable\n"},
            {"path": "m-modified.md", "content": "After\n"},
            {"path": "a-added.md", "content": ""},
        ]
    )
    await create_skill(client, original)
    await create_version(client, revised)

    response = await client.get(
        f"{SKILL_URL}/diff", params={"from_version": 1, "to_version": 2}
    )
    assert response.status_code == 200, response.text
    assert response.json() == {
        "from_version": 1,
        "to_version": 2,
        "files": [
            {"path": "a-added.md", "change": "added", "before": None, "after": ""},
            {
                "path": "m-modified.md",
                "change": "modified",
                "before": "Before\n",
                "after": "After\n",
            },
            {
                "path": "z-deleted.md",
                "change": "deleted",
                "before": "Removed\n",
                "after": None,
            },
        ],
    }
    reverse = await client.get(
        f"{SKILL_URL}/diff", params={"from_version": 2, "to_version": 1}
    )
    assert reverse.status_code == 200, reverse.text
    assert reverse.json() == {
        "from_version": 2,
        "to_version": 1,
        "files": [
            {"path": "a-added.md", "change": "deleted", "before": "", "after": None},
            {
                "path": "m-modified.md",
                "change": "modified",
                "before": "After\n",
                "after": "Before\n",
            },
            {
                "path": "z-deleted.md",
                "change": "added",
                "before": None,
                "after": "Removed\n",
            },
        ],
    }
    same = await client.get(
        f"{SKILL_URL}/diff", params={"from_version": 1, "to_version": 1}
    )
    assert same.status_code == 200, same.text
    assert same.json() == {"from_version": 1, "to_version": 1, "files": []}

    for number, files in ((1, original), (2, revised)):
        exact = await client.get(f"{SKILL_URL}/versions/{number}")
        assert exact.status_code == 200, exact.text
        assert exact.json()["files"] == files
        assert exact.json()["content_hash"] == canonical_hash(files)


async def test_archived_skill_preserves_history_diff_and_exact_revision_reads(
    client: AsyncClient,
    test_workspace: Workspace,
    make_files,
):
    await create_skill(client, make_files())
    await create_version(client, make_files(body="Updated\n"))
    archived = await client.post(f"{SKILL_URL}/archive")
    assert archived.status_code == 200, archived.text

    history = await client.get(f"{SKILL_URL}/versions")
    assert history.status_code == 200, history.text
    assert [item["version"] for item in history.json()["items"]] == [2, 1]
    diff = await client.get(
        f"{SKILL_URL}/diff", params={"from_version": 1, "to_version": 2}
    )
    assert diff.status_code == 200, diff.text
    assert diff.json()["files"][0]["path"] == "SKILL.md"
    exact = await client.get(f"{SKILL_URL}/versions/1")
    assert exact.status_code == 200, exact.text


async def test_history_and_diff_scope_slug_to_workspace(
    client: AsyncClient,
    test_workspace: Workspace,
    test_user: User,
    db_session: AsyncSession,
    make_files,
):
    await create_skill(client, make_files())
    other = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(other)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=other.id,
            user_id=test_user.id,
            role=WorkspaceRole.owner,
        )
    )
    await db_session.flush()

    for suffix in ("versions", "history", "diff?from_version=1&to_version=1"):
        known = await client.get(f"{SKILL_URL}/{suffix}")
        assert known.status_code == 200, known.text
        foreign = await client.get(
            f"/api/workspaces/other/skills/review-history/{suffix}"
        )
        assert foreign.status_code == 404, foreign.text

    for params in (
        {"from_version": 1, "to_version": 99},
        {"from_version": 99, "to_version": 1},
    ):
        missing = await client.get(f"{SKILL_URL}/diff", params=params)
        assert missing.status_code == 404, missing.text


async def test_member_can_read_history_and_diff_but_non_member_cannot(
    client: AsyncClient,
    role_client: AsyncClient,
    test_workspace: Workspace,
    db_session: AsyncSession,
    second_user: User,
    make_files,
):
    await create_skill(client, make_files())
    member = await make_member(db_session, test_workspace)
    for suffix in ("versions", "history", "diff?from_version=1&to_version=1"):
        member_read = await role_client.get(
            f"{SKILL_URL}/{suffix}", headers={"X-User-Email": member.email}
        )
        assert member_read.status_code == 200, member_read.text
        denied = await role_client.get(
            f"{SKILL_URL}/{suffix}", headers={"X-User-Email": second_user.email}
        )
        assert denied.status_code == 403, denied.text


async def test_human_revision_metadata_preserves_authorship_and_provenance_on_publish(
    client: AsyncClient,
    test_workspace: Workspace,
    test_user: User,
    make_files,
):
    created = await create_skill(client, make_files())
    metadata = created["versions"][0]
    assert AUDIT_FIELDS <= metadata.keys()
    assert metadata["created_by_user_id"] == str(test_user.id)
    assert metadata["created_by_agent_id"] is None
    assert metadata["approval_id"] is None
    assert metadata["base_version"] is None
    assert metadata["reason"] is None
    assert isinstance(metadata["provenance"], dict)

    published = await client.post(f"{SKILL_URL}/versions/1/publish")
    assert published.status_code == 200, published.text
    assert published.json()["status"] == "published"
    for field in AUDIT_FIELDS | {"content_hash", "created_at"}:
        assert published.json()[field] == metadata[field]


async def test_agent_revision_records_authenticated_user_and_agent_separately(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_agent: Agent,
    test_user: User,
    make_files,
):
    proposal = await agent_client.post(
        f"{SKILLS_URL}/proposals",
        json={"slug": "review-history", "files": make_files()},
    )
    assert proposal.status_code == 201, proposal.text
    history = await agent_client.get(f"{SKILL_URL}/versions")
    assert history.status_code == 200, history.text
    metadata = history.json()["items"][0]
    assert metadata["created_by_user_id"] == str(test_user.id)
    assert metadata["created_by_agent_id"] == str(test_agent.id)
    assert metadata["approval_id"] == proposal.json()["approval_id"]
    assert metadata["provenance"]["user_id"] == str(test_user.id)
    assert metadata["provenance"]["agent_id"] == str(test_agent.id)
    assert metadata["provenance"]["agent_name"] == test_agent.name


async def test_legacy_revision_returns_unknown_provenance_without_inventing_authorship(
    client: AsyncClient,
    test_workspace: Workspace,
    db_session: AsyncSession,
    make_files,
):
    files = make_files()
    skill = Skill(
        workspace_id=test_workspace.id,
        slug="review-history",
        name="Legacy",
        description="Legacy",
    )
    db_session.add(skill)
    await db_session.flush()
    revision = SkillVersion(
        skill_id=skill.id,
        version=1,
        files=files,
        status="published",
        content_hash=canonical_hash(files),
    )
    db_session.add(revision)
    await db_session.flush()

    history = await client.get(f"{SKILL_URL}/versions")
    assert history.status_code == 200, history.text
    metadata = history.json()["items"][0]
    assert uuid.UUID(metadata["id"]) == revision.id
    for field in AUDIT_FIELDS:
        assert metadata[field] is None
    exact = await client.get(f"{SKILL_URL}/versions/1")
    assert exact.status_code == 200, exact.text
    assert exact.json()["files"] == files


async def test_revision_reason_and_base_snapshot_survive_later_versions_and_actor_rename(
    client: AsyncClient,
    test_workspace: Workspace,
    test_user: User,
    db_session: AsyncSession,
    make_files,
):
    original_name = test_user.name
    first = await client.post(
        SKILLS_URL,
        json={
            "slug": "review-history",
            "files": make_files(),
            "reason": "Establish review practice",
        },
    )
    assert first.status_code == 201, first.text
    second = await client.post(
        f"{SKILL_URL}/versions",
        json={
            "files": make_files(body="Second revision\n"),
            "reason": "Require release evidence",
            "base_version": 1,
        },
    )
    assert second.status_code == 201, second.text
    metadata = second.json()
    assert metadata["base_version"] == 1
    assert metadata["reason"] == "Require release evidence"
    assert metadata["provenance"]["user_id"] == str(test_user.id)
    assert metadata["provenance"]["user_name"] == original_name

    test_user.name = "Renamed after authorship"
    await db_session.flush()
    third = await create_version(client, make_files(body="Third revision\n"))
    assert third["base_version"] is None
    assert third["provenance"]["user_name"] == "Renamed after authorship"

    history = await client.get(f"{SKILL_URL}/versions")
    assert history.status_code == 200, history.text
    by_version = {item["version"]: item for item in history.json()["items"]}
    assert by_version[1]["base_version"] is None
    assert by_version[1]["reason"] == "Establish review practice"
    assert by_version[2]["provenance"] == metadata["provenance"]
    assert by_version[2]["reason"] == "Require release evidence"
    assert by_version[2]["base_version"] == 1


@pytest.mark.parametrize("base_version", [0, -1, 99])
async def test_revision_rejects_invalid_declared_base(
    client: AsyncClient, test_workspace: Workspace, make_files, base_version,
):
    await create_skill(client, make_files())
    response = await client.post(
        f"{SKILL_URL}/versions",
        json={"files": make_files(body="Updated\n"), "base_version": base_version},
    )
    assert response.status_code == 422, response.text


async def test_revision_keeps_declared_ancestry_when_newer_revision_exists(
    client: AsyncClient, test_workspace: Workspace, make_files,
):
    await create_skill(client, make_files())
    await create_version(client, make_files(body="Second revision\n"))
    response = await client.post(
        f"{SKILL_URL}/versions",
        json={"files": make_files(body="Branched revision\n"), "base_version": 1},
    )
    assert response.status_code == 201, response.text
    assert response.json()["version"] == 3
    assert response.json()["base_version"] == 1


async def test_initial_skill_rejects_declared_base(
    client: AsyncClient, test_workspace: Workspace, make_files,
):
    response = await client.post(
        SKILLS_URL,
        json={"slug": "review-history", "files": make_files(), "base_version": 1},
    )
    assert response.status_code == 422, response.text


async def test_audit_history_pages_events_and_preserves_actor_snapshot(
    client: AsyncClient,
    test_workspace: Workspace,
    test_user: User,
    db_session: AsyncSession,
    make_files,
):
    original_name = test_user.name
    await create_skill(client, make_files())
    published = await client.post(f"{SKILL_URL}/versions/1/publish")
    assert published.status_code == 200, published.text
    archived = await client.post(f"{SKILL_URL}/archive")
    assert archived.status_code == 200, archived.text
    test_user.name = "Renamed later"
    await db_session.flush()

    first = await client.get(f"{SKILL_URL}/history", params={"limit": 2})
    assert first.status_code == 200, first.text
    items = first.json()["items"]
    assert len(items) == 2
    assert all(item["actor"]["user_name"] == original_name for item in items)
    assert all(item["actor"]["user_id"] == str(test_user.id) for item in items)
    assert first.json()["next_before_id"] == items[-1]["id"]

    unarchived = await client.post(f"{SKILL_URL}/unarchive")
    assert unarchived.status_code == 200, unarchived.text
    second = await client.get(
        f"{SKILL_URL}/history",
        params={"limit": 2, "before_id": first.json()["next_before_id"]},
    )
    assert second.status_code == 200, second.text
    assert len(second.json()["items"]) == 1
    assert second.json()["next_before_id"] is None
    all_ids = [item["id"] for item in items + second.json()["items"]]
    assert len(set(all_ids)) == 3


@pytest.mark.parametrize("params", [{"limit": 0}, {"limit": 101}, {"before_id": "bad"}])
async def test_audit_history_rejects_invalid_pagination(
    client: AsyncClient, test_workspace: Workspace, make_files, params,
):
    await create_skill(client, make_files())
    response = await client.get(f"{SKILL_URL}/history", params=params)
    assert response.status_code == 422, response.text


async def test_audit_history_cursor_is_scoped_to_skill(
    client: AsyncClient, test_workspace: Workspace, make_files,
):
    await create_skill(client, make_files())
    other = await client.post(
        SKILLS_URL, json={"slug": "other-history", "files": make_files()}
    )
    assert other.status_code == 201, other.text
    foreign = await client.get(f"{SKILLS_URL}/other-history/history")
    assert foreign.status_code == 200, foreign.text
    foreign_id = foreign.json()["items"][0]["id"]
    for cursor in (foreign_id, str(uuid.uuid4())):
        response = await client.get(
            f"{SKILL_URL}/history", params={"before_id": cursor}
        )
        assert response.status_code == 404, response.text
