# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Saving a reviewed session excerpt as an ordinary board or card note.

The owner posts the exact reviewed ProseMirror document to the existing note
routes, plus `client_request_id` and an `excerpt_source` naming the source
workspace, session and each selected content id with its expected sha256.
The response is the plain `NoteRead`. The server authorizes the destination
first, then (for a fresh save) the source through the owner-only captured
content rules, and never regenerates the document from the source.

A receipt per (principal, client_request_id) makes the save retryable: an
identical retry returns the same note, a changed payload is a 409, and a
deleted note leaves a tombstone (410) instead of being resurrected.

Requests run inside a SAVEPOINT that rolls back on error, as `get_db` rolls
back the request transaction, so row counts after a refusal show what a real
request would have left behind. Synthetic data only."""

import json
import uuid
from contextlib import asynccontextmanager

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, func, select, update

from app.core.auth import get_current_user
from app.database import get_db
from app.main import create_app
from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.agent_session import AgentSession, AgentSessionContent, SessionWorkLink
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.notes.note import Note
from app.models.notifications.notification import Notification
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.schemas.notes.note import NoteRead
from app.services.notes.content_normalizer import normalize_note_content
from app.services.storage.session_content import content_store
from tests.rich_capture import (
    PNG,
    declaration,
    declare_and_upload,
    enroll_rich,
    ingest,
    only_session,
    rich_record,
    sessions_path,
)

pytestmark = pytest.mark.usefixtures("content_storage")

# The selected-body bound the session excerpt UI already enforces (SUMMIT02).
SELECTED_BODY_LIMIT_BYTES = 2 << 20
# 2 MiB of captured control bytes can require 12 MiB of JSON escapes; room
# remains for visible provenance/owner edits. This is not a context budget.
REVIEWED_DOCUMENT_LIMIT_BYTES = 16 << 20
SELECTED_ITEM_LIMIT = 256


def canonical_document_bytes(doc) -> bytes:
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


# Shape checks the NoteCreate schema can make alone answer FastAPI's
# `request_validation_error`; checks that need the route or the database
# answer the service's `validation_error`.
SCHEMA_REJECTED = "request_validation_error"
SERVICE_REJECTED = "validation_error"


def board_notes(workspace, board) -> str:
    return f"/api/workspaces/{workspace.slug}/boards/{board.id}/notes"


@asynccontextmanager
async def as_principal(db_session, user):
    """A client for `user` whose requests roll back on error, like `get_db`."""
    app = create_app()

    async def request_transaction():
        savepoint = await db_session.begin_nested()
        try:
            yield db_session
        except Exception:
            await savepoint.rollback()
            raise
        if savepoint.is_active:
            await savepoint.commit()

    async def current_user():
        return user

    app.dependency_overrides[get_db] = request_transaction
    app.dependency_overrides[get_current_user] = current_user
    async with AsyncClient(
        transport=ASGITransport(app), base_url="http://test"
    ) as principal:
        yield principal


async def add_member(db_session, workspace, user, role=WorkspaceRole.member):
    db_session.add(
        WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role=role)
    )
    await db_session.flush()


async def captured_items(client, device_client, db_session, workspace, board, bodies):
    """Ingest `bodies` (bytes, or a ready declaration) into one rich session
    and return (session_id, the owner's content reads in source order)."""
    enrolled = await enroll_rich(client, device_client, db_session, workspace, board)
    declared = [
        body if isinstance(body, dict) else declaration(body, order=index)
        for index, body in enumerate(bodies, start=1)
    ]
    await ingest(
        device_client, enrolled, [rich_record(enrolled["mapping_id"], declared)]
    )
    session = await only_session(db_session)
    listed = await client.get(f"{sessions_path(workspace, session.id)}/contents")
    assert listed.status_code == 200, listed.text
    return session.id, listed.json()["items"]


def selected(items) -> list[dict]:
    return [{"content_id": item["id"], "sha256": item["sha256"]} for item in items]


def reviewed_document(texts, *, mention=None) -> dict:
    """What the review UI builds: provenance, each selected body as a literal
    code block, and an optional mention."""
    blocks = [
        {
            "type": "paragraph",
            "content": [
                {
                    "type": "text",
                    "text": "Selected evidence from a private session; "
                    "1 secret replaced by the capture filter; not a full transcript.",
                }
            ],
        }
    ]
    blocks += [
        {"type": "codeBlock", "content": [{"type": "text", "text": text}]}
        for text in texts
    ]
    if mention is not None:
        blocks.append(
            {
                "type": "paragraph",
                "content": [
                    {
                        "type": "mention",
                        "attrs": {"id": str(mention.id), "label": mention.name},
                    }
                ],
            }
        )
    return {"type": "doc", "content": blocks}


def excerpt_save(workspace, session_id, items, **overrides) -> dict:
    payload = {
        "title": "Reviewed handoff",
        "content": reviewed_document(["synthetic body"]),
        "client_request_id": str(uuid.uuid4()),
        "excerpt_source": {
            "workspace_id": str(workspace.id),
            "session_id": str(session_id),
            "items": selected(items),
        },
    }
    payload.update(overrides)
    return payload


async def note_count(db_session, workspace=None) -> int:
    query = select(func.count()).select_from(Note)
    if workspace is not None:
        query = query.where(Note.workspace_id == workspace.id)
    return await db_session.scalar(query)


async def created_activity_count(db_session) -> int:
    return await db_session.scalar(
        select(func.count())
        .select_from(Activity)
        .where(
            Activity.entity_type == ActivityEntityType.note,
            Activity.action == ActivityAction.created,
        )
    )


async def mention_count(db_session, user) -> int:
    return await db_session.scalar(
        select(func.count())
        .select_from(Notification)
        .where(Notification.category == "mention", Notification.recipient_user_id == user.id)
    )


@pytest.fixture
async def owner(db_session, test_user):
    async with as_principal(db_session, test_user) as principal:
        yield principal


@pytest.fixture
async def source(client, device_client, db_session, test_workspace, test_board):
    """Two captured text items in the owner's session, in the destination
    workspace."""
    session_id, items = await captured_items(
        client,
        device_client,
        db_session,
        test_workspace,
        test_board,
        [b"first selected body", b"second selected body"],
    )
    return {"session_id": session_id, "items": items}


async def second_workspace(db_session, test_user, role=WorkspaceRole.member):
    workspace = Workspace(
        name="Destination", slug="destination", created_by=test_user.id
    )
    db_session.add(workspace)
    await db_session.flush()
    await add_member(db_session, workspace, test_user, role)
    board = Board(
        workspace_id=workspace.id,
        name="Destination board",
        slug="destination-board",
        created_by=test_user.id,
    )
    db_session.add(board)
    await db_session.flush()
    return workspace, board


# --- request shape --------------------------------------------------------------


async def test_generic_note_create_without_excerpt_fields_still_works(
    owner, db_session, test_workspace, test_board, test_card
):
    """Control: today's NoteCreate keeps working unchanged, Markdown included."""
    response = await owner.post(
        board_notes(test_workspace, test_board),
        json={"title": "Plain", "content": "# Heading", "card_id": str(test_card.id)},
    )
    assert response.status_code == 201, response.text
    assert set(response.json()) == set(NoteRead.model_fields)
    assert json.loads(response.json()["content"])["content"][0]["type"] == "heading"
    assert response.json()["pinned"] is False


async def test_excerpt_save_returns_plain_note_read_with_the_exact_reviewed_doc(
    owner, db_session, test_workspace, test_board, test_card, source
):
    """Control: the response is today's NoteRead (no source fields), the note
    is an unpinned user_note on the card, and the stored document is exactly
    the reviewed one, owner edits and provenance text included."""
    edited = reviewed_document(
        ["first selected body, trimmed by the owner", "<script>literal</script>"]
    )
    response = await owner.post(
        board_notes(test_workspace, test_board),
        json=excerpt_save(
            test_workspace,
            source["session_id"],
            source["items"],
            content=edited,
            card_id=str(test_card.id),
        ),
    )
    assert response.status_code == 201, response.text
    saved = response.json()
    assert set(saved) == set(NoteRead.model_fields)
    assert (saved["kind"], saved["pinned"], saved["card_id"]) == (
        "user_note",
        False,
        str(test_card.id),
    )
    assert json.loads(saved["content"]) == json.loads(normalize_note_content(edited))


@pytest.mark.parametrize(
    "broken",
    [
        pytest.param({"client_request_id": None}, id="no-client-request-id"),
        pytest.param({"items": []}, id="no-items"),
        pytest.param({"duplicate": True}, id="duplicate-item"),
        pytest.param({"sha256": "not-a-digest"}, id="malformed-sha256"),
        pytest.param({"session_id": None}, id="no-session"),
    ],
)
async def test_a_malformed_excerpt_source_is_a_schema_422_and_saves_nothing(
    broken, owner, db_session, test_workspace, test_board, source
):
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    excerpt = payload["excerpt_source"]
    if "client_request_id" in broken:
        del payload["client_request_id"]
    if "items" in broken:
        excerpt["items"] = []
    if "duplicate" in broken:
        excerpt["items"] = excerpt["items"][:1] * 2
    if "sha256" in broken:
        excerpt["items"][0]["sha256"] = broken["sha256"]
    if "session_id" in broken:
        del excerpt["session_id"]
    response = await owner.post(board_notes(test_workspace, test_board), json=payload)
    assert response.status_code == 422, response.text
    assert response.json()["error_code"] == SCHEMA_REJECTED
    assert await note_count(db_session) == 0


@pytest.mark.parametrize(
    "field",
    [
        pytest.param({"kind": "review_verdict"}, id="review-verdict-kind"),
        pytest.param({"kind": "plan"}, id="other-kind"),
        pytest.param({"pinned": True}, id="pinned"),
        pytest.param({"failure_class": "LOGIC"}, id="failure-class"),
        pytest.param(
            {"findings": [{"severity": "SHOULD_FIX", "message": "x"}]}, id="findings"
        ),
        pytest.param({"source_execution_id": "real"}, id="execution"),
    ],
)
async def test_an_excerpt_save_is_only_ever_an_unpinned_user_note(
    field, owner, db_session, test_workspace, test_board, test_agent, source
):
    """An excerpt cannot become a verdict, plan, pinned or machine note; the
    UI sends kind/pinned at their defaults, which stay accepted."""
    if field.get("source_execution_id") == "real":
        execution = AgentExecution(
            agent_id=test_agent.id,
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            action="synthetic",
            status=ExecutionStatus.completed,
        )
        db_session.add(execution)
        await db_session.flush()
        field = {"source_execution_id": str(execution.id)}
    response = await owner.post(
        board_notes(test_workspace, test_board),
        json=excerpt_save(
            test_workspace, source["session_id"], source["items"], **field
        ),
    )
    assert response.status_code == 422, response.text
    assert response.json()["error_code"] == SCHEMA_REJECTED
    assert await note_count(db_session) == 0

    defaults = await owner.post(
        board_notes(test_workspace, test_board),
        json=excerpt_save(
            test_workspace,
            source["session_id"],
            source["items"],
            kind="user_note",
            pinned=False,
        ),
    )
    assert defaults.status_code == 201, defaults.text


@pytest.mark.parametrize(
    "content",
    [
        pytest.param("<pre>captured</pre>\n# Forged heading", id="html-string"),
        pytest.param("```\ncaptured\n```", id="markdown-string"),
        pytest.param({"type": "doc", "content": []}, id="empty-doc"),
    ],
)
async def test_an_excerpt_save_requires_a_structured_non_empty_document(
    content, owner, db_session, test_workspace, test_board, source
):
    """Captured text reaches the server only inside a reviewed PM document;
    a string is never reinterpreted as Markdown or HTML for an excerpt."""
    response = await owner.post(
        board_notes(test_workspace, test_board),
        json=excerpt_save(
            test_workspace, source["session_id"], source["items"], content=content
        ),
    )
    assert response.status_code == 422, response.text
    assert response.json()["error_code"] == SCHEMA_REJECTED
    assert await note_count(db_session) == 0


async def test_an_excerpt_save_needs_a_board_destination(
    owner, db_session, test_workspace, source
):
    response = await owner.post(
        f"/api/workspaces/{test_workspace.slug}/notes",
        json=excerpt_save(test_workspace, source["session_id"], source["items"]),
    )
    # The board can come from the path or the body, so only the service knows.
    assert response.status_code == 422, response.text
    assert response.json()["error_code"] == SERVICE_REJECTED
    assert await note_count(db_session) == 0


# --- destination authorization ---------------------------------------------------


@pytest.mark.parametrize("guard", ["viewer", "foreign-board", "foreign-card", "frozen"])
async def test_destination_guards_still_refuse_an_excerpt_save(
    guard,
    owner,
    db_session,
    test_user,
    test_workspace,
    test_board,
    test_card,
    source,
):
    """Control: the existing destination rules apply unchanged."""
    other, other_board = await second_workspace(db_session, test_user)
    url = board_notes(test_workspace, test_board)
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    expected = {"viewer": 403, "foreign-board": 404, "foreign-card": 422, "frozen": 409}
    if guard == "viewer":
        await db_session.execute(
            update(WorkspaceMember)
            .where(WorkspaceMember.workspace_id == other.id)
            .values(role=WorkspaceRole.viewer)
        )
        url = board_notes(other, other_board)
    elif guard == "foreign-board":
        url = f"/api/workspaces/{test_workspace.slug}/boards/{other_board.id}/notes"
    elif guard == "foreign-card":
        sibling = Board(
            workspace_id=test_workspace.id,
            name="Sibling",
            slug="sibling",
            created_by=test_user.id,
        )
        db_session.add(sibling)
        await db_session.flush()
        stray = Card(
            board_id=sibling.id,
            column_id=test_card.column_id,
            title="On the sibling board",
            position=1.0,
            created_by=test_user.id,
        )
        db_session.add(stray)
        await db_session.flush()
        payload["card_id"] = str(stray.id)
    else:
        await db_session.execute(
            update(Board).where(Board.id == test_board.id).values(is_frozen=True)
        )
    await db_session.flush()
    response = await owner.post(url, json=payload)
    assert response.status_code == expected[guard], response.text
    assert await note_count(db_session) == 0


async def test_cross_workspace_save_needs_current_source_membership(
    owner, db_session, test_user, test_workspace, source
):
    destination, destination_board = await second_workspace(db_session, test_user)
    url = board_notes(destination, destination_board)
    allowed = await owner.post(
        url, json=excerpt_save(test_workspace, source["session_id"], source["items"])
    )
    assert allowed.status_code == 201, allowed.text

    await db_session.execute(
        delete(WorkspaceMember).where(
            WorkspaceMember.workspace_id == test_workspace.id,
            WorkspaceMember.user_id == test_user.id,
        )
    )
    await db_session.flush()
    refused = await owner.post(
        url, json=excerpt_save(test_workspace, source["session_id"], source["items"])
    )
    assert refused.status_code == 403, refused.text
    assert await note_count(db_session, destination) == 1


# --- source authorization --------------------------------------------------------


async def test_agent_and_companion_launch_keys_cannot_publish_an_excerpt(
    agent_client,
    installation_key_client,
    db_session,
    test_workspace,
    test_board,
    source,
):
    for key_client in (agent_client, installation_key_client):
        response = await key_client.post(
            board_notes(test_workspace, test_board),
            json=excerpt_save(test_workspace, source["session_id"], source["items"]),
        )
        assert response.status_code == 403, response.text
        assert response.json()["error_code"] == "forbidden"
    assert await note_count(db_session) == 0


async def test_a_personal_api_key_publishes_like_its_person(
    plain_key_client, db_session, test_workspace, test_board, source
):
    """Control: a human's own key keeps the owner's reach."""
    response = await plain_key_client.post(
        board_notes(test_workspace, test_board),
        json=excerpt_save(test_workspace, source["session_id"], source["items"]),
    )
    assert response.status_code == 201, response.text


async def test_another_owners_session_answers_like_an_unknown_one(
    owner,
    client,
    device_client,
    db_session,
    test_workspace,
    test_board,
    second_user,
):
    await add_member(db_session, test_workspace, second_user)
    async with as_principal(db_session, second_user) as other:
        theirs = await enroll_rich(
            other, device_client, db_session, test_workspace, test_board
        )
        await ingest(
            device_client,
            theirs,
            [rich_record(theirs["mapping_id"], [declaration(b"not yours")])],
        )
        session = await only_session(db_session)
        items = (
            await other.get(f"{sessions_path(test_workspace, session.id)}/contents")
        ).json()["items"]
    url = board_notes(test_workspace, test_board)
    crossed = await owner.post(
        url, json=excerpt_save(test_workspace, session.id, items)
    )
    unknown = await owner.post(
        url, json=excerpt_save(test_workspace, uuid.uuid4(), items)
    )
    assert crossed.status_code == 404, crossed.text
    assert crossed.json() == unknown.json()
    assert await note_count(db_session) == 0


async def test_the_source_workspace_must_be_the_sessions_own(
    owner, db_session, test_user, test_workspace, test_board, source
):
    other, _ = await second_workspace(db_session, test_user)
    response = await owner.post(
        board_notes(test_workspace, test_board),
        json=excerpt_save(other, source["session_id"], source["items"]),
    )
    assert response.status_code == 404, response.text
    assert await note_count(db_session) == 0


@pytest.mark.parametrize("swap", ["unknown-id", "other-session"])
async def test_a_content_id_counts_only_under_its_own_session(
    swap,
    owner,
    client,
    device_client,
    db_session,
    test_workspace,
    test_board,
    source,
):
    items = selected(source["items"])
    if swap == "unknown-id":
        items[1]["content_id"] = str(uuid.uuid4())
    else:
        other = await enroll_rich(
            client,
            device_client,
            db_session,
            test_workspace,
            test_board,
            root="/synthetic/second",
        )
        result = await ingest(
            device_client,
            other,
            [
                rich_record(
                    other["mapping_id"], [declaration(b"same owner, other session")]
                )
            ],
        )
        items[1]["content_id"] = result["contents"][0]["content_id"]
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    payload["excerpt_source"]["items"] = items
    response = await owner.post(board_notes(test_workspace, test_board), json=payload)
    assert response.status_code == 404, response.text
    assert response.json()["error_code"] == "content_not_found"
    assert await note_count(db_session) == 0


async def test_a_stale_digest_fails_the_whole_save(
    owner, db_session, test_workspace, test_board, source
):
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    payload["excerpt_source"]["items"][1]["sha256"] = "0" * 64
    response = await owner.post(board_notes(test_workspace, test_board), json=payload)
    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "excerpt_source_stale"
    assert await note_count(db_session) == 0
    assert await created_activity_count(db_session) == 0


@pytest.mark.parametrize(
    "unavailable", ["withheld", "pending-upload", "attachment", "text-attachment"]
)
async def test_one_item_without_a_text_body_fails_the_whole_save(
    unavailable, owner, client, device_client, db_session, test_workspace, test_board
):
    enrolled = await enroll_rich(
        client, device_client, db_session, test_workspace, test_board
    )
    declared = [declaration(b"available text", order=1)]
    if unavailable == "withheld":
        declared.append(
            declaration(
                None,
                channel="instruction",
                role="system",
                order=2,
                coverage="withheld_by_policy",
                coverage_reason="harness_context",
            )
        )
    elif unavailable == "pending-upload":
        declared.append(declaration(b"w" * 20_000, delivery="upload", order=2))
    await ingest(
        device_client, enrolled, [rich_record(enrolled["mapping_id"], declared)]
    )
    if unavailable in {"attachment", "text-attachment"}:
        await declare_and_upload(
            device_client,
            enrolled,
            PNG
            if unavailable == "attachment"
            else b"A readable attachment remains excluded",
            channel="attachment",
            role="user",
            media_type="image/png" if unavailable == "attachment" else "text/plain",
            order=2,
        )
    session = await only_session(db_session)
    items = (
        await client.get(f"{sessions_path(test_workspace, session.id)}/contents")
    ).json()["items"]
    assert len(items) == 2
    payload = excerpt_save(test_workspace, session.id, items)
    payload["excerpt_source"]["items"] = [
        {"content_id": item["id"], "sha256": item["sha256"] or "0" * 64}
        for item in items
    ]
    response = await owner.post(board_notes(test_workspace, test_board), json=payload)
    assert response.status_code == 404, response.text
    assert response.json()["error_code"] == "content_not_found"
    assert await note_count(db_session) == 0


async def test_a_partially_redacted_body_may_be_published(
    owner, client, device_client, db_session, test_workspace, test_board
):
    """Control: redaction is provenance, not unavailability."""
    redacted = declaration(
        b"token=[REDACTED]",
        coverage="partially_redacted",
        coverage_reason="secret_filter",
        redaction={"filter_version": "asymptoteobserve-redact/1", "replacements": 1},
    )
    session_id, items = await captured_items(
        client, device_client, db_session, test_workspace, test_board, [redacted]
    )
    assert items[0]["coverage"] == "partially_redacted"
    response = await owner.post(
        board_notes(test_workspace, test_board),
        json=excerpt_save(test_workspace, session_id, items),
    )
    assert response.status_code == 201, response.text


@pytest.mark.timeout(120)
async def test_selected_bodies_over_2_mib_in_total_are_a_413(
    owner, client, device_client, db_session, test_workspace, test_board
):
    half = SELECTED_BODY_LIMIT_BYTES // 2
    enrolled = await enroll_rich(
        client, device_client, db_session, test_workspace, test_board
    )
    for order, body in enumerate([b"a" * half, b"b" * half, b"c"], start=1):
        await declare_and_upload(device_client, enrolled, body, order=order)
    session = await only_session(db_session)
    items = (
        await client.get(f"{sessions_path(test_workspace, session.id)}/contents")
    ).json()["items"]
    url = board_notes(test_workspace, test_board)
    over = await owner.post(url, json=excerpt_save(test_workspace, session.id, items))
    assert over.status_code == 413, over.text
    assert over.json()["error_code"] == "payload_too_large"
    assert await note_count(db_session) == 0

    at_limit = await owner.post(
        url, json=excerpt_save(test_workspace, session.id, items[:2])
    )
    assert at_limit.status_code == 201, at_limit.text


async def test_a_fresh_save_from_a_deleted_session_fails_closed(
    owner, client, db_session, test_workspace, test_board, source
):
    deleted = await client.delete(sessions_path(test_workspace, source["session_id"]))
    assert deleted.status_code == 204
    response = await owner.post(
        board_notes(test_workspace, test_board),
        json=excerpt_save(test_workspace, source["session_id"], source["items"]),
    )
    assert response.status_code == 404, response.text
    assert await note_count(db_session) == 0


# --- retry receipt ---------------------------------------------------------------


async def test_an_identical_retry_returns_the_same_note_without_repeating_effects(
    owner, db_session, test_workspace, test_board, test_card, second_user, source
):
    await add_member(db_session, test_workspace, second_user)
    payload = excerpt_save(
        test_workspace,
        source["session_id"],
        source["items"],
        card_id=str(test_card.id),
        content=reviewed_document(["first selected body"], mention=second_user),
    )
    url = board_notes(test_workspace, test_board)
    first = await owner.post(url, json=payload)
    assert first.status_code == 201, first.text
    retried = await owner.post(url, json=payload)
    assert retried.status_code == 200, retried.text
    assert retried.json() == first.json()
    assert await note_count(db_session) == 1
    assert await created_activity_count(db_session) == 1
    assert await mention_count(db_session, second_user) == 1


async def test_retry_fingerprint_ignores_json_key_order(
    owner, db_session, test_workspace, test_board, source
):
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    url = board_notes(test_workspace, test_board)
    first = await owner.post(url, json=payload)
    assert first.status_code == 201, first.text
    reordered = json.loads(json.dumps(payload))
    reordered["content"] = {
        "content": reordered["content"]["content"],
        "type": "doc",
    }
    reordered["excerpt_source"]["items"] = [
        {"sha256": item["sha256"], "content_id": item["content_id"]}
        for item in reordered["excerpt_source"]["items"]
    ]
    retried = await owner.post(url, json=reordered)
    assert retried.status_code == 200, retried.text
    assert retried.json()["id"] == first.json()["id"]
    assert await note_count(db_session) == 1


@pytest.mark.parametrize(
    "change",
    [
        "title",
        "content",
        "card",
        "board",
        "items",
        "sha256",
        "source-session",
        "source-workspace",
    ],
)
async def test_reusing_a_request_id_for_a_different_save_is_a_409(
    change,
    owner,
    db_session,
    test_user,
    test_workspace,
    test_board,
    test_card,
    source,
):
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    url = board_notes(test_workspace, test_board)
    first = await owner.post(url, json=payload)
    assert first.status_code == 201, first.text
    changed = json.loads(json.dumps(payload))
    if change == "title":
        changed["title"] = "Another title"
    elif change == "content":
        changed["content"] = reviewed_document(["edited after review"])
    elif change == "card":
        changed["card_id"] = str(test_card.id)
    elif change == "board":
        other_board = Board(
            workspace_id=test_workspace.id,
            name="Sibling",
            slug="sibling",
            created_by=test_user.id,
        )
        db_session.add(other_board)
        await db_session.flush()
        url = board_notes(test_workspace, other_board)
    elif change == "items":
        changed["excerpt_source"]["items"] = changed["excerpt_source"]["items"][:1]
    elif change == "sha256":
        changed["excerpt_source"]["items"][0]["sha256"] = "f" * 64
    elif change == "source-session":
        changed["excerpt_source"]["session_id"] = str(uuid.uuid4())
    else:
        changed["excerpt_source"]["workspace_id"] = str(uuid.uuid4())
    conflict = await owner.post(url, json=changed)
    assert conflict.status_code == 409, conflict.text
    assert conflict.json()["error_code"] == "client_request_conflict"
    assert first.json()["id"] not in conflict.text
    assert await note_count(db_session) == 1


async def test_a_request_id_is_bound_to_its_destination_workspace(
    owner, db_session, test_user, test_workspace, test_board, source
):
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    first = await owner.post(board_notes(test_workspace, test_board), json=payload)
    assert first.status_code == 201, first.text
    destination, destination_board = await second_workspace(db_session, test_user)
    moved = await owner.post(board_notes(destination, destination_board), json=payload)
    assert moved.status_code == 409, moved.text
    assert moved.json()["error_code"] == "client_request_conflict"
    assert first.json()["id"] not in moved.text
    assert await note_count(db_session, destination) == 0


async def test_request_ids_never_cross_principals(
    owner,
    client,
    device_client,
    db_session,
    test_workspace,
    test_board,
    second_user,
    source,
):
    """Another member replaying the owner's exact request (same key, same
    source) gets the source refusal, never the owner's note; with their own
    source the same key makes their own note."""
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    url = board_notes(test_workspace, test_board)
    first = await owner.post(url, json=payload)
    assert first.status_code == 201, first.text
    await add_member(db_session, test_workspace, second_user)
    async with as_principal(db_session, second_user) as other:
        replayed = await other.post(url, json=payload)
        assert replayed.status_code == 404, replayed.text
        assert first.json()["id"] not in replayed.text

        theirs = await enroll_rich(
            other,
            device_client,
            db_session,
            test_workspace,
            test_board,
            root="/synthetic/other",
        )
        result = await ingest(
            device_client,
            theirs,
            [rich_record(theirs["mapping_id"], [declaration(b"their own body")])],
        )
        [ack] = result["contents"]
        session_id = await db_session.scalar(
            select(AgentSession.id).where(AgentSession.owner_id == second_user.id)
        )
        own_items = (
            await other.get(f"{sessions_path(test_workspace, session_id)}/contents")
        ).json()["items"]
        own = await other.post(
            url,
            json={
                **payload,
                "excerpt_source": {
                    "workspace_id": str(test_workspace.id),
                    "session_id": str(session_id),
                    "items": selected(own_items),
                },
            },
        )
    assert own.status_code == 201, own.text
    assert own.json()["id"] != first.json()["id"]
    assert ack["content_id"] in {item["id"] for item in own_items}


async def test_a_deleted_note_leaves_a_tombstone_a_retry_cannot_resurrect(
    owner, db_session, test_workspace, test_board, source
):
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    url = board_notes(test_workspace, test_board)
    first = await owner.post(url, json=payload)
    assert first.status_code == 201, first.text
    assert (await owner.delete(f"{url}/{first.json()['id']}")).status_code == 204
    retried = await owner.post(url, json=payload)
    assert retried.status_code == 410, retried.text
    assert retried.json()["error_code"] == "gone"
    assert await note_count(db_session) == 0


@pytest.mark.parametrize("revoked", ["viewer", "frozen"])
async def test_a_tombstone_answers_only_after_the_destination_checks(
    revoked, owner, db_session, test_user, test_workspace, test_board, source
):
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    url = board_notes(test_workspace, test_board)
    first = await owner.post(url, json=payload)
    assert first.status_code == 201, first.text
    assert (await owner.delete(f"{url}/{first.json()['id']}")).status_code == 204
    if revoked == "viewer":
        await db_session.execute(
            update(WorkspaceMember)
            .where(WorkspaceMember.user_id == test_user.id)
            .values(role=WorkspaceRole.viewer)
        )
    else:
        await db_session.execute(
            update(Board).where(Board.id == test_board.id).values(is_frozen=True)
        )
    await db_session.flush()
    retried = await owner.post(url, json=payload)
    assert retried.status_code == {"viewer": 403, "frozen": 409}[revoked], retried.text
    assert (
        retried.json()["error_code"]
        == {
            "viewer": "forbidden",
            "frozen": "board_frozen",
        }[revoked]
    )


async def test_keys_acting_for_the_owner_cannot_replay_the_owners_request(
    owner,
    agent_client,
    installation_key_client,
    db_session,
    test_workspace,
    test_board,
    source,
):
    """Agent and companion launch keys resolve to the owner's user, so a
    receipt keyed by user alone would hand them the owner's saved excerpt;
    they are refused before any receipt lookup."""
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    url = board_notes(test_workspace, test_board)
    first = await owner.post(url, json=payload)
    assert first.status_code == 201, first.text
    for key_client in (agent_client, installation_key_client):
        replayed = await key_client.post(url, json=payload)
        assert replayed.status_code == 403, replayed.text
        assert replayed.json()["error_code"] == "forbidden"
        assert first.json()["id"] not in replayed.text
    assert await note_count(db_session) == 1


async def test_a_completed_save_is_recoverable_after_its_source_is_deleted(
    owner, client, db_session, test_workspace, test_board, source
):
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    url = board_notes(test_workspace, test_board)
    first = await owner.post(url, json=payload)
    assert first.status_code == 201, first.text
    deleted = await client.delete(sessions_path(test_workspace, source["session_id"]))
    assert deleted.status_code == 204

    retried = await owner.post(url, json=payload)
    assert retried.status_code == 200, retried.text
    assert retried.json() == first.json()
    fresh = await owner.post(
        url, json={**payload, "client_request_id": str(uuid.uuid4())}
    )
    assert fresh.status_code == 404, fresh.text
    assert await note_count(db_session) == 1


@pytest.mark.parametrize("revoked", ["viewer", "frozen"])
async def test_a_retry_rechecks_the_destination_before_returning_the_note(
    revoked, owner, db_session, test_user, test_workspace, test_board, source
):
    """Control: replay never bypasses the current destination checks."""
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    url = board_notes(test_workspace, test_board)
    first = await owner.post(url, json=payload)
    assert first.status_code == 201, first.text
    if revoked == "viewer":
        await db_session.execute(
            update(WorkspaceMember)
            .where(WorkspaceMember.user_id == test_user.id)
            .values(role=WorkspaceRole.viewer)
        )
    else:
        await db_session.execute(
            update(Board).where(Board.id == test_board.id).values(is_frozen=True)
        )
    await db_session.flush()
    retried = await owner.post(url, json=payload)
    assert retried.status_code == {"viewer": 403, "frozen": 409}[revoked], retried.text
    assert first.json()["id"] not in retried.text


# --- non-effects -----------------------------------------------------------------


async def test_publishing_shares_the_note_but_not_the_session(
    owner,
    db_session,
    test_workspace,
    test_board,
    test_card,
    second_user,
    source,
):
    """Control: a second member reads the ordinary note; the raw session and
    its bodies stay owner-private, and no session work link appears."""
    await add_member(db_session, test_workspace, second_user)
    url = board_notes(test_workspace, test_board)
    saved = await owner.post(
        url,
        json=excerpt_save(
            test_workspace,
            source["session_id"],
            source["items"],
            card_id=str(test_card.id),
        ),
    )
    assert saved.status_code == 201, saved.text
    contents = f"{sessions_path(test_workspace, source['session_id'])}/contents"
    async with as_principal(db_session, second_user) as reader:
        read = await reader.get(f"{url}/{saved.json()['id']}")
        assert read.status_code == 200, read.text
        assert read.json()["content"] == saved.json()["content"]
        for path in (contents, f"{contents}/{source['items'][0]['id']}/body"):
            assert (await reader.get(path)).status_code == 404, path
    assert saved.json()["pinned"] is False
    assert (
        await db_session.scalar(select(func.count()).select_from(SessionWorkLink)) == 0
    )


async def test_a_request_id_without_an_excerpt_source_is_rejected(
    owner, db_session, test_workspace, test_board
):
    response = await owner.post(
        board_notes(test_workspace, test_board),
        json={
            "title": "Missing source",
            "content": reviewed_document(["reviewed"]),
            "client_request_id": str(uuid.uuid4()),
        },
    )
    assert response.status_code == 422, response.text
    assert response.json()["error_code"] == SCHEMA_REJECTED
    assert await note_count(db_session) == 0


async def test_a_json_string_pm_doc_keeps_exact_reviewed_text_without_autodetection(
    owner, db_session, test_workspace, test_board, source
):
    reviewed = reviewed_document(["<pre>literal</pre>\n```\n# captured"])
    response = await owner.post(
        board_notes(test_workspace, test_board),
        json=excerpt_save(
            test_workspace,
            source["session_id"],
            source["items"],
            content=json.dumps(reviewed),
        ),
    )
    assert response.status_code == 201, response.text
    assert json.loads(response.json()["content"]) == reviewed


@pytest.mark.parametrize(
    "content",
    [
        pytest.param(json.dumps([{"type": "doc", "content": []}]), id="json-array"),
        pytest.param(json.dumps("<pre>captured</pre>"), id="json-string-scalar"),
        pytest.param("null", id="json-null"),
        pytest.param(
            {"type": "paragraph", "content": [{"type": "text", "text": "x"}]},
            id="non-doc-object",
        ),
    ],
)
async def test_excerpt_content_must_be_a_doc_object_not_a_json_scalar_or_fragment(
    content, owner, db_session, test_workspace, test_board, source
):
    response = await owner.post(
        board_notes(test_workspace, test_board),
        json=excerpt_save(
            test_workspace, source["session_id"], source["items"], content=content
        ),
    )
    assert response.status_code == 422, response.text
    assert response.json()["error_code"] == SCHEMA_REJECTED
    assert await note_count(db_session) == 0


@pytest.mark.parametrize("damage", ["missing", "truncated"])
async def test_fresh_save_checks_the_uploaded_object_even_when_metadata_says_ready(
    damage, owner, client, device_client, db_session, test_workspace, test_board
):
    enrolled = await enroll_rich(
        client, device_client, db_session, test_workspace, test_board
    )
    await declare_and_upload(
        device_client, enrolled, b"stored selected evidence" * 1000
    )
    session = await only_session(db_session)
    items = (
        await client.get(f"{sessions_path(test_workspace, session.id)}/contents")
    ).json()["items"]
    row = await db_session.scalar(
        select(AgentSessionContent).where(
            AgentSessionContent.id == uuid.UUID(items[0]["id"])
        )
    )
    assert row.state == "available" and row.inline_text is None and row.storage_key
    store = content_store()
    if damage == "missing":
        store.delete(row.storage_key)
    else:
        store.put(row.storage_key, b"short")
    body = await owner.get(
        f"{sessions_path(test_workspace, session.id)}/contents/{row.id}/body"
    )
    assert (
        body.status_code == 503
        and body.json()["error_code"] == "storage_backend_unavailable"
    )
    response = await owner.post(
        board_notes(test_workspace, test_board),
        json=excerpt_save(test_workspace, session.id, items),
    )
    assert response.status_code == 503, response.text
    assert response.json()["error_code"] == "storage_backend_unavailable"
    assert await note_count(db_session) == 0
    assert await created_activity_count(db_session) == 0


async def test_completed_retry_does_not_require_the_uploaded_source_object(
    owner, client, device_client, db_session, test_workspace, test_board
):
    enrolled = await enroll_rich(
        client, device_client, db_session, test_workspace, test_board
    )
    await declare_and_upload(
        device_client, enrolled, b"stored selected evidence" * 1000
    )
    session = await only_session(db_session)
    items = (
        await client.get(f"{sessions_path(test_workspace, session.id)}/contents")
    ).json()["items"]
    payload = excerpt_save(test_workspace, session.id, items)
    url = board_notes(test_workspace, test_board)
    first = await owner.post(url, json=payload)
    assert first.status_code == 201, first.text
    row = await db_session.scalar(
        select(AgentSessionContent).where(
            AgentSessionContent.id == uuid.UUID(items[0]["id"])
        )
    )
    assert row.storage_key
    content_store().delete(row.storage_key)
    replay = await owner.post(url, json=payload)
    assert replay.status_code == 200, replay.text
    assert replay.json() == first.json()
    fresh = await owner.post(
        url, json={**payload, "client_request_id": str(uuid.uuid4())}
    )
    assert fresh.status_code == 503, fresh.text
    assert await note_count(db_session) == 1


async def test_retry_after_destination_membership_removal_is_opaque(
    owner, db_session, test_user, test_workspace, test_board, source
):
    payload = excerpt_save(test_workspace, source["session_id"], source["items"])
    url = board_notes(test_workspace, test_board)
    first = await owner.post(url, json=payload)
    assert first.status_code == 201, first.text
    await db_session.execute(
        delete(WorkspaceMember).where(
            WorkspaceMember.workspace_id == test_workspace.id,
            WorkspaceMember.user_id == test_user.id,
        )
    )
    await db_session.flush()
    replay = await owner.post(url, json=payload)
    assert replay.status_code == 403, replay.text
    assert first.json()["id"] not in replay.text
    assert await note_count(db_session) == 1


@pytest.mark.timeout(120)
async def test_reviewed_document_limit_counts_compact_utf8_not_ascii_escapes(
    owner, db_session, test_workspace, test_board, source
):
    reviewed = reviewed_document([""])
    empty_size = len(canonical_document_bytes(reviewed))
    budget = REVIEWED_DOCUMENT_LIMIT_BYTES - empty_size
    text = "é" * (budget // 2) + "a" * (budget % 2)
    reviewed["content"][1]["content"][0]["text"] = text
    assert len(canonical_document_bytes(reviewed)) == REVIEWED_DOCUMENT_LIMIT_BYTES
    too_large = json.loads(json.dumps(reviewed))
    too_large["content"][1]["content"][0]["text"] += "a"
    url = board_notes(test_workspace, test_board)
    refused = await owner.post(
        url,
        json=excerpt_save(
            test_workspace,
            source["session_id"],
            source["items"],
            content=too_large,
        ),
    )
    assert refused.status_code == 413, refused.text[:500]
    assert refused.json()["error_code"] == "payload_too_large"
    assert await note_count(db_session) == 0
    accepted = await owner.post(
        url,
        json=excerpt_save(
            test_workspace,
            source["session_id"],
            source["items"],
            content=reviewed,
        ),
    )
    assert accepted.status_code == 201, accepted.text[:500]
    assert json.loads(accepted.json()["content"]) == reviewed


@pytest.mark.timeout(120)
async def test_json_control_escaping_does_not_reject_a_2_mib_selected_body(
    owner, client, device_client, db_session, test_workspace, test_board
):
    body = b"\x01" * SELECTED_BODY_LIMIT_BYTES
    enrolled = await enroll_rich(
        client, device_client, db_session, test_workspace, test_board
    )
    await declare_and_upload(device_client, enrolled, body)
    session = await only_session(db_session)
    items = (
        await client.get(f"{sessions_path(test_workspace, session.id)}/contents")
    ).json()["items"]
    reviewed = reviewed_document([body.decode("utf-8")])
    size = len(canonical_document_bytes(reviewed))
    assert 12 << 20 < size < REVIEWED_DOCUMENT_LIMIT_BYTES
    response = await owner.post(
        board_notes(test_workspace, test_board),
        json=excerpt_save(
            test_workspace,
            session.id,
            items,
            content=reviewed,
        ),
    )
    assert response.status_code == 201, response.text[:500]
    assert json.loads(response.json()["content"]) == reviewed


@pytest.mark.timeout(120)
async def test_selected_descriptor_count_is_bounded_even_for_empty_text_bodies(
    owner, client, device_client, db_session, test_workspace, test_board
):
    enrolled = await enroll_rich(
        client, device_client, db_session, test_workspace, test_board
    )
    declarations = [declaration(b"", order=i) for i in range(SELECTED_ITEM_LIMIT + 1)]
    items = []
    for batch in [
        declarations[:SELECTED_ITEM_LIMIT],
        declarations[SELECTED_ITEM_LIMIT:],
    ]:
        result = await ingest(
            device_client, enrolled, [rich_record(enrolled["mapping_id"], batch)]
        )
        items.extend(
            {"id": ack["content_id"], "sha256": body["sha256"]}
            for ack, body in zip(result["contents"], batch, strict=True)
        )
    assert len({item["id"] for item in items}) == SELECTED_ITEM_LIMIT + 1
    session = await only_session(db_session)
    url = board_notes(test_workspace, test_board)
    refused = await owner.post(
        url, json=excerpt_save(test_workspace, session.id, items)
    )
    assert refused.status_code == 422, refused.text[:500]
    assert refused.json()["error_code"] == SCHEMA_REJECTED
    assert await note_count(db_session) == 0
    accepted = await owner.post(
        url, json=excerpt_save(test_workspace, session.id, items[:SELECTED_ITEM_LIMIT])
    )
    assert accepted.status_code == 201, accepted.text[:500]
