# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ResourceNotFoundError
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceRole
from app.schemas.workspace import WorkspaceCreate, WorkspaceUpdate
from app.services.workspace import WorkspaceService


async def test_create_workspace(db_session: AsyncSession, test_user: User):
    service = WorkspaceService(db_session)
    data = WorkspaceCreate(name="Engineering", slug="engineering")

    workspace = await service.create_workspace(data, test_user)

    assert workspace.name == "Engineering"
    assert workspace.slug == "engineering"
    assert workspace.created_by == test_user.id


async def test_create_workspace_adds_owner_membership(db_session: AsyncSession, test_user: User):
    service = WorkspaceService(db_session)
    data = WorkspaceCreate(name="Team", slug="team")

    workspace = await service.create_workspace(data, test_user)
    members = await service.list_members(workspace.id)

    assert len(members) == 1
    assert members[0].user_id == test_user.id
    assert members[0].role == WorkspaceRole.owner


async def test_create_workspace_duplicate_slug_is_idempotent(
    db_session: AsyncSession, test_user: User
):
    """Idempotent on slug collision — returns existing workspace, no ConflictError.

    Critical for LLM retry resilience: agents that retry create_workspace must
    not see 409s. Mirrors BoardService.create_board.
    """
    service = WorkspaceService(db_session)
    first = await service.create_workspace(
        WorkspaceCreate(name="First", slug="dup-slug"), test_user
    )

    second = await service.create_workspace(
        WorkspaceCreate(name="Second", slug="dup-slug"), test_user
    )

    assert second.id == first.id
    assert second.slug == "dup-slug"


async def test_list_workspaces(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    service = WorkspaceService(db_session)

    workspaces = await service.list_workspaces(test_user)

    assert any(w.id == test_workspace.id for w in workspaces)


async def test_list_workspaces_excludes_non_member(
    db_session: AsyncSession, second_user: User, test_workspace: Workspace
):
    service = WorkspaceService(db_session)

    workspaces = await service.list_workspaces(second_user)

    assert not any(w.id == test_workspace.id for w in workspaces)


async def test_update_workspace(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = WorkspaceService(db_session)
    data = WorkspaceUpdate(name="Renamed")

    updated = await service.update_workspace(test_workspace.id, data)

    assert updated.name == "Renamed"
    assert updated.slug == test_workspace.slug


async def test_update_workspace_not_found(db_session: AsyncSession):
    service = WorkspaceService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.update_workspace(uuid.uuid4(), WorkspaceUpdate(name="X"))


async def test_delete_workspace(
    db_session: AsyncSession, test_user: User
):
    service = WorkspaceService(db_session)
    data = WorkspaceCreate(name="Temp", slug="temp-delete")
    workspace = await service.create_workspace(data, test_user)

    await service.delete_workspace(workspace.id)

    with pytest.raises(ResourceNotFoundError):
        await service.update_workspace(workspace.id, WorkspaceUpdate(name="X"))


async def test_delete_workspace_not_found(db_session: AsyncSession):
    service = WorkspaceService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.delete_workspace(uuid.uuid4())


async def test_add_member(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = WorkspaceService(db_session)

    await service.add_member(test_workspace.id, "new@valaris.dev", WorkspaceRole.member)
    members = await service.list_members(test_workspace.id)

    emails = [m.user.email for m in members]
    assert "new@valaris.dev" in emails


async def test_add_member_auto_provisions_user(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = WorkspaceService(db_session)

    await service.add_member(test_workspace.id, "auto@valaris.dev", WorkspaceRole.viewer)
    members = await service.list_members(test_workspace.id)

    auto_member = next(m for m in members if m.user.email == "auto@valaris.dev")
    assert auto_member.role == WorkspaceRole.viewer


async def test_add_member_duplicate_is_idempotent(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """Re-adding an existing member returns the existing row, not a ConflictError."""
    service = WorkspaceService(db_session)
    existing = await service.member_repo.get_membership(test_workspace.id, test_user.id)
    assert existing is not None

    result = await service.add_member(
        test_workspace.id, test_user.email, WorkspaceRole.member
    )

    assert result.user_id == existing.user_id
    assert result.workspace_id == existing.workspace_id


async def test_remove_member(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = WorkspaceService(db_session)
    await service.add_member(test_workspace.id, "remove@valaris.dev", WorkspaceRole.member)
    members = await service.list_members(test_workspace.id)
    removable = next(m for m in members if m.user.email == "remove@valaris.dev")

    await service.remove_member(test_workspace.id, removable.user_id)
    members = await service.list_members(test_workspace.id)

    assert not any(m.user.email == "remove@valaris.dev" for m in members)


async def test_list_members(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    service = WorkspaceService(db_session)

    members = await service.list_members(test_workspace.id)

    assert len(members) >= 1
    assert any(m.user_id == test_user.id for m in members)


# --- Tests for activity recording ---


async def test_create_workspace_records_activity(db_session: AsyncSession, test_user: User):
    from app.models.activity import Activity, ActivityAction, ActivityEntityType
    from sqlalchemy import select

    service = WorkspaceService(db_session)
    data = WorkspaceCreate(name="Tracked WS", slug="tracked-ws")

    workspace = await service.create_workspace(data, test_user)

    result = await db_session.execute(select(Activity))
    activities = list(result.scalars().all())
    assert len(activities) == 1
    a = activities[0]
    assert a.entity_type == ActivityEntityType.workspace
    assert a.action == ActivityAction.created
    assert a.entity_id == workspace.id
    assert a.workspace_id == workspace.id
    assert a.actor_id == test_user.id
    assert "created workspace" in a.summary
    assert "Tracked WS" in a.summary


async def test_update_workspace_records_activity(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    from app.models.activity import Activity, ActivityAction, ActivityEntityType
    from sqlalchemy import select

    service = WorkspaceService(db_session)
    data = WorkspaceUpdate(name="Renamed WS")

    await service.update_workspace(test_workspace.id, data, actor_id=test_user.id)

    result = await db_session.execute(
        select(Activity).where(Activity.action == ActivityAction.updated)
    )
    activities = list(result.scalars().all())
    assert len(activities) == 1
    a = activities[0]
    assert a.entity_type == ActivityEntityType.workspace
    assert a.entity_id == test_workspace.id
    assert a.actor_id == test_user.id
    assert "updated workspace" in a.summary
    assert a.changes == {"fields": ["name"]}


async def test_add_member_records_activity(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    from app.models.activity import Activity, ActivityAction, ActivityEntityType
    from sqlalchemy import select

    service = WorkspaceService(db_session)

    await service.add_member(
        test_workspace.id, "member-track@valaris.dev", WorkspaceRole.member,
        actor_id=test_user.id,
    )

    result = await db_session.execute(
        select(Activity).where(Activity.action == ActivityAction.added_member)
    )
    activities = list(result.scalars().all())
    assert len(activities) == 1
    a = activities[0]
    assert a.entity_type == ActivityEntityType.member
    assert a.action == ActivityAction.added_member
    assert a.workspace_id == test_workspace.id
    assert a.actor_id == test_user.id
    assert "member-track@valaris.dev" in a.summary
    assert a.message_key == "activity.member.added"
    assert a.message_params == {
        "member_email": "member-track@valaris.dev",
        "role": "member",
    }


async def test_remove_member_records_activity(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    from app.models.activity import Activity, ActivityAction, ActivityEntityType
    from sqlalchemy import select

    service = WorkspaceService(db_session)
    await service.add_member(
        test_workspace.id, "remove-track@valaris.dev", WorkspaceRole.member,
    )
    members = await service.list_members(test_workspace.id)
    removable = next(m for m in members if m.user.email == "remove-track@valaris.dev")

    await service.remove_member(
        test_workspace.id, removable.user_id, actor_id=test_user.id
    )

    result = await db_session.execute(
        select(Activity).where(Activity.action == ActivityAction.removed_member)
    )
    activities = list(result.scalars().all())
    assert len(activities) == 1
    a = activities[0]
    assert a.entity_type == ActivityEntityType.member
    assert a.action == ActivityAction.removed_member
    assert a.workspace_id == test_workspace.id
    assert a.actor_id == test_user.id
    assert "removed member" in a.summary
    assert a.message_key == "activity.member.removed"
    assert a.message_params == {}


# --- Email case-insensitive identity ---


async def test_add_member_case_variant_resolves_existing_user(
    db_session: AsyncSession, test_workspace: Workspace
):
    """A case variant of a known email lands the membership on the EXISTING
    user — add_member must never mint a phantom duplicate identity, and the
    idempotent re-add path must hold in either casing."""
    from sqlalchemy import func, select

    existing = User(email="pat@example.com", name="Pat")
    db_session.add(existing)
    await db_session.flush()
    users_before = (
        await db_session.execute(select(func.count()).select_from(User))
    ).scalar_one()

    service = WorkspaceService(db_session)
    membership = await service.add_member(
        test_workspace.id, "Pat@EXAMPLE.com", WorkspaceRole.member
    )

    assert membership.user_id == existing.id
    assert existing.email == "pat@example.com"  # stored form stays canonical
    users_after = (
        await db_session.execute(select(func.count()).select_from(User))
    ).scalar_one()
    assert users_after == users_before

    # Re-adding in either casing is idempotent: no error, no second membership.
    again_upper = await service.add_member(
        test_workspace.id, "PAT@example.COM", WorkspaceRole.member
    )
    again_lower = await service.add_member(
        test_workspace.id, "pat@example.com", WorkspaceRole.member
    )
    assert again_upper.user_id == existing.id
    assert again_lower.user_id == existing.id
    pat_memberships = [
        m
        for m in await service.list_members(test_workspace.id)
        if m.user_id == existing.id
    ]
    assert len(pat_memberships) == 1


async def test_add_member_provisions_canonical_email_for_new_user(
    db_session: AsyncSession, test_workspace: Workspace
):
    """When add_member mints the user, the stored email must be the canonical
    (stripped, lowercase) form — the invite casing must not leak into storage,
    or the next entry point resolves a different identity."""
    from sqlalchemy import select

    service = WorkspaceService(db_session)
    membership = await service.add_member(
        test_workspace.id, "  New.Member@EXAMPLE.com  ", WorkspaceRole.member
    )

    minted = (
        await db_session.execute(select(User).where(User.id == membership.user_id))
    ).scalar_one()
    assert minted.email == "new.member@example.com"
