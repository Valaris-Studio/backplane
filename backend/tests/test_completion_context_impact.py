# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from app.models.notes.note import Note
from app.models.kanban.completion import CompletionAttempt
from sqlalchemy import select
from tests.test_completion_execution_boundaries import _claim, _configure_role
from tests.test_postmerge_acceptance import completion_fixture

__all__ = ["completion_fixture"]


async def test_edit_impact_lists_only_active_bound_attempts(client, agent_client, completion_fixture):
    f = completion_fixture
    await _configure_role(f)
    note = Note(workspace_id=f.board.workspace_id, board_id=f.board.id,
                title="Private bound context", content="DO_NOT_RETURN_CONTEXT", pinned=True,
                created_by=f.card.created_by)
    f.db.add(note)
    await f.db.flush()
    work = await _claim(agent_client, f)
    result = await client.get("/api/workspaces/default/config/completion-context-impact",
                              params={"source_kind": "note", "source_id": str(note.id)})
    assert result.status_code == 200, result.text
    assert result.json()["attempts"][0]["execution_id"] == work["execution_id"]
    assert "DO_NOT_RETURN_CONTEXT" not in result.text
    assert "Private bound context" not in result.text
    note.pinned = False
    attempt = await f.db.scalar(select(CompletionAttempt).where(CompletionAttempt.execution_id == uuid.UUID(work["execution_id"])))
    attempt.context_manifest = None
    await f.db.flush()
    unbound = await client.get("/api/workspaces/default/config/completion-context-impact",
                               params={"source_kind": "note", "source_id": str(note.id)})
    # Old attempts have no manifest and cannot bind an unpinned note by inference.
    assert unbound.json()["attempts"] == []


async def test_edit_impact_rejects_foreign_note_identity(client, test_workspace, test_note):
    import uuid
    result = await client.get("/api/workspaces/default/config/completion-context-impact",
                              params={"source_kind": "note", "source_id": str(uuid.uuid4())})
    assert result.status_code == 404


async def test_manifest_binds_unpinned_configured_card_notes(client, completion_fixture):
    from types import SimpleNamespace
    from app.services.completion_context import completion_context_manifest, changed_context_sources

    f = completion_fixture
    note = Note(workspace_id=f.board.workspace_id, board_id=f.board.id, card_id=f.card.id,
                title="Unpinned evidence", content="first version", pinned=False, kind="user_note",
                created_by=f.card.created_by)
    f.db.add(note)
    await f.db.flush()
    dispatch = SimpleNamespace(prompt=None, provider="codex-cli", model="review", tool_policy={},
                               stage={"context_sources": [{"kind": "card_notes", "filter": {"kind": "user_note", "limit": 1}}]}, pipeline_stages=[])
    before = await completion_context_manifest(f.db, f.board, dispatch, {"context": "first"}, card=f.card)
    assert any(item["kind"] == "note" and item["id"] == str(note.id) for item in before)
    note.content = "second version"
    await f.db.flush()
    after = await completion_context_manifest(f.db, f.board, dispatch, {"context": "second"}, card=f.card)
    assert changed_context_sources(before, after) == [{"kind": "note", "id": str(note.id), "change": "changed"}]


async def test_full_execution_limit_is_separate_from_mandatory_limit(agent_client, completion_fixture):
    from unittest.mock import AsyncMock, patch
    from app.models.agents.prompt_config import AgentPromptConfig
    from app.services.completion_context import assemble_mandatory_completion_context
    from tests.test_postmerge_acceptance import submit, status

    f = completion_fixture
    await _configure_role(f)
    prompt = await f.db.scalar(select(AgentPromptConfig).where(AgentPromptConfig.slug == "operator-assessment"))
    prompt.content = "é" * (140 * 1024)
    await f.db.flush()
    _, report = await assemble_mandatory_completion_context(f.db, f.board, f.board.completion_policy)
    assert report["within_limit"]
    with patch("app.services.kanban.reconciler.board_scoped_pr_status", new=AsyncMock(return_value=status())):
        await submit(agent_client, f)
        response = await agent_client.post(f"{f.url}/work/claim", json={"capabilities": {
            "providers": ["codex-cli", "claude-cli"], "exact_checkout": True, "argv_checks": True,
        }})
    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "completion_context_too_large"
    assert "256 KiB" in response.json()["detail"]
    assert await f.db.scalar(select(CompletionAttempt)) is None
