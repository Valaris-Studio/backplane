# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""SEC — note attribution and human-only pin promotion (card 6f33e60a).

Pinned through the public note routes (workspace- and board-level):
- R1 author stamps are derived server-side (user / installation / agent),
  never taken from the request body
- R2 pinning is a human act: an Agent principal cannot pin on create or edit;
  human principals pin and the note records who and when
- R3 an Agent principal cannot replace, append, replace-section, edit, unpin,
  relink or delete a pinned note, and the note stays byte-identical
- R4 a human unpin clears the pin stamps, a re-pin re-stamps, other edits keep them
- R5 an Agent may only cite its own execution as `source_execution_id`
- R6 NoteRead and NoteSummary expose the four attribution fields
- R7 the revision snapshot keeps its eight fields: the new columns never enter the digest
- R8 legacy pinned rows (NULL stamps) read back with nulls, still render into
  the board definition, and are just as agent-protected as freshly pinned notes
"""

import hashlib
import secrets
import uuid
from collections import namedtuple
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.core.auth import get_current_user
from app.database import get_db
from app.main import create_app
from app.models.activity import Activity, ActivityAction
from app.models.agents.agent import Agent, AgentType
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.api_key import ApiKey
from app.models.kanban.board import Board
from app.models.notes.note import Note
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.services.agents.context_assembly import render_board_definition
from app.services.notes.history_content import SNAPSHOT_FIELDS, revision_digest, snapshot

WS_NOTES_URL = "/api/workspaces/default/notes"
BOARD_NOTES_URL = "/api/workspaces/default/boards/{board_id}/notes"
ATTRIBUTION_FIELDS = {"author_principal_kind", "author_agent_id", "pinned_by", "pinned_at"}
# What R3 promises an Agent cannot move on a pinned note.
UNCHANGED_FIELDS = ("history_revision", "content", "title", "pinned", "card_id")
LEGACY_CONTENT = (
    '{"type":"doc","content":[{"type":"paragraph","content":'
    '[{"type":"text","text":"Legacy body"}]}]}'
)

AgentActor = namedtuple("AgentActor", "agent client")


# --- helpers ------------------------------------------------------------------


def _notes_url(board=None) -> str:
    return WS_NOTES_URL if board is None else BOARD_NOTES_URL.format(board_id=board.id)


def _note_url(note_id, board=None) -> str:
    return f"{_notes_url(board)}/{note_id}"


async def _create_note(client: AsyncClient, board=None, **fields) -> dict:
    response = await client.post(
        _notes_url(board),
        json={"title": "Attributed note", "content": "# State\n\nBefore", **fields},
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _read_note(client: AsyncClient, note_id, board=None) -> dict:
    response = await client.get(_note_url(note_id, board))
    assert response.status_code == 200, response.text
    return response.json()


def _unchanged(before: dict, after: dict) -> bool:
    return {k: before[k] for k in UNCHANGED_FIELDS} == {k: after[k] for k in UNCHANGED_FIELDS}


def _missing(body: dict) -> set:
    return ATTRIBUTION_FIELDS - set(body)


async def _mint_agent_actor(db_session, owner, name: str) -> AgentActor:
    """A real `vlr_` key linked to an Agent row, exercised through the Bearer
    verifier (no get_current_user override). This binds current_agent_id and
    current_api_key_id together exactly as production does, which is what
    NoteHistoryAccess.authorize cross-checks (agent.api_key_id == key id)."""
    raw_key = "vlr_" + secrets.token_urlsafe(32)
    api_key = ApiKey(
        user_id=owner.id,
        name=f"{name}-key",
        key_hash=hashlib.sha256(raw_key.encode()).hexdigest(),
        key_prefix=raw_key[:8],
    )
    db_session.add(api_key)
    await db_session.flush()
    agent = Agent(
        name=name,
        agent_type=AgentType.coding,
        description="SEC note attribution test agent",
        created_by_id=owner.id,
        is_active=True,
        api_key_id=api_key.id,
    )
    db_session.add(agent)
    await db_session.flush()
    app = create_app()

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    client = AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"Authorization": f"Bearer {raw_key}"},
    )
    return AgentActor(agent, client)


@pytest_asyncio.fixture
async def agent_actor(db_session, test_user, test_workspace) -> AgentActor:
    actor = await _mint_agent_actor(db_session, test_user, "sec-agent")
    async with actor.client:
        yield actor


@asynccontextmanager
async def _as_member(db_session, workspace, user):
    """A second human, member of the workspace, through the dev-header tier."""
    db_session.add(
        WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role=WorkspaceRole.member)
    )
    await db_session.flush()
    app = create_app()

    async def override_get_db():
        yield db_session

    async def principal():
        return user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = principal
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac


async def _insert_legacy_pinned_note(db_session, workspace, board, user) -> Note:
    """A pre-migration row: pinned, with no author or pin stamps."""
    note = Note(
        workspace_id=workspace.id,
        board_id=board.id,
        title="Legacy pinned",
        content=LEGACY_CONTENT,
        pinned=True,
        created_by=user.id,
    )
    db_session.add(note)
    await db_session.flush()
    return note


async def _completed_execution(db_session, agent, workspace, board) -> AgentExecution:
    execution = AgentExecution(
        agent_id=agent.id,
        workspace_id=workspace.id,
        board_id=board.id,
        action="review",
        role="custom",
        status=ExecutionStatus.completed,
        cost_usd=0.1,
    )
    db_session.add(execution)
    await db_session.flush()
    return execution


# --- baseline (passes before and after SEC) -----------------------------------


async def test_agent_writes_unpinned_note_baseline(agent_actor, test_workspace, test_board):
    """An Agent principal keeps full write access to UNPINNED notes at both
    route levels. This must be green on main today and stay green after SEC;
    every refusal below is specific to pinning."""
    for board in (None, test_board):
        note = await _create_note(agent_actor.client, board)
        url = _note_url(note["id"], board)
        edited = await agent_actor.client.put(url, json={"title": "Agent retitled"})
        assert edited.status_code == 200, edited.text
        appended = await agent_actor.client.post(
            f"{url}/append", json={"content": "## Tail\n\nmore"}
        )
        assert appended.status_code == 200, appended.text
        sectioned = await agent_actor.client.post(
            f"{url}/replace-section",
            json={"anchor_heading": "State", "content": "Replacement"},
        )
        assert sectioned.status_code == 200, sectioned.text
        atomic = await agent_actor.client.post(
            f"{url}/edit", json={"mode": "replace", "title": "Atomic"}
        )
        assert atomic.status_code == 200, atomic.text
        deleted = await agent_actor.client.delete(url)
        assert deleted.status_code == 204, deleted.text


# --- R1 author stamp on creation ----------------------------------------------


async def test_create_note_stamps_human_principals(
    client, plain_key_client, installation_key_client, test_workspace, test_board
):
    # Same derivation as NoteHistoryAccess.authorize: a personal key is a
    # human, a Companion installation key is an installation.
    for caller, expected_kind in (
        (client, "user"),
        (plain_key_client, "user"),
        (installation_key_client, "installation"),
    ):
        note = await _create_note(caller, test_board)
        assert not _missing(note), f"NoteRead lacks {_missing(note)}"
        assert note["author_principal_kind"] == expected_kind
        assert note["author_agent_id"] is None


async def test_create_note_stamps_agent_principal(agent_actor, test_workspace, test_board):
    for board in (None, test_board):
        note = await _create_note(agent_actor.client, board)
        assert not _missing(note), f"NoteRead lacks {_missing(note)}"
        assert note["author_principal_kind"] == "agent"
        assert note["author_agent_id"] == str(agent_actor.agent.id)
        assert note["pinned_by"] is None and note["pinned_at"] is None
        reread = await _read_note(agent_actor.client, note["id"], board)
        assert reread["author_principal_kind"] == "agent"
        assert reread["author_agent_id"] == str(agent_actor.agent.id)


async def test_create_note_ignores_caller_supplied_author_stamp(
    agent_actor, test_user, test_workspace, test_board
):
    note = await _create_note(
        agent_actor.client,
        test_board,
        author_principal_kind="user",
        author_agent_id=None,
        pinned_by=str(test_user.id),
        pinned_at=datetime.now(timezone.utc).isoformat(),
    )
    assert not _missing(note), f"NoteRead lacks {_missing(note)}"
    assert note["author_principal_kind"] == "agent"
    assert note["author_agent_id"] == str(agent_actor.agent.id)
    assert note["pinned_by"] is None and note["pinned_at"] is None


# --- R2 pin promotion is a human act ------------------------------------------


@pytest.mark.parametrize("scope", ["workspace", "board"])
async def test_create_pinned_note_agent_forbidden(
    scope, agent_actor, db_session, test_workspace, test_board
):
    board = test_board if scope == "board" else None
    response = await agent_actor.client.post(
        _notes_url(board),
        json={"title": "Agent pin attempt", "content": "body", "pinned": True},
    )
    assert response.status_code == 403, response.text
    assert "pin" in response.json()["detail"].lower()
    persisted = await db_session.scalar(select(Note).where(Note.title == "Agent pin attempt"))
    assert persisted is None, "a refused pin must not leave a note behind"


async def test_edit_setting_pinned_agent_forbidden(
    agent_actor, client, test_workspace, test_board
):
    # Both an agent-authored and a human-authored unpinned note: authorship
    # grants no pin right.
    for note in (
        await _create_note(agent_actor.client, test_board),
        await _create_note(client, test_board),
    ):
        url = _note_url(note["id"], test_board)
        for method, suffix, payload in (
            ("put", "", {"pinned": True}),
            ("post", "/edit", {"mode": "replace", "pinned": True}),
            # A mixed edit is refused whole, never partially applied.
            ("post", "/edit", {"mode": "replace", "title": "Retitle and pin", "pinned": True}),
        ):
            refused = await getattr(agent_actor.client, method)(url + suffix, json=payload)
            assert refused.status_code == 403, f"{method} {suffix}: {refused.text}"
            assert "pin" in refused.json()["detail"].lower()
        after = await _read_note(client, note["id"], test_board)
        assert after["pinned"] is False
        assert _unchanged(note, after), (note, after)


async def test_create_pinned_note_human_principals_stamp_pinned_by(
    client, plain_key_client, installation_key_client, test_user, test_workspace, test_board
):
    for caller in (client, plain_key_client, installation_key_client):
        note = await _create_note(caller, test_board, pinned=True)
        assert not _missing(note), f"NoteRead lacks {_missing(note)}"
        assert note["pinned"] is True
        assert note["pinned_by"] == str(test_user.id)
        assert note["pinned_at"] is not None


async def _updated_activity_fields(db_session, note_id) -> list:
    """The `changes.fields` of the single `updated` activity row for a note
    that received exactly one edit."""
    rows = (
        await db_session.scalars(
            select(Activity).where(
                Activity.entity_id == uuid.UUID(note_id),
                Activity.action == ActivityAction.updated,
            )
        )
    ).all()
    assert len(rows) == 1, [row.changes for row in rows]
    return rows[0].changes["fields"]


async def test_update_pin_by_human_stamps_pinned_by(
    client, plain_key_client, installation_key_client, db_session, test_user,
    test_workspace, test_board,
):
    pin_edits = (("", {"pinned": True}), ("/edit", {"mode": "replace", "pinned": True}))
    for caller in (client, plain_key_client, installation_key_client):
        for suffix, payload in pin_edits:
            note = await _create_note(caller, test_board)
            assert not _missing(note), f"NoteRead lacks {_missing(note)}"
            assert note["pinned_by"] is None and note["pinned_at"] is None
            url = _note_url(note["id"], test_board)
            method = caller.post if suffix else caller.put
            pinned = await method(url + suffix, json=payload)
            assert pinned.status_code == 200, pinned.text
            body = pinned.json()
            assert body["pinned"] is True
            assert body["pinned_by"] == str(test_user.id)
            assert body["pinned_at"] is not None
            reread = await _read_note(caller, note["id"], test_board)
            assert reread["pinned_by"] == str(test_user.id)
            assert reread["pinned_at"] == body["pinned_at"]
            # The pin stamps ride along; the audited change is the pin itself.
            assert await _updated_activity_fields(db_session, note["id"]) == ["pinned"]


# --- R3 pinned notes are human-controlled -------------------------------------


PINNED_NOTE_MUTATIONS = {
    "put_replace": ("put", "", {"content": "# Agent\n\nOverwrite"}),
    "append": ("post", "/append", {"content": "## Tail\n\nagent"}),
    "replace_section": (
        "post", "/replace-section", {"anchor_heading": "State", "content": "Replacement"},
    ),
    "edit": ("post", "/edit", {"mode": "replace", "title": "Agent edit"}),
    "unpin": ("put", "", {"pinned": False}),
    "relink": ("put", "", {"card_id": "<test_card>"}),
    "delete": ("delete", "", None),
}


@pytest.mark.parametrize("scope", ["workspace", "board"])
@pytest.mark.parametrize("mutation", sorted(PINNED_NOTE_MUTATIONS))
async def test_agent_mutation_of_pinned_note_forbidden(
    mutation, scope, agent_actor, client, test_workspace, test_board, test_card
):
    method, suffix, payload = PINNED_NOTE_MUTATIONS[mutation]
    if mutation == "relink":
        payload = {"card_id": str(test_card.id)}
    # A board note, so relink has a same-board card to point at; pinned by a human.
    note = await _create_note(client, test_board, pinned=True)
    board = test_board if scope == "board" else None
    url = _note_url(note["id"], board)
    request_kwargs = {} if payload is None else {"json": payload}
    refused = await getattr(agent_actor.client, method)(url + suffix, **request_kwargs)
    assert refused.status_code == 403, (
        f"{mutation} via {scope} route: {refused.status_code} {refused.text}"
    )
    after = await _read_note(client, note["id"], board)
    assert after["pinned"] is True
    assert _unchanged(note, after), (note, after)


async def test_agent_cannot_edit_own_note_once_human_pins_it(
    agent_actor, client, test_workspace, test_board
):
    note = await _create_note(agent_actor.client, test_board)
    url = _note_url(note["id"], test_board)
    pinned = await client.put(url, json={"pinned": True})
    assert pinned.status_code == 200, pinned.text
    refused = await agent_actor.client.put(url, json={"title": "Author strikes back"})
    assert refused.status_code == 403, refused.text
    after = await _read_note(client, note["id"], test_board)
    assert after["pinned"] is True
    assert after["title"] == note["title"]
    assert after["history_revision"] == pinned.json()["history_revision"]


async def test_agent_unpin_request_on_unpinned_note_is_allowed(
    agent_actor, test_workspace, test_board
):
    """The pin gate keys on the note being pinned or becoming pinned; an
    explicit pinned=false on an unpinned note is an ordinary agent edit."""
    note = await _create_note(agent_actor.client, test_board)
    assert note["pinned"] is False
    response = await agent_actor.client.put(
        _note_url(note["id"], test_board), json={"pinned": False, "title": "Still unpinned"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["pinned"] is False
    assert response.json()["title"] == "Still unpinned"


# --- R4 human unpin / re-pin / untouched --------------------------------------


async def test_unpin_by_human_clears_pin_stamps(
    client, plain_key_client, installation_key_client, db_session, test_user,
    test_workspace, test_board,
):
    for caller in (client, plain_key_client, installation_key_client):
        note = await _create_note(caller, test_board, pinned=True)
        assert not _missing(note), f"NoteRead lacks {_missing(note)}"
        assert note["pinned_by"] == str(test_user.id)
        unpinned = await caller.put(_note_url(note["id"], test_board), json={"pinned": False})
        assert unpinned.status_code == 200, unpinned.text
        body = unpinned.json()
        assert body["pinned"] is False
        assert body["pinned_by"] is None and body["pinned_at"] is None
        reread = await _read_note(caller, note["id"], test_board)
        assert reread["pinned_by"] is None and reread["pinned_at"] is None
        assert await _updated_activity_fields(db_session, note["id"]) == ["pinned"]


async def test_repin_by_another_human_restamps(
    client, db_session, test_user, second_user, test_workspace, test_board
):
    note = await _create_note(client, test_board, pinned=True)
    assert not _missing(note), f"NoteRead lacks {_missing(note)}"
    first_pinned_at = note["pinned_at"]
    url = _note_url(note["id"], test_board)
    unpinned = await client.put(url, json={"pinned": False})
    assert unpinned.status_code == 200, unpinned.text
    async with _as_member(db_session, test_workspace, second_user) as colleague:
        repinned = await colleague.put(url, json={"pinned": True})
    assert repinned.status_code == 200, repinned.text
    body = repinned.json()
    assert body["pinned"] is True
    assert body["pinned_by"] == str(second_user.id)
    assert body["pinned_at"] is not None
    # UTC ISO strings order lexically; `>=` keeps a same-tick clock from flaking.
    assert body["pinned_at"] >= first_pinned_at


async def test_edit_not_touching_pinned_keeps_pin_stamps(client, test_workspace, test_board):
    note = await _create_note(client, test_board, pinned=True)
    assert not _missing(note), f"NoteRead lacks {_missing(note)}"
    url = _note_url(note["id"], test_board)
    for method, suffix, payload in (
        ("put", "", {"title": "Retitled, still pinned"}),
        ("post", "/append", {"content": "## Tail\n\nmore"}),
        ("post", "/edit", {"mode": "replace", "content": "# State\n\nRewritten"}),
    ):
        edited = await getattr(client, method)(url + suffix, json=payload)
        assert edited.status_code == 200, edited.text
        assert edited.json()["pinned"] is True
        assert edited.json()["pinned_by"] == note["pinned_by"], (method, suffix)
        assert edited.json()["pinned_at"] == note["pinned_at"], (method, suffix)


async def test_repin_of_already_pinned_note_by_human_is_stamp_noop(
    client, test_user, test_workspace, test_board
):
    """pinned=true on a note that is already pinned changes nothing: no new
    stamp, no new revision."""
    note = await _create_note(client, test_board, pinned=True)
    assert note["pinned_by"] == str(test_user.id)
    response = await client.put(_note_url(note["id"], test_board), json={"pinned": True})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["pinned"] is True
    assert body["pinned_by"] == note["pinned_by"]
    assert body["pinned_at"] == note["pinned_at"]
    assert body["history_revision"] == note["history_revision"]
    reread = await _read_note(client, note["id"], test_board)
    assert reread["pinned_at"] == note["pinned_at"]
    assert reread["history_revision"] == note["history_revision"]


# --- R5 source_execution_id honesty -------------------------------------------


async def test_agent_citing_other_agents_execution_forbidden(
    agent_actor, db_session, test_user, test_workspace, test_board
):
    other = Agent(
        name="other-agent",
        agent_type=AgentType.coding,
        description="Not the caller",
        created_by_id=test_user.id,
        is_active=True,
    )
    db_session.add(other)
    await db_session.flush()
    foreign = await _completed_execution(db_session, other, test_workspace, test_board)
    response = await agent_actor.client.post(
        _notes_url(test_board),
        json={
            "title": "Borrowed provenance",
            "content": "body",
            "source_execution_id": str(foreign.id),
        },
    )
    assert response.status_code == 403, response.text
    persisted = await db_session.scalar(
        select(Note).where(Note.source_execution_id == foreign.id)
    )
    assert persisted is None, "a refused citation must not leave a note behind"


async def test_agent_citing_missing_or_other_workspace_execution_forbidden(
    agent_actor, db_session, test_user, test_workspace, test_board
):
    """A missing id and the agent's OWN execution from another workspace get
    one indistinguishable refusal, so the check never reveals whether an
    execution exists elsewhere."""
    elsewhere = Workspace(name="Elsewhere", slug="elsewhere", created_by=test_user.id)
    db_session.add(elsewhere)
    await db_session.flush()
    elsewhere_board = Board(
        workspace_id=elsewhere.id,
        name="Elsewhere Board",
        slug="elsewhere-board",
        description="",
        created_by=test_user.id,
    )
    db_session.add(elsewhere_board)
    await db_session.flush()
    own_elsewhere = await _completed_execution(
        db_session, agent_actor.agent, elsewhere, elsewhere_board
    )
    refusals = []
    for cited in (uuid.uuid4(), own_elsewhere.id):
        response = await agent_actor.client.post(
            _notes_url(test_board),
            json={
                "title": "Misplaced provenance",
                "content": "body",
                "source_execution_id": str(cited),
            },
        )
        assert response.status_code == 403, (cited, response.text)
        refusals.append(response.json())
    assert refusals[0] == refusals[1], "missing and other-workspace must be indistinguishable"
    assert refusals[0]["error_code"] == "foreign_execution_citation"
    assert isinstance(refusals[0]["detail"], str) and refusals[0]["detail"]
    persisted = await db_session.scalar(select(Note).where(Note.title == "Misplaced provenance"))
    assert persisted is None, "a refused citation must not leave a note behind"


async def test_agent_citing_own_execution_persists(
    agent_actor, db_session, test_workspace, test_board
):
    own = await _completed_execution(db_session, agent_actor.agent, test_workspace, test_board)
    note = await _create_note(agent_actor.client, test_board, source_execution_id=str(own.id))
    assert note["source_execution_id"] == str(own.id)
    reread = await _read_note(agent_actor.client, note["id"], test_board)
    assert reread["source_execution_id"] == str(own.id)


async def test_human_citing_an_agents_execution_unchanged(
    client, db_session, test_agent, test_workspace, test_board
):
    """Non-agent principals keep today's behaviour: any existing execution id
    is accepted. Green before and after SEC."""
    execution = await _completed_execution(db_session, test_agent, test_workspace, test_board)
    note = await _create_note(client, test_board, source_execution_id=str(execution.id))
    assert note["source_execution_id"] == str(execution.id)


# --- R6 exposure --------------------------------------------------------------


async def test_note_read_exposes_attribution_fields(client, test_workspace, test_board):
    created = await _create_note(client, test_board, pinned=True)
    assert not _missing(created), f"create response lacks {_missing(created)}"
    reread = await _read_note(client, created["id"], test_board)
    assert not _missing(reread), f"GET response lacks {_missing(reread)}"
    edited = await client.post(
        _note_url(created["id"], test_board) + "/edit",
        json={"mode": "replace", "title": "Edited"},
    )
    assert edited.status_code == 200, edited.text
    assert not _missing(edited.json()), f"edit response lacks {_missing(edited.json())}"


async def test_note_lists_expose_attribution_fields(client, test_user, test_workspace, test_board):
    # The workspace list holds only board_id IS NULL notes, so seed both scopes.
    board_note = await _create_note(client, test_board, pinned=True)
    workspace_note = await _create_note(client, pinned=True)
    for url, expected_id in ((_notes_url(), workspace_note["id"]), (_notes_url(test_board), board_note["id"])):
        for params in ({}, {"summary_only": "true"}):
            listed = await client.get(url, params=params)
            assert listed.status_code == 200, listed.text
            items = {item["id"]: item for item in listed.json()}
            assert expected_id in items, (url, params)
            item = items[expected_id]
            if params:
                assert "content" not in item, "summary shape must stay content-free"
            assert not _missing(item), f"{url} {params} item lacks {_missing(item)}"
            assert item["author_principal_kind"] == "user"
            assert item["author_agent_id"] is None
            assert item["pinned_by"] == str(test_user.id)
            assert item["pinned_at"] is not None


# --- R7 revision snapshot unchanged -------------------------------------------


def test_snapshot_fields_exclude_attribution_columns():
    def _note() -> Note:
        return Note(
            workspace_id=uuid.UUID(int=1),
            board_id=None,
            card_id=None,
            title="Digest preimage",
            content='{"type":"doc","content":[]}',
            pinned=True,
            kind="user_note",
            failure_class=None,
            findings=None,
            source_execution_id=None,
            created_by=uuid.UUID(int=2),
        )

    stamped, bare = _note(), _note()
    # Whatever the model grows, the digest preimage must not. Set the SEC
    # attributes on the instance (plain attributes until the columns exist).
    for name, value in {
        "author_principal_kind": "agent",
        "author_agent_id": uuid.UUID(int=3),
        "pinned_by": uuid.UUID(int=4),
        "pinned_at": datetime(2026, 11, 2, tzinfo=timezone.utc),
    }.items():
        setattr(stamped, name, value)
    assert SNAPSHOT_FIELDS == (
        "content", "title", "pinned", "card_id", "kind", "failure_class", "findings",
        "source_execution_id",
    )
    assert set(snapshot(stamped)) == set(SNAPSHOT_FIELDS)
    assert revision_digest(snapshot(stamped)) == revision_digest(snapshot(bare))


# --- R8 legacy rows -----------------------------------------------------------


async def test_get_legacy_pinned_note_returns_null_stamps(
    client, db_session, test_user, test_workspace, test_board
):
    legacy = await _insert_legacy_pinned_note(db_session, test_workspace, test_board, test_user)
    body = await _read_note(client, legacy.id, test_board)
    assert not _missing(body), f"NoteRead lacks {_missing(body)}"
    assert body["pinned"] is True
    assert {field: body[field] for field in ATTRIBUTION_FIELDS} == dict.fromkeys(ATTRIBUTION_FIELDS)


async def test_render_board_definition_includes_legacy_pinned_note(
    db_session, test_user, test_workspace, test_board
):
    legacy = await _insert_legacy_pinned_note(db_session, test_workspace, test_board, test_user)
    rendered = render_board_definition(None, [legacy])
    assert "Legacy pinned" in rendered
    assert LEGACY_CONTENT in rendered


@pytest.mark.parametrize("scope", ["workspace", "board"])
async def test_agent_edit_of_legacy_pinned_note_forbidden(
    scope, agent_actor, client, db_session, test_user, test_workspace, test_board
):
    legacy = await _insert_legacy_pinned_note(db_session, test_workspace, test_board, test_user)
    board = test_board if scope == "board" else None
    before = await _read_note(client, legacy.id, board)
    url = _note_url(legacy.id, board)
    refused = await agent_actor.client.put(url, json={"title": "Agent rewrite"})
    assert refused.status_code == 403, refused.text
    refused_unpin = await agent_actor.client.post(
        url + "/edit", json={"mode": "replace", "pinned": False}
    )
    assert refused_unpin.status_code == 403, refused_unpin.text
    after = await _read_note(client, legacy.id, board)
    assert after["pinned"] is True
    assert _unchanged(before, after), (before, after)


async def test_agent_delete_of_legacy_pinned_note_forbidden(
    agent_actor, client, db_session, test_user, test_workspace, test_board
):
    legacy = await _insert_legacy_pinned_note(db_session, test_workspace, test_board, test_user)
    refused = await agent_actor.client.delete(_note_url(legacy.id, test_board))
    assert refused.status_code == 403, refused.text
    after = await _read_note(client, legacy.id, test_board)
    assert after["pinned"] is True, "a legacy pinned note is never auto-unpinned"
