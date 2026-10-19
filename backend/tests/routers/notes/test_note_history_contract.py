# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import json
import uuid
from contextlib import asynccontextmanager

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, event, func, select, update

from app.core.auth import get_current_user
from app.database import get_db
from app.main import create_app
from app.models.activity import Activity, ActivityAction
from app.models.base import Base
from app.models.api_key import ApiKey
from app.models.kanban.board import Board
from app.models.notes.note import Note
from app.models.notes.save_receipt import NoteSaveReceipt
from app.models.workspace import WorkspaceMember, WorkspaceRole

SNAPSHOT_FIELDS = (
    "content", "title", "pinned", "card_id", "kind", "failure_class", "findings",
    "source_execution_id",
)


def _url(workspace, note_id=None, board=None):
    base = f"/api/workspaces/{workspace.slug}"
    if board is not None:
        base += f"/boards/{board.id}"
    base += "/notes"
    return base if note_id is None else f"{base}/{note_id}"


def _private(response):
    policy = response.headers.get("cache-control", "")
    assert "private" in policy and "no-store" in policy


async def _create(client, workspace, board=None, **fields):
    response = await client.post(_url(workspace, board=board), json={
        "title": "Recorded note", "content": "# State\n\nBefore", **fields,
    })
    assert response.status_code == 201, response.text
    read = await client.get(_url(workspace, response.json()["id"]))
    assert read.status_code == 200 and read.json()["content"] == response.json()["content"]
    return response.json()


async def _history(client, url, **params):
    response = await client.get(f"{url}/revisions", params=params)
    assert response.status_code == 200, response.text
    _private(response)
    return response.json()


async def _revision(client, url, revision):
    response = await client.get(f"{url}/revisions/{revision}")
    assert response.status_code == 200, response.text
    _private(response)
    return response.json()


@asynccontextmanager
async def _as_user(db, user):
    app = create_app()

    async def database():
        yield db

    async def principal():
        return user

    app.dependency_overrides[get_db] = database
    app.dependency_overrides[get_current_user] = principal
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        yield client


async def test_existing_routes_record_each_exact_committed_shape(
    client, db_session, test_workspace, test_board, test_user, test_card,
):
    first = await _create(client, test_workspace, test_board, card_id=str(test_card.id))
    url = _url(test_workspace, first["id"])
    snapshots = [first]
    for method, suffix, payload in [
        ("put", "", {"title": "Edited title", "pinned": True}),
        ("post", "/append", {"content": "## Tail\n\nAdded café 🐙"}),
        ("post", "/replace-section", {"anchor_heading": "State", "content": "Replacement"}),
    ]:
        response = await getattr(client, method)(url + suffix, json=payload)
        assert response.status_code == 200, response.text
        snapshots.append(response.json())
    listed = await _history(client, url)
    assert [item["revision"] for item in listed["items"]] == [4, 3, 2, 1]
    assert listed["latest_recorded_revision"] == 4
    assert listed["capture_boundary"] == {"first_revision": 1, "capture_kind": "creation"}
    for revision, snapshot in enumerate(snapshots, 1):
        retained = await _revision(client, url, revision)
        assert retained["snapshot"] == {key: snapshot[key] for key in SNAPSHOT_FIELDS}
        assert retained["content_bytes"] == len(snapshot["content"].encode())
        assert retained["content_sha256"] == hashlib.sha256(snapshot["content"].encode()).hexdigest()
        assert retained["actor"]["user_id"] == str(test_user.id)
        assert retained["capture_kind"] == ("creation" if revision == 1 else "edit")
    compared = await client.get(url + "/revisions/compare", params={"from_revision": 1, "to_revision": 2})
    assert compared.status_code == 200, compared.text
    assert set(compared.json()["changed_fields"]) == {"title", "pinned"}
    assert compared.json()["before"]["snapshot"]["content"] == first["content"]
    assert compared.json()["after"]["snapshot"]["title"] == "Edited title"
    assert await db_session.scalar(select(func.count()).select_from(NoteSaveReceipt)) == 0


async def test_legacy_baseline_is_exact_unknown_and_gap_is_not_fabricated(
    client, db_session, test_note, test_workspace,
):
    # This is deliberately not normalized JSON: legacy bytes are historical truth.
    original = ' { "type" : "doc", "content" : [] }\n'
    test_note.content = original
    await db_session.flush()
    await db_session.refresh(test_note)
    url = _url(test_workspace, test_note.id)
    assert (await client.get(url)).status_code == 200
    empty = await _history(client, url)
    assert empty["items"] == [] and empty["capture_boundary"] is None
    edited = await client.put(url, json={"title": "First observed edit"})
    assert edited.status_code == 200, edited.text
    baseline = await _revision(client, url, 1)
    assert baseline["snapshot"]["content"] == original
    assert baseline["capture_kind"] == "baseline" and baseline["actor"] is None
    assert edited.json()["history_revision"] == 2
    await db_session.execute(update(Note).where(Note.id == test_note.id).values(
        content="old writer bytes\r\n", updated_at=test_note.updated_at,
    ))
    later = await client.put(url, json={"title": "After rolling old writer"})
    assert later.status_code == 200, later.text
    gap = await _revision(client, url, 3)
    assert gap["capture_kind"] == "gap_baseline" and gap["actor"] is None
    assert gap["snapshot"]["content"] == "old writer bytes\r\n"
    assert later.json()["history_revision"] == 4
    assert (await _revision(client, url, 1))["snapshot"]["content"] == original


async def test_explicit_retry_precedes_stale_preconditions_and_returns_current_note(
    client, test_workspace, test_board,
):
    first = await _create(client, test_workspace, test_board)
    url = _url(test_workspace, first["id"])
    intent = {"mode": "append", "content": "Exactly once", "client_request_id": str(uuid.uuid4()),
              "expected_revision": 1, "expected_digest": first.get("revision_digest")}
    applied = await client.post(url + "/edit", json=intent)
    assert applied.status_code == 200, applied.text
    assert applied.json()["history_revision"] == 2
    later = await client.put(url, json={"title": "Current title"})
    assert later.status_code == 200
    replay = await client.post(url + "/edit", json=intent)
    assert replay.status_code == 200, replay.text
    assert replay.json()["title"] == "Current title"
    assert replay.json()["history_revision"] == 3
    assert replay.json()["content"].count("Exactly once") == 1
    assert len((await _history(client, url))["items"]) == 3
    changed_intent = await client.post(url + "/edit", json={**intent, "content": "Different intent"})
    assert changed_intent.status_code == 409, changed_intent.text
    _private(changed_intent)
    stale = await client.post(url + "/edit", json={**intent, "client_request_id": str(uuid.uuid4())})
    assert stale.status_code == 409, stale.text


async def test_noop_request_on_revision_zero_records_no_baseline_and_replays(
    client, db_session, test_note, test_workspace,
):
    url = _url(test_workspace, test_note.id)
    before = (await client.get(url)).json()
    intent = {"mode": "replace", "title": test_note.title, "expected_revision": 0,
              "client_request_id": str(uuid.uuid4())}
    for _ in range(2):
        result = await client.post(url + "/edit", json=intent)
        assert result.status_code == 200, result.text
        assert result.json()["history_revision"] == 0
        assert result.json()["updated_at"] == before["updated_at"]
    assert (await _history(client, url))["items"] == []
    assert await db_session.scalar(select(func.count()).select_from(Activity).where(
        Activity.entity_id == test_note.id, Activity.action == ActivityAction.updated,
    )) == 0


async def test_combined_section_failure_is_atomic_and_retry_does_not_claim_failure(
    client, test_workspace, test_board,
):
    first = await _create(client, test_workspace, test_board)
    url = _url(test_workspace, first["id"])
    intent = {"mode": "section", "anchor_heading": "Missing", "content": "Replacement",
              "title": "Must not persist", "client_request_id": str(uuid.uuid4())}
    failed = await client.post(url + "/edit", json=intent)
    assert failed.status_code == 404
    assert (await client.get(url)).json()["title"] == first["title"]
    good = await client.post(url + "/edit", json={**intent, "anchor_heading": "State"})
    assert good.status_code == 200, good.text
    assert good.json()["history_revision"] == 2
    assert len((await _history(client, url))["items"]) == 2


async def test_state_digest_detects_old_writer_drift_even_when_counter_did_not_change(
    client, db_session, test_workspace, test_board,
):
    first = await _create(client, test_workspace, test_board)
    note_id = uuid.UUID(first["id"])
    url = _url(test_workspace, note_id)
    await db_session.execute(update(Note).where(Note.id == note_id).values(pinned=True))
    stale = await client.post(url + "/edit", json={
        "mode": "replace", "title": "Stale save", "expected_revision": 1,
        "expected_digest": first.get("revision_digest"),
    })
    assert stale.status_code == 409, stale.text
    current = (await client.get(url)).json()
    assert current["title"] == first["title"] and current["pinned"] is True
    assert len((await _history(client, url))["items"]) == 1


async def test_history_keyset_is_stable_and_list_never_reads_bodies_or_findings(
    client, db_engine, test_workspace, test_board,
):
    first = await _create(client, test_workspace, test_board)
    url = _url(test_workspace, first["id"])
    for index in range(5):
        assert (await client.put(url, json={"title": f"Revision {index}"})).status_code == 200
    statements = []

    def capture(_conn, _cursor, statement, _params, _ctx, _many):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement.lower())

    event.listen(db_engine.sync_engine, "before_cursor_execute", capture)
    try:
        page = await _history(client, url, limit=2)
    finally:
        event.remove(db_engine.sync_engine, "before_cursor_execute", capture)
    assert [item["revision"] for item in page["items"]] == [6, 5]
    assert page["next_before_revision"] == 5
    for statement in statements:
        projection = statement.split("\nfrom ")[0].split(" from ")[0]
        assert "note_revision_chunks" not in statement
        assert "note_revision_manifest" not in statement
        assert "notes.content," not in projection and "notes.content " not in projection
        assert ".findings" not in projection
    assert all("snapshot" not in item and "content" not in item and "findings" not in item for item in page["items"])
    assert (await client.put(url, json={"title": "Concurrent new head"})).status_code == 200
    following = await _history(client, url, limit=2, before_revision=page["next_before_revision"])
    assert [item["revision"] for item in following["items"]] == [4, 3]
    for invalid in (0, 101):
        response = await client.get(url + "/revisions", params={"limit": invalid})
        assert response.status_code == 422


async def test_new_board_routes_validate_actual_scope_and_workspace_route_stays_valid(
    client, db_session, test_workspace, test_board, test_user,
):
    note = await _create(client, test_workspace, test_board)
    other = Board(workspace_id=test_workspace.id, created_by=test_user.id, name="Other", slug="other")
    db_session.add(other)
    await db_session.flush()
    valid = _url(test_workspace, note["id"])
    wrong = _url(test_workspace, note["id"], other)
    assert len((await _history(client, valid))["items"]) == 1
    for suffix in ("/revisions", "/revisions/1", "/revisions/compare?from_revision=1&to_revision=1"):
        denied = await client.get(wrong + suffix)
        assert denied.status_code == 404, denied.text
        _private(denied)
    denied_edit = await client.post(wrong + "/edit", json={"mode": "replace", "title": "Wrong board"})
    assert denied_edit.status_code == 404
    assert (await client.get(valid)).json()["title"] == note["title"]


async def test_viewer_history_is_shared_current_authorization_and_revocation_preserves_other_readers(
    client, db_session, test_workspace, test_board, second_user,
):
    note = await _create(client, test_workspace, test_board)
    url = _url(test_workspace, note["id"])
    db_session.add(WorkspaceMember(workspace_id=test_workspace.id, user_id=second_user.id, role=WorkspaceRole.viewer))
    await db_session.flush()
    async with _as_user(db_session, second_user) as reader:
        assert (await reader.get(url)).status_code == 200
        assert len((await _history(reader, url))["items"]) == 1
        refused = await reader.post(url + "/edit", json={"mode": "replace", "title": "Denied"})
        assert refused.status_code == 403
        await db_session.execute(delete(WorkspaceMember).where(
            WorkspaceMember.workspace_id == test_workspace.id, WorkspaceMember.user_id == second_user.id,
        ))
        for suffix in ("/revisions", "/revisions/1", "/revisions/compare?from_revision=1&to_revision=1"):
            denied = await reader.get(url + suffix)
            assert denied.status_code == 403
            _private(denied)
    assert len((await _history(client, url))["items"]) == 1


@pytest.mark.parametrize("lifecycle", ["note", "board", "workspace"])
async def test_history_storage_cascades_with_its_note_lifecycle(
    lifecycle, client, db_session, test_workspace, test_board,
):
    note = await _create(client, test_workspace, test_board)
    url = _url(test_workspace, note["id"])
    applied = await client.post(url + "/edit", json={
        "mode": "append", "content": "Retained once", "client_request_id": str(uuid.uuid4()),
    })
    assert applied.status_code == 200, applied.text
    tables = [Base.metadata.tables.get(name) for name in (
        "note_revisions", "note_revision_chunks", "note_revision_manifest", "note_mutation_receipts",
    )]
    assert all(table is not None for table in tables)
    note_id = uuid.UUID(note["id"])
    for table in tables:
        assert await db_session.scalar(select(func.count()).select_from(table).where(table.c.note_id == note_id)) > 0
    if lifecycle == "note":
        assert (await client.delete(url)).status_code == 204
    elif lifecycle == "board":
        await db_session.delete(test_board)
        await db_session.flush()
    else:
        await db_session.delete(test_workspace)
        await db_session.flush()
    for table in tables:
        assert await db_session.scalar(select(func.count()).select_from(table).where(table.c.note_id == note_id)) == 0


async def test_untrusted_headers_do_not_invent_client_or_model_attribution(
    client, test_workspace, test_user,
):
    response = await client.post(_url(test_workspace), json={"title": "Attribution", "content": "Saved"}, headers={
        "X-MCP-Invocation-Id": str(uuid.uuid4()), "X-Model": "forged-model", "X-Client": "browser_session",
    })
    assert response.status_code == 201
    revision = await _revision(client, _url(test_workspace, response.json()["id"]), 1)
    assert revision["actor"]["user_id"] == str(test_user.id)
    assert revision["channel"] == "unconfirmed"
    serialized = json.dumps(revision)
    assert "forged-model" not in serialized and "browser_session" not in serialized
    assert "native_call_id" not in serialized and "harness" not in serialized


async def test_retry_scope_distinguishes_same_owner_credentials_and_note_identity(
    client, plain_key_client, installation_key_client, db_session, test_workspace, test_board,
):
    first = await _create(client, test_workspace, test_board)
    second = await _create(client, test_workspace, test_board, title="Second note")
    url = _url(test_workspace, first["id"])
    intent = {"mode": "append", "content": "Same request, distinct principal",
              "client_request_id": str(uuid.uuid4())}
    for authenticated in (plain_key_client, installation_key_client):
        control = await authenticated.get(url)
        assert control.status_code == 200, control.text
        response = await authenticated.post(url + "/edit", json=intent)
        assert response.status_code == 200, response.text
        replay = await authenticated.post(url + "/edit", json=intent)
        assert replay.status_code == 200
    current = (await client.get(url)).json()
    assert current["content"].count("Same request, distinct principal") == 2
    assert current["history_revision"] == 3
    personal = await _revision(client, url, 2)
    installation = await _revision(client, url, 3)
    assert personal["actor"]["api_key_id"] != installation["actor"]["api_key_id"]
    assert personal["actor"]["installation_id"] is None
    assert installation["actor"]["installation_id"] is not None
    for item in (personal, installation):
        assert item["actor"]["authentication_method"] == "api_key"
        assert item["channel"] == "unconfirmed"
        assert "key_hash" not in json.dumps(item) and "key_prefix" not in json.dumps(item)
    other_note = await plain_key_client.post(_url(test_workspace, second["id"]) + "/edit", json=intent)
    assert other_note.status_code == 200 and other_note.json()["history_revision"] == 2
    await db_session.execute(delete(ApiKey).where(ApiKey.id == uuid.UUID(personal["actor"]["api_key_id"])))
    denied = await plain_key_client.post(url + "/edit", json=intent)
    assert denied.status_code == 403, denied.text
    assert len((await _history(client, url))["items"]) == 3


async def test_omitted_and_explicit_null_are_distinct_retry_intents(
    client, test_workspace, test_board, test_card,
):
    note = await _create(client, test_workspace, test_board, card_id=str(test_card.id))
    url = _url(test_workspace, note["id"])
    intent = {"mode": "replace", "title": "Linked", "client_request_id": str(uuid.uuid4())}
    first = await client.post(url + "/edit", json=intent)
    assert first.status_code == 200, first.text
    conflict = await client.post(url + "/edit", json={**intent, "card_id": None})
    assert conflict.status_code == 409, conflict.text
    current = (await client.get(url)).json()
    assert current["card_id"] == str(test_card.id) and current["history_revision"] == 2


async def test_invocation_header_alone_does_not_deduplicate_intentional_appends(
    client, test_workspace, test_board,
):
    note = await _create(client, test_workspace, test_board)
    url = _url(test_workspace, note["id"])
    header = {"X-MCP-Invocation-Id": str(uuid.uuid4())}
    for _ in range(2):
        response = await client.post(url + "/append", json={"content": "Intentional repeat"}, headers=header)
        assert response.status_code == 200
    assert response.json()["content"].count("Intentional repeat") == 2
    assert len((await _history(client, url))["items"]) == 3


async def test_card_deletion_detaches_current_note_without_rewriting_snapshot(
    client, db_session, test_workspace, test_board, test_card,
):
    note = await _create(client, test_workspace, test_board, card_id=str(test_card.id))
    url = _url(test_workspace, note["id"])
    assert (await _revision(client, url, 1))["snapshot"]["card_id"] == str(test_card.id)
    card_id = str(test_card.id)
    await db_session.delete(test_card)
    await db_session.flush()
    current = await client.get(url)
    assert current.status_code == 200
    assert current.json()["card_id"] is None
    assert (await _revision(client, url, 1))["snapshot"]["card_id"] == card_id


async def test_existing_authorized_note_read_and_ordinary_publication_absence_control(
    client, test_workspace, test_board,
):
    note = await _create(client, test_workspace, test_board)
    url = _url(test_workspace, note["id"], test_board)
    presence = await client.get(url + "/publication-revision/presence")
    assert presence.status_code == 200
    assert presence.json() == {"has_record": False, "recorded_at": None}
