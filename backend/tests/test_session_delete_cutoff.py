# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Deleting a session deletes its history up to the deletion, not the native
session for good: what was observed at or before the cutoff never comes back,
in any arrival order, while later activity is captured as a fresh session."""

import copy
import itertools
import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine, func, inspect, select

from app.core.time import as_utc
from app.database import get_db
from app.main import create_app
from app.models.agent_session import (
    AgentSession,
    AgentSessionEvent,
    AgentSessionTombstone,
)
from app.models.companion import CompanionInstallation
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from tests.test_agent_sessions import FIXTURE_EVENTS, ME, SESSIONS, enroll, record
from tests.test_session_cost_migration import VERSIONS, _at_109, _columns, _load

NATIVE = "resumed-after-login"
PROMPT_EVENT = FIXTURE_EVENTS[1]
TOOL_EVENT = FIXTURE_EVENTS[3]
PRE_DELETION_PROMPT = "pre-deletion prompt that must never resurface"
POST_CUTOFF_TOOL_OUTPUT = "post-cutoff tool output the standard level withholds"


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


def _now():
    return datetime.now(timezone.utc)


def _events(prefix, at, *, count=3, template=None):
    events = []
    for index in range(count):
        event = copy.deepcopy(template or FIXTURE_EVENTS[index % 3])
        event["event"]["id"] = f"{prefix}-{index}"
        event["timestamp"] = (at + timedelta(milliseconds=index)).isoformat()
        events.append(event)
    return events


def _prompt(prefix, at, text):
    event = copy.deepcopy(PROMPT_EVENT)
    event["event"]["id"] = f"{prefix}-prompt"
    event["timestamp"] = at.isoformat()
    event["prompt"] = {**event.get("prompt", {}), "text": text}
    return event


def _record(events, mapping_id, captured_at, *, capture_id=None):
    built = record(events, mapping_id, session=NATIVE)
    built["captured_at"] = captured_at.isoformat()
    if capture_id:
        built["capture_id"] = capture_id
    return built


async def _ingest(device_client, token, records):
    response = await device_client.post(
        "/api/companion/ingest",
        json={"records": records},
        headers={"Authorization": "Bearer " + token},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["rejected"] == [], body
    return body


async def _stored_event_ids(db_session) -> set[str]:
    return set(await db_session.scalars(select(AgentSessionEvent.event_id)))


async def _stored_json(db_session) -> str:
    return json.dumps(list(await db_session.scalars(select(AgentSessionEvent.event))))


async def _session_count(db_session) -> int:
    return await db_session.scalar(select(func.count()).select_from(AgentSession))


async def _delete_only_session(client):
    [item] = (await client.get(SESSIONS)).json()["items"]
    assert (await client.delete(f"{SESSIONS}/{item['id']}")).status_code == 204
    return item


async def _tombstone(db_session) -> AgentSessionTombstone:
    return await db_session.scalar(
        select(AgentSessionTombstone).execution_options(populate_existing=True)
    )


async def _captured_then_deleted(client, device_client, db_session, workspace):
    """A session captured ten minutes ago, then deleted by its owner."""
    token, mapping_id = await enroll(client, workspace)
    observed_at = _now() - timedelta(minutes=10)
    pre_deletion = _record(
        [
            *_events("old", observed_at),
            _prompt("old", observed_at, PRE_DELETION_PROMPT),
        ],
        mapping_id,
        observed_at,
    )
    await _ingest(device_client, token, [pre_deletion])
    await _delete_only_session(client)
    return token, mapping_id, pre_deletion, observed_at


# --- the cutoff -----------------------------------------------------------------


async def test_owner_delete_records_a_cutoff_at_or_after_the_deletion(
    client, device_client, db_session, test_workspace
):
    before = _now()
    await _captured_then_deleted(client, device_client, db_session, test_workspace)
    tombstone = await _tombstone(db_session)
    assert tombstone.history_cutoff is not None
    assert as_utc(tombstone.history_cutoff) >= as_utc(tombstone.deleted_at) >= before


async def test_activity_after_the_cutoff_is_a_fresh_visible_session(
    client, device_client, db_session, test_workspace
):
    token, mapping_id, _, _ = await _captured_then_deleted(
        client, device_client, db_session, test_workspace
    )
    deleted = await _tombstone(db_session)
    after_cutoff = as_utc(deleted.history_cutoff) + timedelta(minutes=1)

    result = await _ingest(
        device_client,
        token,
        [_record(_events("new", after_cutoff), mapping_id, after_cutoff)],
    )

    assert result["dropped"] == []
    [history] = result["history_deleted"]
    assert (
        history["harness"],
        history["native_session_id"],
        history["mapping_id"],
        history["reason"],
    ) == ("claude_code", NATIVE, mapping_id, "owner")
    assert datetime.fromisoformat(history["deleted_through"]) == as_utc(
        deleted.history_cutoff
    )
    [item] = (await client.get(SESSIONS)).json()["items"]
    assert item["id"] != str(deleted.session_id)
    assert item["native_session_id"] == NATIVE
    assert await _stored_event_ids(db_session) == {"new-0", "new-1", "new-2"}


async def test_an_untouched_session_reports_no_deleted_history(
    client, device_client, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    result = await _ingest(
        device_client, token, [_record(_events("a", _now()), mapping_id, _now())]
    )
    assert result["history_deleted"] == []


async def test_events_at_the_cutoff_are_deleted_and_after_it_kept(
    client, device_client, db_session, test_workspace
):
    token, mapping_id, _, _ = await _captured_then_deleted(
        client, device_client, db_session, test_workspace
    )
    cutoff = as_utc((await _tombstone(db_session)).history_cutoff)
    at_cutoff = _events("edge", cutoff, count=1)
    just_after = _events("after", cutoff + timedelta(milliseconds=1), count=1)

    result = await _ingest(
        device_client,
        token,
        [_record([*at_cutoff, *just_after], mapping_id, cutoff + timedelta(seconds=1))],
    )

    assert result["dropped"] == []
    assert await _stored_event_ids(db_session) == {"after-0"}


async def test_a_record_captured_at_or_before_the_cutoff_is_dropped_whole(
    client, device_client, db_session, test_workspace
):
    token, mapping_id, _, _ = await _captured_then_deleted(
        client, device_client, db_session, test_workspace
    )
    cutoff = as_utc((await _tombstone(db_session)).history_cutoff)
    # Queued before the deletion; an event timestamp alone would pass.
    queued = _record(
        _events("queued", cutoff + timedelta(minutes=5)), mapping_id, cutoff
    )

    result = await _ingest(device_client, token, [queued])

    assert result["dropped"] == [
        {"capture_id": queued["capture_id"], "reason": "session_deleted"}
    ]
    assert await _session_count(db_session) == 0


# --- privacy invariant: pre-deletion content never resurfaces ---------------------


@pytest.mark.parametrize("one_batch", [True, False], ids=["one-batch", "per-record"])
@pytest.mark.parametrize(
    "order", list(itertools.permutations(["retry", "backfill", "new", "mixed"]))
)
async def test_pre_deletion_content_never_resurfaces_in_any_arrival_order(
    client, device_client, db_session, test_workspace, order, one_batch
):
    token, mapping_id, pre_deletion, observed_at = await _captured_then_deleted(
        client, device_client, db_session, test_workspace
    )
    after_cutoff = as_utc((await _tombstone(db_session)).history_cutoff) + timedelta(
        minutes=2
    )
    old_events = pre_deletion["events"]
    records = {
        # The device's queued retry of the very record that was deleted.
        "retry": pre_deletion,
        # A transcript re-read after the resume: old events, a new capture.
        "backfill": _record(old_events, mapping_id, after_cutoff),
        "new": _record(_events("new", after_cutoff), mapping_id, after_cutoff),
        "mixed": _record(
            [*old_events, *_events("mixed", after_cutoff)], mapping_id, after_cutoff
        ),
    }
    batches = (
        [[records[name] for name in order]]
        if one_batch
        else [[records[name]] for name in order]
    )
    # Twice: duplicates and retries of every record, after the fact.
    for batch in [*batches, *batches]:
        await _ingest(device_client, token, batch)

    assert await _stored_event_ids(db_session) == {
        "new-0",
        "new-1",
        "new-2",
        "mixed-0",
        "mixed-1",
        "mixed-2",
    }
    stored = await _stored_json(db_session)
    assert PRE_DELETION_PROMPT not in stored
    session = await db_session.scalar(
        select(AgentSession).execution_options(populate_existing=True)
    )
    assert session.event_count == 6
    assert as_utc(session.started_at) > observed_at
    assert session.title is None or PRE_DELETION_PROMPT not in session.title


async def test_a_device_clock_running_ahead_moves_the_cutoff_with_it(
    client, device_client, db_session, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    ahead = timedelta(hours=1)
    device_now = _now() + ahead
    await _ingest(
        device_client,
        token,
        [_record(_events("old", device_now), mapping_id, device_now)],
    )
    await _delete_only_session(client)
    # Captured on the device a moment before the deletion, uploaded after it:
    # by the server's clock its timestamps read as almost an hour later.
    queued_before_delete = _now() + ahead - timedelta(seconds=30)
    late = _record(
        _events("late", queued_before_delete), mapping_id, queued_before_delete
    )

    result = await _ingest(device_client, token, [late])

    assert result["dropped"] == [
        {"capture_id": late["capture_id"], "reason": "session_deleted"}
    ]
    assert await _session_count(db_session) == 0


async def test_post_cutoff_content_still_follows_the_standard_level(
    client, device_client, db_session, test_workspace
):
    token, mapping_id, _, _ = await _captured_then_deleted(
        client, device_client, db_session, test_workspace
    )
    after_cutoff = as_utc((await _tombstone(db_session)).history_cutoff) + timedelta(
        minutes=1
    )
    tool = copy.deepcopy(TOOL_EVENT)
    tool["event"]["id"] = "new-tool"
    tool["timestamp"] = after_cutoff.isoformat()
    tool["tool"] = {"name": "Bash", "output": POST_CUTOFF_TOOL_OUTPUT}

    await _ingest(device_client, token, [_record([tool], mapping_id, after_cutoff)])

    assert await _stored_event_ids(db_session) == {"new-tool"}
    assert POST_CUTOFF_TOOL_OUTPUT not in await _stored_json(db_session)


# --- deleting again, bulk delete, and tombstones from before cutoffs ---------------


async def test_deleting_the_resumed_session_moves_the_cutoff_forward(
    client, device_client, db_session, test_workspace
):
    token, mapping_id, _, _ = await _captured_then_deleted(
        client, device_client, db_session, test_workspace
    )
    first_cutoff = as_utc((await _tombstone(db_session)).history_cutoff)
    resumed_at = first_cutoff + timedelta(minutes=1)
    resumed = _record(_events("resumed", resumed_at), mapping_id, resumed_at)
    await _ingest(device_client, token, [resumed])

    await _delete_only_session(client)

    assert as_utc((await _tombstone(db_session)).history_cutoff) > first_cutoff
    replay = _record(
        resumed["events"], mapping_id, resumed_at, capture_id=uuid.uuid4().hex
    )
    result = await _ingest(device_client, token, [resumed, replay])
    assert [drop["capture_id"] for drop in result["dropped"]] == [
        resumed["capture_id"],
        replay["capture_id"],
    ]
    assert await _session_count(db_session) == 0


async def test_bulk_delete_of_a_device_uses_the_same_cutoff(
    client, device_client, db_session, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    observed_at = _now() - timedelta(minutes=10)
    before = _record(_events("old", observed_at), mapping_id, observed_at)
    await _ingest(device_client, token, [before])
    installation_id = (await client.get(ME)).json()[0]["installation_id"]
    assert (await client.delete(f"{ME}/{installation_id}/sessions")).status_code == 200

    cutoff = as_utc((await _tombstone(db_session)).history_cutoff)
    after = _record(
        _events("new", cutoff + timedelta(minutes=1)),
        mapping_id,
        cutoff + timedelta(minutes=1),
    )
    backfill = _record(before["events"], mapping_id, cutoff + timedelta(minutes=1))
    result = await _ingest(device_client, token, [before, backfill, after])

    assert [drop["capture_id"] for drop in result["dropped"]] == [
        before["capture_id"],
        backfill["capture_id"],
    ]
    assert await _stored_event_ids(db_session) == {"new-0", "new-1", "new-2"}


async def _legacy_tombstone(
    db_session,
    workspace,
    deleted_at,
    history_cutoff=None,
    *,
    cutoff_deleted_at=None,
    reason="owner",
):
    installation = await db_session.scalar(select(CompanionInstallation))
    db_session.add(
        AgentSessionTombstone(
            session_id=uuid.uuid4(),
            installation_id=installation.id,
            workspace_id=workspace.id,
            owner_id=installation.owner_id,
            harness="claude_code",
            native_session_id=NATIVE,
            reason=reason,
            deleted_at=deleted_at,
            history_cutoff=history_cutoff,
            history_cutoff_deleted_at=cutoff_deleted_at,
        )
    )
    await db_session.flush()


async def test_a_cutoff_computed_for_another_deletion_is_not_trusted(
    client, device_client, db_session, test_workspace
):
    """The previous release re-deleting mid-deploy moves deleted_at but not
    the cutoff, even when the stale cutoff still lies after the new deletion."""
    token, mapping_id = await enroll(client, test_workspace)
    deleted_at = _now() - timedelta(minutes=5)
    await _legacy_tombstone(
        db_session,
        test_workspace,
        deleted_at,
        deleted_at + timedelta(minutes=1),
        cutoff_deleted_at=deleted_at - timedelta(hours=1),
    )
    after = _now() + timedelta(minutes=10)

    result = await _ingest(
        device_client, token, [_record(_events("new", after), mapping_id, after)]
    )

    assert len(result["dropped"]) == 1
    assert await _session_count(db_session) == 0


async def test_a_retention_tombstone_reports_its_own_reason(
    client, device_client, db_session, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    deleted_at = _now() - timedelta(days=2)
    await _legacy_tombstone(
        db_session,
        test_workspace,
        deleted_at,
        deleted_at + timedelta(minutes=2),
        cutoff_deleted_at=deleted_at,
        reason="retention",
    )

    result = await _ingest(
        device_client, token, [_record(_events("new", _now()), mapping_id, _now())]
    )

    assert result["dropped"] == []
    assert [history["reason"] for history in result["history_deleted"]] == ["retention"]


async def test_a_deletion_holds_when_the_folder_moves_to_another_workspace(
    client, device_client, db_session, test_workspace, test_user
):
    """Deleted in workspace A, then the folder is remapped to workspace B: a
    re-read of the deleted history under B must not land where B's members
    can see it. Later activity is kept, and each mapping hears of the cutoff."""
    second_workspace = Workspace(name="Second", slug="second", created_by=test_user.id)
    db_session.add(second_workspace)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=second_workspace.id,
            user_id=test_user.id,
            role=WorkspaceRole.owner,
        )
    )
    await db_session.flush()
    token, mapping_a = await enroll(client, test_workspace)
    installation_id = (await client.get(ME)).json()[0]["installation_id"]
    mapping_b = (
        await client.post(
            f"{ME}/{installation_id}/mappings",
            json={
                "workspace_id": str(second_workspace.id),
                "root_path": "/synthetic/other",
            },
        )
    ).json()["id"]
    observed_at = _now() - timedelta(minutes=10)
    deleted = _record(
        [*_events("a", observed_at), _prompt("a", observed_at, PRE_DELETION_PROMPT)],
        mapping_a,
        observed_at,
    )
    await _ingest(device_client, token, [deleted])
    await _delete_only_session(client)
    cutoff = as_utc((await _tombstone(db_session)).history_cutoff)
    after = cutoff + timedelta(minutes=1)
    reread_under_b = _record(deleted["events"], mapping_b, after)
    retried_under_b = _record(
        deleted["events"], mapping_b, observed_at, capture_id=uuid.uuid4().hex
    )

    result = await _ingest(
        device_client,
        token,
        [
            reread_under_b,
            retried_under_b,
            _record(_events("b-new", after), mapping_b, after),
            _record(_events("a-new", after), mapping_a, after),
        ],
    )

    assert [drop["capture_id"] for drop in result["dropped"]] == [
        reread_under_b["capture_id"],
        retried_under_b["capture_id"],
    ]
    assert PRE_DELETION_PROMPT not in await _stored_json(db_session)
    assert await _stored_event_ids(db_session) == {
        "b-new-0",
        "b-new-1",
        "b-new-2",
        "a-new-0",
        "a-new-1",
        "a-new-2",
    }
    reported = {history["mapping_id"]: history for history in result["history_deleted"]}
    assert set(reported) == {mapping_a, mapping_b}
    assert datetime.fromisoformat(reported[mapping_b]["deleted_through"]) == cutoff


@pytest.mark.parametrize(
    "deleted_ago,stored",
    [(timedelta(hours=2), False), (timedelta(days=2), True)],
    ids=["within-a-day", "past-a-day"],
)
async def test_a_tombstone_from_before_cutoffs_holds_for_the_clock_skew_bound(
    client, device_client, db_session, test_workspace, deleted_ago, stored
):
    token, mapping_id = await enroll(client, test_workspace)
    await _legacy_tombstone(db_session, test_workspace, _now() - deleted_ago)

    result = await _ingest(
        device_client, token, [_record(_events("new", _now()), mapping_id, _now())]
    )

    assert (result["dropped"] == []) is stored
    assert await _session_count(db_session) == int(stored)


async def test_a_cutoff_older_than_its_deletion_is_not_trusted(
    client, device_client, db_session, test_workspace
):
    """The previous release, re-deleting during a rolling deploy, moves
    deleted_at but not the cutoff; the stale cutoff must not open a window."""
    token, mapping_id = await enroll(client, test_workspace)
    deleted_at = _now() - timedelta(minutes=5)
    await _legacy_tombstone(
        db_session, test_workspace, deleted_at, deleted_at - timedelta(days=3)
    )

    result = await _ingest(
        device_client, token, [_record(_events("new", _now()), mapping_id, _now())]
    )

    assert len(result["dropped"]) == 1
    assert await _session_count(db_session) == 0


# --- migration --------------------------------------------------------------------


def test_cutoff_migration_is_additive_nullable_and_reverses(tmp_path):
    migration = _load(VERSIONS / "117_session_tombstone_history_cutoff.py")
    assert (migration.revision, migration.down_revision) == ("117", "116")
    engine = create_engine("sqlite:///" + str(tmp_path / "cutoff.db"))
    with engine.begin() as connection:
        _at_109(connection)
        connection.exec_driver_sql(
            "INSERT INTO agent_session_tombstones (id, session_id, installation_id, "
            "workspace_id, owner_id, harness, native_session_id, reason, deleted_at) "
            "VALUES ('t', 's', 'i', 'w', 'o', 'claude_code', 'n', 'owner', "
            "'2026-09-25')"
        )
        migration.op = Operations(MigrationContext.configure(connection))
        for _ in range(2):  # up, down, and up again
            migration.upgrade()
            columns = _columns(inspect(connection), "agent_session_tombstones")
            assert columns["history_cutoff"] is True
            assert columns["history_cutoff_deleted_at"] is True
            assert "ix_agent_session_captures_installation_received" in {
                index["name"]
                for index in inspect(connection).get_indexes("agent_session_captures")
            }
            assert "ix_agent_session_tombstones_installation_native" in {
                index["name"]
                for index in inspect(connection).get_indexes("agent_session_tombstones")
            }
            assert (
                connection.exec_driver_sql(
                    "SELECT history_cutoff FROM agent_session_tombstones"
                ).scalar()
                is None
            )
            migration.downgrade()
            columns = _columns(inspect(connection), "agent_session_tombstones")
            assert "history_cutoff" not in columns
            assert "history_cutoff_deleted_at" not in columns
            assert "ix_agent_session_captures_installation_received" not in {
                index["name"]
                for index in inspect(connection).get_indexes("agent_session_captures")
            }
            assert "ix_agent_session_tombstones_installation_native" not in {
                index["name"]
                for index in inspect(connection).get_indexes("agent_session_tombstones")
            }
    engine.dispose()
