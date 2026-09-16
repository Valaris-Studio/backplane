# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.alerts.alert_threshold import AlertMetric, AlertOperator, AlertThreshold
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace
from app.services.alerts.alert_threshold import AlertThresholdService


async def test_evaluate_triggers_threshold_gt(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_board: Board
):
    db_session.add(AlertThreshold(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        name="Too many stale cards",
        metric=AlertMetric.stale_card_count,
        operator=AlertOperator.gt,
        value=5.0,
        created_by_id=test_user.id,
    ))
    await db_session.flush()

    service = AlertThresholdService(db_session)
    triggered = await service.evaluate_for_board(
        test_board.id,
        {"stale_card_count": 8},
    )
    assert len(triggered) == 1
    assert triggered[0]["name"] == "Too many stale cards"
    assert triggered[0]["current_value"] == 8


async def test_evaluate_does_not_trigger_when_below(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_board: Board
):
    db_session.add(AlertThreshold(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        name="Low health",
        metric=AlertMetric.health_score,
        operator=AlertOperator.lt,
        value=50.0,
        created_by_id=test_user.id,
    ))
    await db_session.flush()

    service = AlertThresholdService(db_session)
    triggered = await service.evaluate_for_board(
        test_board.id,
        {"health_score": 75.0},
    )
    assert len(triggered) == 0


async def test_evaluate_lt_triggers(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_board: Board
):
    db_session.add(AlertThreshold(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        name="Low health",
        metric=AlertMetric.health_score,
        operator=AlertOperator.lt,
        value=50.0,
        created_by_id=test_user.id,
    ))
    await db_session.flush()

    service = AlertThresholdService(db_session)
    triggered = await service.evaluate_for_board(
        test_board.id,
        {"health_score": 30.0},
    )
    assert len(triggered) == 1
    assert triggered[0]["current_value"] == 30.0


async def test_evaluate_skips_inactive_thresholds(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_board: Board
):
    db_session.add(AlertThreshold(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        name="Disabled alert",
        metric=AlertMetric.stale_card_count,
        operator=AlertOperator.gt,
        value=0.0,
        is_active=False,
        created_by_id=test_user.id,
    ))
    await db_session.flush()

    service = AlertThresholdService(db_session)
    triggered = await service.evaluate_for_board(
        test_board.id,
        {"stale_card_count": 100},
    )
    assert len(triggered) == 0


async def test_evaluate_skips_missing_metrics(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_board: Board
):
    db_session.add(AlertThreshold(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        name="Reversion alert",
        metric=AlertMetric.reversion_rate,
        operator=AlertOperator.gte,
        value=0.1,
        created_by_id=test_user.id,
    ))
    await db_session.flush()

    service = AlertThresholdService(db_session)
    triggered = await service.evaluate_for_board(
        test_board.id,
        {"health_score": 50.0},  # no reversion_rate
    )
    assert len(triggered) == 0


async def test_evaluate_multiple_thresholds(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_board: Board
):
    db_session.add_all([
        AlertThreshold(
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            name="Low health",
            metric=AlertMetric.health_score,
            operator=AlertOperator.lt,
            value=60.0,
            created_by_id=test_user.id,
        ),
        AlertThreshold(
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            name="Stale cards",
            metric=AlertMetric.stale_card_count,
            operator=AlertOperator.gt,
            value=3.0,
            created_by_id=test_user.id,
        ),
        AlertThreshold(
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            name="Low efficiency",
            metric=AlertMetric.agent_efficiency,
            operator=AlertOperator.lte,
            value=0.5,
            created_by_id=test_user.id,
        ),
    ])
    await db_session.flush()

    service = AlertThresholdService(db_session)
    triggered = await service.evaluate_for_board(
        test_board.id,
        {"health_score": 40.0, "stale_card_count": 10, "agent_efficiency": 0.8},
    )
    # health_score 40 < 60 triggers, stale 10 > 3 triggers, efficiency 0.8 > 0.5 does NOT trigger
    assert len(triggered) == 2
    names = {t["name"] for t in triggered}
    assert names == {"Low health", "Stale cards"}
