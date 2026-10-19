# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import uuid
from datetime import datetime, timedelta

import pytest
from sqlalchemy import delete, event, func, select, update

from app.config import settings
from app.models.agent_session import SessionWorkLink
from app.models.agents.context_receipt import ExecutionContextReceipt
from app.models.kanban.board import Board
from app.models.mcp_invocation import MCPConsultation, MCPInvocation
from app.models.notes.note import Note
from app.models.notes.save_receipt import NoteSaveReceipt
from app.models.workspace import WorkspaceMember, WorkspaceRole
from app.repositories.notes.note import NoteRepository
from app.services.storage.session_content import LocalContentStore
from tests.routers.agents.context_receipts_support import note_revision
from tests.routers.notes.test_excerpt_note_route import (  # noqa: F401
    route_owner,
    route_source,
)
from tests.routers.notes.test_excerpt_note_save import (
    add_member,
    as_principal,
    board_notes,
    excerpt_save,
    second_workspace,
)
from tests.rich_capture import sessions_path

pytestmark = pytest.mark.usefixtures("content_storage")
REVISION_FIELDS = {
    "status", "recorded_at", "revision_version", "published_revision_sha256",
    "current_revision_sha256", "comparison", "comparison_reason",
}


def publication_revision_path(workspace, board, note_id):
    return f"{board_notes(workspace, board)}/{note_id}/publication-revision"


def publication_presence_path(workspace, board, note_id):
    return f"{publication_revision_path(workspace, board, note_id)}/presence"


def workspace_notes(workspace):
    return f"/api/workspaces/{workspace.slug}/notes"


@pytest.fixture
async def publication(owner, test_workspace, test_board, source):
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    created = await owner.post(
        f"{board_notes(test_workspace, test_board)}/from-excerpt", json=payload
    )
    assert created.status_code == 201, created.text
    return payload, created.json()


async def inspect_revision(owner, workspace, board, note_id):
    response = await owner.get(publication_revision_path(workspace, board, note_id))
    assert response.status_code == 200, response.text
    assert set(response.json()) == REVISION_FIELDS
    return response.json()


async def inspect_presence(owner, workspace, board, note_id):
    response = await owner.get(publication_presence_path(workspace, board, note_id))
    assert response.status_code == 200, response.text
    assert set(response.json()) == {"has_record", "recorded_at"}
    return response.json()


async def receipt_for(db_session, note_id):
    receipt = await db_session.scalar(
        select(NoteSaveReceipt).where(NoteSaveReceipt.note_id == uuid.UUID(note_id))
        .execution_options(populate_existing=True)
    )
    assert receipt is not None
    return receipt


async def test_excerpt_receipt_freezes_the_canonical_saved_note_revision(
    owner, db_session, test_user, test_workspace, test_board, source
):
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    response = await owner.post(
        f"{board_notes(test_workspace, test_board)}/from-excerpt", json=payload
    )
    assert response.status_code == 201, response.text
    receipt = await db_session.scalar(
        select(NoteSaveReceipt).where(
            NoteSaveReceipt.user_id == test_user.id,
            NoteSaveReceipt.client_request_id == uuid.UUID(payload["client_request_id"]),
        )
    )
    assert receipt is not None
    assert getattr(receipt, "published_note_revision_sha256", None) == note_revision(
        response.json()
    ), "A committed excerpt save must retain its canonical publication revision"
    assert getattr(receipt, "published_note_revision_version", None) == 1


async def test_publishing_owner_can_inspect_the_saved_publication_revision(
    owner, db_session, test_workspace, test_board, publication
):
    payload, saved = publication
    inspected = await inspect_revision(owner, test_workspace, test_board, saved["id"])
    receipt = await receipt_for(db_session, saved["id"])
    assert inspected == {
        "status": "recorded",
        "recorded_at": inspected["recorded_at"],
        "revision_version": 1,
        "published_revision_sha256": note_revision(saved),
        "current_revision_sha256": note_revision(saved),
        "comparison": "matches",
        "comparison_reason": None,
    }
    assert datetime.fromisoformat(inspected["recorded_at"]).replace(
        tzinfo=None
    ) == receipt.created_at.replace(tzinfo=None)
    assert inspected["published_revision_sha256"] != receipt.fingerprint
    assert payload["client_request_id"] not in json.dumps(inspected)


async def test_publication_revision_uses_media_canonicalized_stored_content(
    owner, db_session, test_workspace, test_board, source, monkeypatch
):
    monkeypatch.setattr(settings, "FRONTEND_URL", "https://publication.example.test")
    relative = f"/api/workspaces/{test_workspace.slug}/media/{uuid.uuid4()}/image.png"
    document = {
        "type": "doc",
        "content": [{"type": "image", "attrs": {
            "src": "https://publication.example.test" + relative,
        }}],
    }
    response = await owner.post(
        f"{board_notes(test_workspace, test_board)}/from-excerpt",
        json=excerpt_save(
            test_workspace, source["session_id"], source["items"], content=document
        ),
    )
    assert response.status_code == 201, response.text
    saved = response.json()
    assert json.loads(saved["content"])["content"][0]["attrs"]["src"] == relative
    receipt = await receipt_for(db_session, saved["id"])
    assert getattr(receipt, "published_note_revision_sha256", None) == note_revision(saved)
    assert note_revision(saved) != note_revision({**saved, "content": json.dumps(document)})


@pytest.mark.parametrize("field,value", [
    ("title", "Changed title"),
    ("content", '{"type":"doc","content":[{"type":"paragraph"}]}'),
    ("kind", "plan"),
    ("pinned", True),
])
async def test_revision_detects_each_canonical_field_change_at_the_same_timestamp(
    field, value, owner, db_session, test_workspace, test_board, publication
):
    _, saved = publication
    note = await db_session.get(Note, uuid.UUID(saved["id"]))
    original_timestamp = note.updated_at
    await db_session.execute(
        update(Note).where(Note.id == note.id)
        .values(**{field: value, "updated_at": original_timestamp})
    )
    inspected = await inspect_revision(owner, test_workspace, test_board, saved["id"])
    assert inspected["comparison"] == "differs"
    assert inspected["published_revision_sha256"] == note_revision(saved)
    assert inspected["current_revision_sha256"] == note_revision({**saved, field: value})
    assert note.updated_at == original_timestamp


async def test_timestamp_and_card_link_do_not_change_the_note_revision(
    owner, db_session, test_workspace, test_board, test_card, publication
):
    _, saved = publication
    note = await db_session.get(Note, uuid.UUID(saved["id"]))
    await db_session.execute(update(Note).where(Note.id == note.id).values(
        card_id=test_card.id, updated_at=note.updated_at + timedelta(days=1)
    ))
    inspected = await inspect_revision(owner, test_workspace, test_board, saved["id"])
    assert inspected["comparison"] == "matches"
    assert inspected["current_revision_sha256"] == note_revision(saved)


async def test_json_ordering_and_exact_restore_match_the_publication_revision(
    owner, db_session, test_workspace, test_board, publication
):
    _, saved = publication
    note_id = uuid.UUID(saved["id"])
    await db_session.execute(update(Note).where(Note.id == note_id).values(title="Edited"))
    changed = await inspect_revision(owner, test_workspace, test_board, saved["id"])
    assert changed["comparison"] == "differs"
    reordered = json.dumps(json.loads(saved["content"]), sort_keys=True, indent=2)
    assert reordered != saved["content"]
    await db_session.execute(update(Note).where(Note.id == note_id).values(
        title=saved["title"], content=reordered
    ))
    restored = await inspect_revision(owner, test_workspace, test_board, saved["id"])
    assert restored["comparison"] == "matches"
    assert restored["published_revision_sha256"] == changed["published_revision_sha256"]
    assert restored["current_revision_sha256"] == note_revision(saved)


@pytest.mark.parametrize("version,digest,status", [
    (None, None, "revision_not_recorded"),
    (None, "a" * 64, "revision_not_recorded"),
    (1, None, "revision_not_recorded"),
    (1, "not-a-sha256", "revision_not_recorded"),
    (1, "g" * 64, "revision_not_recorded"),
    (99, "a" * 64, "unsupported_version"),
])
async def test_legacy_incomplete_and_unknown_revisions_are_not_compared(
    version, digest, status, owner, db_session, test_workspace, test_board, publication
):
    _, saved = publication
    # First establish a working positive seam; a missing route is a causal red.
    await inspect_revision(owner, test_workspace, test_board, saved["id"])
    receipt = await receipt_for(db_session, saved["id"])
    receipt.published_note_revision_sha256 = digest
    receipt.published_note_revision_version = version
    await db_session.flush()
    inspected = await inspect_revision(owner, test_workspace, test_board, saved["id"])
    assert inspected["status"] == status
    assert inspected["current_revision_sha256"] is None
    assert inspected["comparison"] is None
    assert inspected["comparison_reason"] is None
    assert inspected["recorded_at"] is not None


async def test_own_ordinary_note_has_no_publication_record(
    owner, test_workspace, test_board
):
    created = await owner.post(board_notes(test_workspace, test_board), json={
        "title": "Ordinary note", "content": "Saved normally",
    })
    assert created.status_code == 201, created.text
    inspected = await inspect_revision(owner, test_workspace, test_board, created.json()["id"])
    assert inspected == {key: "no_record" if key == "status" else None for key in REVISION_FIELDS}


@pytest.mark.parametrize("read_only", ["viewer", "frozen"])
async def test_publication_inspection_requires_read_permission_not_write_permission(
    read_only, owner, db_session, test_user, test_workspace, test_board, publication
):
    _, saved = publication
    if read_only == "viewer":
        await db_session.execute(update(WorkspaceMember).where(
            WorkspaceMember.user_id == test_user.id,
            WorkspaceMember.workspace_id == test_workspace.id,
        ).values(role=WorkspaceRole.viewer))
    else:
        await db_session.execute(update(Board).where(Board.id == test_board.id).values(is_frozen=True))
    assert (await owner.get(f"{board_notes(test_workspace, test_board)}/{saved['id']}")).status_code == 200
    inspected = await inspect_revision(owner, test_workspace, test_board, saved["id"])
    assert inspected["comparison"] == "matches"


async def test_another_note_owner_cannot_observe_whether_a_publication_receipt_exists(
    owner, db_session, second_user, test_workspace, test_board, publication
):
    _, saved = publication
    ordinary = await owner.post(board_notes(test_workspace, test_board), json={
        "title": "Ordinary", "content": "Shared",
    })
    assert ordinary.status_code == 201
    await add_member(db_session, test_workspace, second_user)
    # The owner-positive control prevents a missing endpoint from proving privacy.
    await inspect_revision(owner, test_workspace, test_board, saved["id"])
    async with as_principal(db_session, second_user) as reader:
        responses = []
        for note_id in (saved["id"], ordinary.json()["id"], str(uuid.uuid4())):
            if note_id in (saved["id"], ordinary.json()["id"]):
                assert (await reader.get(f"{board_notes(test_workspace, test_board)}/{note_id}")).status_code == 200
            response = await reader.get(publication_revision_path(test_workspace, test_board, note_id))
            assert response.status_code == 404
            responses.append(response.json())
        assert responses[0] == responses[1] == responses[2]


async def test_agent_and_companion_keys_cannot_inspect_the_owners_publication(
    owner, agent_client, installation_key_client, test_workspace, test_board, publication
):
    _, saved = publication
    await inspect_revision(owner, test_workspace, test_board, saved["id"])
    for client in (agent_client, installation_key_client):
        response = await client.get(publication_revision_path(test_workspace, test_board, saved["id"]))
        assert response.status_code == 403, response.text
        assert saved["id"] not in response.text


async def test_personal_owner_key_can_inspect_a_publication(
    plain_key_client, test_workspace, test_board, publication
):
    _, saved = publication
    inspected = await inspect_revision(plain_key_client, test_workspace, test_board, saved["id"])
    assert inspected["comparison"] == "matches"


@pytest.mark.parametrize("source_loss", ["deleted", "membership"])
async def test_cross_workspace_inspection_and_retry_need_no_remaining_source_access(
    source_loss, owner, client, db_session, test_user, test_workspace, source, monkeypatch
):
    destination, board = await second_workspace(db_session, test_user)
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    url = f"{board_notes(destination, board)}/from-excerpt"
    created = await owner.post(url, json=payload)
    assert created.status_code == 201, created.text
    saved = created.json()
    if source_loss == "deleted":
        assert (await client.delete(sessions_path(test_workspace, source["session_id"]))).status_code == 204
    else:
        await db_session.execute(delete(WorkspaceMember).where(
            WorkspaceMember.workspace_id == test_workspace.id,
            WorkspaceMember.user_id == test_user.id,
        ))
    selected_tables = []

    def reject_content_store_access(*args, **kwargs):
        pytest.fail("Publication inspection and replay must not inspect capture storage")

    for method in ("stat", "read", "iter_bytes"):
        monkeypatch.setattr(LocalContentStore, method, reject_content_store_access)

    def observe(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            selected_tables.append(statement.lower())

    engine = db_session.bind.sync_engine
    event.listen(engine, "before_cursor_execute", observe)
    try:
        inspected = await inspect_revision(owner, destination, board, saved["id"])
        retry = await owner.post(url, json=payload)
    finally:
        event.remove(engine, "before_cursor_execute", observe)
    assert retry.status_code == 200, retry.text
    assert retry.json() == saved
    assert inspected["comparison"] == "matches"
    assert inspected["published_revision_sha256"] == note_revision(saved)
    assert not any("agent_session" in sql for sql in selected_tables)
    assert str(source["session_id"]) not in json.dumps(inspected)
    assert str(test_workspace.id) not in json.dumps(inspected)


async def test_edited_note_replay_preserves_the_original_publication_revision(
    owner, db_session, test_workspace, test_board, publication
):
    payload, saved = publication
    note_id = uuid.UUID(saved["id"])
    await db_session.execute(update(Note).where(Note.id == note_id).values(title="Later edit"))
    replayed = await owner.post(f"{board_notes(test_workspace, test_board)}/from-excerpt", json=payload)
    assert replayed.status_code == 200, replayed.text
    assert replayed.json()["title"] == "Later edit"
    inspected = await inspect_revision(owner, test_workspace, test_board, saved["id"])
    assert inspected["comparison"] == "differs"
    assert inspected["published_revision_sha256"] == note_revision(saved)
    assert inspected["current_revision_sha256"] == note_revision(replayed.json())
    conflict = await owner.post(f"{board_notes(test_workspace, test_board)}/from-excerpt", json={
        **payload, "title": "Later edit",
    })
    assert conflict.status_code == 409, conflict.text


async def test_deleted_note_leaves_no_inspectable_revision_and_retry_does_not_resurrect_it(
    owner, db_session, test_workspace, test_board, publication
):
    payload, saved = publication
    await inspect_revision(owner, test_workspace, test_board, saved["id"])
    receipt = await receipt_for(db_session, saved["id"])
    receipt_id = receipt.id
    assert (await owner.delete(f"{board_notes(test_workspace, test_board)}/{saved['id']}")).status_code == 204
    assert (await owner.get(publication_revision_path(test_workspace, test_board, saved["id"]))).status_code == 404
    retried = await owner.post(f"{board_notes(test_workspace, test_board)}/from-excerpt", json=payload)
    assert retried.status_code == 410, retried.text
    await db_session.refresh(receipt)
    assert receipt.id == receipt_id
    assert receipt.note_id is None
    assert receipt.published_note_revision_sha256 == note_revision(saved)


@pytest.mark.parametrize("denied", ["membership", "board", "workspace"])
async def test_http_inspection_rechecks_current_destination_scope(
    denied, owner, db_session, test_user, test_workspace, test_board, publication
):
    _, saved = publication
    await inspect_revision(owner, test_workspace, test_board, saved["id"])
    workspace, board = test_workspace, test_board
    if denied == "membership":
        await db_session.execute(delete(WorkspaceMember).where(
            WorkspaceMember.workspace_id == test_workspace.id,
            WorkspaceMember.user_id == test_user.id,
        ))
    elif denied == "board":
        board = Board(
            workspace_id=test_workspace.id, name="Other board", slug="other-board",
            created_by=test_user.id,
        )
        db_session.add(board)
        await db_session.flush()
    else:
        workspace, board = await second_workspace(db_session, test_user)
    response = await owner.get(publication_revision_path(workspace, board, saved["id"]))
    assert response.status_code == (403 if denied == "membership" else 404), response.text
    assert saved["id"] not in response.text
    assert note_revision(saved) not in response.text


async def test_inspection_preserves_shared_note_export_context_selection_and_link_counts(
    owner, db_session, second_user, test_workspace, test_board, test_card, source
):
    url = board_notes(test_workspace, test_board)
    created = await owner.post(f"{url}/from-excerpt", json=excerpt_save(
        test_workspace, source["session_id"], source["items"], card_id=str(test_card.id),
    ))
    assert created.status_code == 201, created.text
    saved = created.json()
    assert set(saved) == {
        "id", "workspace_id", "board_id", "card_id", "title", "content", "pinned",
        "kind", "failure_class", "findings", "source_execution_id", "created_by",
        "created_at", "updated_at",
        "history_revision", "revision_digest", "applied_revision", "changed", "replayed",
    }
    assert saved["history_revision"] == 1
    assert isinstance(saved["revision_digest"], str)
    assert len(saved["revision_digest"]) == 64
    assert set(saved["revision_digest"]) <= set("0123456789abcdef")
    assert saved["applied_revision"] is None
    assert saved["changed"] is None
    assert saved["replayed"] is None
    before_export = await owner.get(f"{url}/export")
    assert before_export.status_code == 200, before_export.text
    before_markdown = await owner.get(f"{url}/{saved['id']}?format=markdown")
    assert before_markdown.status_code == 200, before_markdown.text
    repository = NoteRepository(db_session)
    before_selected = await repository.list_by_card(test_card.id, test_workspace.id)
    assert [str(note.id) for note in before_selected] == [saved["id"]]
    before_kind_selected = await repository.list_card_notes_by_kind(
        test_card.id, test_workspace.id, "user_note"
    )
    assert [str(note.id) for note in before_kind_selected] == [saved["id"]]
    inspected = await inspect_revision(owner, test_workspace, test_board, saved["id"])
    assert inspected["comparison"] == "matches"
    await add_member(db_session, test_workspace, second_user)
    async with as_principal(db_session, second_user) as reader:
        shared = await reader.get(f"{url}/{saved['id']}")
        assert shared.status_code == 200, shared.text
        assert shared.json() == saved
    after_export = await owner.get(f"{url}/export")
    assert after_export.status_code == 200
    assert after_export.json()["data"] == before_export.json()["data"]
    after_markdown = await owner.get(f"{url}/{saved['id']}?format=markdown")
    assert after_markdown.json() == before_markdown.json()
    assert [str(note.id) for note in await repository.list_by_card(
        test_card.id, test_workspace.id
    )] == [saved["id"]]
    assert [str(note.id) for note in await repository.list_card_notes_by_kind(
        test_card.id, test_workspace.id, "user_note"
    )] == [saved["id"]]
    for model in (SessionWorkLink, MCPInvocation, MCPConsultation, ExecutionContextReceipt):
        assert await db_session.scalar(select(func.count()).select_from(model)) == 0


def assert_no_http_storage(response):
    directives = {
        value.strip().lower()
        for value in response.headers.get("cache-control", "").split(",")
    }
    assert "no-store" in directives, "Private publication responses must bypass HTTP storage"
    assert "public" not in directives


async def test_publication_revision_success_disallows_http_storage(
    owner, test_workspace, test_board, publication
):
    _, saved = publication
    response = await owner.get(publication_revision_path(test_workspace, test_board, saved["id"]))
    assert response.status_code == 200, response.text
    assert response.json()["comparison"] == "matches"
    assert response.json()["published_revision_sha256"] == note_revision(saved)
    assert_no_http_storage(response)


@pytest.mark.parametrize("denied", ["removed-membership", "another-owner", "missing-note"])
async def test_publication_revision_denial_disallows_http_storage(
    denied, owner, db_session, test_user, second_user, test_workspace, test_board, publication
):
    _, saved = publication
    await inspect_revision(owner, test_workspace, test_board, saved["id"])
    path = publication_revision_path(test_workspace, test_board, saved["id"])
    if denied == "removed-membership":
        await db_session.execute(delete(WorkspaceMember).where(
            WorkspaceMember.workspace_id == test_workspace.id,
            WorkspaceMember.user_id == test_user.id,
        ))
        response = await owner.get(path)
    elif denied == "another-owner":
        await add_member(db_session, test_workspace, second_user)
        async with as_principal(db_session, second_user) as reader:
            response = await reader.get(path)
    else:
        response = await owner.get(publication_revision_path(test_workspace, test_board, uuid.uuid4()))
    assert response.status_code == (403 if denied == "removed-membership" else 404), response.text
    assert note_revision(saved) not in response.text
    assert_no_http_storage(response)


async def test_publication_revision_validation_error_is_private_and_redacted(
    owner, test_workspace, test_board, publication
):
    _, saved = publication
    await inspect_revision(owner, test_workspace, test_board, saved["id"])
    invalid_id = "synthetic-private-note-reference"
    response = await owner.get(publication_revision_path(test_workspace, test_board, invalid_id))
    assert response.status_code == 422, response.text
    assert_no_http_storage(response)
    assert invalid_id not in response.text
    assert response.json()["detail"] == "Invalid request"
    assert response.json()["error_code"] == "validation_error"


async def test_publication_presence_distinguishes_recorded_and_ordinary_notes_without_reading_or_hashing_body(
    owner, db_session, test_workspace, test_board, publication, monkeypatch
):
    _, saved = publication
    ordinary = await owner.post(board_notes(test_workspace, test_board), json={
        "title": "Ordinary note", "content": "Saved normally without handoff",
    })
    assert ordinary.status_code == 201, ordinary.text
    ordinary_id = ordinary.json()["id"]
    receipt = await receipt_for(db_session, saved["id"])

    def fail_on_note_revision(*args, **kwargs):
        pytest.fail("Publication presence must not compute or hash note revisions")

    async def fail_on_revision_fields(*args, **kwargs):
        pytest.fail("Publication presence must not read note body or revision fields")

    monkeypatch.setattr("app.services.notes.note.note_revision", fail_on_note_revision)
    monkeypatch.setattr(NoteRepository, "get_revision_fields", fail_on_revision_fields)

    selected_statements = []

    def observe(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            selected_statements.append(statement.lower())

    engine = db_session.bind.sync_engine
    event.listen(engine, "before_cursor_execute", observe)
    try:
        present = await inspect_presence(owner, test_workspace, test_board, saved["id"])
        absent = await inspect_presence(owner, test_workspace, test_board, ordinary_id)
    finally:
        event.remove(engine, "before_cursor_execute", observe)

    assert present["has_record"] is True
    assert datetime.fromisoformat(present["recorded_at"]).replace(
        tzinfo=None
    ) == receipt.created_at.replace(tzinfo=None)
    assert absent == {"has_record": False, "recorded_at": None}
    assert not any("notes.content" in sql or "octet_length" in sql for sql in selected_statements)


@pytest.mark.parametrize("version,digest", [
    (None, None),
    (1, None),
    (99, "a" * 64),
])
async def test_publication_presence_reports_legacy_or_unsupported_receipt_record_without_inventing_diff(
    version, digest, owner, db_session, test_workspace, test_board, publication
):
    _, saved = publication
    receipt = await receipt_for(db_session, saved["id"])
    receipt.published_note_revision_sha256 = digest
    receipt.published_note_revision_version = version
    await db_session.flush()

    presence = await inspect_presence(owner, test_workspace, test_board, saved["id"])
    assert presence["has_record"] is True
    assert presence["recorded_at"] is not None

    inspected = await inspect_revision(owner, test_workspace, test_board, saved["id"])
    assert inspected["comparison"] is None
    assert inspected["current_revision_sha256"] is None


async def test_publication_presence_enforces_author_only_credential_scope_and_private_no_store_boundaries(
    owner,
    agent_client,
    installation_key_client,
    plain_key_client,
    db_session,
    test_user,
    second_user,
    test_workspace,
    test_board,
    publication,
):
    _, saved = publication
    ordinary = await owner.post(board_notes(test_workspace, test_board), json={
        "title": "Shared ordinary", "content": "Shared content",
    })
    assert ordinary.status_code == 201, ordinary.text
    ordinary_id = ordinary.json()["id"]

    owner_response = await owner.get(publication_presence_path(test_workspace, test_board, saved["id"]))
    assert owner_response.status_code == 200, owner_response.text
    assert owner_response.json()["has_record"] is True
    assert_no_http_storage(owner_response)

    key_presence = await inspect_presence(plain_key_client, test_workspace, test_board, saved["id"])
    assert key_presence["has_record"] is True

    for client in (agent_client, installation_key_client):
        denied_key = await client.get(publication_presence_path(test_workspace, test_board, saved["id"]))
        assert denied_key.status_code == 403, denied_key.text
        assert saved["id"] not in denied_key.text
        assert_no_http_storage(denied_key)

    await add_member(db_session, test_workspace, second_user)
    async with as_principal(db_session, second_user) as reader:
        other_responses = []
        for note_id in (saved["id"], ordinary_id, str(uuid.uuid4())):
            res = await reader.get(publication_presence_path(test_workspace, test_board, note_id))
            assert res.status_code == 404, res.text
            assert_no_http_storage(res)
            other_responses.append(res.json())
        assert other_responses[0] == other_responses[1] == other_responses[2]

    invalid_id = "synthetic-private-presence-reference"
    invalid_res = await owner.get(publication_presence_path(test_workspace, test_board, invalid_id))
    assert invalid_res.status_code == 422, invalid_res.text
    assert_no_http_storage(invalid_res)
    assert invalid_id not in invalid_res.text

    other_board = Board(
        workspace_id=test_workspace.id, name="Wrong board", slug="wrong-board", created_by=test_user.id,
    )
    db_session.add(other_board)
    await db_session.flush()
    wrong_board = await owner.get(publication_presence_path(test_workspace, other_board, saved["id"]))
    assert wrong_board.status_code == 404, wrong_board.text
    assert_no_http_storage(wrong_board)

    await db_session.execute(delete(WorkspaceMember).where(
        WorkspaceMember.workspace_id == test_workspace.id,
        WorkspaceMember.user_id == test_user.id,
    ))
    revoked = await owner.get(publication_presence_path(test_workspace, test_board, saved["id"]))
    assert revoked.status_code == 403, revoked.text
    assert_no_http_storage(revoked)


async def test_ordinary_ui_and_mcp_note_mutations_do_not_create_publication_receipts(
    owner, db_session, test_workspace, test_board
):
    base = board_notes(test_workspace, test_board)
    created = await owner.post(base, json={
        "title": "Routine note", "content": "## Status\n\nInitial body",
    })
    assert created.status_code == 201, created.text
    note_id = created.json()["id"]

    updated = await owner.put(f"{base}/{note_id}", json={
        "title": "Routine note edited", "pinned": True,
    })
    assert updated.status_code == 200, updated.text

    appended = await owner.post(f"{base}/{note_id}/append", json={
        "content": "Appended paragraph",
    })
    assert appended.status_code == 200, appended.text

    replaced = await owner.post(f"{base}/{note_id}/replace-section", json={
        "anchor_heading": "Status", "content": "Updated status section",
    })
    assert replaced.status_code == 200, replaced.text

    receipt_count = await db_session.scalar(
        select(func.count()).select_from(NoteSaveReceipt).where(
            NoteSaveReceipt.note_id == uuid.UUID(note_id)
        )
    )
    assert receipt_count == 0
    presence = await inspect_presence(owner, test_workspace, test_board, note_id)
    assert presence == {"has_record": False, "recorded_at": None}


async def test_workspace_route_mutations_on_board_note_record_actual_note_board_id_in_activity(
    owner, db_session, test_workspace, test_board, monkeypatch
):
    from app.models.activity import Activity, ActivityEntityType
    from app.services import activity as activity_service_module

    published_events = []
    original_queue = activity_service_module.queue_until_commit

    def spy_queue(db, event_type, payload, workspace_id):
        published_events.append((event_type, payload, workspace_id))
        return original_queue(db, event_type, payload, workspace_id)

    monkeypatch.setattr(activity_service_module, "queue_until_commit", spy_queue)

    created = await owner.post(board_notes(test_workspace, test_board), json={
        "title": "Board note edited via workspace route",
        "content": "## Progress\n\nInitial progress",
    })
    assert created.status_code == 201, created.text
    note_id = created.json()["id"]
    ws_url = f"{workspace_notes(test_workspace)}/{note_id}"

    assert (await owner.put(ws_url, json={"pinned": True})).status_code == 200
    assert (await owner.post(f"{ws_url}/append", json={"content": "More details"})).status_code == 200
    assert (await owner.post(f"{ws_url}/replace-section", json={
        "anchor_heading": "Progress", "content": "Replaced progress",
    })).status_code == 200
    assert (await owner.delete(ws_url)).status_code == 204

    rows = (
        await db_session.execute(
            select(Activity.message_key, Activity.board_id)
            .where(
                Activity.entity_type == ActivityEntityType.note,
                Activity.entity_id == uuid.UUID(note_id),
            )
            .order_by(Activity.created_at)
        )
    ).all()
    by_key = {message_key: board_id for message_key, board_id in rows}
    for key in (
        "activity.note.updated",
        "activity.note.appended",
        "activity.note.section_replaced",
        "activity.note.deleted",
    ):
        assert by_key.get(key) == test_board.id, f"{key} omitted or misattributed the note's board_id"

    note_events = [event for event in published_events if event[1].get("entity_id") == note_id]
    assert len(note_events) == 5
    for event_type, payload, workspace_id in note_events:
        assert workspace_id == test_workspace.id
        assert payload["board_id"] == str(test_board.id), f"{event_type} omitted the note's board_id"
