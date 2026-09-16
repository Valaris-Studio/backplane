# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Phase 3 — Notification HTTP API (RED).

Integration tests for the current-user-scoped notification endpoints under
`/api/notifications` (contract §"API surface"). The router/service/schema for
these endpoints do NOT exist yet → these tests FAIL at import/route-resolution
until Phase 3 lands. That is the RED proof.

Endpoints covered (all current-user scoped, NOT under /api/workspaces/{slug}):
  GET    /api/notifications                       (A) keyset list + filters
  GET    /api/notifications/unread-count          (B) {count}
  POST   /api/notifications/{id}/read             (C) mark one read (idempotent)
  POST   /api/notifications/read-all              (D) mark all read
  GET    /api/notifications/preferences           (E) effective + raw prefs
  PUT    /api/notifications/preferences           (F) upsert prefs
  GET    /api/notifications/channels              (G) registered channel keys

WORKSPACE FILTER CHOICE (documented for the implementer):
  The contract (§"API surface") says the filter is `?workspace={slug}`. These
  notification endpoints are cross-workspace and NOT mounted under
  /api/workspaces/{slug}, so the `get_workspace` path-dependency can't resolve
  it. The implementer must resolve the slug → workspace id and re-verify the
  current user's membership (contract: "Workspace membership is re-verified when
  ?workspace= is supplied"). Tests use the SLUG form `?workspace=<slug>` to honor
  the contract. Omitting `?workspace` returns the all-workspaces rollup.

READ-ALL RETURN SHAPE CHOICE (documented for the implementer):
  The contract says POST /read-all → "mark all read" with no mandated body. We
  assert only status 200 + the observable effect (unread-count drops to 0), so
  the implementer is free to return {} or {"marked": N}. The state assertion is
  the binding contract, not the body shape.

SQLite strips tz — assert read_at is None / not None, never tz-aware equality.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.database import get_db
from app.main import create_app
from app.models.notifications.notification import Notification
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.repositories.notifications.notification import NotificationRepository


# --------------------------------------------------------------------------- #
# fixtures
# --------------------------------------------------------------------------- #
@pytest_asyncio.fixture
async def client_for_other_user(
    db_session: AsyncSession, second_user: User
) -> AsyncClient:
    """A second authenticated client bound to `second_user`, for cross-user
    isolation tests (userB must never see userA's notifications)."""
    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        return second_user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


async def _make_workspace(db: AsyncSession, owner: User, slug: str) -> Workspace:
    ws = Workspace(name=slug.title(), slug=slug, created_by=owner.id)
    db.add(ws)
    await db.flush()
    db.add(
        WorkspaceMember(workspace_id=ws.id, user_id=owner.id, role=WorkspaceRole.owner)
    )
    await db.flush()
    return ws


async def _add_member(db: AsyncSession, ws: Workspace, user: User) -> None:
    db.add(
        WorkspaceMember(
            workspace_id=ws.id, user_id=user.id, role=WorkspaceRole.member
        )
    )
    await db.flush()


async def _notify(
    db: AsyncSession,
    *,
    recipient: User,
    workspace: Workspace,
    category: str = "card_participant_changed",
    dedupe_key: str | None = None,
    actor: User | None = None,
    board_id: uuid.UUID | None = None,
    is_agent_actor: bool = False,
) -> Notification:
    repo = NotificationRepository(db)
    return await repo.create(
        recipient_user_id=recipient.id,
        workspace_id=workspace.id,
        board_id=board_id,
        category=category,
        actor_id=actor.id if actor else None,
        is_agent_actor=is_agent_actor,
        entity_type="card",
        entity_id=uuid.uuid4(),
        params={"card_title": "Widget"},
        link={"kind": "card", "workspace_slug": workspace.slug},
        dedupe_key=dedupe_key or f"{category}:{uuid.uuid4()}",
    )


# --------------------------------------------------------------------------- #
# A. GET /api/notifications — list
# --------------------------------------------------------------------------- #
async def test_list_notifications_empty_returns_empty_list(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get("/api/notifications")
    assert response.status_code == 200
    assert response.json() == []


async def test_list_notifications_returns_current_users_rows_desc_flat(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    second_user: User,
):
    """Flat list (no envelope), DESC by created_at, NotificationRead shape."""
    older = await _notify(
        db_session,
        recipient=test_user,
        workspace=test_workspace,
        actor=second_user,
        dedupe_key="k:older",
    )
    newer = await _notify(
        db_session,
        recipient=test_user,
        workspace=test_workspace,
        actor=second_user,
        dedupe_key="k:newer",
    )

    response = await client.get("/api/notifications")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)  # flat, no envelope
    ids = [row["id"] for row in data]
    assert ids.index(str(newer.id)) < ids.index(str(older.id))

    item = data[0]
    for key in (
        "id",
        "recipient_user_id",
        "workspace_id",
        "board_id",
        "category",
        "actor_id",
        "is_agent_actor",
        "entity_type",
        "entity_id",
        "params",
        "link",
        "read_at",
        "created_at",
    ):
        assert key in item, f"NotificationRead missing key {key!r}"
    assert item["recipient_user_id"] == str(test_user.id)
    assert item["read_at"] is None  # unread


async def test_list_notifications_filter_by_workspace_slug(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """`?workspace=<slug>` narrows to that workspace; omitting it returns the
    all-workspaces rollup."""
    ws_b = await _make_workspace(db_session, test_user, "workspace-b")
    in_a = await _notify(
        db_session, recipient=test_user, workspace=test_workspace, dedupe_key="k:a"
    )
    in_b = await _notify(
        db_session, recipient=test_user, workspace=ws_b, dedupe_key="k:b"
    )

    scoped = await client.get(f"/api/notifications?workspace={test_workspace.slug}")
    assert scoped.status_code == 200
    scoped_ids = {row["id"] for row in scoped.json()}
    assert scoped_ids == {str(in_a.id)}

    rollup = await client.get("/api/notifications")
    assert rollup.status_code == 200
    rollup_ids = {row["id"] for row in rollup.json()}
    assert rollup_ids == {str(in_a.id), str(in_b.id)}


async def test_list_notifications_unread_true_returns_only_unread(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    read_row = await _notify(
        db_session, recipient=test_user, workspace=test_workspace, dedupe_key="k:read"
    )
    unread_row = await _notify(
        db_session, recipient=test_user, workspace=test_workspace, dedupe_key="k:unread"
    )
    await NotificationRepository(db_session).mark_read(read_row)

    response = await client.get("/api/notifications?unread=true")
    assert response.status_code == 200
    ids = {row["id"] for row in response.json()}
    assert ids == {str(unread_row.id)}


async def test_list_notifications_respects_limit(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    for i in range(3):
        await _notify(
            db_session,
            recipient=test_user,
            workspace=test_workspace,
            dedupe_key=f"k:{i}",
        )

    response = await client.get("/api/notifications?limit=2")
    assert response.status_code == 200
    assert len(response.json()) == 2


async def test_list_notifications_before_cursor_paginates(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """Keyset: `?before=<created_at>` returns only rows strictly older than the
    cursor (the cursor row itself is excluded)."""
    for i in range(3):
        await _notify(
            db_session,
            recipient=test_user,
            workspace=test_workspace,
            dedupe_key=f"k:{i}",
        )

    full = await client.get("/api/notifications")
    assert full.status_code == 200
    rows = full.json()
    assert len(rows) == 3
    cursor = rows[0]["created_at"]

    # Pass the cursor via params so httpx URL-encodes the +00:00 offset the API
    # now emits (a raw f-string would turn `+` into a space → 422).
    page = await client.get("/api/notifications", params={"before": cursor})
    assert page.status_code == 200
    page_ids = {row["id"] for row in page.json()}
    assert rows[0]["id"] not in page_ids
    assert len(page_ids) == 2


async def test_list_notifications_isolated_across_users(
    client: AsyncClient,
    client_for_other_user: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    second_user: User,
):
    """userA's notifications must NOT appear in userB's feed."""
    await _add_member(db_session, test_workspace, second_user)
    mine = await _notify(
        db_session, recipient=test_user, workspace=test_workspace, dedupe_key="k:mine"
    )

    mine_resp = await client.get("/api/notifications")
    assert {row["id"] for row in mine_resp.json()} == {str(mine.id)}

    other_resp = await client_for_other_user.get("/api/notifications")
    assert other_resp.status_code == 200
    assert other_resp.json() == []


# --------------------------------------------------------------------------- #
# B. GET /api/notifications/unread-count
# --------------------------------------------------------------------------- #
async def test_unread_count_returns_count_object(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    await _notify(
        db_session, recipient=test_user, workspace=test_workspace, dedupe_key="k:a"
    )
    await _notify(
        db_session, recipient=test_user, workspace=test_workspace, dedupe_key="k:b"
    )

    response = await client.get("/api/notifications/unread-count")
    assert response.status_code == 200
    assert response.json() == {"count": 2}


async def test_unread_count_scopes_by_workspace_slug(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    ws_b = await _make_workspace(db_session, test_user, "workspace-b")
    await _notify(
        db_session, recipient=test_user, workspace=test_workspace, dedupe_key="k:a"
    )
    await _notify(
        db_session, recipient=test_user, workspace=ws_b, dedupe_key="k:b"
    )

    scoped = await client.get(
        f"/api/notifications/unread-count?workspace={test_workspace.slug}"
    )
    assert scoped.status_code == 200
    assert scoped.json() == {"count": 1}

    rollup = await client.get("/api/notifications/unread-count")
    assert rollup.status_code == 200
    assert rollup.json() == {"count": 2}


async def test_unread_count_decrements_when_a_notification_is_read(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    row = await _notify(
        db_session, recipient=test_user, workspace=test_workspace, dedupe_key="k:a"
    )
    await _notify(
        db_session, recipient=test_user, workspace=test_workspace, dedupe_key="k:b"
    )

    before = await client.get("/api/notifications/unread-count")
    assert before.json() == {"count": 2}

    read = await client.post(f"/api/notifications/{row.id}/read")
    assert read.status_code == 200

    after = await client.get("/api/notifications/unread-count")
    assert after.json() == {"count": 1}


# --------------------------------------------------------------------------- #
# C. POST /api/notifications/{id}/read
# --------------------------------------------------------------------------- #
async def test_read_notification_sets_read_at(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    row = await _notify(
        db_session, recipient=test_user, workspace=test_workspace, dedupe_key="k:a"
    )

    response = await client.post(f"/api/notifications/{row.id}/read")
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == str(row.id)
    assert body["read_at"] is not None


async def test_read_notification_is_idempotent(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    row = await _notify(
        db_session, recipient=test_user, workspace=test_workspace, dedupe_key="k:a"
    )

    first = await client.post(f"/api/notifications/{row.id}/read")
    assert first.status_code == 200
    stamp = first.json()["read_at"]
    assert stamp is not None

    second = await client.post(f"/api/notifications/{row.id}/read")
    assert second.status_code == 200
    assert second.json()["read_at"] == stamp  # unchanged on re-read


async def test_read_notification_of_another_user_is_rejected(
    client: AsyncClient,
    client_for_other_user: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    second_user: User,
):
    """Owner-only guard: userB cannot mark userA's notification read. A
    cross-owner read must NOT succeed (404 to avoid leaking existence, or 403)
    and must leave the row unread.

    First assert the OWNER can read it (200) so this test cannot pass vacuously
    against a missing route — a 404 from an unmounted endpoint would otherwise
    satisfy the `in (403, 404)` cross-owner assertion. Both the route AND the
    guard must exist for this test to go green."""
    await _add_member(db_session, test_workspace, second_user)
    row = await _notify(
        db_session, recipient=test_user, workspace=test_workspace, dedupe_key="k:a"
    )

    # The route must exist: the rightful owner reads it successfully.
    owner_read = await client.post(f"/api/notifications/{row.id}/read")
    assert owner_read.status_code == 200

    # Re-arm the row to unread so the cross-owner guard is tested on a fresh row.
    fresh = await _notify(
        db_session, recipient=test_user, workspace=test_workspace, dedupe_key="k:b"
    )
    response = await client_for_other_user.post(f"/api/notifications/{fresh.id}/read")
    assert response.status_code in (403, 404)

    await db_session.refresh(fresh)
    assert fresh.read_at is None  # untouched by the non-owner


# --------------------------------------------------------------------------- #
# D. POST /api/notifications/read-all
# --------------------------------------------------------------------------- #
async def test_read_all_marks_workspace_unread_read(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """`?workspace=<slug>` clears only that workspace's unread; the other
    workspace's unread survives."""
    ws_b = await _make_workspace(db_session, test_user, "workspace-b")
    await _notify(
        db_session, recipient=test_user, workspace=test_workspace, dedupe_key="k:a"
    )
    await _notify(
        db_session, recipient=test_user, workspace=ws_b, dedupe_key="k:b"
    )

    response = await client.post(
        f"/api/notifications/read-all?workspace={test_workspace.slug}"
    )
    assert response.status_code == 200

    a_left = await client.get(
        f"/api/notifications/unread-count?workspace={test_workspace.slug}"
    )
    assert a_left.json() == {"count": 0}
    b_left = await client.get(
        f"/api/notifications/unread-count?workspace={ws_b.slug}"
    )
    assert b_left.json() == {"count": 1}


async def test_read_all_without_workspace_clears_all_workspaces(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    ws_b = await _make_workspace(db_session, test_user, "workspace-b")
    await _notify(
        db_session, recipient=test_user, workspace=test_workspace, dedupe_key="k:a"
    )
    await _notify(
        db_session, recipient=test_user, workspace=ws_b, dedupe_key="k:b"
    )

    response = await client.post("/api/notifications/read-all")
    assert response.status_code == 200

    rollup = await client.get("/api/notifications/unread-count")
    assert rollup.json() == {"count": 0}


# --------------------------------------------------------------------------- #
# E. GET /api/notifications/preferences
# --------------------------------------------------------------------------- #
async def test_get_preferences_defaults_for_user_with_no_row(
    client: AsyncClient, test_workspace: Workspace
):
    """A user with no prefs row gets the defaults: relevance_scope='watching',
    category_overrides {}, muted false, plus an `effective` map derived from
    CATEGORY_DEFAULTS."""
    response = await client.get(
        f"/api/notifications/preferences?workspace={test_workspace.slug}"
    )
    assert response.status_code == 200
    body = response.json()

    assert body["relevance_scope"] == "watching"
    assert body["category_overrides"] == {}
    assert body["muted"] is False

    effective = body["effective"]
    # card_assigned default-ON for in_app at watching; card_created default-OFF.
    assert effective["card_assigned"]["in_app"] is True
    assert effective["card_created"]["in_app"] is False


# --------------------------------------------------------------------------- #
# F. PUT /api/notifications/preferences
# --------------------------------------------------------------------------- #
async def test_put_preferences_round_trips(
    client: AsyncClient, test_workspace: Workspace
):
    put = await client.put(
        f"/api/notifications/preferences?workspace={test_workspace.slug}",
        json={
            "relevance_scope": "everything",
            "category_overrides": {"card_created": {"in_app": True}},
            "muted": False,
        },
    )
    assert put.status_code == 200

    get = await client.get(
        f"/api/notifications/preferences?workspace={test_workspace.slug}"
    )
    assert get.status_code == 200
    body = get.json()
    assert body["relevance_scope"] == "everything"
    assert body["category_overrides"] == {"card_created": {"in_app": True}}


async def test_put_preferences_muted_makes_effective_all_false(
    client: AsyncClient, test_workspace: Workspace
):
    put = await client.put(
        f"/api/notifications/preferences?workspace={test_workspace.slug}",
        json={"relevance_scope": "watching", "category_overrides": {}, "muted": True},
    )
    assert put.status_code == 200

    get = await client.get(
        f"/api/notifications/preferences?workspace={test_workspace.slug}"
    )
    body = get.json()
    assert body["muted"] is True
    effective = body["effective"]
    # muted is the kill-switch: every category/channel resolves false.
    assert all(
        chan is False
        for cat in effective.values()
        for chan in cat.values()
    ), "muted must force every effective channel false"


async def test_put_preferences_override_flips_a_default(
    client: AsyncClient, test_workspace: Workspace
):
    """An override flips a default: card_created is default-OFF; overriding it ON
    must surface in the effective map."""
    put = await client.put(
        f"/api/notifications/preferences?workspace={test_workspace.slug}",
        json={
            "relevance_scope": "watching",
            "category_overrides": {"card_created": {"in_app": True}},
            "muted": False,
        },
    )
    assert put.status_code == 200

    get = await client.get(
        f"/api/notifications/preferences?workspace={test_workspace.slug}"
    )
    effective = get.json()["effective"]
    assert effective["card_created"]["in_app"] is True


# --------------------------------------------------------------------------- #
# G. GET /api/notifications/channels
# --------------------------------------------------------------------------- #
async def test_channels_lists_registered_keys(client: AsyncClient):
    """The capability list the FE prefs grid renders columns from. v1 ships
    in_app only."""
    response = await client.get("/api/notifications/channels")
    assert response.status_code == 200
    body = response.json()
    keys = body if isinstance(body, list) else body.get("channels")
    assert keys is not None, "channels response must expose the channel keys"
    assert "in_app" in keys
