# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Slug→workspace resolution served from the Tier-1 cache within its TTL.

The membership/role read stays uncached on purpose (DO-NOT-CACHE, tenancy);
only the slug→id hop is spared, so these tests count that query alone."""

import uuid

import pytest
from sqlalchemy import event as sa_event

from app.core import workspace as workspace_dep
from app.models.workspace import Workspace


@pytest.fixture
def slug_query_counter(db_session):
    """Count executions of the slug→workspace SELECT on the test session."""
    counter = {"n": 0}
    # get_bind() hands back the sync Engine the async session wraps, which is
    # the level the cursor-execute event fires at.
    engine = db_session.get_bind()

    def before_cursor_execute(
        conn, cursor, statement, parameters, context, executemany
    ):
        normalized = " ".join(statement.split()).lower()
        if "from workspaces" in normalized and "workspaces.slug =" in normalized:
            counter["n"] += 1

    sa_event.listen(engine, "before_cursor_execute", before_cursor_execute)
    yield counter
    sa_event.remove(engine, "before_cursor_execute", before_cursor_execute)


@pytest.fixture
def enabled_slug_cache(monkeypatch):
    from app.core.cache import WorkspaceSlugCache
    from app.core.event_bus import EventBus

    cache = WorkspaceSlugCache(bus=EventBus(), single_instance_opt_in=True)
    monkeypatch.setattr(workspace_dep, "workspace_slug_cache", cache)
    return cache


@pytest.mark.asyncio
async def test_second_lookup_within_ttl_issues_no_second_slug_query(
    client, test_workspace, slug_query_counter, enabled_slug_cache
):
    first = await client.get(f"/api/workspaces/{test_workspace.slug}/boards")
    assert first.status_code == 200
    assert slug_query_counter["n"] == 1

    second = await client.get(f"/api/workspaces/{test_workspace.slug}/boards")
    assert second.status_code == 200
    assert slug_query_counter["n"] == 1


@pytest.mark.asyncio
async def test_disabled_cache_leaves_every_request_hitting_postgres(
    client, test_workspace, slug_query_counter, monkeypatch
):
    from app.core.cache import WorkspaceSlugCache
    from app.core.event_bus import EventBus

    monkeypatch.setattr(
        workspace_dep,
        "workspace_slug_cache",
        WorkspaceSlugCache(bus=EventBus(), single_instance_opt_in=False),
    )

    await client.get(f"/api/workspaces/{test_workspace.slug}/boards")
    await client.get(f"/api/workspaces/{test_workspace.slug}/boards")

    assert slug_query_counter["n"] == 2


@pytest.mark.asyncio
async def test_cached_id_pointing_at_a_vanished_workspace_falls_back_to_slug_query(
    client, db_session, test_workspace, slug_query_counter, enabled_slug_cache
):
    """delete_workspace records no activity, so nothing evicts on delete. The
    id-load must miss and fall back rather than resurrect a dead workspace."""
    enabled_slug_cache.remember(test_workspace.slug, uuid.uuid4())

    response = await client.get(f"/api/workspaces/{test_workspace.slug}/boards")

    assert response.status_code == 200
    assert slug_query_counter["n"] == 1


@pytest.mark.asyncio
async def test_renamed_slug_stops_resolving_once_its_event_evicts(
    client, db_session, test_workspace, enabled_slug_cache
):
    await client.get(f"/api/workspaces/{test_workspace.slug}/boards")
    assert enabled_slug_cache.lookup(test_workspace.slug) == test_workspace.id

    stale_slug = test_workspace.slug
    await db_session.execute(
        Workspace.__table__.update()
        .where(Workspace.id == test_workspace.id)
        .values(slug="renamed")
    )
    await enabled_slug_cache._on_workspace_activity(_workspace_event(test_workspace.id))

    response = await client.get(f"/api/workspaces/{stale_slug}/boards")

    assert response.status_code == 404


def _workspace_event(workspace_id):
    from app.core.event_bus import Event

    return Event(
        event_type="activity.workspace.updated",
        workspace_id=workspace_id,
        payload={"entity_type": "workspace", "action": "updated"},
    )
