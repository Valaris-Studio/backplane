# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from copy import deepcopy
from unittest.mock import AsyncMock, patch
from sqlalchemy import select
from app.models.workspace_config import WorkspaceConfig
from app.services.merge_queue import MergeQueueService
from tests.test_postmerge_acceptance import completion_fixture, policy, status, submit

__all__ = ["completion_fixture"]


async def test_frozen_board_does_not_execute_queued_completion(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    saved = await client.put(
        f"{f.url}/policy",
        json={
            "policy": policy(
                source_review="none", review_role=None, postmerge_validation=None
            )
        },
    )
    assert saved.status_code == 200
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        await submit(agent_client, f)
        landed = await agent_client.post(
            f"{f.url}/cards/{f.card.id}/land", json={"method": "merge_queue"}
        )
        assert landed.status_code == 200, landed.text
        frozen = await client.post(
            f"/api/workspaces/default/boards/{f.board.id}/freeze"
        )
        assert frozen.status_code == 200
        executor = AsyncMock(return_value=("failed", "fixture without external merge"))
        await MergeQueueService(f.db).tick(executor=executor)
    executor.assert_not_awaited()


async def test_explicit_review_provider_does_not_change_to_tier_default(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    config = await f.db.scalar(
        select(WorkspaceConfig).where(
            WorkspaceConfig.workspace_id == f.board.workspace_id
        )
    )
    pipeline = deepcopy(config.pipeline_config)
    pipeline["stages"][0]["llm"]["model"] = "premium"
    config.pipeline_config = pipeline
    await f.db.flush()
    response = await client.put(f"{f.url}/policy", json={"policy": policy()})
    if response.status_code in (409, 422):
        return
    assert response.status_code == 200, response.text
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        await submit(agent_client, f)
        claimed = await agent_client.post(
            f"{f.url}/work/claim",
            json={
                "capabilities": {
                    "providers": ["codex-cli", "claude-cli"],
                    "exact_checkout": True,
                    "argv_checks": True,
                }
            },
        )
    assert claimed.status_code == 409, claimed.status_code


async def _configure_role(f, *, lifecycle=False):
    from app.models.agents.prompt_config import AgentPromptConfig

    config = await f.db.scalar(
        select(WorkspaceConfig).where(
            WorkspaceConfig.workspace_id == f.board.workspace_id
        )
    )
    pipeline = deepcopy(config.pipeline_config)
    pipeline["stages"][0]["llm"].update(
        {"stage": "completion-assessment", "tool_policy": {"deny": ["Bash(curl:*)"]}}
    )
    if lifecycle:
        pipeline["stages"][0]["lifecycle"] = [
            {
                "name": "assess",
                "kind": "llm",
                "params": {
                    "provider": "claude-cli",
                    "model": "operator-review-model",
                    "stage": "completion-assessment",
                    "tool_policy": {"deny": ["Bash(wget:*)"]},
                },
            }
        ]
    config.pipeline_config = pipeline
    f.db.add(
        AgentPromptConfig(
            name="Operator assessment",
            slug="operator-assessment",
            team_role="custom-arbiter",
            stage="completion-assessment",
            content="MANDATORY_OPERATOR_CHECK_792: inspect schema migration reversibility.",
            workspace_id=f.board.workspace_id,
            created_by_id=f.card.created_by,
        )
    )
    await f.db.flush()


async def _claim(agent_client, f):
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        await submit(agent_client, f)
        claimed = await agent_client.post(
            f"{f.url}/work/claim",
            json={
                "capabilities": {
                    "providers": ["codex-cli", "claude-cli"],
                    "exact_checkout": True,
                    "argv_checks": True,
                }
            },
        )
    assert claimed.status_code == 200, claimed.text
    return claimed.json()["work"]


async def test_completion_claim_injects_configured_role_prompt(
    agent_client, completion_fixture
):
    f = completion_fixture
    await _configure_role(f)
    work = await _claim(agent_client, f)
    assert "MANDATORY_OPERATOR_CHECK_792" in work["context"]


async def test_completion_claim_preserves_configured_tool_policy(
    agent_client, completion_fixture
):
    f = completion_fixture
    await _configure_role(f)
    work = await _claim(agent_client, f)
    assert "Bash(curl:*)" in work.get("tool_policy", {}).get("deny", [])


async def test_completion_role_uses_lifecycle_provider_model_precedence(
    agent_client, completion_fixture
):
    f = completion_fixture
    await _configure_role(f, lifecycle=True)
    work = await _claim(agent_client, f)
    assert (work["provider"], work["model"]) == ("claude-cli", "operator-review-model")
    assert "Bash(wget:*)" in work.get("tool_policy", {}).get("deny", [])


async def test_completion_role_prompt_renders_claim_identity_and_context(
    agent_client, completion_fixture
):
    from app.models.agents.prompt_config import AgentPromptConfig

    f = completion_fixture
    await _configure_role(f)
    prompt = await f.db.scalar(
        select(AgentPromptConfig).where(AgentPromptConfig.slug == "operator-assessment")
    )
    prompt.content = "Assess {{.CardID}} on {{.BoardID}} for {{.Workspace}} execution {{.ExecutionID}}.{{if .ProjectDirectives}} MANDATORY {{.ProjectDirectives}}{{end}}"
    await f.db.flush()
    work = await _claim(agent_client, f)
    assert (
        f"Assess {f.card.id} on {f.board.id} for default execution {work['execution_id']}."
        in work["context"]
    )
    assert "{{" not in work["context"]


async def test_completion_claim_requires_named_configured_prompt(
    agent_client, completion_fixture
):
    from app.models.agents.prompt_config import AgentPromptConfig

    f = completion_fixture
    await _configure_role(f)
    prompt = await f.db.scalar(
        select(AgentPromptConfig).where(AgentPromptConfig.slug == "operator-assessment")
    )
    await f.db.delete(prompt)
    await f.db.flush()
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        await submit(agent_client, f)
        response = await agent_client.post(
            f"{f.url}/work/claim",
            json={
                "capabilities": {
                    "providers": ["codex-cli"],
                    "exact_checkout": True,
                    "argv_checks": True,
                }
            },
        )
    assert response.status_code == 409, response.text
    assert "prompt" in response.text.lower()


async def test_changed_role_prompt_rejects_active_completion_result(
    agent_client, completion_fixture
):
    from app.models.agents.prompt_config import AgentPromptConfig
    from tests.test_postmerge_acceptance import acknowledge

    f = completion_fixture
    await _configure_role(f)
    work = await _claim(agent_client, f)
    prompt = await f.db.scalar(
        select(AgentPromptConfig).where(AgentPromptConfig.slug == "operator-assessment")
    )
    prompt.content += " NEW MANDATORY CHECK"
    prompt.version += 1
    await f.db.flush()
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        response = await acknowledge(agent_client, f, work)
    assert response.status_code == 200, response.text
    assert response.json()["result_receipt"]["status"] == "rejected"
    assert response.json()["result_receipt"]["code"] == "completion_context_changed"


async def test_changed_deny_policy_rejects_active_completion_result(
    agent_client, completion_fixture
):
    from tests.test_postmerge_acceptance import acknowledge

    f = completion_fixture
    await _configure_role(f)
    work = await _claim(agent_client, f)
    config = await f.db.scalar(
        select(WorkspaceConfig).where(
            WorkspaceConfig.workspace_id == f.board.workspace_id
        )
    )
    pipeline = deepcopy(config.pipeline_config)
    pipeline["stages"][0]["llm"]["tool_policy"]["deny"].append("Bash(wget:*)")
    config.pipeline_config = pipeline
    await f.db.flush()
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        response = await acknowledge(agent_client, f, work)
    assert response.status_code == 200, response.text
    assert response.json()["result_receipt"]["status"] == "rejected"


async def test_completed_identical_ack_remains_idempotent_after_prompt_change(
    agent_client, completion_fixture
):
    from app.models.agents.prompt_config import AgentPromptConfig
    from tests.test_postmerge_acceptance import acknowledge

    f = completion_fixture
    await _configure_role(f)
    work = await _claim(agent_client, f)
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        response = await acknowledge(agent_client, f, work)
        assert response.status_code == 200, response.text
        prompt = await f.db.scalar(
            select(AgentPromptConfig).where(
                AgentPromptConfig.slug == "operator-assessment"
            )
        )
        prompt.content += " NEXT ATTEMPT CHECK"
        prompt.version += 1
        await f.db.flush()
        repeated = await acknowledge(agent_client, f, work)
    assert repeated.status_code == 200, repeated.text


async def test_role_prompt_context_source_is_fetched_and_bound(
    agent_client, completion_fixture
):
    from app.models.agents.prompt_config import AgentPromptConfig
    from app.models.notes.note import Note
    from tests.test_postmerge_acceptance import acknowledge

    f = completion_fixture
    await _configure_role(f)
    config = await f.db.scalar(
        select(WorkspaceConfig).where(
            WorkspaceConfig.workspace_id == f.board.workspace_id
        )
    )
    pipeline = deepcopy(config.pipeline_config)
    pipeline["stages"][0]["context_sources"] = [
        {"kind": "card_notes", "as": "ReviewInstructions"}
    ]
    config.pipeline_config = pipeline
    prompt = await f.db.scalar(
        select(AgentPromptConfig).where(AgentPromptConfig.slug == "operator-assessment")
    )
    prompt.content = (
        'Assess this evidence: {{ index .ContextSources "ReviewInstructions" }}'
    )
    note = Note(
        workspace_id=f.board.workspace_id,
        board_id=f.board.id,
        card_id=f.card.id,
        title="Operator instruction",
        content="EXACT_CONTEXT_SOURCE_129",
        created_by=f.card.created_by,
    )
    f.db.add(note)
    await f.db.flush()
    work = await _claim(agent_client, f)
    assert "EXACT_CONTEXT_SOURCE_129" in work["context"]
    note.content = "CHANGED_MANDATORY_SOURCE_130"
    await f.db.flush()
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        response = await acknowledge(agent_client, f, work)
    assert response.status_code == 200, response.text
    assert response.json()["result_receipt"]["status"] == "rejected"


async def test_lifecycle_only_overrides_authored_role_fields(
    agent_client, completion_fixture
):
    f = completion_fixture
    await _configure_role(f)
    config = await f.db.scalar(
        select(WorkspaceConfig).where(
            WorkspaceConfig.workspace_id == f.board.workspace_id
        )
    )
    pipeline = deepcopy(config.pipeline_config)
    pipeline["stages"][0]["lifecycle"] = [
        {"kind": "llm", "params": {"model": "operator-specific-model"}}
    ]
    config.pipeline_config = pipeline
    await f.db.flush()
    work = await _claim(agent_client, f)
    assert (work["provider"], work["model"]) == ("codex-cli", "operator-specific-model")
    assert work["tool_policy"] == {"deny": ["Bash(curl:*)"]}
    assert "MANDATORY_OPERATOR_CHECK_792" in work["context"]
