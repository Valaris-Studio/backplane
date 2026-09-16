# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ResourceNotFoundError
from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.definitions.definition import Definition
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.definitions.definition import DefinitionUpsert
from app.services.definitions.definition import DefinitionService


async def test_get_definition_success(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_definition: Definition,
):
    service = DefinitionService(db_session)

    result = await service.get_definition(test_board.id, test_workspace.id)

    assert result.id == test_definition.id
    assert result.board_id == test_board.id
    assert result.workspace_id == test_workspace.id
    assert result.scope == "Build the MVP"
    assert result.content == {"tech_stack": ["Python"]}
    assert result.updated_by == test_user.id


async def test_get_definition_not_found(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = DefinitionService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.get_definition(uuid.uuid4(), test_workspace.id)


async def test_upsert_definition_create(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    service = DefinitionService(db_session)
    data = DefinitionUpsert(
        scope="Build the MVP",
        content={"tech_stack": ["Python"]},
    )

    result = await service.upsert_definition(
        test_board.id, test_workspace.id, data, test_user.id
    )

    assert result.scope == "Build the MVP"
    assert result.content == {"tech_stack": ["Python"]}
    assert result.board_id == test_board.id
    assert result.workspace_id == test_workspace.id
    assert result.updated_by == test_user.id


async def test_upsert_definition_update(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_definition: Definition,
):
    service = DefinitionService(db_session)
    data = DefinitionUpsert(
        scope="Updated scope",
        content={"tech_stack": ["Rust"]},
    )

    result = await service.upsert_definition(
        test_board.id, test_workspace.id, data, test_user.id
    )

    assert result.id == test_definition.id
    assert result.scope == "Updated scope"
    assert result.content == {"tech_stack": ["Rust"]}


async def test_upsert_definition_partial_update(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_definition: Definition,
):
    service = DefinitionService(db_session)
    data = DefinitionUpsert(scope="Only scope changed")

    result = await service.upsert_definition(
        test_board.id, test_workspace.id, data, test_user.id
    )

    assert result.id == test_definition.id
    assert result.scope == "Only scope changed"
    assert result.content == {"tech_stack": ["Python"]}


async def test_upsert_definition_records_activity(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    service = DefinitionService(db_session)
    data = DefinitionUpsert(scope="New definition")

    result = await service.upsert_definition(
        test_board.id, test_workspace.id, data, test_user.id
    )

    from sqlalchemy import select

    activities_result = await db_session.execute(
        select(Activity).where(
            Activity.entity_type == ActivityEntityType.definition,
            Activity.entity_id == result.id,
        )
    )
    activities = list(activities_result.scalars().all())

    assert len(activities) == 1
    assert activities[0].action == ActivityAction.created
    assert activities[0].workspace_id == test_workspace.id
    assert activities[0].board_id == test_board.id
    assert activities[0].actor_id == test_user.id


# --- Shallow merge tests ---


async def test_upsert_definition_content_shallow_merge(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    service = DefinitionService(db_session)
    original_content = {
        "tech_stack": ["Python"],
        "objectives": [{"text": "old objective", "priority": None}],
        "constraints": ["no downtime"],
    }
    await service.upsert_definition(
        test_board.id,
        test_workspace.id,
        DefinitionUpsert(scope="Test", content=original_content),
        test_user.id,
    )

    result = await service.upsert_definition(
        test_board.id,
        test_workspace.id,
        DefinitionUpsert(content={"objectives": ["new objective"]}),
        test_user.id,
    )

    assert result.content["objectives"] == [
        {"text": "new objective", "priority": None}
    ]
    assert result.content["tech_stack"] == ["Python"]
    assert result.content["constraints"] == ["no downtime"]


async def test_upsert_definition_content_merge_null_deletes_key(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    service = DefinitionService(db_session)
    await service.upsert_definition(
        test_board.id,
        test_workspace.id,
        DefinitionUpsert(
            scope="Test",
            content={"tech_stack": ["Python"], "constraints": ["old"]},
        ),
        test_user.id,
    )

    result = await service.upsert_definition(
        test_board.id,
        test_workspace.id,
        DefinitionUpsert(content={"constraints": None}),
        test_user.id,
    )

    assert "constraints" not in result.content
    assert result.content["tech_stack"] == ["Python"]


async def test_upsert_definition_content_full_replace_still_works(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    service = DefinitionService(db_session)
    await service.upsert_definition(
        test_board.id,
        test_workspace.id,
        DefinitionUpsert(scope="Test", content={"tech_stack": ["Python"]}),
        test_user.id,
    )

    full_content = {"tech_stack": ["Rust"], "objectives": ["new"]}
    result = await service.upsert_definition(
        test_board.id,
        test_workspace.id,
        DefinitionUpsert(content=full_content),
        test_user.id,
    )

    assert result.content == {
        "tech_stack": ["Rust"],
        "objectives": [{"text": "new", "priority": None}],
    }
