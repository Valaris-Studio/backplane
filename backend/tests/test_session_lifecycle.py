# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Session display state, deletion and retention, heartbeats and invalidation."""

import copy
import json
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.event_bus import event_bus
from app.database import get_db
from app.main import create_app
from app.models.agent_session import (
    AgentSession,
    AgentSessionTombstone,
    SessionWorkLink,
)
from app.models.companion import CompanionInstallation, CompanionProjectMapping
from app.models.workspace import WorkspaceMember, WorkspaceRole
from tests.test_agent_sessions import (
    FIXTURE_EVENTS,
    ME,
    SESSIONS,
    as_user,
    enroll,
    outcome,
    record,
    upload,
    work_under_invocation,
)

NOW = datetime.now(timezone.utc)


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


def fresh(events, *, at=None):
    """Events re-timed so the session's last event is `at` (default now)."""
    at = at or datetime.now(timezone.utc)
    events = copy.deepcopy(events)
    for offset, event in enumerate(reversed(events)):
        event["timestamp"] = (at - timedelta(seconds=offset)).isoformat()
    return events


def with_ids(events, prefix):
    events = copy.deepcopy(events)
    for index, event in enumerate(events):
        event["event"]["id"] = f"{prefix}-{index}"
    return events


async def ingest(device_client, token, records):
    response = await device_client.post(
        "/api/companion/ingest",
        json={"records": records},
        headers={"Authorization": "Bearer " + token},
    )
    assert response.status_code == 200, response.text
    return response.json()


async def only_session(db_session):
    return await db_session.scalar(
        select(AgentSession).execution_options(populate_existing=True)
    )


async def listed(client):
    return (await client.get(SESSIONS)).json()["items"]


# --- display state -------------------------------------------------------------


OPEN_EVENTS = FIXTURE_EVENTS[:3]  # started, prompt, tool: no session.ended


async def _age_session(db_session, silent_for: timedelta):
    await db_session.execute(
        update(AgentSession).values(
            last_event_at=datetime.now(timezone.utc) - silent_for,
            started_at=datetime.now(timezone.utc) - silent_for - timedelta(minutes=1),
        )
    )
    await db_session.flush()


@pytest.mark.parametrize(
    "silent_for,status,state,ended_reason",
    [
        (timedelta(minutes=5), "active", "active", None),
        (timedelta(minutes=16), "idle", "idle", None),
        (timedelta(hours=23), "idle", "idle", None),
        (timedelta(hours=25), "ended", "incomplete", "abandoned"),
    ],
)
async def test_silence_is_idle_then_abandoned_never_a_real_end(
    client,
    device_client,
    db_session,
    test_workspace,
    silent_for,
    status,
    state,
    ended_reason,
):
    token, mapping_id = await enroll(client, test_workspace)
    await upload(device_client, token, [record(fresh(OPEN_EVENTS), mapping_id)])
    await _age_session(db_session, silent_for)
    [item] = await listed(client)
    assert item["status"] == status
    assert item["ended_at"] is None
    assert item["display_state"] == state
    assert item["ended_reason"] == ended_reason


async def test_session_end_event_is_ended_unless_captures_were_lost(
    client, device_client, db_session, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    await upload(device_client, token, [record(fresh(FIXTURE_EVENTS), mapping_id)])
    [item] = await listed(client)
    assert (item["display_state"], item["ended_reason"]) == (
        "ended",
        "session_end_event",
    )
    await db_session.execute(update(AgentSession).values(capture_gaps=1))
    await db_session.flush()
    [item] = await listed(client)
    assert item["display_state"] == "incomplete"
    assert item["capture_gaps"] == 1


@pytest.mark.parametrize("switch", ["paused", "agent_disabled", "mapping_disabled"])
async def test_capture_switched_off_shows_paused(
    client, device_client, db_session, test_workspace, switch
):
    token, mapping_id = await enroll(client, test_workspace)
    await upload(device_client, token, [record(fresh(OPEN_EVENTS), mapping_id)])
    installation = await db_session.scalar(select(CompanionInstallation))
    if switch == "paused":
        installation.paused = True
    elif switch == "agent_disabled":
        installation.enabled_agents = ["codex_cli"]
    else:
        await db_session.execute(update(CompanionProjectMapping).values(enabled=False))
    await db_session.flush()
    [item] = await listed(client)
    assert item["display_state"] == "paused"


@pytest.mark.parametrize(
    "enabled_agents,state", [(["codex_cli"], "active"), (["claude_code"], "paused")]
)
async def test_codex_desktop_session_follows_the_codex_switch(
    client, device_client, db_session, test_workspace, enabled_agents, state
):
    token, mapping_id = await enroll(client, test_workspace)
    events = fresh(OPEN_EVENTS)
    for event in events:
        event["harness"] = {**event.get("harness", {}), "name": "codex_desktop"}
    await upload(
        device_client, token, [record(events, mapping_id, harness="codex_desktop")]
    )
    installation = await db_session.scalar(select(CompanionInstallation))
    installation.enabled_agents = enabled_agents
    await db_session.flush()
    [item] = await listed(client)
    assert item["display_state"] == state


@pytest.mark.parametrize("cause", ["revoked", "stale_heartbeat"])
async def test_unreachable_device_shows_disconnected(
    client, device_client, db_session, test_workspace, cause
):
    token, mapping_id = await enroll(client, test_workspace)
    await upload(device_client, token, [record(fresh(OPEN_EVENTS), mapping_id)])
    installation = await db_session.scalar(select(CompanionInstallation))
    if cause == "revoked":
        installation.revoked_at = datetime.now(timezone.utc)
    else:
        installation.last_seen_at = datetime.now(timezone.utc) - timedelta(hours=2)
    await db_session.flush()
    [item] = await listed(client)
    assert item["display_state"] == "disconnected"


async def test_rejected_records_of_a_known_session_count_as_capture_gaps(
    device_client, client, db_session, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    first = record(fresh(OPEN_EVENTS), mapping_id)
    await upload(device_client, token, [first])
    conflicting = {**first, "events": fresh(FIXTURE_EVENTS[3:4])}
    broken = record(fresh(OPEN_EVENTS), mapping_id)
    del broken["events"][0]["event"]["action"]
    huge = record(fresh(OPEN_EVENTS[:1]), mapping_id)
    huge["events"][0]["padding"] = "x" * (64 << 10)
    unknown_session = record(fresh(OPEN_EVENTS), mapping_id, session="never-seen")
    del unknown_session["events"][0]["event"]["action"]
    result = await ingest(
        device_client, token, [conflicting, broken, huge, unknown_session]
    )
    assert [item["reason"] for item in result["rejected"]] == [
        "conflict",
        "invalid",
        "too_large",
        "invalid",
    ]
    assert (await only_session(db_session)).capture_gaps == 3


# --- deletion -------------------------------------------------------------------


async def test_owner_deletes_a_session_and_retries_cannot_resurrect_it(
    client, device_client, db_session, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    original = record(fresh(FIXTURE_EVENTS), mapping_id)
    await upload(device_client, token, [original])
    [item] = await listed(client)

    deleted = await client.delete(f"{SESSIONS}/{item['id']}")
    assert deleted.status_code == 204
    assert (await client.delete(f"{SESSIONS}/{item['id']}")).status_code == 204
    assert await db_session.scalar(select(func.count()).select_from(AgentSession)) == 0
    assert (await client.get(f"{SESSIONS}/{item['id']}")).status_code == 404

    later = record(fresh(OPEN_EVENTS), mapping_id)
    result = await ingest(device_client, token, [original, later])
    assert result["acknowledged"] == [original["capture_id"], later["capture_id"]]
    assert result["dropped"] == [
        {"capture_id": original["capture_id"], "reason": "session_deleted"},
        {"capture_id": later["capture_id"], "reason": "session_deleted"},
    ]
    assert result["rejected"] == []
    assert await db_session.scalar(select(func.count()).select_from(AgentSession)) == 0

    other_thread = record(
        with_ids(fresh(OPEN_EVENTS), "other"), mapping_id, session="other"
    )
    result = await ingest(device_client, token, [other_thread])
    assert result["dropped"] == []
    assert await db_session.scalar(select(func.count()).select_from(AgentSession)) == 1


async def test_tombstones_never_expire_while_the_device_is_enrolled(
    client, device_client, db_session, test_workspace
):
    """Age alone never lifts a cutoff: a queue replayed months later still
    drops what was observed before the deletion."""
    token, mapping_id = await enroll(client, test_workspace)
    long_ago = datetime.now(timezone.utc) - timedelta(days=61)
    await upload(
        device_client,
        token,
        [record(fresh(FIXTURE_EVENTS, at=long_ago), mapping_id)],
    )
    [item] = await listed(client)
    await client.delete(f"{SESSIONS}/{item['id']}")
    deleted_at = datetime.now(timezone.utc) - timedelta(days=60)
    await db_session.execute(
        update(AgentSessionTombstone).values(
            deleted_at=deleted_at,
            history_cutoff_deleted_at=deleted_at,
            history_cutoff=deleted_at + timedelta(minutes=2),
        )
    )
    await db_session.flush()
    replay = record(with_ids(fresh(OPEN_EVENTS, at=long_ago), "again"), mapping_id)
    result = await ingest(device_client, token, [replay])
    assert result["dropped"] == [
        {"capture_id": replay["capture_id"], "reason": "session_deleted"}
    ]
    assert await db_session.scalar(select(func.count()).select_from(AgentSession)) == 0


async def test_only_the_owner_can_delete_and_never_with_an_agent_key(
    client, agent_client, device_client, db_session, test_workspace, second_user
):
    token, mapping_id = await enroll(client, test_workspace)
    await upload(device_client, token, [record(fresh(FIXTURE_EVENTS), mapping_id)])
    [item] = await listed(client)
    assert (await agent_client.delete(f"{SESSIONS}/{item['id']}")).status_code == 403
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=second_user.id,
            role=WorkspaceRole.owner,
        )
    )
    await db_session.flush()
    async with as_user(db_session, second_user) as other:
        assert (await other.delete(f"{SESSIONS}/{item['id']}")).status_code == 404
    assert len(await listed(client)) == 1


async def test_bulk_delete_removes_an_installations_sessions_with_tombstones(
    client, device_client, db_session, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    first = record(fresh(OPEN_EVENTS), mapping_id)
    second = record(with_ids(fresh(OPEN_EVENTS), "b"), mapping_id, session="thread-b")
    await upload(device_client, token, [first, second])
    installation_id = (await client.get(ME)).json()[0]["installation_id"]
    response = await client.delete(f"{ME}/{installation_id}/sessions")
    assert response.status_code == 200
    assert response.json() == {"deleted": 2}
    assert await db_session.scalar(select(func.count()).select_from(AgentSession)) == 0
    assert (
        await db_session.scalar(select(func.count()).select_from(AgentSessionTombstone))
        == 2
    )
    result = await ingest(device_client, token, [first])
    assert result["dropped"] == [
        {"capture_id": first["capture_id"], "reason": "session_deleted"}
    ]


# --- retention ------------------------------------------------------------------


async def test_retention_days_is_part_of_the_capture_policy(client, test_workspace):
    await enroll(client, test_workspace)
    installation_id = (await client.get(ME)).json()[0]["installation_id"]
    path = f"{ME}/{installation_id}/policy"
    assert (await client.get(path)).json()["retention_days"] is None
    assert (await client.patch(path, json={"retention_days": 30})).json()[
        "retention_days"
    ] == 30
    assert (await client.patch(path, json={"retention_days": 0})).status_code == 422
    assert (await client.patch(path, json={"retention_days": 3651})).status_code == 422
    assert (await client.patch(path, json={"retention_days": None})).json()[
        "retention_days"
    ] is None


async def test_purge_job_owns_its_transaction_deletes_expired_sessions_in_batches(
    client, device_client, db_session, db_engine, test_workspace, test_card
):
    from app.services.session_retention import SessionRetentionService

    token, mapping_id = await enroll(client, test_workspace)
    old = [
        record(
            with_ids(fresh(OPEN_EVENTS, at=NOW - timedelta(days=5)), name),
            mapping_id,
            session=name,
        )
        for name in ("old-1", "old-2")
    ]
    recent = record(
        with_ids(fresh(OPEN_EVENTS), "recent"), mapping_id, session="recent"
    )
    await upload(device_client, token, [*old, recent])
    installation = await db_session.scalar(select(CompanionInstallation))
    installation.retention_days = 3
    stale_link = SessionWorkLink(
        session_id=(
            await db_session.scalar(
                select(AgentSession.id).where(
                    AgentSession.native_session_id == "recent"
                )
            )
        ),
        workspace_id=test_workspace.id,
        entity_type="card",
        entity_id=uuid.uuid4(),
        relation="changed",
        first_seen_at=NOW,
        last_seen_at=NOW,
        invocation_count=1,
    )
    db_session.add(stale_link)
    revoked_device = CompanionInstallation(
        id=uuid.uuid4(),
        owner_id=installation.owner_id,
        name="Old laptop",
        platform="linux",
        token_hash=uuid.uuid4().hex * 2,
        token_prefix="bpc_old",
        enabled_agents=[],
        exclude_globs=[],
        revoked_at=NOW,
    )
    db_session.add(revoked_device)
    await db_session.flush()
    for device, native in [(installation, "long-ago"), (revoked_device, "on-revoked")]:
        db_session.add(
            AgentSessionTombstone(
                session_id=uuid.uuid4(),
                installation_id=device.id,
                workspace_id=test_workspace.id,
                owner_id=installation.owner_id,
                harness="claude_code",
                native_session_id=native,
                reason="owner",
                deleted_at=NOW - timedelta(days=400),
            )
        )
    await db_session.commit()

    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    service = SessionRetentionService(factory)
    assert await service.run_purge(batch_size=1, max_batches=1) == 1
    assert await service.run_purge(batch_size=1, max_batches=10) == 1
    assert await service.run_purge() == 0

    async with factory() as reader:
        names = set(await reader.scalars(select(AgentSession.native_session_id)))
        reasons = {
            row.native_session_id: row.reason
            for row in await reader.scalars(select(AgentSessionTombstone))
        }
        links = await reader.scalar(select(func.count()).select_from(SessionWorkLink))
    assert names == {"recent"}
    # Tombstones outlive any age; only a revoked device's are cleared.
    assert reasons == {"old-1": "retention", "old-2": "retention", "long-ago": "owner"}
    assert links == 0


# --- heartbeat --------------------------------------------------------------------


def status_report(**values):
    return {
        "companion_version": "0.3.0",
        "beacon_commit": "b" * 40,
        "agents": [
            {"harness": "claude_code", "state": "capturing"},
            {
                "harness": "codex_cli",
                "state": "error",
                "detail": "cannot read /home/synthetic/.codex/config.toml: denied",
            },
        ],
        "queue": {
            "pending": 3,
            "dropped_total": 1,
            "oldest_pending_at": NOW.isoformat(),
        },
        **values,
    }


async def test_heartbeat_stores_scrubbed_status_and_marks_the_device_seen(
    client, device_client, db_session, test_workspace
):
    token, _ = await enroll(client, test_workspace)
    headers = {"Authorization": "Bearer " + token}
    assert (await client.get(ME)).json()[0]["last_seen_at"] is None
    response = await device_client.post(
        "/api/companion/status", json=status_report(), headers=headers
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"recorded": True}
    [installation] = (await client.get(ME)).json()
    assert installation["last_seen_at"] is not None
    status = installation["status"]
    assert status["companion_version"] == "0.3.0"
    assert status["queue"]["pending"] == 3
    detail = status["agents"][1]["detail"]
    assert (
        "/home/" not in detail
        and detail == "cannot read ~synthetic/.codex/config.toml: denied"
    )
    assert installation["status_reported_at"] is not None

    again = await device_client.post(
        "/api/companion/status",
        json=status_report(companion_version="0.3.1"),
        headers=headers,
    )
    assert again.json() == {"recorded": False}
    assert (await client.get(ME)).json()[0]["status"]["companion_version"] == "0.3.0"


async def test_heartbeat_rejects_long_detail_and_revoked_devices(
    client, device_client, test_workspace
):
    token, _ = await enroll(client, test_workspace)
    headers = {"Authorization": "Bearer " + token}
    too_long = status_report(
        agents=[{"harness": "claude_code", "state": "error", "detail": "x" * 201}]
    )
    assert (
        await device_client.post(
            "/api/companion/status", json=too_long, headers=headers
        )
    ).status_code == 422
    installation_id = (await client.get(ME)).json()[0]["installation_id"]
    await client.delete(f"{ME}/{installation_id}")
    assert (
        await device_client.post(
            "/api/companion/status", json=status_report(), headers=headers
        )
    ).status_code == 401


async def test_policy_reads_do_not_count_as_seen_but_ingest_does(
    client, device_client, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    headers = {"Authorization": "Bearer " + token}
    await device_client.get("/api/companion/policy", headers=headers)
    assert (await client.get(ME)).json()[0]["last_seen_at"] is None
    await upload(device_client, token, [record(fresh(OPEN_EVENTS), mapping_id)])
    assert (await client.get(ME)).json()[0]["last_seen_at"] is not None


# --- invalidation events ------------------------------------------------------------


def published(mock):
    return [
        (call.kwargs["event_type"], call.kwargs["payload"], call.kwargs["workspace_id"])
        for call in mock.await_args_list
        if call.kwargs.get("event_type", "").startswith(
            ("agent_session.", "companion_")
        )
    ]


async def test_ingest_delete_and_heartbeat_publish_owner_only_id_events(
    client, device_client, test_workspace, test_user
):
    token, mapping_id = await enroll(client, test_workspace)
    with patch.object(event_bus, "publish", new_callable=AsyncMock) as publish:
        await upload(device_client, token, [record(fresh(OPEN_EVENTS), mapping_id)])
        [(event_type, payload, workspace_id)] = published(publish)
        assert event_type == "agent_session.updated"
        assert workspace_id == test_workspace.id
        assert set(payload) == {"owner_id", "session_id", "workspace_id", "reason"}
        assert payload["owner_id"] == str(test_user.id)
        assert payload["reason"] == "events"

        publish.reset_mock()
        [item] = await listed(client)
        await client.delete(f"{SESSIONS}/{item['id']}")
        assert [(t, p["reason"]) for t, p, _ in published(publish)] == [
            ("agent_session.updated", "deleted")
        ]

        publish.reset_mock()
        await device_client.post(
            "/api/companion/status",
            json=status_report(),
            headers={"Authorization": "Bearer " + token},
        )
        [(event_type, payload, _)] = published(publish)
        assert event_type == "companion_installation.updated"
        assert set(payload) == {"owner_id", "installation_id", "reason"}
        assert payload["reason"] == "status"


def test_session_events_reach_only_their_owner():
    from app.core.event_bus import Event
    from app.services.events.connection_manager import ConnectionManager

    owner, other = uuid.uuid4(), uuid.uuid4()
    for event_type, key in [
        ("agent_session.updated", "owner_id"),
        ("companion_installation.updated", "owner_id"),
    ]:
        event = Event(
            event_type=event_type, workspace_id=uuid.uuid4(), payload={key: str(owner)}
        )
        assert ConnectionManager._should_deliver(
            type("Conn", (), {"user_id": owner})(), event
        )
        assert not ConnectionManager._should_deliver(
            type("Conn", (), {"user_id": other})(), event
        )


async def test_rolled_back_ingest_publishes_nothing(db_session, client, test_workspace):
    token, mapping_id = await enroll(client, test_workspace)
    app = create_app()

    async def failing_commit():
        yield db_session
        raise RuntimeError("commit failed")

    app.dependency_overrides[get_db] = failing_commit
    with patch.object(event_bus, "publish", new_callable=AsyncMock) as publish:
        async with AsyncClient(
            transport=ASGITransport(app, raise_app_exceptions=False),
            base_url="http://test",
        ) as failing:
            response = await failing.post(
                "/api/companion/ingest",
                json={"records": [record(fresh(OPEN_EVENTS), mapping_id)]},
                headers={"Authorization": "Bearer " + token},
            )
    assert response.status_code == 500
    assert published(publish) == []


# --- linked work rollups, notes and subagent threads ----------------------------------


async def _linked_session(client, device_client, workspace, board, card, *, usage=None):
    token, mapping_id = await enroll(client, workspace, board)
    events = copy.deepcopy(FIXTURE_EVENTS)
    if usage is not None:
        events[1]["gen_ai"] = {"usage": usage}
    await upload(device_client, token, [record(events, mapping_id)])
    invocation_id = uuid.uuid4()
    await work_under_invocation(client, board, card, invocation_id)
    await client.post("/api/me/mcp-invocations", json=outcome(invocation_id))


async def test_card_sessions_carry_a_rollup(
    client, device_client, test_workspace, test_board, test_card
):
    await _linked_session(
        client,
        device_client,
        test_workspace,
        test_board,
        test_card,
        usage={"input_tokens": 10, "output_tokens": 4, "cost_usd": 0.25},
    )
    body = (
        await client.get(
            f"/api/workspaces/default/boards/{test_board.id}/cards/{test_card.id}/sessions"
        )
    ).json()
    assert len(body["items"]) == 1
    summary = body["summary"]
    assert summary["session_count"] == 1
    assert (summary["input_tokens"], summary["output_tokens"]) == (10, 4)
    assert summary["cost_usd"] == pytest.approx(0.25)
    assert summary["cost_complete"] is True
    assert summary["total_duration_seconds"] >= 0
    assert summary["first_seen_at"] and summary["last_seen_at"]


async def test_rollup_cost_is_null_when_no_session_reported_one(
    client, device_client, test_workspace, test_board, test_card
):
    await _linked_session(client, device_client, test_workspace, test_board, test_card)
    summary = (
        await client.get(
            f"/api/workspaces/default/boards/{test_board.id}/cards/{test_card.id}/sessions"
        )
    ).json()["summary"]
    assert summary["cost_usd"] is None
    assert summary["cost_complete"] is False


async def test_note_sessions_are_owner_private_with_rollup(
    client,
    device_client,
    db_session,
    test_workspace,
    test_board,
    test_note,
    second_user,
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(device_client, token, [record(FIXTURE_EVENTS, mapping_id)])
    invocation_id = uuid.uuid4()
    await client.get(
        f"/api/workspaces/default/notes/{test_note.id}",
        headers={"X-Backplane-Invocation-ID": str(invocation_id)},
    )
    await client.post("/api/me/mcp-invocations", json=outcome(invocation_id))
    path = f"/api/workspaces/default/notes/{test_note.id}/sessions"
    body = (await client.get(path)).json()
    assert [item["relations"] for item in body["items"]] == [["consulted"]]
    assert body["summary"]["session_count"] == 1
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=second_user.id,
            role=WorkspaceRole.owner,
        )
    )
    await db_session.flush()
    async with as_user(db_session, second_user) as other:
        other_body = (await other.get(path)).json()
    assert other_body["items"] == [] and other_body["summary"]["session_count"] == 0
    assert (
        await client.get(f"/api/workspaces/default/notes/{uuid.uuid4()}/sessions")
    ).status_code == 404


async def test_children_lists_a_sessions_subagent_threads(
    client, device_client, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    root = record(with_ids(fresh(OPEN_EVENTS), "root"), mapping_id, session="root")
    child = record(with_ids(fresh(OPEN_EVENTS), "child"), mapping_id, session="child")
    child["parent_native_session_id"] = "root"
    await upload(device_client, token, [root, child])
    by_native = {item["native_session_id"]: item for item in await listed(client)}
    children = (
        await client.get(f"{SESSIONS}/{by_native['root']['id']}/children")
    ).json()["items"]
    assert [item["native_session_id"] for item in children] == ["child"]
    assert (await client.get(f"{SESSIONS}/{by_native['child']['id']}/children")).json()[
        "items"
    ] == []
    assert json.dumps(children)  # plain read models


# --- review round: precedence, idle_since, cascades, events, heartbeat scrub ----


async def test_silence_past_a_day_is_abandoned_even_when_the_device_is_stale(
    client, device_client, db_session, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    await upload(device_client, token, [record(fresh(OPEN_EVENTS), mapping_id)])
    await _age_session(db_session, timedelta(hours=30))
    installation = await db_session.scalar(select(CompanionInstallation))
    installation.last_seen_at = datetime.now(timezone.utc) - timedelta(hours=30)
    await db_session.flush()
    [item] = await listed(client)
    assert (item["display_state"], item["ended_reason"]) == ("incomplete", "abandoned")
    await _age_session(db_session, timedelta(hours=2))
    [item] = await listed(client)
    assert item["display_state"] == "disconnected"


async def test_idle_since_marks_when_silence_began(
    client, device_client, db_session, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    await upload(device_client, token, [record(fresh(OPEN_EVENTS), mapping_id)])
    [item] = await listed(client)
    assert item["idle_since"] is None
    await _age_session(db_session, timedelta(hours=2))
    [item] = await listed(client)
    assert item["display_state"] == "idle"
    assert item["idle_since"] == item["last_event_at"]


async def test_deleting_a_parent_deletes_its_subagent_threads(
    client, device_client, db_session, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    root = record(with_ids(fresh(OPEN_EVENTS), "root"), mapping_id, session="root")
    child = record(with_ids(fresh(OPEN_EVENTS), "child"), mapping_id, session="child")
    child["parent_native_session_id"] = "root"
    grandchild = record(with_ids(fresh(OPEN_EVENTS), "gc"), mapping_id, session="gc")
    grandchild["parent_native_session_id"] = "child"
    await upload(device_client, token, [root, child, grandchild])
    by_native = {item["native_session_id"]: item for item in await listed(client)}
    assert (
        await client.delete(f"{SESSIONS}/{by_native['root']['id']}")
    ).status_code == 204
    assert await listed(client) == []
    natives = set(
        await db_session.scalars(select(AgentSessionTombstone.native_session_id))
    )
    assert natives == {"root", "child", "gc"}
    result = await ingest(device_client, token, [grandchild])
    assert result["dropped"][0]["reason"] == "session_deleted"


async def test_bulk_delete_publishes_one_installation_event(
    client, device_client, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    await upload(
        device_client,
        token,
        [
            record(with_ids(fresh(OPEN_EVENTS), name), mapping_id, session=name)
            for name in ("a", "b", "c")
        ],
    )
    installation_id = (await client.get(ME)).json()[0]["installation_id"]
    with patch.object(event_bus, "publish", new_callable=AsyncMock) as publish:
        response = await client.delete(f"{ME}/{installation_id}/sessions")
    assert response.json() == {"deleted": 3}
    assert [(t, p["reason"]) for t, p, _ in published(publish)] == [
        ("companion_installation.updated", "sessions_deleted")
    ]


def test_private_session_events_never_reach_agent_sockets():
    from app.core.event_bus import Event
    from app.services.events.connection_manager import ConnectionManager

    owner = uuid.uuid4()
    event = Event(
        event_type="agent_session.updated",
        workspace_id=uuid.uuid4(),
        payload={"owner_id": str(owner)},
    )
    human = type("Conn", (), {"user_id": owner, "agent_id": None})()
    agent = type("Conn", (), {"user_id": owner, "agent_id": uuid.uuid4()})()
    assert ConnectionManager._should_deliver(human, event)
    assert not ConnectionManager._should_deliver(agent, event)


@pytest.mark.parametrize(
    "detail,forbidden",
    [
        ("open file://" + "/" + "Users/me/x failed", "/" + "Users/"),
        ("cannot read " + "/" + "Users/John Doe/y", "/" + "Users/"),
        ("missing /home/me/.codex/config.toml", "/home/"),
        ("bad C:\\" + "Users\\me\\a.json", "\\" + "Users\\"),
    ],
)
async def test_heartbeat_detail_keeps_no_home_path(
    client, device_client, test_workspace, detail, forbidden
):
    token, _ = await enroll(client, test_workspace)
    report = status_report(
        agents=[{"harness": "claude_code", "state": "error", "detail": detail}]
    )
    await device_client.post(
        "/api/companion/status",
        json=report,
        headers={"Authorization": "Bearer " + token},
    )
    stored = (await client.get(ME)).json()[0]["status"]["agents"][0]["detail"]
    assert forbidden.lower() not in stored.lower(), stored


# --- parent/child cycles ----------------------------------------------------------


def _thread(name, parent=None):
    item = record(with_ids(fresh(OPEN_EVENTS), name), None, session=name)
    if parent:
        item["parent_native_session_id"] = parent
    return item


async def _upload_threads(device_client, token, mapping_id, threads):
    for thread in threads:
        thread["mapping_id"] = mapping_id
        await upload(device_client, token, [thread])


async def test_threads_naming_each_other_never_form_a_cycle(
    client, device_client, db_session, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    await _upload_threads(
        device_client,
        token,
        mapping_id,
        [_thread("a", parent="b"), _thread("b", parent="a")],
    )
    parents = {
        row.native_session_id: row.parent_session_id
        for row in await db_session.scalars(
            select(AgentSession).execution_options(populate_existing=True)
        )
    }
    ids = {
        row.native_session_id: row.id
        for row in await db_session.scalars(select(AgentSession))
    }
    # Exactly one direction is linked; the one that would close the loop is refused.
    assert sorted(value is None for value in parents.values()) == [False, True]
    assert parents["b"] == ids["a"] and parents["a"] is None


@pytest.mark.timeout(10)
async def test_deleting_inside_a_forced_cycle_terminates(
    client, device_client, db_session, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    await _upload_threads(
        device_client, token, mapping_id, [_thread("x"), _thread("y"), _thread("z")]
    )
    ids = {
        row.native_session_id: row.id
        for row in await db_session.scalars(select(AgentSession))
    }
    # A cycle that bypassed the ingest guard (e.g. older data) must not wedge a delete.
    for child, parent in [("x", "z"), ("y", "x"), ("z", "y")]:
        await db_session.execute(
            update(AgentSession)
            .where(AgentSession.id == ids[child])
            .values(parent_session_id=ids[parent])
        )
    await db_session.flush()
    response = await client.delete(f"{SESSIONS}/{ids['x']}")
    assert response.status_code == 204
    assert await db_session.scalar(select(func.count()).select_from(AgentSession)) == 0


async def test_deleting_a_deep_chain_removes_every_thread(
    client, device_client, db_session, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    names = [f"t{index}" for index in range(80)]
    threads = [
        _thread(name, parent=names[index - 1] if index else None)
        for index, name in enumerate(names)
    ]
    for thread in threads:
        thread["mapping_id"] = mapping_id
    for start in range(0, len(threads), 32):
        await upload(device_client, token, threads[start : start + 32])
    root_id = await db_session.scalar(
        select(AgentSession.id).where(AgentSession.native_session_id == "t0")
    )
    assert (await client.delete(f"{SESSIONS}/{root_id}")).status_code == 204
    assert await db_session.scalar(select(func.count()).select_from(AgentSession)) == 0


# --- sessions that never send an end event (headless `codex exec`) -------------


async def test_a_session_without_an_end_event_stops_reading_active(
    client, device_client, db_session, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    silences = {
        "fresh": timedelta(minutes=2),
        "quiet": timedelta(minutes=16),
        "abandoned": timedelta(hours=25),
    }
    for name in silences:
        await upload(
            device_client,
            token,
            [
                record(
                    with_ids(fresh(OPEN_EVENTS), name),
                    mapping_id,
                    harness="codex_cli",
                    session=f"exec-{name}",
                )
            ],
        )
    await upload(
        device_client,
        token,
        [record(with_ids(fresh(FIXTURE_EVENTS), "done"), mapping_id, session="done")],
    )
    now = datetime.now(timezone.utc)
    for name, silent_for in silences.items():
        await db_session.execute(
            update(AgentSession)
            .where(AgentSession.native_session_id == f"exec-{name}")
            .values(
                last_event_at=now - silent_for,
                started_at=now - silent_for - timedelta(minutes=1),
            )
        )
    await db_session.flush()

    by_session = {item["native_session_id"]: item for item in await listed(client)}
    assert {name: item["status"] for name, item in by_session.items()} == {
        "exec-fresh": "active",
        "exec-quiet": "idle",
        "exec-abandoned": "ended",
        "done": "ended",
    }
    quiet_since = datetime.fromisoformat(by_session["exec-quiet"]["idle_since"])
    expected = now - silences["quiet"]
    assert (quiet_since.year, quiet_since.month, quiet_since.day, quiet_since.hour) == (
        expected.year,
        expected.month,
        expected.day,
        expected.hour,
    )

    # The status filter agrees with the status every item reads.
    for status, expected_sessions in {
        "active": {"exec-fresh"},
        "idle": {"exec-quiet"},
        "ended": {"exec-abandoned", "done"},
    }.items():
        items = (await client.get(f"{SESSIONS}?status={status}")).json()["items"]
        assert {item["native_session_id"] for item in items} == expected_sessions
        assert {item["status"] for item in items} == {status}


async def test_an_abandoned_session_that_speaks_again_is_active(
    client, device_client, db_session, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    await upload(device_client, token, [record(fresh(OPEN_EVENTS), mapping_id)])
    await _age_session(db_session, timedelta(hours=25))
    [item] = await listed(client)
    assert item["status"] == "ended"
    await upload(
        device_client,
        token,
        [record(with_ids(fresh(OPEN_EVENTS[2:]), "resumed"), mapping_id)],
    )
    [item] = await listed(client)
    assert (item["status"], item["display_state"]) == ("active", "active")


async def test_ended_reason_follows_the_status_not_the_display_precedence(
    client, device_client, db_session, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    await upload(device_client, token, [record(fresh(OPEN_EVENTS), mapping_id)])
    await _age_session(db_session, timedelta(hours=25))
    installation = await db_session.scalar(select(CompanionInstallation))
    installation.paused = True
    await db_session.flush()
    [item] = await listed(client)
    assert (item["status"], item["display_state"], item["ended_reason"]) == (
        "ended",
        "paused",
        "abandoned",
    )

    await _age_session(db_session, timedelta(hours=2))
    [item] = await listed(client)
    assert (item["status"], item["ended_reason"]) == ("idle", None)
