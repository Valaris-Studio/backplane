# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from copy import deepcopy
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select

from app.core.auth import current_agent_id
from app.exceptions import ForbiddenError, ResourceNotFoundError
from app.models.agents.execution import AgentExecution
from app.models.kanban.completion import CompletionAttempt, CompletionCandidate
from app.models.workspace_config import WorkspaceConfig
from app.services.completion import CompletionService
from tests.test_agent_workspace_scope import _make_agent_with_key, raw_key_client
from tests.test_completion_execution_boundaries import _configure_role
from tests.test_postmerge_acceptance import (
    MERGED,
    completion_fixture,
    policy,
    status,
    submit,
)

__all__ = ["completion_fixture", "raw_key_client"]
pytestmark = pytest.mark.slow


async def test_legacy_requirements_are_empty(client, test_board):
    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/completion/requirements"
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"policy_hash": None, "requirements": []}


async def test_requirements_resolve_arbitrary_roles_and_direct_validation(
    client, completion_fixture
):
    f = completion_fixture
    await _configure_role(f, lifecycle=True)
    config = await f.db.scalar(
        select(WorkspaceConfig).where(
            WorkspaceConfig.workspace_id == f.board.workspace_id
        )
    )
    pipeline = deepcopy(config.pipeline_config)
    pipeline["stages"][1] = {
        "role": "custom-validation",
        "enabled": True,
    }  # no model needed
    config.pipeline_config = pipeline
    await f.db.flush()
    response = await client.get(f"{f.url}/requirements")
    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body["policy_hash"]) == 64
    assert body["requirements"] == [
        {
            "kind": "review",
            "role": "custom-arbiter",
            "provider": "claude-cli",
            "model": "operator-review-model",
            "checks": [],
            "tool_policy": {"deny": ["Bash(wget:*)"]},
        },
        {
            "kind": "validation",
            "role": "custom-validation",
            "provider": "",
            "model": "",
            "checks": policy()["postmerge_validation"]["checks"],
            "tool_policy": {"deny": []},
        },
        {
            "kind": "evidence_review",
            "role": "custom-arbiter",
            "provider": "claude-cli",
            "model": "operator-review-model",
            "checks": [],
            "tool_policy": {"deny": ["Bash(wget:*)"]},
        },
    ]


async def test_requirements_fail_before_work_for_missing_review_prompt(
    client, completion_fixture
):
    f = completion_fixture
    config = await f.db.scalar(
        select(WorkspaceConfig).where(
            WorkspaceConfig.workspace_id == f.board.workspace_id
        )
    )
    pipeline = deepcopy(config.pipeline_config)
    pipeline["stages"][0]["llm"]["prompt_slug"] = "missing-operator-prompt"
    config.pipeline_config = pipeline
    await f.db.flush()
    response = await client.get(f"{f.url}/requirements")
    assert response.status_code == 409, response.text
    assert "completion_role_prompt_required" in response.text
    assert "missing-operator-prompt" in response.text


async def test_requirements_include_pending_stored_policy_without_mutation(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        await submit(agent_client, f)
    candidate = await f.db.scalar(
        select(CompletionCandidate).where(CompletionCandidate.card_id == f.card.id)
    )
    before = (candidate.status, candidate.is_current, candidate.updated_at)
    response = await client.get(f"{f.url}/requirements")
    assert response.status_code == 200, response.text
    assert {entry["kind"] for entry in response.json()["requirements"]} == {
        "review",
        "validation",
        "evidence_review",
    }
    await f.db.refresh(candidate)
    assert (candidate.status, candidate.is_current, candidate.updated_at) == before
    assert (await f.db.scalars(select(CompletionAttempt))).all() == []
    assert len((await f.db.scalars(select(AgentExecution))).all()) == 1


async def test_requirements_service_enforces_workspace_and_bound_runner(
    completion_fixture, test_agent
):
    import uuid

    f = completion_fixture
    service = CompletionService(f.db)
    with pytest.raises(ForbiddenError):
        await service.requirements(f.board.id, f.board.workspace_id, uuid.uuid4())
    with pytest.raises(ResourceNotFoundError):
        await service.requirements(
            uuid.uuid4(), f.board.workspace_id, f.card.created_by
        )
    test_agent.allowed_workspaces = ["different-workspace"]
    await f.db.flush()
    token = current_agent_id.set(test_agent.id)
    try:
        with pytest.raises(ForbiddenError):
            await service.requirements(
                f.board.id, f.board.workspace_id, f.card.created_by
            )
    finally:
        current_agent_id.reset(token)


async def test_direct_validation_claim_requires_no_model_provider(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    config = await f.db.scalar(
        select(WorkspaceConfig).where(
            WorkspaceConfig.workspace_id == f.board.workspace_id
        )
    )
    config.pipeline_config = {
        "stages": [{"role": "custom-validation", "enabled": True}]
    }
    await f.db.flush()
    saved = await client.put(
        f"{f.url}/policy",
        json={
            "policy": policy(
                source_review="none", review_role=None, evidence_only={"enabled": False}
            )
        },
    )
    assert saved.status_code == 200, saved.text
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        await submit(agent_client, f)
    candidate = await f.db.scalar(
        select(CompletionCandidate).where(CompletionCandidate.card_id == f.card.id)
    )
    candidate.status = "awaiting_validation"
    candidate.merge_sha = MERGED
    await f.db.flush()
    missing_checks = await agent_client.post(
        f"{f.url}/work/claim",
        json={
            "capabilities": {
                "providers": [],
                "exact_checkout": True,
                "argv_checks": False,
            }
        },
    )
    assert missing_checks.status_code == 409, missing_checks.text
    assert "direct argv check execution" in missing_checks.text
    assert "provider '" not in missing_checks.text
    assert (await f.db.scalars(select(CompletionAttempt))).all() == []
    response = await agent_client.post(
        f"{f.url}/work/claim",
        json={
            "capabilities": {
                "providers": [],
                "exact_checkout": True,
                "argv_checks": True,
            }
        },
    )
    assert response.status_code == 200, response.text
    work = response.json()["work"]
    assert work["kind"] == "validation"
    assert work["role"] == "custom-validation"
    assert work["provider"] == work["model"] == ""
    assert work["source_sha"] == MERGED
    assert "MANDATORY LANDING AND COMPLETION CONTRACT" in work["context"]
    assert work["checks"] == policy()["postmerge_validation"]["checks"]
    assert work["execution_id"] != str(f.execution.id)
    from tests.test_postmerge_acceptance import result

    evidence = result(work)
    evidence["checks"][0]["source_sha"] = "c" * 40
    rejected = await agent_client.post(
        f"{f.url}/work/{work['attempt_id']}/result", json=evidence
    )
    assert rejected.status_code == 409, rejected.text
    assert "completion_check_mismatch" in rejected.text
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status(merged=True)),
    ):
        accepted = await agent_client.post(
            f"{f.url}/work/{work['attempt_id']}/result", json=result(work)
        )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["candidate"]["status"] == "accepted"


@pytest.mark.parametrize(
    "capabilities,missing",
    [
        (
            {"providers": ["claude-cli"], "exact_checkout": True, "argv_checks": True},
            "codex-cli",
        ),
        (
            {"providers": ["codex-cli"], "exact_checkout": False, "argv_checks": True},
            "exact revision checkout",
        ),
    ],
)
async def test_incompatible_claim_names_only_missing_capability(
    agent_client, completion_fixture, capabilities, missing
):
    f = completion_fixture
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        await submit(agent_client, f)
    response = await agent_client.post(
        f"{f.url}/work/claim", json={"capabilities": capabilities}
    )
    assert response.status_code == 409, response.text
    assert missing in response.text
    assert "required check execution" not in response.text
    assert (await f.db.scalars(select(CompletionAttempt))).all() == []


@pytest.mark.parametrize(
    "state,expected",
    [("active", 200), ("paused", 200), ("deactivated", 403), ("other_workspace", 403)],
)
async def test_requirements_authenticates_real_bound_key(
    raw_key_client, db_session, test_user, test_board, state, expected
):
    from app.models.agents.agent import Agent

    raw = await _make_agent_with_key(
        db_session,
        test_user,
        allowed_workspaces=["different"] if state == "other_workspace" else ["default"],
    )
    agent = await db_session.scalar(select(Agent).where(Agent.name == "scoped-agent"))
    agent.is_active = state != "deactivated"
    agent.is_paused = state == "paused"
    await db_session.flush()
    response = await raw_key_client.get(
        f"/api/workspaces/default/boards/{test_board.id}/completion/requirements",
        headers={"Authorization": f"Bearer {raw}"},
    )
    assert response.status_code == expected, response.text


async def test_requirements_cannot_read_board_through_other_workspace(
    client, db_session, test_user, test_board
):
    from tests.test_agent_workspace_scope import _make_workspace

    await _make_workspace(db_session, test_user, name="Other", slug="other")
    response = await client.get(
        f"/api/workspaces/other/boards/{test_board.id}/completion/requirements"
    )
    assert response.status_code == 404, response.text


async def test_validation_preflight_requires_enabled_role_without_model(
    client, completion_fixture
):
    f = completion_fixture
    config = await f.db.scalar(
        select(WorkspaceConfig).where(
            WorkspaceConfig.workspace_id == f.board.workspace_id
        )
    )
    pipeline = deepcopy(config.pipeline_config)
    pipeline["stages"][1] = {"role": "custom-validation", "enabled": False}
    config.pipeline_config = pipeline
    await f.db.flush()
    response = await client.get(f"{f.url}/requirements")
    assert response.status_code == 409, response.text
    assert "custom-validation" in response.text
    assert "no model provider is required" in response.text


async def test_requirements_ignore_terminal_candidate_policy(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        await submit(agent_client, f)
    candidate = await f.db.scalar(
        select(CompletionCandidate).where(CompletionCandidate.card_id == f.card.id)
    )
    candidate.status = "accepted"
    candidate.policy = policy(review_role="obsolete-unconfigured-role")
    await f.db.flush()
    response = await client.get(f"{f.url}/requirements")
    assert response.status_code == 200, response.text
    assert "obsolete-unconfigured-role" not in response.text


async def test_requirements_ignore_stale_pending_policy_without_mutating_candidate(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        await submit(agent_client, f)
    candidate = await f.db.scalar(
        select(CompletionCandidate).where(CompletionCandidate.card_id == f.card.id)
    )
    f.board.completion_policy = policy(
        source_review="none",
        review_role=None,
        postmerge_validation=None,
        evidence_only={"enabled": False},
    )
    config = await f.db.scalar(
        select(WorkspaceConfig).where(
            WorkspaceConfig.workspace_id == f.board.workspace_id
        )
    )
    config.pipeline_config = {"stages": []}
    await f.db.flush()
    before = (candidate.status, candidate.is_current, candidate.updated_at)
    response = await client.get(f"{f.url}/requirements")
    assert response.status_code == 200, response.text
    assert response.json()["requirements"] == []
    await f.db.refresh(candidate)
    assert (candidate.status, candidate.is_current, candidate.updated_at) == before
    assert (await f.db.scalars(select(CompletionAttempt))).all() == []


@pytest.mark.parametrize(
    "content",
    [
        "Assess {{.NonexistentIdentity}}",
        "{{if .CardID}}Unclosed",
        "{{else}}",
        '{{index .ContextSources "missing-source"}}',
    ],
)
async def test_requirements_reject_invalid_prompt_before_source(
    client, completion_fixture, content
):
    from app.models.agents.prompt_config import AgentPromptConfig

    f = completion_fixture
    await _configure_role(f)
    prompt = await f.db.scalar(
        select(AgentPromptConfig).where(AgentPromptConfig.slug == "operator-assessment")
    )
    prompt.content = content
    await f.db.flush()
    response = await client.get(f"{f.url}/requirements")
    assert response.status_code == 409, response.text
    assert "completion_prompt_render_invalid" in response.text


async def test_requirements_validate_prompt_schema_without_rendering_context(
    client, completion_fixture
):
    from app.models.agents.prompt_config import AgentPromptConfig

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
    prompt.content = '{{if .ProjectDirectives}} {{.SourceSHA}} {{else}} {{index .ContextSources "ReviewInstructions"}} {{end}}'
    await f.db.flush()
    with patch(
        "app.services.completion_context.mandatory_completion_context",
        new=AsyncMock(
            side_effect=AssertionError("Preflight must not render card-bound context")
        ),
    ):
        response = await client.get(f"{f.url}/requirements")
    assert response.status_code == 200, response.text


@pytest.mark.parametrize(
    "directives,expected", [("required", "Use note"), ("", "Fallback source")]
)
def test_shared_prompt_walk_preserves_conditional_rendering(directives, expected):
    from app.services.completion_context import (
        render_completion_prompt,
        validate_completion_prompt,
    )

    content = '{{if .ProjectDirectives}}Use {{index .ContextSources "Notes"}}{{else}}Fallback {{.SourceSHA}}{{end}}'
    validate_completion_prompt(content, [{"kind": "card_notes", "as": "Notes"}])
    assert (
        render_completion_prompt(
            content,
            {
                "ProjectDirectives": directives,
                "SourceSHA": "source",
                "ContextSources": {"Notes": "note"},
            },
        )
        == expected
    )
