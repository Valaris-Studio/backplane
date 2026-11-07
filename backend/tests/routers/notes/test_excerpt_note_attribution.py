# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""A published session excerpt is stamped like any other human note (SEC R1/R6).

The excerpt path reaches `_insert_note` through `save_note`, so the author
stamp must be the publishing person's, on the first save and again on the
idempotent replay that answers from the receipt instead of inserting.
"""

import pytest

from tests.routers.notes.test_excerpt_note_route import (  # noqa: F401
    publication_path,
    route_owner,
    route_source,
)
from tests.routers.notes.test_excerpt_note_save import board_notes, excerpt_save

pytestmark = pytest.mark.usefixtures("content_storage")

ATTRIBUTION_FIELDS = ("author_principal_kind", "author_agent_id", "pinned_by", "pinned_at")


def _stamps(note: dict) -> dict:
    return {field: note[field] for field in ATTRIBUTION_FIELDS}


@pytest.mark.parametrize("route", ["from-excerpt", "generic"])
async def test_published_excerpt_is_stamped_as_the_publishing_human_and_replays_identically(
    route, owner, test_workspace, test_board, source
):
    url = (
        publication_path(test_workspace, test_board)
        if route == "from-excerpt"
        else board_notes(test_workspace, test_board)
    )
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    first = await owner.post(url, json=payload)
    assert first.status_code == 201, first.text
    saved = first.json()
    assert saved["pinned"] is False
    assert _stamps(saved) == {
        "author_principal_kind": "user",
        "author_agent_id": None,
        "pinned_by": None,
        "pinned_at": None,
    }
    replayed = await owner.post(url, json=payload)
    assert replayed.status_code == 200, replayed.text
    assert replayed.json()["id"] == saved["id"]
    assert _stamps(replayed.json()) == _stamps(saved)


async def test_personal_key_published_excerpt_is_stamped_as_a_user(
    plain_key_client, test_workspace, test_board, source
):
    """A person's own API key publishes like its person: still "user"."""
    response = await plain_key_client.post(
        publication_path(test_workspace, test_board),
        json=excerpt_save(test_workspace, source["session_id"], source["items"]),
    )
    assert response.status_code == 201, response.text
    assert _stamps(response.json()) == {
        "author_principal_kind": "user",
        "author_agent_id": None,
        "pinned_by": None,
        "pinned_at": None,
    }
