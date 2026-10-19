# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from app.exceptions import ResourceNotFoundError
from app.repositories.notes.history import NoteHistoryRepository
from app.schemas.notes.history import NoteRevisionSummary
from app.services.notes.history_access import NoteHistoryAccess
from app.services.notes.history_content import NoteHistoryContent

_NOTE_TOOLS = {"create_note", "update_note", "append_note", "replace_note_section"}


class NoteHistoryService:
    def __init__(self, db):
        self.repo = NoteHistoryRepository(db)
        self.access = NoteHistoryAccess(db)
        self.content = NoteHistoryContent(db)

    async def _summaries(self, revisions, workspace_id):
        outcomes = await self.access.repo.outcomes({row.invocation_id for row in revisions if row.invocation_id})
        result = []
        for row in revisions:
            outcome = outcomes.get(row.invocation_id)
            actor = row.actor or {}
            matches = outcome is not None and (
                str(outcome.owner_id) == actor.get("user_id")
                and (str(outcome.agent_id) if outcome.agent_id else None) == actor.get("agent_id")
                and outcome.workspace_id == workspace_id
                and outcome.tool_name in _NOTE_TOOLS
                and outcome.scope_status == "authorized"
                # A legacy split call can commit metadata before its body
                # operation fails. Correlation never asserts overall success.
                and outcome.status in {"completed", "failed", "aborted"}
            )
            result.append({
                **{name: getattr(row, name) for name in NoteRevisionSummary.model_fields if name != "channel"},
                "channel": "mcp_reported" if matches else "unconfirmed",
            })
        return result

    async def list(self, note_id, workspace_id, user_id, *, board_id=None, limit=50, before_revision=None):
        await self.access.note_scope(note_id, workspace_id, user_id, board_id=board_id)
        rows = await self.repo.list(note_id, limit + 1, before_revision)
        latest, first = await self.repo.latest(note_id), await self.repo.first(note_id)
        items = await self._summaries(rows[:limit], workspace_id)
        await self.access.note_scope(note_id, workspace_id, user_id, board_id=board_id)
        return {
            "items": items,
            "next_before_revision": rows[limit - 1].revision if len(rows) > limit else None,
            "latest_recorded_revision": latest.revision if latest else 0,
            "capture_boundary": {"first_revision": first.revision, "capture_kind": first.capture_kind} if first else None,
        }

    async def _detail(self, note_id, revision, workspace_id):
        row = await self.repo.get(note_id, revision, with_snapshot=True)
        if row is None:
            raise ResourceNotFoundError("Note revision not found")
        snapshot = await self.content.reconstruct(row)
        return {**(await self._summaries([row], workspace_id))[0], "snapshot": snapshot}

    async def detail(self, note_id, revision, workspace_id, user_id, *, board_id=None):
        await self.access.note_scope(note_id, workspace_id, user_id, board_id=board_id)
        try:
            result = await self._detail(note_id, revision, workspace_id)
        finally:
            # A read may wait on storage, including one that becomes unavailable.
            # Current deletion/revocation takes precedence over a storage error.
            await self.access.note_scope(note_id, workspace_id, user_id, board_id=board_id)
        return result

    async def compare(self, note_id, from_revision, to_revision, workspace_id, user_id, *, board_id=None):
        await self.access.note_scope(note_id, workspace_id, user_id, board_id=board_id)
        try:
            before = await self._detail(note_id, from_revision, workspace_id)
            after = before if from_revision == to_revision else await self._detail(note_id, to_revision, workspace_id)
        finally:
            await self.access.note_scope(note_id, workspace_id, user_id, board_id=board_id)
        return {"before": before, "after": after, "changed_fields": [
            key for key in before["snapshot"] if before["snapshot"][key] != after["snapshot"][key]
        ]}
