# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import timedelta

import pytest

from tests.test_session_content_window import (
    START,
    add_content,
    ids,
    seed_contents as content_window_seed_fixture,
    window,
)

seed_contents = content_window_seed_fixture
pytestmark = pytest.mark.usefixtures("content_storage")


def assert_private_error(response, status, error_code):
    assert response.status_code == status, response.text
    assert response.json()["error_code"] == error_code
    assert response.headers.get("cache-control") == "private, no-store"


async def test_missing_window_anchor_is_not_negatively_cached(client, seed_contents):
    seeded = await seed_contents()
    response = await client.get(
        f"{seeded.path}/window",
        params={"mode": "anchor", "anchor_id": str(uuid.uuid4())},
    )
    assert_private_error(response, 404, "content_not_found")


async def test_overflowed_pinned_window_error_is_private_and_not_cached(
    client, seed_contents, db_session
):
    seeded = await seed_contents(100)
    original = await window(client, seeded, mode="beginning")
    await add_content(db_session, seeded, occurred_at=START + timedelta(microseconds=1))
    response = await client.get(
        f"{seeded.path}/window",
        params={"mode": "refresh", "cursor": original["window_cursor"]},
    )
    assert_private_error(response, 409, "content_window_changed")


async def test_window_authorization_error_is_private_and_not_cached(
    agent_client, seed_contents
):
    seeded = await seed_contents()
    response = await agent_client.get(f"{seeded.path}/window")
    assert_private_error(response, 403, "forbidden")


async def test_invalid_window_cursor_error_is_private_and_not_cached(
    client, seed_contents
):
    seeded = await seed_contents()
    response = await client.get(
        f"{seeded.path}/window", params={"mode": "refresh", "cursor": "%"}
    )
    assert_private_error(response, 422, "validation_error")


async def test_selected_metadata_authorization_error_is_private_and_not_cached(
    agent_client, seed_contents
):
    seeded = await seed_contents()
    response = await agent_client.post(
        f"{seeded.path}/metadata", json={"content_ids": ids(seeded.rows)}
    )
    assert_private_error(response, 403, "forbidden")


async def test_selected_metadata_validation_error_is_private_and_redacted(
    client, seed_contents
):
    seeded = await seed_contents()
    invalid_id = "synthetic-private-path-or-token"
    response = await client.post(
        f"{seeded.path}/metadata", json={"content_ids": [invalid_id]}
    )
    assert invalid_id not in response.text
    assert response.json()["detail"] == "Invalid request"
    assert_private_error(response, 422, "validation_error")
