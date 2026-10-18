# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Authorization is a property of the delivered event and current principal."""

import json
import uuid
from datetime import datetime, timezone

import pytest
import websockets
from sqlalchemy import select, text

from app.models.api_key import ApiKey
from tests.routers.agents.event_authority_support import (
    OBSERVER,
    RECEIPT,
    _receipt_case_fixture,  # noqa: F401
    _wire_case_fixture,  # noqa: F401
    db_engine,  # noqa: F401
)
from tests.test_agent_sessions import FIXTURE_EVENTS, record

pytestmark = [pytest.mark.slow, pytest.mark.timeout(40)]
UNSAFE = ["*.*", "?*", "execution.?*", "[e]xecution.*", "execution*",
          "execution.completed", "agent.status_changed", "approval.created"]


@pytest.mark.parametrize("role", ["member", "viewer"])
@pytest.mark.parametrize("pattern", UNSAFE)
async def test_nonobserver_pattern_cannot_deliver_sensitive_namespace(wire_case, role, pattern):
    f = wire_case
    await f.member_role(role)
    reader = await f.connect("recipient", [pattern, "column.*", "activity.*", RECEIPT])
    owner = await f.connect("curator", ["*"])
    marker = "observer-" + uuid.uuid4().hex
    for name in OBSERVER:
        await f.publish(name, {"marker": marker})
    for name in ["column.updated", "activity.card.updated"]:
        await f.publish(name, {"marker": marker})
    await f.barrier([reader, owner])
    assert all(any(e["payload"].get("marker") == marker for e in owner.events(name)) for name in OBSERVER)
    leaked = [e for e in reader.frames if e.get("event") in OBSERVER and e["payload"].get("marker") == marker]
    assert leaked == [], {"pattern": pattern, "role": role, "leaked": leaked}
    assert all(any(e["payload"].get("marker") == marker for e in reader.events(name))
               for name in ["column.updated", "activity.card.updated"])
    denied = [x for x in reader.frames if x.get("type") == "subscription_denied"]
    assert any(x.get("error_code") == "admin_required" and pattern in x.get("patterns", []) for x in denied)


@pytest.mark.parametrize("actor", ["owner", "admin", "agent", "viewer_agent"])
async def test_current_observers_keep_namespaces_and_board_sync(wire_case, actor):
    f = wire_case
    await f.member_role("admin" if actor == "admin" else "viewer" if actor == "viewer_agent" else "member")
    key = "curator" if actor == "owner" else "recipient" if actor == "admin" else "agent"
    reader = await f.connect(key, ["*"])
    marker = uuid.uuid4().hex
    for name in OBSERVER:
        await f.publish(name, {"marker": marker})
    await f.barrier([reader])
    assert all(any(e["payload"].get("marker") == marker for e in reader.events(name)) for name in OBSERVER)


@pytest.mark.parametrize("role", ["member", "viewer"])
@pytest.mark.parametrize("credential", ["recipient", "session"])
async def test_exact_receipt_exception_remains_readable_and_body_free(wire_case, role, credential):
    f = wire_case
    await f.member_role(role)
    reader = await f.connect(credential, [RECEIPT, "execution.*"])
    owner = await f.connect("curator", ["*"])
    execution, payload = await f.begin_receipt()
    response = await f.case.http.post(f.case.execution_path(execution["id"]) + "/context-receipts",
                                    json=payload, headers=f.case.headers["agent"])
    assert response.status_code == 201, response.text
    receipt = response.json()
    expected = {"execution_id": execution["id"], "workspace_id": f.case.workspace["id"],
                "receipt_id": receipt["id"], "ordinal": 1}
    await reader.until(lambda e: e.get("event") == RECEIPT and e.get("payload") == expected)
    await owner.until(lambda e: e.get("event") == RECEIPT and e.get("payload") == expected)
    read = await f.case.receipt(execution, receipt["id"])
    assert read.status_code == 200, read.text
    assert any(e.get("type") == "subscription_denied" and e.get("patterns") == ["execution.*"] for e in reader.frames)
    assert reader.events("execution.started") == []
    for client in [reader, owner]:
        for frame in client.events(RECEIPT):
            assert set(frame) == {"event", "payload", "timestamp", "event_id"}
            assert frame["payload"] == expected
        assert "PRIVATE_WIRE_PROMPT" not in json.dumps(client.frames)


@pytest.mark.parametrize("role", ["member", "viewer"])
@pytest.mark.parametrize("remote", [False, True])
async def test_demotion_filters_previously_authorized_patterns_at_delivery(wire_case, role, remote):
    f = wire_case
    await f.member_role("admin")
    reader = await f.connect("recipient", ["*"])
    owner = await f.connect("curator", ["*"])
    before = uuid.uuid4().hex
    await f.publish("execution.completed", {"marker": before}, remote=remote)
    await f.barrier([reader, owner])
    assert any(e["payload"].get("marker") == before for e in reader.events("execution.completed"))
    await f.member_role(role)
    after = uuid.uuid4().hex
    for name in OBSERVER:
        await f.publish(name, {"marker": after}, remote=remote)
    receipt = {"execution_id": str(uuid.uuid4()), "workspace_id": f.case.workspace["id"],
               "receipt_id": str(uuid.uuid4()), "ordinal": 1}
    await f.publish(RECEIPT, receipt, remote=remote)
    await f.barrier([reader, owner])
    assert any(e["payload"] == receipt for e in reader.events(RECEIPT))
    assert all(any(e["payload"].get("marker") == after for e in owner.events(name)) for name in OBSERVER)
    assert not any(e.get("event") in OBSERVER and e["payload"].get("marker") == after for e in reader.frames)
    assert reader.closed is None, "A demoted current member retains ordinary board and receipt access"


@pytest.mark.parametrize("revocation", ["membership", "session_membership", "agent_membership", "agent_inactive", "agent_scope", "agent_deleted", "human_key", "agent_key"])
async def test_committed_revocation_closes_live_socket_before_next_matching_event(wire_case, revocation):
    f = wire_case
    actor = "agent" if revocation.startswith("agent_") else "session" if revocation == "session_membership" else "recipient"
    reader = await f.connect(actor, [RECEIPT])
    owner = await f.connect("curator", ["*"])
    if revocation in {"membership", "session_membership", "agent_membership"}:
        response = await f.case.http.delete(
            f"/api/workspaces/{f.case.workspace['slug']}/members/{f.case.recipient_id}", headers=f.case.headers["curator"])
        assert response.status_code == 204, response.text
    elif revocation in {"human_key", "agent_key"}:
        async with f.case.factory() as db:
            key_id = await db.scalar(select(ApiKey.id).where(ApiKey.name == actor))
        assert key_id is not None
        response = await f.case.http.delete(f"/api/me/api-keys/{key_id}", headers=f.case.headers["recipient"])
        assert response.status_code == 204, response.text
    elif revocation == "agent_deleted":
        response = await f.case.http.delete(f"/api/agents/{f.case.agent_id}/hard", headers=f.case.headers["recipient"])
        assert response.status_code == 204, response.text
    else:
        changes = {"is_active": False} if revocation == "agent_inactive" else {"allowed_workspaces": ["foreign"]}
        response = await f.case.http.patch(f"/api/agents/{f.case.agent_id}", json=changes, headers=f.case.headers["recipient"])
        assert response.status_code == 200, response.text
    marker = "after-revocation-" + uuid.uuid4().hex
    await f.publish("card.updated", {"marker": marker})
    await owner.until(lambda e: e.get("payload", {}).get("marker") == marker)
    leaked = await reader.until(lambda e: e.get("payload", {}).get("marker") == marker, allow_closed=True)
    assert leaked is None, {"revocation": revocation, "unauthorized_frame": leaked}
    assert reader.closed is not None and reader.closed[0] in {4001, 4002}
    with pytest.raises(websockets.InvalidStatus) as rejected:
        await websockets.connect(f.ws_base + f"/ws/workspaces/{f.case.workspace['slug']}/events",
                                 additional_headers=f.case.headers[actor], open_timeout=3)
    assert rejected.value.response.status_code == 403


async def test_private_internal_and_workspace_filters_survive_authority_checks(wire_case):
    f = wire_case
    human = await f.connect("recipient", ["agent_session.updated", "companion_installation.updated",
                                          "notification.created", "api_key.first_used"])
    agent = await f.connect("agent", ["*"])
    owner = await f.connect("curator", ["*"])
    foreign = await f.connect("recipient", [], foreign=True)
    marker = uuid.uuid4().hex
    for name in ["agent_session.updated", "companion_installation.updated"]:
        await f.publish(name, {"owner_id": f.case.recipient_id, "marker": marker})
    for name, key in [("notification.created", "recipient_user_id"), ("api_key.first_used", "user_id")]:
        await f.publish(name, {key: f.case.recipient_id, "marker": marker})
    for name in ["agent.restart_probe", "agent.restart_ack"]:
        await f.publish(name, {"marker": marker})
    await f.barrier([human, agent, owner])
    await f.barrier([foreign], foreign=True)
    assert any(e["payload"].get("marker") == marker for e in human.events("agent_session.updated"))
    assert any(e["payload"].get("marker") == marker for e in human.events("notification.created"))
    assert not any(e.get("event") in {"agent_session.updated", "companion_installation.updated"}
                   and e["payload"].get("marker") == marker for e in agent.frames)
    assert not any(e.get("payload", {}).get("marker") == marker for e in owner.frames + foreign.frames)
    assert all(not client.events("agent.restart_probe") and not client.events("agent.restart_ack")
               for client in [human, agent, owner, foreign])


async def test_private_mutations_reach_owner_but_not_another_admin_or_linked_agent(wire_case):
    f = wire_case
    await f.member_role("admin")
    member = await f.case.http.post(
        f"/api/workspaces/{f.case.workspace['slug']}/members",
        json={"email": "outsider@example.test", "role": "admin"},
        headers=f.case.headers["curator"],
    )
    assert member.status_code == 201, member.text
    human = await f.connect("session", ["*"])
    other_admin = await f.connect("outsider", ["*"])
    agent = await f.connect("agent", ["*"])

    installations = "/api/me/companion/installations"
    enrollment = await f.case.http.post(
        installations,
        json={"installation_id": str(uuid.uuid4()), "name": "Private capture device",
              "platform": "linux-amd64"},
        headers=f.case.headers["session"],
    )
    assert enrollment.status_code == 201, enrollment.text
    installation = enrollment.json()
    mapping = await f.case.http.post(
        f"{installations}/{installation['installation_id']}/mappings",
        json={"workspace_id": f.case.workspace["id"], "board_id": f.case.board_id,
              "root_path": "/synthetic/project", "content_level": "standard"},
        headers=f.case.headers["session"],
    )
    assert mapping.status_code == 201, mapping.text
    native_session = "private-observer-session-" + uuid.uuid4().hex
    captured = record(FIXTURE_EVENTS[:1], mapping.json()["id"], session=native_session)
    captured["captured_at"] = datetime.now(timezone.utc).isoformat()
    captured["events"][0]["timestamp"] = captured["captured_at"]
    captured["events"][0]["message"] = "PRIVATE_OBSERVER_CAPTURE_BODY"
    ingest = await f.case.http.post(
        "/api/companion/ingest", json={"records": [captured]},
        headers={"Authorization": "Bearer " + installation["device_token"]},
    )
    assert ingest.status_code == 200, ingest.text
    assert ingest.json()["acknowledged"] == [captured["capture_id"]]
    assert ingest.json()["rejected"] == []
    received_session = await human.until(lambda e: e.get("event") == "agent_session.updated")
    session_payload = received_session["payload"]
    assert set(session_payload) == {"owner_id", "session_id", "workspace_id", "reason"}
    assert session_payload["owner_id"] == f.case.recipient_id
    assert session_payload["workspace_id"] == f.case.workspace["id"]
    # The positive side is a committed capture, not a synthetic event injection.
    stored = await f.case.http.get(
        f"/api/workspaces/{f.case.workspace['slug']}/sessions/{session_payload['session_id']}",
        headers=f.case.headers["session"],
    )
    assert stored.status_code == 200, stored.text
    assert stored.json()["native_session_id"] == native_session

    renamed = await f.case.http.patch(
        f"{installations}/{installation['installation_id']}",
        json={"name": "PRIVATE_OBSERVER_DEVICE_NAME"}, headers=f.case.headers["session"],
    )
    assert renamed.status_code == 200, renamed.text
    device_event = await human.until(lambda e: e.get("event") == "companion_installation.updated")
    assert device_event["payload"] == {
        "owner_id": f.case.recipient_id, "installation_id": installation["installation_id"],
        "reason": "renamed",
    }

    board_path = f"/api/workspaces/{f.case.workspace['slug']}/boards/{f.case.board_id}"
    participant = await f.case.http.post(
        f"{board_path}/cards/{f.case.card_id}/participants",
        json={"user_id": f.case.recipient_id, "role": "hero"},
        headers=f.case.headers["curator"],
    )
    assert participant.status_code == 201, participant.text
    notification = await human.until(lambda e: e.get("event") == "notification.created")
    assert notification["payload"]["recipient_user_id"] == f.case.recipient_id
    assert notification["payload"]["category"] == "card_participant_changed"
    assert notification["payload"]["link"]["card_id"] == f.case.card_id

    # FIFO barriers prove both unauthorized observers processed the mutation
    # sequence; a timeout with no frames would also pass on a broken connection.
    await f.barrier([human, other_admin, agent])
    for observer in [human, other_admin]:
        assert not any(e.get("type") == "subscription_denied" for e in observer.frames)
        assert any(e["payload"].get("entity_id") == f.case.card_id
                   for e in observer.events("activity.card.updated"))
    private_names = {"agent_session.updated", "companion_installation.updated", "notification.created"}
    assert not any(e.get("event") in private_names for e in other_admin.frames)
    assert not any(e.get("event") in private_names - {"notification.created"} for e in agent.frames)
    for observer in [human, other_admin, agent]:
        wire = json.dumps(observer.frames)
        for secret in [installation["device_token"], installation["token_prefix"], native_session,
                       "PRIVATE_OBSERVER_CAPTURE_BODY", "PRIVATE_OBSERVER_DEVICE_NAME"]:
            assert secret not in wire


@pytest.mark.parametrize("request_wildcard", [False, True], ids=["wildcard-absent", "wildcard-denied"])
async def test_real_domain_mutations_and_notifications_keep_named_subscriptions(wire_case, request_wildcard):
    f = wire_case
    patterns = ["activity.note.*", "activity.resource.*", "notification.created"]
    reader = await f.connect("session", [*patterns, *(["*"] if request_wildcard else [])])
    board_path = f"/api/workspaces/{f.case.workspace['slug']}/boards/{f.case.board_id}"
    card_path = f"{board_path}/cards/{f.case.card_id}"
    participant = await f.case.http.post(
        f"{card_path}/participants", json={"user_id": f.case.recipient_id, "role": "hero"},
        headers=f.case.headers["curator"],
    )
    assert participant.status_code == 201, participant.text
    card = await f.case.http.patch(
        card_path, json={"title": "Named subscription card"}, headers=f.case.headers["curator"],
    )
    assert card.status_code == 200, card.text
    note = await f.case.http.post(
        f"{board_path}/notes", json={"title": "Named subscription note", "content": "Body stays in the note"},
        headers=f.case.headers["curator"],
    )
    assert note.status_code == 201, note.text
    resource = await f.case.http.post(
        f"{board_path}/resources", json={"name": "Named subscription folder", "resource_type": "folder"},
        headers=f.case.headers["curator"],
    )
    assert resource.status_code == 201, resource.text
    await f.barrier([reader])

    for name, entity_id in [("card.updated", f.case.card_id),
                            ("activity.note.created", note.json()["id"]),
                            ("activity.resource.created", resource.json()["id"])]:
        assert any(e["payload"].get("entity_id") == entity_id for e in reader.events(name)), name
    notifications = reader.events("notification.created")
    assert notifications, "The real participant/card mutations must produce the recipient's live push"
    assert all(e["payload"]["recipient_user_id"] == f.case.recipient_id for e in notifications)
    denied = [e for e in reader.frames if e.get("type") == "subscription_denied"]
    assert bool(denied) is request_wildcard
    if request_wildcard:
        assert denied[0]["patterns"] == ["*"]
    assert reader.closed is None


@pytest.mark.parametrize("malformation", ["extra", "missing", "ordinal_bool", "ordinal_zero", "ordinal_negative",
                                        "ordinal_string", "ordinal_float", "execution_id", "receipt_id",
                                        "workspace_id", "foreign_workspace"])
async def test_receipt_exception_drops_malformed_event_for_every_socket_and_keeps_valid_delivery(wire_case, malformation):
    f = wire_case
    clients = [await f.connect("recipient", [RECEIPT]), await f.connect("curator", ["*"]),
               await f.connect("agent", ["*"])]
    valid = {"execution_id": str(uuid.uuid4()), "workspace_id": f.case.workspace["id"],
             "receipt_id": str(uuid.uuid4()), "ordinal": 1}
    malformed = dict(valid)
    if malformation == "extra":
        malformed["input_prompt"] = "PRIVATE_MALFORMED_RECEIPT_BODY"
    elif malformation == "missing":
        malformed.pop("receipt_id")
    elif malformation.startswith("ordinal_"):
        malformed["ordinal"] = {"ordinal_bool": True, "ordinal_zero": 0, "ordinal_negative": -1,
                                "ordinal_string": "1", "ordinal_float": 1.0}[malformation]
    elif malformation == "foreign_workspace":
        malformed["workspace_id"] = f.case.foreign_workspace["id"]
    else:
        malformed[malformation] = "not-a-uuid"
    await f.publish(RECEIPT, malformed)
    await f.publish(RECEIPT, valid)
    await f.barrier(clients)
    for client in clients:
        assert [e["payload"] for e in client.events(RECEIPT)] == [valid], malformation
        assert client.closed is None, "Malformed publication must not close a still-authorized reader"


async def test_delivery_database_failure_closes_without_reusing_connect_time_authority(wire_case):
    f = wire_case
    reader = await f.connect("recipient", [RECEIPT])
    async with f.case.factory() as db:
        await db.execute(text("DROP TABLE workspace_members CASCADE"))
        await db.commit()
    marker = uuid.uuid4().hex
    await f.publish("card.updated", {"marker": marker})
    leaked = await reader.until(lambda e: e.get("payload", {}).get("marker") == marker, allow_closed=True)
    assert leaked is None
    assert reader.closed is not None and reader.closed[0] in {4001, 4002}
