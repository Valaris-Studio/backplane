# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.agents.prompt_config import PromptConfigCreate
from app.services.agents.prompt_config import PromptConfigService


async def test_create_config_duplicate_returns_existing(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    service = PromptConfigService(db_session)
    payload = PromptConfigCreate(
        name="Discover",
        slug="discover",
        stage="discover",
        content="Initial content",
        team_role="orchestrator",
    )

    first = await service.create_config(test_workspace.id, payload, test_user.id)

    duplicate = await service.create_config(test_workspace.id, payload, test_user.id)

    assert duplicate.id == first.id
    assert duplicate.slug == "discover"
    assert duplicate.content == "Initial content"


async def test_create_config_same_slug_different_stage_creates_new(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    service = PromptConfigService(db_session)
    base = PromptConfigCreate(
        name="Shared",
        slug="shared",
        stage="discover",
        content="Discover content",
        team_role="orchestrator",
    )
    other_stage = PromptConfigCreate(
        name="Shared",
        slug="shared",
        stage="implement",
        content="Implement content",
        team_role="orchestrator",
    )

    first = await service.create_config(test_workspace.id, base, test_user.id)
    second = await service.create_config(test_workspace.id, other_stage, test_user.id)

    assert first.id != second.id
