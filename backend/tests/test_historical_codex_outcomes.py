# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Retained historical outcomes agree across owner-private call read paths."""

import copy
import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import delete, event as sa_event, select

from app.core.codex_tool_result import codex_tool_result
from app.models.agent_session import (
    AgentSession,
    AgentSessionCapture,
    AgentSessionEvent,
    AgentSessionUsage,
)
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from tests.test_agent_sessions import (
    ME,
    SESSIONS,
    as_user,
    device_client as device_client_fixture,
    enroll,
    outcome,
    record,
    upload,
    work_under_invocation,
)
from tests.test_codex_tool_results import codex_result
from tests.test_session_calls import T0, call_started, calls, prompt


device_client = device_client_fixture
RAW_SENTINEL = "HISTORICAL_RAW_OUTPUT_MUST_NOT_ENTER_SUMMARIES"


def result(call_id="legacy-call", seconds=2, success="false", harness="codex_desktop"):
    event = codex_result(success, output=RAW_SENTINEL)
    event["event"]["id"] = f"{call_id}-{seconds}"
    event["timestamp"] = (T0 + timedelta(seconds=seconds)).isoformat()
    event["gen_ai"]["tool"]["call"]["id"] = call_id
    event["harness"]["name"] = harness
    return event


async def historical_session(
    client,
    device_client,
    db_session,
    workspace,
    board,
    events,
    *,
    indexed=None,
    level="full",
):
    token, mapping_id = await enroll(client, workspace, board, content_level=level)
    name = "historical-" + uuid.uuid4().hex
    captures = [
        record(
            events[start : start + 5], mapping_id, harness="codex_desktop", session=name
        )
        for start in range(0, len(events), 5)
    ]
    await upload(device_client, token, captures)
    session = await db_session.scalar(
        select(AgentSession).where(AgentSession.native_session_id == name)
    )
    rows = list(
        await db_session.scalars(
            select(AgentSessionEvent).where(AgentSessionEvent.session_id == session.id)
        )
    )
    # Current ingest promotes native results. Restore the missing scalar values
    # of historical rows without mocking the routes or their repository queries.
    for row in rows:
        row.outcome = (indexed or {}).get(row.event_id)
        row.mcp_server = row.mcp_tool = None
    session.error_count = sum(row.outcome == "failed" for row in rows)
    session.capture_levels = None
    for receipt in await db_session.scalars(
        select(AgentSessionCapture).where(AgentSessionCapture.session_id == session.id)
    ):
        receipt.content_level = None
    await db_session.flush()
    return session, rows, token, captures


async def rhythm(client, session_id):
    response = await client.get(f"{SESSIONS}/{session_id}/rhythm?buckets=4")
    assert response.status_code == 200, response.text
    return response.json()


async def stored_snapshot(db_session, session_id):
    tables = [AgentSession, AgentSessionEvent, AgentSessionCapture, AgentSessionUsage]
    values = {}
    for model in tables:
        key = model.id if model is AgentSession else model.session_id
        rows = await db_session.execute(
            select(*model.__table__.columns).where(key == session_id)
        )
        values[model.__tablename__] = sorted(
            [dict(row._mapping) for row in rows], key=lambda row: str(row["id"])
        )
    return json.dumps(values, sort_keys=True, default=str)


@pytest.mark.parametrize("surface", ["failures", "turns", "rhythm"])
async def test_historical_failed_call_is_consistent_across_read_paths(
    client, device_client, db_session, test_workspace, test_board, surface
):
    session, _, _, _ = await historical_session(
        client,
        device_client,
        db_session,
        test_workspace,
        test_board,
        [prompt(1), result()],
    )
    page = await calls(client, session.id)
    [failed] = [item for item in page["items"] if item["kind"] != "prompt"]
    assert failed["outcome"] == "failed"  # the display already understands the evidence
    before = await stored_snapshot(db_session, session.id)
    if surface == "failures":
        response = await calls(client, session.id, "?filter=failures")
        observed = [item["key"] for item in response["items"]]
        expected = [failed["key"]]
    elif surface == "turns":
        response = page
        observed, expected = page["turns"][0]["failure_count"], 1
    else:
        response = await rhythm(client, session.id)
        observed = sum(bucket["error"] for bucket in response["buckets"])
        expected = 1
    assert RAW_SENTINEL not in json.dumps(response)
    assert await stored_snapshot(db_session, session.id) == before
    assert observed == expected


# (case, success, indexed outcome, displayed outcome). These are also the
# finite truth-table inputs for the separately authorized PostgreSQL leg.
OUTCOME_CASES = [
    ("boolean-false", False, None, "failed"),
    ("string-false", "false", None, "failed"),
    ("cli-false", False, None, "failed"),
    ("empty-index", "false", "", "failed"),
    ("boolean-true", True, None, "succeeded"),
    ("string-true", "true", None, "succeeded"),
    ("integer-zero", 0, None, "unknown"),
    ("integer-one", 1, None, "unknown"),
    ("float-zero", 0.0, None, "unknown"),
    ("capitalized", "False", None, "unknown"),
    ("numeric-string", "0", None, "unknown"),
    ("whitespace", " false ", None, "unknown"),
    ("empty", "", None, "unknown"),
    ("null", None, None, "unknown"),
    ("array", [False], None, "unknown"),
    ("object", {"success": False}, None, "unknown"),
    ("missing-success", "false", None, "unknown"),
    ("wrong-marker", "false", None, "unknown"),
    ("other-harness", "false", None, "unknown"),
    ("missing-harness", "false", None, "unknown"),
    ("malformed-harness", "false", None, "unknown"),
    ("missing-raw", "false", None, "unknown"),
    ("malformed-raw", "false", None, "unknown"),
    ("malformed-attributes", "false", None, "unknown"),
    ("indexed-success", "false", "succeeded", "succeeded"),
    ("indexed-failure", "true", "failed", "failed"),
    ("indexed-unknown", "false", "unknown", "unknown"),
]


def historical_payload(case, success):
    payload = result(success=success)
    if case == "cli-false":
        payload["harness"]["name"] = "codex_cli"
    elif case == "missing-success":
        payload["raw"]["attributes"].pop("success")
    elif case == "wrong-marker":
        payload["raw"]["attributes"]["event.name"] = "unrelated.result"
    elif case == "other-harness":
        payload["harness"]["name"] = "claude_code"
    elif case == "missing-harness":
        payload.pop("harness")
    elif case == "malformed-harness":
        payload["harness"] = ["codex_desktop"]
    elif case == "missing-raw":
        payload.pop("raw")
    elif case == "malformed-raw":
        payload["raw"] = [payload["raw"]["attributes"]]
    elif case == "malformed-attributes":
        payload["raw"]["attributes"] = [payload["raw"]["attributes"]]
    return payload


@pytest.mark.parametrize(
    "case,success,indexed,expected",
    OUTCOME_CASES,
    ids=[row[0] for row in OUTCOME_CASES],
)
async def test_historical_outcome_types_and_indexed_precedence(
    client,
    device_client,
    db_session,
    test_workspace,
    test_board,
    case,
    success,
    indexed,
    expected,
):
    seed = result(success="true")
    session, [row], _, _ = await historical_session(
        client,
        device_client,
        db_session,
        test_workspace,
        test_board,
        [seed],
        indexed={seed["event"]["id"]: indexed},
    )
    # Malformed containers are read-safety controls arranged in stored JSON;
    # they are not claims that today's ingest accepts those shapes.
    row.event = historical_payload(case, success)
    await db_session.flush()
    native = codex_tool_result(row.event)
    signal = indexed or (native.outcome if native else None)
    assert (signal if signal in {"failed", "succeeded"} else "unknown") == expected
    page = await calls(client, session.id)
    assert page["items"][0]["outcome"] == expected
    failures = await calls(client, session.id, "?filter=failures")
    shape = await rhythm(client, session.id)
    assert RAW_SENTINEL not in json.dumps([page, failures, shape])
    assert [item["key"] for item in failures["items"]] == (
        [page["items"][0]["key"]] if expected == "failed" else []
    )
    assert page["turns"][0]["failure_count"] == int(expected == "failed")
    assert sum(bucket["error"] for bucket in shape["buckets"]) == int(
        expected == "failed"
    )


@pytest.mark.parametrize("level", ["metadata", "standard"])
@pytest.mark.parametrize("open_session", [False, True])
async def test_discarded_historical_outcome_is_not_recovered_from_current_mapping(
    client, device_client, db_session, test_workspace, test_board, level, open_session
):
    session, [row], _, _ = await historical_session(
        client,
        device_client,
        db_session,
        test_workspace,
        test_board,
        [result()],
        level=level,
    )
    assert "raw" not in row.event
    if open_session:
        session.last_event_at = datetime.now(timezone.utc)
        await db_session.flush()
    changed = await client.patch(
        f"{ME}/{session.installation_id}/mappings/{session.mapping_id}",
        json={"content_level": "full"},
    )
    assert changed.status_code == 200
    page = await calls(client, session.id)
    assert page["items"][0]["outcome"] == ("running" if open_session else "unknown")
    assert (await calls(client, session.id, "?filter=failures"))["items"] == []
    assert page["turns"][0]["failure_count"] == 0
    assert (
        sum(bucket["error"] for bucket in (await rhythm(client, session.id))["buckets"])
        == 0
    )


async def test_historical_failure_pages_keep_call_order_and_whole_turn_totals(
    client, device_client, db_session, test_workspace, test_board
):
    events, indexed = [prompt(0), prompt(10)], {}
    failed_ids = set()
    for number in range(12):
        call_id = f"call-{number:02d}"
        first = 1 + number if number < 9 else 12  # equal-time newest anchors
        start = call_started(call_id, first)
        finish = result(call_id, 30 + number, "false" if number % 3 != 1 else "true")
        events += [start, finish]
        if number % 3 != 1:
            failed_ids.add(call_id)
        if number % 2:
            indexed[finish["event"]["id"]] = (
                "failed" if number % 3 != 1 else "succeeded"
            )
    events.append(result("call-00", 50))  # a second failed event still counts one call
    session, _, _, _ = await historical_session(
        client,
        device_client,
        db_session,
        test_workspace,
        test_board,
        events,
        indexed=indexed,
    )
    ordinary = await calls(client, session.id)
    expected = [item for item in ordinary["items"] if item["outcome"] == "failed"]
    assert {item["call_id"] for item in expected} == failed_ids
    pages = [await calls(client, session.id, "?filter=failures&limit=2")]
    while pages[-1]["next_cursor"]:
        assert len(pages) < 6, "failure pagination did not terminate"
        pages.append(
            await calls(
                client,
                session.id,
                "?filter=failures&limit=2&cursor=" + pages[-1]["next_cursor"],
            )
        )
    actual = [item for page in reversed(pages) for item in page["items"]]
    assert [item["key"] for item in actual] == [item["key"] for item in expected]
    assert [item["call_id"] for item in actual] == [
        "call-00",
        "call-02",
        "call-03",
        "call-05",
        "call-06",
        "call-08",
        "call-09",
        "call-11",
    ]
    assert len(pages) == 4 and all(len(page["items"]) == 2 for page in pages)
    expected_by_turn = {1: 6, 2: 2}
    for page in [ordinary, *pages]:
        for turn in page["turns"]:
            assert turn["failure_count"] == expected_by_turn[turn["turn_index"]]
    oldest = next(item for item in actual if item["call_id"] == "call-00")
    assert oldest["turn_index"] == 1 and oldest["event_count"] == 3
    assert (
        sum(bucket["error"] for bucket in (await rhythm(client, session.id))["buckets"])
        == 8
    )


async def test_failed_event_counter_stays_distinct_from_failed_call_count(
    client, device_client, db_session, test_workspace, test_board
):
    events = [result(seconds=2), result(seconds=3)]
    session, _, _, _ = await historical_session(
        client,
        device_client,
        db_session,
        test_workspace,
        test_board,
        events,
        indexed={event["event"]["id"]: "failed" for event in events},
    )
    page = await calls(client, session.id)
    assert len(page["items"]) == 1 and page["turns"][0]["failure_count"] == 1
    assert (
        sum(bucket["error"] for bucket in (await rhythm(client, session.id))["buckets"])
        == 1
    )
    assert (await client.get(f"{SESSIONS}/{session.id}")).json()["error_count"] == 2


async def test_historical_reads_and_capture_replay_do_not_rewrite_evidence(
    client, device_client, db_session, test_workspace, test_board
):
    session, _, token, captures = await historical_session(
        client, device_client, db_session, test_workspace, test_board, [result()]
    )
    before = await stored_snapshot(db_session, session.id)
    for _ in range(2):
        for suffix in ["/calls", "/calls?filter=failures", "/rhythm"]:
            response = await client.get(f"{SESSIONS}/{session.id}{suffix}")
            assert response.status_code == 200
            assert RAW_SENTINEL not in response.text
    assert await stored_snapshot(db_session, session.id) == before
    await upload(device_client, token, captures)
    assert await stored_snapshot(db_session, session.id) == before
    changed = copy.deepcopy(captures[0])
    changed["events"][0]["raw"]["attributes"]["success"] = "true"
    response = await device_client.post(
        "/api/companion/ingest",
        json={"records": [changed]},
        headers={"Authorization": "Bearer " + token},
    )
    assert response.status_code == 200
    assert response.json()["rejected"][0]["reason"] == "conflict"
    # Conflicting ingest may record a capture gap; reads and exact replay did not.
    [stored] = list(
        await db_session.scalars(
            select(AgentSessionEvent).where(AgentSessionEvent.session_id == session.id)
        )
    )
    assert stored.outcome is None
    assert stored.event["raw"]["attributes"]["success"] == "false"


async def test_historical_call_queries_keep_owner_and_workspace_boundaries(
    client,
    agent_client,
    device_client,
    db_session,
    test_workspace,
    test_board,
    test_user,
    second_user,
):
    session, _, _, _ = await historical_session(
        client, device_client, db_session, test_workspace, test_board, [result()]
    )
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=second_user.id,
            role=WorkspaceRole.owner,
        )
    )
    other_workspace = Workspace(
        name="Other", slug="other-history", created_by=test_user.id
    )
    db_session.add(other_workspace)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=other_workspace.id,
            user_id=test_user.id,
            role=WorkspaceRole.owner,
        )
    )
    await db_session.flush()
    for suffix in ["/calls", "/calls?filter=failures", "/rhythm"]:
        async with as_user(db_session, second_user) as other:
            assert (
                await other.get(f"{SESSIONS}/{session.id}{suffix}")
            ).status_code == 404
        assert (
            await agent_client.get(f"{SESSIONS}/{session.id}{suffix}")
        ).status_code == 403
        assert (
            await client.get(
                f"/api/workspaces/other-history/sessions/{session.id}{suffix}"
            )
        ).status_code == 404
    await db_session.execute(
        delete(WorkspaceMember).where(
            WorkspaceMember.workspace_id == test_workspace.id,
            WorkspaceMember.user_id == test_user.id,
        )
    )
    await db_session.flush()
    for suffix in ["/calls", "/calls?filter=failures", "/rhythm"]:
        assert (await client.get(f"{SESSIONS}/{session.id}{suffix}")).status_code == 403


async def test_a_legacy_failure_in_another_event_wins_over_indexed_call_success(
    client, device_client, db_session, test_workspace, test_board
):
    succeeded, failed = result(seconds=2, success="true"), result(seconds=3)
    session, _, _, _ = await historical_session(
        client,
        device_client,
        db_session,
        test_workspace,
        test_board,
        [succeeded, failed],
        indexed={succeeded["event"]["id"]: "succeeded"},
    )
    page = await calls(client, session.id)
    assert len(page["items"]) == 1 and page["items"][0]["outcome"] == "failed"
    assert (await calls(client, session.id, "?filter=failures"))["items"] == page[
        "items"
    ]
    assert page["turns"][0]["failure_count"] == 1


async def test_matching_native_ids_in_another_session_do_not_supply_a_failure(
    client, device_client, db_session, test_workspace, test_board
):
    await historical_session(
        client, device_client, db_session, test_workspace, test_board, [result()]
    )
    session, _, _, _ = await historical_session(
        client,
        device_client,
        db_session,
        test_workspace,
        test_board,
        [result(success="true")],
    )
    page = await calls(client, session.id)
    assert page["items"][0]["outcome"] == "succeeded"
    assert (await calls(client, session.id, "?filter=failures"))["items"] == []
    assert page["turns"][0]["failure_count"] == 0
    assert (
        sum(bucket["error"] for bucket in (await rhythm(client, session.id))["buckets"])
        == 0
    )


async def test_historical_queries_keep_a_constant_number_of_statements(
    client, device_client, db_session, test_workspace, test_board
):
    async def counts_for(call_count):
        session, _, _, _ = await historical_session(
            client,
            device_client,
            db_session,
            test_workspace,
            test_board,
            [result(f"call-{number}", number + 1) for number in range(call_count)],
        )
        counts = []
        for suffix in [
            "/calls?limit=2",
            "/calls?limit=2&filter=failures",
            "/rhythm?buckets=4",
        ]:
            count = 0

            def counted(*_):
                nonlocal count
                count += 1

            engine = db_session.get_bind()
            sa_event.listen(engine, "before_cursor_execute", counted)
            try:
                response = await client.get(f"{SESSIONS}/{session.id}{suffix}")
            finally:
                sa_event.remove(engine, "before_cursor_execute", counted)
            assert response.status_code == 200
            counts.append(count)
        return counts

    small, large = await counts_for(3), await counts_for(120)
    assert small == large
    assert max(small[:2]) <= 12 and small[2] <= 10


async def test_work_filtered_historical_turn_counts_include_other_calls(
    client, device_client, db_session, test_workspace, test_board, test_card
):
    session, _, _, _ = await historical_session(
        client,
        device_client,
        db_session,
        test_workspace,
        test_board,
        [
            prompt(0),
            result("worked", 1),
            result("other-failure", 2),
            result("success", 3, "true"),
        ],
    )
    invocation = uuid.uuid4()
    await work_under_invocation(client, test_board, test_card, invocation)
    response = await client.post(
        "/api/me/mcp-invocations",
        json=outcome(
            invocation,
            harness="codex_cli",
            native_call_id="worked",
            started_at=(T0 + timedelta(seconds=1)).isoformat(),
            completed_at=(T0 + timedelta(seconds=2)).isoformat(),
        ),
    )
    assert response.status_code == 200
    page = await calls(client, session.id, "?filter=work&limit=1")
    assert [item["call_id"] for item in page["items"]] == ["worked"]
    assert page["items"][0]["outcome"] == "failed"
    assert page["turns"][0]["call_count"] == 3
    assert page["turns"][0]["failure_count"] == 2
