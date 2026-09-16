# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from app.models.notes.note import Note
from tests.test_landing_completion_policy import board_url, save_policy


async def test_explicit_policy_requires_upgraded_runner_and_injects_project_context(
    client, agent_client, db_session, test_board, test_git_repo, test_workspace, test_user,
):
    await save_policy(client, test_board)
    configured = await client.put(f"{board_url(test_board)}/loop", json={"enabled": False, "system_prompt": "No context slots", "loop_prompt": "Work"})
    assert configured.status_code == 200, configured.text
    db_session.add(Note(workspace_id=test_workspace.id, board_id=test_board.id, title="Mandatory acceptance methodology", content="Run exact-revision checks", pinned=True, created_by=test_user.id))
    await db_session.flush()
    old = await agent_client.get(f"{board_url(test_board)}/loop")
    assert old.status_code == 409, old.text
    assert old.json()["error_code"] == "completion_runner_upgrade_required"
    current = await agent_client.get(f"{board_url(test_board)}/loop", headers={"X-Backplane-Completion-Version": "1"})
    assert current.status_code == 200, current.text
    body = current.json()
    assert body["completion_policy"]["version"] == 1
    assert len(body["completion_policy_hash"]) == 64
    assert "Run exact-revision checks" in body["completion_context"]
    assert "submit_completion" in body["completion_context"]
    assert "request_landing" in body["completion_context"]
    assert "No context slots" == body["system_prompt"]


async def test_legacy_runner_read_does_not_require_new_handshake(client, agent_client, test_board):
    saved = await client.put(f"{board_url(test_board)}/loop", json={"enabled": False})
    assert saved.status_code == 200, saved.text
    response = await agent_client.get(f"{board_url(test_board)}/loop")
    assert response.status_code == 200, response.text
    assert response.json().get("completion_policy") is None


async def test_loop_history_includes_completion_cost_without_counting_review_as_iteration(
    client, db_session, test_board, test_agent, test_workspace,
):
    from app.models.agents.execution import AgentExecution, ExecutionStatus
    saved = await client.put(f"{board_url(test_board)}/loop", json={"enabled": False})
    assert saved.status_code == 200
    for action, cost in [("loop_iteration", 0.2), ("completion_review", 0.3), ("completion_validation", 0.4)]:
        db_session.add(AgentExecution(agent_id=test_agent.id, workspace_id=test_workspace.id,
                                     board_id=test_board.id, action=action, role="custom", status=ExecutionStatus.completed, cost_usd=cost))
    await db_session.flush()
    response = await client.get(f"{board_url(test_board)}/loop/history")
    assert response.status_code == 200, response.text
    assert response.json()["iteration_count"] == 1
    assert abs(response.json()["spent_usd"] - 0.9) < 0.0001
