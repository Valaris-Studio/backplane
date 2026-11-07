# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.exceptions import ForbiddenError, ResourceNotFoundError
from app.repositories.kanban.board import BoardRepository
from app.repositories.workspace_config import WorkspaceConfigRepository
from app.schemas.kanban.card_context import ContextSnapshotManifest, ContextSnapshotRead
from app.services.agents.context_snapshot import SnapshotSelection
from app.services.agents.guarded_context_assembly import assemble_stage_context
from app.services.notes.history_access import NoteHistoryAccess

BOOTSTRAP_SOURCE_KINDS = (
    "board_definition", "pinned_notes", "card_notes", "linked_cards", "execution_history",
)


class CardContextService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def snapshot(self, *, card, board_id: uuid.UUID, workspace_id: uuid.UUID, reader_id: uuid.UUID):
        principal = await NoteHistoryAccess(self.db).authorize(workspace_id, reader_id)
        if principal is None:
            raise ForbiddenError("An authenticated reader is required")
        board = await BoardRepository(self.db).get_by_id(board_id)
        if not board or board.workspace_id != workspace_id or card.board_id != board_id:
            raise ResourceNotFoundError("Card not found", error_code="card_not_found")
        config = await WorkspaceConfigRepository(self.db).get_by_workspace(workspace_id)
        stored = config.pipeline_config if config and isinstance(config.pipeline_config, dict) else {}
        sources = [{"kind": kind} for kind in BOOTSTRAP_SOURCE_KINDS]
        stage = {"role": "bootstrap", "llm": {"context_sources": sources}}
        # A request-local profile opts into the existing budget engine without
        # writing pipeline configuration or requiring any execution/stage record.
        pipeline = {"context_budget": stored.get("context_budget", {}), "stages": [stage]}
        trace = SnapshotSelection()
        assembled = await assemble_stage_context(
            self.db, pipeline=pipeline, role="bootstrap", workspace_id=workspace_id,
            card=card, board=board, sources=sources, stage=stage, snapshot=trace,
        )
        ceilings = settings.CONTEXT_BUDGET_CEILINGS
        omissions, omissions_summary = trace.bounded_omissions(ceilings)
        return ContextSnapshotRead(
            principal_kind=principal["principal_kind"],
            blocks=trace.blocks,
            manifest=ContextSnapshotManifest(
                inclusions=[trace.identity(block) for block in trace.blocks],
                omissions=omissions,
                omissions_summary=omissions_summary,
                limits={
                    **assembled.selection.policy.as_dict(),
                    "max_diagnostic_entries": ceilings.max_diagnostic_entries,
                    "max_diagnostic_bytes": ceilings.max_diagnostic_bytes,
                },
            ),
        )
