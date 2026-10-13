# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import copy
import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select

from app.core.auth import get_current_user
from app.database import get_db
from app.main import create_app
from app.models.activity import Activity
from app.models.agent_session import SessionWorkLink
from app.models.workspace import WorkspaceMember, WorkspaceRole

ME = "/api/me/companion/installations"
SESSIONS = "/api/workspaces/default/sessions"
FIXTURE_EVENTS = [
    event
    for record in json.loads(
        (
            Path(__file__).parent / "fixtures/session_capture/beacon_hooks.json"
        ).read_text()
    )
    for event in record["beacon_events"]
]
FIXTURE_START = datetime(2026, 9, 24, 2, 21, 28, tzinfo=timezone.utc)
TOOL_CALL = "toolu_evidence_1"


def as_user(db_session, user):
    app = create_app()

    async def database():
        yield db_session

    async def current_user():
        return user

    app.dependency_overrides[get_db] = database
    app.dependency_overrides[get_current_user] = current_user
    return AsyncClient(transport=ASGITransport(app), base_url="http://test")


@pytest.fixture
async def device_client(db_session):
    app = create_app()

    async def database():
        yield db_session

    app.dependency_overrides[get_db] = database
    async with AsyncClient(
        transport=ASGITransport(app), base_url="http://test"
    ) as client:
        yield client


async def enroll(
    client, workspace, board=None, root="/synthetic/project", content_level="standard"
):
    """A device with one mapping. The level is explicit: these tests were
    written against standard, and new mappings now default to rich."""
    installation = (
        await client.post(
            ME,
            json={
                "installation_id": str(uuid.uuid4()),
                "name": "Synthetic laptop",
                "platform": "linux-amd64",
            },
        )
    ).json()
    mapping = (
        await client.post(
            f"{ME}/{installation['installation_id']}/mappings",
            json={
                "workspace_id": str(workspace.id),
                "board_id": str(board.id) if board else None,
                "root_path": root,
                "content_level": content_level,
            },
        )
    ).json()
    return installation["device_token"], mapping["id"]


def record(events, mapping_id, *, harness="claude_code", session=None):
    events = copy.deepcopy(events)
    native_session = session or "sc01-synthetic-session"
    for event in events:
        event.setdefault("session", {})["id"] = native_session
    return {
        "capture_id": uuid.uuid4().hex,
        "mapping_id": mapping_id,
        "harness": harness,
        "collection_method": "hook",
        "native_session_id": native_session,
        "captured_at": "2026-09-24T02:21:30Z",
        "beacon": {"commit": "b" * 40, "schema_version": "1.0"},
        "events": events,
    }


async def upload(device_client, token, records):
    response = await device_client.post(
        "/api/companion/ingest",
        json={"records": records},
        headers={"Authorization": "Bearer " + token},
    )
    assert response.status_code == 200, response.text
    assert response.json()["rejected"] == [], response.text
    return response


def outcome(invocation_id=None, **values):
    return {
        "id": str(invocation_id or uuid.uuid4()),
        "tool_name": "get_card",
        "workspace_slug": "default",
        "status": "completed",
        "started_at": (FIXTURE_START + timedelta(seconds=1)).isoformat(),
        "completed_at": (FIXTURE_START + timedelta(seconds=2)).isoformat(),
        "duration_seconds": 1,
        "harness": "claude_code",
        "native_call_id": TOOL_CALL,
        **values,
    }


async def work_under_invocation(client, board, card, invocation_id):
    headers = {"X-Backplane-Invocation-ID": str(invocation_id)}
    base = f"/api/workspaces/default/boards/{board.id}/cards/{card.id}"
    assert (await client.get(base, headers=headers)).status_code == 200
    assert (
        await client.patch(base, json={"title": "Changed"}, headers=headers)
    ).status_code == 200


async def links(client, session_id):
    response = await client.get(f"{SESSIONS}/{session_id}/links")
    assert response.status_code == 200
    return {
        (item["entity_type"], item["relation"]): item
        for item in response.json()["items"]
    }


async def session_id(client):
    return (await client.get(SESSIONS)).json()["items"][0]["id"]


# --- read APIs ---------------------------------------------------------------


async def test_list_get_and_events_are_private_paginated_and_no_store(
    client, device_client, test_workspace, test_board
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(device_client, token, [record(FIXTURE_EVENTS, mapping_id)])
    codex_start = copy.deepcopy(FIXTURE_EVENTS[0])
    codex_start["event"]["id"] = "codex-start"
    # Recent enough to still be open: a day of silence reads as ended.
    codex_start["timestamp"] = datetime.now(timezone.utc).isoformat()
    await upload(
        device_client,
        token,
        [record([codex_start], mapping_id, harness="codex_cli", session="codex-1")],
    )

    listed = await client.get(SESSIONS)
    assert listed.status_code == 200
    assert listed.headers["cache-control"] == "no-store"
    items = listed.json()["items"]
    assert [item["harness"] for item in items] == ["codex_cli", "claude_code"]
    assert items[1]["harness_display_name"] == "Claude Code"
    assert items[1]["status"] == "ended"
    assert items[1]["cost_usd"] is None
    assert items[1]["board_id"] == str(test_board.id)

    first_page = (await client.get(SESSIONS + "?limit=1")).json()
    assert len(first_page["items"]) == 1 and first_page["next_cursor"]
    second_page = (
        await client.get(SESSIONS + "?limit=1&cursor=" + first_page["next_cursor"])
    ).json()
    assert [item["harness"] for item in second_page["items"]] == ["claude_code"]
    assert second_page["next_cursor"] is None

    assert [
        item["harness"]
        for item in (await client.get(SESSIONS + "?harness=claude_code")).json()[
            "items"
        ]
    ] == ["claude_code"]
    assert (await client.get(SESSIONS + "?status=active")).json()["items"][0][
        "harness"
    ] == "codex_cli"
    assert (await client.get(SESSIONS + f"?board_id={uuid.uuid4()}")).json()[
        "items"
    ] == []

    claude_id = items[1]["id"]
    detail = await client.get(f"{SESSIONS}/{claude_id}")
    assert detail.status_code == 200 and detail.headers["cache-control"] == "no-store"
    assert detail.json()["event_count"] == 7

    events = (await client.get(f"{SESSIONS}/{claude_id}/events?limit=3")).json()
    assert [item["action"] for item in events["items"]] == [
        "session.started",
        "prompt.submitted",
        "tool.invoked",
    ]
    rest = (
        await client.get(
            f"{SESSIONS}/{claude_id}/events?cursor={events['next_cursor']}"
        )
    ).json()
    assert len(rest["items"]) == 4 and rest["next_cursor"] is None
    assert rest["items"][0]["data"]["event"]["action"] == "mcp.tool_invoked"
    tools = (await client.get(f"{SESSIONS}/{claude_id}/events?category=tool")).json()
    assert {item["action"] for item in tools["items"]} == {
        "tool.invoked",
        "tool.failed",
        "tool.completed",
    }
    failed = (
        await client.get(f"{SESSIONS}/{claude_id}/events?action=tool.failed")
    ).json()["items"]
    assert failed[0]["outcome"] == "failed"
    assert failed[0]["native_tool_call_id"] == "toolu_evidence_2"

    assert (await client.get(SESSIONS + "?cursor=garbage")).status_code == 422


async def test_other_members_never_see_your_sessions(
    client, device_client, db_session, test_workspace, test_board, second_user
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(device_client, token, [record(FIXTURE_EVENTS, mapping_id)])
    own_id = await session_id(client)
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=second_user.id,
            role=WorkspaceRole.owner,
        )
    )
    await db_session.flush()
    async with as_user(db_session, second_user) as other:
        assert (await other.get(SESSIONS)).json()["items"] == []
        for path in ["", "/events", "/links"]:
            assert (await other.get(f"{SESSIONS}/{own_id}{path}")).status_code == 404


async def test_agent_keys_and_former_members_cannot_read_sessions(
    client, agent_client, device_client, db_session, test_workspace, test_user
):
    token, mapping_id = await enroll(client, test_workspace)
    await upload(device_client, token, [record(FIXTURE_EVENTS, mapping_id)])
    own_id = await session_id(client)
    assert (await agent_client.get(SESSIONS)).status_code == 403
    assert (await agent_client.get(f"{SESSIONS}/{own_id}")).status_code == 403
    await db_session.execute(
        delete(WorkspaceMember).where(WorkspaceMember.user_id == test_user.id)
    )
    await db_session.flush()
    assert (await client.get(SESSIONS)).status_code == 403


async def test_read_sessions_installation_key_allowed(
    client, installation_key_client, device_client, test_workspace
):
    """The companion captures sessions a person drives, and that person reads
    them back through the key the companion handed their agent."""
    token, mapping_id = await enroll(client, test_workspace)
    await upload(device_client, token, [record(FIXTURE_EVENTS, mapping_id)])
    own_id = await session_id(client)
    listed = await installation_key_client.get(SESSIONS)
    assert listed.status_code == 200, listed.text
    assert (await installation_key_client.get(f"{SESSIONS}/{own_id}")).status_code == 200


async def test_read_sessions_plain_user_key_allowed(
    client, plain_key_client, device_client, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    await upload(device_client, token, [record(FIXTURE_EVENTS, mapping_id)])
    own_id = await session_id(client)
    listed = await plain_key_client.get(SESSIONS)
    assert listed.status_code == 200, listed.text
    assert (await plain_key_client.get(f"{SESSIONS}/{own_id}")).status_code == 200


# --- work links --------------------------------------------------------------


@pytest.mark.parametrize("invocation_first", [False, True])
async def test_links_materialize_in_either_arrival_order(
    client,
    device_client,
    db_session,
    test_workspace,
    test_board,
    test_card,
    invocation_first,
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    invocation_id = uuid.uuid4()
    await work_under_invocation(client, test_board, test_card, invocation_id)

    async def record_invocation():
        response = await client.post(
            "/api/me/mcp-invocations", json=outcome(invocation_id)
        )
        assert response.status_code == 200, response.text

    if invocation_first:
        await record_invocation()
        await upload(device_client, token, [record(FIXTURE_EVENTS, mapping_id)])
    else:
        await upload(device_client, token, [record(FIXTURE_EVENTS, mapping_id)])
        await record_invocation()

    found = await links(client, await session_id(client))
    assert set(found) == {("card", "changed"), ("card", "consulted")}
    changed = found[("card", "changed")]
    assert changed["entity_id"] == str(test_card.id)
    assert changed["board_id"] == str(test_board.id)
    assert changed["invocation_count"] == 1

    # Replays on either side never materialize the pair twice.
    await client.post("/api/me/mcp-invocations", json=outcome(invocation_id))
    await upload(device_client, token, [record(FIXTURE_EVENTS[2:4], mapping_id)])
    assert (await links(client, await session_id(client)))[("card", "changed")][
        "invocation_count"
    ] == 1


async def test_second_invocation_on_same_card_counts_once_more(
    client, device_client, test_workspace, test_board, test_card
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(device_client, token, [record(FIXTURE_EVENTS, mapping_id)])
    for call_id in [TOOL_CALL, "toolu_evidence_2"]:
        invocation_id = uuid.uuid4()
        await work_under_invocation(client, test_board, test_card, invocation_id)
        await client.post(
            "/api/me/mcp-invocations",
            json=outcome(invocation_id, native_call_id=call_id),
        )
    found = await links(client, await session_id(client))
    assert found[("card", "changed")]["invocation_count"] == 2


@pytest.mark.parametrize(
    "mismatch",
    [
        {"harness": "codex_cli"},
        {"native_call_id": "toolu_unrelated"},
        {
            "started_at": "2026-09-24T03:00:00+00:00",
            "completed_at": "2026-09-24T03:00:01+00:00",
        },
        {"harness": None},
    ],
)
async def test_unmatched_invocations_create_no_links(
    client, device_client, test_workspace, test_board, test_card, mismatch
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(device_client, token, [record(FIXTURE_EVENTS, mapping_id)])
    invocation_id = uuid.uuid4()
    await work_under_invocation(client, test_board, test_card, invocation_id)
    response = await client.post(
        "/api/me/mcp-invocations", json=outcome(invocation_id, **mismatch)
    )
    assert response.status_code == 200, response.text
    assert await links(client, await session_id(client)) == {}


async def test_agent_and_other_owner_invocations_never_link(
    client,
    agent_client,
    device_client,
    db_session,
    test_workspace,
    test_board,
    test_card,
    second_user,
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(device_client, token, [record(FIXTURE_EVENTS, mapping_id)])
    agent_invocation = uuid.uuid4()
    await work_under_invocation(agent_client, test_board, test_card, agent_invocation)
    assert (
        await agent_client.post(
            "/api/me/mcp-invocations", json=outcome(agent_invocation)
        )
    ).status_code == 200

    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=second_user.id,
            role=WorkspaceRole.owner,
        )
    )
    await db_session.flush()
    other_invocation = uuid.uuid4()
    async with as_user(db_session, second_user) as other:
        await work_under_invocation(other, test_board, test_card, other_invocation)
        assert (
            await other.post("/api/me/mcp-invocations", json=outcome(other_invocation))
        ).status_code == 200
    assert await links(client, await session_id(client)) == {}


async def test_links_are_rechecked_against_live_entities_at_read_time(
    client, device_client, db_session, test_workspace, test_board, test_card
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(device_client, token, [record(FIXTURE_EVENTS, mapping_id)])
    invocation_id = uuid.uuid4()
    await work_under_invocation(client, test_board, test_card, invocation_id)
    await client.post("/api/me/mcp-invocations", json=outcome(invocation_id))
    own_id = await session_id(client)
    assert len(await links(client, own_id)) == 2
    await db_session.delete(test_card)
    await db_session.flush()
    assert await links(client, own_id) == {}
    assert await db_session.scalar(select(SessionWorkLink.id)) is not None


async def test_card_sessions_are_owner_private(
    client,
    device_client,
    db_session,
    test_workspace,
    test_board,
    test_card,
    second_user,
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(device_client, token, [record(FIXTURE_EVENTS, mapping_id)])
    invocation_id = uuid.uuid4()
    await work_under_invocation(client, test_board, test_card, invocation_id)
    await client.post("/api/me/mcp-invocations", json=outcome(invocation_id))
    path = (
        f"/api/workspaces/default/boards/{test_board.id}/cards/{test_card.id}/sessions"
    )

    own = await client.get(path)
    assert own.status_code == 200 and own.headers["cache-control"] == "no-store"
    [item] = own.json()["items"]
    assert item["session"]["harness"] == "claude_code"
    assert sorted(item["relations"]) == ["changed", "consulted"]
    assert item["session"]["event_count"] == 7

    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=second_user.id,
            role=WorkspaceRole.owner,
        )
    )
    await db_session.flush()
    async with as_user(db_session, second_user) as other:
        response = await other.get(path)
        assert response.status_code == 200
        assert response.json()["items"] == []
    assert (
        await client.get(
            f"/api/workspaces/default/boards/{test_board.id}/cards/{uuid.uuid4()}/sessions"
        )
    ).status_code == 404


async def test_consultation_failure_never_breaks_the_read(
    client, test_board, test_card, monkeypatch
):
    from app.repositories.mcp_invocation import MCPInvocationRepository

    async def broken(*_args, **_kwargs):
        raise RuntimeError("consultation store unavailable")

    monkeypatch.setattr(MCPInvocationRepository, "record_consultation", broken)
    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/cards/{test_card.id}",
        headers={"X-Backplane-Invocation-ID": str(uuid.uuid4())},
    )
    assert response.status_code == 200


async def test_note_reads_record_consultations_on_both_routes(
    client, db_session, test_board, test_note
):
    from app.models.mcp_invocation import MCPConsultation

    for path in [
        f"/api/workspaces/default/notes/{test_note.id}",
        f"/api/workspaces/default/boards/{test_board.id}/notes/{test_note.id}",
    ]:
        invocation_id = uuid.uuid4()
        response = await client.get(
            path, headers={"X-Backplane-Invocation-ID": str(invocation_id)}
        )
        assert response.status_code == 200
        consultation = await db_session.scalar(
            select(MCPConsultation).where(
                MCPConsultation.invocation_id == invocation_id
            )
        )
        assert consultation.entity_type == "note"
        assert consultation.entity_id == test_note.id
        assert consultation.principal_key == ""


async def test_activity_carries_invocation_and_principal(
    client, db_session, test_board, test_card
):
    invocation_id = uuid.uuid4()
    await client.patch(
        f"/api/workspaces/default/boards/{test_board.id}/cards/{test_card.id}",
        json={"title": "Renamed"},
        headers={"X-Backplane-Invocation-ID": str(invocation_id)},
    )
    activity = await db_session.scalar(
        select(Activity).where(Activity.mcp_invocation_id == invocation_id)
    )
    assert activity.principal_key == ""


async def _two_machines_sharing_a_call(client, device_client, workspace, board):
    tokens = []
    for root in ["/machine-a/project", "/machine-b/project"]:
        token, mapping_id = await enroll(client, workspace, board, root=root)
        tokens.append((token, mapping_id))
    return tokens


async def _all_links(db_session):
    return list(await db_session.scalars(select(SessionWorkLink)))


async def test_invocation_matching_several_sessions_links_none(
    client, device_client, db_session, test_workspace, test_board, test_card, caplog
):
    for token, mapping_id in await _two_machines_sharing_a_call(
        client, device_client, test_workspace, test_board
    ):
        await upload(device_client, token, [record(FIXTURE_EVENTS, mapping_id)])
    invocation_id = uuid.uuid4()
    await work_under_invocation(client, test_board, test_card, invocation_id)
    response = await client.post("/api/me/mcp-invocations", json=outcome(invocation_id))
    assert response.status_code == 200
    assert await _all_links(db_session) == []
    assert "ambiguous" in caplog.text


async def test_later_second_candidate_retracts_an_earlier_link(
    client, device_client, db_session, test_workspace, test_board, test_card
):
    (token_a, mapping_a), (token_b, mapping_b) = await _two_machines_sharing_a_call(
        client, device_client, test_workspace, test_board
    )
    invocation_id = uuid.uuid4()
    await work_under_invocation(client, test_board, test_card, invocation_id)
    await client.post("/api/me/mcp-invocations", json=outcome(invocation_id))
    await upload(device_client, token_a, [record(FIXTURE_EVENTS, mapping_a)])
    assert len(await _all_links(db_session)) == 2
    await upload(device_client, token_b, [record(FIXTURE_EVENTS, mapping_b)])
    db_session.expire_all()
    assert await _all_links(db_session) == []


# --- harness families ----------------------------------------------------------


@pytest.mark.parametrize("invocation_first", [False, True])
async def test_codex_desktop_session_links_a_codex_cli_invocation(
    client, device_client, test_workspace, test_board, test_card, invocation_first
):
    # Every Codex host introduces itself to MCP servers the same way, so the
    # MCP server reports codex_cli even when Beacon saw Codex Desktop.
    token, mapping_id = await enroll(client, test_workspace, test_board)
    invocation_id = uuid.uuid4()
    await work_under_invocation(client, test_board, test_card, invocation_id)

    async def record_invocation():
        response = await client.post(
            "/api/me/mcp-invocations",
            json=outcome(invocation_id, harness="codex_cli"),
        )
        assert response.status_code == 200, response.text

    desktop = record(FIXTURE_EVENTS, mapping_id, harness="codex_desktop")
    if invocation_first:
        await record_invocation()
        await upload(device_client, token, [desktop])
    else:
        await upload(device_client, token, [desktop])
        await record_invocation()
    assert set(await links(client, await session_id(client))) == {
        ("card", "changed"),
        ("card", "consulted"),
    }


async def test_claude_invocation_never_links_a_codex_session(
    client, device_client, test_workspace, test_board, test_card
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(
        device_client,
        token,
        [record(FIXTURE_EVENTS, mapping_id, harness="codex_desktop")],
    )
    invocation_id = uuid.uuid4()
    await work_under_invocation(client, test_board, test_card, invocation_id)
    await client.post(
        "/api/me/mcp-invocations", json=outcome(invocation_id, harness="claude_code")
    )
    assert await links(client, await session_id(client)) == {}


async def test_ambiguity_inside_one_harness_family_links_none(
    client, device_client, db_session, test_workspace, test_board, test_card
):
    (token_a, mapping_a), (token_b, mapping_b) = await _two_machines_sharing_a_call(
        client, device_client, test_workspace, test_board
    )
    await upload(
        device_client, token_a, [record(FIXTURE_EVENTS, mapping_a, harness="codex_cli")]
    )
    await upload(
        device_client,
        token_b,
        [record(FIXTURE_EVENTS, mapping_b, harness="codex_desktop")],
    )
    invocation_id = uuid.uuid4()
    await work_under_invocation(client, test_board, test_card, invocation_id)
    await client.post(
        "/api/me/mcp-invocations", json=outcome(invocation_id, harness="codex_cli")
    )
    assert await _all_links(db_session) == []
