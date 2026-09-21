# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import copy
import json
from contextlib import contextmanager

import pytest
from sqlalchemy import select

from app.core.auth import (
    current_agent_id,
    current_api_key_id,
    current_api_key_name,
    current_authentication_method,
)
from app.models.approvals.approval import ApprovalRequest, ApprovalStatus
from app.models.skills.skill import SkillAuditEvent
from app.repositories.skills.skill import SkillAuditEventRepository
from app.schemas.approvals.approval import ApprovalDecide
from app.schemas.skills.skill import SkillProposalCreate
from app.services.api_key import ApiKeyService
from app.services.approvals.approval import ApprovalService
from app.services.skills.skill_service import SkillService


@contextmanager
def authenticated_actor(*, agent=None, key=None, method="session"):
    values = (
        (current_agent_id, agent.id if agent else None),
        (current_api_key_id, key.id if key else None),
        (current_api_key_name, key.name if key else None),
        (current_authentication_method, method),
    )
    tokens = [(variable, variable.set(value)) for variable, value in values]
    try:
        yield
    finally:
        for variable, token in reversed(tokens):
            variable.reset(token)


async def proposal(db_session, workspace, user, agent):
    key, raw_key = await ApiKeyService(db_session).create_key(user.id, "Proposal key")
    agent.api_key_id = key.id
    await db_session.flush()
    payload = SkillProposalCreate(
        slug="provenance-lifecycle",
        reason="Capture the verified workflow",
        files=[
            {
                "path": "SKILL.md",
                "content": "---\nname: Provenance\ndescription: Audit the workflow\n---\nVerify outcomes.\n",
            }
        ],
    )
    with authenticated_actor(agent=agent, key=key, method="api_key"):
        result, created = await SkillService(db_session).propose_skill(
            workspace.id, payload, user.id
        )
    assert created
    return result, key, raw_key


async def audit_events(db_session, skill_id):
    return list(
        (
            await db_session.scalars(
                select(SkillAuditEvent).where(SkillAuditEvent.skill_id == skill_id)
            )
        ).all()
    )


@pytest.mark.parametrize(
    ("decision", "version_status", "event_type"),
    [
        (ApprovalStatus.approved, "published", "published"),
        (ApprovalStatus.rejected, "rejected", "rejected"),
    ],
)
@pytest.mark.parametrize("decision_method", ["session", "api_key"])
async def test_proposal_decision_preserves_author_and_records_decider(
    db_session,
    test_workspace,
    test_user,
    second_user,
    test_agent,
    decision,
    version_status,
    event_type,
    decision_method,
):
    result, key, raw_key = await proposal(
        db_session, test_workspace, test_user, test_agent
    )
    service = SkillService(db_session)
    version = await service.get_version(test_workspace.id, result["skill_slug"], 1)
    original_provenance = copy.deepcopy(version.provenance)
    original_files = copy.deepcopy(version.files)
    assert original_provenance == {
        "user_id": str(test_user.id),
        "user_name": test_user.name,
        "agent_id": str(test_agent.id),
        "agent_name": test_agent.name,
        "credential_id": str(key.id),
        "authentication_method": "api_key",
    }

    decision_key = None
    decision_raw_key = None
    if decision_method == "api_key":
        decision_key, decision_raw_key = await ApiKeyService(db_session).create_key(
            second_user.id, "Operator automation"
        )
    with authenticated_actor(key=decision_key, method=decision_method):
        await ApprovalService(db_session).decide(
            result["approval_id"],
            test_workspace.id,
            second_user.id,
            ApprovalDecide(
                decision=decision, reason="Reviewed against project principles"
            ),
        )

    await db_session.refresh(version)
    assert version.status == version_status
    assert version.provenance == original_provenance
    assert version.files == original_files
    assert version.reason == "Capture the verified workflow"
    assert version.created_by_user_id == test_user.id
    assert version.created_by_agent_id == test_agent.id
    assert version.approval_id == result["approval_id"]
    events = await audit_events(db_session, version.skill_id)
    expected_types = ["authored", event_type]
    if decision == ApprovalStatus.approved:
        expected_types.append("approved")
    assert sorted(event.event_type for event in events) == sorted(expected_types)
    authored = next(event for event in events if event.event_type == "authored")
    decided = next(event for event in events if event.event_type == event_type)
    assert authored.actor == original_provenance
    assert authored.reason == version.reason
    assert authored.details["approval_id"] == str(result["approval_id"])
    assert decided.actor == {
        "user_id": str(second_user.id),
        "user_name": second_user.name,
        "agent_id": None,
        "agent_name": None,
        "credential_id": str(decision_key.id) if decision_key else None,
        "authentication_method": decision_method,
    }
    assert decided.version == 1
    assert decided.reason == "Reviewed against project principles"
    assert decided.details["approval_id"] == str(result["approval_id"])
    if decision == ApprovalStatus.approved:
        approved = next(event for event in events if event.event_type == "approved")
        assert approved.actor == decided.actor
        assert approved.version == version.version
        assert approved.reason == decided.reason
        assert approved.details["approval_id"] == str(result["approval_id"])
    assert raw_key not in json.dumps([event.actor for event in events])
    if decision_raw_key:
        assert decision_raw_key not in json.dumps([event.actor for event in events])


async def test_provenance_and_history_survive_credential_agent_approval_cleanup(
    db_session,
    test_workspace,
    test_user,
    test_agent,
):
    result, key, _ = await proposal(db_session, test_workspace, test_user, test_agent)
    service = SkillService(db_session)
    with authenticated_actor():
        await ApprovalService(db_session).decide(
            result["approval_id"],
            test_workspace.id,
            test_user.id,
            ApprovalDecide(decision=ApprovalStatus.approved, reason="Ready to publish"),
        )
    version = await service.get_version(test_workspace.id, result["skill_slug"], 1)
    snapshot = copy.deepcopy(version.provenance)
    events = await audit_events(db_session, version.skill_id)
    history = {
        event.id: (
            event.event_type,
            copy.deepcopy(event.actor),
            copy.deepcopy(event.details),
        )
        for event in events
    }
    approval = await db_session.get(ApprovalRequest, result["approval_id"])
    await db_session.delete(approval)
    await db_session.flush()
    await db_session.delete(test_agent)
    await db_session.flush()
    await db_session.delete(key)
    await db_session.flush()
    await db_session.refresh(version)
    assert version.created_by_agent_id is None
    assert version.provenance == snapshot
    assert version.approval_id == result["approval_id"]
    assert version.status == "published"
    assert {
        event.id: (event.event_type, event.actor, event.details)
        for event in await audit_events(db_session, version.skill_id)
    } == history


async def test_direct_publication_does_not_claim_pending_approval_decided(
    db_session,
    test_workspace,
    test_user,
    test_agent,
):
    result, _, _ = await proposal(db_session, test_workspace, test_user, test_agent)
    service = SkillService(db_session)

    with authenticated_actor():
        version = await service.publish_version(
            test_workspace.id, result["skill_slug"], 1, test_user.id
        )

    approval = await db_session.get(ApprovalRequest, result["approval_id"])
    assert approval.status == ApprovalStatus.pending
    assert version.approval_id == approval.id
    published = next(
        event
        for event in await audit_events(db_session, version.skill_id)
        if event.event_type == "published"
    )
    assert published.details["approval_id"] is None


async def test_approval_after_direct_publication_keeps_decision_audit(
    db_session,
    test_workspace,
    test_user,
    second_user,
    test_agent,
):
    result, _, _ = await proposal(db_session, test_workspace, test_user, test_agent)
    service = SkillService(db_session)
    with authenticated_actor():
        version = await service.publish_version(
            test_workspace.id, result["skill_slug"], 1, test_user.id
        )
        await ApprovalService(db_session).decide(
            result["approval_id"],
            test_workspace.id,
            second_user.id,
            ApprovalDecide(
                decision=ApprovalStatus.approved, reason="Approved after publication"
            ),
        )

    events = await audit_events(db_session, version.skill_id)
    assert sorted(event.event_type for event in events) == [
        "approved",
        "authored",
        "published",
    ]
    approved = next(event for event in events if event.event_type == "approved")
    assert approved.actor["user_id"] == str(second_user.id)
    assert approved.actor["authentication_method"] == "session"
    assert approved.reason == "Approved after publication"
    assert approved.details["approval_id"] == str(result["approval_id"])
    assert approved.version == 1


@pytest.mark.parametrize("decision", [ApprovalStatus.approved, ApprovalStatus.rejected])
async def test_decision_audit_failure_rolls_back_approval_and_revision(
    db_session,
    test_workspace,
    test_user,
    test_agent,
    monkeypatch,
    decision,
):
    result, _, _ = await proposal(db_session, test_workspace, test_user, test_agent)
    workspace_id, user_id = test_workspace.id, test_user.id
    await db_session.commit()

    create_audit = SkillAuditEventRepository.create

    async def unavailable_decision_audit(repository, **kwargs):
        if kwargs["event_type"] == decision.value:
            raise RuntimeError("decision audit unavailable")
        return await create_audit(repository, **kwargs)

    monkeypatch.setattr(SkillAuditEventRepository, "create", unavailable_decision_audit)
    with (
        authenticated_actor(),
        pytest.raises(RuntimeError, match="decision audit unavailable"),
    ):
        async with db_session.begin():
            await ApprovalService(db_session).decide(
                result["approval_id"],
                workspace_id,
                user_id,
                ApprovalDecide(decision=decision, reason="Decision must be atomic"),
            )

    approval = await db_session.get(ApprovalRequest, result["approval_id"])
    assert approval.status == ApprovalStatus.pending
    assert approval.decided_by_id is None
    assert approval.decided_at is None
    assert approval.decision_reason is None
    service = SkillService(db_session)
    skill = await service.get_skill_detail(workspace_id, result["skill_slug"])
    version = await service.get_version(workspace_id, result["skill_slug"], 1)
    assert skill.latest_published_version is None
    assert version.status == "proposed"
    assert [event.event_type for event in await audit_events(db_session, skill.id)] == [
        "authored"
    ]


async def test_approval_history_records_decision_before_publication(
    db_session, test_workspace, test_user, second_user, test_agent
):
    result, _, _ = await proposal(db_session, test_workspace, test_user, test_agent)
    with authenticated_actor():
        await ApprovalService(db_session).decide(
            result["approval_id"],
            test_workspace.id,
            second_user.id,
            ApprovalDecide(decision=ApprovalStatus.approved, reason="Reviewed"),
        )
    events = list(
        (
            await db_session.scalars(
                select(SkillAuditEvent).order_by(
                    SkillAuditEvent.created_at, SkillAuditEvent.id
                )
            )
        ).all()
    )
    assert [event.event_type for event in events] == [
        "authored",
        "approved",
        "published",
    ]
