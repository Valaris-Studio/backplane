# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Retained structured events must keep exact search identities and coverage."""

import json

import pytest

from app.services.session_search_text import event_leaf
from tests.test_session_calls import beacon
from tests.test_session_search import (
    exact_match,
    paused_object_indexing as paused_object_indexing,
    retained_event_session,
    search,
)

pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]


@pytest.fixture
def retained_arguments(client, device_client, db_session, test_workspace, test_board):
    async def retain(arguments):
        event = beacon(
            "tool.invoked", 1,
            tool={"name": "FixtureTool", "arguments": arguments},
        )
        assert len(json.dumps(event, ensure_ascii=False).encode()) < 64 << 10
        path, _, _ = await retained_event_session(
            client, device_client, db_session, test_workspace, test_board, [event],
            level="full",
        )
        response = await client.get(f"{path}/events")
        assert response.status_code == 200, response.text
        assert response.headers["cache-control"] == "no-store"
        [stored] = response.json()["items"]
        assert stored["capture_level"] == "full"
        assert stored["data"]["tool"]["arguments"] == arguments
        return path, stored

    return retain


def assert_exact_event_hit(item, stored, text, needle, *, start=0):
    assert item["source_kind"] == "event"
    assert item["source_id"] == stored["id"]
    assert item["event_id"] == stored["event_id"]
    assert item["channel"] == "tool_input"
    assert item["source_state"] == "available", item
    # Exercise the field resolver the API uses, without prescribing a new path
    # syntax. Distinct retained leaves must resolve to their original bytes.
    assert event_leaf(stored["data"], item["field"]) == text
    exact_match(item, text, needle, start=start)


def assert_event_ready(page):
    coverage = page["coverage"]
    assert coverage["indexed"]["count"] == 1, coverage
    assert coverage["pending_index"] == {"count": 0, "bytes": 0}, coverage
    assert coverage["unavailable"] == {"count": 0, "bytes": 0}, coverage
    assert coverage["index_ready"] is True, coverage


@pytest.mark.parametrize(
    "arguments",
    [
        {"flat": "CONTROL_NEEDLE plain"},
        {"nested": {"leaf": "CONTROL_NEEDLE plain"}},
        {"array": ["ordinary text", {"leaf": "CONTROL_NEEDLE plain"}]},
    ],
    ids=["flat", "nested", "array"],
)
async def test_ordinary_structured_arguments_keep_exact_leaf_identity(
    client, retained_arguments, arguments
):
    path, stored = await retained_arguments(arguments)
    page = await search(client, path, "CONTROL_NEEDLE")
    [item] = page["items"]
    assert_exact_event_hit(item, stored, "CONTROL_NEEDLE plain", "CONTROL_NEEDLE")
    assert_event_ready(page)
    assert page["complete"] is True


async def test_literal_dotted_key_is_not_verified_against_a_different_nested_leaf(
    client, retained_arguments
):
    arguments = {"a": {"b": "NESTED_VALUE_ONLY"}, "a.b": "DOTTED_VALUE_ONLY"}
    path, stored = await retained_arguments(arguments)
    nested = await search(client, path, "NESTED_VALUE_ONLY")
    [nested_hit] = nested["items"]
    assert_exact_event_hit(nested_hit, stored, "NESTED_VALUE_ONLY", "NESTED_VALUE_ONLY")

    dotted = await search(client, path, "DOTTED_VALUE_ONLY")
    [dotted_hit] = dotted["items"]
    assert_exact_event_hit(dotted_hit, stored, "DOTTED_VALUE_ONLY", "DOTTED_VALUE_ONLY")
    assert dotted_hit["field"] != nested_hit["field"]
    assert_event_ready(dotted)


async def test_same_needle_in_dotted_and_nested_leaves_produces_two_exact_hits(
    client, retained_arguments
):
    nested_text, dotted_text = "same-needle nested", "same-needle dotted"
    path, stored = await retained_arguments(
        {"a": {"b": nested_text}, "a.b": dotted_text}
    )
    page = await search(client, path, "same-needle")
    assert len(page["items"]) == 2, page
    assert len({item["field"] for item in page["items"]}) == 2
    resolved = {event_leaf(stored["data"], item["field"]): item for item in page["items"]}
    assert set(resolved) == {nested_text, dotted_text}
    for text, item in resolved.items():
        assert_exact_event_hit(item, stored, text, "same-needle")
    assert_event_ready(page)
    assert page["complete"] is True


@pytest.mark.parametrize("key_length", [6, 1000], ids=["ordinary-key", "1000-character-key"])
async def test_issued_cursor_is_bounded_and_roundtrips_long_retained_field_identity(
    client, retained_arguments, key_length
):
    text = "needle needle"
    path, stored = await retained_arguments({"k" * key_length: text})
    first = await search(client, path, "needle", limit=1)
    [first_hit] = first["items"]
    assert_exact_event_hit(first_hit, stored, text, "needle")
    assert_event_ready(first)
    cursor = first["next_cursor"]
    assert isinstance(cursor, str) and cursor
    original_cursor = cursor
    items = [first_hit]

    # Submit the issued cursor before checking its length so the original red
    # records both the oversized output and the actual HTTP rejection.
    for _ in range(3):
        response = await client.post(
            f"{path}/search", json={"q": "needle", "limit": 1, "cursor": cursor}
        )
        assert (len(cursor) <= 1024, response.status_code) == (True, 200), {
            "issued_cursor_length": len(cursor),
            "resume_status": response.status_code,
            "resume_body": response.json(),
        }
        assert response.headers["cache-control"] == "private, no-store"
        page = response.json()
        assert page["generation"] == first["generation"]
        items.extend(page["items"])
        if page["complete"]:
            assert page["next_cursor"] is None
            break
        assert page["next_cursor"] != cursor
        cursor = page["next_cursor"]
    else:
        pytest.fail("Two retained occurrences did not finish within four pages")

    assert [(item["byte_start"], item["byte_end"]) for item in items] == [(0, 6), (7, 13)]
    assert len({item["field"] for item in items}) == 1
    for item, start in zip(items, (0, 7), strict=True):
        assert_exact_event_hit(item, stored, text, "needle", start=start)
    for options in (
        {"cursor": "not-a-valid-cursor"},
        {"cursor": original_cursor, "types": ["prompt"]},
    ):
        invalid = await client.post(f"{path}/search", json={"q": "needle", **options})
        assert invalid.status_code == 422, invalid.text
        assert invalid.headers["cache-control"] == "private, no-store"


async def test_retained_33_level_argument_is_searchable_when_index_reports_ready(
    client, retained_arguments
):
    text = "DEEP_RETAINED_NEEDLE"
    arguments = text
    for depth in range(33):
        arguments = {f"level_{depth}": arguments}
    path, stored = await retained_arguments(arguments)
    page = await search(client, path, text)
    assert_event_ready(page)
    assert len(page["items"]) == 1, {
        "retained_leaf": text,
        "items": page["items"],
        "coverage": page["coverage"],
    }
    assert_exact_event_hit(page["items"][0], stored, text, text)
    assert page["complete"] is True
