# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Agent skill proposals — POST /api/workspaces/{slug}/skills/proposals.

RED phase for Skills Registry W2 (card cdcf94b7): agents cannot author skills
directly (forbid_agent_callers on the registry writes), so their path is a
PROPOSAL that lands as a pending ApprovalRequest for a human to decide.

Pins: agent-only access (humans get pointed at the draft+publish path), W1
bundle validation reuse, skill+version+approval creation in one call, pending
(never auto-approved) approvals, content-hash idempotency while pending, and
the per-board `skills_proposal_enabled` loop-config gate.

Trap note (same as test_workspace_skills.py): the app wraps route-missing
404s, so negative tests here either expect a NON-404 status or anchor on a
known-good 201 first — a missing /proposals route can never go green.
"""

import uuid

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.approvals.approval import ApprovalRequest, ApprovalStatus
from app.models.kanban.board import Board
from app.models.skills.skill import Skill, SkillVersion
from app.models.workspace import Workspace
from app.services.approvals.risk import AUTO_APPROVE_THRESHOLD

PROPOSALS_URL = "/api/workspaces/default/skills/proposals"
SKILLS_URL = "/api/workspaces/default/skills"

# The 201 wire contract — extra keys are allowed, these four are required.
RESPONSE_REQUIRED_KEYS = {"approval_id", "skill_slug", "version", "status"}


async def _propose(
    client: AsyncClient,
    files: list[dict],
    slug: str = "code-review-ritual",
    board_id: str | None = None,
):
    body: dict = {"slug": slug, "files": files}
    if board_id is not None:
        body["board_id"] = board_id
    return await client.post(PROPOSALS_URL, json=body)


async def _get_approval(db: AsyncSession, approval_id: str) -> ApprovalRequest:
    result = await db.execute(
        select(ApprovalRequest).where(ApprovalRequest.id == uuid.UUID(approval_id))
    )
    return result.scalar_one()


# --- happy path: new skill --------------------------------------------------


async def test_propose_skill_new_slug_creates_skill_version_and_pending_approval(
    agent_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    make_files,
):
    response = await _propose(agent_client, make_files())
    assert response.status_code == 201, response.text
    data = response.json()
    assert RESPONSE_REQUIRED_KEYS <= set(data.keys()), data.keys()
    assert data["skill_slug"] == "code-review-ritual"
    assert data["version"] == 1
    assert data["status"] == "proposed"

    # The skill row exists with name/description MIRRORED from frontmatter.
    skill = (
        await db_session.execute(
            select(Skill).where(
                Skill.workspace_id == test_workspace.id,
                Skill.slug == "code-review-ritual",
            )
        )
    ).scalar_one()
    assert skill.name == "Code Review Ritual"
    assert skill.description == "How this workspace reviews pull requests."
    assert skill.latest_published_version is None

    # Version 1 lands as 'proposed', never 'draft' — the proposal path skips
    # the human draft stage by design.
    version = (
        await db_session.execute(
            select(SkillVersion).where(SkillVersion.skill_id == skill.id)
        )
    ).scalar_one()
    assert version.version == 1
    assert version.status == "proposed"

    # The approval is PENDING, never auto-approved: skill content steers
    # future agent behavior, so its base risk score must sit above the
    # auto-approve threshold.
    approval = await _get_approval(db_session, data["approval_id"])
    assert approval.category.value == "skill_publication"
    assert approval.status == ApprovalStatus.pending
    assert approval.risk_score > AUTO_APPROVE_THRESHOLD
    assert approval.action_payload["skill_id"] == str(skill.id)
    assert approval.action_payload["version"] == 1
    assert approval.action_payload["slug"] == "code-review-ritual"
    assert approval.board_id is None


async def test_propose_skill_board_id_passthrough(
    agent_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    make_files,
):
    # test_board has NO loop_config stored — the flag defaults open, so a
    # board_id on an unconfigured board must not block the proposal.
    response = await _propose(
        agent_client, make_files(), board_id=str(test_board.id)
    )
    assert response.status_code == 201, response.text

    approval = await _get_approval(db_session, response.json()["approval_id"])
    assert approval.board_id == test_board.id


# --- existing skill: next version --------------------------------------------


async def test_propose_skill_existing_skill_creates_next_version(
    client: AsyncClient,
    agent_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    make_files,
):
    # A human authored v1 through the registry (draft) — the agent proposal
    # must stack on top as max+1, not collide or reset.
    created = await client.post(
        SKILLS_URL, json={"slug": "code-review-ritual", "files": make_files()}
    )
    assert created.status_code == 201, created.text

    response = await _propose(
        agent_client, make_files(body="## Steps\n\n1. Read it three times.\n")
    )
    assert response.status_code == 201, response.text
    data = response.json()
    assert data["version"] == 2
    assert data["status"] == "proposed"

    skill_id = uuid.UUID(created.json()["id"])
    versions = (
        (
            await db_session.execute(
                select(SkillVersion)
                .where(SkillVersion.skill_id == skill_id)
                .order_by(SkillVersion.version)
            )
        )
        .scalars()
        .all()
    )
    assert [v.version for v in versions] == [1, 2]
    assert versions[1].status == "proposed"


# --- idempotency --------------------------------------------------------------


async def test_propose_skill_idempotent_same_content_while_pending(
    agent_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    make_files,
):
    files = make_files()
    first = await _propose(agent_client, files)
    assert first.status_code == 201, first.text

    # Agents retry: the identical bundle (same content_hash) while the first
    # proposal is still pending returns the SAME approval and version as a
    # 200 — no stacked version, no duplicate approval.
    second = await _propose(agent_client, files)
    assert second.status_code == 200, second.text
    assert second.json()["approval_id"] == first.json()["approval_id"]
    assert second.json()["version"] == first.json()["version"]

    version_count = len(
        (await db_session.execute(select(SkillVersion))).scalars().all()
    )
    assert version_count == 1
    approval_count = len(
        (await db_session.execute(select(ApprovalRequest))).scalars().all()
    )
    assert approval_count == 1


async def test_propose_skill_different_content_coexists_as_new_pending_version(
    agent_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    make_files,
):
    first = await _propose(agent_client, make_files())
    assert first.status_code == 201, first.text

    second = await _propose(
        agent_client, make_files(body="## Steps\n\n1. Something else.\n")
    )
    assert second.status_code == 201, second.text
    assert second.json()["version"] == first.json()["version"] + 1
    assert second.json()["approval_id"] != first.json()["approval_id"]

    # Two pending proposals for the same skill, different versions, coexist.
    approvals = (
        (await db_session.execute(select(ApprovalRequest))).scalars().all()
    )
    assert len(approvals) == 2
    assert all(a.status == ApprovalStatus.pending for a in approvals)


# --- access gating ------------------------------------------------------------


async def test_propose_skill_human_caller_forbidden(
    client: AsyncClient,
    agent_client: AsyncClient,
    test_workspace: Workspace,
    make_files,
):
    # Known-good first: the agent path 201s, so the human 403 below cannot be
    # a route-missing artifact wearing the wrong status.
    ok = await _propose(agent_client, make_files(), slug="agent-authored")
    assert ok.status_code == 201, ok.text

    response = await _propose(client, make_files(), slug="human-authored")
    assert response.status_code == 403, response.text
    # Humans are redirected to their own path — direct authoring via
    # draft + publish on the registry.
    assert "draft" in str(response.json()["detail"]).lower()


# --- W1 validation rails reused ----------------------------------------------


async def test_propose_skill_invalid_files_422(
    agent_client: AsyncClient, test_workspace: Workspace
):
    # No root SKILL.md — the same structural rail as W1 create.
    response = await _propose(
        agent_client, [{"path": "README.md", "content": "not a manifest"}]
    )
    assert response.status_code == 422, response.text


async def test_propose_skill_oversize_file_413(
    agent_client: AsyncClient, test_workspace: Workspace, make_files
):
    files = make_files(
        extra_files=[{"path": "huge.md", "content": "x" * (64 * 1024 + 1)}]
    )
    response = await _propose(agent_client, files)
    assert response.status_code == 413, response.text


# --- per-board loop-config gate ----------------------------------------------


async def test_propose_skill_board_flag_disabled_403(
    agent_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    make_files,
):
    test_board.loop_config = {"enabled": False, "skills_proposal_enabled": False}
    await db_session.flush()

    response = await _propose(
        agent_client, make_files(), board_id=str(test_board.id)
    )
    assert response.status_code == 403, response.text

    # A gated proposal leaves NOTHING behind — no skill, no version, no
    # approval half-created before the flag check.
    assert (await db_session.execute(select(Skill))).scalars().all() == []
    assert (await db_session.execute(select(ApprovalRequest))).scalars().all() == []


async def test_propose_skill_board_flag_enabled_allows(
    agent_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    make_files,
):
    test_board.loop_config = {"enabled": False, "skills_proposal_enabled": True}
    await db_session.flush()

    response = await _propose(
        agent_client, make_files(), board_id=str(test_board.id)
    )
    assert response.status_code == 201, response.text
