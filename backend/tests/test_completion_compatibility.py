# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import pytest
from sqlalchemy import select

from app.models.workspace_config import WorkspaceConfig
from tests.test_landing_completion_policy import completion_url, policy, save_policy, board_url


@pytest.mark.parametrize("stage", [
    {"role": "bespoke", "enabled": False, "llm": {"provider": "codex-cli", "model": "concrete"}},
    {"role": "bespoke", "llm": {"enabled": False, "provider": "codex-cli", "model": "concrete"}},
    {"role": "bespoke", "llm": {"model": "concrete"}},
    {"role": "bespoke", "llm": {"provider": "codex-cli"}},
])
async def test_policy_preview_requires_enabled_configured_role(client, db_session, test_workspace, test_board, test_git_repo, stage):
    config = await db_session.scalar(select(WorkspaceConfig).where(WorkspaceConfig.workspace_id == test_workspace.id))
    if config is None:
        config = WorkspaceConfig(workspace_id=test_workspace.id)
        db_session.add(config)
    config.pipeline_config = {"stages": [stage]}
    await db_session.flush()
    response = await client.post(f"{completion_url(test_board)}/policy/preview", json={"policy": policy(source_review="independent", review_role="bespoke")})
    assert response.status_code == 200, response.text
    assert any(f["code"] == "completion_role_unconfigured" for f in response.json()["incompatibilities"])


async def test_explicit_provider_alias_model_is_editable_while_disabled_but_cannot_enable(client, test_board, test_git_repo):
    await save_policy(client, test_board)
    url = f"{board_url(test_board)}/loop"
    saved = await client.put(url, json={"enabled": False, "loop_prompt": "Work", "provider": "codex-cli", "model": "mid"})
    assert saved.status_code == 200, saved.text
    assert (await client.get(url)).status_code == 200
    preview = await client.get(f"{completion_url(test_board)}/policy")
    assert any(f["code"] == "completion_source_model_required" for f in preview.json()["incompatibilities"])
    response = await client.patch(f"{url}/state", json={"enabled": True, "reason": "operator enabled"})
    assert response.status_code == 409, response.text
    updated = await client.put(url, json={"enabled": True, "model": "configured-concrete-model"})
    assert updated.status_code == 200, updated.text


async def test_policy_preview_and_loop_save_use_proposed_model_atomically(client, db_session, test_board, test_git_repo):
    from app.models.kanban.board import Board
    url = f"{board_url(test_board)}/loop"
    assert (await client.put(url, json={"enabled": False, "loop_prompt": "Work", "provider": "codex-cli", "model": "mid"})).status_code == 200
    draft = {"enabled": True, "provider": "codex-cli", "model": "concrete-source"}
    preview = await client.post(f"{completion_url(test_board)}/policy/preview", json={"policy": policy(), "loop_config": draft})
    assert preview.status_code == 200, preview.text
    assert preview.json()["incompatibilities"] == []
    await db_session.refresh(test_board)
    assert test_board.completion_policy is None
    assert test_board.loop_config["model"] == "mid"
    saved = await client.put(url, json={**draft, "completion_policy": policy()})
    assert saved.status_code == 200, saved.text
    persisted = await db_session.get(Board, test_board.id)
    await db_session.refresh(persisted)
    assert persisted.completion_policy == policy()
    assert persisted.loop_config["model"] == "concrete-source"
    assert persisted.loop_config["enabled"] is True


async def test_invalid_atomic_loop_policy_write_changes_neither_half(client, db_session, test_board, test_git_repo):
    from app.database import get_db

    async def transactional_db():
        # Match the production request's rollback-on-error boundary while
        # preserving the shared fixture transaction for inspection afterward.
        async with db_session.begin_nested():
            yield db_session

    client._transport.app.dependency_overrides[get_db] = transactional_db
    url = f"{board_url(test_board)}/loop"
    await client.put(url, json={"enabled": False, "loop_prompt": "Work"})
    response = await client.put(url, json={"enabled": True, "completion_policy": policy(source_review="independent", review_role="missing-role")})
    assert response.status_code in (409, 422), response.text
    await db_session.refresh(test_board)
    assert test_board.completion_policy is None
    assert test_board.loop_config["enabled"] is False
