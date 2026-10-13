# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Owner reads of captured content (contract §6 Safe preview, §7 Owner reads,
§11): paged metadata, UTF-8-safe body pages, hardened downloads, and a body
visible to its owner only, never through a role, a link or a launch key."""

import logging
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import delete, select, update

from app.models.agent_session import AgentSession, SessionWorkLink
from app.models.companion import CompanionInstallation
from app.models.workspace import WorkspaceMember, WorkspaceRole
from app.schemas.session_content import (
    MAX_BODY_PAGE_BYTES,
    ContentBodyPage,
    ContentPage,
)
from app.services.storage.local import STORED_FILE_CSP
from tests.rich_capture import (
    PNG,
    acks_by_key,
    declaration,
    declare_and_upload,
    enroll_rich,
    ingest,
    only_session,
    put_chunk,
    rich_record,
    sessions_path,
)
from tests.test_agent_sessions import as_user

pytestmark = pytest.mark.usefixtures("content_storage")


async def rich(client, device_client, db_session, test_workspace, test_board):
    return await enroll_rich(
        client, device_client, db_session, test_workspace, test_board
    )


async def contents_path(db_session, workspace) -> str:
    session = await only_session(db_session)
    return f"{sessions_path(workspace, session.id)}/contents"


async def test_contents_page_in_source_order_with_filters(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    declared = [
        declaration(
            b"first prompt",
            channel="prompt",
            role="user",
            order=1,
            occurred_at="2026-10-08T14:03:00Z",
        ),
        declaration(
            b"same instant, later line",
            channel="reply",
            role="assistant",
            order=2,
            occurred_at="2026-10-08T14:03:00Z",
            call_id="call_a",
        ),
        declaration(
            b"tool output",
            call_id="call_a",
            event_id="evt-tool-output",
            order=3,
            occurred_at="2026-10-08T14:04:00Z",
        ),
    ]
    await ingest(
        device_client, enrolled, [rich_record(enrolled["mapping_id"], declared)]
    )
    path = await contents_path(db_session, test_workspace)

    first = await client.get(path, params={"limit": 2})
    assert first.status_code == 200, first.text
    # Previews are content: the same caching as bodies.
    assert first.headers["cache-control"] == "private, no-store"
    page = ContentPage.model_validate(first.json())
    assert [item.source.order for item in page.items] == [1, 2]
    assert page.next_cursor
    rest = ContentPage.model_validate(
        (await client.get(path, params={"limit": 2, "cursor": page.next_cursor})).json()
    )
    assert [item.source.order for item in rest.items] == [3]
    assert rest.next_cursor is None

    replies = (await client.get(path, params={"channel": "reply"})).json()["items"]
    assert [item["channel"] for item in replies] == ["reply"]
    calls = (await client.get(path, params={"call_id": "call_a"})).json()["items"]
    assert len(calls) == 2
    linked = (await client.get(path, params={"event_id": "evt-tool-output"})).json()
    assert [item["source"]["order"] for item in linked["items"]] == [3]
    assert (await client.get(path, params={"limit": 201})).status_code == 422


async def test_a_long_body_reads_back_exactly_in_utf8_safe_pages(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    text = "".join(f"line {index}: naïve café 漢字 🙂\n" for index in range(20_000))
    body = text.encode()
    assert len(body) > 2 * MAX_BODY_PAGE_BYTES
    uploaded = await declare_and_upload(device_client, enrolled, body)
    content_id = uploaded["ack"]["content_id"]
    path = f"{await contents_path(db_session, test_workspace)}/{content_id}/body"

    pages, offset = [], 0
    while offset is not None:
        response = await client.get(path, params={"offset": offset})
        assert response.status_code == 200, response.text
        page = ContentBodyPage.model_validate(response.json())
        assert page.total_bytes == len(body)
        assert len(page.text.encode()) <= MAX_BODY_PAGE_BYTES
        pages.append(page.text)
        offset = page.next_offset
    assert len(pages) >= 3
    assert "".join(pages) == text
    end = (await client.get(path, params={"offset": len(body)})).json()
    assert (end["text"], end["next_offset"]) == ("", None)
    assert (await client.get(path, params={"offset": len(body) + 1})).status_code == 422


async def test_inline_bodies_page_like_uploaded_ones(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    [ack] = (
        await ingest(
            device_client,
            enrolled,
            [rich_record(enrolled["mapping_id"], [declaration("inline ✓".encode())])],
        )
    )["contents"]
    path = f"{await contents_path(db_session, test_workspace)}/{ack['content_id']}/body"
    page = (await client.get(path)).json()
    assert page == {
        "content_id": ack["content_id"],
        "offset": 0,
        "next_offset": None,
        "total_bytes": len("inline ✓".encode()),
        "text": "inline ✓",
    }


async def test_render_follows_media_type_and_coverage(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    await declare_and_upload(
        device_client,
        enrolled,
        PNG,
        channel="attachment",
        role="user",
        media_type="image/png",
        order=1,
    )
    await declare_and_upload(
        device_client,
        enrolled,
        b"%PDF-1.7\n" + b"0" * 30_000,
        channel="attachment",
        role="user",
        media_type="application/pdf",
        order=2,
    )
    pending = declaration(b"w" * 20_000, delivery="upload", order=3)
    withheld = declaration(
        None,
        channel="instruction",
        role="system",
        order=4,
        coverage="withheld_by_policy",
        coverage_reason="harness_context",
        original_byte_count=9_000,
    )
    markdown = declaration(
        b"# Plan\n![x](https://evil.test/x.png)",
        channel="reply",
        role="assistant",
        media_type="text/markdown",
        order=5,
    )
    await ingest(
        device_client,
        enrolled,
        [rich_record(enrolled["mapping_id"], [pending, withheld, markdown], events=[])],
    )
    items = (await client.get(await contents_path(db_session, test_workspace))).json()[
        "items"
    ]
    by_order = {item["source"]["order"]: item for item in items}
    assert by_order[1]["render"] == "image"
    assert by_order[2]["render"] == "download"
    assert (by_order[3]["render"], by_order[3]["coverage"]) == (
        "none",
        "not_yet_uploaded",
    )
    assert by_order[3]["preview"] is None
    assert (by_order[4]["render"], by_order[4]["coverage_reason"]) == (
        "none",
        "harness_context",
    )
    assert by_order[5]["render"] == "text"
    assert by_order[5]["preview"] == {
        "text": "# Plan\n![x](https://evil.test/x.png)",
        "truncated": False,
    }


async def test_downloads_are_hardened_and_only_raster_images_are_inline(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    image = await declare_and_upload(
        device_client,
        enrolled,
        PNG,
        channel="attachment",
        role="user",
        media_type="image/png",
        display_path="docs/shot.png",
    )
    text = await declare_and_upload(
        device_client,
        enrolled,
        b"<script>alert(1)</script>" * 1000,
        channel="reply",
        role="assistant",
        media_type="text/markdown",
    )
    base = await contents_path(db_session, test_workspace)
    for uploaded, disposition in [(image, "inline"), (text, "attachment")]:
        response = await client.get(f"{base}/{uploaded['ack']['content_id']}/download")
        assert response.status_code == 200, response.text
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.headers["content-security-policy"] == STORED_FILE_CSP
        assert response.headers["cache-control"] == "private, no-store"
        assert response.headers["content-encoding"] == "identity"
        assert response.headers["content-disposition"].startswith(disposition)
    assert response.content == b"<script>alert(1)</script>" * 1000
    shot = await client.get(f"{base}/{image['ack']['content_id']}/download")
    assert shot.headers["content-type"] == "image/png"
    assert shot.content == PNG


# --- who may read ------------------------------------------------------------------


async def _one_body(client, device_client, db_session, test_workspace, test_board):
    """The owner's paths to one uploaded body, and the device that sent it."""
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    uploaded = await declare_and_upload(device_client, enrolled, b"private " * 4000)
    base = await contents_path(db_session, test_workspace)
    content_id = uploaded["ack"]["content_id"]
    return [
        base,
        f"{base}/{content_id}/body",
        f"{base}/{content_id}/download",
    ], enrolled


@pytest.mark.parametrize("role", [WorkspaceRole.admin, WorkspaceRole.member])
async def test_teammates_and_board_links_see_nothing_not_even_existence(
    role,
    client,
    device_client,
    db_session,
    test_workspace,
    test_board,
    test_card,
    second_user,
):
    paths, enrolled = await _one_body(
        client, device_client, db_session, test_workspace, test_board
    )
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=second_user.id,
            role=role,
        )
    )
    session = await only_session(db_session)
    now = datetime.now(timezone.utc)
    db_session.add(
        SessionWorkLink(
            session_id=session.id,
            workspace_id=test_workspace.id,
            entity_type="card",
            entity_id=test_card.id,
            board_id=test_board.id,
            relation="changed",
            first_seen_at=now,
            last_seen_at=now,
            invocation_count=1,
        )
    )
    await db_session.flush()
    unknown = [path.replace(str(session.id), str(uuid.uuid4())) for path in paths]
    async with as_user(db_session, second_user) as teammate:
        for path, nonexistent in zip(paths, unknown):
            seen = await teammate.get(path)
            assert seen.status_code == 404, path
            assert seen.json() == (await teammate.get(nonexistent)).json()


async def test_keys_that_act_for_the_owner_never_read_bodies(
    client,
    device_client,
    agent_client,
    installation_key_client,
    plain_key_client,
    db_session,
    test_workspace,
    test_board,
):
    paths, enrolled = await _one_body(
        client, device_client, db_session, test_workspace, test_board
    )
    session_path = paths[0].removesuffix("/contents")
    # A Companion-launched agent keeps reading session metadata, never bodies.
    assert (await installation_key_client.get(session_path)).status_code == 200
    for path in paths:
        assert (await agent_client.get(path)).status_code == 403, path
        assert (await installation_key_client.get(path)).status_code == 403, path
        assert (await plain_key_client.get(path)).status_code == 200, path


async def test_a_device_token_reads_no_bodies(
    client, device_client, db_session, test_workspace, test_board
):
    """Upload access is not read access: the token that sent the body is
    refused on every owner read."""
    paths, enrolled = await _one_body(
        client, device_client, db_session, test_workspace, test_board
    )
    for path in paths:
        response = await device_client.get(path, headers=enrolled["headers"])
        assert response.status_code == 403, path


async def test_a_former_member_cannot_read_their_own_bodies(
    client, device_client, db_session, test_workspace, test_board, test_user
):
    paths, enrolled = await _one_body(
        client, device_client, db_session, test_workspace, test_board
    )
    await db_session.execute(
        delete(WorkspaceMember).where(WorkspaceMember.user_id == test_user.id)
    )
    await db_session.flush()
    for path in paths:
        assert (await client.get(path)).status_code == 403, path


async def test_deleted_contents_answer_like_unknown_ones(
    client, device_client, db_session, test_workspace, test_board
):
    paths, enrolled = await _one_body(
        client, device_client, db_session, test_workspace, test_board
    )
    session = await only_session(db_session)
    assert (
        await client.delete(sessions_path(test_workspace, session.id))
    ).status_code == 204
    for path in paths:
        response = await client.get(path)
        assert response.status_code == 404, path
        unknown = await client.get(path.replace(str(session.id), str(uuid.uuid4())))
        assert response.json() == unknown.json()


async def test_the_generic_local_storage_route_refuses_session_content_keys(
    client, device_client, db_session, test_workspace, test_board, content_storage
):
    await _one_body(client, device_client, db_session, test_workspace, test_board)
    [stored] = [path for path in content_storage.rglob("body")]
    key = str(stored.relative_to(content_storage))
    assert key.startswith("session-content/v1/")
    response = await client.get(f"/api/local-storage/download/{key}")
    assert response.status_code == 403


async def _session_of(db_session, installation_id) -> uuid.UUID:
    return await db_session.scalar(
        select(AgentSession.id).where(
            AgentSession.installation_id == uuid.UUID(installation_id)
        )
    )


async def test_a_content_id_is_found_only_under_its_own_session(
    client, device_client, db_session, test_workspace, test_board, second_user
):
    """Authorizing the session in the path is not enough: the content must
    belong to it, for another owner's session and for the owner's own."""
    victim = await rich(client, device_client, db_session, test_workspace, test_board)
    uploaded = await declare_and_upload(device_client, victim, b"secret " * 4000)
    victim_cid = uploaded["ack"]["content_id"]
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=second_user.id,
            role=WorkspaceRole.member,
        )
    )
    await db_session.flush()
    own_other = await enroll_rich(
        client,
        device_client,
        db_session,
        test_workspace,
        test_board,
        root="/synthetic/second",
    )
    await ingest(
        device_client,
        own_other,
        [rich_record(own_other["mapping_id"], [declaration(b"mine too")])],
    )
    async with as_user(db_session, second_user) as attacker:
        theirs = await enroll_rich(
            attacker,
            device_client,
            db_session,
            test_workspace,
            test_board,
            root="/synthetic/attacker",
        )
        await ingest(
            device_client,
            theirs,
            [rich_record(theirs["mapping_id"], [declaration(b"attacker's own")])],
        )
        cases = [
            (attacker, await _session_of(db_session, theirs["installation_id"])),
            (client, await _session_of(db_session, own_other["installation_id"])),
        ]
        for reader, session_id in cases:
            base = f"{sessions_path(test_workspace, session_id)}/contents"
            for suffix in ("body", "download"):
                crossed = await reader.get(f"{base}/{victim_cid}/{suffix}")
                unknown = await reader.get(f"{base}/{uuid.uuid4()}/{suffix}")
                assert crossed.status_code == 404, crossed.text
                assert crossed.json() == unknown.json()


async def test_nothing_without_an_available_body_is_served(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    image = await declare_and_upload(
        device_client,
        enrolled,
        PNG,
        channel="attachment",
        role="user",
        media_type="image/png",
    )
    pending = declaration(b"w" * 20_000, delivery="upload")
    excluded = declaration(
        b"x" * 100, channel="file_content", display_path="vendor/lib.txt"
    )
    withheld = declaration(
        None,
        channel="instruction",
        role="system",
        coverage="withheld_by_policy",
        coverage_reason="harness_context",
    )
    await db_session.execute(
        update(CompanionInstallation).values(exclude_globs=["vendor/*"])
    )
    await db_session.flush()
    result = acks_by_key(
        await ingest(
            device_client,
            enrolled,
            [
                rich_record(
                    enrolled["mapping_id"], [pending, excluded, withheld], events=[]
                )
            ],
        )
    )
    pending_id = result[pending["content_key"]]["content_id"]
    await put_chunk(device_client, enrolled, pending_id, 0, b"w" * 20_000)
    base = await contents_path(db_session, test_workspace)
    unknown = {
        suffix: (await client.get(f"{base}/{uuid.uuid4()}/{suffix}")).json()
        for suffix in ("body", "download")
    }
    for declared in (pending, excluded, withheld):
        content_id = result[declared["content_key"]]["content_id"]
        for suffix in ("body", "download"):
            response = await client.get(f"{base}/{content_id}/{suffix}")
            assert response.status_code == 404, (declared["channel"], suffix)
            assert response.json() == unknown[suffix]
    # An image has no text pages; it is offered through /download only.
    image_body = await client.get(f"{base}/{image['ack']['content_id']}/body")
    assert image_body.status_code == 404
    assert image_body.json() == unknown["body"]


@pytest.mark.parametrize("damage", ["missing", "truncated"])
async def test_a_damaged_stored_body_is_never_served(
    client,
    device_client,
    db_session,
    test_workspace,
    test_board,
    content_storage,
    damage,
    caplog,
):
    """The row says available but the object is gone or the wrong size:
    retry later (it exists), log it, and serve no bytes."""
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    uploaded = await declare_and_upload(device_client, enrolled, b"kept " * 6000)
    content_id = uploaded["ack"]["content_id"]
    [stored] = list(content_storage.rglob("body"))
    if damage == "missing":
        stored.unlink()
    else:
        stored.write_bytes(stored.read_bytes()[:100])
    base = await contents_path(db_session, test_workspace)
    for suffix in ("body", "download"):
        with caplog.at_level(logging.ERROR):
            response = await client.get(f"{base}/{content_id}/{suffix}")
        assert response.status_code == 503, response.text
        assert response.json()["error_code"] == "storage_backend_unavailable"
        assert b"kept" not in response.content
        assert any(
            content_id in record.getMessage() and record.levelno == logging.ERROR
            for record in caplog.records
        )
        caplog.clear()
