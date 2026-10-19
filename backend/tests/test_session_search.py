# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""B01 private retained-session search at real ingest and owner-read seams.

The response and exact-source writer handshake was accepted by the composition
owner on 2026-10-18. Historical fixtures call the production source writer;
they do not stand in for B01H's deployed backfill/readiness evidence.
"""

import hashlib
import importlib
import importlib.util
import json
import secrets
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.config import settings
from app.database import get_db
from app.main import create_app
from app.models.agent_session import (
    AgentSession,
    AgentSessionContent,
    AgentSessionEvent,
)
from app.models.base import Base
from app.models.api_key import ApiKey
from app.models.companion import CompanionInstallation
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.services.session_calls import call_key
from app.services.storage.session_content import LocalContentStore
from tests.rich_capture import (
    PNG,
    declaration,
    enroll_rich,
    ingest,
    only_session,
    purge,
    put_chunk,
    rich_record,
    sessions_path,
    upload,
)
from tests.test_agent_sessions import (
    as_user,
    enroll,
    outcome,
    record,
    upload as upload_events,
    work_under_invocation,
)
from tests.test_session_calls import call_finished, call_started, prompt

pytestmark = pytest.mark.usefixtures("content_storage", "paused_object_indexing")
SCAN_BYTES = 8 << 20
SNIPPET_BYTES = 2 << 10


@pytest.fixture
def paused_object_indexing(monkeypatch):
    """Pause only the post-commit single-source processor, never finalization.

    Pending-index fixtures need a deterministic scheduling boundary. Production
    must still schedule new uploads; the separate real-finalize test proves that
    dispatch. Absence of the new module on the original candidate does not stop
    collection or turn tests into skips. Monkeypatch restores the real method.
    """
    queued = []
    if importlib.util.find_spec("app.services.session_search_index") is not None:
        _, processor = index_types()

        async def record_queued_source(_self, content_id, **_options):
            queued.append(str(content_id))

        monkeypatch.setattr(processor, "process_source", record_queued_source)
    return queued


@pytest.fixture
async def capture(client, device_client, db_session, test_workspace, test_board):
    return await enroll_rich(
        client, device_client, db_session, test_workspace, test_board
    )


async def store_contents(device_client, capture, declared, **overrides):
    result = await ingest(
        device_client,
        capture,
        [rich_record(capture["mapping_id"], declared, events=[], **overrides)],
    )
    assert result["rejected"] == [], result
    assert len(result["contents"]) == len(declared), result
    return result["contents"]


async def one_inline(client, device_client, db_session, workspace, capture, text):
    [ack] = await store_contents(device_client, capture, [declaration(text.encode())])
    assert ack["outcome"] == "available", ack
    session = await only_session(db_session)
    path = sessions_path(workspace, session.id)
    body = await client.get(f"{path}/contents/{ack['content_id']}/body")
    assert body.status_code == 200, body.text
    assert body.json()["text"] == text
    return path, ack["content_id"]


async def search(client, path, q, **options):
    response = await client.post(f"{path}/search", json={"q": q, **options})
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    assert response.request.url.query == b""
    page = response.json()
    assert 0 <= page["scanned_bytes"] <= SCAN_BYTES
    assert page["eligible_bytes"] >= page["scanned_bytes"]
    assert len(page["items"]) <= options.get("limit", 20)
    assert isinstance(page["complete"], bool)
    assert page["complete"] == (page["next_cursor"] is None)
    assert page["generation"] is not None
    return page


async def all_results(client, path, q, **options):
    pages, items, cursor = [], [], None
    # A bounded fixture must terminate; a looping cursor is a real failure.
    for _ in range(100):
        page = await search(client, path, q, cursor=cursor, **options)
        pages.append(page)
        items.extend(page["items"])
        if page["complete"]:
            return pages, items
        assert page["next_cursor"] != cursor
        cursor = page["next_cursor"]
    pytest.fail("Search did not complete within this fixture's bounded source size")


def exact_match(item, body, needle, *, start=None):
    encoded = body.encode()
    start = encoded.index(needle.encode()) if start is None else start
    assert (item["byte_start"], item["byte_end"]) == (
        start,
        start + len(needle.encode()),
    )
    assert item["source_state"] == "available"
    snippet = item["snippet"]
    assert snippet is not None
    assert len(snippet.encode()) <= SNIPPET_BYTES
    offset = item["snippet_byte_start"]
    assert encoded[offset : offset + len(snippet.encode())] == snippet.encode()
    assert (
        offset
        <= item["byte_start"]
        < item["byte_end"]
        <= offset + len(snippet.encode())
    )


async def test_capture_fixture_control_uses_persisted_owner_body(
    client, device_client, db_session, test_workspace, capture
):
    path, content_id = await one_inline(
        client, device_client, db_session, test_workspace, capture, "fixture control ✓"
    )
    listed = await client.get(f"{path}/contents")
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()["items"]] == [content_id]


@pytest.mark.parametrize(
    ("body", "query", "matched"),
    [
        ("前🙂 Straße café", "STRASSE", "Straße"),
        ("前🙂 Straße café", "CAFÉ", "café"),
        ("İstanbul", "i\u0307", "İ"),
        ("ΟΣ and ς", "οσ", "ΟΣ"),
        ("literal 50%_done and 50XXdone", "50%_DONE", "50%_done"),
        ("a\\b", "a\\b", "a\\b"),
        ("ß", "s", "ß"),
    ],
)
async def test_literal_casefold_returns_original_utf8_ranges(
    client, device_client, db_session, test_workspace, capture, body, query, matched
):
    path, content_id = await one_inline(
        client, device_client, db_session, test_workspace, capture, body
    )
    page = await search(client, path, query)
    [item] = page["items"]
    assert item["source_kind"] == "content"
    assert item["source_id"] == item["content_id"] == content_id
    assert item["channel"] == "tool_output"
    exact_match(item, body, matched)
    assert page["complete"]


async def test_accent_and_combining_forms_are_not_silently_normalized(
    client, device_client, db_session, test_workspace, capture
):
    path, _ = await one_inline(
        client, device_client, db_session, test_workspace, capture, "café"
    )
    assert (await search(client, path, "CAFÉ"))["items"]
    for query in ("cafe", "cafe\u0301"):
        page = await search(client, path, query)
        assert page["items"] == []
        assert page["complete"]


async def test_search_finds_content_outside_loaded_metadata_page(
    client, device_client, db_session, test_workspace, capture
):
    declared = [
        declaration(
            ("UNLOADED_NEEDLE" if index == 204 else f"ordinary {index}").encode(),
            order=index,
        )
        for index in range(205)
    ]
    acks = await store_contents(device_client, capture, declared)
    path = sessions_path(test_workspace, (await only_session(db_session)).id)
    initial = await client.get(f"{path}/contents", params={"limit": 100})
    assert initial.status_code == 200
    assert len(initial.json()["items"]) == 100
    assert initial.json()["next_cursor"]
    assert acks[204]["content_id"] not in {row["id"] for row in initial.json()["items"]}
    [item] = (await search(client, path, "unloaded_needle"))["items"]
    assert item["content_id"] == acks[204]["content_id"]


@pytest.mark.parametrize("query", ["", "PRIVATE_QUERY_" * 25, "🙂" * 257])
async def test_query_validation_is_bounded_private_and_non_echoing(
    client, device_client, db_session, test_workspace, capture, query
):
    path, _ = await one_inline(
        client, device_client, db_session, test_workspace, capture, "control"
    )
    response = await client.post(f"{path}/search", json={"q": query})
    assert response.status_code == 422, response.text
    assert response.headers["cache-control"] == "private, no-store"
    if query:
        assert query not in response.text
    assert "input" not in response.json()


async def test_256_unicode_characters_are_valid_without_query_string(
    client, device_client, db_session, test_workspace, capture
):
    text = "🙂" * 256
    path, _ = await one_inline(
        client, device_client, db_session, test_workspace, capture, text
    )
    [item] = (await search(client, path, text))["items"]
    exact_match(item, text, text)
    get = await client.get(f"{path}/search")
    assert get.status_code == 405
    assert "items" not in get.json()


async def test_type_choices_are_or_and_do_not_drop_retained_channels(
    client, device_client, db_session, test_workspace, capture
):
    channels = [
        "prompt",
        "reply",
        "reasoning",
        "tool_input",
        "tool_output",
        "diff",
        "file_content",
        "command_output",
        "error",
        "summary",
        "instruction",
        "native_record",
    ]
    acks = await store_contents(
        device_client,
        capture,
        [
            declaration(b"type marker", channel=channel, order=index)
            for index, channel in enumerate(channels)
        ],
    )
    path = sessions_path(test_workspace, (await only_session(db_session)).id)
    page = await search(client, path, "marker")
    assert {item["content_id"] for item in page["items"]} == {
        ack["content_id"] for ack in acks
    }
    for channel in channels:
        [item] = (await search(client, path, "marker", types=[channel]))["items"]
        assert item["channel"] == channel
    choices = await search(client, path, "marker", types=["reply", "diff"])
    assert {item["channel"] for item in choices["items"]} == {"reply", "diff"}
    tools = await search(client, path, "marker", types=["tool"])
    assert {item["channel"] for item in tools["items"]} == {"tool_input", "tool_output"}
    assert (await search(client, path, "absent", types=["reply", "diff"]))[
        "items"
    ] == []


@pytest.mark.parametrize("role", [WorkspaceRole.member, WorkspaceRole.admin])
async def test_other_members_and_admins_get_no_matches_counts_or_existence(
    client, device_client, db_session, test_workspace, capture, second_user, role
):
    path, _ = await one_inline(
        client,
        device_client,
        db_session,
        test_workspace,
        capture,
        "PRIVATE_OWNER_MARKER",
    )
    assert (await search(client, path, "PRIVATE_OWNER_MARKER"))["items"]
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id, user_id=second_user.id, role=role
        )
    )
    await db_session.flush()
    unknown = sessions_path(test_workspace, uuid.uuid4())
    async with as_user(db_session, second_user) as other:
        response = await other.post(
            f"{path}/search", json={"q": "PRIVATE_OWNER_MARKER"}
        )
        missing = await other.post(
            f"{unknown}/search", json={"q": "PRIVATE_OWNER_MARKER"}
        )
    assert response.status_code == missing.status_code == 404
    assert response.json() == missing.json()
    assert response.headers["cache-control"] == "private, no-store"
    assert "PRIVATE_OWNER_MARKER" not in response.text
    assert not ({"coverage", "items", "eligible_bytes"} & response.json().keys())


async def test_real_agent_installation_and_device_credentials_are_denied(
    client,
    device_client,
    db_session,
    test_workspace,
    test_user,
    test_agent,
    capture,
    installation_key_client,
    plain_key_client,
):
    path, _ = await one_inline(
        client, device_client, db_session, test_workspace, capture, "key-private"
    )
    assert (await search(client, path, "key-private"))["items"]
    assert (await search(plain_key_client, path, "key-private"))["items"]
    raw_key = "vlr_" + secrets.token_urlsafe(32)
    key = ApiKey(
        user_id=test_user.id,
        name="synthetic search agent",
        key_hash=hashlib.sha256(raw_key.encode()).hexdigest(),
        key_prefix=raw_key[:8],
    )
    db_session.add(key)
    await db_session.flush()
    test_agent.api_key_id = key.id
    await db_session.flush()
    # The real verifier resolves the registered Agent from this key.
    agent_headers = {"Authorization": "Bearer " + raw_key}
    assert (await device_client.get(path, headers=agent_headers)).status_code == 403
    for caller, headers in (
        (device_client, agent_headers),
        (device_client, capture["headers"]),
        (installation_key_client, {}),
    ):
        response = await caller.post(
            f"{path}/search", json={"q": "key-private"}, headers=headers
        )
        assert response.status_code == 403, response.text
        assert response.headers["cache-control"] == "private, no-store"
        assert "key-private" not in response.text
        assert "coverage" not in response.json()


async def test_current_membership_wins_over_a_valid_search_cursor(
    client, device_client, db_session, test_workspace, test_user, capture
):
    await store_contents(
        device_client,
        capture,
        [declaration(b"private match", order=i) for i in range(3)],
    )
    path = sessions_path(test_workspace, (await only_session(db_session)).id)
    page = await search(client, path, "private", limit=1)
    assert page["next_cursor"]
    await db_session.execute(
        delete(WorkspaceMember).where(
            WorkspaceMember.workspace_id == test_workspace.id,
            WorkspaceMember.user_id == test_user.id,
        )
    )
    response = await client.post(
        f"{path}/search",
        json={"q": "private", "cursor": page["next_cursor"], "limit": 1},
    )
    assert response.status_code == 403, response.text
    assert "private match" not in response.text
    assert "eligible_bytes" not in response.json()


async def test_cross_workspace_path_cannot_resolve_an_owned_private_session(
    client, device_client, db_session, test_workspace, test_user, capture
):
    path, _ = await one_inline(
        client, device_client, db_session, test_workspace, capture, "cross-workspace"
    )
    assert (await search(client, path, "cross-workspace"))["items"]
    other = Workspace(
        slug="search-other", name="Synthetic other", created_by=test_user.id
    )
    db_session.add(other)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=other.id, user_id=test_user.id, role=WorkspaceRole.owner
        )
    )
    await db_session.flush()
    response = await client.post(
        f"{path.replace('/default/', '/search-other/')}/search",
        json={"q": "cross-workspace"},
    )
    assert response.status_code == 404, response.text
    assert "cross-workspace" not in response.text


async def test_cursor_is_bound_to_its_exact_session(
    client, device_client, db_session, test_workspace, capture
):
    await store_contents(
        device_client,
        capture,
        [declaration(b"match", order=i) for i in range(3)],
        native_session_id="cursor-origin",
    )
    origin = await db_session.scalar(
        select(AgentSession).where(AgentSession.native_session_id == "cursor-origin")
    )
    origin_path = sessions_path(test_workspace, origin.id)
    first = await search(client, origin_path, "match", limit=1)
    await store_contents(
        device_client,
        capture,
        [declaration(b"match destination")],
        native_session_id="cursor-other",
    )
    other = await db_session.scalar(
        select(AgentSession).where(AgentSession.native_session_id == "cursor-other")
    )
    other_path = sessions_path(test_workspace, other.id)
    assert (await client.get(f"{other_path}/contents")).status_code == 200
    response = await client.post(
        f"{other_path}/search",
        json={"q": "match", "limit": 1, "cursor": first["next_cursor"]},
    )
    assert response.status_code == 422, response.text
    assert "match destination" not in response.text


async def test_live_generation_restarts_but_idempotent_ingest_does_not(
    client, device_client, db_session, test_workspace, capture
):
    batch = rich_record(
        capture["mapping_id"],
        [declaration(b"match", order=i) for i in range(3)],
        events=[],
    )
    original = await ingest(device_client, capture, [batch])
    assert original["rejected"] == []
    path = sessions_path(test_workspace, (await only_session(db_session)).id)
    first = await search(client, path, "match", limit=1)
    replay = await ingest(device_client, capture, [batch])
    assert replay["rejected"] == []
    second = await search(client, path, "match", limit=1, cursor=first["next_cursor"])
    assert second["generation"] == first["generation"]
    assert first["items"][0]["source_id"] != second["items"][0]["source_id"]
    await store_contents(device_client, capture, [declaration(b"new match", order=99)])
    stale = await client.post(
        f"{path}/search",
        json={"q": "match", "limit": 1, "cursor": first["next_cursor"]},
    )
    assert stale.status_code == 409, stale.text
    assert stale.json()["error_code"] == "session_search_stale"
    restarted = await search(client, path, "match")
    assert restarted["generation"] != first["generation"]
    assert len(restarted["items"]) == 4


@pytest.mark.parametrize(
    "changed",
    [
        {"q": "different"},
        {"types": ["reply"]},
        {"failures_only": True},
        {"work_only": True},
    ],
)
async def test_cursor_cannot_be_reused_with_a_different_query_or_filter(
    client, device_client, db_session, test_workspace, capture, changed
):
    await store_contents(
        device_client, capture, [declaration(b"match", order=i) for i in range(3)]
    )
    path = sessions_path(test_workspace, (await only_session(db_session)).id)
    first = await search(client, path, "match", limit=1)
    response = await client.post(
        f"{path}/search",
        json={"q": "match", "limit": 1, "cursor": first["next_cursor"], **changed},
    )
    assert response.status_code == 422, response.text
    assert response.headers["cache-control"] == "private, no-store"


async def test_search_respects_companion_feature_gate(
    client, device_client, db_session, test_workspace, capture, monkeypatch
):
    path, _ = await one_inline(
        client, device_client, db_session, test_workspace, capture, "enabled control"
    )
    assert (await search(client, path, "enabled"))["items"]
    monkeypatch.setattr(settings, "COMPANION_ENABLED", False)
    response = await client.post(f"{path}/search", json={"q": "enabled"})
    assert response.status_code == 404, response.text


async def test_revoking_capture_installation_preserves_owner_retained_search(
    client, device_client, db_session, test_workspace, capture
):
    path, _ = await one_inline(
        client,
        device_client,
        db_session,
        test_workspace,
        capture,
        "RETAINED_AFTER_REVOKE",
    )
    before = await search(client, path, "RETAINED_AFTER_REVOKE")
    assert before["items"]
    revoked = await client.delete(
        f"/api/me/companion/installations/{capture['installation_id']}"
    )
    assert revoked.status_code == 200, revoked.text
    assert revoked.json()["revoked_at"] is not None
    assert (
        await device_client.get("/api/companion/policy", headers=capture["headers"])
    ).status_code == 401
    after = await search(client, path, "RETAINED_AFTER_REVOKE")
    assert after["items"] == before["items"]


async def test_chronological_search_pages_cover_all_matches_once(
    client, device_client, db_session, test_workspace, capture
):
    acks = await store_contents(
        device_client,
        capture,
        [declaration(f"match {i:03d}".encode(), order=i) for i in range(61)],
    )
    path = sessions_path(test_workspace, (await only_session(db_session)).id)
    pages, items = await all_results(client, path, "match")
    assert len(pages) == 4
    assert [item["content_id"] for item in items] == [ack["content_id"] for ack in acks]
    assert all(len(page["items"]) == 20 for page in pages[:-1])
    assert len({item["source_id"] for item in items}) == 61


@pytest.mark.parametrize(
    "options",
    [
        {"limit": 0},
        {"limit": 21},
        {"cursor": "invalid_cursor"},
        {"types": ["invented_kind"]},
    ],
)
async def test_invalid_search_bounds_fail_without_query_echo(
    client, device_client, db_session, test_workspace, capture, options
):
    path, _ = await one_inline(
        client, device_client, db_session, test_workspace, capture, "positive control"
    )
    response = await client.post(
        f"{path}/search", json={"q": "PRIVATE_VALIDATION_QUERY", **options}
    )
    assert response.status_code == 422, response.text
    assert response.headers["cache-control"] == "private, no-store"
    assert "PRIVATE_VALIDATION_QUERY" not in response.text


def index_types():
    # Runtime import: missing implementation must not prevent the HTTP/control
    # regressions from collecting on the original source candidate.
    module = importlib.import_module("app.services.session_search_index")
    return module.SessionSearchIndexWriter, module.SessionSearchObjectProcessor


async def index_uploaded(db_session, db_engine, content_id):
    writer, processor = index_types()
    await db_session.commit()
    prepared = await processor(
        async_sessionmaker(db_engine, expire_on_commit=False)
    ).prepare_source(uuid.UUID(content_id))
    assert prepared is not None
    async with db_session.begin():
        await writer(db_session).index_prepared_source(prepared)


async def uploaded_body(
    client, device_client, db_session, workspace, capture, body, **fields
):
    [ack] = await store_contents(
        device_client, capture, [declaration(body, delivery="upload", **fields)]
    )
    assert ack["outcome"] == "upload_required", ack
    settled = await upload(device_client, capture, ack, body)
    assert settled["state"] == "available", settled
    path = sessions_path(workspace, (await only_session(db_session)).id)
    first = await client.get(f"{path}/contents/{ack['content_id']}/body")
    assert first.status_code == 200, first.text
    assert first.json()["text"].encode() == body[: len(first.json()["text"].encode())]
    return path, ack["content_id"]


@pytest.mark.slow
async def test_uploaded_text_beyond_preview_and_body_page_is_indexed_once(
    client, device_client, db_session, db_engine, test_workspace, capture, monkeypatch
):
    text = "先🙂" + "ordinary " * 70_000 + "Straße_UNLOADED_BODY" + " ending"
    body = text.encode()
    path, content_id = await uploaded_body(
        client, device_client, db_session, test_workspace, capture, body
    )
    first = await client.get(f"{path}/contents/{content_id}/body")
    assert "UNLOADED_BODY" not in first.json()["text"]
    metadata = await client.get(f"{path}/contents")
    assert "UNLOADED_BODY" not in json.dumps(metadata.json())
    pending = await search(client, path, "strasse_unloaded_body")
    assert pending["items"] == []
    assert pending["coverage"]["pending_index"] == {"count": 1, "bytes": len(body)}
    await index_uploaded(db_session, db_engine, content_id)

    reads = []
    original_read = LocalContentStore.read

    def bounded_read(store, key, offset=0, length=None):
        reads.append((key, offset, length))
        assert length is not None and 0 < length <= SNIPPET_BYTES
        return original_read(store, key, offset, length)

    def no_full_read(*_args, **_kwargs):
        pytest.fail("Search must not stream an entire object per query")

    monkeypatch.setattr(LocalContentStore, "read", bounded_read)
    monkeypatch.setattr(LocalContentStore, "iter_bytes", no_full_read)
    page = await search(client, path, "strasse_unloaded_body")
    [item] = page["items"]
    assert item["content_id"] == content_id
    exact_match(item, text, "Straße_UNLOADED_BODY")
    assert len(reads) == 1
    assert page["coverage"]["pending_index"]["count"] == 0
    reads.clear()
    assert (await search(client, path, "genuinely_absent_marker"))["items"] == []
    assert reads == [], "Only returned object hits may cause body ranges to be read"


@pytest.mark.slow
async def test_chunk_boundary_matches_are_not_lost_or_duplicated(
    client, device_client, db_session, db_engine, test_workspace, capture
):
    # Markers cross common power-of-two chunk boundaries. The invariant is
    # exact global offsets and one hit, independent of the chosen chunk size.
    body = bytearray(b"." * ((1 << 20) + 100))
    markers = []
    for power in range(10, 21):
        marker = f"EDGE_{power}_Straße".encode()
        start = (1 << power) - 5
        body[start : start + len(marker)] = marker
        markers.append((marker.decode(), start))
    path, content_id = await uploaded_body(
        client, device_client, db_session, test_workspace, capture, bytes(body)
    )
    assert (await search(client, path, "EDGE_20_STRASSE"))["coverage"]["pending_index"][
        "count"
    ] == 1
    await index_uploaded(db_session, db_engine, content_id)
    for marker, start in markers:
        _, items = await all_results(client, path, marker.casefold())
        [item] = items
        exact_match(item, bytes(body).decode(), marker, start=start)


async def test_retained_text_attachment_is_searchable_in_its_exact_channel(
    client, device_client, db_session, db_engine, test_workspace, capture
):
    body = b"attached retained text ATTACHMENT_MARKER"
    path, content_id = await uploaded_body(
        client,
        device_client,
        db_session,
        test_workspace,
        capture,
        body,
        channel="attachment",
        media_type="text/plain",
        display_path="evidence.txt",
    )
    pending = await search(client, path, "ATTACHMENT_MARKER", types=["attachment"])
    assert pending["coverage"]["pending_index"]["count"] == 1
    await index_uploaded(db_session, db_engine, content_id)
    [item] = (await search(client, path, "ATTACHMENT_MARKER", types=["attachment"]))[
        "items"
    ]
    assert item["content_id"] == content_id
    assert item["channel"] == "attachment"
    exact_match(item, body.decode(), "ATTACHMENT_MARKER")


@pytest.mark.parametrize(
    "damage", ["missing", "truncated", "same_size_replacement", "same_size_case_change"]
)
async def test_object_hit_revalidates_actual_bytes_and_never_returns_stale_snippet(
    client,
    device_client,
    db_session,
    db_engine,
    test_workspace,
    capture,
    content_storage,
    damage,
):
    body = b"prefix " * 6000 + b"PRIVATE_STALE_HIT" + b" tail"
    path, content_id = await uploaded_body(
        client, device_client, db_session, test_workspace, capture, body
    )
    assert (await search(client, path, "PRIVATE_STALE_HIT"))["coverage"][
        "pending_index"
    ]["count"] == 1
    await index_uploaded(db_session, db_engine, content_id)
    assert (await search(client, path, "PRIVATE_STALE_HIT"))["items"]
    [stored] = list(content_storage.rglob("body"))
    if damage == "missing":
        stored.unlink()
    elif damage == "truncated":
        stored.write_bytes(body[:100])
    elif damage == "same_size_replacement":
        stored.write_bytes(body.replace(b"PRIVATE_STALE_HIT", b"REPLACED_CONTENTS"))
        assert stored.stat().st_size == len(body)
    else:
        # Casefold still matches, but the exact indexed source bytes changed.
        stored.write_bytes(body.replace(b"PRIVATE_STALE_HIT", b"private_stale_hit"))
        assert stored.stat().st_size == len(body)
    page = await search(client, path, "PRIVATE_STALE_HIT")
    assert all(
        item["source_state"] == "unavailable" and item["snippet"] is None
        for item in page["items"]
    )
    assert "PRIVATE_STALE_HIT" not in json.dumps(page)
    assert page["coverage"]["unavailable"]["count"] == 1


async def test_coverage_separates_retained_missing_withheld_pending_and_nontext(
    client, device_client, db_session, test_workspace, capture
):
    declared = [
        declaration(b"ready", order=1),
        declaration(b"pending", delivery="upload", order=2),
        declaration(
            None,
            coverage="withheld_by_policy",
            coverage_reason="harness_context",
            original_byte_count=91,
            order=3,
        ),
        declaration(
            None,
            coverage="source_unavailable",
            coverage_reason="file_missing",
            original_byte_count=92,
            order=4,
        ),
        declaration(
            None,
            coverage="collection_failed",
            coverage_reason="source_stalled",
            original_byte_count=93,
            order=5,
        ),
        declaration(PNG, channel="attachment", media_type="image/png", order=6),
    ]
    acks = await store_contents(device_client, capture, declared)
    await upload(device_client, capture, acks[-1], PNG)
    path = sessions_path(test_workspace, (await only_session(db_session)).id)
    metadata = await client.get(f"{path}/contents")
    assert metadata.status_code == 200
    assert len(metadata.json()["items"]) == 6
    page = await search(client, path, "ready")
    assert len(page["items"]) == 1
    coverage = page["coverage"]
    for name, byte_count in (
        ("indexed", 5),
        ("pending_upload", 7),
        ("withheld", 91),
        ("unavailable", 92),
        ("uncaptured", 93),
        ("nontext", len(PNG)),
    ):
        assert coverage[name] == {"count": 1, "bytes": byte_count}
    assert coverage["pending_index"] == {"count": 0, "bytes": 0}
    assert coverage["extractor_version"]
    assert coverage["verified_at"] is not None


async def retained_event_session(
    client, device_client, db_session, workspace, board, events, *, level="full"
):
    token, mapping_id = await enroll(client, workspace, board, content_level=level)
    await upload_events(device_client, token, [record(events, mapping_id)])
    session = await only_session(db_session)
    path = sessions_path(workspace, session.id)
    positive = await client.get(f"{path}/calls")
    assert positive.status_code == 200, positive.text
    return path, session, positive.json()


async def test_event_fields_beyond_previews_have_exact_event_and_call_anchors(
    client, device_client, db_session, test_workspace, test_board
):
    text = "prefix " * 1000 + "OLD_PROMPT_NEEDLE"
    raw = prompt(1, text)
    path, session, calls = await retained_event_session(
        client, device_client, db_session, test_workspace, test_board, [raw]
    )
    assert "OLD_PROMPT_NEEDLE" not in json.dumps(calls)
    row = await db_session.scalar(
        select(AgentSessionEvent).where(AgentSessionEvent.session_id == session.id)
    )
    assert row.event["prompt"]["text"] == text
    [item] = (await search(client, path, "old_prompt_needle"))["items"]
    assert item["source_kind"] == "event"
    assert item["source_id"] == str(row.id)
    assert item["event_id"] == row.event_id
    assert item["field"] == "prompt.text"
    assert item["call_key"] == call_key("e:" + row.event_id)
    assert (await client.get(f"{path}/calls/{item['call_key']}")).status_code == 200
    exact_match(item, text, "OLD_PROMPT_NEEDLE")


async def test_historical_source_writer_is_idempotent_and_uses_exact_old_fields(
    client, device_client, db_session, test_workspace, test_board
):
    path, session, _ = await retained_event_session(
        client,
        device_client,
        db_session,
        test_workspace,
        test_board,
        [prompt(1, "new control")],
    )
    assert (await search(client, path, "new control"))["items"]
    template = await db_session.scalar(
        select(AgentSessionEvent).where(AgentSessionEvent.session_id == session.id)
    )
    values = {
        column.name: getattr(template, column.name)
        for column in AgentSessionEvent.__table__.columns
    }
    old_id, event_id = uuid.uuid4(), uuid.uuid4().hex
    text = "legacy " * 200 + "HISTORICAL_ONLY"
    old_event = prompt(0, text)
    old_event["event"]["id"] = event_id
    values.update(
        id=old_id,
        event_id=event_id,
        event=old_event,
        occurred_at=template.occurred_at - timedelta(days=60),
    )
    # Direct insertion models a retained pre-feature row, bypassing new ingest.
    db_session.add(AgentSessionEvent(**values))
    await db_session.flush()
    before = await search(client, path, "HISTORICAL_ONLY")
    assert before["items"] == []
    assert before["coverage"]["pending_index"]["count"] >= 1
    writer, _ = index_types()
    await writer(db_session).index_source("event", old_id)
    first = await search(client, path, "HISTORICAL_ONLY")
    [item] = first["items"]
    assert item["source_id"] == str(old_id)
    exact_match(item, text, "HISTORICAL_ONLY")
    await writer(db_session).index_source("event", old_id)
    repeated = await search(client, path, "HISTORICAL_ONLY")
    assert repeated["generation"] == first["generation"]
    assert repeated["items"] == first["items"]


async def test_historical_inline_content_writer_does_not_require_backfill_job(
    client, device_client, db_session, test_workspace, capture
):
    path, content_id = await one_inline(
        client, device_client, db_session, test_workspace, capture, "new control"
    )
    assert (await search(client, path, "new control"))["items"]
    template = await db_session.get(AgentSessionContent, uuid.UUID(content_id))
    values = {
        column.name: getattr(template, column.name)
        for column in AgentSessionContent.__table__.columns
    }
    old_id = uuid.uuid4()
    text = "retained inline OLD_INLINE_SOURCE"
    digest = hashlib.sha256(text.encode()).hexdigest()
    values.update(
        id=old_id,
        content_key=hashlib.sha256(old_id.bytes).hexdigest(),
        inline_text=text,
        byte_count=len(text.encode()),
        sha256=digest,
        source_order=0,
        occurred_at=template.occurred_at - timedelta(days=60),
    )
    db_session.add(AgentSessionContent(**values))
    await db_session.flush()
    before = await search(client, path, "OLD_INLINE_SOURCE")
    assert before["items"] == []
    assert before["coverage"]["pending_index"]["count"] == 1
    writer, _ = index_types()
    await writer(db_session).index_source("content", old_id, expected_digest=digest)
    indexed = await search(client, path, "OLD_INLINE_SOURCE")
    [item] = indexed["items"]
    assert item["content_id"] == str(old_id)
    exact_match(item, text, "OLD_INLINE_SOURCE")
    await writer(db_session).index_source("content", old_id, expected_digest=digest)
    repeated = await search(client, path, "OLD_INLINE_SOURCE")
    assert repeated["generation"] == indexed["generation"]
    assert repeated["coverage"]["pending_index"]["count"] == 0


@pytest.mark.parametrize("level", ["metadata", "standard", "full"])
async def test_event_index_obeys_persisted_policy_and_excludes_paths_and_placeholders(
    client, device_client, db_session, test_workspace, test_board, level
):
    started = call_started("privacy-call", 2, arguments={"command": "ARGUMENT_MARKER"})
    finished = call_finished("privacy-call", 3, output="OUTPUT_MARKER")
    omitted = call_finished(
        "omitted-call", 4, output="[omitted 42 bytes sha256:abc123]"
    )
    descriptor = call_finished(
        "descriptor-call", 5, output=json.dumps({"bytes": 42, "sha256": "def456"})
    )
    started["gen_ai"]["tool"]["call"]["arguments"]["cwd"] = (
        "/synthetic/project/NESTED_CWD_MARKER"
    )
    for value in (started, finished, omitted, descriptor):
        value["session"]["working_directory"] = (
            "/synthetic/project/PRIVATE_DIRECTORY_MARKER"
        )
    path, session, _ = await retained_event_session(
        client,
        device_client,
        db_session,
        test_workspace,
        test_board,
        [started, finished, omitted, descriptor],
        level=level,
    )
    persisted = list(
        await db_session.scalars(
            select(AgentSessionEvent).where(AgentSessionEvent.session_id == session.id)
        )
    )
    persisted_text = json.dumps([row.event for row in persisted])
    assert ("ARGUMENT_MARKER" in persisted_text) == (level != "metadata")
    assert ("OUTPUT_MARKER" in persisted_text) == (level == "full")
    for query, expected in (
        ("ARGUMENT_MARKER", level != "metadata"),
        ("OUTPUT_MARKER", level == "full"),
        ("PRIVATE_DIRECTORY_MARKER", False),
        ("NESTED_CWD_MARKER", False),
        ("omitted 42 bytes", False),
        ("abc123", False),
        ("def456", False),
    ):
        page = await search(client, path, query)
        assert bool(page["items"]) == expected
        # Excluded directory fields must not leak as nearby snippet context
        # when another eligible argument is the actual match.
        assert "PRIVATE_DIRECTORY_MARKER" not in json.dumps(page)
        assert "NESTED_CWD_MARKER" not in json.dumps(page)


async def test_text_type_failure_and_current_work_filters_are_intersections(
    client, device_client, db_session, test_workspace, test_board, test_card
):
    events = []
    for index, (call_id, failed) in enumerate(
        (
            ("linked-failure", True),
            ("linked-failure-two", True),
            ("unlinked-failure", True),
            ("linked-success", False),
        )
    ):
        started = call_started(
            call_id,
            index * 3 + 1,
            tool="get_card",
            arguments={"query": "combined marker"},
        )
        finished = call_finished(
            call_id, index * 3 + 2, tool="get_card", exit_code=1 if failed else 0
        )
        for value in (started, finished):
            value["mcp"] = {"server": "backplane", "tool": "get_card"}
        events.extend([started, finished])
    path, session, _ = await retained_event_session(
        client, device_client, db_session, test_workspace, test_board, events
    )
    for call_id in ("linked-failure", "linked-failure-two", "linked-success"):
        invocation = uuid.uuid4()
        await work_under_invocation(client, test_board, test_card, invocation)
        result = await client.post(
            "/api/me/mcp-invocations",
            json=outcome(
                invocation,
                native_call_id=call_id,
                started_at="2026-09-24T02:00:02Z",
                completed_at="2026-09-24T02:00:03Z",
            ),
        )
        assert result.status_code == 200, result.text
    controls = await client.get(f"{path}/calls", params={"filter": "work"})
    assert controls.status_code == 200
    assert {item["call_id"] for item in controls.json()["items"]} == {
        "linked-failure",
        "linked-failure-two",
        "linked-success",
    }
    filtered = await search(
        client,
        path,
        "combined marker",
        types=["mcp"],
        failures_only=True,
        work_only=True,
    )
    assert filtered["items"]
    assert {item["call_key"] for item in filtered["items"]} == {
        call_key("c:linked-failure"),
        call_key("c:linked-failure-two"),
    }
    assert not (
        await search(
            client,
            path,
            "combined marker",
            types=["prompt"],
            failures_only=True,
            work_only=True,
        )
    )["items"]
    first = await search(
        client,
        path,
        "combined marker",
        types=["mcp"],
        failures_only=True,
        work_only=True,
        limit=1,
    )
    assert first["next_cursor"]
    # A stale invocation link is not current authorization to deleted work.
    deleted = await client.delete(
        f"/api/workspaces/{test_workspace.slug}/boards/{test_board.id}/cards/{test_card.id}"
    )
    assert deleted.status_code == 204
    stale = await client.post(
        f"{path}/search",
        json={
            "q": "combined marker",
            "types": ["mcp"],
            "failures_only": True,
            "work_only": True,
            "limit": 1,
            "cursor": first["next_cursor"],
        },
    )
    assert stale.status_code == 409, stale.text
    assert stale.json()["error_code"] == "session_search_stale"
    assert (await search(client, path, "combined marker", work_only=True))[
        "items"
    ] == []


async def test_child_summary_is_explicit_metadata_not_recursive_parent_search(
    client, device_client, db_session, test_workspace, test_board
):
    token, mapping_id = await enroll(
        client, test_workspace, test_board, content_level="full"
    )
    parent = record([prompt(1, "parent content")], mapping_id, session="search-parent")
    child = record(
        [prompt(2, "CHILD_BODY_MARKER " + "beyond title " * 100)],
        mapping_id,
        session="search-child",
    )
    child["parent_native_session_id"] = "search-parent"
    await upload_events(device_client, token, [parent, child])
    sessions = {
        row.native_session_id: row
        for row in await db_session.scalars(select(AgentSession))
    }
    parent_path = sessions_path(test_workspace, sessions["search-parent"].id)
    child_path = sessions_path(test_workspace, sessions["search-child"].id)
    calls = await client.get(f"{parent_path}/calls")
    assert calls.status_code == 200
    [subagent] = [item for item in calls.json()["items"] if item["kind"] == "subagent"]
    assert subagent["subagent"]["id"] == str(sessions["search-child"].id)
    parent_search = await search(client, parent_path, "CHILD_BODY_MARKER")
    assert parent_search["items"] == []
    assert parent_search["coverage"]["linked_child_metadata"] == {
        "count": 1,
        "searchable": False,
    }
    assert (await search(client, parent_path, "CHILD_BODY_MARKER", types=["subagent"]))[
        "items"
    ] == []
    [hit] = (await search(client, child_path, "CHILD_BODY_MARKER"))["items"]
    assert hit["source_kind"] == "event"
    assert hit["call_key"] != subagent["key"]


def searchable_tables():
    # Assert actual durable index cleanup without fixing a private model/class
    # layout. The B01 source/chunk tables are the additive session-search schema.
    tables = [
        table for table in Base.metadata.sorted_tables if "session_search" in table.name
    ]
    assert tables, "B01 must have durable search/index coverage tables"
    return tables


@pytest.mark.parametrize(
    "deletion", ["session", "workspace", "installation_sessions", "retention"]
)
async def test_deletion_and_retention_remove_durable_index_text(
    client, device_client, db_session, db_engine, test_workspace, capture, deletion
):
    path, _ = await one_inline(
        client,
        device_client,
        db_session,
        test_workspace,
        capture,
        "DELETE_INDEX_MARKER",
    )
    assert (await search(client, path, "DELETE_INDEX_MARKER"))["items"]
    tables = searchable_tables()
    counts = [
        await db_session.scalar(select(func.count()).select_from(table))
        for table in tables
    ]
    assert any(counts)
    if deletion == "session":
        assert (await client.delete(path)).status_code == 204
    elif deletion == "workspace":
        await db_session.execute(
            delete(Workspace).where(Workspace.id == test_workspace.id)
        )
    elif deletion == "installation_sessions":
        response = await client.delete(
            f"/api/me/companion/installations/{capture['installation_id']}/sessions"
        )
        assert response.status_code == 200, response.text
    else:
        await db_session.execute(
            update(CompanionInstallation)
            .where(CompanionInstallation.id == uuid.UUID(capture["installation_id"]))
            .values(retention_days=1)
        )
        await db_session.execute(
            update(AgentSession).values(
                last_event_at=datetime.now(timezone.utc) - timedelta(days=3)
            )
        )
        await db_session.commit()
        await purge(db_engine).run_purge()
    await db_session.flush()
    for table in tables:
        assert (
            await db_session.scalar(select(func.count()).select_from(table)) == 0
        ), table.name
    response = await client.post(f"{path}/search", json={"q": "DELETE_INDEX_MARKER"})
    assert response.status_code in (403, 404), response.text
    assert "DELETE_INDEX_MARKER" not in response.text


@pytest.mark.parametrize("settlement", ["commit", "rollback", "processor_error"])
async def test_real_finalize_schedules_index_only_after_commit_with_durable_fallback(
    client,
    device_client,
    db_session,
    db_engine,
    test_workspace,
    capture,
    monkeypatch,
    settlement,
):
    body = b"POSTCOMMIT_INDEX_MARKER " * 2000
    [ack] = await store_contents(
        device_client, capture, [declaration(body, delivery="upload")]
    )
    assert ack["outcome"] == "upload_required"
    assert ack["upload"]["chunk_count"] == 1
    uploaded = await put_chunk(device_client, capture, ack["content_id"], 0, body)
    assert uploaded.status_code == 200, uploaded.text
    session_id = (await only_session(db_session)).id
    content_id = uuid.UUID(ack["content_id"])
    await db_session.commit()
    factory = async_sessionmaker(db_engine, expire_on_commit=False)
    committed, calls = [], []

    async def record_processing_after_commit(_self, queued_id, **_options):
        assert (
            committed
        ), "Object indexing ran before its finalize transaction committed"
        assert str(queued_id) == str(content_id)
        async with factory.begin() as observer:
            current = await observer.get(AgentSessionContent, content_id)
            assert current is not None and current.state == "available"
        calls.append(str(queued_id))
        if settlement == "processor_error":
            raise RuntimeError("synthetic postcommit processor outage")

    if importlib.util.find_spec("app.services.session_search_index") is not None:
        _, processor = index_types()
        monkeypatch.setattr(processor, "process_source", record_processing_after_commit)

    app = create_app()

    async def request_transaction():
        async with factory() as transaction:
            try:
                yield transaction
                if settlement == "rollback":
                    raise RuntimeError("synthetic finalize commit failure")
                await transaction.commit()
                committed.append(True)
            except Exception:
                await transaction.rollback()
                raise

    app.dependency_overrides[get_db] = request_transaction
    async with AsyncClient(
        # Observe actual HTTP semantics, including a task failure after a 200
        # response has already been sent. Do not mandate where it is caught.
        transport=ASGITransport(app, raise_app_exceptions=False),
        base_url="http://test",
    ) as request:
        if settlement == "rollback":
            failed = await request.post(
                f"/api/companion/contents/{content_id}/finalize",
                headers=capture["headers"],
                json={
                    "byte_count": len(body),
                    "sha256": hashlib.sha256(body).hexdigest(),
                },
            )
            assert failed.status_code == 500
            assert calls == []
            assert committed == []
        else:
            response = await request.post(
                f"/api/companion/contents/{content_id}/finalize",
                headers=capture["headers"],
                json={
                    "byte_count": len(body),
                    "sha256": hashlib.sha256(body).hexdigest(),
                },
            )
            assert response.status_code == 200, response.text
            assert response.json()["state"] == "available"
            assert calls == [
                str(content_id)
            ], "Finalized new text must schedule its single-source index processor"
    async with factory.begin() as observer:
        current = await observer.get(AgentSessionContent, content_id)
        assert current.state == ("pending" if settlement == "rollback" else "available")
    if settlement != "rollback":
        path = sessions_path(test_workspace, session_id)
        page = await search(client, path, "POSTCOMMIT_INDEX_MARKER")
        assert page["items"] == []
        assert page["coverage"]["pending_index"] == {"count": 1, "bytes": len(body)}
