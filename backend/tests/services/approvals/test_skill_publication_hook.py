# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Skill-publication decision hook — Skills Registry W2 (card cdcf94b7).

RED phase. Approving a `skill_publication` approval publishes the proposed
skill version IN THE SAME decide request/transaction — no background loop
(a bare async_session rolls back at close; see CLAUDE.md), so the effect is
asserted immediately after the REST decide call returns. Rejection marks the
version rejected. A hook failure must not leave a decided approval behind.

Also pins the W2 plumbing the hook stands on: the ApprovalCategory enum
member, its risk score sitting above the auto-approve threshold, and the
additive migration extending the Postgres enum (pinned by file text — SQLite
cannot execute ALTER TYPE).

Approvals are exercised over REST (mirroring tests/routers/approvals/
test_approvals.py); the proposal rows are seeded directly on the models so
the hook is pinned independently of the proposals endpoint.
"""

import uuid
from datetime import timedelta
from pathlib import Path

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.agents.agent import Agent
from app.models.approvals.approval import (
    ApprovalCategory,
    ApprovalRequest,
    ApprovalStatus,
)
from app.models.skills.skill import Skill, SkillVersion
from app.models.user import User
from app.models.workspace import Workspace
from app.services.approvals.risk import AUTO_APPROVE_THRESHOLD, BASE_SCORES
from app.utils import utcnow

BASE_URL = "/api/workspaces/default/approvals"

SKILL_MD = (
    "---\n"
    "name: Code Review Ritual\n"
    "description: How this workspace reviews pull requests.\n"
    "---\n\n## Steps\n"
)


async def seed_proposal(
    db: AsyncSession,
    workspace: Workspace,
    agent: Agent,
    slug: str = "code-review-ritual",
    version: int = 1,
    payload: dict | None = None,
) -> tuple[Skill, SkillVersion, ApprovalRequest]:
    """A skill with one 'proposed' version and its pending approval, exactly
    as the proposals endpoint leaves them."""
    skill = Skill(
        workspace_id=workspace.id,
        slug=slug,
        name="Code Review Ritual",
        description="How this workspace reviews pull requests.",
    )
    db.add(skill)
    await db.flush()
    row = SkillVersion(
        skill_id=skill.id,
        version=version,
        files=[{"path": "SKILL.md", "content": SKILL_MD}],
        status="proposed",
        content_hash="0" * 64,
    )
    db.add(row)
    await db.flush()
    approval = ApprovalRequest(
        agent_id=agent.id,
        workspace_id=workspace.id,
        category=ApprovalCategory.skill_publication,
        action_description=f"Publish skill {slug} version {version}",
        action_payload=payload
        if payload is not None
        else {"skill_id": str(skill.id), "version": version, "slug": slug},
        risk_score=80,
        status=ApprovalStatus.pending,
        expires_at=utcnow() + timedelta(hours=24),
    )
    db.add(approval)
    await db.flush()
    return skill, row, approval


async def _decide(client: AsyncClient, approval_id, decision: str):
    return await client.post(
        f"{BASE_URL}/{approval_id}/decide",
        json={"decision": decision, "reason": "test decision"},
    )


# --- the hook -----------------------------------------------------------------


async def test_decide_approve_publishes_version_immediately(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    test_agent: Agent,
):
    skill, version, approval = await seed_proposal(db_session, test_workspace, test_agent)

    response = await _decide(client, approval.id, "approved")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "approved"

    # Same request, no polling, no background task: the publish is already
    # visible the moment decide returns.
    await db_session.refresh(version)
    await db_session.refresh(skill)
    assert version.status == "published"
    assert skill.latest_published_version == 1


async def test_decide_reject_marks_version_rejected(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    test_agent: Agent,
):
    skill, version, approval = await seed_proposal(db_session, test_workspace, test_agent)

    response = await _decide(client, approval.id, "rejected")
    assert response.status_code == 200, response.text

    await db_session.refresh(version)
    await db_session.refresh(skill)
    assert version.status == "rejected"
    assert skill.latest_published_version is None


async def test_decide_approve_records_published_activity(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    test_agent: Agent,
):
    skill, _version, approval = await seed_proposal(db_session, test_workspace, test_agent)

    response = await _decide(client, approval.id, "approved")
    assert response.status_code == 200, response.text

    # Publishing via the hook leaves the SAME activity trail as a direct
    # publish — the board history must not depend on which path published.
    rows = (
        (
            await db_session.execute(
                select(Activity).where(
                    Activity.entity_type == ActivityEntityType.skill,
                    Activity.entity_id == skill.id,
                    Activity.action == ActivityAction.published,
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1


async def test_decide_missing_version_fails_and_approval_stays_pending(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    test_agent: Agent,
):
    # Payload points at a skill/version that does not exist (deleted between
    # proposal and decision).
    _skill, _version, approval = await seed_proposal(
        db_session,
        test_workspace,
        test_agent,
        payload={"skill_id": str(uuid.uuid4()), "version": 7, "slug": "ghost"},
    )

    response = await _decide(client, approval.id, "approved")
    assert response.status_code >= 400, response.text

    # The decision must not survive a failed hook. The test session never
    # auto-rolls-back, so this also pins the ORDER: the handler may not flip
    # the status before the hook's referent is known to exist.
    await db_session.refresh(approval)
    assert approval.status == ApprovalStatus.pending


async def test_decide_skill_publication_already_decided_409(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    test_agent: Agent,
):
    _skill, _version, approval = await seed_proposal(db_session, test_workspace, test_agent)

    first = await _decide(client, approval.id, "approved")
    assert first.status_code == 200, first.text

    second = await _decide(client, approval.id, "rejected")
    assert second.status_code == 409, second.text


async def test_decide_non_skill_category_unaffected_by_hook(
    client: AsyncClient,
    test_workspace: Workspace,
    test_user: User,
):
    # Control: a plain deletion approval still decides exactly as before —
    # the hook must key on category, never run for the other five.
    agent_resp = await client.post(
        "/api/agents",
        json={
            "name": "control-bot",
            "agent_type": "coding",
            "description": "test",
            "allowed_workspaces": ["default"],
        },
    )
    create_resp = await client.post(
        BASE_URL,
        json={
            "agent_id": agent_resp.json()["id"],
            "category": "deletion",
            "action_description": "Delete 12 cards",
            "action_payload": {"card_ids": ["abc", "def"]},
        },
    )
    assert create_resp.status_code == 201, create_resp.text

    response = await _decide(client, create_resp.json()["id"], "approved")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "approved"


# --- enum + scoring + migration pins (W2 section C) --------------------------


async def test_approval_category_has_skill_publication_member():
    assert ApprovalCategory.skill_publication.value == "skill_publication"


async def test_skill_publication_base_score_above_auto_approve_threshold():
    # A skill steers future agent behavior — it must NEVER auto-approve.
    assert BASE_SCORES[ApprovalCategory.skill_publication] > AUTO_APPROVE_THRESHOLD


async def test_migration_101_extends_approvalcategory_enum():
    # SQLite cannot execute ALTER TYPE, so the rolling-deploy-safe enum
    # extension is pinned by reading the migration text itself.
    versions_dir = Path(__file__).resolve().parents[3] / "alembic" / "versions"
    matches = sorted(versions_dir.glob("101_*.py"))
    assert matches, f"no 101_*.py migration in {versions_dir}"
    text = matches[0].read_text()
    normalized = " ".join(text.split())
    assert 'revision = "101"' in normalized
    assert 'down_revision = "100"' in normalized
    assert (
        "ALTER TYPE approvalcategory ADD VALUE IF NOT EXISTS 'skill_publication'"
        in normalized
    )


# --- malformed / forged payloads ---------------------------------------------
#
# action_payload is agent-supplied (MCP request_approval accepts an arbitrary
# dict), so the hook must treat every key as untrusted input: a bad payload is
# a 4xx that leaves the approval decidable, never a 500 that strands it.


async def test_decide_empty_payload_is_4xx_and_approval_stays_pending(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    test_agent: Agent,
):
    _skill, _version, approval = await seed_proposal(
        db_session, test_workspace, test_agent, payload={}
    )

    response = await _decide(client, approval.id, "approved")
    assert 400 <= response.status_code < 500, response.text

    await db_session.refresh(approval)
    assert approval.status == ApprovalStatus.pending


async def test_decide_non_uuid_skill_id_is_404_not_500(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    test_agent: Agent,
):
    _skill, _version, approval = await seed_proposal(
        db_session,
        test_workspace,
        test_agent,
        payload={"skill_id": "not-a-uuid", "version": 1, "slug": "code-review-ritual"},
    )

    response = await _decide(client, approval.id, "approved")
    assert response.status_code == 404, response.text

    await db_session.refresh(approval)
    assert approval.status == ApprovalStatus.pending


async def test_decide_non_integer_version_is_4xx_and_approval_stays_pending(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    test_agent: Agent,
):
    skill, _version, approval = await seed_proposal(db_session, test_workspace, test_agent)
    # Real skill, but the version key is junk the hook must not hand to a query.
    approval.action_payload = {"skill_id": str(skill.id), "version": None}
    await db_session.flush()

    response = await _decide(client, approval.id, "approved")
    assert 400 <= response.status_code < 500, response.text

    await db_session.refresh(approval)
    assert approval.status == ApprovalStatus.pending


async def test_decide_cross_tenant_payload_cannot_publish_other_workspace_skill(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    test_agent: Agent,
):
    """A forged payload naming ANOTHER workspace's skill must not publish it.

    The deciding admin is only an admin of workspace A; the approval lives in
    A, so the hook's workspace_id check is the whole defense.
    """
    victim_ws = Workspace(name="Victim", slug="victim-ws", created_by=test_user.id)
    db_session.add(victim_ws)
    await db_session.flush()

    victim_skill = Skill(
        workspace_id=victim_ws.id,
        slug="victim-skill",
        name="Victim Skill",
        description="Belongs to another workspace.",
    )
    db_session.add(victim_skill)
    await db_session.flush()
    victim_version = SkillVersion(
        skill_id=victim_skill.id,
        version=1,
        files=[{"path": "SKILL.md", "content": SKILL_MD}],
        status="proposed",
        content_hash="1" * 64,
    )
    db_session.add(victim_version)
    await db_session.flush()

    _skill, _version, approval = await seed_proposal(
        db_session,
        test_workspace,
        test_agent,
        payload={
            "skill_id": str(victim_skill.id),
            "version": 1,
            "slug": "victim-skill",
        },
    )

    response = await _decide(client, approval.id, "approved")
    assert response.status_code == 404, response.text

    await db_session.refresh(victim_version)
    await db_session.refresh(victim_skill)
    await db_session.refresh(approval)
    assert victim_version.status == "proposed"
    assert victim_skill.latest_published_version is None
    assert approval.status == ApprovalStatus.pending
