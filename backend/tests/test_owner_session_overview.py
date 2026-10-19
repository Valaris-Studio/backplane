# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Owner discovery is global, metadata-only, and reauthorized on every page."""

import base64
import hashlib
import json
import secrets
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, event as sa_event

from app.config import settings
from app.database import get_db
from app.main import create_app
from app.models.agent_session import AgentSession, SessionWorkLink
from app.models.agents.agent import Agent, AgentType
from app.models.api_key import ApiKey
from app.models.kanban.board import Board
from app.models.notes.note import Note
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from tests.session_rows import add_installation, add_link, add_session
from tests.test_agent_sessions import as_user

SESSIONS = "/api/me/sessions"
OVERVIEW = SESSIONS + "/overview"
MINUTE = timedelta(minutes=1)
HOUR = timedelta(hours=1)


async def workspace_for(db, owner, slug):
    workspace = Workspace(name=slug.title(), slug=slug, created_by=owner.id)
    db.add(workspace)
    await db.flush()
    db.add(
        WorkspaceMember(
            workspace_id=workspace.id, user_id=owner.id, role=WorkspaceRole.owner
        )
    )
    await db.flush()
    return workspace


async def page(client, path=SESSIONS, **params):
    response = await client.get(path, params=params)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def ids(rows):
    return [row["id"] for row in rows]


async def test_global_list_scopes_owner_and_membership_before_paging(
    client, db_session, test_user, second_user, test_workspace
):
    other_workspace = await workspace_for(db_session, test_user, "second-project")
    inaccessible = await workspace_for(db_session, second_user, "former-project")
    mine = await add_installation(db_session, test_user)
    theirs = await add_installation(db_session, second_user)
    default_session = await add_session(
        db_session, mine, test_workspace, started=HOUR, last=3 * MINUTE
    )
    second_session = await add_session(
        db_session, mine, other_workspace, started=HOUR, last=2 * MINUTE
    )
    await add_session(db_session, mine, inaccessible, started=HOUR)
    await add_session(db_session, theirs, test_workspace, started=HOUR)

    for workspace, expected in (
        (test_workspace, default_session),
        (other_workspace, second_session),
    ):
        control = await page(client, f"/api/workspaces/{workspace.slug}/sessions")
        assert ids(control["items"]) == [str(expected.id)]
    assert (
        await client.get("/api/workspaces/former-project/sessions")
    ).status_code == 403

    first = await page(client, limit=1)
    assert ids(first["items"]) == [str(second_session.id)]
    assert first["next_cursor"]
    row = first["items"][0]
    assert row["workspace_id"] == str(other_workspace.id)
    assert row["workspace_slug"] == other_workspace.slug
    assert row["workspace_name"] == other_workspace.name
    second = await page(client, limit=1, cursor=first["next_cursor"])
    assert ids(second["items"]) == [str(default_session.id)]
    assert second["next_cursor"] is None


async def test_overview_finds_active_capture_behind_six_newer_paused_roots(
    client, db_session, test_user, test_workspace
):
    live = await add_installation(db_session, test_user)
    paused = await add_installation(db_session, test_user, paused=True)
    active = await add_session(
        db_session, live, test_workspace, started=HOUR, last=8 * MINUTE
    )
    recent = [
        await add_session(
            db_session, paused, test_workspace, started=HOUR, last=i * MINUTE
        )
        for i in range(7)
    ]
    control = await page(client, "/api/workspaces/default/sessions", limit=6)
    assert all(row["display_state"] == "paused" for row in control["items"])
    assert str(active.id) not in ids(control["items"])

    overview = await page(client, OVERVIEW, active_limit=6, recent_limit=6)
    assert ids(overview["active"]) == [str(active.id)]
    assert overview["active"][0]["display_state"] == "active"
    assert ids(overview["recent"]) == [str(row.id) for row in recent[:6]]
    assert overview["active_more"] is False
    assert overview["recent_more"] is True
    assert overview["generated_at"]
    assert "running" not in overview["active"][0]


async def test_metadata_keeps_withheld_title_and_never_queries_private_bodies(
    client, db_session, test_user, test_workspace, monkeypatch
):
    laptop = await add_installation(db_session, test_user)
    session = await add_session(
        db_session,
        laptop,
        test_workspace,
        started=HOUR,
        title=None,
        native="private-native-origin",
        cwd="/private/device/project",
        repository="safe-repository",
        branch="safe-branch",
    )
    control = await page(client, "/api/workspaces/default/sessions")
    assert control["items"][0]["title"] is None

    def unexpected_body_read(*_args, **_kwargs):
        raise AssertionError("Owner metadata must not fetch captured bodies")

    monkeypatch.setattr("app.services.session_content.store_for", unexpected_body_read)
    monkeypatch.setattr(
        "app.services.storage.session_content.content_store", unexpected_body_read
    )
    statements = []

    def record_query(_conn, _cursor, statement, *_args):
        statements.append(statement.lower())

    engine = db_session.get_bind()
    sa_event.listen(engine, "before_cursor_execute", record_query)
    try:
        listing = await page(client)
        overview = await page(client, OVERVIEW)
    finally:
        sa_event.remove(engine, "before_cursor_execute", record_query)

    forbidden_fields = {
        "native_session_id",
        "parent_native_session_id",
        "installation_id",
        "mapping_id",
        "cwd",
        "capture_id",
        "inline_text",
        "preview",
        "body",
    }
    for row in listing["items"] + overview["active"] + overview["recent"]:
        assert row["id"] == str(session.id)
        assert row["title"] is None
        assert row["repository"] == "safe-repository"
        assert forbidden_fields.isdisjoint(row)
    assert all("agent_session_contents" not in statement for statement in statements)
    assert all("agent_session_events" not in statement for statement in statements)


@pytest.mark.parametrize("sort", ["recent", "started"])
async def test_global_keyset_visits_205_interleaved_roots_once_with_equal_times(
    client, db_session, test_user, test_workspace, sort
):
    laptop = await add_installation(db_session, test_user)
    second = await workspace_for(db_session, test_user, "interleaved")
    now = datetime.now(timezone.utc)
    roots = []
    for index in range(205):
        root = AgentSession(
            id=uuid.UUID(int=index + 1),
            workspace_id=(test_workspace, second)[index % 2].id,
            owner_id=test_user.id,
            installation_id=laptop.id,
            harness="claude_code",
            native_session_id=f"root-{index}",
            title=f"Root {index}",
            started_at=now - timedelta(minutes=index // 4),
            last_event_at=now - timedelta(seconds=index // 3),
            activity_event_count=1,
        )
        db_session.add(root)
        roots.append(root)
    await db_session.flush()
    child = await add_session(
        db_session,
        laptop,
        test_workspace,
        started=MINUTE,
        parent_native_session_id=roots[0].native_session_id,
        parent_session_id=roots[0].id,
    )
    orphan = await add_session(
        db_session,
        laptop,
        test_workspace,
        started=MINUTE,
        parent_native_session_id="parent-not-captured-yet",
    )
    control = await page(
        client, "/api/workspaces/default/sessions", root_only=True, limit=100
    )
    assert str(child.id) not in ids(control["items"])
    assert str(orphan.id) not in ids(control["items"])
    observed = []
    cursor = None
    cursors = set()
    while True:
        params = {"limit": 40, "sort": sort}
        if cursor:
            params["cursor"] = cursor
        result = await page(client, **params)
        observed.extend(result["items"])
        cursor = result["next_cursor"]
        if not cursor:
            break
        assert cursor not in cursors
        cursors.add(cursor)
        assert len(cursors) <= 6
    key = "last_event_at" if sort == "recent" else "started_at"
    expected = sorted(roots, key=lambda row: (getattr(row, key), row.id), reverse=True)
    assert ids(observed) == [str(row.id) for row in expected]
    assert len(set(ids(observed))) == 205
    assert (
        next(row for row in observed if row["id"] == str(roots[0].id))["child_count"]
        == 1
    )
    assert str(orphan.id) in ids((await page(client, root_only=False))["items"])


async def test_membership_is_rechecked_between_cursor_pages(
    client, db_session, test_user, test_workspace
):
    laptop = await add_installation(db_session, test_user)
    lost = await workspace_for(db_session, test_user, "lost-after-page-one")
    first = await add_session(db_session, laptop, test_workspace, started=HOUR)
    await add_session(db_session, laptop, lost, started=HOUR, last=MINUTE)
    retained = await add_session(
        db_session, laptop, test_workspace, started=HOUR, last=2 * MINUTE
    )
    assert (
        len((await page(client, f"/api/workspaces/{lost.slug}/sessions"))["items"]) == 1
    )
    result = await page(client, limit=1)
    assert ids(result["items"]) == [str(first.id)]
    await db_session.execute(
        delete(WorkspaceMember).where(
            WorkspaceMember.workspace_id == lost.id,
            WorkspaceMember.user_id == test_user.id,
        )
    )
    result = await page(client, limit=1, cursor=result["next_cursor"])
    assert ids(result["items"]) == [str(retained.id)]
    assert result["next_cursor"] is None
    assert all(
        row["workspace_id"] != str(lost.id)
        for row in (await page(client, OVERVIEW))["active"]
    )


async def test_cursor_is_bound_to_owner_and_all_effective_filters(
    client, db_session, test_user, second_user, test_workspace
):
    laptop = await add_installation(db_session, test_user)
    for index in range(3):
        await add_session(
            db_session,
            laptop,
            test_workspace,
            started=HOUR,
            last=index * MINUTE,
            title="needle",
        )
    result = await page(client, limit=1)
    cursor = result["next_cursor"]
    assert cursor
    changes = (
        {"sort": "started"},
        {"workspace_id": str(test_workspace.id)},
        {"q": "needle"},
        {"harness": "claude_code"},
        {"state": "active"},
        {"root_only": False},
        {"linked_only": True},
    )
    for change in changes:
        response = await client.get(SESSIONS, params={"cursor": cursor, **change})
        assert response.status_code == 422, (change, response.text)
        assert response.headers["cache-control"] == "no-store"
    async with as_user(db_session, second_user) as other:
        response = await other.get(SESSIONS, params={"cursor": cursor})
    assert response.status_code == 422
    assert cursor not in response.text


async def test_cursor_keeps_its_evaluation_clock_when_capture_becomes_idle(
    client, db_session, test_user, test_workspace, monkeypatch
):
    now = datetime.now(timezone.utc)
    clock = {"now": now}

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock["now"] if tz else clock["now"].replace(tzinfo=None)

    laptop = await add_installation(db_session, test_user, last_seen_at=now)
    sessions = [
        await add_session(db_session, laptop, test_workspace, started=HOUR)
        for _ in range(2)
    ]
    for index, session in enumerate(sessions):
        session.last_event_at = now - timedelta(minutes=14, seconds=50 + index)
    await db_session.flush()
    # Existing workspace reads are a positive control for the real derived-state seam.
    monkeypatch.setattr("app.services.agent_session.datetime", Clock)
    monkeypatch.setattr("app.utils.datetime", Clock)
    control = await page(client, "/api/workspaces/default/sessions", state="active")
    assert ids(control["items"]) == [str(row.id) for row in sessions]
    first = await page(client, state="active", limit=1)
    assert ids(first["items"]) == [str(sessions[0].id)]
    assert first["next_cursor"]

    clock["now"] += timedelta(seconds=20)
    assert (await page(client, "/api/workspaces/default/sessions", state="active"))[
        "items"
    ] == []
    assert (await page(client, state="active"))["items"] == []
    continued = await page(client, state="active", limit=1, cursor=first["next_cursor"])
    assert ids(continued["items"]) == [str(sessions[1].id)]
    assert continued["items"][0]["display_state"] == "active"
    assert continued["next_cursor"] is None
    overview = await page(client, OVERVIEW)
    assert overview["active"] == []
    assert ids(overview["recent"]) == [str(row.id) for row in sessions]
    assert (
        datetime.fromisoformat(overview["generated_at"].replace("Z", "+00:00"))
        == clock["now"]
    )


async def test_global_filters_apply_before_limit_and_title_search_is_literal(
    client, db_session, test_user, test_workspace
):
    other = await workspace_for(db_session, test_user, "filter-target")
    laptop = await add_installation(db_session, test_user)
    paused = await add_installation(db_session, test_user, paused=True)
    for index in range(8):
        await add_session(
            db_session,
            laptop,
            test_workspace,
            started=HOUR,
            title="ordinary",
            last=index * MINUTE,
        )
    match = await add_session(
        db_session,
        paused,
        other,
        started=2 * HOUR,
        last=10 * MINUTE,
        title="Literal 100%_done",
        harness="codex_cli",
    )
    control = await page(client, f"/api/workspaces/{other.slug}/sessions", q="%_")
    assert ids(control["items"]) == [str(match.id)]
    result = await page(
        client,
        workspace_id=str(other.id),
        q="%_",
        harness="codex_cli",
        state="paused",
        limit=1,
    )
    assert ids(result["items"]) == [str(match.id)]
    assert result["next_cursor"] is None


async def test_related_work_resolves_actual_workspace_and_hides_revoked_or_deleted_targets(
    client, db_session, test_user, test_workspace, test_board
):
    other = await workspace_for(db_session, test_user, "destination")
    board = Board(
        workspace_id=other.id,
        name="Destination board",
        slug="destination",
        created_by=test_user.id,
    )
    db_session.add(board)
    await db_session.flush()
    note = Note(
        workspace_id=other.id,
        board_id=board.id,
        title="Destination note",
        content="private note content is not a label",
        created_by=test_user.id,
    )
    db_session.add(note)
    await db_session.flush()
    laptop = await add_installation(db_session, test_user)
    session = await add_session(
        db_session, laptop, test_workspace, started=HOUR, board_id=test_board.id
    )
    link = await add_link(
        db_session, session, note, entity_type="note", correlated=True
    )
    link.workspace_id = other.id
    await db_session.flush()
    control = await page(client, "/api/workspaces/default/sessions", linked_only=True)
    assert control["items"][0]["link_count"] == 1

    row = (await page(client))["items"][0]
    assert row["workspace_id"] == str(test_workspace.id)
    assert row["board_id"] == str(test_board.id)
    assert row["board_name"] == test_board.name
    preview = row["link_preview"][0]
    assert preview["entity_id"] == str(note.id)
    assert preview["workspace_id"] == str(other.id)
    assert preview["workspace_slug"] == other.slug
    assert preview["workspace_name"] == other.name
    assert preview["board_id"] == str(board.id)
    assert preview["board_name"] == board.name
    assert preview["title"] == note.title
    assert preview["relation"] == "changed"
    assert preview["provenance"] == "correlated"

    await db_session.execute(
        delete(WorkspaceMember).where(
            WorkspaceMember.workspace_id == other.id,
            WorkspaceMember.user_id == test_user.id,
        )
    )
    row = (await page(client))["items"][0]
    assert row["link_count"] == 0 and row["link_preview"] == []
    assert (await page(client, linked_only=True))["items"] == []
    db_session.add(
        WorkspaceMember(
            workspace_id=other.id, user_id=test_user.id, role=WorkspaceRole.owner
        )
    )
    await db_session.flush()
    await db_session.delete(note)
    await db_session.flush()
    assert (await page(client))["items"][0]["link_count"] == 0


async def test_deleted_board_leaves_honest_workspace_only_session(
    client, db_session, test_user, test_workspace, test_board
):
    laptop = await add_installation(db_session, test_user)
    session = await add_session(
        db_session, laptop, test_workspace, started=HOUR, board_id=test_board.id
    )
    await db_session.delete(test_board)
    await db_session.flush()
    await db_session.refresh(session)
    control = await page(client, "/api/workspaces/default/sessions")
    assert control["items"][0]["board_id"] is None
    row = (await page(client))["items"][0]
    assert row["id"] == str(session.id)
    assert row["board_id"] is None
    assert row["board_name"] is None
    assert row["workspace_slug"] == test_workspace.slug


async def test_moved_related_note_uses_current_destination_and_preview_stays_bounded(
    client, db_session, test_user, test_workspace, test_board
):
    destination = await workspace_for(db_session, test_user, "moved-destination")
    laptop = await add_installation(db_session, test_user)
    session = await add_session(db_session, laptop, test_workspace, started=HOUR)
    notes = []
    for index in range(3):
        note = Note(
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            title=f"Related {index}",
            content="Private body",
            created_by=test_user.id,
        )
        db_session.add(note)
        await db_session.flush()
        await add_link(
            db_session, session, note, entity_type="note", last_seen=index * MINUTE
        )
        notes.append(note)
    await add_link(
        db_session, session, notes[0], entity_type="note", relation="consulted"
    )
    control = (await page(client, "/api/workspaces/default/sessions"))["items"][0]
    assert control["link_count"] == 3 and len(control["link_preview"]) == 2
    notes[0].workspace_id = destination.id
    notes[0].board_id = None
    await db_session.flush()
    row = (await page(client))["items"][0]
    assert row["link_count"] == 3
    assert len(row["link_preview"]) == 2
    moved = next(
        preview
        for preview in row["link_preview"]
        if preview["entity_id"] == str(notes[0].id)
    )
    assert moved["workspace_id"] == str(destination.id)
    assert moved["workspace_slug"] == destination.slug
    assert moved["board_id"] is None
    assert moved["board_name"] is None


async def test_overview_more_flags_count_roots_in_distinct_capture_groups(
    client, db_session, test_user, test_workspace
):
    laptop = await add_installation(db_session, test_user)
    roots = []
    for index in range(7):
        roots.append(
            await add_session(
                db_session, laptop, test_workspace, started=HOUR, last=index * MINUTE
            )
        )
    await add_session(
        db_session,
        laptop,
        test_workspace,
        started=MINUTE,
        parent_native_session_id=roots[0].native_session_id,
        parent_session_id=roots[0].id,
    )
    overview = await page(client, OVERVIEW)
    assert ids(overview["active"]) == [str(row.id) for row in roots[:6]]
    assert overview["active_more"] is True
    assert overview["recent"] == [] and overview["recent_more"] is False
    assert overview["active"][0]["child_count"] == 1


@pytest.mark.parametrize(
    "credential", ["personal", "agent", "installation", "companion"]
)
async def test_private_global_endpoints_accept_only_human_owner_credentials(
    db_session, test_user, test_workspace, credential
):
    laptop = await add_installation(db_session, test_user)
    session = await add_session(db_session, laptop, test_workspace, started=HOUR)
    raw = "vlr_" + secrets.token_urlsafe(32)
    key = ApiKey(
        user_id=test_user.id,
        name="Synthetic key",
        key_hash=hashlib.sha256(raw.encode()).hexdigest(),
        key_prefix=raw[:8],
        last_used_at=datetime.now(timezone.utc),
        installation_id=laptop.id if credential == "installation" else None,
    )
    db_session.add(key)
    await db_session.flush()
    if credential == "agent":
        db_session.add(
            Agent(
                name="Configured role",
                agent_type=AgentType.coding,
                created_by_id=test_user.id,
                api_key_id=key.id,
                allowed_workspaces=[str(test_workspace.id)],
            )
        )
        await db_session.flush()
    if credential == "companion":
        raw = "bpc_" + secrets.token_urlsafe(32)
        laptop.token_hash = hashlib.sha256(raw.encode()).hexdigest()
        await db_session.flush()
    app = create_app()

    async def database():
        yield db_session

    app.dependency_overrides[get_db] = database
    async with AsyncClient(
        transport=ASGITransport(app), base_url="http://test"
    ) as real_auth:
        control = await real_auth.get(
            "/api/workspaces/default/sessions",
            headers={"X-User-Email": test_user.email},
        )
        assert control.status_code == 200
        assert ids(control.json()["items"]) == [str(session.id)]
        for path in (SESSIONS, OVERVIEW):
            response = await real_auth.get(
                path, headers={"Authorization": f"Bearer {raw}"}
            )
            assert response.status_code == (200 if credential == "personal" else 403)
            assert response.headers["cache-control"] == "no-store"
            if credential != "personal":
                assert str(session.id) not in response.text


async def test_default_page_is_40_and_limits_are_validated_privately(
    client, db_session, test_user, test_workspace
):
    laptop = await add_installation(db_session, test_user)
    for index in range(41):
        await add_session(
            db_session,
            laptop,
            test_workspace,
            started=HOUR,
            last=timedelta(seconds=index),
        )
    result = await page(client)
    assert len(result["items"]) == 40 and result["next_cursor"]
    for params in ({"limit": 101}, {"limit": 0}, {"cursor": "private-invalid-cursor"}):
        response = await client.get(SESSIONS, params=params)
        assert response.status_code == 422
        assert response.headers["cache-control"] == "no-store"
        assert "private-invalid-cursor" not in response.text


@pytest.mark.parametrize("invalid_id", [{"private": "cursor"}, ["private-cursor"], 42])
async def test_malformed_cursor_identity_is_a_private_validation_error(
    client, db_session, test_user, test_workspace, invalid_id
):
    laptop = await add_installation(db_session, test_user)
    for index in range(2):
        await add_session(
            db_session, laptop, test_workspace, started=HOUR, last=index * MINUTE
        )
    cursor = (await page(client, limit=1))["next_cursor"]
    decoded = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    decoded[-1] = invalid_id
    malformed = base64.urlsafe_b64encode(json.dumps(decoded).encode()).decode()
    response = await client.get(SESSIONS, params={"cursor": malformed})
    assert response.status_code == 422
    assert response.headers["cache-control"] == "no-store"
    assert malformed not in response.text


@pytest.mark.slow
def test_owner_metadata_has_its_own_public_openapi_projection():
    schema = create_app().openapi()
    for path in (SESSIONS, OVERVIEW):
        assert path in schema["paths"]
        response = schema["paths"][path]["get"]["responses"]["200"]["content"][
            "application/json"
        ]["schema"]
        pending = [response]
        seen = set()
        while pending:
            current = pending.pop()
            if isinstance(current, list):
                pending.extend(current)
            elif isinstance(current, dict):
                reference = current.get("$ref")
                if reference and reference not in seen:
                    seen.add(reference)
                    pending.append(
                        schema["components"]["schemas"][reference.rsplit("/", 1)[1]]
                    )
                assert not {
                    "native_session_id",
                    "installation_id",
                    "cwd",
                    "inline_text",
                    "preview",
                }.intersection(current.get("properties", {}))
                pending.extend(
                    value
                    for value in current.values()
                    if isinstance(value, (dict, list))
                )


@pytest.mark.slow
@pytest.mark.parametrize("path", [SESSIONS, OVERVIEW])
async def test_disabled_owner_routes_are_indistinguishable_from_absent_routes(
    monkeypatch, path
):
    monkeypatch.setattr(settings, "COMPANION_ENABLED", False)
    app = create_app()
    assert path not in app.openapi()["paths"]
    async with AsyncClient(
        transport=ASGITransport(app), base_url="http://test"
    ) as anonymous:
        for method in ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"):
            for slash in ("", "/"):
                observed = await anonymous.request(
                    method,
                    path + slash,
                    headers={"Authorization": "Bearer bpc_not-a-human"},
                )
                absent = await anonymous.request(
                    method,
                    "/api/no-such-route" + slash,
                    headers={"Authorization": "Bearer bpc_not-a-human"},
                )
                assert (observed.status_code, observed.content) == (
                    absent.status_code,
                    absent.content,
                )
                volatile = {"x-ratelimit-remaining"}
                assert {
                    k: v for k, v in observed.headers.items() if k not in volatile
                } == {k: v for k, v in absent.headers.items() if k not in volatile}


async def seed_volume(db, owner, workspaces, active_device, paused_device, now):
    rows = []
    notes_by_workspace = {}
    for workspace_index, workspace in enumerate(workspaces):
        notes = [
            Note(
                workspace_id=workspace.id,
                title=f"Synthetic related note {index}",
                content="Private note body is not needed by session discovery",
                created_by=owner.id,
            )
            for index in range(2)
        ]
        db.add_all(notes)
        notes_by_workspace[workspace.id] = notes
        for index in range(40):
            ordinal = workspace_index * 40 + index
            row = AgentSession(
                workspace_id=workspace.id,
                owner_id=owner.id,
                installation_id=(active_device if index % 2 else paused_device).id,
                harness="claude_code",
                native_session_id=uuid.uuid4().hex,
                started_at=now - HOUR,
                last_event_at=now - timedelta(microseconds=ordinal),
                activity_event_count=1,
            )
            rows.append(row)
    db.add_all(rows)
    await db.flush()
    db.add_all(
        [
            SessionWorkLink(
                session_id=row.id,
                workspace_id=row.workspace_id,
                entity_type="note",
                entity_id=note.id,
                relation="changed",
                first_seen_at=now,
                last_seen_at=now,
                invocation_count=1,
                correlated_count=0,
            )
            for row in rows
            for note in notes_by_workspace[row.workspace_id]
        ]
    )
    await db.flush()
    return rows


async def counted_page(client, engine, path):
    statements = []

    def record(_connection, _cursor, statement, *_rest):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    sa_event.listen(engine, "before_cursor_execute", record)
    try:
        result = await page(client, path)
    finally:
        sa_event.remove(engine, "before_cursor_execute", record)
    return result, statements


@pytest.mark.slow
async def test_50_workspace_2000_session_fixture_has_fixed_query_bounds(
    client, db_session, test_user, test_workspace
):
    active = await add_installation(db_session, test_user)
    paused = await add_installation(db_session, test_user, paused=True)
    now = datetime.now(timezone.utc)
    await seed_volume(db_session, test_user, [test_workspace], active, paused, now)
    workspaces = [
        await workspace_for(db_session, test_user, f"volume-{index}")
        for index in range(49)
    ]
    await seed_volume(db_session, test_user, workspaces, active, paused, now - MINUTE)
    control = await page(client, "/api/workspaces/default/sessions")
    assert len(control["items"]) == 40
    control = await page(client, f"/api/workspaces/{workspaces[-1].slug}/sessions")
    assert len(control["items"]) == 40
    engine = db_session.get_bind()
    large_list, large_list_queries = await counted_page(client, engine, SESSIONS)
    large_overview, large_overview_queries = await counted_page(
        client, engine, OVERVIEW
    )
    await db_session.execute(
        delete(WorkspaceMember).where(
            WorkspaceMember.user_id == test_user.id,
            WorkspaceMember.workspace_id.in_(
                [workspace.id for workspace in workspaces]
            ),
        )
    )
    small_list, list_queries = await counted_page(client, engine, SESSIONS)
    small_overview, overview_queries = await counted_page(client, engine, OVERVIEW)
    assert len(small_list["items"]) == len(large_list["items"]) == 40
    assert large_list["next_cursor"]
    for group in ("active", "recent"):
        assert len(small_overview[group]) == len(large_overview[group]) == 6
        assert large_overview[group + "_more"] is True
    assert len(large_list_queries) == len(list_queries) <= 12
    assert len(large_overview_queries) == len(overview_queries) <= 24
    assert not any(
        "agent_session_contents" in query or "agent_session_events" in query
        for query in large_list_queries + large_overview_queries
    )
