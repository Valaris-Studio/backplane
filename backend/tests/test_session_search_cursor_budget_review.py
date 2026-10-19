# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""An owner-provided cursor cannot invent bytes already scanned.

The fixture uses real capture, index and owner HTTP search against the bound
SQLite database. Only `y` changes in the server-issued cursor; its identity,
query/filter binding, generation fingerprint and chunk position stay exact.
"""

import base64
import json

import pytest

from app import database
from tests.test_session_search import (
    capture as capture,
    exact_match,
    one_inline,
    paused_object_indexing as paused_object_indexing,
    search,
)

pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]

BODY = "prefix🙂 needle first needle second tail"
QUERY = "needle"


def decode_cursor(cursor):
    return json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))


def encode_cursor(payload):
    raw = json.dumps(payload, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


@pytest.fixture
async def issued_cursor(
    client, device_client, db_session, db_engine, test_workspace, capture
):
    assert db_engine.dialect.name == "sqlite"
    assert database.async_session.kw["bind"] is db_engine
    path, content_id = await one_inline(
        client, device_client, db_session, test_workspace, capture, BODY
    )
    first = await search(client, path, QUERY, limit=1)
    [hit] = first["items"]
    assert hit["content_id"] == content_id
    exact_match(hit, BODY, QUERY)
    cursor = first["next_cursor"]
    assert cursor is not None and len(cursor) <= 1024
    payload = decode_cursor(cursor)
    second_character = BODY.index(QUERY, BODY.index(QUERY) + len(QUERY))
    second_byte = len(BODY[:second_character].encode())
    assert payload["c"] == second_character
    assert payload["y"] == second_byte
    assert 0 < second_byte < len(BODY.encode())
    return path, cursor, payload, second_byte, first["generation"]


async def assert_valid_continuation(client, issued):
    path, cursor, payload, second_byte, generation = issued
    page = await search(client, path, QUERY, cursor=cursor, limit=1)
    [hit] = page["items"]
    exact_match(hit, BODY, QUERY, start=second_byte)
    assert page["generation"] == generation
    assert page["scanned_bytes"] == len(BODY.encode()) - payload["y"]
    assert page["complete"] is True
    assert page["next_cursor"] is None


async def test_server_issued_resume_prefix_keeps_exact_bounded_continuation(
    client, issued_cursor
):
    await assert_valid_continuation(client, issued_cursor)


@pytest.mark.parametrize("offset", ["past_actual_prefix", "past_chunk"])
async def test_resume_byte_offset_must_match_the_indexed_prefix(
    client, issued_cursor, offset
):
    # Prove this exact issued cursor works before changing only its byte count.
    await assert_valid_continuation(client, issued_cursor)
    path, original_cursor, original, _, _ = issued_cursor
    changed = dict(original)
    changed["y"] = (
        original["y"] + 1
        if offset == "past_actual_prefix"
        else len(BODY.encode()) + 1
    )
    assert {key: value for key, value in changed.items() if key != "y"} == {
        key: value for key, value in original.items() if key != "y"
    }
    invalid_cursor = encode_cursor(changed)
    assert invalid_cursor != original_cursor
    assert len(invalid_cursor) <= 1024

    response = await client.post(
        f"{path}/search",
        json={"q": QUERY, "cursor": invalid_cursor, "limit": 1},
    )
    assert response.request.url.query == b""
    assert response.headers["cache-control"] == "private, no-store"
    assert response.status_code == 422, json.dumps(
        {
            "offset": offset,
            "valid_prefix_bytes": original["y"],
            "submitted_prefix_bytes": changed["y"],
            "chunk_body_bytes": len(BODY.encode()),
            "response_status": response.status_code,
            "response": response.json(),
        },
        indent=2,
    )
    assert "items" not in response.json()
    assert "coverage" not in response.json()
    assert QUERY not in response.text
    assert invalid_cursor not in response.text
