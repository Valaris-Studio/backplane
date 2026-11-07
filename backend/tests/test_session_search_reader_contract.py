# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import copy
import hashlib
import uuid
from datetime import timedelta

import pytest

from app.models.agent_session import AgentSessionContent
from app.services.session_calls import call_key
from app.services.storage.session_content import LocalContentStore
from tests.rich_capture import declaration
from tests.test_agent_sessions import outcome, work_under_invocation
from tests.test_session_calls import beacon, call_finished, call_started, prompt
from tests.test_session_search import (
    capture as capture_fixture,
    exact_match,
    index_uploaded,
    one_inline,
    retained_event_session,
    search,
    store_contents,
)

capture = capture_fixture
pytestmark = pytest.mark.usefixtures("content_storage")
BODY_PAGE_BYTES = 256 << 10


@pytest.mark.slow
async def test_historical_search_hit_opens_exact_window_and_utf8_body_page(
    client,
    device_client,
    db_session,
    db_engine,
    test_workspace,
    capture,
    content_storage,
):
    path, recent_id = await one_inline(
        client, device_client, db_session, test_workspace, capture, "recent control"
    )
    await store_contents(
        device_client,
        capture,
        [declaration(f"recent {index}".encode(), order=index) for index in range(99)],
    )
    recent = await db_session.get(AgentSessionContent, uuid.UUID(recent_id))
    historical_id = uuid.uuid4()
    matched = "Straße_İ_B02"
    text = "古🙂" * 40_000 + matched + " retained tail" * 30_000
    body = text.encode()
    storage_key = f"reader-contract/{historical_id}/body"
    LocalContentStore(str(content_storage)).put(storage_key, body)
    values = {
        column.name: copy.deepcopy(getattr(recent, column.name))
        for column in AgentSessionContent.__table__.columns
    }
    values.update(
        id=historical_id,
        content_key=hashlib.sha256(historical_id.bytes).hexdigest(),
        inline_text=None,
        preview="古🙂" * 100,
        delivery="upload",
        byte_count=len(body),
        sha256=hashlib.sha256(body).hexdigest(),
        storage_backend="local",
        storage_key=storage_key,
        occurred_at=recent.occurred_at - timedelta(days=60),
        source_order=0,
    )
    # Pre-feature storage has no index row; only B01's single-source writer runs.
    db_session.add(AgentSessionContent(**values))
    await db_session.flush()
    pending = await search(client, path, "strasse_i\u0307_b02")
    assert pending["items"] == []
    assert pending["coverage"]["pending_index"] == {"count": 1, "bytes": len(body)}

    latest = await client.get(f"{path}/contents/window")
    assert latest.status_code == 200, latest.text
    latest_ids = {item["id"] for item in latest.json()["items"]}
    assert len(latest_ids) == 100
    assert recent_id in latest_ids
    assert str(historical_id) not in latest_ids
    first_page = await client.get(f"{path}/contents/{historical_id}/body")
    assert first_page.status_code == 200, first_page.text
    assert first_page.json()["next_offset"] is not None
    assert matched not in first_page.json()["text"]
    assert matched not in values["preview"]

    await index_uploaded(db_session, db_engine, str(historical_id))
    page = await search(client, path, "strasse_i\u0307_b02")
    [hit] = page["items"]
    assert hit["content_id"] == str(historical_id)
    assert page["complete"] and page["coverage"]["index_ready"]
    exact_match(hit, text, matched)
    assert hit["snippet_byte_start"] > BODY_PAGE_BYTES

    anchored = await client.get(
        f"{path}/contents/window",
        params={"mode": "anchor", "anchor_id": hit["content_id"]},
    )
    assert anchored.status_code == 200, anchored.text
    assert anchored.json()["anchor_id"] == hit["content_id"]
    assert anchored.json()["items"][0]["id"] == hit["content_id"]
    opened = await client.get(
        f"{path}/contents/{hit['content_id']}/body",
        params={"offset": hit["snippet_byte_start"]},
    )
    assert opened.status_code == 200, opened.text
    body_page = opened.json()
    page_bytes = body_page["text"].encode()
    assert body_page["offset"] == hit["snippet_byte_start"]
    assert 0 < len(page_bytes) <= BODY_PAGE_BYTES
    assert body_page["next_offset"] == body_page["offset"] + len(page_bytes)
    assert page_bytes == body[body_page["offset"] : body_page["next_offset"]]
    assert page_bytes.startswith(hit["snippet"].encode())
    assert (
        page_bytes[
            hit["byte_start"] - body_page["offset"] : hit["byte_end"]
            - body_page["offset"]
        ].decode()
        == matched
    )


@pytest.mark.parametrize("source", ["call", "prompt", "turn"])
async def test_off_window_search_key_opens_exact_call_or_event(
    client, device_client, db_session, test_workspace, test_board, source
):
    matched = "前🙂 Straße_MATCH"
    text = "older context " * 200 + matched
    if source == "call":
        target = call_finished("old-call", 1, output=text)
        field = "tool.output"
        expected_key = call_key("c:old-call")
    elif source == "prompt":
        target = prompt(1, text)
        field = "prompt.text"
        expected_key = call_key("e:" + target["event"]["id"])
    else:
        target = beacon(
            "agent.turn.completed", 1, category="agent", gen_ai={"output": text}
        )
        field = "gen_ai.output"
        expected_key = call_key("e:" + target["event"]["id"])
    path, _, _ = await retained_event_session(
        client,
        device_client,
        db_session,
        test_workspace,
        test_board,
        [target, call_finished("recent-call", 2)],
    )
    latest = await client.get(f"{path}/calls", params={"limit": 1})
    assert latest.status_code == 200, latest.text
    assert [item["key"] for item in latest.json()["items"]] == [
        call_key("c:recent-call")
    ]
    if source == "turn":
        assert latest.json()["next_cursor"] is None
    else:
        assert latest.json()["next_cursor"]
    [hit] = (await search(client, path, "前🙂 strasse_match"))["items"]
    assert hit["call_key"] == expected_key
    assert hit["event_id"] == target["event"]["id"]
    assert hit["field"] == field
    exact_match(hit, text, matched)

    opened = await client.get(f"{path}/calls/{hit['call_key']}")
    assert opened.status_code == 200, opened.text
    assert opened.json()["key"] == expected_key
    [event] = opened.json()["events"]
    assert event["event_id"] == hit["event_id"]
    original = event["data"]
    for member in field.split("."):
        original = original[member]
    assert original == text


async def test_combined_filters_return_only_exact_failed_work_call_destinations(
    client, device_client, db_session, test_workspace, test_board, test_card
):
    events = []
    for index, (call_id, failed) in enumerate(
        [("linked-failed", True), ("unlinked-failed", True), ("linked-ok", False)]
    ):
        started = call_started(call_id, index * 2, arguments={"query": "filter match"})
        finished = call_finished(call_id, index * 2 + 1, exit_code=int(failed))
        for event in (started, finished):
            event["mcp"] = {"server": "backplane", "tool": "get_card"}
        events.extend([started, finished])
    path, _, _ = await retained_event_session(
        client, device_client, db_session, test_workspace, test_board, events
    )
    for call_id in ("linked-failed", "linked-ok"):
        invocation = uuid.uuid4()
        await work_under_invocation(client, test_board, test_card, invocation)
        response = await client.post(
            "/api/me/mcp-invocations",
            json=outcome(
                invocation,
                native_call_id=call_id,
                started_at="2026-09-24T02:00:02Z",
                completed_at="2026-09-24T02:00:03Z",
            ),
        )
        assert response.status_code == 200, response.text
    assert len((await search(client, path, "filter match"))["items"]) == 3
    page = await search(
        client,
        path,
        "filter match",
        types=["mcp", "prompt"],
        failures_only=True,
        work_only=True,
    )
    [hit] = page["items"]
    assert page["complete"]
    assert hit["call_key"] == call_key("c:linked-failed")
    opened = await client.get(f"{path}/calls/{hit['call_key']}")
    assert opened.status_code == 200, opened.text
    assert {event["event_id"] for event in opened.json()["events"]} == {
        event["event"]["id"] for event in events[:2]
    }


async def test_installation_key_cannot_follow_an_owner_search_hit(
    client,
    device_client,
    db_session,
    test_workspace,
    capture,
    installation_key_client,
):
    path, _ = await one_inline(
        client,
        device_client,
        db_session,
        test_workspace,
        capture,
        "owner private match",
    )
    [hit] = (await search(client, path, "owner private match"))["items"]
    for method, endpoint, options in (
        ("POST", f"{path}/search", {"json": {"q": "owner private match"}}),
        (
            "GET",
            f"{path}/contents/window",
            {
                "params": {"mode": "anchor", "anchor_id": hit["content_id"]},
            },
        ),
        ("GET", f"{path}/contents/{hit['content_id']}/body", {}),
    ):
        response = await installation_key_client.request(method, endpoint, **options)
        assert response.status_code == 403, response.text
        assert response.headers["cache-control"] == "private, no-store"
        assert "owner private match" not in response.text
        assert "coverage" not in response.json()
