# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""DK-WEB B7: a session's rhythm, bucketed on the server. Each timeline
entry (a prompt, or every event of one tool call) counts once, in the bucket
of its first event, as exactly one kind; nothing but counts and times leaves
the server."""

import copy
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import event as sa_event

from app.models.workspace import WorkspaceMember, WorkspaceRole
from tests.test_agent_sessions import (
    FIXTURE_EVENTS,
    SESSIONS,
    as_user,
    enroll,
    outcome,
    record,
    session_id,
    upload,
    work_under_invocation,
)
from tests.test_session_lifecycle import device_client as device_client_fixture

device_client = device_client_fixture

T0 = datetime(2026, 9, 24, 2, 0, 0, tzinfo=timezone.utc)
KINDS = ("prompt", "tool", "file", "work", "error")


def beacon(action, at, *, category="tool", **members):
    event = {
        "timestamp": at.isoformat(),
        "schema_version": "1.0",
        "event": {
            "id": str(uuid.uuid4()),
            "action": action,
            "category": category,
            "kind": "agent_runtime",
        },
        "harness": {"name": "claude_code", "collection_method": "hook"},
        "session": {"working_directory": "/synthetic/project"},
    }
    event.update(copy.deepcopy(members))
    return event


def prompt(at):
    return beacon("prompt.submitted", at, category="prompt", prompt={"text": "SECRET"})


def call(call_id, at, tool="Bash", *, seconds=1, failed=False):
    tool_call = {"name": tool, "call": {"id": call_id}}
    finish = {"tool": {"name": tool}, "gen_ai": {"tool": tool_call}}
    if failed:
        finish["command"] = {"exit_code": 1}
        finish["error"] = {"message": "SECRET failure"}
    return [
        beacon(
            "tool.invoked",
            at,
            tool={"name": tool},
            gen_ai={
                "tool": {**tool_call, "call": {"id": call_id, "arguments": "SECRET"}}
            },
        ),
        beacon(
            "tool.failed" if failed else "tool.completed",
            at + timedelta(seconds=seconds),
            **finish,
        ),
    ]


def reasoning(at):
    return beacon("agent.reasoning", at, category="agent")


async def rhythm(client, sid, query=""):
    response = await client.get(f"{SESSIONS}/{sid}/rhythm{query}")
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


async def captured(client, device_client, workspace, board, events, **record_values):
    token, mapping_id = await enroll(client, workspace, board)
    await upload(device_client, token, [record(events, mapping_id, **record_values)])
    return await session_id(client), token, mapping_id


def counts(bucket):
    return {kind: bucket[kind] for kind in KINDS if bucket[kind]}


def seconds_after(value, base=T0):
    return (datetime.fromisoformat(value) - base).total_seconds()


async def test_entries_land_once_in_the_bucket_of_their_first_event(
    client, device_client, test_workspace, test_board
):
    events = [
        prompt(T0),
        reasoning(T0 + timedelta(seconds=50)),  # not a timeline entry
        *call("call-a", T0 + timedelta(seconds=100), seconds=20),
        *call("call-b", T0 + timedelta(seconds=900), tool="Edit"),
        *call("call-c", T0 + timedelta(seconds=1790), seconds=9, failed=True),
        # Straddles the 1800 s edge: counted where it began.
        *call("call-d", T0 + timedelta(seconds=1795), tool="apply_patch", seconds=30),
        prompt(T0 + timedelta(seconds=3600)),
    ]
    sid, _, _ = await captured(
        client, device_client, test_workspace, test_board, events
    )

    body = await rhythm(client, sid, "?buckets=4")

    assert seconds_after(body["start"]) == 0
    assert seconds_after(body["end"]) == 3600
    assert body["live"] is False
    assert body["bucket_seconds"] == 900
    assert [seconds_after(bucket["t"]) for bucket in body["buckets"]] == [
        0,
        900,
        1800,
        2700,
    ]
    assert [counts(bucket) for bucket in body["buckets"]] == [
        {"prompt": 1, "tool": 1},
        {"file": 2, "error": 1},
        {},
        # The session's last instant belongs to the last bucket.
        {"prompt": 1},
    ]
    assert "SECRET" not in str(body)


async def test_an_mcp_call_that_touched_work_counts_as_work_not_tool(
    client, device_client, test_workspace, test_board, test_card
):
    sid, _, _ = await captured(
        client, device_client, test_workspace, test_board, FIXTURE_EVENTS
    )
    before = await rhythm(client, sid, "?buckets=1")
    invocation_id = uuid.uuid4()
    await work_under_invocation(client, test_board, test_card, invocation_id)
    response = await client.post("/api/me/mcp-invocations", json=outcome(invocation_id))
    assert response.status_code == 200, response.text

    after = await rhythm(client, sid, "?buckets=1")

    [was], [now] = before["buckets"], after["buckets"]
    assert now["work"] == 1 and was["work"] == 0
    assert sum(now[kind] for kind in KINDS) == sum(was[kind] for kind in KINDS)


async def test_idle_spans_are_silences_longer_than_five_minutes(
    client, device_client, test_workspace, test_board
):
    events = [
        prompt(T0),
        *call("a", T0 + timedelta(seconds=200)),  # 199 s of silence: busy
        *call("b", T0 + timedelta(seconds=561)),  # 360 s: idle
        *call("c", T0 + timedelta(seconds=862)),  # exactly 300 s: not idle
    ]
    sid, _, _ = await captured(
        client, device_client, test_workspace, test_board, events
    )

    body = await rhythm(client, sid)

    assert [
        (seconds_after(span["start"]), seconds_after(span["end"]))
        for span in body["idle_spans"]
    ] == [(201, 561)]


async def test_a_live_session_runs_to_now_with_its_current_silence_idle(
    client, device_client, test_workspace, test_board
):
    start = datetime.now(timezone.utc) - timedelta(minutes=30)
    events = [prompt(start), *call("a", start + timedelta(minutes=20))]
    sid, _, _ = await captured(
        client, device_client, test_workspace, test_board, events
    )

    before = datetime.now(timezone.utc)
    body = await rhythm(client, sid, "?buckets=10")

    end = datetime.fromisoformat(body["end"])
    assert body["live"] is True
    assert end >= before - timedelta(seconds=1)
    assert len(body["buckets"]) == 10
    [quiet, trailing] = body["idle_spans"]
    assert seconds_after(quiet["start"], start) == 0
    assert seconds_after(trailing["start"], start) == pytest.approx(20 * 60 + 1)
    assert trailing["end"] == body["end"]


async def test_subagents_are_lanes_with_their_own_span_and_state(
    client, device_client, test_workspace, test_board
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(
        device_client,
        token,
        [
            record(
                [prompt(T0), *call("a", T0 + timedelta(seconds=60))],
                mapping_id,
                session="root",
            )
        ],
    )
    child = record(
        [*call("child", T0 + timedelta(seconds=10), seconds=40)],
        mapping_id,
        session="child",
    )
    child["parent_native_session_id"] = "root"
    await upload(device_client, token, [child])
    [root] = (await client.get(SESSIONS + "?root_only=true")).json()["items"]

    body = await rhythm(client, root["id"])

    [lane] = body["children"]
    assert lane["harness"] == "claude_code"
    assert lane["display_state"] == "incomplete"  # a day of silence, no end event
    assert seconds_after(lane["start"]) == 10
    assert seconds_after(lane["end"]) == 50
    assert lane["session_id"] != root["id"]


async def test_bucket_count_is_bounded_and_a_zero_length_session_is_one_bucket(
    client, device_client, test_workspace, test_board
):
    sid, _, _ = await captured(
        client, device_client, test_workspace, test_board, [prompt(T0)]
    )
    body = await rhythm(client, sid, "?buckets=240")
    assert len(body["buckets"]) == 1 and body["buckets"][0]["prompt"] == 1
    assert (await client.get(f"{SESSIONS}/{sid}/rhythm?buckets=241")).status_code == 422
    assert (await client.get(f"{SESSIONS}/{sid}/rhythm?buckets=0")).status_code == 422


async def test_rhythm_is_the_owners_alone(
    client,
    agent_client,
    device_client,
    db_session,
    test_workspace,
    test_board,
    second_user,
):
    sid, _, _ = await captured(
        client, device_client, test_workspace, test_board, [prompt(T0)]
    )
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=second_user.id,
            role=WorkspaceRole.member,
        )
    )
    await db_session.flush()
    async with as_user(db_session, second_user) as other:
        assert (await other.get(f"{SESSIONS}/{sid}/rhythm")).status_code == 404
    assert (await agent_client.get(f"{SESSIONS}/{sid}/rhythm")).status_code == 403
    assert (await client.get(f"{SESSIONS}/{uuid.uuid4()}/rhythm")).status_code == 404


async def test_rhythm_is_a_fixed_number_of_statements(
    client, device_client, db_session, test_workspace, test_board
):
    count = 0

    def _count(*_):
        nonlocal count
        count += 1

    async def statements(sid):
        nonlocal count
        count = 0
        engine = db_session.get_bind()
        sa_event.listen(engine, "before_cursor_execute", _count)
        try:
            await rhythm(client, sid)
        finally:
            sa_event.remove(engine, "before_cursor_execute", _count)
        return count

    token, mapping_id = await enroll(client, test_workspace, test_board)

    async def session_of(name, call_count):
        events = [prompt(T0)]
        for index in range(call_count):
            events += call(f"{name}-{index}", T0 + timedelta(seconds=400 * index + 1))
        await upload(device_client, token, [record(events, mapping_id, session=name)])
        listed = (await client.get(SESSIONS)).json()["items"]
        return next(item["id"] for item in listed if item["native_session_id"] == name)

    small = await statements(await session_of("small", 2))
    assert await statements(await session_of("large", 120)) == small
    assert small <= 10
