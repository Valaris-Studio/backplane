# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Independent HTTP fixture for context receipts; no provider is dispatched."""

import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.database import get_db
from app.main import create_app
from app.models.agents.agent import Agent, AgentType
from app.models.notes.note import Note
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.models.workspace_config import WorkspaceConfig
from tests.conftest import _raw_api_key
from tests.routers.agents.test_assignments import (
    _add_team_role,
    _make_card,
    _make_repo,
    _make_typed_columns,
)

ROLE = "continuity_keeper_47"
ALIAS = "ReviewedHandoff_47"
KIND = "operator_handoff"
STAMP = datetime(2026, 1, 2, 3, 4, 5)


def sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def document(text):
    return {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": text}]},
    ]}


def note_revision(note):
    stored = note["content"]
    try:
        parsed = json.loads(stored)
    except (json.JSONDecodeError, ValueError):
        parsed = None
    content = parsed if isinstance(parsed, dict) and parsed.get("type") == "doc" else stored
    payload = {
        "title": note["title"], "content": content,
        "kind": note["kind"], "pinned": note["pinned"],
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256("backplane.note-revision.v1\0" + canonical)


@dataclass
class ReceiptCase:
    http: AsyncClient
    factory: object
    workspace: dict
    foreign_workspace: dict
    board_id: str
    card_id: str
    other_card_id: str
    recipient_id: str
    agent_id: str
    other_agent_id: str
    headers: dict
    notes: list[dict]

    def execution_path(self, execution_id):
        return f"/api/workspaces/{self.workspace['slug']}/executions/{execution_id}"

    async def assignment(self):
        response = await self.http.post(
            f"/api/workspaces/{self.workspace['slug']}/agents/{self.agent_id}/next-assignment",
            json={"board_id": self.board_id}, headers=self.headers["agent"],
        )
        assert response.status_code == 200, response.text
        assert response.json()["card"]["id"] == self.card_id
        return response.json()

    def start_payload(self, assignment, **changes):
        return {
            "workspace_slug": self.workspace["slug"], "board_id": self.board_id,
            "card_id": self.card_id, "role": ROLE, "action": "continue_project",
            "input_summary": "Synthetic context receipt qualification",
            "reservation_id": assignment["reservation"]["id"], **changes,
        }

    async def start(self, assignment, **changes):
        response = await self.http.post(
            f"/api/agents/{self.agent_id}/executions",
            json=self.start_payload(assignment, **changes), headers=self.headers["agent"],
        )
        assert response.status_code == 201, response.text
        return response.json()

    def receipt_payload(self, context, *, key=None, prompt=None):
        return {
            "client_request_id": key or str(uuid.uuid4()),
            # The fallback lets baseline tests reach the actual missing endpoint,
            # instead of all failing at the assignment's absent additive field.
            "context_revision": context.get("context_revision", "0" * 64),
            "input_prompt": prompt if prompt is not None else
                "Continue this synthetic project.\n" + context["context"][ALIAS],
            "system_prompt": "Use the configured project context. 🧪",
            "provider": "operator-provider", "model": "operator-model",
        }

    async def prepare(self, execution, context, **changes):
        return await self.http.post(
            self.execution_path(execution["id"]) + "/context-receipts",
            json=self.receipt_payload(context, **changes), headers=self.headers["agent"],
        )

    async def receipt(self, execution, receipt_id, actor="recipient"):
        return await self.http.get(
            self.execution_path(execution["id"]) + f"/context-receipts/{receipt_id}",
            headers=self.headers[actor],
        )


@pytest_asyncio.fixture(name="receipt_case")
async def _receipt_case_fixture(db_engine, db_session, test_user, second_user, test_workspace, test_board):
    columns = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, columns["backlog"], test_user)
    other_card = await _make_card(db_session, test_board, columns["done"], test_user)
    db_session.add(WorkspaceMember(
        workspace_id=test_workspace.id, user_id=second_user.id, role=WorkspaceRole.member,
    ))
    foreign = Workspace(name="Foreign", slug="foreign", created_by=test_user.id)
    db_session.add(foreign)
    await db_session.flush()
    db_session.add(WorkspaceMember(
        workspace_id=foreign.id, user_id=second_user.id, role=WorkspaceRole.member,
    ))
    outsider = User(email="outsider@example.test", name="Unrelated owner")
    db_session.add(outsider)
    await db_session.flush()
    headers = {}
    agents = {}
    for label, owner in [("curator", test_user), ("recipient", second_user),
                         ("agent", second_user), ("other_agent", second_user),
                         ("outsider", outsider)]:
        key, raw = _raw_api_key(owner, label)
        db_session.add(key)
        await db_session.flush()
        headers[label] = {"Authorization": "Bearer " + raw}
        if label in {"agent", "other_agent"}:
            agent = Agent(name=label, agent_type=AgentType.coding,
                          created_by_id=owner.id, api_key_id=key.id,
                          allowed_workspaces=[test_workspace.slug])
            db_session.add(agent)
            await db_session.flush()
            agents[label] = agent
    await _add_team_role(db_session, test_workspace, agents["agent"], second_user, ROLE)
    sources = [
        {"kind": "card_notes", "as": ALIAS, "filter": {"limit": 3}},
        {"kind": "card_notes", "as": "KindOnly", "filter": {"kind": KIND, "limit": 3}},
        {"kind": "card_notes", "as": "RepeatedAlias47", "filter": {"kind": KIND, "limit": 3}},
    ]
    stage = {
        "role": ROLE, "unique": True,
        "discover": {"strategy": "column_scan", "column_type": "backlog"},
        "claim": {"participant_role": "hero", "execution_action": "continue_project"},
        "git": {"action": "none"},
        "llm": {"enabled": True, "stage": "continue_project", "provider": "claude-cli",
                "model": "premium", "post_process_kind": "produces_note",
                "context_sources": sources},
    }
    db_session.add(WorkspaceConfig(
        workspace_id=test_workspace.id, pipeline_config={"version": 1, "stages": [stage]},
    ))
    notes = []
    for number, title, text, kind, pinned, created in [
        (1, "First", "Evidência 🧪 <literal>", KIND, False, STAMP),
        (2, "Pinned", "Keep the complete booking rule.", KIND, True, STAMP),
        (3, "Newest", "Adjacent intervals are allowed.", "another_kind", False,
         STAMP + timedelta(seconds=1)),
    ]:
        content = json.dumps(document(text), ensure_ascii=False, separators=(",", ":"))
        note = Note(id=uuid.UUID(int=number), workspace_id=test_workspace.id,
                    board_id=test_board.id, card_id=card.id, title=title, content=content,
                    kind=kind, pinned=pinned, created_by=test_user.id,
                    created_at=created, updated_at=created)
        db_session.add(note)
        notes.append({"id": str(note.id), "title": title, "content": content,
                      "text": text, "kind": kind, "pinned": pinned,
                      "updated_at": created.isoformat() + "+00:00"})
    db_session.add(Note(workspace_id=test_workspace.id, board_id=test_board.id,
                        card_id=other_card.id, title="Not selected", content="PRIVATE_OTHER_CARD",
                        created_by=test_user.id))
    await db_session.commit()
    factory = async_sessionmaker(db_engine, expire_on_commit=False)
    app = create_app()

    async def transaction():
        async with factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = transaction
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield ReceiptCase(
            http=http, factory=factory,
            workspace={"id": str(test_workspace.id), "slug": test_workspace.slug},
            foreign_workspace={"id": str(foreign.id), "slug": foreign.slug},
            board_id=str(test_board.id), card_id=str(card.id), other_card_id=str(other_card.id),
            recipient_id=str(second_user.id), agent_id=str(agents["agent"].id),
            other_agent_id=str(agents["other_agent"].id), headers=headers, notes=notes,
        )
