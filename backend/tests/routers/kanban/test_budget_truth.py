# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from datetime import datetime

from tests.routers.kanban.test_board_loop_history import (
    _history_url,
    _iteration,
    loop_agent,
)

__all__ = ["loop_agent"]


async def test_budget_history_reports_lifetime_source_and_completion_without_resetting_epoch(
    client, db_session, test_workspace, test_board, loop_agent,
):
    test_board.loop_config = {"budget_epoch": "2026-09-15T00:00:00"}
    for day, action, cost in [
        (14, "loop_iteration", 40),
        (14, "completion_review", 5),
        (15, "loop_iteration", 2),
        (15, "completion_review", 1),
        (15, "completion_evidence_review", 0.5),
        (15, "completion_validation", 0.25),
        (15, "implement", 90),
    ]:
        await _iteration(
            db_session, agent=loop_agent, workspace=test_workspace, board=test_board,
            started_at=datetime(2026, 9, day, 12), cost_usd=cost, action=action,
        )
    response = await client.get(_history_url(test_board))
    assert response.status_code == 200
    data = response.json()
    assert data["lifetime_spent_usd"] == 48.75
    assert data["spent_usd"] == 3.75
    assert data["iteration_count"] == 2
    assert data["budget_epoch"] == "2026-09-15T00:00:00"
