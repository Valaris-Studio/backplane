# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ResourceNotFoundError, ValidationError
from app.models.kanban.board import Board
from app.models.resources.resource import ResourceType
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.resources.resource import ResourceCreate, ResourceUpdate
from app.services.resources.resource import ResourceService


async def test_create_resource_file(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ResourceService(db_session)
    data = ResourceCreate(name="doc.pdf", resource_type=ResourceType.file)

    resource = await service.create_resource(test_workspace.id, data, test_user.id)

    assert resource.name == "doc.pdf"
    assert resource.resource_type == ResourceType.file
    assert resource.workspace_id == test_workspace.id
    assert resource.board_id is None
    assert resource.gcs_path is not None
    assert resource.uploaded_by == test_user.id
    assert resource.meta == {}
    assert resource.description is None


async def test_create_resource_folder(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ResourceService(db_session)
    data = ResourceCreate(name="Images", resource_type=ResourceType.folder)

    resource = await service.create_resource(test_workspace.id, data, test_user.id)

    assert resource.name == "Images"
    assert resource.resource_type == ResourceType.folder
    assert resource.gcs_path is None
    assert resource.mime_type is None
    assert resource.size_bytes is None


async def test_create_resource_with_valid_parent(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ResourceService(db_session)
    folder = await service.create_resource(
        test_workspace.id,
        ResourceCreate(name="Parent", resource_type=ResourceType.folder),
        test_user.id,
    )

    child = await service.create_resource(
        test_workspace.id,
        ResourceCreate(name="child.txt", parent_id=folder.id),
        test_user.id,
    )

    assert child.parent_id == folder.id


async def test_create_resource_with_invalid_parent(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ResourceService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.create_resource(
            test_workspace.id,
            ResourceCreate(name="orphan.txt", parent_id=uuid.uuid4()),
            test_user.id,
        )


async def test_create_resource_parent_not_folder(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ResourceService(db_session)
    file_resource = await service.create_resource(
        test_workspace.id,
        ResourceCreate(name="not-a-folder.txt"),
        test_user.id,
    )

    with pytest.raises(ValidationError):
        await service.create_resource(
            test_workspace.id,
            ResourceCreate(name="child.txt", parent_id=file_resource.id),
            test_user.id,
        )


async def test_list_resources_by_workspace(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ResourceService(db_session)
    await service.create_resource(
        test_workspace.id,
        ResourceCreate(name="ws-file.txt"),
        test_user.id,
    )

    resources = await service.list_resources(workspace_id=test_workspace.id)

    assert len(resources) == 1
    assert resources[0].name == "ws-file.txt"


async def test_list_resources_by_board(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    service = ResourceService(db_session)
    await service.create_resource(
        test_workspace.id,
        ResourceCreate(name="board-file.txt"),
        test_user.id,
        board_id=test_board.id,
    )
    # Workspace-level resource should not appear
    await service.create_resource(
        test_workspace.id,
        ResourceCreate(name="ws-file.txt"),
        test_user.id,
    )

    resources = await service.list_resources(board_id=test_board.id)

    assert len(resources) == 1
    assert resources[0].name == "board-file.txt"


async def test_list_resources_by_parent(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ResourceService(db_session)
    folder = await service.create_resource(
        test_workspace.id,
        ResourceCreate(name="Folder", resource_type=ResourceType.folder),
        test_user.id,
    )
    await service.create_resource(
        test_workspace.id,
        ResourceCreate(name="inside.txt", parent_id=folder.id),
        test_user.id,
    )
    await service.create_resource(
        test_workspace.id,
        ResourceCreate(name="outside.txt"),
        test_user.id,
    )

    resources = await service.list_resources(parent_id=folder.id)

    assert len(resources) == 1
    assert resources[0].name == "inside.txt"


async def test_get_resource_success(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ResourceService(db_session)
    created = await service.create_resource(
        test_workspace.id,
        ResourceCreate(name="get-me.txt"),
        test_user.id,
    )

    resource = await service.get_resource(created.id, test_workspace.id)

    assert resource.id == created.id
    assert resource.name == "get-me.txt"


async def test_get_resource_not_found(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = ResourceService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.get_resource(uuid.uuid4(), test_workspace.id)


async def test_get_resource_wrong_workspace(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ResourceService(db_session)
    created = await service.create_resource(
        test_workspace.id,
        ResourceCreate(name="secret.txt"),
        test_user.id,
    )

    with pytest.raises(ResourceNotFoundError):
        await service.get_resource(created.id, uuid.uuid4())


async def test_update_resource_rename(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ResourceService(db_session)
    created = await service.create_resource(
        test_workspace.id,
        ResourceCreate(name="old.txt"),
        test_user.id,
    )

    updated = await service.update_resource(
        created.id, test_workspace.id, test_user.id, ResourceUpdate(name="new.txt")
    )

    assert updated.name == "new.txt"
    assert updated.id == created.id


async def test_update_resource_move_to_folder(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ResourceService(db_session)
    folder = await service.create_resource(
        test_workspace.id,
        ResourceCreate(name="Target", resource_type=ResourceType.folder),
        test_user.id,
    )
    file = await service.create_resource(
        test_workspace.id,
        ResourceCreate(name="movable.txt"),
        test_user.id,
    )

    updated = await service.update_resource(
        file.id, test_workspace.id, test_user.id, ResourceUpdate(parent_id=folder.id)
    )

    assert updated.parent_id == folder.id


async def test_update_resource_prevent_self_reference(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ResourceService(db_session)
    folder = await service.create_resource(
        test_workspace.id,
        ResourceCreate(name="Self", resource_type=ResourceType.folder),
        test_user.id,
    )

    with pytest.raises(ValidationError, match="Cannot move resource into itself"):
        await service.update_resource(
            folder.id, test_workspace.id, test_user.id,
            ResourceUpdate(parent_id=folder.id),
        )


async def test_delete_resource(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ResourceService(db_session)
    created = await service.create_resource(
        test_workspace.id,
        ResourceCreate(name="delete-me.txt"),
        test_user.id,
    )

    await service.delete_resource(created.id, test_workspace.id, test_user.id)

    with pytest.raises(ResourceNotFoundError):
        await service.get_resource(created.id, test_workspace.id)


# --- Search & metadata tests ---


async def test_search_by_name(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ResourceService(db_session)
    await service.create_resource(
        test_workspace.id,
        ResourceCreate(name="design-doc.md"),
        test_user.id,
    )
    await service.create_resource(
        test_workspace.id,
        ResourceCreate(name="budget.xlsx"),
        test_user.id,
    )

    results = await service.list_resources(
        workspace_id=test_workspace.id, q="design"
    )

    assert len(results) == 1
    assert results[0].name == "design-doc.md"


async def test_create_with_metadata(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ResourceService(db_session)
    data = ResourceCreate(
        name="logo.svg",
        resource_type=ResourceType.file,
        metadata={"tags": ["branding", "design"]},
        description="Company logo",
    )

    resource = await service.create_resource(test_workspace.id, data, test_user.id)

    assert resource.meta == {"tags": ["branding", "design"]}
    assert resource.description == "Company logo"


async def test_update_metadata(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ResourceService(db_session)
    created = await service.create_resource(
        test_workspace.id,
        ResourceCreate(name="file.txt", metadata={"tags": ["old"]}),
        test_user.id,
    )

    updated = await service.update_resource(
        created.id,
        test_workspace.id,
        test_user.id,
        ResourceUpdate(metadata={"tags": ["new"]}, description="Updated"),
    )

    assert updated.meta == {"tags": ["new"]}
    assert updated.description == "Updated"


async def test_metadata_validation_too_many_tags(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ResourceService(db_session)
    tags = [f"tag-{i}" for i in range(25)]

    with pytest.raises(ValidationError):
        await service.create_resource(
            test_workspace.id,
            ResourceCreate(name="file.txt", metadata={"tags": tags}),
            test_user.id,
        )


async def test_metadata_validation_tag_too_long(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ResourceService(db_session)

    with pytest.raises(ValidationError):
        await service.create_resource(
            test_workspace.id,
            ResourceCreate(name="file.txt", metadata={"tags": ["x" * 60]}),
            test_user.id,
        )


async def test_list_tags(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = ResourceService(db_session)
    await service.create_resource(
        test_workspace.id,
        ResourceCreate(name="a.png", metadata={"tags": ["design", "ui"]}),
        test_user.id,
    )
    await service.create_resource(
        test_workspace.id,
        ResourceCreate(name="b.png", metadata={"tags": ["design", "branding"]}),
        test_user.id,
    )

    tags = await service.list_tags(test_workspace.id)

    assert tags == ["branding", "design", "ui"]


# --- Shallow merge tests ---


async def test_update_resource_metadata_shallow_merge(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """Sending partial metadata merges with existing before validation.

    Empty metadata update ({}) preserves existing tags via merge.
    """
    service = ResourceService(db_session)
    created = await service.create_resource(
        test_workspace.id,
        ResourceCreate(name="merge.txt", metadata={"tags": ["keep-me"]}),
        test_user.id,
    )

    updated = await service.update_resource(
        created.id,
        test_workspace.id,
        test_user.id,
        ResourceUpdate(metadata={}),
    )

    assert updated.meta["tags"] == ["keep-me"]
