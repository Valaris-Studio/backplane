# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Deleting captured content (contract §10): every deletion path queues the
doomed prefixes in the same transaction and releases their quota, the purge
job deletes bodies with retries, expires abandoned uploads, sweeps orphans
and reconciles counters that cascades it never saw."""

import os
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import delete, select, update

from app.models.agent_session import (
    AgentSession,
    AgentSessionContent,
    AgentSessionContentDeletion,
)
from app.models.companion import CompanionInstallation
from app.models.workspace import Workspace
from app.services.storage.session_content import LocalContentStore
from tests.rich_capture import (
    CONTENTS,
    ME,
    declaration,
    declare_and_upload,
    enroll_rich,
    ingest,
    installation_bytes,
    only_session,
    purge,
    put_chunk,
    rich_record,
    sessions_path,
)

pytestmark = pytest.mark.usefixtures("content_storage")

ORPHAN_AGE = timedelta(days=7)


async def rich(client, device_client, db_session, test_workspace, test_board):
    return await enroll_rich(
        client, device_client, db_session, test_workspace, test_board
    )


def files(storage) -> list[str]:
    return sorted(
        str(path.relative_to(storage)) for path in storage.rglob("*") if path.is_file()
    )


async def session_deletion(db_session, session_id) -> AgentSessionContentDeletion:
    """The one queued deletion of a session's prefix (a published body's
    staging is queued too, as the fallback of its after-commit delete)."""
    [deletion] = [
        item
        for item in await queued(db_session)
        if item.storage_prefix.endswith(f"/{session_id}/")
    ]
    return deletion


async def queued(db_session) -> list[AgentSessionContentDeletion]:
    return list(
        await db_session.scalars(
            select(AgentSessionContentDeletion).execution_options(
                populate_existing=True
            )
        )
    )


async def stored_body(client, device_client, db_session, test_workspace, test_board):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    uploaded = await declare_and_upload(device_client, enrolled, b"body " * 5000)
    return enrolled, uploaded


async def test_deleting_a_session_queues_its_prefix_and_releases_its_bytes(
    client,
    device_client,
    db_session,
    db_engine,
    test_workspace,
    test_board,
    content_storage,
):
    enrolled, _ = await stored_body(
        client, device_client, db_session, test_workspace, test_board
    )
    session = await only_session(db_session)
    assert await installation_bytes(db_session, enrolled) == 25_000
    assert (
        await client.delete(sessions_path(test_workspace, session.id))
    ).status_code == 204

    deletion = await session_deletion(db_session, session.id)
    assert deletion.storage_backend == "local"
    assert deletion.storage_prefix == (
        f"session-content/v1/{test_workspace.id}/{session.owner_id}/"
        f"{enrolled['installation_id']}/{session.id}/"
    )
    assert await installation_bytes(db_session, enrolled) == 0
    assert files(content_storage)  # bytes go eventually, the rows at once
    await db_session.commit()

    await purge(db_engine).run_purge()
    assert files(content_storage) == []
    assert await queued(db_session) == []


async def test_deleting_a_devices_sessions_queues_and_releases_in_one_step(
    client,
    device_client,
    db_session,
    db_engine,
    test_workspace,
    test_board,
    content_storage,
):
    enrolled, _ = await stored_body(
        client, device_client, db_session, test_workspace, test_board
    )
    session = await only_session(db_session)
    response = await client.delete(f"{ME}/{enrolled['installation_id']}/sessions")
    assert response.status_code == 200, response.text
    # Queued and released in the deletion's own transaction; the bytes are
    # left for the purge.
    deletion = await session_deletion(db_session, session.id)
    assert deletion.storage_prefix.endswith(
        f"/{enrolled['installation_id']}/{session.id}/"
    )
    assert await installation_bytes(db_session, enrolled) == 0
    assert files(content_storage)
    await db_session.commit()

    await purge(db_engine).run_purge()
    assert files(content_storage) == []
    assert await queued(db_session) == []


async def test_retention_deletes_bodies_with_their_sessions(
    client,
    device_client,
    db_session,
    db_engine,
    test_workspace,
    test_board,
    content_storage,
):
    enrolled, _ = await stored_body(
        client, device_client, db_session, test_workspace, test_board
    )
    await db_session.execute(
        update(CompanionInstallation)
        .where(CompanionInstallation.id == uuid.UUID(enrolled["installation_id"]))
        .values(retention_days=1)
    )
    await db_session.execute(
        update(AgentSession).values(
            last_event_at=datetime.now(timezone.utc) - timedelta(days=3)
        )
    )
    await db_session.commit()
    await purge(db_engine).run_purge()
    assert await db_session.scalar(select(AgentSession.id)) is None
    assert files(content_storage) == []
    assert await queued(db_session) == []
    assert await installation_bytes(db_session, enrolled) == 0


async def test_a_failed_body_deletion_is_retried_later_and_keeps_its_error(
    client,
    device_client,
    db_session,
    db_engine,
    test_workspace,
    test_board,
    content_storage,
    monkeypatch,
):
    await stored_body(client, device_client, db_session, test_workspace, test_board)
    session = await only_session(db_session)
    await client.delete(sessions_path(test_workspace, session.id))
    await db_session.commit()

    real_delete = LocalContentStore.delete_prefix

    def failing(self, prefix):
        raise OSError("bucket timeout")

    monkeypatch.setattr(LocalContentStore, "delete_prefix", failing)
    await purge(db_engine).run_purge()
    deletion = await session_deletion(db_session, session.id)
    assert deletion.attempts == 1
    assert "bucket timeout" in deletion.last_error
    retry_at = deletion.next_attempt_at.replace(tzinfo=timezone.utc)
    assert retry_at > datetime.now(timezone.utc)

    monkeypatch.setattr(LocalContentStore, "delete_prefix", real_delete)
    await purge(db_engine).run_purge()
    assert await session_deletion(db_session, session.id)  # not due yet
    await db_session.execute(
        update(AgentSessionContentDeletion).values(
            next_attempt_at=datetime.now(timezone.utc) - timedelta(seconds=1)
        )
    )
    await db_session.commit()
    await purge(db_engine).run_purge()
    assert await queued(db_session) == []
    assert files(content_storage) == []


async def test_an_abandoned_upload_expires_and_releases_its_reservation(
    client,
    device_client,
    db_session,
    db_engine,
    test_workspace,
    test_board,
    content_storage,
):
    from unittest.mock import AsyncMock, patch

    from app.core.event_bus import event_bus

    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    body = b"x" * (5 << 20)
    [ack] = (
        await ingest(
            device_client,
            enrolled,
            [
                rich_record(
                    enrolled["mapping_id"], [declaration(body, delivery="upload")]
                )
            ],
        )
    )["contents"]
    await put_chunk(device_client, enrolled, ack["content_id"], 0, body[: 4 << 20])
    assert files(content_storage)
    assert (await only_session(db_session)).content_bytes == len(body)
    await db_session.execute(
        update(AgentSessionContent).values(
            upload_expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)
        )
    )
    await db_session.commit()

    with patch.object(event_bus, "publish", new_callable=AsyncMock) as publish:
        await purge(db_engine).run_purge()
    status = await device_client.get(
        f"{CONTENTS}/{ack['content_id']}", headers=enrolled["headers"]
    )
    assert status.json() == {
        "content_id": ack["content_id"],
        "state": "recorded",
        "coverage": "expired",
        "coverage_reason": "staging_expired",
        "upload": None,
    }
    assert (await only_session(db_session)).content_bytes == 0
    assert await installation_bytes(db_session, enrolled) == 0
    assert files(content_storage) == []
    reasons = [
        call.kwargs["payload"]["reason"]
        for call in publish.await_args_list
        if call.kwargs.get("event_type") == "agent_session.updated"
    ]
    assert reasons == ["content_expired"]


async def test_the_orphan_sweep_resumes_one_page_per_pass(
    client,
    device_client,
    db_session,
    db_engine,
    test_workspace,
    test_board,
    content_storage,
):
    """m4: a pass lists at most 1,000 objects of an installation and the next
    pass resumes from the persisted token. Young objects may still be in
    flight and are kept. The first page holds only young objects (their
    session sorts first), so orphans past it go only on a resumed pass."""
    enrolled, uploaded = await stored_body(
        client, device_client, db_session, test_workspace, test_board
    )
    session = await only_session(db_session)
    installation_prefix = content_storage / (
        f"session-content/v1/{test_workspace.id}/{session.owner_id}/"
        f"{enrolled['installation_id']}"
    )
    first_page = installation_prefix / str(uuid.UUID(int=0))
    young = []
    for index in range(1000):
        staged = first_page / f"{uuid.UUID(int=index + 1)}" / "staging" / "00"
        staged.parent.mkdir(parents=True)
        staged.write_bytes(b"still uploading")
        young.append(staged)
    old = time.time() - ORPHAN_AGE.total_seconds() - 3600
    orphans = []
    for index in range(5):
        orphan = (
            installation_prefix
            / ("f" * 8 + str(uuid.uuid4())[8:])
            / str(uuid.uuid4())
            / "body"
        )
        orphan.parent.mkdir(parents=True)
        orphan.write_bytes(b"left behind")
        os.utime(orphan, (old, old))
        orphans.append(orphan)
    gone_workspace = content_storage / f"session-content/v1/{uuid.uuid4()}/x/y/z/c/body"
    gone_workspace.parent.mkdir(parents=True)
    gone_workspace.write_bytes(b"of a deleted workspace")
    await db_session.commit()

    async def sweep_cursor():
        installation = await db_session.scalar(
            select(CompanionInstallation)
            .where(CompanionInstallation.id == uuid.UUID(enrolled["installation_id"]))
            .execution_options(populate_existing=True)
        )
        return installation.content_sweep_cursor

    await purge(db_engine).run_purge()
    assert not gone_workspace.exists()
    assert all(orphan.exists() for orphan in orphans)
    assert await sweep_cursor() is not None

    await purge(db_engine).run_purge()
    assert not any(orphan.exists() for orphan in orphans)
    assert all(staged.exists() for staged in young)
    kept = uploaded["ack"]["content_id"]
    assert any(path.endswith(f"{kept}/body") for path in files(content_storage))
    assert await sweep_cursor() is None


async def test_purge_reconciles_device_bytes_after_a_workspace_cascade(
    client, device_client, db_session, db_engine, test_workspace, test_board
):
    """R2-7: a workspace delete removes sessions through the FK cascade the
    app never sees; the purge recomputes the device's total from what is left."""
    enrolled, _ = await stored_body(
        client, device_client, db_session, test_workspace, test_board
    )
    assert await installation_bytes(db_session, enrolled) == 25_000
    await db_session.execute(delete(Workspace).where(Workspace.id == test_workspace.id))
    await db_session.commit()
    assert await installation_bytes(db_session, enrolled) == 25_000

    await purge(db_engine).run_purge()
    assert await installation_bytes(db_session, enrolled) == 0


async def test_a_malformed_key_never_stops_the_cleanup(
    client,
    device_client,
    db_session,
    db_engine,
    test_workspace,
    test_board,
    content_storage,
):
    """Keys the store holds that no row could own (too short, not a uuid) are
    skipped or swept, and every later step of the pass still runs."""
    enrolled, _ = await stored_body(
        client, device_client, db_session, test_workspace, test_board
    )
    session = await only_session(db_session)
    installation_dir = content_storage / (
        f"session-content/v1/{test_workspace.id}/{session.owner_id}/"
        f"{enrolled['installation_id']}"
    )
    stray = installation_dir / "stray"
    stray.write_bytes(b"x")
    foreign = content_storage / "session-content/v1/not-a-workspace/kept.txt"
    foreign.parent.mkdir(parents=True)
    foreign.write_bytes(b"not ours to judge")
    # Drift the purge must still reconcile after the sweep met the strays.
    await db_session.execute(
        update(CompanionInstallation)
        .where(CompanionInstallation.id == uuid.UUID(enrolled["installation_id"]))
        .values(content_bytes=1)
    )
    await db_session.commit()

    await purge(db_engine).run_purge()
    assert await installation_bytes(db_session, enrolled) == 25_000
    assert foreign.exists()
    assert stray.exists()  # young: it may still be in flight


async def test_one_failing_cleanup_step_leaves_the_others_running(
    client,
    device_client,
    db_session,
    db_engine,
    test_workspace,
    test_board,
    monkeypatch,
):
    enrolled, _ = await stored_body(
        client, device_client, db_session, test_workspace, test_board
    )
    await db_session.execute(
        update(CompanionInstallation)
        .where(CompanionInstallation.id == uuid.UUID(enrolled["installation_id"]))
        .values(content_bytes=1)
    )
    await db_session.commit()

    def unavailable(*_args, **_kwargs):
        raise OSError("store unreachable")

    monkeypatch.setattr(LocalContentStore, "list_prefixes", unavailable)
    await purge(db_engine).run_purge()
    assert await installation_bytes(db_session, enrolled) == 25_000


async def test_bodies_of_sessions_deleted_without_the_app_are_swept(
    client,
    device_client,
    db_session,
    db_engine,
    test_workspace,
    test_board,
    content_storage,
):
    """While code from before rich capture runs, deleting sessions cascades
    their content rows but queues no stored prefix. Once no session of the
    device is left in that workspace, the sweep still finds its bodies."""
    enrolled, uploaded = await stored_body(
        client, device_client, db_session, test_workspace, test_board
    )
    [body] = list(content_storage.rglob("body"))
    old = time.time() - ORPHAN_AGE.total_seconds() - 3600
    os.utime(body, (old, old))
    await db_session.execute(delete(AgentSession))
    await db_session.commit()

    await purge(db_engine).run_purge()
    assert not body.exists()
