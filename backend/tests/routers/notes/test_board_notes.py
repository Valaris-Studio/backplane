# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from httpx import AsyncClient

from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.workspace import Workspace


BASE_URL = "/api/workspaces/default/boards/{board_id}/notes"


async def test_list_board_notes_empty(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    url = BASE_URL.format(board_id=test_board.id)
    response = await client.get(url)
    assert response.status_code == 200
    assert response.json() == []


async def test_create_board_note(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    url = BASE_URL.format(board_id=test_board.id)
    import json

    response = await client.post(url, json={"title": "Board Note", "content": "Some content"})
    assert response.status_code == 201
    data = response.json()
    assert data["title"] == "Board Note"
    stored = json.loads(data["content"])
    assert stored["type"] == "doc"
    assert stored["content"][0]["content"][0]["text"] == "Some content"
    assert data["board_id"] == str(test_board.id)
    assert data["pinned"] is False


async def test_create_board_note_with_source_execution_id_round_trips(
    client, db_session, test_workspace: Workspace, test_board: Board, test_user
):
    """A machine-generated note (verdict/system) can record the execution that
    produced it; it persists and round-trips through the API so the UI can link
    the note to its source execution (the 'link the element' rule). NoteRead
    also exposes the field as null for ordinary human notes (back-compat)."""
    from app.models.agents.agent import Agent, AgentType
    from app.models.agents.execution import AgentExecution, ExecutionStatus

    agent = Agent(name="reviewer", agent_type=AgentType.reviewer, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()
    execution = AgentExecution(
        agent_id=agent.id, workspace_id=test_workspace.id, board_id=test_board.id,
        action="review", status=ExecutionStatus.completed, input_summary="x",
    )
    db_session.add(execution)
    await db_session.flush()

    url = BASE_URL.format(board_id=test_board.id)
    response = await client.post(
        url,
        json={
            "title": "Review: pr-123 — request_changes",
            "kind": "review_verdict",
            "source_execution_id": str(execution.id),
        },
    )
    assert response.status_code == 201
    assert response.json()["source_execution_id"] == str(execution.id)

    # A plain human note leaves it null.
    plain = await client.post(url, json={"title": "human note"})
    assert plain.status_code == 201
    assert plain.json()["source_execution_id"] is None


async def test_get_board_note(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    url = BASE_URL.format(board_id=test_board.id)
    create_resp = await client.post(url, json={"title": "Get This"})
    assert create_resp.status_code == 201
    note_id = create_resp.json()["id"]

    response = await client.get(f"{url}/{note_id}")
    assert response.status_code == 200
    assert response.json()["title"] == "Get This"
    assert response.json()["id"] == note_id


async def test_update_board_note(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    url = BASE_URL.format(board_id=test_board.id)
    create_resp = await client.post(url, json={"title": "Before Update"})
    assert create_resp.status_code == 201
    note_id = create_resp.json()["id"]

    response = await client.put(f"{url}/{note_id}", json={"title": "After Update", "pinned": True})
    assert response.status_code == 200
    data = response.json()
    assert data["title"] == "After Update"
    assert data["pinned"] is True


async def test_delete_board_note(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    url = BASE_URL.format(board_id=test_board.id)
    create_resp = await client.post(url, json={"title": "Delete Me"})
    assert create_resp.status_code == 201
    note_id = create_resp.json()["id"]

    response = await client.delete(f"{url}/{note_id}")
    assert response.status_code == 204

    get_resp = await client.get(f"{url}/{note_id}")
    assert get_resp.status_code == 404


async def test_get_board_note_not_found(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    url = BASE_URL.format(board_id=test_board.id)
    fake_id = uuid.uuid4()
    response = await client.get(f"{url}/{fake_id}")
    assert response.status_code == 404


# --- Tests for card_id support ---


async def test_create_board_note_with_card_id(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
):
    url = BASE_URL.format(board_id=test_board.id)
    response = await client.post(
        url,
        json={"title": "Card Review", "content": "Review findings", "card_id": str(test_card.id)},
    )
    assert response.status_code == 201
    data = response.json()
    assert data["title"] == "Card Review"
    assert data["card_id"] == str(test_card.id)
    assert data["board_id"] == str(test_board.id)


async def test_list_board_notes_filtered_by_card_id(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
):
    url = BASE_URL.format(board_id=test_board.id)
    # Create a note linked to the card
    resp1 = await client.post(
        url,
        json={"title": "Linked", "card_id": str(test_card.id)},
    )
    assert resp1.status_code == 201
    # Create a note without card_id
    resp2 = await client.post(url, json={"title": "Unlinked"})
    assert resp2.status_code == 201

    # Filter by card_id
    response = await client.get(url, params={"card_id": str(test_card.id)})
    assert response.status_code == 200
    notes = response.json()
    assert len(notes) == 1
    assert notes[0]["title"] == "Linked"
    assert notes[0]["card_id"] == str(test_card.id)


async def test_card_id_null_in_response_when_not_set(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    url = BASE_URL.format(board_id=test_board.id)
    response = await client.post(url, json={"title": "No Card Link"})
    assert response.status_code == 201
    data = response.json()
    assert data["card_id"] is None


async def test_export_board_notes_success(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    url = BASE_URL.format(board_id=test_board.id)
    create_a = await client.post(
        url, json={"title": "First", "content": "alpha", "pinned": True}
    )
    assert create_a.status_code == 201
    create_b = await client.post(url, json={"title": "Second", "content": "beta"})
    assert create_b.status_code == 201

    response = await client.get(f"{url}/export")
    assert response.status_code == 200, response.text

    body = response.json()
    assert body["entity_type"] == "notes_bundle"
    assert body["source_workspace_slug"] == test_workspace.slug
    assert body["source_board_slug"] == test_board.slug

    notes = body["data"]["notes"]
    assert len(notes) == 2
    by_title = {n["title"]: n for n in notes}
    import json as _json

    assert by_title["First"]["pinned"] is True
    first_content = _json.loads(by_title["First"]["content"])
    assert first_content["content"][0]["content"][0]["text"] == "alpha"
    assert by_title["First"]["external_note_id"] == create_a.json()["id"]
    assert by_title["Second"]["pinned"] is False
    assert by_title["First"]["card_slug"] is None

    assert (
        f'filename="{test_board.slug}.valaris.notes.json"'
        in response.headers["content-disposition"]
    )


async def test_export_board_notes_empty_returns_envelope(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.get(BASE_URL.format(board_id=test_board.id) + "/export")
    assert response.status_code == 200, response.text
    assert response.json()["data"]["notes"] == []


async def test_export_board_notes_excludes_workspace_level(
    client: AsyncClient,
    db_session,
    test_workspace: Workspace,
    test_board: Board,
    test_user,
):
    from app.models.notes.note import Note

    workspace_note = Note(
        workspace_id=test_workspace.id,
        board_id=None,
        title="Workspace Only",
        content="not in board export",
        created_by=test_user.id,
    )
    db_session.add(workspace_note)
    board_note = Note(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        title="Board Note",
        content="in export",
        created_by=test_user.id,
    )
    db_session.add(board_note)
    await db_session.flush()

    response = await client.get(BASE_URL.format(board_id=test_board.id) + "/export")
    assert response.status_code == 200
    titles = [n["title"] for n in response.json()["data"]["notes"]]
    assert titles == ["Board Note"]


async def test_export_board_notes_unknown_workspace(client: AsyncClient):
    response = await client.get(
        f"/api/workspaces/nonexistent/boards/{uuid.uuid4()}/notes/export"
    )
    assert response.status_code == 404


# --- Tests for note kind + verdict immutability + verdict route ---


async def test_create_board_note_with_review_verdict_kind(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
):
    url = BASE_URL.format(board_id=test_board.id)
    response = await client.post(
        url,
        json={
            "title": f"Review: {test_card.id} — approve",
            "content": "LGTM",
            "kind": "review_verdict",
            "card_id": str(test_card.id),
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["kind"] == "review_verdict"


async def test_delete_review_verdict_note_returns_403(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
):
    url = BASE_URL.format(board_id=test_board.id)
    create_resp = await client.post(
        url,
        json={
            "title": f"Review: {test_card.id} — request_changes",
            "kind": "review_verdict",
            "card_id": str(test_card.id),
        },
    )
    assert create_resp.status_code == 201
    note_id = create_resp.json()["id"]

    delete_resp = await client.delete(f"{url}/{note_id}")
    assert delete_resp.status_code == 403

    get_resp = await client.get(f"{url}/{note_id}")
    assert get_resp.status_code == 200


async def test_update_review_verdict_note_returns_403(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
):
    url = BASE_URL.format(board_id=test_board.id)
    create_resp = await client.post(
        url,
        json={
            "title": f"Review: {test_card.id} — approve",
            "kind": "review_verdict",
            "card_id": str(test_card.id),
        },
    )
    assert create_resp.status_code == 201
    note_id = create_resp.json()["id"]

    update_resp = await client.put(
        f"{url}/{note_id}", json={"content": "tampered"}
    )
    assert update_resp.status_code == 403


async def test_get_card_verdict_returns_latest_approve(
    client: AsyncClient,
    db_session,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
):
    from datetime import datetime, timedelta

    from app.models.notes.note import Note

    url = BASE_URL.format(board_id=test_board.id)
    earlier_resp = await client.post(
        url,
        json={
            "title": f"Review: {test_card.id} — request_changes",
            "kind": "review_verdict",
            "card_id": str(test_card.id),
        },
    )
    latest_resp = await client.post(
        url,
        json={
            "title": f"Review: {test_card.id} — approve",
            "kind": "review_verdict",
            "card_id": str(test_card.id),
        },
    )
    # SQLite CURRENT_TIMESTAMP collisions break ORDER BY created_at DESC; force
    # a deterministic ordering by writing distinct timestamps directly.
    earlier = await db_session.get(Note, uuid.UUID(earlier_resp.json()["id"]))
    latest = await db_session.get(Note, uuid.UUID(latest_resp.json()["id"]))
    earlier.created_at = datetime.utcnow() - timedelta(minutes=5)
    latest.created_at = datetime.utcnow()
    await db_session.flush()

    verdict_url = (
        f"/api/workspaces/{test_workspace.slug}/boards/{test_board.id}"
        f"/cards/{test_card.id}/verdict"
    )
    response = await client.get(verdict_url)
    assert response.status_code == 200
    body = response.json()
    assert body["decision"] == "approve"
    assert "note_id" in body


async def test_get_notes_returns_review_verdict_with_findings(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
):
    """The board-notes endpoint must round-trip review_verdict notes with
    their structured `findings` + `failure_class` fields. UX-2 depends on
    this for the reviewer-history UI; without it, the runner-view fallback
    has no decision context to render."""
    url = BASE_URL.format(board_id=test_board.id)
    create_resp = await client.post(
        url,
        json={
            "title": f"Review: {test_card.id} — request_changes",
            "kind": "review_verdict",
            "card_id": str(test_card.id),
            "failure_class": "LOGIC",
            "findings": [
                {
                    "severity": "BLOCKING",
                    "message": "Null deref in handler",
                    "file": "app/services/foo.py",
                    "function": "handle",
                },
                {"severity": "SUGGESTION", "message": "Nit: rename var"},
            ],
        },
    )
    assert create_resp.status_code == 201, create_resp.text

    list_resp = await client.get(url, params={"card_id": str(test_card.id)})
    assert list_resp.status_code == 200
    notes = list_resp.json()
    verdicts = [n for n in notes if n["kind"] == "review_verdict"]
    assert len(verdicts) == 1
    verdict = verdicts[0]
    assert verdict["failure_class"] == "LOGIC"
    assert verdict["findings"] is not None
    assert len(verdict["findings"]) == 2
    assert verdict["findings"][0]["severity"] == "BLOCKING"
    assert verdict["findings"][0]["file"] == "app/services/foo.py"
    assert verdict["findings"][1]["severity"] == "SUGGESTION"


async def test_get_card_verdict_404_when_no_verdict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
):
    verdict_url = (
        f"/api/workspaces/{test_workspace.slug}/boards/{test_board.id}"
        f"/cards/{test_card.id}/verdict"
    )
    response = await client.get(verdict_url)
    assert response.status_code == 404


# --- ?format=markdown / ?summary_only (board-scoped smoke) ------------------


async def test_get_board_note_markdown_format(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    url = BASE_URL.format(board_id=test_board.id)
    create_resp = await client.post(
        url, json={"title": "MD", "content": "A *list*:\n\n- one\n- two"}
    )
    assert create_resp.status_code == 201
    note_id = create_resp.json()["id"]

    response = await client.get(f"{url}/{note_id}?format=markdown")
    assert response.status_code == 200
    content = response.json()["content"]
    assert "- one" in content
    assert "- two" in content
    assert "<" not in content


async def test_list_board_notes_summary_only_omits_content(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    url = BASE_URL.format(board_id=test_board.id)
    await client.post(url, json={"title": "B1", "content": "heavy body"})

    response = await client.get(f"{url}?summary_only=true")
    assert response.status_code == 200
    notes = response.json()
    assert len(notes) == 1
    assert "content" not in notes[0]
    assert notes[0]["title"] == "B1"
