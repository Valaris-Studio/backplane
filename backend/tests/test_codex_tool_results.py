# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import copy
import uuid

import pytest

from app.schemas.beacon import BeaconEvent, promote
from app.models.agent_session import AgentSessionEvent
from app.services.session_calls import _call_item
from app.services.session_call_content import reported_duration_ms
from tests.test_agent_sessions import (
    SESSIONS,
    device_client as device_client_fixture,
    enroll,
    links,
    outcome,
    record,
    session_id,
    upload,
    work_under_invocation,
)

device_client = device_client_fixture


def test_previously_stored_codex_result_is_read_as_completed_mcp_call():
    from datetime import datetime, timezone

    event = AgentSessionEvent(
        event=codex_result(),
        action="tool.invoked",
        tool_name="get_note",
        native_tool_call_id="exec-native-call",
        occurred_at=datetime.now(timezone.utc),
    )
    call = _call_item("c:exec-native-call", [event], 0, [], True)
    assert call.outcome == "succeeded"
    assert (call.kind, call.mcp_server, call.mcp_tool) == (
        "mcp",
        "backplane",
        "get_note",
    )
    assert call.duration_ms == 478
    assert event.outcome is None  # reading does not rewrite captured evidence


def codex_result(success="true", **attributes):
    return {
        "timestamp": "2026-09-24T02:21:29Z",
        "event": {"id": "codex-result", "action": "tool.invoked", "category": "tool"},
        "harness": {"name": "codex_desktop", "collection_method": "otlp"},
        "tool": {"name": "get_note"},
        "gen_ai": {"tool": {"name": "get_note", "call": {"id": "exec-native-call"}}},
        "raw": {
            "attributes": {
                "event.name": "codex.tool_result",
                "mcp_server": "backplane",
                "tool_name": "get_note",
                "success": success,
                "duration_ms": "478",
                **attributes,
            }
        },
    }


@pytest.mark.parametrize(
    "success,expected",
    [
        ("true", "succeeded"),
        (True, "succeeded"),
        ("false", "failed"),
        (False, "failed"),
    ],
)
def test_codex_result_promotes_native_completion_and_mcp_identity(success, expected):
    event = codex_result(success)
    original = copy.deepcopy(event)
    promoted = promote(event, BeaconEvent.model_validate(event), "otlp")
    assert promoted.outcome == expected
    assert promoted.mcp_server == "backplane"
    assert promoted.mcp_tool == "get_note"
    assert promoted.native_tool_call_id == "exec-native-call"
    assert event == original


@pytest.mark.parametrize("success", ["yes", "0", "False", 1, None, {}])
def test_codex_unknown_success_is_not_a_completion(success):
    event = codex_result(success)
    assert promote(event, BeaconEvent.model_validate(event), "otlp").outcome is None


def test_other_harness_cannot_supply_codex_result_metadata():
    event = codex_result()
    event["harness"]["name"] = "claude_code"
    promoted = promote(event, BeaconEvent.model_validate(event), "hook")
    assert promoted.outcome is None
    assert promoted.mcp_server is None


@pytest.mark.parametrize(
    "value,expected",
    [
        ("478", 478),
        (478, 478),
        ("-1", None),
        ("nan", None),
        (True, None),
        (10**1000, None),
        (float("inf"), None),
        (float("nan"), None),
    ],
)
def test_codex_result_duration_handles_native_string_attributes(value, expected):
    assert reported_duration_ms(codex_result(duration_ms=value)) == expected


async def test_codex_result_is_a_completed_mcp_call_after_ingest(
    client, device_client, test_workspace, test_board
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(
        device_client,
        token,
        [record([codex_result()], mapping_id, harness="codex_desktop")],
    )
    sid = await session_id(client)
    page = (await client.get(f"{SESSIONS}/{sid}/calls")).json()
    [call] = page["items"]
    assert call["outcome"] == "succeeded"
    assert call["kind"] == "mcp"
    assert call["mcp_server"] == "backplane"
    assert call["mcp_tool"] == "get_note"


@pytest.mark.parametrize("invocation_first", [False, True])
@pytest.mark.parametrize("entity_type", ["card", "note"])
async def test_codex_result_links_real_server_work_with_a_native_receipt(
    client,
    device_client,
    test_workspace,
    test_board,
    test_card,
    test_note,
    invocation_first,
    entity_type,
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    invocation_id = uuid.uuid4()
    if entity_type == "card":
        await work_under_invocation(client, test_board, test_card, invocation_id)
    else:
        path = f"/api/workspaces/default/notes/{test_note.id}"
        headers = {"X-Backplane-Invocation-ID": str(invocation_id)}
        assert (await client.get(path, headers=headers)).status_code == 200
        assert (
            await client.put(path, headers=headers, json={"title": "Updated note"})
        ).status_code == 200
    receipt = outcome(
        invocation_id, harness="codex_cli", native_call_id="exec-native-call"
    )
    capture = record([codex_result()], mapping_id, harness="codex_desktop")
    if invocation_first:
        assert (
            await client.post("/api/me/mcp-invocations", json=receipt)
        ).status_code == 200
    await upload(device_client, token, [capture])
    if not invocation_first:
        # A captured success alone is not evidence of server-side work.
        assert await links(client, await session_id(client)) == {}
        assert (
            await client.post("/api/me/mcp-invocations", json=receipt)
        ).status_code == 200
    found = await links(client, await session_id(client))
    assert set(found) == {(entity_type, "changed"), (entity_type, "consulted")}
    assert all(link["provenance"] == "exact" for link in found.values())
    await upload(device_client, token, [capture])
    await client.post("/api/me/mcp-invocations", json=receipt)
    assert all(
        link["invocation_count"] == 1
        for link in (await links(client, await session_id(client))).values()
    )
