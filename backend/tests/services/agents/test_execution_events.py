# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from unittest.mock import AsyncMock, patch

from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.models.agents.agent import Agent
from app.models.agents.execution import ExecutionStatus
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.agents.execution import (
    ExecutionCreate,
    ExecutionUpdate,
    ExecutionWarningCreate,
)
from app.services.agents.execution import ExecutionService


async def test_log_execution_start_persists_prompt_slug_and_model(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_agent: Agent
):
    """Runner posts `prompt_slug` + `model` on execution-start so the row
    durably records which LLM ran which prompt. Frontend timeline columns
    that currently show em-dashes consume these directly."""
    service = ExecutionService(db_session)
    data = ExecutionCreate(
        workspace_slug=test_workspace.slug,
        action="implement_card",
        input_summary="Implement TDD-1",
        prompt_slug="implement",
        model="claude-sonnet-4-5",
    )
    execution = await service.start_execution(test_agent.id, data)

    assert execution.prompt_slug == "implement"
    assert execution.model == "claude-sonnet-4-5"


async def test_log_execution_start_persists_resolved_provider(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_agent: Agent
):
    """Runner posts the RESOLVED provider+model it actually ran (after its
    tier_providers remap), not the backend's tier suggestion. A premium stage
    the backend resolved to claude-cli/opus may run codex-cli/gpt-5.5 locally;
    the row must record the truth so the activity feed shows what executed."""
    service = ExecutionService(db_session)
    data = ExecutionCreate(
        workspace_slug=test_workspace.slug,
        action="implement_card",
        input_summary="Implement TDD-1",
        prompt_slug="implement",
        model="gpt-5.5",
        provider="codex-cli",
    )
    execution = await service.start_execution(test_agent.id, data)

    assert execution.provider == "codex-cli"
    assert execution.model == "gpt-5.5"


async def test_log_execution_start_provider_defaults_none_for_legacy_runner(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_agent: Agent
):
    """A pre-rollout runner omits provider entirely — the column stays NULL,
    keeping the endpoint backward compatible."""
    service = ExecutionService(db_session)
    data = ExecutionCreate(
        workspace_slug=test_workspace.slug,
        action="implement_card",
        input_summary="legacy",
        model="opus",
    )
    execution = await service.start_execution(test_agent.id, data)

    assert execution.provider is None


async def test_start_execution_publishes_event(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_agent: Agent
):
    """start_execution should publish EXECUTION_STARTED via event_bus."""
    with patch("app.services.agents.execution.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        service = ExecutionService(db_session)
        data = ExecutionCreate(
            workspace_slug=test_workspace.slug,
            action="implement_feature",
            input_summary="Build login page",
            board_id=None,
        )
        execution = await service.start_execution(test_agent.id, data)

        mock_bus.publish.assert_awaited_once()
        call_args = mock_bus.publish.call_args
        assert call_args.kwargs["event_type"] == events.EXECUTION_STARTED
        assert call_args.kwargs["workspace_id"] == test_workspace.id

        payload = call_args.kwargs["payload"]
        assert payload["execution_id"] == str(execution.id)
        assert payload["agent_id"] == str(test_agent.id)
        assert payload["action"] == "implement_feature"
        assert payload["input_summary"] == "Build login page"
        assert payload["board_id"] is None


async def test_update_execution_completed_publishes_event(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_agent: Agent
):
    """Updating execution to completed should publish EXECUTION_COMPLETED."""
    service = ExecutionService(db_session)
    data = ExecutionCreate(
        workspace_slug=test_workspace.slug,
        action="implement_feature",
        input_summary="Build login page",
    )
    execution = await service.start_execution(test_agent.id, data)

    with patch("app.services.agents.execution.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        update_data = ExecutionUpdate(
            status=ExecutionStatus.completed,
            output_summary="Login page built successfully",
            cost_usd=0.05,
            tokens_used=1500,
        )
        await service.update_execution(test_agent.id, execution.id, update_data)

        mock_bus.publish.assert_awaited_once()
        call_args = mock_bus.publish.call_args
        assert call_args.kwargs["event_type"] == events.EXECUTION_COMPLETED
        assert call_args.kwargs["workspace_id"] == test_workspace.id

        payload = call_args.kwargs["payload"]
        assert payload["execution_id"] == str(execution.id)
        assert payload["status"] == "completed"
        assert payload["cost_usd"] == 0.05
        assert payload["tokens_used"] == 1500
        assert payload["output_summary"] == "Login page built successfully"
        assert payload["error_message"] is None


async def test_update_execution_failed_publishes_event(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_agent: Agent
):
    """Updating execution to failed should publish EXECUTION_COMPLETED."""
    service = ExecutionService(db_session)
    data = ExecutionCreate(
        workspace_slug=test_workspace.slug,
        action="deploy_backend",
        input_summary="Deploy to staging",
    )
    execution = await service.start_execution(test_agent.id, data)

    with patch("app.services.agents.execution.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        update_data = ExecutionUpdate(
            status=ExecutionStatus.failed,
            error_message="Connection timeout",
        )
        await service.update_execution(test_agent.id, execution.id, update_data)

        mock_bus.publish.assert_awaited_once()
        call_args = mock_bus.publish.call_args
        assert call_args.kwargs["event_type"] == events.EXECUTION_COMPLETED

        payload = call_args.kwargs["payload"]
        assert payload["status"] == "failed"
        assert payload["error_message"] == "Connection timeout"


async def test_start_execution_with_card_id_binds_cards_affected(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_agent: Agent
):
    """Binding the reserved card at execution START makes agent_presence='active'
    authoritative — without this the runner (which never sets cards_affected)
    leaves the board blind to in-flight work even though activity/history reflect
    it. The card the runner reserved must appear in cards_affected immediately."""
    service = ExecutionService(db_session)
    card_id = uuid.uuid4()
    data = ExecutionCreate(
        workspace_slug=test_workspace.slug,
        action="implement_card",
        input_summary="Implement TDD-1",
        card_id=card_id,
    )
    execution = await service.start_execution(test_agent.id, data)

    assert execution.cards_affected == [str(card_id)]


async def test_start_execution_without_card_id_leaves_cards_affected_unset(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_agent: Agent
):
    """A non-card execution (e.g. a planning/triage stage) must not fabricate a
    cards_affected entry — backward compatible with legacy runners."""
    service = ExecutionService(db_session)
    data = ExecutionCreate(
        workspace_slug=test_workspace.slug,
        action="plan_work",
        input_summary="Decompose epic",
    )
    execution = await service.start_execution(test_agent.id, data)

    assert not execution.cards_affected


async def test_start_execution_event_carries_card_id(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_agent: Agent
):
    """EXECUTION_STARTED must carry card_id so a board can scope the live refetch
    (and a future targeted patch) to the right card."""
    with patch("app.services.agents.execution.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        service = ExecutionService(db_session)
        card_id = uuid.uuid4()
        data = ExecutionCreate(
            workspace_slug=test_workspace.slug,
            action="implement_card",
            input_summary="Build login page",
            board_id=None,
            card_id=card_id,
        )
        await service.start_execution(test_agent.id, data)

        payload = mock_bus.publish.call_args.kwargs["payload"]
        assert payload["card_id"] == str(card_id)


async def test_completed_event_carries_board_card_agent_ids(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_agent: Agent,
    test_board,
):
    """EXECUTION_COMPLETED must carry board_id, card_id and agent_id so the
    frontend board filter (payload.board_id === boardUuid) can flip a card's
    agent-presence indicator, and the runner's self-suppression can match on
    agent_id. All three are on the execution row (card via cards_affected)."""
    service = ExecutionService(db_session)
    board_id = test_board.id
    card_id = uuid.uuid4()
    data = ExecutionCreate(
        workspace_slug=test_workspace.slug,
        action="implement_card",
        input_summary="Build login page",
        board_id=board_id,
        card_id=card_id,
    )
    execution = await service.start_execution(test_agent.id, data)

    with patch("app.services.agents.execution.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        update_data = ExecutionUpdate(
            status=ExecutionStatus.completed,
            output_summary="done",
        )
        await service.update_execution(test_agent.id, execution.id, update_data)

        payload = mock_bus.publish.call_args.kwargs["payload"]
        assert payload["board_id"] == str(board_id)
        assert payload["card_id"] == str(card_id)
        assert payload["agent_id"] == str(test_agent.id)


async def test_failed_event_carries_board_card_agent_ids(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_agent: Agent,
    test_board,
):
    """The failed terminal path is the one that most needs these ids — a failed
    run must clear the card's active indicator, which the board filter can only
    do when board_id matches."""
    service = ExecutionService(db_session)
    board_id = test_board.id
    card_id = uuid.uuid4()
    data = ExecutionCreate(
        workspace_slug=test_workspace.slug,
        action="implement_card",
        input_summary="Build login page",
        board_id=board_id,
        card_id=card_id,
    )
    execution = await service.start_execution(test_agent.id, data)

    with patch("app.services.agents.execution.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        update_data = ExecutionUpdate(
            status=ExecutionStatus.failed,
            error_message="boom",
        )
        await service.update_execution(test_agent.id, execution.id, update_data)

        payload = mock_bus.publish.call_args.kwargs["payload"]
        assert payload["board_id"] == str(board_id)
        assert payload["card_id"] == str(card_id)
        assert payload["agent_id"] == str(test_agent.id)


async def test_completed_event_ids_none_safe_for_cardless_execution(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_agent: Agent
):
    """A non-card / non-board execution (e.g. a standup) must still publish —
    board_id and card_id serialize to None rather than raising."""
    service = ExecutionService(db_session)
    data = ExecutionCreate(
        workspace_slug=test_workspace.slug,
        action="standup",
        input_summary="daily standup",
    )
    execution = await service.start_execution(test_agent.id, data)

    with patch("app.services.agents.execution.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        update_data = ExecutionUpdate(status=ExecutionStatus.completed)
        await service.update_execution(test_agent.id, execution.id, update_data)

        payload = mock_bus.publish.call_args.kwargs["payload"]
        assert payload["board_id"] is None
        assert payload["card_id"] is None
        assert payload["agent_id"] == str(test_agent.id)


async def test_warning_event_carries_board_id(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_agent: Agent,
    test_board,
):
    """EXECUTION_WARNING already carries agent_id and card_id; add board_id so a
    board-scoped consumer can filter warnings the same way it filters
    completions."""
    service = ExecutionService(db_session)
    board_id = test_board.id
    card_id = uuid.uuid4()
    data = ExecutionCreate(
        workspace_slug=test_workspace.slug,
        action="implement_card",
        input_summary="Build login page",
        board_id=board_id,
        card_id=card_id,
    )
    execution = await service.start_execution(test_agent.id, data)

    with patch("app.services.agents.execution.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        warning = ExecutionWarningCreate(
            kind="deadline_warning",
            message="approaching deadline",
            card_id=card_id,
        )
        await service.record_warning(test_agent.id, execution.id, warning)

        payload = mock_bus.publish.call_args.kwargs["payload"]
        assert payload["board_id"] == str(board_id)
        assert payload["card_id"] == str(card_id)
        assert payload["agent_id"] == str(test_agent.id)


async def test_update_execution_running_does_not_publish(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_agent: Agent
):
    """Updating execution to running should NOT publish EXECUTION_COMPLETED."""
    service = ExecutionService(db_session)
    data = ExecutionCreate(
        workspace_slug=test_workspace.slug,
        action="analyze_code",
        input_summary="Review PR",
    )
    execution = await service.start_execution(test_agent.id, data)

    with patch("app.services.agents.execution.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        update_data = ExecutionUpdate(status=ExecutionStatus.running)
        await service.update_execution(test_agent.id, execution.id, update_data)

        mock_bus.publish.assert_not_awaited()
