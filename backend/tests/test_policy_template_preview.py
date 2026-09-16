# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from copy import deepcopy

import pytest
from sqlalchemy import select

from app.models.config_template import BoardLoopTemplateBinding
from app.models.workspace_config import WorkspaceConfig
from app.services.loop_templates import get_system_template
from tests.test_landing_completion_policy import policy

pytestmark = pytest.mark.anyio


def path(board):
    return f"/api/workspaces/default/boards/{board.id}"


def template_proposal(label="proposed"):
    template = get_system_template("coding-loop-easy")
    return {"source": "system", "ref": template.slug, "version": template.version,
            "slot_values": {"RUN_LABEL": label, "INTEGRATION_BRANCH": "integration"}}


async def binding(db, board):
    return await db.scalar(select(BoardLoopTemplateBinding).where(BoardLoopTemplateBinding.board_id == board.id))


@pytest.mark.parametrize("already_bound", [False, True])
async def test_policy_preview_rehearses_exact_atomic_bind_without_mutation(client, db_session, test_board, test_git_repo, already_bound):
    if already_bound:
        assert (await client.put(f"{path(test_board)}/loop", json={
            "enabled": False, "template": template_proposal("saved"), "budget_usd": 41,
        })).status_code == 200
    await db_session.refresh(test_board)
    before = deepcopy(test_board.loop_config)
    previous_binding = await binding(db_session, test_board)
    previous_slots = deepcopy(previous_binding.slot_values) if previous_binding else None
    selected = policy()
    rails = {"enabled": False, "provider": "operator-provider", "model": "source-v19", "budget_usd": 42}
    template = template_proposal()
    response = await client.post(f"{path(test_board)}/completion/policy/preview", json={
        "policy": selected, "loop_config": rails, "template": template,
    })
    assert response.status_code == 200, response.text
    preview = response.json()
    assert preview["incompatibilities"] == []
    assert preview["template_preview"]["findings"] == []
    assert preview["loop_config"]["loop_landing"] == "merge_queue"
    assert "submit_completion_candidate" in preview["template_preview"]["system_prompt"]
    assert "proposed" in preview["template_preview"]["loop_prompt"]
    await db_session.refresh(test_board)
    assert test_board.completion_policy is None
    assert test_board.loop_config == before
    current_binding = await binding(db_session, test_board)
    assert (current_binding.slot_values if current_binding else None) == previous_slots
    saved = await client.put(f"{path(test_board)}/loop", json={
        **rails, "completion_policy": selected, "template": template,
    })
    assert saved.status_code == 200, saved.text
    for key in ("system_prompt", "loop_prompt", "tools", "provider", "model", "loop_landing", "budget_usd", "completion_query"):
        assert saved.json()[key] == preview["loop_config"][key], key


async def test_policy_template_preview_refuses_unavailable_version_without_binding(client, db_session, test_board, test_git_repo):
    proposal = template_proposal()
    proposal["version"] -= 1
    response = await client.post(f"{path(test_board)}/completion/policy/preview", json={
        "policy": policy(), "template": proposal,
    })
    assert response.status_code == 409, response.text
    assert await binding(db_session, test_board) is None
    await db_session.refresh(test_board)
    assert test_board.completion_policy is None


async def test_policy_template_preview_rejects_mixed_raw_and_template_prompts(client, db_session, test_board, test_git_repo):
    response = await client.post(f"{path(test_board)}/completion/policy/preview", json={
        "policy": policy(), "template": template_proposal(), "loop_config": {"system_prompt": "conflicting raw"},
    })
    assert response.status_code == 422, response.text
    assert "template_and_raw_prompts" in response.text
    assert await binding(db_session, test_board) is None


@pytest.mark.parametrize("view", ["fit", "preview"])
async def test_board_template_rehearsal_uses_proposed_policy_without_saving(client, db_session, test_board, test_git_repo, view):
    proposal = template_proposal()
    response = await client.post(f"{path(test_board)}/loop-templates/{proposal['ref']}/{view}", json={
        "slot_values": proposal["slot_values"], "version": proposal["version"], "draft": False,
        "completion_policy": policy(),
    })
    assert response.status_code == 200, response.text
    data = response.json()
    if view == "preview":
        assert data["rails"]["loop_landing"] == "merge_queue"
        assert "submit_completion_candidate" in data["system_prompt"]
    else:
        assert not any(item["id"] == "completion_policy" and item["status"] == "warn" for item in data["checks"])
    await db_session.refresh(test_board)
    assert test_board.completion_policy is None
    assert await binding(db_session, test_board) is None


async def test_proposed_null_policy_inherits_workspace_when_rendering_template(client, db_session, test_board, test_workspace, test_git_repo):
    human = policy(landing_actor="human", landing_methods=["external"], auto_complete=False)
    config = await db_session.scalar(select(WorkspaceConfig).where(WorkspaceConfig.workspace_id == test_workspace.id))
    if config is None:
        config = WorkspaceConfig(workspace_id=test_workspace.id)
        db_session.add(config)
    config.completion_policy = human
    test_board.completion_policy = policy()
    await db_session.flush()
    proposal = template_proposal()
    response = await client.post(f"{path(test_board)}/loop-templates/{proposal['ref']}/preview", json={
        "slot_values": proposal["slot_values"], "version": proposal["version"], "draft": False,
        "completion_policy": None,
    })
    assert response.status_code == 200, response.text
    assert response.json()["rails"]["loop_landing"] == "human"
    await db_session.refresh(test_board)
    assert test_board.completion_policy == policy()
