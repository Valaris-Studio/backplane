# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Chunked, resumable uploads (contract §7 Upload): digest-checked chunks,
finalize re-verifies the composed body, re-sniffs images and re-runs the
policy and placement checks, and only then is a body readable."""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings
from app.models.agent_session import AgentSessionContent, AgentSessionContentDeletion
from app.models.companion import CompanionInstallation
from app.schemas.session_content import (
    CHUNK_BYTES,
    ChunkReceipt,
    ContentError,
    ContentUploadState,
)
from app.services.storage.session_content import LocalContentStore
from tests.rich_capture import (
    CONTENTS,
    ME,
    PNG,
    ROOT,
    declaration,
    declare_and_upload,
    enroll_rich,
    finalize,
    ingest,
    installation_bytes,
    only_session,
    purge,
    put_chunk,
    rich_record,
    sessions_path,
    sha256,
    upload,
)

pytestmark = pytest.mark.usefixtures("content_storage")


async def rich(client, device_client, db_session, test_workspace, test_board, **kw):
    return await enroll_rich(
        client, device_client, db_session, test_workspace, test_board, **kw
    )


async def declared(device_client, enrolled, body: bytes, **fields) -> dict:
    result = await ingest(
        device_client,
        enrolled,
        [
            rich_record(
                enrolled["mapping_id"], [declaration(body, delivery="upload", **fields)]
            )
        ],
    )
    [ack] = result["contents"]
    assert ack["outcome"] == "upload_required", ack
    return ack


async def row(db_session, content_id) -> AgentSessionContent:
    return await db_session.scalar(
        select(AgentSessionContent)
        .where(AgentSessionContent.id == uuid.UUID(content_id))
        .execution_options(populate_existing=True)
    )


def error(response, status: int, code: str) -> dict:
    assert response.status_code == status, response.text
    body = ContentError.model_validate(response.json())
    assert body.error_code == code
    return response.json()


async def received(device_client, enrolled, content_id) -> list[int] | None:
    status = await device_client.get(
        f"{CONTENTS}/{content_id}", headers=enrolled["headers"]
    )
    state = ContentUploadState.model_validate(status.json())
    return state.upload.received_chunks if state.upload else None


def stored_files(storage) -> list[str]:
    return sorted(
        str(path.relative_to(storage)) for path in storage.rglob("*") if path.is_file()
    )


async def test_a_multi_chunk_body_becomes_available_only_after_finalize(
    client, device_client, db_session, test_workspace, test_board, content_storage
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    body = ("é" * (CHUNK_BYTES // 2) + "tail").encode()
    ack = await declared(device_client, enrolled, body)
    assert ack["upload"]["chunk_count"] == 2
    content_id = ack["content_id"]

    second = await put_chunk(device_client, enrolled, content_id, 1, body[CHUNK_BYTES:])
    receipt = ChunkReceipt.model_validate(second.json())
    assert (receipt.index, receipt.received_chunks, receipt.complete) == (1, [1], False)
    status = await device_client.get(
        f"{CONTENTS}/{content_id}", headers=enrolled["headers"]
    )
    pending = ContentUploadState.model_validate(status.json())
    assert (pending.state, pending.coverage, pending.coverage_reason) == (
        "pending",
        "not_yet_uploaded",
        "upload_pending",
    )
    assert pending.upload.received_chunks == [1]
    # Not readable while pending.
    session = await only_session(db_session)
    body_url = f"{sessions_path(test_workspace, session.id)}/contents/{content_id}/body"
    error(await client.get(body_url), 404, "content_not_found")

    first = await put_chunk(device_client, enrolled, content_id, 0, body[:CHUNK_BYTES])
    assert first.json()["complete"] is True
    final = await finalize(device_client, enrolled, content_id, body)
    assert final.status_code == 200, final.text
    assert ContentUploadState.model_validate(final.json()).state == "available"
    assert final.json() == {
        "content_id": content_id,
        "state": "available",
        "coverage": "captured",
        "coverage_reason": None,
        "upload": None,
    }
    stored = await row(db_session, content_id)
    assert (stored.state, stored.coverage, stored.sha256) == (
        "available",
        "captured",
        sha256(body),
    )
    # Staging is gone; the composed body is the only copy.
    files = stored_files(content_storage)
    assert len(files) == 1 and files[0].endswith(f"{content_id}/body")
    assert stored.preview and len(stored.preview.encode()) <= 2048
    assert (await client.get(body_url)).status_code == 200


async def test_chunk_retries_are_idempotent_and_other_bytes_conflict(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    body = b"r" * 20_000
    ack = await declared(device_client, enrolled, body)
    content_id = ack["content_id"]
    assert (
        await put_chunk(device_client, enrolled, content_id, 0, body)
    ).status_code == 200
    again = await put_chunk(device_client, enrolled, content_id, 0, body)
    assert again.status_code == 200 and again.json()["received_chunks"] == [0]
    other = b"s" * 20_000
    error(
        await put_chunk(device_client, enrolled, content_id, 0, other),
        409,
        "chunk_conflict",
    )


async def test_chunks_are_checked_before_anything_is_stored(
    client, device_client, db_session, test_workspace, test_board, content_storage
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    body = b"c" * 20_000
    ack = await declared(device_client, enrolled, body)
    content_id = ack["content_id"]
    error(
        await put_chunk(device_client, enrolled, content_id, 0, body, digest="0" * 64),
        422,
        "chunk_checksum_mismatch",
    )
    out_of_range = error(
        await put_chunk(device_client, enrolled, content_id, 1, body),
        422,
        "chunk_out_of_range",
    )
    assert out_of_range["error_params"] == {"chunk_count": 1}
    error(
        await put_chunk(
            device_client, enrolled, content_id, 0, b"!" * (CHUNK_BYTES + 1)
        ),
        413,
        "chunk_too_large",
    )
    mismatch = error(
        await put_chunk(device_client, enrolled, content_id, 0, body + b"!"),
        422,
        "chunk_size_mismatch",
    )
    assert mismatch["error_params"] == {
        "expected_bytes": 20_000,
        "received_bytes": 20_001,
    }
    assert stored_files(content_storage) == []
    assert (await row(db_session, content_id)).state == "pending"


async def test_every_chunk_but_the_last_is_exactly_chunk_bytes(
    client, device_client, db_session, test_workspace, test_board, content_storage
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    body = b"n" * (CHUNK_BYTES + 10)
    ack = await declared(device_client, enrolled, body)
    short = error(
        await put_chunk(device_client, enrolled, ack["content_id"], 0, body[:1000]),
        422,
        "chunk_size_mismatch",
    )
    assert short["error_params"] == {
        "expected_bytes": CHUNK_BYTES,
        "received_bytes": 1000,
    }
    assert stored_files(content_storage) == []


async def test_finalize_before_every_chunk_arrived_names_the_missing_ones(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    body = b"m" * (CHUNK_BYTES + 10)
    ack = await declared(device_client, enrolled, body)
    await put_chunk(device_client, enrolled, ack["content_id"], 1, body[CHUNK_BYTES:])
    incomplete = error(
        await finalize(device_client, enrolled, ack["content_id"], body),
        409,
        "upload_incomplete",
    )
    assert incomplete["error_params"] == {"missing_chunks": [0]}


async def test_a_finalize_that_contradicts_the_declaration_is_refused(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    body = b"d" * 20_000
    ack = await declared(device_client, enrolled, body)
    await put_chunk(device_client, enrolled, ack["content_id"], 0, body)
    error(
        await finalize(
            device_client, enrolled, ack["content_id"], body, sha256="1" * 64
        ),
        422,
        "body_checksum_mismatch",
    )


async def test_three_failed_finalizes_record_the_upload_as_failed(
    client, device_client, db_session, test_workspace, test_board
):
    """The chunks each match their digests but the whole does not match the
    declaration: refused every time, then the server gives up and settles it."""
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    declared_body = b"a" * 20_000
    sent_body = b"b" * 20_000
    ack = await declared(device_client, enrolled, declared_body)
    content_id = ack["content_id"]
    for attempt in (1, 2, 3):
        await put_chunk(device_client, enrolled, content_id, 0, sent_body)
        response = await finalize(device_client, enrolled, content_id, declared_body)
        refused = error(response, 422, "body_checksum_mismatch")
        assert refused["error_params"]["attempts"] == attempt
        if attempt < 3:
            assert await received(device_client, enrolled, content_id) == []
    status = await device_client.get(
        f"{CONTENTS}/{content_id}", headers=enrolled["headers"]
    )
    state = ContentUploadState.model_validate(status.json())
    assert (state.state, state.coverage, state.coverage_reason) == (
        "recorded",
        "collection_failed",
        "upload_failed",
    )
    assert (await only_session(db_session)).content_bytes == 0
    assert await installation_bytes(db_session, enrolled) == 0
    session = await only_session(db_session)
    content_prefix = (
        f"session-content/v1/{session.workspace_id}/{session.owner_id}/"
        f"{enrolled['installation_id']}/{session.id}/{content_id}/"
    )
    prefixes = {
        item.storage_prefix
        for item in await db_session.scalars(select(AgentSessionContentDeletion))
    }
    assert content_prefix in prefixes
    error(
        await put_chunk(device_client, enrolled, content_id, 0, declared_body),
        409,
        "chunk_conflict",
    )
    error(
        await finalize(device_client, enrolled, content_id, declared_body),
        409,
        "chunk_conflict",
    )


async def test_a_retry_after_a_checksum_mismatch_keeps_its_good_body(
    client,
    device_client,
    db_session,
    db_engine,
    test_workspace,
    test_board,
    content_storage,
):
    """A failed attempt queues nothing: the retry rewrites the same keys, and
    only a terminal failure or expiry queues the content's objects. So no
    purge, whenever it runs or whatever it leased, can take the good body."""
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    body = b"g" * (CHUNK_BYTES + 10)
    ack = await declared(device_client, enrolled, body)
    content_id = ack["content_id"]
    await put_chunk(device_client, enrolled, content_id, 0, body[:CHUNK_BYTES])
    await put_chunk(device_client, enrolled, content_id, 1, b"h" * 10)
    error(
        await finalize(device_client, enrolled, content_id, body),
        422,
        "body_checksum_mismatch",
    )
    queued = list(await db_session.scalars(select(AgentSessionContentDeletion)))
    assert queued == []
    # A purge pass between the failure and the retry.
    await db_session.commit()
    await purge(db_engine).run_purge()

    state = await upload(device_client, enrolled, ack, body)
    assert state["state"] == "available"
    await db_session.commit()
    await purge(db_engine).run_purge()
    session = await only_session(db_session)
    page = await client.get(
        f"{sessions_path(test_workspace, session.id)}/contents/{content_id}/body"
    )
    assert page.status_code == 200, page.text
    assert page.json()["total_bytes"] == len(body)
    assert any(
        path.endswith(f"{content_id}/body") for path in stored_files(content_storage)
    )


@pytest.mark.parametrize(
    "settled, status, code",
    [
        ("available_same_bytes", 200, None),
        ("available_other_bytes", 409, "chunk_conflict"),
        ("expired_by_the_sweep", 410, "upload_expired"),
        ("recorded", 409, "chunk_conflict"),
    ],
)
async def test_a_chunk_for_a_settled_upload(
    client,
    device_client,
    db_session,
    db_engine,
    test_workspace,
    test_board,
    settled,
    status,
    code,
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    # A body that fails placement settles as recorded at finalize.
    body = f"{ROOT}/leak ".encode() * 1000 if settled == "recorded" else b"s" * 20_000
    ack = await declared(device_client, enrolled, body)
    content_id = ack["content_id"]
    if settled == "expired_by_the_sweep":
        await db_session.execute(
            update(AgentSessionContent).values(
                upload_expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)
            )
        )
        await db_session.commit()
        await purge(db_engine).run_purge()
    else:
        await put_chunk(device_client, enrolled, content_id, 0, body)
        await finalize(device_client, enrolled, content_id, body)
    chunk = b"t" * len(body) if settled == "available_other_bytes" else body
    response = await put_chunk(device_client, enrolled, content_id, 0, chunk)
    if code is None:
        receipt = ChunkReceipt.model_validate(response.json())
        assert receipt.complete is True
    else:
        error(response, status, code)


async def test_a_storage_failure_at_finalize_leaves_the_upload_resumable(
    client, device_client, db_session, test_workspace, test_board, monkeypatch
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    body = b"v" * 20_000
    ack = await declared(device_client, enrolled, body)
    content_id = ack["content_id"]
    await put_chunk(device_client, enrolled, content_id, 0, body)
    real_compose = LocalContentStore.compose

    def unavailable(*_args, **_kwargs):
        raise OSError("bucket timeout")

    monkeypatch.setattr(LocalContentStore, "compose", unavailable)
    error(
        await finalize(device_client, enrolled, content_id, body),
        503,
        "storage_backend_unavailable",
    )
    assert await received(device_client, enrolled, content_id) == [0]
    session = await only_session(db_session)
    body_url = f"{sessions_path(test_workspace, session.id)}/contents/{content_id}/body"
    error(await client.get(body_url), 404, "content_not_found")

    monkeypatch.setattr(LocalContentStore, "compose", real_compose)
    final = await finalize(device_client, enrolled, content_id, body)
    assert final.json()["state"] == "available", final.text
    assert (await client.get(body_url)).status_code == 200


async def test_an_svg_declared_as_png_is_withheld_at_finalize(
    client, device_client, db_session, test_workspace, test_board
):
    """m16: the declared type is a hint; the bytes decide."""
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    ack = await declared(
        device_client,
        enrolled,
        svg,
        channel="attachment",
        role="user",
        media_type="image/png",
    )
    await put_chunk(device_client, enrolled, ack["content_id"], 0, svg)
    final = await finalize(device_client, enrolled, ack["content_id"], svg)
    assert final.json()["state"] == "recorded", final.text
    assert (final.json()["coverage"], final.json()["coverage_reason"]) == (
        "withheld_by_policy",
        "media_type_not_permitted",
    )
    assert (await only_session(db_session)).content_bytes == 0
    assert await installation_bytes(db_session, enrolled) == 0


async def test_a_real_png_is_available(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    uploaded = await declare_and_upload(
        device_client,
        enrolled,
        PNG,
        channel="attachment",
        role="user",
        media_type="image/png",
    )
    assert uploaded["state"]["state"] == "available"


async def test_an_uploaded_body_naming_a_local_path_fails_placement(
    client, device_client, db_session, test_workspace, test_board, content_storage
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    body = (f"traceback at {ROOT}/src/app.py line 3\n" * 1000).encode()
    ack = await declared(device_client, enrolled, body)
    await put_chunk(device_client, enrolled, ack["content_id"], 0, body)
    final = await finalize(device_client, enrolled, ack["content_id"], body)
    assert final.json() == {
        "content_id": ack["content_id"],
        "state": "recorded",
        "coverage": "collection_failed",
        "coverage_reason": "placement_failed",
        "upload": None,
    }
    assert (await only_session(db_session)).content_bytes == 0
    assert await installation_bytes(db_session, enrolled) == 0
    [deletion] = await db_session.scalars(select(AgentSessionContentDeletion))
    assert deletion.storage_prefix.endswith(f"{ack['content_id']}/")


async def test_finalize_rechecks_the_mapping_but_not_the_pause(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    body = b"p" * 20_000
    excluded = await declared(
        device_client,
        enrolled,
        body,
        channel="file_content",
        display_path="vendor/x.txt",
    )
    downgraded = await declared(device_client, enrolled, body)
    paused = await declared(device_client, enrolled, body)
    for ack in (excluded, downgraded, paused):
        await put_chunk(device_client, enrolled, ack["content_id"], 0, body)
    installation_id = uuid.UUID(enrolled["installation_id"])
    await db_session.execute(
        update(CompanionInstallation)
        .where(CompanionInstallation.id == installation_id)
        .values(exclude_globs=["vendor/*"], paused=True)
    )
    await db_session.flush()
    assert (await finalize(device_client, enrolled, paused["content_id"], body)).json()[
        "state"
    ] == "available"
    final = await finalize(device_client, enrolled, excluded["content_id"], body)
    assert (final.json()["state"], final.json()["coverage_reason"]) == (
        "recorded",
        "excluded_path",
    )
    assert await installation_bytes(db_session, enrolled) == 2 * len(body)
    assert (await only_session(db_session)).content_bytes == 2 * len(body)
    await client.patch(
        f"{ME}/{enrolled['installation_id']}/mappings/{enrolled['mapping_id']}",
        json={"content_level": "full"},
    )
    final = await finalize(device_client, enrolled, downgraded["content_id"], body)
    assert (final.json()["state"], final.json()["coverage_reason"]) == (
        "recorded",
        "content_level",
    )
    # Only the available body keeps its reservation.
    assert await installation_bytes(db_session, enrolled) == len(body)
    assert (await only_session(db_session)).content_bytes == len(body)


async def test_finalize_is_idempotent_once_available(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    body = b"i" * 20_000
    uploaded = await declare_and_upload(device_client, enrolled, body)
    again = await finalize(device_client, enrolled, uploaded["ack"]["content_id"], body)
    assert again.status_code == 200
    assert again.json() == uploaded["state"]


async def test_another_installation_cannot_touch_this_upload(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    other = await rich(
        client,
        device_client,
        db_session,
        test_workspace,
        test_board,
        root="/synthetic/elsewhere",
    )
    body = b"o" * 20_000
    ack = await declared(device_client, enrolled, body)
    unknown = str(uuid.uuid4())
    for content_id in (ack["content_id"], unknown):
        responses = [
            await put_chunk(device_client, other, content_id, 0, body),
            await finalize(device_client, other, content_id, body),
            await device_client.get(
                f"{CONTENTS}/{content_id}", headers=other["headers"]
            ),
        ]
        for response in responses:
            error(response, 404, "content_not_found")
    assert await received(device_client, enrolled, ack["content_id"]) == []


async def test_device_routes_refuse_uploads_while_rich_capture_is_off(
    client, device_client, db_session, test_workspace, test_board, monkeypatch
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    body = b"f" * 20_000
    ack = await declared(device_client, enrolled, body)
    monkeypatch.setattr(settings, "RICH_CAPTURE_ENABLED", False)
    error(
        await put_chunk(device_client, enrolled, ack["content_id"], 0, body),
        409,
        "rich_capture_unavailable",
    )
    error(
        await finalize(device_client, enrolled, ack["content_id"], body),
        409,
        "rich_capture_unavailable",
    )


async def test_an_expired_upload_is_gone_for_the_device(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    body = b"e" * 20_000
    ack = await declared(device_client, enrolled, body)
    expired_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    await db_session.execute(
        update(AgentSessionContent)
        .where(AgentSessionContent.id == uuid.UUID(ack["content_id"]))
        .values(upload_expires_at=expired_at)
    )
    await db_session.flush()
    gone = error(
        await put_chunk(device_client, enrolled, ack["content_id"], 0, body),
        410,
        "upload_expired",
    )
    assert set(gone["error_params"]) == {"expired_at"}
    error(
        await finalize(device_client, enrolled, ack["content_id"], body),
        410,
        "upload_expired",
    )


async def test_a_retry_after_the_session_was_deleted_restores_nothing(
    client, device_client, db_session, test_workspace, test_board, content_storage
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    body = b"g" * (CHUNK_BYTES + 10)
    ack = await declared(device_client, enrolled, body)
    await put_chunk(device_client, enrolled, ack["content_id"], 0, body[:CHUNK_BYTES])
    session = await only_session(db_session)
    assert (
        await client.delete(sessions_path(test_workspace, session.id))
    ).status_code == 204

    error(
        await put_chunk(
            device_client, enrolled, ack["content_id"], 1, body[CHUNK_BYTES:]
        ),
        404,
        "content_not_found",
    )
    error(
        await finalize(device_client, enrolled, ack["content_id"], body),
        404,
        "content_not_found",
    )
    assert not any(
        f"/{ack['content_id']}/" in f"/{path}" and "staging/01" in path
        for path in stored_files(content_storage)
    )


async def test_storage_failures_answer_retry_later(
    client, device_client, db_session, test_workspace, test_board, monkeypatch
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    body = b"u" * 20_000
    ack = await declared(device_client, enrolled, body)

    def unavailable(*_args, **_kwargs):
        raise OSError("disk detached")

    monkeypatch.setattr(LocalContentStore, "put", unavailable)
    error(
        await put_chunk(device_client, enrolled, ack["content_id"], 0, body),
        503,
        "storage_backend_unavailable",
    )
    assert await received(device_client, enrolled, ack["content_id"]) == []


async def test_an_upload_status_names_received_chunks(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    body = b"q" * (2 * CHUNK_BYTES + 1)
    ack = await declared(device_client, enrolled, body)
    await put_chunk(
        device_client, enrolled, ack["content_id"], 2, body[2 * CHUNK_BYTES :]
    )
    await put_chunk(device_client, enrolled, ack["content_id"], 0, body[:CHUNK_BYTES])
    status = await device_client.get(
        f"{CONTENTS}/{ack['content_id']}", headers=enrolled["headers"]
    )
    state = ContentUploadState.model_validate(status.json())
    assert state.upload.chunk_count == 3
    assert state.upload.received_chunks == [0, 2]


async def test_a_persons_own_key_cannot_use_the_device_upload_routes(
    client, device_client, plain_key_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    body = b"h" * 20_000
    ack = await declared(device_client, enrolled, body)
    content_id = ack["content_id"]
    for response in [
        await plain_key_client.get(f"{CONTENTS}/{content_id}"),
        await plain_key_client.put(f"{CONTENTS}/{content_id}/chunks/0", content=body),
    ]:
        assert response.status_code == 401, response.text


async def test_upload_writes_land_under_the_contracted_key(
    client, device_client, db_session, test_workspace, test_board, content_storage
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    body = b"k" * 20_000
    uploaded = await declare_and_upload(device_client, enrolled, body)
    session = await only_session(db_session)
    [path] = stored_files(content_storage)
    assert path == (
        f"session-content/v1/{test_workspace.id}/{session.owner_id}/"
        f"{enrolled['installation_id']}/{session.id}/"
        f"{uploaded['ack']['content_id']}/body"
    )


async def test_a_purge_that_leased_its_rows_before_a_retry_spares_the_body(
    client, device_client, db_session, db_engine, test_workspace, test_board
):
    """The purge claims rows in one transaction and deletes their objects
    later, outside any; whatever it leased around a failed attempt and its
    retry, the published body survives."""
    from app.repositories.session_content import SessionContentRepository
    from app.services.storage.session_content import content_store

    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    body = b"g" * (CHUNK_BYTES + 10)
    ack = await declared(device_client, enrolled, body)
    content_id = ack["content_id"]
    await put_chunk(device_client, enrolled, content_id, 0, body[:CHUNK_BYTES])
    await put_chunk(device_client, enrolled, content_id, 1, b"h" * 10)
    error(
        await finalize(device_client, enrolled, content_id, body),
        422,
        "body_checksum_mismatch",
    )
    await db_session.commit()
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)

    async def lease():
        async with factory() as db:
            async with db.begin():
                now = datetime.now(timezone.utc)
                return [
                    row.storage_prefix
                    for row in await SessionContentRepository(db).claim_due_deletions(
                        now, now + timedelta(minutes=10), 500
                    )
                ]

    leased = await lease()
    assert (await upload(device_client, enrolled, ack, body))["state"] == "available"
    await db_session.commit()
    leased += await lease()
    for prefix in leased:
        content_store().delete_prefix(prefix)
    session = await only_session(db_session)
    page = await client.get(
        f"{sessions_path(test_workspace, session.id)}/contents/{content_id}/body"
    )
    assert page.status_code == 200, page.text


async def test_a_body_composed_after_its_upload_expired_is_queued_for_deletion(
    client, device_client, db_session, test_workspace, test_board, monkeypatch
):
    """The upload expired between compose and settle: the body just written is
    queued in the same transaction, so the purge deletes it even if the
    after-commit delete never happens."""
    from app.services.session_content_upload import SessionContentUploadService

    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    body = b"z" * 20_000
    ack = await declared(device_client, enrolled, body)
    content_id = ack["content_id"]
    await put_chunk(device_client, enrolled, content_id, 0, body)

    async def expired_while_composing(self, installation, content, composed):
        await db_session.execute(
            update(AgentSessionContent)
            .where(AgentSessionContent.id == uuid.UUID(content_id))
            .values(
                state="recorded", coverage="expired", coverage_reason="staging_expired"
            )
        )
        return None

    monkeypatch.setattr(
        SessionContentUploadService, "_policy_outcome", expired_while_composing
    )
    monkeypatch.setattr(
        SessionContentUploadService, "delete_leftovers", lambda self, prefixes: None
    )
    final = await finalize(device_client, enrolled, content_id, body)
    assert final.json()["coverage"] == "expired", final.text
    prefixes = {
        item.storage_prefix
        for item in await db_session.scalars(select(AgentSessionContentDeletion))
    }
    assert any(prefix.endswith(f"{content_id}/body") for prefix in prefixes)
