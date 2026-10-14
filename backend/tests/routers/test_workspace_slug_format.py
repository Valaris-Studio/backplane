# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole

# Rows created before workspace slugs were validated keep whatever slug they
# were given; reads must keep resolving them without a data migration.
LEGACY_NON_CONFORMING_SLUG = "Legacy_Slug"


@pytest.mark.parametrize(
    "invalid_slug",
    [
        "evil\nslug",
        'quo"te',
        "it's",
        "has space",
        "UpperCase",
        "-leading",
        "trailing-",
        "double--hyphen",
        "under_score",
        "dot.ted",
        "slash/slug",
        "",
        "a" * 256,
    ],
    ids=[
        "newline",
        "double-quote",
        "single-quote",
        "space",
        "uppercase",
        "leading-hyphen",
        "trailing-hyphen",
        "double-hyphen",
        "underscore",
        "dot",
        "slash",
        "empty",
        "over-255",
    ],
)
async def test_create_workspace_rejects_non_conforming_slug(
    client: AsyncClient, db_session: AsyncSession, test_user: User, invalid_slug: str
):
    response = await client.post(
        "/api/workspaces", json={"name": "Anything", "slug": invalid_slug}
    )

    assert response.status_code == 422, response.text
    assert response.json()["error_code"] == "request_validation_error"
    workspace_count = await db_session.scalar(select(func.count(Workspace.id)))
    assert workspace_count == 0


@pytest.mark.parametrize(
    "valid_slug",
    ["acme", "acme-corp", "team-42", "2026", "a", "a" * 255, "a1-b2-c3"],
)
async def test_create_workspace_accepts_conforming_slug(
    client: AsyncClient, test_user: User, valid_slug: str
):
    response = await client.post(
        "/api/workspaces", json={"name": "Anything", "slug": valid_slug}
    )

    assert response.status_code == 201, response.text
    assert response.json()["slug"] == valid_slug


@pytest.fixture
async def legacy_workspace(db_session: AsyncSession, test_user: User) -> Workspace:
    workspace = Workspace(
        name="Legacy", slug=LEGACY_NON_CONFORMING_SLUG, created_by=test_user.id
    )
    db_session.add(workspace)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=workspace.id, user_id=test_user.id, role=WorkspaceRole.owner
        )
    )
    await db_session.flush()
    return workspace


async def test_get_workspace_legacy_non_conforming_slug_still_resolves(
    client: AsyncClient, legacy_workspace: Workspace
):
    detail = await client.get(f"/api/workspaces/{LEGACY_NON_CONFORMING_SLUG}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["id"] == str(legacy_workspace.id)

    boards = await client.get(f"/api/workspaces/{LEGACY_NON_CONFORMING_SLUG}/boards")
    assert boards.status_code == 200, boards.text

    renamed = await client.put(
        f"/api/workspaces/{LEGACY_NON_CONFORMING_SLUG}", json={"name": "Renamed"}
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["slug"] == LEGACY_NON_CONFORMING_SLUG

    listed = await client.get("/api/workspaces")
    assert [ws["slug"] for ws in listed.json()] == [LEGACY_NON_CONFORMING_SLUG]
