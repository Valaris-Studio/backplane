# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent
from app.models.agents.prompt_config import AgentPromptConfig
from app.models.agents.team import AgentTeam, AgentTeamMember
from app.models.user import User
from app.models.workspace import Workspace
from app.services.agents.prompt_config import PromptConfigService
from app.services.agents.prompt_defaults import get_prompt_defaults


EXPECTED_DEFAULT_COUNT = len(get_prompt_defaults())


async def test_seed_defaults_creates_system_prompts(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User,
):
    service = PromptConfigService(db_session)
    result = await service.seed_defaults(test_workspace.id, test_user.id)

    assert len(result) == EXPECTED_DEFAULT_COUNT
    for config in result:
        assert config.is_system is True
        assert config.workspace_id == test_workspace.id
        assert config.created_by_id == test_user.id

    slugs = {c.slug for c in result}
    assert "discover" in slugs
    assert "implement" in slugs
    assert "review" in slugs
    assert "document" in slugs
    # Phase I.1.h — researcher + planner personas seeded alongside defaults.
    assert "research" in slugs
    assert "plan" in slugs


async def test_seed_defaults_includes_researcher_and_planner(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User,
):
    service = PromptConfigService(db_session)
    result = await service.seed_defaults(test_workspace.id, test_user.id)

    by_slug = {c.slug: c for c in result}
    research = by_slug["research"]
    assert research.team_role == "researcher"
    # T0.4: stage MUST equal the DSL token the Go engine queries — display
    # names like "Research" silently never match and fall back to hardcoded
    # Go prompts (ST#8 2026-04-17). slug and stage are now the same value.
    assert research.stage == "research"
    assert "{{.CardID}}" in research.content
    assert "findings" in research.content  # produces_note JSON shape

    plan = by_slug["plan"]
    assert plan.team_role == "planner"
    assert plan.stage == "plan"
    assert "{{.CardID}}" in plan.content
    assert "plan" in plan.content  # lifecycle persists decomposition as a plan note


# T0.4: every live stage (the ones Go's resolvePrompt actually queries) MUST
# be seeded with stage == slug. Display-name stages don't match the lookup key
# and every run silently falls back to hardcoded Go prompts.
LIVE_STAGES = {
    "implement",
    "implement_after_approval",
    "mediate_rework",
    "rework_implement",
    "review",
    "document",
    "research",
    "plan",
}


async def test_seed_defaults_live_stages_use_dsl_tokens(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User,
):
    service = PromptConfigService(db_session)
    result = await service.seed_defaults(test_workspace.id, test_user.id)

    by_slug = {c.slug: c for c in result}
    for token in LIVE_STAGES:
        assert token in by_slug, f"default prompt registry missing live stage {token!r}"
        cfg = by_slug[token]
        assert cfg.stage == token, (
            f"stage for slug {token!r} must equal the DSL token Go queries "
            f"({token!r}), got {cfg.stage!r}. Display names don't match "
            f"resolvePrompt's lookup key — Go silently falls back to hardcoded "
            f"prompts."
        )


async def test_seed_defaults_idempotent(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User,
):
    service = PromptConfigService(db_session)
    first = await service.seed_defaults(test_workspace.id, test_user.id)
    second = await service.seed_defaults(test_workspace.id, test_user.id)

    assert len(first) == EXPECTED_DEFAULT_COUNT
    assert len(second) == EXPECTED_DEFAULT_COUNT

    # Same IDs -- no duplicates created
    first_ids = {c.id for c in first}
    second_ids = {c.id for c in second}
    assert first_ids == second_ids


async def test_seed_defaults_skipped_when_user_prompts_exist(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User,
):
    """If user-created (non-system) prompts exist but no system prompts, seeding proceeds."""
    user_config = AgentPromptConfig(
        name="Custom Prompt",
        slug="custom-prompt",
        stage="discover",
        content="Custom content",
        workspace_id=test_workspace.id,
        created_by_id=test_user.id,
        is_system=False,
    )
    db_session.add(user_config)
    await db_session.flush()

    service = PromptConfigService(db_session)
    result = await service.seed_defaults(test_workspace.id, test_user.id)

    # Should seed because no system prompts exist yet
    system_configs = [c for c in result if c.is_system]
    assert len(system_configs) == EXPECTED_DEFAULT_COUNT


async def test_seed_defaults_skipped_when_system_prompts_exist(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User,
):
    """If system prompts already exist, seeding is a no-op."""
    system_config = AgentPromptConfig(
        name="System Prompt",
        slug="system-prompt",
        stage="discover",
        content="System content",
        workspace_id=test_workspace.id,
        created_by_id=test_user.id,
        is_system=True,
    )
    db_session.add(system_config)
    await db_session.flush()

    service = PromptConfigService(db_session)
    result = await service.seed_defaults(test_workspace.id, test_user.id)

    # Should return the existing list without adding new system prompts
    system_configs = [c for c in result if c.is_system]
    assert len(system_configs) == 1
    assert system_configs[0].slug == "system-prompt"


async def test_agent_config_seeds_prompts_on_first_access(
    agent_client: AsyncClient,
    db_session: AsyncSession,
    test_agent: Agent,
    test_user: User,
    test_workspace: Workspace,
    test_board,
):
    team = AgentTeam(
        name="Seed Team",
        description="Team for seeding test",
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        created_by_id=test_user.id,
    )
    db_session.add(team)
    await db_session.flush()

    member = AgentTeamMember(
        team_id=team.id,
        agent_id=test_agent.id,
        roles=["orchestrator"],
    )
    db_session.add(member)
    await db_session.flush()

    response = await agent_client.get("/api/agents/me/config")
    assert response.status_code == 200
    data = response.json()

    assert len(data["prompt_configs"]) > 0
    # Orchestrator should get orchestrator-role prompts
    orchestrator_defaults = [d for d in get_prompt_defaults() if d.role == "orchestrator"]
    assert len(data["prompt_configs"]) >= len(orchestrator_defaults)


async def test_agent_config_returns_existing_prompts_no_seeding(
    agent_client: AsyncClient,
    db_session: AsyncSession,
    test_agent: Agent,
    test_user: User,
    test_workspace: Workspace,
    test_board,
):
    # Create team assignment
    team = AgentTeam(
        name="Existing Prompts Team",
        description="Team with existing prompts",
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        created_by_id=test_user.id,
    )
    db_session.add(team)
    await db_session.flush()

    member = AgentTeamMember(
        team_id=team.id,
        agent_id=test_agent.id,
        roles=["orchestrator"],
    )
    db_session.add(member)
    await db_session.flush()

    # Pre-create a system prompt so seeding is skipped
    system_config = AgentPromptConfig(
        name="Pre-existing System",
        slug="pre-existing-system",
        stage="discover",
        content="Pre-existing content",
        team_role="orchestrator",
        workspace_id=test_workspace.id,
        created_by_id=test_user.id,
        is_system=True,
    )
    db_session.add(system_config)
    await db_session.flush()

    response = await agent_client.get("/api/agents/me/config")
    assert response.status_code == 200
    data = response.json()

    # Should return the existing prompt, not seed new ones
    assert len(data["prompt_configs"]) == 1
    assert data["prompt_configs"][0]["slug"] == "pre-existing-system"
