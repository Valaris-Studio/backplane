# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import copy
import json
import re
import uuid
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, func, select

from app.database import get_db
from app.main import create_app
from app.models.agent_session import AgentSession, AgentSessionEvent
from app.models.companion import CompanionInstallation, CompanionProjectMapping
from app.schemas.beacon import without_command_content
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole

ME = "/api/me/companion/installations"
INGEST = "/api/companion/ingest"
FIXTURE_EVENTS = [
    event
    for record in json.loads(
        (
            Path(__file__).parent / "fixtures/session_capture/beacon_hooks.json"
        ).read_text()
    )
    for event in record["beacon_events"]
]
SESSION = "sc01-synthetic-session"


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


@pytest.fixture
async def enrolled(client, test_workspace, test_board):
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
                "workspace_id": str(test_workspace.id),
                "board_id": str(test_board.id),
                "root_path": "/synthetic/project",
                # Written against standard; new mappings now default to rich.
                "content_level": "standard",
            },
        )
    ).json()
    return {
        "installation": installation,
        "mapping": mapping,
        "headers": {"Authorization": "Bearer " + installation["device_token"]},
    }


def record(events, mapping_id, *, capture_id=None, **overrides):
    return {
        "capture_id": capture_id or uuid.uuid4().hex,
        "mapping_id": str(mapping_id),
        "harness": "claude_code",
        "harness_version": "2.1.0",
        "collection_method": "hook",
        "native_session_id": SESSION,
        "captured_at": "2026-09-24T02:21:30Z",
        "beacon": {"commit": "b" * 40, "schema_version": "1.0"},
        "events": events,
        **overrides,
    }


async def ingest(device_client, enrolled, records):
    return await device_client.post(
        INGEST, json={"records": records}, headers=enrolled["headers"]
    )


async def only_session(db_session):
    return await db_session.scalar(
        select(AgentSession).execution_options(populate_existing=True)
    )


async def event_count(db_session):
    return await db_session.scalar(select(func.count()).select_from(AgentSessionEvent))


async def test_fixture_session_roundtrip_builds_summary(
    device_client, enrolled, db_session, test_board
):
    mapping_id = enrolled["mapping"]["id"]
    records = [record([event], mapping_id) for event in FIXTURE_EVENTS]
    response = await ingest(device_client, enrolled, records)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "acknowledged": [item["capture_id"] for item in records],
        "rejected": [],
        "dropped": [],
        "history_deleted": [],
        "contents": [],
    }
    session = await only_session(db_session)
    assert session.harness == "claude_code"
    assert session.native_session_id == SESSION
    assert str(session.mapping_id) == mapping_id
    assert session.board_id == test_board.id
    assert session.event_count == 7
    assert session.prompt_count == 1
    assert session.tool_call_count == 2
    assert session.error_count == 1
    assert session.status == "ended" and session.ended_at is not None
    # The fixture carries Beacon's absolute paths; the server keeps none.
    assert session.cwd == "project"
    assert session.repository is None
    assert session.harness_version == "2.1.0"
    assert session.title == "Inspect synthetic fixture token=[REDACTED]"
    assert session.cost_usd is None
    assert session.input_tokens == 0

    retry = await ingest(device_client, enrolled, records)
    assert retry.json()["acknowledged"] == [item["capture_id"] for item in records]
    session = await only_session(db_session)
    assert session.event_count == 7 and session.prompt_count == 1
    assert await event_count(db_session) == 7


async def test_conflicting_capture_is_rejected_without_blocking_the_batch(
    device_client, enrolled, db_session
):
    mapping_id = enrolled["mapping"]["id"]
    first = record(FIXTURE_EVENTS[:1], mapping_id)
    assert (await ingest(device_client, enrolled, [first])).status_code == 200
    changed = {**first, "events": FIXTURE_EVENTS[1:2]}
    fresh = record(FIXTURE_EVENTS[2:3], mapping_id)
    response = await ingest(device_client, enrolled, [changed, fresh])
    assert response.status_code == 200
    assert response.json() == {
        "acknowledged": [fresh["capture_id"]],
        "rejected": [{"capture_id": first["capture_id"], "reason": "conflict"}],
        "dropped": [],
        "history_deleted": [],
        "contents": [],
    }
    assert await event_count(db_session) == 2


async def test_hook_and_otlp_copies_of_one_event_collapse_into_one_session(
    device_client, enrolled, db_session
):
    mapping_id = enrolled["mapping"]["id"]
    otlp_copy = copy.deepcopy(FIXTURE_EVENTS[3])
    otlp_copy["harness"]["collection_method"] = "otlp"
    otlp_copy["sequence"] = 99
    response = await ingest(
        device_client,
        enrolled,
        [
            record([FIXTURE_EVENTS[3]], mapping_id),
            record([otlp_copy], mapping_id, collection_method="otlp"),
        ],
    )
    assert len(response.json()["acknowledged"]) == 2
    assert await db_session.scalar(select(func.count()).select_from(AgentSession)) == 1
    assert await event_count(db_session) == 1
    assert (await only_session(db_session)).event_count == 1


async def test_events_without_beacon_id_deduplicate_by_content(
    device_client, enrolled, db_session
):
    mapping_id = enrolled["mapping"]["id"]
    anonymous = copy.deepcopy(FIXTURE_EVENTS[0])
    del anonymous["event"]["id"]
    await ingest(device_client, enrolled, [record([anonymous], mapping_id)])
    await ingest(device_client, enrolled, [record([anonymous], mapping_id)])
    stored = await db_session.scalar(select(AgentSessionEvent))
    assert await event_count(db_session) == 1
    assert len(stored.event_id) == 64


async def test_usage_and_model_are_summed_and_unknown_cost_stays_null(
    device_client, enrolled, db_session
):
    mapping_id = enrolled["mapping"]["id"]

    def usage_event(event_id, usage, **extra):
        event = copy.deepcopy(FIXTURE_EVENTS[1])
        event["event"]["id"] = event_id
        event["event"]["action"] = "model.response"
        event["gen_ai"] = {"request": {"model": "synthetic-model-1"}, "usage": usage}
        event.update(extra)
        return event

    await ingest(
        device_client,
        enrolled,
        [
            record(
                [
                    usage_event(
                        "u1",
                        {
                            "input_tokens": 100,
                            "output_tokens": 20,
                            "cache_read": {"input_tokens": 5},
                            "cache_creation": {"input_tokens": 7},
                        },
                    )
                ],
                mapping_id,
            )
        ],
    )
    session = await only_session(db_session)
    assert (session.input_tokens, session.output_tokens) == (100, 20)
    assert (session.cache_read_tokens, session.cache_creation_tokens) == (5, 7)
    assert session.cost_usd is None
    assert session.model == "synthetic-model-1"

    await ingest(
        device_client,
        enrolled,
        [
            record(
                [usage_event("u2", {"input_tokens": 1, "cost_usd": 0.25})], mapping_id
            ),
            record([usage_event("u3", {"cost_usd": 0.5})], mapping_id),
        ],
    )
    session = await only_session(db_session)
    assert session.input_tokens == 101
    assert float(session.cost_usd) == pytest.approx(0.75)


async def test_metadata_content_level_stores_no_prompt_or_tool_text(
    client, device_client, enrolled, db_session
):
    installation_id = enrolled["installation"]["installation_id"]
    mapping_id = enrolled["mapping"]["id"]
    await client.patch(
        f"{ME}/{installation_id}/mappings/{mapping_id}",
        json={"content_level": "metadata"},
    )
    tool_event = copy.deepcopy(FIXTURE_EVENTS[3])
    tool_event["command"] = {"command": "cat SYNTHETIC_SECRET_FILE", "exit_code": 0}
    tool_event["file"] = {"path": "/x", "diff": "+SYNTHETIC_DIFF_LINE"}
    response = await ingest(
        device_client,
        enrolled,
        [record([FIXTURE_EVENTS[1], tool_event], mapping_id)],
    )
    assert response.json()["rejected"] == []
    stored = [row.event for row in await db_session.scalars(select(AgentSessionEvent))]
    text = json.dumps(stored)
    for secret in [
        "Inspect synthetic fixture",
        "SYNTHETIC_SECRET_FILE",
        "SYNTHETIC_DIFF_LINE",
        "Synthetic card",
    ]:
        assert secret not in text
    prompt = next(
        event for event in stored if event["event"]["action"] == "prompt.submitted"
    )
    assert prompt["backplane_redactions"]["prompt"]["bytes"] > 0
    assert len(prompt["backplane_redactions"]["prompt"]["sha256"]) == 64
    assert prompt["content"]["included"] is False
    assert prompt["content"]["hash"]
    session = await only_session(db_session)
    assert session.title is None
    assert session.prompt_count == 1


@pytest.mark.parametrize(
    "policy,reason",
    [
        ({"paused": True}, "paused"),
        ({"enabled_agents": ["codex_cli"]}, "agent_disabled"),
        ({"enabled_agents": []}, "agent_disabled"),
        ({"exclude_globs": ["*"]}, "excluded"),
    ],
)
async def test_capture_policy_rejects_records(
    client, device_client, enrolled, db_session, policy, reason
):
    installation_id = enrolled["installation"]["installation_id"]
    await client.patch(f"{ME}/{installation_id}/policy", json=policy)
    item = record(FIXTURE_EVENTS[:1], enrolled["mapping"]["id"])
    response = await ingest(device_client, enrolled, [item])
    assert response.json() == {
        "acknowledged": [],
        "rejected": [{"capture_id": item["capture_id"], "reason": reason}],
        "dropped": [],
        "history_deleted": [],
        "contents": [],
    }
    assert await event_count(db_session) == 0


def _as_harness(events, harness):
    renamed = json.loads(json.dumps(events))
    for event in renamed:
        event["harness"] = {**event.get("harness", {}), "name": harness}
    return renamed


# The desktop writes enabled_agents from its integrations, which have one
# Codex (codex_cli); Codex Desktop's sessions follow that switch.
@pytest.mark.parametrize(
    "enabled_agents,admitted",
    [
        (["claude_code", "codex_cli"], True),
        (["claude_code", "codex_cli", "pi_cli"], True),
        (["claude_code", "pi_cli"], False),
        (["codex_desktop"], False),
    ],
)
async def test_codex_desktop_capture_follows_the_codex_switch(
    client, device_client, enrolled, db_session, enabled_agents, admitted
):
    installation_id = enrolled["installation"]["installation_id"]
    await client.patch(
        f"{ME}/{installation_id}/policy", json={"enabled_agents": enabled_agents}
    )
    item = record(
        _as_harness(FIXTURE_EVENTS[:1], "codex_desktop"),
        enrolled["mapping"]["id"],
        harness="codex_desktop",
        collection_method="otlp",
    )
    response = await ingest(device_client, enrolled, [item])
    if admitted:
        assert response.json()["acknowledged"] == [item["capture_id"]]
        assert await event_count(db_session) == 1
    else:
        assert response.json()["rejected"] == [
            {"capture_id": item["capture_id"], "reason": "agent_disabled"}
        ]
        assert await event_count(db_session) == 0


async def _mapping_of_another_owner(db_session, owner, workspace):
    installation = CompanionInstallation(
        id=uuid.uuid4(),
        owner_id=owner.id,
        name="Someone else's laptop",
        platform="linux-amd64",
        token_hash=uuid.uuid4().hex * 2,
        token_prefix="bpc_xxxx",
        exclude_globs=[],
    )
    db_session.add(installation)
    db_session.add(
        WorkspaceMember(
            workspace_id=workspace.id, user_id=owner.id, role=WorkspaceRole.member
        )
    )
    await db_session.flush()
    mapping = CompanionProjectMapping(
        installation_id=installation.id,
        workspace_id=workspace.id,
        root_path="/synthetic/project",
        origin="explicit",
    )
    db_session.add(mapping)
    await db_session.flush()
    return mapping.id


async def test_mapping_admission_is_per_record(
    client, device_client, enrolled, db_session, test_user, test_workspace, second_user
):
    installation_id = enrolled["installation"]["installation_id"]
    mapping_id = enrolled["mapping"]["id"]
    other = (
        await client.post(
            ME,
            json={
                "installation_id": str(uuid.uuid4()),
                "name": "Other machine",
                "platform": "linux-amd64",
            },
        )
    ).json()
    foreign_mapping = (
        await client.post(
            f"{ME}/{other['installation_id']}/mappings",
            json={"workspace_id": str(test_workspace.id), "root_path": "/other"},
        )
    ).json()
    disabled = (
        await client.post(
            f"{ME}/{installation_id}/mappings",
            json={
                "workspace_id": str(test_workspace.id),
                "root_path": "/disabled",
                "enabled": False,
            },
        )
    ).json()
    other_owner_mapping = await _mapping_of_another_owner(
        db_session, second_user, test_workspace
    )
    good = record(FIXTURE_EVENTS[:1], mapping_id)
    foreign = record(FIXTURE_EVENTS[1:2], foreign_mapping["id"])
    not_yours = record(FIXTURE_EVENTS[5:6], other_owner_mapping)
    off = record(FIXTURE_EVENTS[2:3], disabled["id"])
    missing = record(FIXTURE_EVENTS[3:4], uuid.uuid4())
    response = await ingest(
        device_client, enrolled, [good, foreign, off, missing, not_yours]
    )
    assert response.json() == {
        "acknowledged": [good["capture_id"]],
        "rejected": [
            {"capture_id": foreign["capture_id"], "reason": "mapping_unavailable"},
            {"capture_id": off["capture_id"], "reason": "mapping_disabled"},
            {"capture_id": missing["capture_id"], "reason": "mapping_unavailable"},
            {"capture_id": not_yours["capture_id"], "reason": "mapping_unavailable"},
        ],
        "dropped": [],
        "history_deleted": [],
        "contents": [],
    }

    await db_session.execute(
        delete(WorkspaceMember).where(WorkspaceMember.user_id == test_user.id)
    )
    await db_session.flush()
    later = record(FIXTURE_EVENTS[4:5], mapping_id)
    response = await ingest(device_client, enrolled, [later])
    assert response.json()["rejected"] == [
        {"capture_id": later["capture_id"], "reason": "mapping_unavailable"}
    ]


async def test_invalid_events_reject_only_their_record(device_client, enrolled):
    mapping_id = enrolled["mapping"]["id"]
    no_action = copy.deepcopy(FIXTURE_EVENTS[0])
    del no_action["event"]["action"]
    no_timestamp = copy.deepcopy(FIXTURE_EVENTS[0])
    del no_timestamp["timestamp"]
    wrong_session = copy.deepcopy(FIXTURE_EVENTS[0])
    wrong_session["session"]["id"] = "another-session"
    huge = copy.deepcopy(FIXTURE_EVENTS[0])
    huge["padding"] = "x" * (64 << 10)
    good = record(FIXTURE_EVENTS[:1], mapping_id)
    bad = [
        record([no_action], mapping_id),
        record([no_timestamp], mapping_id),
        record([wrong_session], mapping_id),
        record(FIXTURE_EVENTS[:1], mapping_id, harness="Claude Code"),
        record(FIXTURE_EVENTS[:1], mapping_id, collection_method="scrape"),
        record(FIXTURE_EVENTS[:1] * 257, mapping_id),
    ]
    too_large = record([huge], mapping_id)
    response = await ingest(device_client, enrolled, [good, *bad, too_large])
    assert response.status_code == 200
    assert response.json()["acknowledged"] == [good["capture_id"]]
    assert response.json()["rejected"] == [
        *({"capture_id": item["capture_id"], "reason": "invalid"} for item in bad),
        {"capture_id": too_large["capture_id"], "reason": "too_large"},
    ]
    assert "Synthetic" not in response.text


async def test_unknown_well_formed_harness_is_accepted_once_enabled(
    client, device_client, enrolled, db_session
):
    # New installations enable the known harnesses; a new one needs only a
    # policy change, never a backend release.
    await client.patch(
        f"{ME}/{enrolled['installation']['installation_id']}/policy",
        json={"enabled_agents": ["claude_code", "future_agent"]},
    )
    event = copy.deepcopy(FIXTURE_EVENTS[0])
    event["harness"] = {"name": "future_agent", "collection_method": "plugin"}
    response = await ingest(
        device_client,
        enrolled,
        [
            record(
                [event],
                enrolled["mapping"]["id"],
                harness="future_agent",
                collection_method="plugin",
            )
        ],
    )
    assert response.json()["rejected"] == []
    assert (await only_session(db_session)).harness == "future_agent"


@pytest.mark.parametrize(
    "body",
    [
        b"{not json",
        b"[]",
        b'{"records": []}',
        b'{"records": [{"capture_id": "not-hex"}]}',
        # A fixed id: the parameter is the test id, which pytest-xdist workers
        # must all collect identically.
        json.dumps({"records": [{"capture_id": "0123456789abcdef" * 2}] * 33}).encode(),
    ],
)
async def test_malformed_batches_are_rejected_whole(device_client, enrolled, body):
    response = await device_client.post(
        INGEST,
        content=body,
        headers={**enrolled["headers"], "Content-Type": "application/json"},
    )
    assert response.status_code == 422


async def test_oversized_batch_is_rejected_before_parsing(device_client, enrolled):
    body = b'{"records": [' + b" " * (8 << 20) + b"]}"
    response = await device_client.post(
        INGEST,
        content=body,
        headers={**enrolled["headers"], "Content-Type": "application/json"},
    )
    assert response.status_code == 413


async def test_revoked_installation_cannot_ingest(client, device_client, enrolled):
    await client.delete(f"{ME}/{enrolled['installation']['installation_id']}")
    response = await ingest(
        device_client, enrolled, [record(FIXTURE_EVENTS[:1], enrolled["mapping"]["id"])]
    )
    assert response.status_code == 401


async def test_sessions_are_separated_by_workspace_and_harness(
    client, device_client, enrolled, db_session, second_user
):
    mapping_id = enrolled["mapping"]["id"]
    codex = copy.deepcopy(FIXTURE_EVENTS[0])
    codex["event"]["id"] = "codex-start"
    await ingest(
        device_client,
        enrolled,
        [
            record(FIXTURE_EVENTS[:1], mapping_id),
            record([codex], mapping_id, harness="codex_cli"),
        ],
    )
    sessions = list(await db_session.scalars(select(AgentSession)))
    assert sorted(session.harness for session in sessions) == [
        "claude_code",
        "codex_cli",
    ]


def _summary(session):
    return (
        session.event_count,
        session.prompt_count,
        session.tool_call_count,
        session.error_count,
        session.input_tokens,
        session.output_tokens,
        session.cache_read_tokens,
        session.cache_creation_tokens,
        session.cost_usd,
    )


async def test_counters_advance_only_for_newly_stored_events(
    device_client, enrolled, db_session
):
    mapping_id = enrolled["mapping"]["id"]
    usage = copy.deepcopy(FIXTURE_EVENTS[1])
    usage["event"]["id"] = "usage-1"
    usage["gen_ai"] = {
        "usage": {
            "input_tokens": 10,
            "output_tokens": 2,
            "cache_read": {"input_tokens": 3},
            "cache_creation": {"input_tokens": 4},
            "cost_usd": 0.5,
        }
    }
    first = record([*FIXTURE_EVENTS, usage], mapping_id)
    await ingest(device_client, enrolled, [first])
    counts = _summary(await only_session(db_session))
    assert counts[:8] == (8, 2, 2, 1, 10, 2, 3, 4)

    replay = await ingest(device_client, enrolled, [first])
    assert replay.json()["acknowledged"] == [first["capture_id"]]
    assert _summary(await only_session(db_session)) == counts

    # Existing event ids under new capture_ids (hook/OTLP copies, a rebuilt
    # queue item): acknowledged, stored once, never counted twice.
    copies = [
        record([event], mapping_id, harness_version=None)
        for event in [*FIXTURE_EVENTS, usage]
    ]
    response = await ingest(device_client, enrolled, copies)
    assert len(response.json()["acknowledged"]) == len(copies)
    assert _summary(await only_session(db_session)) == counts
    assert await event_count(db_session) == 8


async def test_out_of_order_uploads_keep_occurrence_order(
    client, device_client, enrolled
):
    mapping_id = enrolled["mapping"]["id"]
    for event in reversed(FIXTURE_EVENTS):
        await ingest(device_client, enrolled, [record([event], mapping_id)])
    sessions = (await client.get("/api/workspaces/default/sessions")).json()["items"]
    events = (
        await client.get(f"/api/workspaces/default/sessions/{sessions[0]['id']}/events")
    ).json()["items"]
    assert [item["action"] for item in events] == [
        event["event"]["action"] for event in FIXTURE_EVENTS
    ]
    assert sessions[0]["status"] == "ended"


@pytest.mark.parametrize("content_level", ["metadata", "standard", "full"])
async def test_identity_fields_are_dropped_at_every_content_level(
    client, device_client, enrolled, db_session, content_level
):
    installation_id = enrolled["installation"]["installation_id"]
    mapping_id = enrolled["mapping"]["id"]
    await client.patch(
        f"{ME}/{installation_id}/mappings/{mapping_id}",
        json={"content_level": content_level},
    )
    event = copy.deepcopy(FIXTURE_EVENTS[0])
    event["host"] = {"name": "SYNTHETIC-HOST", "ip": ["10.0.0.9"]}
    await ingest(device_client, enrolled, [record([event], mapping_id)])
    stored = (await db_session.scalar(select(AgentSessionEvent))).event
    assert "user" not in stored and "host" not in stored
    assert "hostname" not in stored["endpoint"]
    assert stored["endpoint"]["os"] == "darwin"
    assert "synthetic-host" not in json.dumps(stored).lower()


async def test_tool_call_id_falls_back_to_trace_span_for_tool_events(
    device_client, enrolled, db_session
):
    event = copy.deepcopy(FIXTURE_EVENTS[4])
    del event["gen_ai"]
    await ingest(device_client, enrolled, [record([event], enrolled["mapping"]["id"])])
    stored = await db_session.scalar(select(AgentSessionEvent))
    assert stored.native_tool_call_id == "toolu_evidence_2"


async def test_pi_plugin_events_are_accepted(device_client, enrolled, db_session):
    event = copy.deepcopy(FIXTURE_EVENTS[0])
    event["harness"] = {"name": "pi_cli", "collection_method": "plugin"}
    response = await ingest(
        device_client,
        enrolled,
        [
            record(
                [event],
                enrolled["mapping"]["id"],
                harness="pi_cli",
                collection_method="plugin",
            )
        ],
    )
    assert response.json()["rejected"] == []
    assert (await only_session(db_session)).harness == "pi_cli"


def _thread(native_session_id, parent=None, event_id=None, at="2026-09-24T02:21:28Z"):
    event = copy.deepcopy(FIXTURE_EVENTS[0])
    event["event"]["id"] = event_id or native_session_id
    event["session"]["id"] = native_session_id
    event["timestamp"] = at
    event["harness"] = {"name": "codex_cli", "collection_method": "hook"}
    overrides = {"harness": "codex_cli", "native_session_id": native_session_id}
    if parent:
        overrides["parent_native_session_id"] = parent
    return event, overrides


async def _sessions_by_native_id(db_session):
    rows = await db_session.scalars(
        select(AgentSession).execution_options(populate_existing=True)
    )
    return {row.native_session_id: row for row in rows}


@pytest.mark.parametrize("child_first", [False, True])
async def test_subagent_thread_links_to_its_parent_in_either_order(
    client, device_client, enrolled, db_session, child_first
):
    mapping_id = enrolled["mapping"]["id"]
    root_event, root = _thread("root-thread")
    child_event, child = _thread("child-thread", parent="root-thread")
    uploads = [
        record([root_event], mapping_id, **root),
        record([child_event], mapping_id, **child),
    ]
    if child_first:
        uploads.reverse()
    for upload in uploads:
        response = await ingest(device_client, enrolled, [upload])
        assert response.json()["rejected"] == [], response.text
    sessions = await _sessions_by_native_id(db_session)
    assert sessions["child-thread"].parent_session_id == sessions["root-thread"].id
    assert sessions["root-thread"].parent_session_id is None

    listed = (await client.get("/api/workspaces/default/sessions")).json()["items"]
    by_native = {item["native_session_id"]: item for item in listed}
    assert by_native["child-thread"]["parent_session_id"] == str(
        sessions["root-thread"].id
    )
    roots = (
        await client.get("/api/workspaces/default/sessions?root_only=true")
    ).json()["items"]
    assert [item["native_session_id"] for item in roots] == ["root-thread"]


async def test_parent_is_never_linked_across_workspaces_or_harnesses(
    client, device_client, enrolled, db_session, test_user
):
    other_workspace = Workspace(name="Other", slug="other", created_by=test_user.id)
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
    installation_id = enrolled["installation"]["installation_id"]
    other_mapping = (
        await client.post(
            f"{ME}/{installation_id}/mappings",
            json={"workspace_id": str(other_workspace.id), "root_path": "/other"},
        )
    ).json()
    root_event, root = _thread("root-thread")
    child_event, child = _thread("child-thread", parent="root-thread")
    claude_event, claude = _thread("claude-child", parent="root-thread", event_id="c1")
    claude["harness"] = "claude_code"
    claude_event["harness"]["name"] = "claude_code"
    await ingest(
        device_client,
        enrolled,
        [
            record([root_event], other_mapping["id"], **root),
            record([child_event], enrolled["mapping"]["id"], **child),
            record([claude_event], enrolled["mapping"]["id"], **claude),
        ],
    )
    sessions = await _sessions_by_native_id(db_session)
    assert sessions["child-thread"].parent_session_id is None
    assert sessions["claude-child"].parent_session_id is None


async def test_session_cannot_be_its_own_parent(device_client, enrolled):
    event, overrides = _thread("loop-thread", parent="loop-thread")
    item = record([event], enrolled["mapping"]["id"], **overrides)
    response = await ingest(device_client, enrolled, [item])
    assert response.json()["rejected"] == [
        {"capture_id": item["capture_id"], "reason": "invalid"}
    ]


SENTINEL = "SENTINEL_PRIVATE_TEXT"


def _loaded_event():
    event = copy.deepcopy(FIXTURE_EVENTS[3])
    event["message"] = SENTINEL + "-message"
    event["output"] = SENTINEL + "-top-level-output"
    event["error"] = {"type": "ToolError", "message": SENTINEL + "-error"}
    event["tool"] = {"name": "Bash", "input": {"command": SENTINEL + "-tool-input"}}
    event["mcp"]["arguments"] = {"card_id": SENTINEL + "-mcp-args"}
    event["command"] = {
        "command": SENTINEL + "-command",
        "output": SENTINEL + "-command-output",
        "stdout": SENTINEL + "-stdout",
        "stderr": SENTINEL + "-stderr",
        "exit_code": 1,
    }
    event["gen_ai"]["tool"]["call"]["result"] = {"text": SENTINEL + "-tool-result"}
    event["gen_ai"]["output"] = {"messages": [SENTINEL + "-model-output"]}
    event["gen_ai"]["usage"] = {"input_tokens": 5, "note": SENTINEL + "-usage-note"}
    event["event"]["note"] = SENTINEL + "-event-extra"
    event["trace"]["baggage"] = SENTINEL + "-trace-extra"
    event["custom"] = {"deep": {"nested": [SENTINEL + "-unknown"]}}
    event["file"] = {"path": "/x", "operation": "write", "diff": SENTINEL + "-diff"}
    event["prompt"] = {"text": SENTINEL + "-prompt"}
    return event


async def _store_at_level(client, device_client, enrolled, db_session, level, event):
    installation_id = enrolled["installation"]["installation_id"]
    mapping_id = enrolled["mapping"]["id"]
    await client.patch(
        f"{ME}/{installation_id}/mappings/{mapping_id}", json={"content_level": level}
    )
    response = await ingest(device_client, enrolled, [record([event], mapping_id)])
    assert response.json()["rejected"] == [], response.text
    return (await db_session.scalar(select(AgentSessionEvent))).event


async def test_metadata_level_keeps_only_allowlisted_structure(
    client, device_client, enrolled, db_session
):
    stored = await _store_at_level(
        client, device_client, enrolled, db_session, "metadata", _loaded_event()
    )
    assert SENTINEL not in json.dumps(stored)
    assert stored["event"]["action"] == "mcp.tool_invoked"
    assert stored["timestamp"] == FIXTURE_EVENTS[3]["timestamp"]
    assert stored["tool"] == {"name": "Bash"}
    assert (
        stored["mcp"]["server"] == "backplane" and stored["mcp"]["tool"] == "get_card"
    )
    assert stored["gen_ai"]["tool"]["call"]["id"] == "toolu_evidence_1"
    assert stored["gen_ai"]["usage"] == {"input_tokens": 5}
    assert stored["command"] == {"exit_code": 1}
    assert stored["file"] == {"operation": "write"}
    assert stored["session"]["id"] == "sc01-synthetic-session"
    redacted = stored["backplane_redactions"]
    for path in [
        "message",
        "output",
        "error",
        "custom",
        "prompt",
        "tool.input",
        "mcp.arguments",
        "command.stderr",
        "event.note",
        "trace.baggage",
        "gen_ai.usage.note",
    ]:
        assert set(redacted[path]) == {"sha256", "bytes", "original_bytes"}, path


async def test_standard_level_strips_tool_output_but_keeps_prompts_and_commands(
    client, device_client, enrolled, db_session
):
    stored = await _store_at_level(
        client, device_client, enrolled, db_session, "standard", _loaded_event()
    )
    text = json.dumps(stored)
    for kept in ["-prompt", '-command"', "-tool-input", "-mcp-args"]:
        assert SENTINEL + kept in text, kept
    for dropped in [
        "-tool-result",
        "-command-output",
        "-stdout",
        "-stderr",
        "-model-output",
        "-top-level-output",
    ]:
        assert SENTINEL + dropped not in text, dropped
    assert "gen_ai.tool.call.result" in stored["backplane_redactions"]


async def test_full_level_keeps_tool_output(
    client, device_client, enrolled, db_session
):
    stored = await _store_at_level(
        client, device_client, enrolled, db_session, "full", _loaded_event()
    )
    text = json.dumps(stored)
    for kept in ["-tool-result", "-command-output", "-stderr", "-model-output"]:
        assert SENTINEL + kept in text, kept
    assert "backplane_redactions" not in stored


@pytest.mark.parametrize("field", ["timestamp", "captured_at"])
async def test_future_or_naive_times_reject_the_record(device_client, enrolled, field):
    event = copy.deepcopy(FIXTURE_EVENTS[0])
    far_future = "2999-01-01T00:00:00Z"
    item = record([event], enrolled["mapping"]["id"])
    if field == "timestamp":
        event["timestamp"] = far_future
        item["events"] = [event]
    else:
        item["captured_at"] = far_future
    naive = record(FIXTURE_EVENTS[:1], enrolled["mapping"]["id"])
    naive["captured_at"] = "2026-09-24T02:21:30"
    response = await ingest(device_client, enrolled, [item, naive])
    assert response.json()["rejected"] == [
        {"capture_id": item["capture_id"], "reason": "invalid"},
        {"capture_id": naive["capture_id"], "reason": "invalid"},
    ]


async def test_metadata_leaves_are_capped_at_one_kib(
    client, device_client, enrolled, db_session
):
    event = copy.deepcopy(FIXTURE_EVENTS[0])
    event["session"]["working_directory"] = "d" * 5001
    stored = await _store_at_level(
        client, device_client, enrolled, db_session, "metadata", event
    )
    kept = stored["session"]["working_directory"]
    assert len(kept.encode()) <= 1024
    assert kept.endswith("[truncated]")
    assert stored["backplane_redactions"]["session.working_directory"]["bytes"] == 5001


async def test_standard_level_also_strips_raw_and_diff_and_bounds_error_message(
    client, device_client, enrolled, db_session
):
    event = _loaded_event()
    event["raw"] = {"hook_payload": SENTINEL + "-raw"}
    event["error"]["message"] = SENTINEL + "-error" + "e" * 5000
    stored = await _store_at_level(
        client, device_client, enrolled, db_session, "standard", event
    )
    text = json.dumps(stored)
    assert SENTINEL + "-raw" not in text and SENTINEL + "-diff" not in text
    assert {"raw", "file.diff"} <= set(stored["backplane_redactions"])
    assert stored["error"]["message"].startswith(SENTINEL + "-error")
    assert len(stored["error"]["message"].encode()) <= 1024
    assert SENTINEL + "-prompt" in text


@pytest.mark.parametrize("content_level", ["metadata", "standard", "full"])
async def test_client_sent_redaction_records_are_never_stored(
    client, device_client, enrolled, db_session, content_level
):
    event = copy.deepcopy(FIXTURE_EVENTS[0])
    event["backplane_redactions"] = {"forged": {"sha256": "0" * 64, "bytes": 1}}
    stored = await _store_at_level(
        client, device_client, enrolled, db_session, content_level, event
    )
    assert "forged" not in json.dumps(stored)


def _placed(event, working_directory, repository, branch=None):
    placed = copy.deepcopy(event)
    placed["session"]["working_directory"] = working_directory
    placed["repository"] = repository
    if branch:
        placed["branch"] = branch
    return placed


async def _auto_mapping(device_client, enrolled):
    response = await device_client.post(
        "/api/companion/mappings",
        json={"repo_url": "git@github.com:valaris/test-repo.git"},
        headers=enrolled["headers"],
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


async def test_absolute_paths_are_relativized_against_an_explicit_root(
    device_client, enrolled, db_session
):
    events = [
        _placed(FIXTURE_EVENTS[0], "/synthetic/project/src", "/synthetic/project"),
        _placed(FIXTURE_EVENTS[1], "/synthetic/elsewhere", "/synthetic/project"),
    ]
    response = await ingest(
        device_client, enrolled, [record(events[:1], enrolled["mapping"]["id"])]
    )
    assert response.json()["rejected"] == []
    session = await only_session(db_session)
    assert (session.cwd, session.repository) == ("project/src", None)

    await ingest(
        device_client, enrolled, [record(events[1:], enrolled["mapping"]["id"])]
    )
    session = await only_session(db_session)
    # Outside the mapping root only the folder's own name is kept.
    assert session.cwd == "elsewhere"
    stored = [row.event for row in await db_session.scalars(select(AgentSessionEvent))]
    assert sorted(event["session"]["working_directory"] for event in stored) == [
        "elsewhere",
        "project/src",
    ]
    assert all("repository" not in event for event in stored)


async def test_auto_repo_sessions_keep_no_absolute_path(
    device_client, enrolled, db_session, test_git_repo
):
    mapping_id = await _auto_mapping(device_client, enrolled)
    # Assembled so the source never spells a macOS home path.
    mac_home = "/" + "Users/"
    home_path = mac_home + "synthetic/code/test-repo"
    legacy = _placed(FIXTURE_EVENTS[0], home_path, home_path, branch="main")
    response = await ingest(device_client, enrolled, [record([legacy], mapping_id)])
    assert response.json()["rejected"] == []
    session = await only_session(db_session)
    # No root to place it under: the folder's own name only.
    assert session.cwd == "test-repo"
    assert session.repository == "github.com/valaris/test-repo"
    assert session.branch == "main"
    stored = (await db_session.scalar(select(AgentSessionEvent))).event
    assert mac_home not in json.dumps(stored)

    relative = _placed(
        FIXTURE_EVENTS[1], "cmd/server", "github.com/valaris/test-repo", "feature/x"
    )
    await ingest(device_client, enrolled, [record([relative], mapping_id)])
    session = await only_session(db_session)
    assert (session.cwd, session.repository, session.branch) == (
        "cmd/server",
        "github.com/valaris/test-repo",
        "feature/x",
    )


@pytest.mark.parametrize("glob", ["github.com/valaris/*", "cmd/*"])
async def test_exclusions_match_the_repository_and_relative_directory(
    client, device_client, enrolled, db_session, test_git_repo, glob
):
    mapping_id = await _auto_mapping(device_client, enrolled)
    installation_id = enrolled["installation"]["installation_id"]
    await client.patch(f"{ME}/{installation_id}/policy", json={"exclude_globs": [glob]})
    event = _placed(FIXTURE_EVENTS[0], "cmd/server", "github.com/valaris/test-repo")
    item = record([event], mapping_id)
    response = await ingest(device_client, enrolled, [item])
    assert response.json()["rejected"] == [
        {"capture_id": item["capture_id"], "reason": "excluded"}
    ]


# Assembled at runtime: the public export refuses home paths in source.
_MAC_HOME = "/" + "Users/me"
_HOME_SPELLINGS = re.compile(
    "(?i)(/" + "users/|/home/|[a-z]:\\\\" + "users\\\\|%2f" + "users%2f|%2fhome%2f)"
)


def _probe_event(cwd):
    event = copy.deepcopy(FIXTURE_EVENTS[3])
    event["session"]["working_directory"] = cwd
    event["file"] = {"path": _MAC_HOME + "/code/main.go", "operation": "write"}
    event["tool"] = {"name": "Read", "path": "/home/me/.claude/settings.json"}
    event["transcript_path"] = _MAC_HOME + "/.claude/projects/p/s.jsonl"
    event["command"] = {"command": "cat " + _MAC_HOME + "/.ssh/config", "exit_code": 0}
    event["prompt"] = {"text": "look at " + _MAC_HOME + "/code/README.md please"}
    event["raw"] = {_MAC_HOME + "/code/a.py": "C:\\" + "Users\\me\\x"}
    return event


@pytest.mark.parametrize("content_level", ["metadata", "standard", "full"])
@pytest.mark.parametrize(
    "cwd", ["file://" + _MAC_HOME + "/code", " " + _MAC_HOME + "/code", "/home/me/x"]
)
async def test_reviewer_probe_stores_no_home_path(
    client, device_client, enrolled, db_session, content_level, cwd
):
    installation_id = enrolled["installation"]["installation_id"]
    mapping_id = enrolled["mapping"]["id"]
    await client.patch(
        f"{ME}/{installation_id}/mappings/{mapping_id}",
        json={"content_level": content_level},
    )
    response = await ingest(
        device_client, enrolled, [record([_probe_event(cwd)], mapping_id)]
    )
    assert response.json()["rejected"] == [], response.text
    stored = (await db_session.scalar(select(AgentSessionEvent))).event
    session = await only_session(db_session)
    for text in [json.dumps(stored), session.cwd or "", session.title or ""]:
        assert not _HOME_SPELLINGS.search(text), text
    if content_level != "metadata":
        assert stored["prompt"]["text"] == "look at ~me/code/README.md please"


async def _store_cwd_at_level(
    client, device_client, enrolled, db_session, level, working_directory
):
    event = copy.deepcopy(FIXTURE_EVENTS[0])
    event["session"]["working_directory"] = working_directory
    stored = await _store_at_level(
        client, device_client, enrolled, db_session, level, event
    )
    session = await only_session(db_session)
    return stored["session"].get("working_directory"), session.cwd


async def _set_root_path(db_session, enrolled, root_path):
    mapping = await db_session.get(
        CompanionProjectMapping, uuid.UUID(enrolled["mapping"]["id"])
    )
    mapping.root_path = root_path
    await db_session.flush()


async def test_metadata_level_stores_working_directory_base_name_only(
    client, device_client, enrolled, db_session
):
    stored, session_cwd = await _store_cwd_at_level(
        client,
        device_client,
        enrolled,
        db_session,
        "metadata",
        "/synthetic/project/packages/api",
    )
    assert (stored, session_cwd) == ("api", "api")
    stored_rows = [
        row.event for row in await db_session.scalars(select(AgentSessionEvent))
    ]
    assert "packages" not in json.dumps(stored_rows)


async def test_metadata_level_root_working_directory_becomes_root_folder_name(
    client, device_client, enrolled, db_session
):
    stored, session_cwd = await _store_cwd_at_level(
        client, device_client, enrolled, db_session, "metadata", "."
    )
    assert (stored, session_cwd) == ("project", "project")


async def test_metadata_level_absolute_root_working_directory_becomes_root_folder_name(
    client, device_client, enrolled, db_session
):
    stored, session_cwd = await _store_cwd_at_level(
        client, device_client, enrolled, db_session, "metadata", "/synthetic/project/"
    )
    assert (stored, session_cwd) == ("project", "project")


async def test_metadata_level_windows_root_working_directory_becomes_root_folder_name(
    client, device_client, enrolled, db_session
):
    await _set_root_path(db_session, enrolled, "C:\\code\\storefront-api")
    stored, session_cwd = await _store_cwd_at_level(
        client, device_client, enrolled, db_session, "metadata", "."
    )
    assert (stored, session_cwd) == ("storefront-api", "storefront-api")


async def test_metadata_level_root_working_directory_dropped_without_root_path(
    client, device_client, enrolled, db_session, test_git_repo
):
    mapping_id = await _auto_mapping(device_client, enrolled)
    installation_id = enrolled["installation"]["installation_id"]
    await client.patch(
        f"{ME}/{installation_id}/mappings/{mapping_id}",
        json={"content_level": "metadata"},
    )
    event = copy.deepcopy(FIXTURE_EVENTS[0])
    event["session"]["working_directory"] = "."
    response = await ingest(device_client, enrolled, [record([event], mapping_id)])
    assert response.json()["rejected"] == [], response.text
    stored = (await db_session.scalar(select(AgentSessionEvent))).event
    session = await only_session(db_session)
    assert "working_directory" not in stored["session"]
    assert session.cwd is None


async def test_metadata_level_keeps_bare_folder_name_from_new_companion(
    client, device_client, enrolled, db_session
):
    stored, session_cwd = await _store_cwd_at_level(
        client, device_client, enrolled, db_session, "metadata", "api"
    )
    assert (stored, session_cwd) == ("api", "api")


async def test_metadata_windows_relative_path_reduced_to_base_name(
    client, device_client, enrolled, db_session
):
    stored, session_cwd = await _store_cwd_at_level(
        client, device_client, enrolled, db_session, "metadata", "packages\\api\\"
    )
    assert (stored, session_cwd) == ("api", "api")


@pytest.mark.parametrize(
    "root_path,folder_name",
    [("\\\\server\\share", "share"), ("\\\\server\\share\\proj", "proj")],
)
async def test_metadata_level_unc_root_working_directory_becomes_root_folder_name(
    client, device_client, enrolled, db_session, root_path, folder_name
):
    await _set_root_path(db_session, enrolled, root_path)
    stored, session_cwd = await _store_cwd_at_level(
        client, device_client, enrolled, db_session, "metadata", "."
    )
    assert (stored, session_cwd) == (folder_name, folder_name)


async def test_metadata_mixed_separator_path_reduced_to_base_name(
    client, device_client, enrolled, db_session
):
    stored, session_cwd = await _store_cwd_at_level(
        client, device_client, enrolled, db_session, "metadata", "packages/sub\\api"
    )
    assert (stored, session_cwd) == ("api", "api")


@pytest.mark.parametrize("content_level", ["standard", "full"])
async def test_above_metadata_level_keeps_relative_working_directory(
    client, device_client, enrolled, db_session, content_level
):
    stored, session_cwd = await _store_cwd_at_level(
        client,
        device_client,
        enrolled,
        db_session,
        content_level,
        "/synthetic/project/packages/api",
    )
    assert (stored, session_cwd) == ("project/packages/api", "project/packages/api")


async def test_metadata_exclude_glob_still_matches_full_relative_path(
    client, device_client, enrolled
):
    installation_id = enrolled["installation"]["installation_id"]
    mapping_id = enrolled["mapping"]["id"]
    await client.patch(
        f"{ME}/{installation_id}/mappings/{mapping_id}",
        json={"content_level": "metadata"},
    )
    await client.patch(
        f"{ME}/{installation_id}/policy", json={"exclude_globs": ["packages/secret/*"]}
    )
    event = copy.deepcopy(FIXTURE_EVENTS[0])
    event["session"]["working_directory"] = "packages/secret/api"
    item = record([event], mapping_id)
    response = await ingest(device_client, enrolled, [item])
    assert response.json()["rejected"] == [
        {"capture_id": item["capture_id"], "reason": "excluded"}
    ]


async def test_standard_level_never_stores_the_agent_reply(
    client, device_client, enrolled, db_session
):
    reply = SENTINEL + "-agent-reply"
    event = copy.deepcopy(FIXTURE_EVENTS[5])
    event["raw"] = {"hook_event_name": "Stop", "last_assistant_message": reply}
    event["gen_ai"] = {"output": {"type": "text", "messages": [reply]}}
    event["output"] = reply
    stored = await _store_at_level(
        client, device_client, enrolled, db_session, "standard", event
    )
    assert reply not in json.dumps(stored)
    assert {"raw", "gen_ai.output", "output"} <= set(stored["backplane_redactions"])


# The exec tool's JavaScript as codex-cli 0.159.0 sent it in a live run: the
# patch rides inside a JS string, its newlines escaped.
CODEX_EXEC_PATCH = (
    'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: cli/existing.txt'
    "\\n@@\\n+"
    + SENTINEL
    + "-patch-edit\\n*** Add File: cli/new.txt\\n+"
    + SENTINEL
    + '-patch-new\\n*** End Patch"));'
)
SHELL_PATCH = (
    "cd cli && apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: a.txt\n+"
    + SENTINEL
    + "-patch-shell\n*** End Patch\nPATCH"
)


def _wrapped_patch_event():
    event = copy.deepcopy(FIXTURE_EVENTS[3])
    event["tool"] = {"name": "exec", "command": CODEX_EXEC_PATCH}
    event["gen_ai"] = {
        "tool": {"call": {"id": "call_3", "arguments": CODEX_EXEC_PATCH}}
    }
    event["command"] = {"command": SHELL_PATCH, "exit_code": 0}
    event["prompt"] = {
        "text": "apply *** Begin Patch\n*** Add File: p\n+"
        + SENTINEL
        + "-pasted\n*** End Patch"
    }
    return event


async def test_standard_level_withholds_patches_wrapped_in_tool_arguments(
    client, device_client, enrolled, db_session
):
    stored = await _store_at_level(
        client, device_client, enrolled, db_session, "standard", _wrapped_patch_event()
    )
    text = json.dumps(stored)
    for patched in ["-patch-edit", "-patch-new", "-patch-shell"]:
        assert SENTINEL + patched not in text, patched
    assert stored["tool"]["command"].startswith(
        'text(await tools.apply_patch("[omitted '
    )
    assert stored["command"]["command"].startswith(
        "cd cli && apply_patch <<'PATCH'\n[omitted "
    )
    assert SENTINEL + "-pasted" in text
    assert {"tool.command", "gen_ai.tool.call.arguments", "command.command"} <= set(
        stored["backplane_redactions"]
    )


async def test_standard_level_keeps_commands_that_only_mention_the_patch_marker(
    client, device_client, enrolled, db_session
):
    event = copy.deepcopy(FIXTURE_EVENTS[3])
    mention = 'grep -rn "*** Begin Patch" docs/ && echo "*** End Patch"'
    event["command"] = {"command": mention, "exit_code": 0}
    event["tool"] = {"name": "exec_command", "command": "apply_patch --help"}
    stored = await _store_at_level(
        client, device_client, enrolled, db_session, "standard", event
    )
    assert stored["command"]["command"] == mention
    assert stored["tool"]["command"] == "apply_patch --help"
    assert "command.command" not in stored.get("backplane_redactions", {})


async def test_full_level_keeps_wrapped_patches(
    client, device_client, enrolled, db_session
):
    stored = await _store_at_level(
        client, device_client, enrolled, db_session, "full", _wrapped_patch_event()
    )
    text = json.dumps(stored)
    for patched in ["-patch-edit", "-patch-new", "-patch-shell"]:
        assert SENTINEL + patched in text, patched


# Shared with the companion's Go tests, so the two detectors cannot drift apart.
EDIT_CONTENT_VECTORS = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "companion/internal/privacy/testdata/edit_content_vectors.json"
    ).read_text()
)["cases"]


@pytest.mark.parametrize(
    "vector",
    EDIT_CONTENT_VECTORS,
    ids=[case["name"] for case in EDIT_CONTENT_VECTORS],
)
def test_edit_content_vectors_match_the_companion(vector):
    withheld = without_command_content(vector["input"])
    if not vector["withheld"]:
        assert withheld == vector["input"]
        return
    assert "[omitted " in withheld
    for text in vector["gone"]:
        assert text not in withheld, text
    for text in vector["kept"]:
        assert text in withheld, text
    assert without_command_content(withheld) == withheld


async def test_standard_level_withholds_file_content_that_commands_write(
    client, device_client, enrolled, db_session
):
    event = copy.deepcopy(FIXTURE_EVENTS[3])
    heredoc = "mkdir -p docs && cat > docs/a.md <<'EOF'\n" + SENTINEL + "-heredoc\nEOF"
    event["command"] = {"command": heredoc, "exit_code": 0}
    event["tool"] = {
        "name": "Bash",
        "input": {"command": "echo '" + SENTINEL + "-echo' > .env"},
    }
    stored = await _store_at_level(
        client, device_client, enrolled, db_session, "standard", event
    )
    text = json.dumps(stored)
    assert SENTINEL + "-heredoc" not in text and SENTINEL + "-echo" not in text
    assert stored["command"]["command"].startswith(
        "mkdir -p docs && cat > docs/a.md <<'EOF'\n[omitted "
    )
    assert stored["tool"]["input"]["command"].endswith("> .env")
    assert {"command.command", "tool.input"} <= set(stored["backplane_redactions"])
