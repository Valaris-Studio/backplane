# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.prompt_config import AgentPromptConfig
from app.models.agents.team import AgentTeam
from app.models.user import User
from app.models.workspace import Workspace


async def _create_config(
    db_session: AsyncSession, user: User, workspace_id=None, **overrides
) -> AgentPromptConfig:
    defaults = {
        "name": "Default Prompt",
        "slug": "default-prompt",
        "stage": "planning",
        "content": "You are a helpful agent.",
        "created_by_id": user.id,
        "workspace_id": workspace_id,
    }
    defaults.update(overrides)
    config = AgentPromptConfig(**defaults)
    db_session.add(config)
    await db_session.flush()
    return config


def _configs_url(slug: str) -> str:
    return f"/api/workspaces/{slug}/prompt-configs"


# --- Existing read tests ---


async def test_list_prompt_configs_empty(
    client: AsyncClient, test_workspace: Workspace,
):
    response = await client.get(_configs_url(test_workspace.slug))
    assert response.status_code == 200
    assert response.json() == []


async def test_list_prompt_configs_returns_workspace_and_system(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    # System-level config (no workspace)
    await _create_config(db_session, test_user, slug="system-prompt", name="System")
    # Workspace-scoped config
    await _create_config(
        db_session, test_user, workspace_id=test_workspace.id,
        slug="ws-prompt", name="Workspace Prompt",
    )

    response = await client.get(_configs_url(test_workspace.slug))
    assert response.status_code == 200
    slugs = [c["slug"] for c in response.json()]
    assert "system-prompt" in slugs
    assert "ws-prompt" in slugs


async def test_get_prompt_config_success(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    config = await _create_config(
        db_session, test_user, workspace_id=test_workspace.id,
        slug="get-test", name="Get Test",
    )
    response = await client.get(f"{_configs_url(test_workspace.slug)}/{config.id}")
    assert response.status_code == 200
    data = response.json()
    assert data["slug"] == "get-test"
    assert data["content"] == "You are a helpful agent."
    assert data["version"] == 1


async def test_get_prompt_config_not_found(
    client: AsyncClient, test_workspace: Workspace,
):
    fake_id = uuid.uuid4()
    response = await client.get(f"{_configs_url(test_workspace.slug)}/{fake_id}")
    assert response.status_code == 404


# --- New CRUD tests ---


async def test_create_prompt_config(
    client: AsyncClient,
    test_workspace: Workspace,
    test_user: User,
):
    payload = {
        "name": "Discover Prompt",
        "slug": "discover",
        "stage": "discover",
        "content": "Find work for {{.Workspace}}",
        "team_role": "orchestrator",
        "agent_type": "coding",
    }
    response = await client.post(_configs_url(test_workspace.slug), json=payload)
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "Discover Prompt"
    assert data["slug"] == "discover"
    assert data["stage"] == "discover"
    assert data["content"] == "Find work for {{.Workspace}}"
    assert data["team_role"] == "orchestrator"
    assert data["agent_type"] == "coding"
    assert data["workspace_id"] == str(test_workspace.id)
    assert data["created_by_id"] == str(test_user.id)
    assert data["version"] == 1
    assert data["team_id"] is None


async def test_create_prompt_config_with_team_id(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    team = AgentTeam(
        name="Backend Crew",
        workspace_id=test_workspace.id,
        created_by_id=test_user.id,
    )
    db_session.add(team)
    await db_session.flush()

    payload = {
        "name": "Team Discover",
        "slug": "team-discover",
        "stage": "discover",
        "content": "Team prompt content",
        "team_id": str(team.id),
    }
    response = await client.post(_configs_url(test_workspace.slug), json=payload)
    assert response.status_code == 201
    data = response.json()
    assert data["team_id"] == str(team.id)
    assert data["slug"] == "team-discover"


async def test_update_prompt_config(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    config = await _create_config(
        db_session, test_user, workspace_id=test_workspace.id,
        slug="update-test", name="Update Test",
    )
    url = f"{_configs_url(test_workspace.slug)}/{config.id}"

    response = await client.patch(url, json={"content": "Updated content"})
    assert response.status_code == 200
    data = response.json()
    assert data["content"] == "Updated content"
    assert data["version"] == 2  # bumped on content change
    assert data["name"] == "Update Test"  # unchanged


async def test_update_prompt_config_non_content_field(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    config = await _create_config(
        db_session, test_user, workspace_id=test_workspace.id,
        slug="meta-update-test", name="Meta Update",
    )
    url = f"{_configs_url(test_workspace.slug)}/{config.id}"

    response = await client.patch(url, json={"name": "Renamed"})
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "Renamed"
    assert data["version"] == 1  # NOT bumped for non-content changes


async def test_update_prompt_config_not_found(
    client: AsyncClient, test_workspace: Workspace,
):
    fake_id = uuid.uuid4()
    url = f"{_configs_url(test_workspace.slug)}/{fake_id}"
    response = await client.patch(url, json={"content": "nope"})
    assert response.status_code == 404


async def test_delete_prompt_config(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    config = await _create_config(
        db_session, test_user, workspace_id=test_workspace.id,
        slug="delete-test", name="Delete Test",
    )
    url = f"{_configs_url(test_workspace.slug)}/{config.id}"

    response = await client.delete(url)
    assert response.status_code == 204

    # Verify gone
    response = await client.get(url)
    assert response.status_code == 404


async def test_delete_prompt_config_not_found(
    client: AsyncClient, test_workspace: Workspace,
):
    fake_id = uuid.uuid4()
    url = f"{_configs_url(test_workspace.slug)}/{fake_id}"
    response = await client.delete(url)
    assert response.status_code == 404


async def test_list_prompt_configs_filter_by_team_role(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    await _create_config(
        db_session, test_user, workspace_id=test_workspace.id,
        slug="orch-discover", name="Orch Discover", team_role="orchestrator",
    )
    await _create_config(
        db_session, test_user, workspace_id=test_workspace.id,
        slug="rev-discover", name="Rev Discover", team_role="reviewer",
    )

    response = await client.get(
        _configs_url(test_workspace.slug), params={"team_role": "orchestrator"}
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["slug"] == "orch-discover"


# --- Prompt stage defaults tests ---


def _defaults_url(slug: str) -> str:
    return f"/api/workspaces/{slug}/prompt-configs/defaults"


async def test_get_prompt_defaults(
    client: AsyncClient, test_workspace: Workspace,
):
    response = await client.get(_defaults_url(test_workspace.slug))
    assert response.status_code == 200
    data = response.json()
    # 20 base registry entries + 1 synthesised stage. After the 2026-06-08
    # registry re-key (behavioral prompts moved from role='orchestrator' to
    # their real config roles), the (rework_mediator, mediate_rework) and
    # (implementer, implement) registry entries now match the default config's
    # stages directly, so they no longer synthesise; only the disabled-stage /
    # documentator placeholder remains synthesised. The board_reconciler
    # (reconcile) prompt added the 20th base entry (A1b no-op-loop cure).
    assert len(data) == 21
    slugs = [d["slug"] for d in data]
    assert "discover" in slugs
    assert "implement" in slugs
    assert "review" in slugs
    assert "post_review_decision" in slugs
    assert "document" in slugs
    # Phase I.1.h: research + plan personas seeded as defaults.
    assert "research" in slugs
    assert "plan" in slugs
    # New from 5-role redesign:
    assert "mediate_rework" in slugs
    # A1b no-op-loop cure: the board_reconciler disposition prompt.
    assert "reconcile" in slugs


async def test_get_prompt_defaults_researcher_role(
    client: AsyncClient, test_workspace: Workspace,
):
    response = await client.get(
        _defaults_url(test_workspace.slug), params={"role": "researcher"}
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["slug"] == "research"
    assert data[0]["role"] == "researcher"
    # T0.4: stage must equal the DSL token Go queries (was "Research").
    assert data[0]["stage"] == "research"


async def test_get_prompt_defaults_planner_role(
    client: AsyncClient, test_workspace: Workspace,
):
    response = await client.get(
        _defaults_url(test_workspace.slug), params={"role": "planner"}
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["slug"] == "plan"
    assert data[0]["role"] == "planner"
    # T0.4: stage must equal the DSL token Go queries (was "Plan").
    assert data[0]["stage"] == "plan"


async def test_get_prompt_defaults_by_role(
    client: AsyncClient, test_workspace: Workspace,
):
    response = await client.get(
        _defaults_url(test_workspace.slug), params={"role": "reviewer"}
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 4
    roles = {d["role"] for d in data}
    assert roles == {"reviewer"}


async def test_get_prompt_defaults_unknown_role(
    client: AsyncClient, test_workspace: Workspace,
):
    response = await client.get(
        _defaults_url(test_workspace.slug), params={"role": "unknown"}
    )
    assert response.status_code == 200
    assert response.json() == []


async def test_prompt_defaults_include_template_variables(
    client: AsyncClient, test_workspace: Workspace,
):
    response = await client.get(_defaults_url(test_workspace.slug))
    assert response.status_code == 200
    data = response.json()
    for stage in data:
        assert isinstance(stage["template_variables"], list)
        assert len(stage["template_variables"]) > 0
        assert "slug" in stage
        assert "role" in stage
        assert "stage" in stage
        assert "description" in stage


async def test_prompt_defaults_include_default_content(
    client: AsyncClient, test_workspace: Workspace,
):
    response = await client.get(_defaults_url(test_workspace.slug))
    assert response.status_code == 200
    data = response.json()
    for stage in data:
        assert "default_content" in stage
        assert isinstance(stage["default_content"], str)
        assert len(stage["default_content"]) > 100, f"{stage['slug']} content too short"
        assert "{{." in stage["default_content"], f"{stage['slug']} missing template vars"


async def test_review_prompt_uses_structured_output_not_freeform_json(
    client: AsyncClient, test_workspace: Workspace,
):
    # T2.1: reviewer migrated to claude --json-schema (StructuredOutput tool).
    # The prompt must no longer demand raw JSON in the message body — that text
    # was the source of parse failures (model emitted prose first).
    response = await client.get(
        _defaults_url(test_workspace.slug), params={"role": "reviewer"}
    )
    assert response.status_code == 200
    data = response.json()
    review = next((d for d in data if d["slug"] == "review"), None)
    assert review is not None, "review prompt missing"
    body = review["default_content"]
    assert "EXACTLY this JSON" not in body, (
        "review prompt must not demand raw JSON; --json-schema enforces shape"
    )
    assert "approve" in body and "request_changes" in body, (
        "decision values still need to be discoverable to the model"
    )
    assert "StructuredOutput" in body, (
        "prompt should mention the StructuredOutput tool the model will call"
    )


# --- Unique slug-per-scope constraint tests ---
# Scope = (workspace_id, team_id, team_role, stage, slug). Duplicate inserts
# within the same scope must fail at the DB layer. Cross-scope duplicates
# (different workspace, team, role) are allowed — slugs are only unique
# within their owning scope, which is what makes the config portable.


async def test_create_prompt_config_duplicate_slug_in_same_scope_fails(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    team = AgentTeam(
        name="Scoped Crew",
        workspace_id=test_workspace.id,
        created_by_id=test_user.id,
    )
    db_session.add(team)
    await db_session.flush()

    await _create_config(
        db_session, test_user,
        workspace_id=test_workspace.id,
        team_id=team.id,
        team_role="orchestrator",
        stage="discover",
        slug="dup-scope",
        name="First",
    )

    duplicate = AgentPromptConfig(
        name="Second",
        slug="dup-scope",
        stage="discover",
        team_role="orchestrator",
        team_id=team.id,
        workspace_id=test_workspace.id,
        content="Conflicting content",
        created_by_id=test_user.id,
    )
    db_session.add(duplicate)
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()


async def test_create_prompt_config_same_slug_different_team_role_succeeds(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    first = await _create_config(
        db_session, test_user,
        workspace_id=test_workspace.id,
        team_role="orchestrator",
        stage="discover",
        slug="shared-slug",
        name="Orch",
    )
    second = await _create_config(
        db_session, test_user,
        workspace_id=test_workspace.id,
        team_role="reviewer",
        stage="discover",
        slug="shared-slug",
        name="Rev",
    )
    assert first.id != second.id
    assert first.slug == second.slug == "shared-slug"


async def test_create_prompt_config_same_slug_different_workspace_succeeds(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    other_workspace = Workspace(
        name="Other", slug="other", created_by=test_user.id,
    )
    db_session.add(other_workspace)
    await db_session.flush()

    first = await _create_config(
        db_session, test_user,
        workspace_id=test_workspace.id,
        team_role="orchestrator",
        stage="discover",
        slug="portable-slug",
        name="In Default",
    )
    second = await _create_config(
        db_session, test_user,
        workspace_id=other_workspace.id,
        team_role="orchestrator",
        stage="discover",
        slug="portable-slug",
        name="In Other",
    )
    assert first.id != second.id
    assert first.slug == second.slug == "portable-slug"


# --- Cross-tenant isolation ---
# Workspace A must not be able to read/modify/delete workspace B's configs
# by guessing or enumerating the UUID. Service must verify
# config.workspace_id matches the URL-scoped workspace.


async def _make_foreign_workspace_with_config(
    db_session: AsyncSession, test_user: User
) -> tuple[Workspace, AgentPromptConfig]:
    other_workspace = Workspace(
        name="Private", slug="private", created_by=test_user.id,
    )
    db_session.add(other_workspace)
    await db_session.flush()

    foreign_config = await _create_config(
        db_session, test_user,
        workspace_id=other_workspace.id,
        slug="foreign-prompt", name="Foreign",
    )
    return other_workspace, foreign_config


async def test_get_prompt_config_cross_tenant_rejected(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    _, foreign_config = await _make_foreign_workspace_with_config(db_session, test_user)

    response = await client.get(
        f"{_configs_url(test_workspace.slug)}/{foreign_config.id}"
    )
    assert response.status_code == 404


async def test_update_prompt_config_cross_tenant_rejected(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    _, foreign_config = await _make_foreign_workspace_with_config(db_session, test_user)

    response = await client.patch(
        f"{_configs_url(test_workspace.slug)}/{foreign_config.id}",
        json={"content": "pwned"},
    )
    assert response.status_code == 404


async def test_delete_prompt_config_cross_tenant_rejected(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    _, foreign_config = await _make_foreign_workspace_with_config(db_session, test_user)

    response = await client.delete(
        f"{_configs_url(test_workspace.slug)}/{foreign_config.id}"
    )
    assert response.status_code == 404


async def test_get_system_prompt_config_accessible(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    # workspace_id=NULL → system default, readable from any workspace scope
    system_config = await _create_config(
        db_session, test_user, workspace_id=None,
        slug="sys-readable", name="System Default",
    )
    response = await client.get(
        f"{_configs_url(test_workspace.slug)}/{system_config.id}"
    )
    assert response.status_code == 200
    assert response.json()["slug"] == "sys-readable"


# --- Synthesis of defaults from workspace pipeline_config (T1.1) ---
# When a workspace's pipeline_config defines a (role, stage) pair that is not
# covered by PROMPT_STAGE_REGISTRY, GET /defaults must synthesize a placeholder
# entry so the UI renders an authoring surface for the user-defined stage.


def _pipeline_with_stage(role: str, llm_stage: str | None, enabled: bool = True) -> dict:
    llm: dict = {"enabled": enabled, "tools": []}
    if llm_stage is not None:
        llm["stage"] = llm_stage
    return {
        "version": 1,
        "stages": [
            {
                "role": role,
                "discover": {"strategy": "unassigned_or_rework"},
                "claim": {"participant_role": "hero", "execution_action": "run"},
                "git": {"action": "none"},
                "llm": llm,
                "sensors": [],
                "on_success": {},
                "on_failure": {},
            }
        ],
    }


async def test_get_prompt_defaults_synthesizes_missing_role_stage(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace,
):
    from app.models.workspace_config import WorkspaceConfig

    pipeline = _pipeline_with_stage("security-auditor", "security_review")
    db_session.add(WorkspaceConfig(workspace_id=test_workspace.id, pipeline_config=pipeline))
    await db_session.flush()

    response = await client.get(_defaults_url(test_workspace.slug))
    assert response.status_code == 200
    data = response.json()
    synthesized = next(
        (d for d in data if d["role"] == "security-auditor" and d["stage"] == "security_review"),
        None,
    )
    assert synthesized is not None, "synthesized placeholder missing for custom role/stage"
    assert synthesized["slug"] == "security-auditor-security_review"
    assert synthesized["template_variables"] == [
        "Workspace", "AgentID", "BoardID", "CardID", "ExecutionID", "ProjectDirectives",
    ]
    # Interpolation proof: literal role and stage tokens appear in content
    assert "security_review" in synthesized["default_content"]
    assert "security-auditor" in synthesized["default_content"]
    # Go template tokens preserved (not interpolated by Python)
    assert "{{.Workspace}}" in synthesized["default_content"]
    assert "{{.CardID}}" in synthesized["default_content"]


async def test_get_prompt_defaults_does_not_duplicate_existing_registry_entries(
    client: AsyncClient, test_workspace: Workspace,
):
    # Post-redesign: implementer role has llm.stage=implement, which IS in
    # the registry. Must not get a duplicate synthesized row.
    response = await client.get(
        _defaults_url(test_workspace.slug), params={"role": "implementer"}
    )
    assert response.status_code == 200
    data = response.json()
    implement_entries = [d for d in data if d["stage"] == "implement"]
    assert len(implement_entries) == 1


async def test_get_prompt_defaults_skips_disabled_llm_stages(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace,
):
    from app.models.workspace_config import WorkspaceConfig

    pipeline = _pipeline_with_stage("custom-role", "custom_stage", enabled=False)
    db_session.add(WorkspaceConfig(workspace_id=test_workspace.id, pipeline_config=pipeline))
    await db_session.flush()

    response = await client.get(_defaults_url(test_workspace.slug))
    assert response.status_code == 200
    data = response.json()
    assert not any(
        d["role"] == "custom-role" and d["stage"] == "custom_stage" for d in data
    ), "disabled llm stage must not be synthesized"


async def test_get_prompt_defaults_filter_by_custom_role_returns_only_synthesized(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace,
):
    from app.models.workspace_config import WorkspaceConfig

    pipeline = _pipeline_with_stage("db-migrator", "migrate")
    db_session.add(WorkspaceConfig(workspace_id=test_workspace.id, pipeline_config=pipeline))
    await db_session.flush()

    response = await client.get(
        _defaults_url(test_workspace.slug), params={"role": "db-migrator"}
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["role"] == "db-migrator"
    assert data[0]["stage"] == "migrate"


async def test_get_prompt_defaults_workspace_without_pipeline_config(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace,
):
    # Edge case: WorkspaceConfig with pipeline_config=None. get_or_create seeds
    # with defaults, so this is a defensive guardrail. Asserting no crash and
    # the registry entries are still returned.
    response = await client.get(_defaults_url(test_workspace.slug))
    assert response.status_code == 200
    data = response.json()
    # Registry size is 19 (existing test asserts this); synthesis from default
    # pipeline_config may add 0 (all registry-covered) entries.
    slugs = {d["slug"] for d in data}
    assert "implement" in slugs
    assert "review" in slugs
    assert "document" in slugs


async def test_get_prompt_defaults_synthesizes_lowercase_slug_for_mixed_case_role_stage(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace,
):
    # Frontend "Create new stage" form lowercases role+stage before POSTing the
    # slug (components/PromptConfigPage.tsx:145-150). Backend synthesis must
    # produce the same canonical form so getOverride() matches user-authored
    # overrides against synthesized defaults. Without this, a pipeline with
    # role="Security-Auditor" + stage="SecurityReview" synthesizes slug
    # "Security-Auditor-SecurityReview" while the user's override would be
    # "security-auditor-securityreview" — no match, defaults appear un-editable.
    from app.models.workspace_config import WorkspaceConfig

    pipeline = _pipeline_with_stage("Security-Auditor", "SecurityReview")
    db_session.add(WorkspaceConfig(workspace_id=test_workspace.id, pipeline_config=pipeline))
    await db_session.flush()

    response = await client.get(_defaults_url(test_workspace.slug))
    assert response.status_code == 200
    data = response.json()
    synthesized = next(
        (d for d in data if d["role"] == "Security-Auditor" and d["stage"] == "SecurityReview"),
        None,
    )
    assert synthesized is not None, "synthesized placeholder missing for mixed-case role/stage"
    assert synthesized["slug"] == "security-auditor-securityreview", (
        f"expected lowercase canonical slug, got {synthesized['slug']!r}"
    )


async def test_export_prompt_config_workspace_scoped(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    config = await _create_config(
        db_session,
        test_user,
        workspace_id=test_workspace.id,
        slug="exp-prompt",
        name="Export Prompt",
        agent_type="coding",
        team_role="orchestrator",
        stage="implement",
        content="You are exporting.",
    )

    response = await client.get(
        f"{_configs_url(test_workspace.slug)}/{config.id}/export"
    )
    assert response.status_code == 200, response.text

    body = response.json()
    assert body["entity_type"] == "prompt_config"
    assert body["source_workspace_slug"] == test_workspace.slug

    data = body["data"]
    assert data["slug"] == "exp-prompt"
    assert data["name"] == "Export Prompt"
    assert data["agent_type"] == "coding"
    assert data["team_role"] == "orchestrator"
    assert data["stage"] == "implement"
    assert data["content"] == "You are exporting."
    assert data["team_slug"] is None
    assert data["is_system"] is False
    assert data["version"] == 1

    assert (
        'filename="exp-prompt.valaris.prompt_config.json"'
        in response.headers["content-disposition"]
    )


async def test_export_prompt_config_system_row(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    # System rows have workspace_id=None and is_system=True.
    config = await _create_config(
        db_session,
        test_user,
        workspace_id=None,
        slug="system-export",
        name="System Export",
        is_system=True,
    )

    response = await client.get(
        f"{_configs_url(test_workspace.slug)}/{config.id}/export"
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["data"]["is_system"] is True
    assert body["data"]["slug"] == "system-export"


async def test_export_prompt_config_includes_team_slug(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    team = AgentTeam(
        name="Owner Team",
        slug="owner-team",
        description="",
        workspace_id=test_workspace.id,
        created_by_id=test_user.id,
    )
    db_session.add(team)
    await db_session.flush()

    config = await _create_config(
        db_session,
        test_user,
        workspace_id=test_workspace.id,
        team_id=team.id,
        slug="team-prompt",
    )

    response = await client.get(
        f"{_configs_url(test_workspace.slug)}/{config.id}/export"
    )
    assert response.status_code == 200
    assert response.json()["data"]["team_slug"] == "owner-team"


async def test_export_prompt_config_cross_workspace_returns_404(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    second_user: User,
):
    other_ws = Workspace(name="Other", slug="other", created_by=second_user.id)
    db_session.add(other_ws)
    await db_session.flush()

    config = await _create_config(
        db_session,
        second_user,
        workspace_id=other_ws.id,
        slug="other-ws-config",
    )

    # client is authenticated as test_user (member of test_workspace).
    # Trying to export via second_user's workspace slug → 403/404 (non-member).
    # Trying via test_workspace slug → cross-workspace ID guard → 404.
    response = await client.get(
        f"/api/workspaces/default/prompt-configs/{config.id}/export"
    )
    assert response.status_code == 404


async def test_export_prompt_config_unknown_id(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get(
        f"{_configs_url(test_workspace.slug)}/{uuid.uuid4()}/export"
    )
    assert response.status_code == 404


# --- Resolved content (B11 fix) ---
# Operator-edited prompts (is_system=false) override the synthesized default,
# which means the post_process imperative baked into the synthesized content
# disappears. `resolved_content` is a derived field on PromptConfigRead that
# appends the matching imperative at read time so the runner sees it even
# when the operator has rewritten `content`.


def _pipeline_with_llm(role: str, stage: str, post_process_kind: str) -> dict:
    return {
        "version": 1,
        "stages": [
            {
                "role": role,
                "discover": {"strategy": "unassigned_or_rework"},
                "claim": {"participant_role": "hero", "execution_action": "run"},
                "git": {"action": "none"},
                "llm": {
                    "enabled": True,
                    "stage": stage,
                    "tools": [],
                    "post_process_kind": post_process_kind,
                },
                "sensors": [],
                "on_success": {},
                "on_failure": {},
            }
        ],
    }


async def _install_pipeline(db_session: AsyncSession, workspace_id, pipeline: dict):
    from app.models.workspace_config import WorkspaceConfig

    db_session.add(
        WorkspaceConfig(workspace_id=workspace_id, pipeline_config=pipeline)
    )
    await db_session.flush()


async def test_prompt_config_read_resolved_content_equals_content_when_no_post_process(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    # writes_code has no imperative — resolved_content == content.
    await _install_pipeline(
        db_session,
        test_workspace.id,
        _pipeline_with_llm("coder", "implement", "writes_code"),
    )
    config = await _create_config(
        db_session,
        test_user,
        workspace_id=test_workspace.id,
        slug="coder-implement",
        team_role="coder",
        stage="implement",
        content="Operator-authored implement prompt.",
    )

    response = await client.get(
        f"{_configs_url(test_workspace.slug)}/{config.id}"
    )
    assert response.status_code == 200
    data = response.json()
    assert data["content"] == "Operator-authored implement prompt."
    assert data["resolved_content"] == "Operator-authored implement prompt."


async def test_prompt_config_read_resolved_content_appends_produces_note_imperative(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    # Post-LLM→lifecycle-contract redesign: operator rewrites a produces_note
    # stage and the resolver appends an imperative. The new imperative tells
    # the LLM to emit findings via the JSON envelope and explicitly forbids
    # calling create_note (the lifecycle handles persistence). See
    # session_2026_05_18 for the round-7 smoke evidence.
    await _install_pipeline(
        db_session,
        test_workspace.id,
        _pipeline_with_llm("secretary", "inform", "produces_note"),
    )
    config = await _create_config(
        db_session,
        test_user,
        workspace_id=test_workspace.id,
        slug="secretary-inform",
        team_role="secretary",
        stage="inform",
        content="Summarize today's standup.",
    )

    response = await client.get(
        f"{_configs_url(test_workspace.slug)}/{config.id}"
    )
    assert response.status_code == 200
    data = response.json()
    assert data["content"] == "Summarize today's standup."
    assert data["resolved_content"].startswith("Summarize today's standup.\n\n")
    assert "findings" in data["resolved_content"]
    assert "DO NOT call" in data["resolved_content"]
    assert "mcp__valaris__create_note" in data["resolved_content"]


async def test_prompt_config_read_resolved_content_appends_mutates_backlog_imperative(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    await _install_pipeline(
        db_session,
        test_workspace.id,
        _pipeline_with_llm("architect", "plan_work", "mutates_backlog"),
    )
    config = await _create_config(
        db_session,
        test_user,
        workspace_id=test_workspace.id,
        slug="architect-plan_work",
        team_role="architect",
        stage="plan_work",
        content="Break the objective into cards.",
    )

    response = await client.get(
        f"{_configs_url(test_workspace.slug)}/{config.id}"
    )
    assert response.status_code == 200
    data = response.json()
    # New contract: the resolver forbids LLM-side create_card / create_note
    # calls instead of mandating them. Sibling-card creation belongs to a
    # separate decomposer role.
    assert "do not call" in data["resolved_content"].lower()
    assert "mcp__valaris__create_card" in data["resolved_content"]
    assert "mcp__valaris__create_note" in data["resolved_content"]


async def test_prompt_config_read_resolved_content_does_not_double_append_when_operator_already_included_it(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    # Paste/copy scenario: operator copied the imperative into their own content
    # (e.g., from the synthesized default). Resolver must detect and not double-append.
    await _install_pipeline(
        db_session,
        test_workspace.id,
        _pipeline_with_llm("secretary", "inform", "produces_note"),
    )
    operator_content = (
        "Summarize today's standup.\n\n"
        "You MUST emit your full output in the `findings` field of the "
        "response JSON. DO NOT call mcp__valaris__create_note."
    )
    config = await _create_config(
        db_session,
        test_user,
        workspace_id=test_workspace.id,
        slug="secretary-inform-dedup",
        team_role="secretary",
        stage="inform",
        content=operator_content,
    )

    response = await client.get(
        f"{_configs_url(test_workspace.slug)}/{config.id}"
    )
    assert response.status_code == 200
    resolved = response.json()["resolved_content"]
    occurrences = resolved.count(
        "You MUST emit your full output in the `findings` field"
    )
    assert occurrences == 1, (
        f"imperative double-appended ({occurrences}x). resolved={resolved!r}"
    )


async def test_prompt_config_list_fetches_pipeline_config_once(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    monkeypatch,
):
    # N prompts → 1 pipeline_config fetch. Tracked via call count on
    # WorkspaceConfigService.get_config.
    from app.services import workspace_config as workspace_config_module

    await _install_pipeline(
        db_session,
        test_workspace.id,
        _pipeline_with_llm("secretary", "inform", "produces_note"),
    )
    for i in range(5):
        await _create_config(
            db_session,
            test_user,
            workspace_id=test_workspace.id,
            slug=f"prompt-{i}",
            team_role="secretary",
            stage="inform",
            content=f"Prompt {i}",
        )

    original = workspace_config_module.WorkspaceConfigService.get_config
    call_count = {"n": 0}

    async def counting_get_config(self, workspace_id):
        call_count["n"] += 1
        return await original(self, workspace_id)

    monkeypatch.setattr(
        workspace_config_module.WorkspaceConfigService,
        "get_config",
        counting_get_config,
    )

    response = await client.get(_configs_url(test_workspace.slug))
    assert response.status_code == 200
    assert len(response.json()) >= 5
    assert call_count["n"] == 1, (
        f"expected 1 pipeline_config fetch per list call, got {call_count['n']}"
    )


async def test_prompt_config_read_workspace_less_config_skips_resolution(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    # System row (workspace_id=None) has no pipeline scope → resolved_content == content.
    system_config = await _create_config(
        db_session,
        test_user,
        workspace_id=None,
        slug="system-resolved",
        team_role="secretary",
        stage="inform",
        content="System default content, no imperative appended.",
    )
    response = await client.get(
        f"{_configs_url(test_workspace.slug)}/{system_config.id}"
    )
    assert response.status_code == 200
    data = response.json()
    assert data["content"] == data["resolved_content"]
    assert "You MUST capture" not in data["resolved_content"]


async def test_prompt_config_read_no_matching_pipeline_stage_leaves_content(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    # Pipeline declares a different (role, stage) — no match → no append.
    await _install_pipeline(
        db_session,
        test_workspace.id,
        _pipeline_with_llm("secretary", "inform", "produces_note"),
    )
    config = await _create_config(
        db_session,
        test_user,
        workspace_id=test_workspace.id,
        slug="unmatched",
        team_role="architect",
        stage="plan_work",
        content="No matching pipeline stage.",
    )
    response = await client.get(
        f"{_configs_url(test_workspace.slug)}/{config.id}"
    )
    assert response.status_code == 200
    data = response.json()
    assert data["resolved_content"] == data["content"]


# --- Dual-lookup: slug or UUID on {config_ident} path param ---
# Phase-3 slug-identity migration: router accepts slug as a first-class
# alternative to UUID. UUID keeps working; slug resolves within the
# URL-scoped workspace. Out-of-workspace or non-existent → 404.


async def test_lookup_prompt_config_by_slug_returns_config(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    config = await _create_config(
        db_session, test_user, workspace_id=test_workspace.id,
        slug="lookup-by-slug", name="Lookup Slug",
    )
    response = await client.get(
        f"{_configs_url(test_workspace.slug)}/lookup-by-slug"
    )
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == str(config.id)
    assert data["slug"] == "lookup-by-slug"


async def test_lookup_prompt_config_by_uuid_still_works(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    config = await _create_config(
        db_session, test_user, workspace_id=test_workspace.id,
        slug="uuid-path", name="UUID Path",
    )
    response = await client.get(
        f"{_configs_url(test_workspace.slug)}/{config.id}"
    )
    assert response.status_code == 200
    assert response.json()["slug"] == "uuid-path"


async def test_lookup_prompt_config_by_slug_not_found(
    client: AsyncClient, test_workspace: Workspace,
):
    response = await client.get(
        f"{_configs_url(test_workspace.slug)}/does-not-exist"
    )
    assert response.status_code == 404


async def test_lookup_prompt_config_by_slug_prefers_workspace_over_system(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    # If a slug exists both workspace-scoped and system-scoped, the
    # workspace-scoped row wins — operator overrides are authoritative.
    system_config = await _create_config(
        db_session, test_user, workspace_id=None,
        slug="shared-slug-lookup", name="System", is_system=True,
    )
    ws_config = await _create_config(
        db_session, test_user, workspace_id=test_workspace.id,
        slug="shared-slug-lookup", name="Workspace",
    )
    response = await client.get(
        f"{_configs_url(test_workspace.slug)}/shared-slug-lookup"
    )
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == str(ws_config.id)
    assert data["id"] != str(system_config.id)


async def test_lookup_prompt_config_by_slug_falls_back_to_system(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    # No workspace-scoped row with this slug → system row should resolve.
    system_config = await _create_config(
        db_session, test_user, workspace_id=None,
        slug="system-only-slug", name="System Only", is_system=True,
    )
    response = await client.get(
        f"{_configs_url(test_workspace.slug)}/system-only-slug"
    )
    assert response.status_code == 200
    assert response.json()["id"] == str(system_config.id)


async def test_update_prompt_config_by_slug(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    config = await _create_config(
        db_session, test_user, workspace_id=test_workspace.id,
        slug="patch-by-slug", name="Patch Slug",
    )
    response = await client.patch(
        f"{_configs_url(test_workspace.slug)}/patch-by-slug",
        json={"content": "new content"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == str(config.id)
    assert data["content"] == "new content"
    assert data["version"] == 2


async def test_delete_prompt_config_by_slug(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    await _create_config(
        db_session, test_user, workspace_id=test_workspace.id,
        slug="delete-by-slug", name="Delete Slug",
    )
    response = await client.delete(
        f"{_configs_url(test_workspace.slug)}/delete-by-slug"
    )
    assert response.status_code == 204

    response = await client.get(
        f"{_configs_url(test_workspace.slug)}/delete-by-slug"
    )
    assert response.status_code == 404


async def test_lookup_prompt_config_by_slug_cross_workspace_rejected(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    # Same slug in a foreign workspace must NOT resolve via the current
    # workspace's URL scope. Slug lookup is workspace-scoped; cross-tenant
    # reads return 404 even when the slug exists elsewhere.
    other_workspace = Workspace(
        name="Foreign", slug="foreign", created_by=test_user.id,
    )
    db_session.add(other_workspace)
    await db_session.flush()
    await _create_config(
        db_session, test_user, workspace_id=other_workspace.id,
        slug="only-in-foreign", name="Foreign Prompt",
    )
    response = await client.get(
        f"{_configs_url(test_workspace.slug)}/only-in-foreign"
    )
    assert response.status_code == 404


async def test_duplicate_slug_across_stages_same_team_allowed(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    # Composite unique is (workspace, team, team_role, stage, slug).
    # Same slug under different stage on the same team is legal.
    team = AgentTeam(
        name="Cross-Stage Crew",
        workspace_id=test_workspace.id,
        created_by_id=test_user.id,
    )
    db_session.add(team)
    await db_session.flush()

    first = await _create_config(
        db_session, test_user,
        workspace_id=test_workspace.id,
        team_id=team.id,
        team_role="orchestrator",
        stage="discover",
        slug="shared-across-stages",
        name="Discover",
    )
    second = await _create_config(
        db_session, test_user,
        workspace_id=test_workspace.id,
        team_id=team.id,
        team_role="orchestrator",
        stage="implement",
        slug="shared-across-stages",
        name="Implement",
    )
    assert first.id != second.id
    assert first.slug == second.slug == "shared-across-stages"


# --- Context-source ↔ prompt wiring warnings (Layer 1) ---


def _pipeline_with_context_source(role: str, stage_name: str, sources: list[dict]) -> dict:
    return {
        "version": 4,
        "stages": [
            {
                "role": role,
                "discover": {"strategy": "unassigned_or_rework"},
                "claim": {"participant_role": "hero"},
                "git": {"action": "none"},
                "llm": {
                    "enabled": True,
                    "stage": stage_name,
                    "context_sources": sources,
                },
            }
        ],
        "scheduling": {"priority_order": [role], "mode": "priority"},
    }


async def _set_pipeline_config(
    db_session: AsyncSession, workspace_id, pipeline_config: dict
) -> None:
    from app.models.workspace_config import WorkspaceConfig

    db_session.add(
        WorkspaceConfig(workspace_id=workspace_id, pipeline_config=pipeline_config)
    )
    await db_session.flush()


async def test_prompt_read_surfaces_declared_but_unreferenced_warning(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    await _set_pipeline_config(
        db_session,
        test_workspace.id,
        _pipeline_with_context_source(
            "implementer", "implement", [{"kind": "pipeline_expectations"}]
        ),
    )
    cfg = await _create_config(
        db_session,
        test_user,
        workspace_id=test_workspace.id,
        team_role="implementer",
        stage="implement",
        slug="impl-prompt",
        content="Do the work. No context referenced here.",
    )

    response = await client.get(f"{_configs_url(test_workspace.slug)}/{cfg.id}")
    assert response.status_code == 200
    warnings = response.json()["context_source_warnings"]
    codes = [w["code"] for w in warnings]
    assert "context_source_declared_but_unreferenced" in codes


async def test_prompt_read_no_warning_when_referenced(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    await _set_pipeline_config(
        db_session,
        test_workspace.id,
        _pipeline_with_context_source(
            "implementer", "implement", [{"kind": "pipeline_expectations"}]
        ),
    )
    cfg = await _create_config(
        db_session,
        test_user,
        workspace_id=test_workspace.id,
        team_role="implementer",
        stage="implement",
        slug="impl-prompt",
        content='Expectations:\n{{ index .ContextSources "pipeline_expectations" }}',
    )

    response = await client.get(f"{_configs_url(test_workspace.slug)}/{cfg.id}")
    assert response.status_code == 200
    assert response.json()["context_source_warnings"] == []


async def test_prompt_update_returns_undeclared_warning(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    await _set_pipeline_config(
        db_session,
        test_workspace.id,
        _pipeline_with_context_source("implementer", "implement", []),
    )
    cfg = await _create_config(
        db_session,
        test_user,
        workspace_id=test_workspace.id,
        team_role="implementer",
        stage="implement",
        slug="impl-prompt",
        content="placeholder",
    )

    response = await client.patch(
        f"{_configs_url(test_workspace.slug)}/{cfg.id}",
        json={"content": '{{ index .ContextSources "linked_cards" }}'},
    )
    assert response.status_code == 200
    codes = [w["code"] for w in response.json()["context_source_warnings"]]
    assert "context_source_referenced_but_undeclared" in codes


async def test_workspace_config_read_surfaces_wiring_warning(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    await _set_pipeline_config(
        db_session,
        test_workspace.id,
        _pipeline_with_context_source(
            "implementer", "implement", [{"kind": "pipeline_expectations"}]
        ),
    )
    await _create_config(
        db_session,
        test_user,
        workspace_id=test_workspace.id,
        team_role="implementer",
        stage="implement",
        slug="impl-prompt",
        content="No context referenced.",
    )

    response = await client.get(f"/api/workspaces/{test_workspace.slug}/config")
    assert response.status_code == 200
    codes = [w["code"] for w in response.json()["context_source_warnings"]]
    assert "context_source_declared_but_unreferenced" in codes
