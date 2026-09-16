# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Phase 1 — NotificationPreference model + NotificationPreferenceRepository.

RED-phase tests for docs/notification-system-contract.md
§"Table notification_preferences". Pure data access — the effective-prefs
resolver (muted -> override -> category default keyed by relevance_scope)
lives in the service layer in Phase 2. Here we pin only:
  - column shape + defaults (relevance_scope="watching", category_overrides={},
    muted=False)
  - unique (user_id, workspace_id)
  - get_for returns the row, or None when absent ("missing row = all defaults")
  - upsert creates when absent, updates in place when present, and round-trips
    JSON category_overrides

A missing row meaning "all defaults" is asserted only as "get_for returns None"
— the defaulting is the Phase-2 resolver's job, not the repo's.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notifications.preference import NotificationPreference
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.repositories.notifications.preference import (
    NotificationPreferenceRepository,
)


async def _make_workspace(db: AsyncSession, owner: User, slug: str) -> Workspace:
    ws = Workspace(name=slug.title(), slug=slug, created_by=owner.id)
    db.add(ws)
    await db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=owner.id, role=WorkspaceRole.owner))
    await db.flush()
    return ws


# --------------------------------------------------------------------------- #
# model shape + defaults
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_preference_defaults(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    pref = NotificationPreference(
        user_id=test_user.id, workspace_id=test_workspace.id
    )
    db_session.add(pref)
    await db_session.flush()
    await db_session.refresh(pref)

    assert pref.id is not None
    assert pref.relevance_scope == "watching"
    assert pref.category_overrides == {}
    assert pref.muted is False
    assert pref.created_at is not None
    assert pref.updated_at is not None


@pytest.mark.asyncio
async def test_preference_persists_overrides_and_scope(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    overrides = {"card_comment": {"in_app": False}, "approval_requested": {"in_app": True}}
    pref = NotificationPreference(
        user_id=test_user.id,
        workspace_id=test_workspace.id,
        relevance_scope="everything",
        category_overrides=overrides,
        muted=True,
    )
    db_session.add(pref)
    await db_session.flush()
    await db_session.refresh(pref)

    assert pref.relevance_scope == "everything"
    assert pref.category_overrides == overrides
    assert pref.muted is True


@pytest.mark.asyncio
async def test_unique_user_workspace_rejects_duplicate(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """uq_notif_prefs_user_workspace — one row per (user, workspace)."""
    db_session.add(
        NotificationPreference(user_id=test_user.id, workspace_id=test_workspace.id)
    )
    await db_session.flush()
    db_session.add(
        NotificationPreference(user_id=test_user.id, workspace_id=test_workspace.id)
    )
    with pytest.raises(IntegrityError):
        await db_session.flush()


@pytest.mark.asyncio
async def test_same_user_different_workspaces_allowed(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """A user can be loud in one workspace, quiet in another -> distinct rows."""
    ws_b = await _make_workspace(db_session, test_user, "workspace-b")
    db_session.add(
        NotificationPreference(user_id=test_user.id, workspace_id=test_workspace.id)
    )
    db_session.add(
        NotificationPreference(user_id=test_user.id, workspace_id=ws_b.id)
    )
    await db_session.flush()

    rows = (await db_session.execute(select(NotificationPreference))).scalars().all()
    assert len(rows) == 2


# --------------------------------------------------------------------------- #
# get_for
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_get_for_returns_none_when_absent(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """Missing row = all defaults; the repo just reports its absence."""
    repo = NotificationPreferenceRepository(db_session)
    assert await repo.get_for(test_user.id, test_workspace.id) is None


@pytest.mark.asyncio
async def test_get_for_returns_existing_row(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    db_session.add(
        NotificationPreference(
            user_id=test_user.id,
            workspace_id=test_workspace.id,
            relevance_scope="everything",
        )
    )
    await db_session.flush()

    repo = NotificationPreferenceRepository(db_session)
    found = await repo.get_for(test_user.id, test_workspace.id)
    assert found is not None
    assert found.relevance_scope == "everything"


@pytest.mark.asyncio
async def test_get_for_scoped_per_workspace(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    ws_b = await _make_workspace(db_session, test_user, "workspace-b")
    db_session.add(
        NotificationPreference(
            user_id=test_user.id, workspace_id=test_workspace.id, muted=True
        )
    )
    await db_session.flush()

    repo = NotificationPreferenceRepository(db_session)
    assert (await repo.get_for(test_user.id, test_workspace.id)).muted is True
    assert await repo.get_for(test_user.id, ws_b.id) is None


# --------------------------------------------------------------------------- #
# upsert — create when absent, update in place when present
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_upsert_creates_row_when_absent(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    repo = NotificationPreferenceRepository(db_session)
    pref = await repo.upsert(
        test_user.id,
        test_workspace.id,
        relevance_scope="everything",
        muted=True,
    )

    assert pref.id is not None
    assert pref.relevance_scope == "everything"
    assert pref.muted is True

    rows = (await db_session.execute(select(NotificationPreference))).scalars().all()
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_upsert_updates_existing_row_in_place(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    repo = NotificationPreferenceRepository(db_session)
    created = await repo.upsert(
        test_user.id, test_workspace.id, relevance_scope="watching"
    )
    updated = await repo.upsert(
        test_user.id,
        test_workspace.id,
        relevance_scope="everything",
        category_overrides={"card_comment": {"in_app": False}},
    )

    assert updated.id == created.id
    assert updated.relevance_scope == "everything"
    assert updated.category_overrides == {"card_comment": {"in_app": False}}

    rows = (await db_session.execute(select(NotificationPreference))).scalars().all()
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_upsert_round_trips_category_overrides(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    overrides = {
        "card_assigned": {"in_app": True},
        "card_comment": {"in_app": False},
    }
    repo = NotificationPreferenceRepository(db_session)
    await repo.upsert(test_user.id, test_workspace.id, category_overrides=overrides)

    found = await repo.get_for(test_user.id, test_workspace.id)
    assert found.category_overrides == overrides


# --------------------------------------------------------------------------- #
# get_for_users — batch-load (kills the per-recipient N+1 in generation)
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_get_for_users_batches_and_omits_missing(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User, second_user: User
):
    """One query returns a {user_id: pref} dict; users with no row are absent
    (the caller defaults them). Scoped to the requested workspace only."""
    repo = NotificationPreferenceRepository(db_session)
    await repo.upsert(test_user.id, test_workspace.id, relevance_scope="everything")

    by_user = await repo.get_for_users(
        [test_user.id, second_user.id], test_workspace.id
    )
    assert set(by_user) == {test_user.id}  # second_user has no row → omitted
    assert by_user[test_user.id].relevance_scope == "everything"


@pytest.mark.asyncio
async def test_get_for_users_empty_input_returns_empty(
    db_session: AsyncSession, test_workspace: Workspace
):
    repo = NotificationPreferenceRepository(db_session)
    assert await repo.get_for_users([], test_workspace.id) == {}


@pytest.mark.asyncio
async def test_get_for_users_scoped_to_workspace(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """A pref in another workspace is not returned for this workspace's query."""
    repo = NotificationPreferenceRepository(db_session)
    other_ws = await _make_workspace(db_session, test_user, "other-ws-prefs")
    await repo.upsert(test_user.id, other_ws.id, muted=True)

    by_user = await repo.get_for_users([test_user.id], test_workspace.id)
    assert by_user == {}
