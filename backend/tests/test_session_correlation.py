# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Fuzzy linking of Pi MCP calls that carry no native call id."""

import asyncio
import copy
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import delete, select

from app.core.call_correlation import CORRELATION_WINDOW, arguments_fingerprint
from app.core.event_bus import event_bus
from app.core.harness import native_call_key
from app.models.agent_session import (
    AgentSessionEvent,
    AgentSessionInvocation,
    SessionWorkLink,
)
from app.models.notes.note import Note
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.repositories.session_work_link import SessionWorkLinkRepository
from app.services.session_work_link import CORRELATION_LOCK
from tests.test_agent_sessions import (
    ME,
    as_user,
    device_client as device_client_fixture,
    links,
    session_id,
    upload,
    work_under_invocation,
)

device_client = device_client_fixture

CALL_TIME = datetime(2026, 9, 24, 10, 0, 0, tzinfo=timezone.utc)
ARGS = {"workspace_slug": "default", "card_id": "c-1", "limit": 3}
PI_CALL = "toolu_pi_1"
# The companion's metadata level replaces every string with this digest
# (companion/internal/privacy Digest, checked against the Go output).
DIGESTED_ARGS = {
    "workspace_slug": "[omitted 7 bytes sha256:37a8eec1ce19687d]",
    "card_id": "[omitted 3 bytes sha256:a6f7ef47ee8dc84a]",
    "limit": 3,
}


async def enroll(client, workspace, board, *, content_level=None, root="/pi/project"):
    installation = (
        await client.post(
            ME,
            json={
                "installation_id": str(uuid.uuid4()),
                "name": "Pi laptop",
                "platform": "darwin-arm64",
            },
        )
    ).json()
    mapping = (
        await client.post(
            f"{ME}/{installation['installation_id']}/mappings",
            json={
                "workspace_id": str(workspace.id),
                "board_id": str(board.id),
                "root_path": root,
            },
        )
    ).json()
    if content_level:
        response = await client.patch(
            f"{ME}/{installation['installation_id']}/mappings/{mapping['id']}",
            json={"content_level": content_level},
        )
        assert response.status_code == 200, response.text
    return installation["device_token"], mapping["id"]


def pi_tool_event(
    tool_name, arguments, *, call_id=PI_CALL, action="tool.invoked", session="pi-1"
):
    return {
        "timestamp": (CALL_TIME + timedelta(seconds=1)).isoformat(),
        "schema_version": "1.0",
        "event": {
            "id": str(uuid.uuid4()),
            "action": action,
            "category": "tool",
            "kind": "agent_runtime",
        },
        "harness": {"name": "pi_cli", "collection_method": "plugin"},
        "session": {"id": session},
        "tool": {"name": tool_name},
        "gen_ai": {"tool": {"call": {"id": call_id}}},
        "trace": {"span_id": call_id},
        "raw": {
            "pi": {
                "type": "tool_call",
                "toolName": tool_name,
                "toolCallId": call_id,
                "input": copy.deepcopy(arguments),
                "sessionId": session,
            }
        },
    }


def pi_record(events, mapping_id, *, captured_at=CALL_TIME, session="pi-1"):
    return {
        "capture_id": uuid.uuid4().hex,
        "mapping_id": mapping_id,
        "harness": "pi_cli",
        "collection_method": "plugin",
        "native_session_id": session,
        "captured_at": captured_at.isoformat(),
        "beacon": {"commit": "b" * 40, "schema_version": "1.0"},
        "events": events,
    }


def pi_outcome(invocation_id=None, *, arguments=ARGS, **values):
    return {
        "id": str(invocation_id or uuid.uuid4()),
        "tool_name": "get_card",
        "workspace_slug": "default",
        "status": "completed",
        "started_at": (CALL_TIME + timedelta(milliseconds=300)).isoformat(),
        "completed_at": (CALL_TIME + timedelta(milliseconds=800)).isoformat(),
        "duration_seconds": 0.5,
        "harness": "pi_cli",
        "native_call_id": None,
        "client_name": "pi-mcp-valaris",
        "client_version": "1.0.0",
        "arguments_fingerprint": arguments_fingerprint(arguments),
        **values,
    }


async def record_invocation(client, body):
    response = await client.post("/api/me/mcp-invocations", json=body)
    assert response.status_code == 200, response.text


async def pi_call_with_work(client, board, card, **outcome_values):
    invocation_id = uuid.uuid4()
    await work_under_invocation(client, board, card, invocation_id)
    await record_invocation(client, pi_outcome(invocation_id, **outcome_values))
    return invocation_id


async def all_links(db_session):
    return list(
        await db_session.scalars(
            select(SessionWorkLink).execution_options(populate_existing=True)
        )
    )


@pytest.fixture
def session_refreshes(test_workspace):
    received = []

    async def receive(event):
        received.append(event)

    unsubscribe = event_bus.subscribe(
        receive,
        workspace_id=test_workspace.id,
        event_pattern="agent_session.updated",
    )
    try:
        yield received
    finally:
        unsubscribe()


@pytest.mark.slow
@pytest.mark.parametrize("exact", [False, True])
async def test_late_receipt_refreshes_linked_session_only_after_commit(
    client,
    device_client,
    db_session,
    test_user,
    test_workspace,
    test_board,
    test_card,
    session_refreshes,
    exact,
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(
        device_client,
        token,
        [pi_record([pi_tool_event("valaris_get_card", ARGS)], mapping_id)],
    )
    captured_session_id = await session_id(client)
    invocation_id = uuid.uuid4()
    await work_under_invocation(client, test_board, test_card, invocation_id)
    await db_session.commit()
    await asyncio.sleep(0.01)
    session_refreshes.clear()

    await record_invocation(
        client,
        pi_outcome(
            invocation_id,
            native_call_id=PI_CALL if exact else None,
            arguments_fingerprint=None if exact else arguments_fingerprint(ARGS),
        ),
    )
    found = await links(client, captured_session_id)
    assert set(found) == {("card", "changed"), ("card", "consulted")}
    await asyncio.sleep(0.01)
    assert session_refreshes == [], "Uncommitted relationship was announced"

    await db_session.commit()
    await asyncio.sleep(0.01)
    assert len(session_refreshes) == 1, "Late receipt left the open session stale"
    [refresh] = session_refreshes
    assert refresh.payload["session_id"] == captured_session_id
    assert refresh.payload["owner_id"] == str(test_user.id)
    assert refresh.workspace_id == test_workspace.id
    assert set(refresh.payload) <= {"session_id", "owner_id", "workspace_id", "reason"}


@pytest.mark.slow
@pytest.mark.parametrize("exact", [False, True])
async def test_new_candidate_refreshes_older_session_after_retracting_its_links(
    client,
    device_client,
    db_session,
    test_workspace,
    test_board,
    test_card,
    session_refreshes,
    exact,
):
    token_a, mapping_a = await enroll(client, test_workspace, test_board, root="/a")
    token_b, mapping_b = await enroll(client, test_workspace, test_board, root="/b")
    await pi_call_with_work(
        client,
        test_board,
        test_card,
        native_call_id=PI_CALL if exact else None,
        arguments_fingerprint=None if exact else arguments_fingerprint(ARGS),
    )
    await upload(
        device_client,
        token_a,
        [pi_record([pi_tool_event("valaris_get_card", ARGS)], mapping_a)],
    )
    older_session_id = await session_id(client)
    assert len(await links(client, older_session_id)) == 2
    await db_session.commit()
    await asyncio.sleep(0.01)
    session_refreshes.clear()

    await upload(
        device_client,
        token_b,
        [
            pi_record(
                [
                    pi_tool_event(
                        "valaris_get_card",
                        ARGS,
                        call_id=PI_CALL if exact else "toolu_b",
                    )
                ],
                mapping_b,
            )
        ],
    )
    assert await links(client, older_session_id) == {}
    await db_session.commit()
    await asyncio.sleep(0.01)
    assert older_session_id in {
        event.payload["session_id"] for event in session_refreshes
    }, "Retraction refreshed the new capture but left the older session stale"


@pytest.mark.slow
async def test_competing_receipt_refreshes_retracted_correlated_session(
    client,
    device_client,
    db_session,
    test_workspace,
    test_board,
    test_card,
    session_refreshes,
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(
        device_client,
        token,
        [pi_record([pi_tool_event("valaris_get_card", ARGS)], mapping_id)],
    )
    captured_session_id = await session_id(client)
    await pi_call_with_work(client, test_board, test_card)
    assert len(await links(client, captured_session_id)) == 2
    await db_session.commit()
    await asyncio.sleep(0.01)
    session_refreshes.clear()

    await pi_call_with_work(client, test_board, test_card)
    assert await links(client, captured_session_id) == {}
    await db_session.commit()
    await asyncio.sleep(0.01)
    assert [event.payload["session_id"] for event in session_refreshes] == [
        captured_session_id
    ]


@pytest.mark.slow
async def test_exact_replacement_refreshes_once_and_duplicate_retry_stays_silent(
    client,
    device_client,
    db_session,
    test_workspace,
    test_board,
    test_card,
    session_refreshes,
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(
        device_client,
        token,
        [pi_record([pi_tool_event("valaris_get_card", ARGS)], mapping_id)],
    )
    captured_session_id = await session_id(client)
    await pi_call_with_work(client, test_board, test_card)
    exact_id = uuid.uuid4()
    await work_under_invocation(client, test_board, test_card, exact_id)
    await db_session.commit()
    await asyncio.sleep(0.01)
    session_refreshes.clear()

    exact = pi_outcome(exact_id, native_call_id=PI_CALL, arguments_fingerprint=None)
    await record_invocation(client, exact)
    await db_session.commit()
    await asyncio.sleep(0.01)
    found = await links(client, captured_session_id)
    assert {item["provenance"] for item in found.values()} == {"exact"}
    assert {item["invocation_count"] for item in found.values()} == {1}
    assert len(session_refreshes) == 1, "Exact replacement must coalesce its retraction"
    assert session_refreshes[0].payload["session_id"] == captured_session_id

    await record_invocation(client, exact)
    await db_session.commit()
    await asyncio.sleep(0.01)
    assert len(session_refreshes) == 1, "A no-op receipt replayed the refresh"


@pytest.mark.slow
@pytest.mark.parametrize("target_visible", [False, True])
async def test_cross_workspace_target_refresh_never_exposes_private_session(
    client,
    device_client,
    db_session,
    test_user,
    test_workspace,
    test_board,
    target_visible,
):
    target = Workspace(
        name="Synthetic target workspace",
        slug="target-evidence",
        created_by=test_user.id,
    )
    db_session.add(target)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=target.id, user_id=test_user.id, role=WorkspaceRole.owner
        )
    )
    note = Note(workspace_id=target.id, created_by=test_user.id, title="Private note")
    db_session.add(note)
    await db_session.flush()
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(
        device_client,
        token,
        [pi_record([pi_tool_event("valaris_get_card", ARGS)], mapping_id)],
    )
    captured_session_id = await session_id(client)
    invocation_id = uuid.uuid4()
    response = await client.get(
        f"/api/workspaces/{target.slug}/notes/{note.id}",
        headers={"X-Backplane-Invocation-ID": str(invocation_id)},
    )
    assert response.status_code == 200, response.text
    if not target_visible:
        await db_session.execute(
            delete(WorkspaceMember).where(
                WorkspaceMember.workspace_id == target.id,
                WorkspaceMember.user_id == test_user.id,
            )
        )
    await db_session.commit()
    await asyncio.sleep(0.01)
    target_events = []

    async def receive(event):
        target_events.append(event)

    unsubscribe = event_bus.subscribe(
        receive, workspace_id=target.id, event_pattern="agent_session.updated"
    )
    try:
        await record_invocation(
            client,
            pi_outcome(
                invocation_id, native_call_id=PI_CALL, arguments_fingerprint=None
            ),
        )
        await db_session.commit()
        await asyncio.sleep(0.01)
        found = await links(client, captured_session_id)
        if not target_visible:
            assert found == {}
            assert target_events == [], "Access loss still announced a target refresh"
            return
        assert set(found) == {("note", "consulted")}
        assert (
            len(target_events) == 1
        ), "Linked target in another workspace stayed stale"
        [refresh] = target_events
        assert refresh.payload == {
            "owner_id": str(test_user.id),
            "workspace_id": str(target.id),
            "reason": "links",
        }
        assert refresh.workspace_id == target.id
        assert captured_session_id not in str(refresh.payload)
        assert str(test_workspace.id) not in str(refresh.payload)
        assert note.title not in str(refresh.payload)
    finally:
        unsubscribe()


# --- the fingerprint contract --------------------------------------------------


def test_fingerprint_matches_the_mcp_server():
    # Pinned in mcp-server/tests/test_native_context.py too.
    vector = {
        "workspace_slug": "default",
        "limit": 3.0,
        "tags": ["café ☕"],
        "on": True,
    }
    assert (
        arguments_fingerprint(vector)
        == "d43be8d9f336a5426084a52327e8ff033765899ca98f2007d59f6f0d4217a079"
    )


def test_fingerprint_is_the_same_for_companion_digested_arguments():
    assert arguments_fingerprint(DIGESTED_ARGS) == arguments_fingerprint(ARGS)


# --- matching -------------------------------------------------------------------


@pytest.mark.parametrize("invocation_first", [False, True])
async def test_pi_call_without_id_links_as_correlated(
    client, device_client, test_workspace, test_board, test_card, invocation_first
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    session_record = pi_record([pi_tool_event("valaris_get_card", ARGS)], mapping_id)
    if invocation_first:
        await pi_call_with_work(client, test_board, test_card)
        await upload(device_client, token, [session_record])
    else:
        await upload(device_client, token, [session_record])
        await pi_call_with_work(client, test_board, test_card)

    found = await links(client, await session_id(client))
    assert set(found) == {("card", "changed"), ("card", "consulted")}
    assert {item["provenance"] for item in found.values()} == {"correlated"}

    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/cards/{test_card.id}/sessions"
    )
    [item] = response.json()["items"]
    assert item["provenance"] == "correlated"


@pytest.mark.parametrize(
    "tool_name,arguments",
    [
        # Direct tools under each pi-mcp-adapter toolPrefix mode.
        ("valaris_get_card", ARGS),
        ("get_card", ARGS),
        ("mcp__valaris_get_card", ARGS),
        # The `mcp` proxy tool and the per-server namespace tool.
        ("mcp", {"tool": "valaris_get_card", "args": ARGS}),
        ("mcp", {"tool": "get_card", "args": ARGS, "server": "valaris"}),
        ("mcp__valaris", {"tool": "get_card", "args": ARGS}),
        # The proxy tool also takes its arguments as a JSON string.
        (
            "mcp",
            {
                "tool": "get_card",
                "args": '{"card_id":"c-1","limit":3,"workspace_slug":"default"}',
            },
        ),
    ],
)
async def test_every_pi_mcp_adapter_tool_shape_correlates(
    client, device_client, test_workspace, test_board, test_card, tool_name, arguments
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(
        device_client,
        token,
        [pi_record([pi_tool_event(tool_name, arguments)], mapping_id)],
    )
    await pi_call_with_work(client, test_board, test_card)
    assert len(await links(client, await session_id(client))) == 2


async def test_metadata_level_sessions_correlate_on_digested_arguments(
    client, device_client, test_workspace, test_board, test_card
):
    token, mapping_id = await enroll(
        client, test_workspace, test_board, content_level="metadata"
    )
    await upload(
        device_client,
        token,
        [pi_record([pi_tool_event("valaris_get_card", DIGESTED_ARGS)], mapping_id)],
    )
    await pi_call_with_work(client, test_board, test_card)
    assert len(await links(client, await session_id(client))) == 2


async def test_call_and_result_events_of_one_call_are_one_candidate(
    client, device_client, test_workspace, test_board, test_card
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    events = [
        pi_tool_event("valaris_get_card", ARGS),
        pi_tool_event("valaris_get_card", ARGS, action="tool.completed"),
    ]
    await upload(device_client, token, [pi_record(events, mapping_id)])
    await pi_call_with_work(client, test_board, test_card)
    assert len(await links(client, await session_id(client))) == 2


@pytest.mark.parametrize(
    "event_values,outcome_values",
    [
        # Different arguments.
        ({"arguments": {**ARGS, "card_id": "c-2"}}, {}),
        # Same arguments, different tool.
        ({"tool_name": "valaris_list_card_dependencies"}, {}),
        # A tool of another server.
        ({"tool_name": "github_get_card"}, {}),
        # Outside the window.
        ({"captured_at": CALL_TIME - CORRELATION_WINDOW - timedelta(seconds=1)}, {}),
        # The invocation came from another harness.
        ({}, {"harness": "claude_code"}),
        # No fingerprint: nothing to correlate on.
        ({}, {"arguments_fingerprint": None}),
    ],
)
async def test_near_misses_never_link(
    client,
    device_client,
    test_workspace,
    test_board,
    test_card,
    event_values,
    outcome_values,
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    event = pi_tool_event(
        event_values.get("tool_name", "valaris_get_card"),
        event_values.get("arguments", ARGS),
    )
    await upload(
        device_client,
        token,
        [
            pi_record(
                [event],
                mapping_id,
                captured_at=event_values.get("captured_at", CALL_TIME),
            )
        ],
    )
    await pi_call_with_work(client, test_board, test_card, **outcome_values)
    assert await links(client, await session_id(client)) == {}


async def test_other_owners_invocations_never_correlate(
    client,
    device_client,
    db_session,
    test_workspace,
    test_board,
    test_card,
    second_user,
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(
        device_client,
        token,
        [pi_record([pi_tool_event("valaris_get_card", ARGS)], mapping_id)],
    )
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=second_user.id,
            role=WorkspaceRole.owner,
        )
    )
    await db_session.flush()
    async with as_user(db_session, second_user) as other:
        await pi_call_with_work(other, test_board, test_card)
    assert await links(client, await session_id(client)) == {}


# --- ambiguity --------------------------------------------------------------------


async def test_two_identical_calls_in_the_window_link_neither(
    client, device_client, db_session, test_workspace, test_board, test_card, caplog
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    events = [
        pi_tool_event("valaris_get_card", ARGS, call_id="toolu_a"),
        pi_tool_event("valaris_get_card", ARGS, call_id="toolu_b"),
    ]
    await upload(device_client, token, [pi_record(events, mapping_id)])
    await pi_call_with_work(client, test_board, test_card)
    assert await all_links(db_session) == []
    assert "ambiguous" in caplog.text


async def test_a_later_second_candidate_retracts_a_correlated_link(
    client, device_client, db_session, test_workspace, test_board, test_card
):
    token_a, mapping_a = await enroll(client, test_workspace, test_board, root="/a")
    token_b, mapping_b = await enroll(client, test_workspace, test_board, root="/b")
    await pi_call_with_work(client, test_board, test_card)
    await upload(
        device_client,
        token_a,
        [pi_record([pi_tool_event("valaris_get_card", ARGS)], mapping_a)],
    )
    assert len(await all_links(db_session)) == 2
    await upload(
        device_client,
        token_b,
        [
            pi_record(
                [pi_tool_event("valaris_get_card", ARGS, call_id="toolu_b")], mapping_b
            )
        ],
    )
    assert await all_links(db_session) == []


async def test_two_identical_invocations_for_one_call_link_neither(
    client, device_client, db_session, test_workspace, test_board, test_card
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(
        device_client,
        token,
        [pi_record([pi_tool_event("valaris_get_card", ARGS)], mapping_id)],
    )
    await pi_call_with_work(client, test_board, test_card)
    assert len(await all_links(db_session)) == 2
    await pi_call_with_work(client, test_board, test_card)
    assert await all_links(db_session) == []


# --- exact always wins --------------------------------------------------------------


async def test_a_pi_call_with_its_id_links_exactly(
    client, device_client, test_workspace, test_board, test_card
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(
        device_client,
        token,
        [pi_record([pi_tool_event("valaris_get_card", ARGS)], mapping_id)],
    )
    await pi_call_with_work(
        client,
        test_board,
        test_card,
        native_call_id=PI_CALL,
        arguments_fingerprint=None,
    )
    found = await links(client, await session_id(client))
    assert {item["provenance"] for item in found.values()} == {"exact"}


async def test_an_exactly_claimed_call_is_never_a_correlation_candidate(
    client, device_client, db_session, test_workspace, test_board, test_card
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(
        device_client,
        token,
        [pi_record([pi_tool_event("valaris_get_card", ARGS)], mapping_id)],
    )
    await pi_call_with_work(
        client,
        test_board,
        test_card,
        native_call_id=PI_CALL,
        arguments_fingerprint=None,
    )
    await pi_call_with_work(client, test_board, test_card)
    found = await links(client, await session_id(client))
    assert {item["provenance"] for item in found.values()} == {"exact"}
    assert {item["invocation_count"] for item in found.values()} == {1}


async def test_a_later_exact_claim_replaces_the_correlated_one(
    client, device_client, db_session, test_workspace, test_board, test_card
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(
        device_client,
        token,
        [pi_record([pi_tool_event("valaris_get_card", ARGS)], mapping_id)],
    )
    correlated = await pi_call_with_work(client, test_board, test_card)
    exact = await pi_call_with_work(
        client,
        test_board,
        test_card,
        native_call_id=PI_CALL,
        arguments_fingerprint=None,
    )
    found = await links(client, await session_id(client))
    assert {item["provenance"] for item in found.values()} == {"exact"}
    assert {item["invocation_count"] for item in found.values()} == {1}
    matches = {
        (row.invocation_id, row.provenance)
        for row in await db_session.scalars(
            select(AgentSessionInvocation).execution_options(populate_existing=True)
        )
    }
    assert matches == {(exact, "exact")}
    assert correlated not in {invocation for invocation, _ in matches}


async def test_an_exact_invocation_on_the_same_card_upgrades_the_link(
    client, device_client, test_workspace, test_board, test_card
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    events = [
        pi_tool_event("valaris_get_card", ARGS),
        pi_tool_event("valaris_update_card", {"card_id": "c-1"}, call_id="toolu_pi_2"),
    ]
    await upload(device_client, token, [pi_record(events, mapping_id)])
    await pi_call_with_work(client, test_board, test_card)
    changed = (await links(client, await session_id(client)))[("card", "changed")]
    assert changed["provenance"] == "correlated"

    await pi_call_with_work(
        client,
        test_board,
        test_card,
        tool_name="update_card",
        native_call_id="toolu_pi_2",
        arguments_fingerprint=None,
    )
    changed = (await links(client, await session_id(client)))[("card", "changed")]
    assert changed["provenance"] == "exact"
    assert changed["invocation_count"] == 2


# --- lock order -------------------------------------------------------------------


@pytest.fixture
def lock_log(monkeypatch):
    """Every advisory lock key in the order it is taken (sorted per call, as
    the repository takes them)."""
    log = []
    original = SessionWorkLinkRepository.serialize_call_matching

    async def spy(self, owner_id, keys):
        log.extend(sorted(keys))
        await original(self, owner_id, keys)

    monkeypatch.setattr(SessionWorkLinkRepository, "serialize_call_matching", spy)
    return log


def correlation_lock_leads(log):
    return bool(log) and log[0] == CORRELATION_LOCK


@pytest.mark.parametrize("invocation_first", [False, True])
async def test_pi_transactions_take_the_correlation_lock_before_any_call_lock(
    client,
    device_client,
    test_workspace,
    test_board,
    test_card,
    lock_log,
    invocation_first,
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    session_record = pi_record([pi_tool_event("valaris_get_card", ARGS)], mapping_id)

    async def exact_invocation():
        lock_log.clear()
        await pi_call_with_work(
            client,
            test_board,
            test_card,
            native_call_id=PI_CALL,
            arguments_fingerprint=None,
        )
        assert correlation_lock_leads(lock_log), lock_log
        assert PI_CALL in lock_log

    async def ingest():
        lock_log.clear()
        await upload(device_client, token, [session_record])
        assert correlation_lock_leads(lock_log), lock_log
        assert PI_CALL in lock_log

    if invocation_first:
        await exact_invocation()
        await ingest()
    else:
        await ingest()
        await exact_invocation()


async def test_an_exact_claim_locks_before_evicting_a_correlated_guess(
    client, device_client, test_workspace, test_board, test_card, lock_log
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(
        device_client,
        token,
        [pi_record([pi_tool_event("valaris_get_card", ARGS)], mapping_id)],
    )
    await pi_call_with_work(client, test_board, test_card)
    lock_log.clear()
    await pi_call_with_work(
        client,
        test_board,
        test_card,
        native_call_id=PI_CALL,
        arguments_fingerprint=None,
    )
    assert correlation_lock_leads(lock_log), lock_log
    found = await links(client, await session_id(client))
    assert {item["provenance"] for item in found.values()} == {"exact"}


async def test_harnesses_with_call_ids_never_take_the_correlation_lock(
    client, device_client, test_workspace, test_board, test_card, lock_log
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    event = pi_tool_event("Read", {"file_path": "/x"})
    event["harness"]["name"] = "claude_code"
    claude = pi_record([event], mapping_id)
    claude["harness"] = "claude_code"
    await upload(device_client, token, [claude])
    await pi_call_with_work(
        client,
        test_board,
        test_card,
        harness="claude_code",
        native_call_id=PI_CALL,
        arguments_fingerprint=None,
    )
    assert PI_CALL in lock_log
    assert CORRELATION_LOCK not in lock_log


# --- bounded queries ----------------------------------------------------------------


async def test_signed_calls_bounds_the_capture_time_in_sql(
    client, device_client, db_session, test_workspace, test_board, test_user
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    # The same instant as CALL_TIME, sent with a non-UTC offset.
    local = CALL_TIME.astimezone(timezone(timedelta(hours=2)))
    await upload(
        device_client,
        token,
        [
            pi_record(
                [pi_tool_event("valaris_get_card", ARGS)], mapping_id, captured_at=local
            )
        ],
    )
    repo = SessionWorkLinkRepository(db_session)
    [signature] = {
        signature
        for signature in await db_session.scalars(
            select(AgentSessionEvent.tool_call_signature)
        )
    }
    window = timedelta(seconds=1)
    assert (
        len(
            await repo.signed_calls(
                test_user.id,
                "pi_cli",
                {signature},
                CALL_TIME - window,
                CALL_TIME + window,
            )
        )
        == 1
    )
    assert (
        await repo.signed_calls(
            test_user.id,
            "pi_cli",
            {signature},
            CALL_TIME + window,
            CALL_TIME + 2 * window,
        )
        == []
    )


# --- long and piped call ids --------------------------------------------------------

# Pi on OpenAI's Responses API joins the call id and the item id with `|`,
# and the item id alone can run to hundreds of characters.
OPENAI_PI_CALL_ID = "call_" + "A1b2" * 6 + "|fc_" + "0123456789abcdef" * 26
# github-copilot, openai-codex and opencode item ids carry base64 (+, /, =).
BASE64_PI_CALL_ID = "call_" + "A1b2" * 6 + "|fc_" + "ab+/cd==" * 55


def test_native_call_key_matches_the_mcp_server():
    import hashlib

    assert len(OPENAI_PI_CALL_ID) == 449
    assert native_call_key("call_abc|fc_def") == "call_abc|fc_def"
    assert native_call_key("call_x|fc_ab+/cd==") == "call_x|fc_ab+/cd=="
    for long_id in [OPENAI_PI_CALL_ID, BASE64_PI_CALL_ID]:
        assert native_call_key(long_id) == (
            "sha256:" + hashlib.sha256(long_id.encode()).hexdigest()
        )


@pytest.mark.parametrize(
    "raw_call_id",
    [
        "call_abc123|fc_def456",
        "call_x|fc_ab+/cd==",
        OPENAI_PI_CALL_ID,
        BASE64_PI_CALL_ID,
    ],
)
async def test_openai_pi_call_ids_link_exactly(
    client, device_client, test_workspace, test_board, test_card, raw_call_id
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(
        device_client,
        token,
        [
            pi_record(
                [pi_tool_event("valaris_get_card", ARGS, call_id=raw_call_id)],
                mapping_id,
            )
        ],
    )
    # What the MCP server sends for that id.
    await pi_call_with_work(
        client,
        test_board,
        test_card,
        native_call_id=native_call_key(raw_call_id),
        arguments_fingerprint=None,
    )
    found = await links(client, await session_id(client))
    assert {item["provenance"] for item in found.values()} == {"exact"}
    assert len(found) == 2
