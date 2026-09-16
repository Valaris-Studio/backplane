# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from unittest.mock import AsyncMock, patch

from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.models.agents.agent import Agent
from app.models.approvals.approval import ApprovalCategory, ApprovalStatus
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.approvals.approval import ApprovalCreate, ApprovalDecide
from app.services.approvals.approval import ApprovalService


async def test_create_approval_publishes_event(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_agent: Agent
):
    """create_approval should publish APPROVAL_CREATED via event_bus."""
    with patch("app.services.approvals.approval.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        service = ApprovalService(db_session)
        data = ApprovalCreate(
            agent_id=test_agent.id,
            category=ApprovalCategory.deployment,
            action_description="Deploy backend to production",
            action_payload={"environment": "production"},
        )
        approval = await service.create_approval(test_workspace.id, data)

        mock_bus.publish.assert_awaited()
        call_args = mock_bus.publish.call_args
        assert call_args.kwargs["event_type"] == events.APPROVAL_CREATED
        assert call_args.kwargs["workspace_id"] == test_workspace.id

        payload = call_args.kwargs["payload"]
        assert payload["approval_id"] == str(approval.id)
        assert payload["category"] == ApprovalCategory.deployment.value
        assert payload["action_description"] == "Deploy backend to production"
        assert payload["agent_id"] == str(test_agent.id)
        assert payload["risk_score"] is not None


async def test_decide_approval_publishes_event(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_agent: Agent
):
    """decide should publish APPROVAL_UPDATED via event_bus."""
    service = ApprovalService(db_session)

    # Create a pending approval (high risk so it's not auto-approved)
    data = ApprovalCreate(
        agent_id=test_agent.id,
        category=ApprovalCategory.deployment,
        action_description="Deploy to production",
        action_payload={"environment": "production"},
    )
    approval = await service.create_approval(test_workspace.id, data)
    assert approval.status == ApprovalStatus.pending

    with patch("app.services.approvals.approval.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        decide_data = ApprovalDecide(
            decision=ApprovalStatus.approved,
            reason="Looks good",
        )
        await service.decide(approval.id, test_workspace.id, test_user.id, decide_data)

        mock_bus.publish.assert_awaited_once()
        call_args = mock_bus.publish.call_args
        assert call_args.kwargs["event_type"] == events.APPROVAL_UPDATED
        assert call_args.kwargs["workspace_id"] == test_workspace.id

        payload = call_args.kwargs["payload"]
        assert payload["approval_id"] == str(approval.id)
        assert payload["status"] == ApprovalStatus.approved.value
        assert payload["decided_by"] == str(test_user.id)
        assert payload["decision_reason"] == "Looks good"


async def test_auto_approved_publishes_created_event(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_agent: Agent
):
    """Auto-approved approvals should publish APPROVAL_CREATED with auto_approved status."""
    with patch("app.services.approvals.approval.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        service = ApprovalService(db_session)
        # external_action with no risky payload has risk score 30 = AUTO_APPROVE_THRESHOLD
        data = ApprovalCreate(
            agent_id=test_agent.id,
            category=ApprovalCategory.external_action,
            action_description="Push to feature branch",
            action_payload={"branch": "feature/test"},
        )
        approval = await service.create_approval(test_workspace.id, data)

        assert approval.status == ApprovalStatus.auto_approved

        mock_bus.publish.assert_awaited()
        call_args = mock_bus.publish.call_args
        assert call_args.kwargs["event_type"] == events.APPROVAL_CREATED
        payload = call_args.kwargs["payload"]
        assert payload["status"] == ApprovalStatus.auto_approved.value
