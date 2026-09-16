# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ResourceNotFoundError
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.git.git_repo import GitRepoCreate, GitRepoUpdate
from app.services.git.git_repo import GitRepoService


async def test_create_git_repo(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    service = GitRepoService(db_session)
    data = GitRepoCreate(
        name="valaris-api",
        url="https://github.com/valaris/api",
        provider="github",
        default_branch="main",
        description="Main API repo",
    )

    repo, created = await service.create_git_repo(
        test_board.id, test_workspace.id, data, test_user.id
    )

    assert created is True
    assert repo.name == "valaris-api"
    assert repo.url == "https://github.com/valaris/api"
    assert repo.provider.value == "github"
    assert repo.default_branch == "main"
    assert repo.description == "Main API repo"
    assert repo.board_id == test_board.id
    assert repo.workspace_id == test_workspace.id
    assert repo.added_by == test_user.id
    # T2.3b: branch protection policy defaults to True so agent-driven
    # auto-merge has something to arm against. Operators can opt out per repo
    # for existing repos where flipping protection would disrupt humans.
    assert repo.require_branch_protection is True


async def test_create_git_repo_protection_can_be_disabled(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    service = GitRepoService(db_session)
    data = GitRepoCreate(
        name="legacy-repo",
        url="https://github.com/valaris/legacy",
        provider="github",
        require_branch_protection=False,
    )

    repo, _ = await service.create_git_repo(
        test_board.id, test_workspace.id, data, test_user.id
    )

    assert repo.require_branch_protection is False


async def test_update_git_repo_toggle_branch_protection(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    service = GitRepoService(db_session)
    repo, _ = await service.create_git_repo(
        test_board.id,
        test_workspace.id,
        GitRepoCreate(name="toggle", url="https://github.com/v/toggle", provider="github"),
        test_user.id,
    )

    updated = await service.update_git_repo(
        repo.id,
        test_board.id,
        GitRepoUpdate(require_branch_protection=False),
    )

    assert updated.require_branch_protection is False


async def test_list_git_repos(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    service = GitRepoService(db_session)
    await service.create_git_repo(
        test_board.id,
        test_workspace.id,
        GitRepoCreate(name="Repo 1", url="https://github.com/v/r1", provider="github"),
        test_user.id,
    )
    await service.create_git_repo(
        test_board.id,
        test_workspace.id,
        GitRepoCreate(name="Repo 2", url="https://gitlab.com/v/r2", provider="gitlab"),
        test_user.id,
    )

    repos = await service.list_git_repos(test_board.id)

    assert len(repos) == 2
    names = [r.name for r in repos]
    assert "Repo 1" in names
    assert "Repo 2" in names


async def test_list_git_repos_empty(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board
):
    service = GitRepoService(db_session)

    repos = await service.list_git_repos(test_board.id)

    assert repos == []


async def test_get_git_repo_success(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    service = GitRepoService(db_session)
    created, _ = await service.create_git_repo(
        test_board.id,
        test_workspace.id,
        GitRepoCreate(name="Get Me", url="https://github.com/v/get", provider="github"),
        test_user.id,
    )

    repo = await service.get_git_repo(created.id, test_board.id)

    assert repo.id == created.id
    assert repo.name == "Get Me"


async def test_get_git_repo_not_found(
    db_session: AsyncSession, test_board: Board
):
    service = GitRepoService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.get_git_repo(uuid.uuid4(), test_board.id)


async def test_get_git_repo_wrong_board(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    service = GitRepoService(db_session)
    created, _ = await service.create_git_repo(
        test_board.id,
        test_workspace.id,
        GitRepoCreate(name="Scoped", url="https://github.com/v/scoped", provider="github"),
        test_user.id,
    )

    other_board_id = uuid.uuid4()
    with pytest.raises(ResourceNotFoundError):
        await service.get_git_repo(created.id, other_board_id)


async def test_update_git_repo(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    service = GitRepoService(db_session)
    created, _ = await service.create_git_repo(
        test_board.id,
        test_workspace.id,
        GitRepoCreate(name="Original", url="https://github.com/v/old", provider="github"),
        test_user.id,
    )

    updated = await service.update_git_repo(
        created.id, test_board.id, GitRepoUpdate(name="Updated", url="https://github.com/v/new")
    )

    assert updated.name == "Updated"
    assert updated.url == "https://github.com/v/new"
    assert updated.id == created.id


async def test_update_git_repo_not_found(
    db_session: AsyncSession, test_board: Board
):
    service = GitRepoService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.update_git_repo(
            uuid.uuid4(), test_board.id, GitRepoUpdate(name="Nope")
        )


async def test_delete_git_repo(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    service = GitRepoService(db_session)
    created, _ = await service.create_git_repo(
        test_board.id,
        test_workspace.id,
        GitRepoCreate(name="Delete Me", url="https://github.com/v/del", provider="github"),
        test_user.id,
    )

    await service.delete_git_repo(created.id, test_board.id)

    with pytest.raises(ResourceNotFoundError):
        await service.get_git_repo(created.id, test_board.id)


async def test_delete_git_repo_not_found(
    db_session: AsyncSession, test_board: Board
):
    service = GitRepoService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.delete_git_repo(uuid.uuid4(), test_board.id)


# --- Tests for activity recording ---


async def test_update_git_repo_records_activity(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    from app.models.activity import Activity, ActivityAction, ActivityEntityType
    from sqlalchemy import select

    service = GitRepoService(db_session)
    created, _ = await service.create_git_repo(
        test_board.id, test_workspace.id,
        GitRepoCreate(name="Track Repo", url="https://github.com/v/track", provider="github"),
        test_user.id,
    )

    await service.update_git_repo(
        created.id, test_board.id, GitRepoUpdate(name="Updated Repo"),
        workspace_id=test_workspace.id, actor_id=test_user.id,
    )

    result = await db_session.execute(
        select(Activity).where(Activity.action == ActivityAction.updated)
    )
    activities = list(result.scalars().all())
    assert len(activities) == 1
    a = activities[0]
    assert a.entity_type == ActivityEntityType.git_repo
    assert a.entity_id == created.id
    assert a.board_id == test_board.id
    assert a.actor_id == test_user.id
    assert "updated git repo" in a.summary
    assert a.changes == {"fields": ["name"]}


async def test_delete_git_repo_records_activity(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    from app.models.activity import Activity, ActivityAction, ActivityEntityType
    from sqlalchemy import select

    service = GitRepoService(db_session)
    created, _ = await service.create_git_repo(
        test_board.id, test_workspace.id,
        GitRepoCreate(name="Delete Repo", url="https://github.com/v/delete", provider="github"),
        test_user.id,
    )

    await service.delete_git_repo(
        created.id, test_board.id,
        workspace_id=test_workspace.id, actor_id=test_user.id,
    )

    result = await db_session.execute(
        select(Activity).where(Activity.action == ActivityAction.deleted)
    )
    activities = list(result.scalars().all())
    assert len(activities) == 1
    a = activities[0]
    assert a.entity_type == ActivityEntityType.git_repo
    assert a.entity_id == created.id
    assert a.board_id == test_board.id
    assert "unlinked git repo" in a.summary
    assert "Delete Repo" in a.summary
