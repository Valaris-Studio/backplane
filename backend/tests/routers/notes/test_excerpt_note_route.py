# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The publication route cannot degrade into ordinary note creation on old APIs.

The dedicated path is intentionally absent on legacy backends. Both source and
receipt fields are mandatory here; its service semantics match the frozen
publication contract. That older contract remains unchanged in its own file.
"""

import json

import pytest
from sqlalchemy import update

from app.models.workspace import WorkspaceMember, WorkspaceRole
from app.schemas.notes.note import NoteRead
from tests.routers.notes.test_excerpt_note_save import (
    add_member,
    as_principal,
    board_notes,
    created_activity_count,
    captured_items,
    excerpt_save,
    note_count,
    reviewed_document,
)

pytestmark = pytest.mark.usefixtures("content_storage")


@pytest.fixture(name="owner")
async def route_owner(db_session, test_user):
    async with as_principal(db_session, test_user) as principal:
        yield principal


@pytest.fixture(name="source")
async def route_source(client, device_client, db_session, test_workspace, test_board):
    session_id, items = await captured_items(
        client,
        device_client,
        db_session,
        test_workspace,
        test_board,
        [b"first selected body", b"second selected body"],
    )
    return {"session_id": session_id, "items": items}


def publication_path(workspace, board):
    return f"{board_notes(workspace, board)}/from-excerpt"


@pytest.mark.parametrize(
    "removed,null_field",
    [
        (("client_request_id",), None),
        (("excerpt_source",), None),
        (("client_request_id", "excerpt_source"), None),
        ((), "client_request_id"),
        ((), "excerpt_source"),
    ],
    ids=[
        "missing-receipt",
        "missing-source",
        "missing-both",
        "null-receipt",
        "null-source",
    ],
)
async def test_explicit_route_requires_both_fields_before_any_creation(
    removed, null_field, owner, db_session, test_workspace, test_board, source
):
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    for key in removed:
        payload.pop(key)
    if null_field:
        payload[null_field] = None
    response = await owner.post(
        publication_path(test_workspace, test_board), json=payload
    )
    assert response.status_code == 422, response.text
    assert response.json()["error_code"] == "request_validation_error"
    assert await note_count(db_session) == 0
    assert await created_activity_count(db_session) == 0


async def test_explicit_route_saves_reviewed_document_and_replays_one_ordinary_note(
    owner, db_session, test_workspace, test_board, test_card, source
):
    doc = reviewed_document(
        ["Owner edited this body\n~~~\n# literal", "second selected body\n"]
    )
    payload = excerpt_save(
        test_workspace,
        source["session_id"],
        source["items"],
        content=doc,
        card_id=str(test_card.id),
    )
    url = publication_path(test_workspace, test_board)
    first = await owner.post(url, json=payload)
    assert first.status_code == 201, first.text
    saved = first.json()
    assert set(saved) == set(NoteRead.model_fields)
    assert json.loads(saved["content"]) == doc
    assert saved["card_id"] == str(test_card.id)
    assert saved["kind"] == "user_note"
    assert saved["pinned"] is False
    replay = await owner.post(url, json=payload)
    assert replay.status_code == 200, replay.text
    assert replay.json()["id"] == saved["id"]
    assert json.loads(replay.json()["content"]) == doc
    assert await note_count(db_session) == 1
    assert await created_activity_count(db_session) == 1


async def test_explicit_route_validates_selected_source_before_fresh_creation(
    owner, db_session, test_workspace, test_board, source
):
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    payload["excerpt_source"]["items"][0]["sha256"] = "0" * 64
    response = await owner.post(
        publication_path(test_workspace, test_board), json=payload
    )
    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "excerpt_source_stale"
    assert await note_count(db_session) == 0
    assert await created_activity_count(db_session) == 0


async def test_explicit_route_reauthorizes_destination_before_receipt_replay(
    owner, db_session, test_user, test_workspace, test_board, source
):
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    url = publication_path(test_workspace, test_board)
    first = await owner.post(url, json=payload)
    assert first.status_code == 201, first.text
    await db_session.execute(
        update(WorkspaceMember)
        .where(
            WorkspaceMember.workspace_id == test_workspace.id,
            WorkspaceMember.user_id == test_user.id,
        )
        .values(role=WorkspaceRole.viewer)
    )
    await db_session.flush()
    refused = await owner.post(url, json=payload)
    assert refused.status_code == 403, refused.text
    assert first.json()["id"] not in refused.text
    assert await note_count(db_session) == 1
    assert await created_activity_count(db_session) == 1


async def test_explicit_route_keeps_source_private_from_another_destination_writer(
    owner, db_session, test_workspace, test_board, second_user, source
):
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    url = publication_path(test_workspace, test_board)
    first = await owner.post(url, json=payload)
    assert first.status_code == 201, first.text
    await add_member(db_session, test_workspace, second_user)
    async with as_principal(db_session, second_user) as other:
        refused = await other.post(url, json=payload)
    assert refused.status_code == 404, refused.text
    assert first.json()["id"] not in refused.text
    assert await note_count(db_session) == 1
    assert await created_activity_count(db_session) == 1


async def test_generic_route_still_accepts_an_ordinary_note_without_publication_fields(
    owner, db_session, test_workspace, test_board
):
    response = await owner.post(
        board_notes(test_workspace, test_board),
        json={"title": "Ordinary note control", "content": "# Normal Markdown"},
    )
    assert response.status_code == 201, response.text
    assert json.loads(response.json()["content"])["content"][0]["type"] == "heading"
    assert await note_count(db_session) == 1


async def test_explicit_route_rejects_agent_and_installation_keys_before_fresh_or_replay(
    owner,
    agent_client,
    installation_key_client,
    db_session,
    test_workspace,
    test_board,
    source,
):
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    url = publication_path(test_workspace, test_board)
    for key_client in (agent_client, installation_key_client):
        fresh = await key_client.post(url, json=payload)
        assert fresh.status_code == 403, fresh.text
        assert fresh.json()["error_code"] == "forbidden"
    assert await note_count(db_session) == 0
    first = await owner.post(url, json=payload)
    assert first.status_code == 201, first.text
    for key_client in (agent_client, installation_key_client):
        replay = await key_client.post(url, json=payload)
        assert replay.status_code == 403, replay.text
        assert replay.json()["error_code"] == "forbidden"
        assert first.json()["id"] not in replay.text
    assert await note_count(db_session) == 1
    assert await created_activity_count(db_session) == 1
