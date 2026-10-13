# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The session timeline as calls and turns (DK-WEB B4)."""

import copy
import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import delete, event as sa_event

from app.config import settings
from app.models.agent_session import AgentSessionInvocation
from app.models.kanban.card import Card
from app.models.workspace import WorkspaceMember, WorkspaceRole
from app.services.session_call_content import withheld_content
from tests.test_agent_sessions import (
    FIXTURE_EVENTS,
    ME,
    SESSIONS,
    TOOL_CALL,
    as_user,
    device_client as device_client_fixture,
    enroll,
    outcome,
    record,
    session_id,
    upload,
    work_under_invocation,
)
from tests.test_session_correlation import (
    ARGS,
    PI_CALL,
    enroll as pi_enroll,
    pi_call_with_work,
    pi_record,
    pi_tool_event,
)

device_client = device_client_fixture

T0 = datetime(2026, 9, 24, 2, 0, 0, tzinfo=timezone.utc)
SENTINELS = {
    "prompt": "SENTINEL_PROMPT_rename_billing",
    "arguments": "SENTINEL_ARGS_src_billing.py",
    "output": "SENTINEL_OUTPUT_lines_of_stdout",
    "error": "SENTINEL_ERROR_target_missing",
}


def beacon(action, seconds, *, category="tool", **members):
    event = {
        "timestamp": (T0 + timedelta(seconds=seconds)).isoformat(),
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


def prompt(seconds, text="Rename the billing module"):
    return beacon("prompt.submitted", seconds, category="prompt", prompt={"text": text})


def reasoning(seconds):
    return beacon("agent.reasoning", seconds, category="agent")


def call_started(call_id, seconds, tool="Bash", arguments=None):
    return beacon(
        "tool.invoked",
        seconds,
        tool={"name": tool},
        gen_ai={
            "tool": {
                "name": tool,
                "call": {"id": call_id, "arguments": arguments or {"command": "ls"}},
            }
        },
    )


def call_finished(call_id, seconds, tool="Bash", output="ok", exit_code=0):
    members = {
        "tool": {"name": tool, "output": output},
        "gen_ai": {"tool": {"name": tool, "call": {"id": call_id}}},
        "command": {"exit_code": exit_code},
    }
    if exit_code:
        members["error"] = {"message": "make: target not found"}
    return beacon("tool.failed" if exit_code else "tool.completed", seconds, **members)


async def calls(client, sid, query=""):
    response = await client.get(f"{SESSIONS}/{sid}/calls{query}")
    assert response.status_code == 200, response.text
    return response.json()


async def session_with(client, device_client, workspace, board, *records_events):
    token, mapping_id = await enroll(client, workspace, board)
    for events in records_events:
        await upload(device_client, token, [record(events, mapping_id)])
    return await session_id(client)


# --- grouping -------------------------------------------------------------------


async def test_pre_and_post_events_are_one_call_inside_its_turn(
    client, device_client, test_workspace, test_board
):
    sid = await session_with(
        client,
        device_client,
        test_workspace,
        test_board,
        [
            beacon("session.started", 0, category="session"),
            prompt(1),
            reasoning(2),
            call_started("call-a", 3),
            call_finished("call-a", 5),
            reasoning(6),
            prompt(10, "Now run the tests"),
            call_started("call-b", 11, arguments={"command": "make test"}),
            call_finished("call-b", 12, exit_code=2),
        ],
    )

    page = await calls(client, sid)

    assert [(item["kind"], item["turn_index"]) for item in page["items"]] == [
        ("prompt", 1),
        ("tool", 1),
        ("prompt", 2),
        ("tool", 2),
    ]
    first_call = page["items"][1]
    assert first_call["call_id"] == "call-a"
    assert first_call["name"] == "Bash"
    assert first_call["event_count"] == 2
    assert first_call["duration_ms"] == 2000
    assert first_call["outcome"] == "succeeded"
    assert first_call["exit_code"] == 0
    failed = page["items"][3]
    assert failed["outcome"] == "failed"
    assert failed["exit_code"] == 2
    assert page["turns"] == [
        {
            "turn_index": 1,
            "started_at": "2026-09-24T02:00:01+00:00",
            "ended_at": "2026-09-24T02:00:06+00:00",
            "call_count": 1,
            "failure_count": 0,
            "reasoning_count": 2,
        },
        {
            "turn_index": 2,
            "started_at": "2026-09-24T02:00:10+00:00",
            "ended_at": "2026-09-24T02:00:12+00:00",
            "call_count": 1,
            "failure_count": 1,
            "reasoning_count": 0,
        },
    ]
    assert page["next_cursor"] is None

    failures = await calls(client, sid, "?filter=failures")
    assert [item["call_id"] for item in failures["items"]] == ["call-b"]


async def test_a_call_missing_its_start_or_end_still_shows_once(
    client, device_client, test_workspace, test_board
):
    sid = await session_with(
        client,
        device_client,
        test_workspace,
        test_board,
        [
            prompt(1),
            # The pre-tool event of call-a never arrived.
            call_finished("call-a", 4),
            # call-b started and nothing more was captured.
            call_started("call-b", 6),
        ],
    )

    items = (await calls(client, sid))["items"]

    lone_end, lone_start = items[1], items[2]
    assert lone_end["call_id"] == "call-a"
    assert lone_end["event_count"] == 1
    assert lone_end["duration_ms"] is None
    assert lone_end["outcome"] == "succeeded"
    assert lone_start["call_id"] == "call-b"
    assert lone_start["duration_ms"] is None
    # Nothing says how call-b ended, and the session is long over.
    assert lone_start["outcome"] == "unknown"


async def test_a_call_without_a_completion_in_a_live_session_is_running(
    client, device_client, test_workspace, test_board
):
    now = datetime.now(timezone.utc)
    started = call_started("call-live", 0)
    started["timestamp"] = (now - timedelta(seconds=30)).isoformat()
    hook_again = call_started("call-live", 0)
    hook_again["timestamp"] = (now - timedelta(seconds=20)).isoformat()
    sid = await session_with(
        client, device_client, test_workspace, test_board, [started, hook_again]
    )

    [item] = (await calls(client, sid))["items"]

    assert item["event_count"] == 2
    assert item["outcome"] == "running"


async def test_events_arriving_out_of_order_regroup_by_occurrence(
    client, device_client, test_workspace, test_board
):
    sid = await session_with(
        client,
        device_client,
        test_workspace,
        test_board,
        # The end of the call and the second prompt are uploaded first.
        [call_finished("call-a", 5), prompt(8, "second")],
        [call_started("call-a", 2), prompt(1, "first")],
    )

    items = (await calls(client, sid))["items"]

    assert [(item["kind"], item["turn_index"]) for item in items] == [
        ("prompt", 1),
        ("tool", 1),
        ("prompt", 2),
    ]
    assert items[1]["started_at"] == "2026-09-24T02:00:02+00:00"
    assert items[1]["duration_ms"] == 3000
    assert items[1]["event_count"] == 2


async def test_activity_before_the_first_prompt_is_turn_zero(
    client, device_client, test_workspace, test_board
):
    sid = await session_with(
        client,
        device_client,
        test_workspace,
        test_board,
        [call_started("call-a", 1), call_finished("call-a", 2), prompt(3)],
    )

    items = (await calls(client, sid))["items"]

    assert [(item["kind"], item["turn_index"]) for item in items] == [
        ("tool", 0),
        ("prompt", 1),
    ]


async def test_mcp_calls_carry_server_and_tool(
    client, device_client, test_workspace, test_board
):
    sid = await session_with(
        client, device_client, test_workspace, test_board, FIXTURE_EVENTS
    )

    items = (await calls(client, sid))["items"]

    mcp_call = next(item for item in items if item["call_id"] == TOOL_CALL)
    assert mcp_call["kind"] == "mcp"
    assert (mcp_call["mcp_server"], mcp_call["mcp_tool"]) == ("backplane", "get_card")
    assert mcp_call["event_count"] == 2
    # Both events are invocation hooks: neither says the call completed.
    assert mcp_call["outcome"] == "unknown"
    # Session lifecycle and the end-of-response event are not calls.
    assert {item["kind"] for item in items} <= {"prompt", "tool", "mcp"}
    assert all(item["name"] for item in items if item["kind"] != "prompt")


# --- content by capture level ---------------------------------------------------


def privacy_probe_events():
    return [
        prompt(1, SENTINELS["prompt"]),
        call_started(
            "call-out", 2, tool="Read", arguments={"file_path": SENTINELS["arguments"]}
        ),
        call_finished("call-out", 3, tool="Read", output=SENTINELS["output"]),
        beacon(
            "tool.failed",
            4,
            tool={"name": "Bash"},
            gen_ai={"tool": {"call": {"id": "call-err"}}},
            error={"message": SENTINELS["error"]},
            command={"exit_code": 1},
        ),
        # A call that produced nothing at all.
        call_started("call-quiet", 5, tool="Glob", arguments={"pattern": "*.md"}),
        beacon(
            "tool.completed",
            6,
            tool={"name": "Glob"},
            gen_ai={"tool": {"call": {"id": "call-quiet"}}},
        ),
    ]


async def leveled_session(client, device_client, workspace, board, level):
    token, mapping_id = await enroll(client, workspace, board)
    installation_id = (await client.get(ME)).json()[0]["installation_id"]
    response = await client.patch(
        f"{ME}/{installation_id}/mappings/{mapping_id}",
        json={"content_level": level},
    )
    assert response.status_code == 200, response.text
    await upload(device_client, token, [record(privacy_probe_events(), mapping_id)])
    return await session_id(client)


def by_call(items):
    return {item["call_id"] or item["kind"]: item for item in items}


def withheld(item):
    return {entry["field"]: entry["bytes"] for entry in item["withheld"]}


async def details(client, sid, items):
    texts = []
    for item in items:
        response = await client.get(f"{SESSIONS}/{sid}/calls/{item['key']}")
        assert response.status_code == 200, response.text
        texts.append(response.text)
    return "\n".join(texts)


async def test_metadata_sends_no_content_and_marks_what_was_withheld(
    client, device_client, test_workspace, test_board
):
    sid = await leveled_session(
        client, device_client, test_workspace, test_board, "metadata"
    )

    page = await calls(client, sid)
    detail = await details(client, sid, page["items"])

    for sentinel in SENTINELS.values():
        assert sentinel not in json.dumps(page)
        assert sentinel not in detail
    items = by_call(page["items"])
    assert items["prompt"]["prompt_preview"] is None
    assert withheld(items["prompt"])["prompt"] > 0
    read = items["call-out"]
    assert read["args_preview"] is None
    assert withheld(read)["arguments"] > 0
    assert read["output"] == "withheld"
    assert withheld(read)["output"] > 0
    assert withheld(items["call-err"])["error"] > 0
    assert items["call-quiet"]["output"] == "none"
    assert "output" not in withheld(items["call-quiet"])


async def test_standard_shows_prompts_and_arguments_but_never_output(
    client, device_client, test_workspace, test_board
):
    sid = await leveled_session(
        client, device_client, test_workspace, test_board, "standard"
    )

    page = await calls(client, sid)
    detail = await details(client, sid, page["items"])

    assert SENTINELS["output"] not in json.dumps(page)
    assert SENTINELS["output"] not in detail
    items = by_call(page["items"])
    assert SENTINELS["prompt"] in items["prompt"]["prompt_preview"]
    assert "prompt" not in withheld(items["prompt"])
    read = items["call-out"]
    assert SENTINELS["arguments"] in read["args_preview"]
    assert "arguments" not in withheld(read)
    assert read["output"] == "withheld"
    assert withheld(read)["output"] == len(SENTINELS["output"].encode())
    # The error message is kept at standard, for the expanded call only.
    assert SENTINELS["error"] not in json.dumps(page)
    assert SENTINELS["error"] in detail
    assert items["call-quiet"]["output"] == "none"
    assert items["call-quiet"]["withheld"] == []


async def test_full_keeps_output_out_of_the_page_but_in_the_expanded_call(
    client, device_client, test_workspace, test_board
):
    sid = await leveled_session(
        client, device_client, test_workspace, test_board, "full"
    )

    page = await calls(client, sid)

    assert SENTINELS["output"] not in json.dumps(page)
    read = by_call(page["items"])["call-out"]
    assert read["output"] == "sent"
    assert read["withheld"] == []
    assert SENTINELS["output"] in await details(client, sid, [read])


async def test_argument_previews_are_capped(
    client, device_client, test_workspace, test_board
):
    long_command = "echo " + "x" * 2000
    sid = await session_with(
        client,
        device_client,
        test_workspace,
        test_board,
        [call_started("call-a", 1, arguments={"command": long_command})],
    )

    [item] = (await calls(client, sid))["items"]

    assert len(item["args_preview"]) == 300
    assert item["args_preview"].endswith("…")


# --- work references -------------------------------------------------------------


async def test_mcp_call_carries_the_cards_it_changed_and_consulted(
    client, device_client, db_session, test_workspace, test_board, test_card
):
    sid = await session_with(
        client, device_client, test_workspace, test_board, FIXTURE_EVENTS
    )
    invocation_id = uuid.uuid4()
    await work_under_invocation(client, test_board, test_card, invocation_id)
    response = await client.post("/api/me/mcp-invocations", json=outcome(invocation_id))
    assert response.status_code == 200, response.text

    items = (await calls(client, sid))["items"]

    mcp_call = next(item for item in items if item["call_id"] == TOOL_CALL)
    refs = {ref["relation"]: ref for ref in mcp_call["work_refs"]}
    assert set(refs) == {"changed", "consulted"}
    assert refs["changed"] == {
        "entity_type": "card",
        "entity_id": str(test_card.id),
        "workspace_id": str(test_workspace.id),
        "board_id": str(test_board.id),
        "title": "Changed",
        "relation": "changed",
        "provenance": "exact",
    }
    assert all(not item["work_refs"] for item in items if item is not mcp_call)
    work_only = await calls(client, sid, "?filter=work")
    assert [item["call_id"] for item in work_only["items"]] == [TOOL_CALL]

    await db_session.execute(delete(Card).where(Card.id == test_card.id))
    await db_session.flush()
    items = (await calls(client, sid))["items"]
    assert all(item["work_refs"] == [] for item in items)
    assert (await calls(client, sid, "?filter=work"))["items"] == []


async def test_correlated_call_reports_correlated_provenance(
    client, device_client, test_workspace, test_board, test_card
):
    token, mapping_id = await pi_enroll(client, test_workspace, test_board)
    await upload(
        device_client,
        token,
        [pi_record([pi_tool_event("valaris_get_card", ARGS)], mapping_id)],
    )
    await pi_call_with_work(client, test_board, test_card)

    [item] = (await calls(client, await session_id(client)))["items"]

    assert item["call_id"] == PI_CALL
    assert {ref["provenance"] for ref in item["work_refs"]} == {"correlated"}


async def test_work_refs_ignore_matches_of_another_session(
    client, device_client, db_session, test_workspace, test_board, test_card
):
    sid = await session_with(
        client, device_client, test_workspace, test_board, FIXTURE_EVENTS
    )
    invocation_id = uuid.uuid4()
    await work_under_invocation(client, test_board, test_card, invocation_id)
    await client.post("/api/me/mcp-invocations", json=outcome(invocation_id))
    await db_session.execute(
        delete(AgentSessionInvocation).where(
            AgentSessionInvocation.session_id == uuid.UUID(sid)
        )
    )
    await db_session.flush()

    items = (await calls(client, sid))["items"]

    assert all(item["work_refs"] == [] for item in items)


# --- subagents -------------------------------------------------------------------


async def test_subagent_sessions_interleave_at_their_start(
    client, device_client, test_workspace, test_board
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(
        device_client,
        token,
        [
            record(
                [prompt(1), call_started("call-a", 2), call_finished("call-a", 3)]
                + [call_started("call-b", 20), call_finished("call-b", 21)],
                mapping_id,
                session="root-session",
            )
        ],
    )
    child = record(
        [call_started("child-call", 10), call_finished("child-call", 12)],
        mapping_id,
        session="child-session",
    )
    child["parent_native_session_id"] = "root-session"
    await upload(device_client, token, [child])
    listed = (await client.get(SESSIONS + "?root_only=true")).json()["items"]
    [root] = listed

    items = (await calls(client, root["id"]))["items"]

    assert [item["kind"] for item in items] == ["prompt", "tool", "subagent", "tool"]
    subagent = items[2]
    assert subagent["turn_index"] == 1
    assert subagent["started_at"] == "2026-09-24T02:00:10+00:00"
    assert subagent["subagent"]["parent_session_id"] == root["id"]
    assert subagent["subagent"]["tool_call_count"] == 1
    assert subagent["work_refs"] == []
    assert [
        item["kind"]
        for item in (await calls(client, root["id"], "?filter=failures"))["items"]
    ] == []


# --- size --------------------------------------------------------------------------


async def large_session(client, device_client, workspace, board, call_count):
    token, mapping_id = await enroll(client, workspace, board)
    events = [prompt(0)]
    for index in range(call_count):
        call_id = f"call-{index:04d}"
        events += [
            call_started(call_id, 1 + index * 2),
            call_finished(call_id, 2 + index * 2),
        ]
    batches = [events[start : start + 250] for start in range(0, len(events), 250)]
    await upload(device_client, token, [record(batch, mapping_id) for batch in batches])
    return await session_id(client)


async def test_large_session_pages_newest_first_without_splitting_calls(
    client, device_client, test_workspace, test_board
):
    # Calls cross the 250-event upload batches, so pre and post of one call
    # arrive in different records.
    sid = await large_session(client, device_client, test_workspace, test_board, 260)

    pages = [await calls(client, sid, "?limit=100")]
    while pages[-1]["next_cursor"]:
        pages.append(
            await calls(client, sid, f"?limit=100&cursor={pages[-1]['next_cursor']}")
        )

    assert [len(page["items"]) for page in pages] == [100, 100, 61]
    # Each page is in occurrence order; later pages hold earlier calls.
    timeline = [item for page in reversed(pages) for item in page["items"]]
    assert timeline[0]["kind"] == "prompt"
    calls_seen = [item["call_id"] for item in timeline[1:]]
    assert calls_seen == [f"call-{index:04d}" for index in range(260)]
    assert {item["event_count"] for item in timeline[1:]} == {2}
    assert pages[0]["turns"][0]["call_count"] == 260


async def test_calls_page_runs_a_constant_number_of_queries(
    client, device_client, db_session, test_workspace, test_board
):
    async def statements_for(sid):
        count = 0

        def _count(*_):
            nonlocal count
            count += 1

        engine = db_session.get_bind()
        sa_event.listen(engine, "before_cursor_execute", _count)
        try:
            await calls(client, sid, "?limit=200")
        finally:
            sa_event.remove(engine, "before_cursor_execute", _count)
        return count

    small = await large_session(client, device_client, test_workspace, test_board, 3)
    small_count = await statements_for(small)
    await client.delete(f"{SESSIONS}/{small}")
    large = await large_session(client, device_client, test_workspace, test_board, 150)

    assert await statements_for(large) == small_count
    assert small_count <= 12


async def test_limit_and_cursor_are_validated(
    client, device_client, test_workspace, test_board
):
    sid = await session_with(
        client, device_client, test_workspace, test_board, [prompt(1)]
    )
    assert (await client.get(f"{SESSIONS}/{sid}/calls?limit=201")).status_code == 422
    assert (
        await client.get(f"{SESSIONS}/{sid}/calls?cursor=garbage")
    ).status_code == 422
    assert (await client.get(f"{SESSIONS}/{sid}/calls?filter=nope")).status_code == 422


# --- one call, expanded -------------------------------------------------------------


async def test_expanding_a_call_returns_its_events(
    client, device_client, test_workspace, test_board
):
    sid = await session_with(
        client,
        device_client,
        test_workspace,
        test_board,
        [prompt(1), call_started("call/a:1", 2), call_finished("call/a:1", 3)],
    )
    item = (await calls(client, sid))["items"][1]

    response = await client.get(f"{SESSIONS}/{sid}/calls/{item['key']}")

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["key"] == item["key"]
    assert [event["action"] for event in body["events"]] == [
        "tool.invoked",
        "tool.completed",
    ]
    assert (await client.get(f"{SESSIONS}/{sid}/calls/bm90LWEta2V5")).status_code == 404
    assert (await client.get(f"{SESSIONS}/{sid}/calls/not-base64!")).status_code == 404


# --- access ----------------------------------------------------------------------------


async def test_calls_are_private_to_the_session_owner(
    client,
    agent_client,
    device_client,
    db_session,
    test_workspace,
    test_board,
    second_user,
):
    sid = await session_with(
        client, device_client, test_workspace, test_board, [prompt(1)]
    )
    key = (await calls(client, sid))["items"][0]["key"]
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=second_user.id,
            role=WorkspaceRole.owner,
        )
    )
    await db_session.flush()

    async with as_user(db_session, second_user) as other:
        assert (await other.get(f"{SESSIONS}/{sid}/calls")).status_code == 404
        assert (await other.get(f"{SESSIONS}/{sid}/calls/{key}")).status_code == 404
    assert (await agent_client.get(f"{SESSIONS}/{sid}/calls")).status_code == 403
    assert (await agent_client.get(f"{SESSIONS}/{sid}/calls/{key}")).status_code == 403


async def test_calls_answer_not_found_when_companion_is_off(
    client, device_client, monkeypatch, test_workspace, test_board
):
    sid = await session_with(
        client, device_client, test_workspace, test_board, [prompt(1)]
    )
    key = (await calls(client, sid))["items"][0]["key"]
    monkeypatch.setattr(settings, "COMPANION_ENABLED", False)

    assert (await client.get(f"{SESSIONS}/{sid}/calls")).status_code == 404
    assert (await client.get(f"{SESSIONS}/{sid}/calls/{key}")).status_code == 404


@pytest.mark.parametrize("path", ["/calls", "/calls/bm90LWEta2V5"])
async def test_unknown_session_is_not_found(client, test_workspace, path):
    response = await client.get(f"{SESSIONS}/{uuid.uuid4()}{path}")
    assert response.status_code == 404


async def test_output_the_companion_withheld_reports_its_stated_size(
    client, device_client, test_workspace, test_board
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    installation_id = (await client.get(ME)).json()[0]["installation_id"]
    await client.patch(
        f"{ME}/{installation_id}/mappings/{mapping_id}",
        json={"content_level": "standard"},
    )
    descriptor = {"bytes": 6400, "sha256": "a" * 64}
    events = [call_started("call-big", 1), call_finished("call-big", 2, output=descriptor)]
    await upload(device_client, token, [record(events, mapping_id)])

    [item] = (await calls(client, await session_id(client)))["items"]
    # Never the size of the {bytes, sha256} placeholder Backplane received.
    assert withheld(item)["output"] == 6400


def test_redactions_stored_before_original_sizes_report_no_size():
    fingerprint = {"sha256": "c" * 64, "bytes": 88}

    def stored(**entry):
        return {"backplane_redactions": {"tool.output": {**fingerprint, **entry}}}

    assert withheld_content([stored()]) == {"output": None}
    assert withheld_content([stored(original_bytes=None)]) == {"output": None}
    assert withheld_content([stored(original_bytes=6400)]) == {"output": 6400}
