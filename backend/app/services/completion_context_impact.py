# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from app.exceptions import ResourceNotFoundError
from app.repositories.agents.prompt_config import PromptConfigRepository
from app.repositories.completion_context import CompletionContextRepository
from app.repositories.notes.note import NoteRepository
from app.services.completion_policy import CompletionPolicyService


class CompletionContextImpactService:
    def __init__(self, db):
        self.db = db
        self.repo = CompletionContextRepository(db)

    async def read(self, workspace_id, actor_id, source_kind, source_id):
        policy = CompletionPolicyService(self.db)
        await policy.authorize(workspace_id, actor_id)
        note = None
        if source_kind == "note":
            note = await NoteRepository(self.db).get_by_id(source_id)
            if note is None or note.workspace_id != workspace_id:
                raise ResourceNotFoundError("Note not found")
        if source_kind == "prompt":
            prompt = await PromptConfigRepository(self.db).get_by_id(source_id)
            if prompt is None or prompt.workspace_id not in (None, workspace_id):
                raise ResourceNotFoundError("Prompt not found")
        attempts = []
        for attempt in await self.repo.active_attempts(workspace_id):
            manifest = attempt.context_manifest
            bound = manifest is not None and any(
                value["kind"] == source_kind and value["id"] == str(source_id)
                for value in manifest
            )
            if source_kind == "configuration":
                bound = source_id is None or source_id == attempt.board_id
            elif source_kind == "definition":
                bound = source_id == attempt.board_id
            elif source_kind == "note":
                bound = bound or (note.pinned and (note.board_id is None or note.board_id == attempt.board_id))
            elif manifest is None and source_kind == "prompt":
                # Older leases have no source provenance. Surface uncertainty
                # rather than claim this edit is safe.
                bound = True
            if not bound:
                continue
            await policy.get_board(attempt.board_id, workspace_id, actor_id)
            attempts.append({"attempt_id": str(attempt.id), "execution_id": str(attempt.execution_id),
                             "board_id": str(attempt.board_id), "kind": attempt.kind,
                             "role": attempt.role, "expires_at": attempt.expires_at,
                             "binding_known": manifest is not None})
        return {"attempts": attempts}
