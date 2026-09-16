# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from collections import Counter

from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ResourceNotFoundError
from app.repositories.definitions.definition import DefinitionRepository
from app.repositories.git.git_repo import GitRepoRepository
from app.repositories.kanban.board import BoardRepository
from app.repositories.notes.note import NoteRepository
from app.schemas.kanban.board_context import (
    ActivitySummary,
    BoardContextRead,
    BoardSummary,
    ColumnSummary,
    DefinitionSummary,
    GitRepoSummary,
    NoteSummary,
)
from app.services.activity import ActivityService


class BoardContextService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.board_repo = BoardRepository(db)
        self.definition_repo = DefinitionRepository(db)
        self.note_repo = NoteRepository(db)
        self.git_repo_repo = GitRepoRepository(db)
        self.activity_service = ActivityService(db)

    async def get_context(
        self, board_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> BoardContextRead:
        board = await self.board_repo.get_full_board(board_id)
        if not board or board.workspace_id != workspace_id:
            raise ResourceNotFoundError("Board not found")

        column_summaries = []
        total_cards = 0
        for col in board.columns:
            cards = col.cards
            card_count = len(cards)
            total_cards += card_count

            priority_counts = Counter(
                (c.priority.value if c.priority else "none") for c in cards
            )
            status_counts = Counter(
                (c.status if c.status else "null") for c in cards
            )

            column_summaries.append(
                ColumnSummary(
                    id=col.id,
                    name=col.name,
                    color=col.color,
                    column_type=col.column_type.value if col.column_type else None,
                    position=col.position,
                    card_count=card_count,
                    priority_distribution=dict(priority_counts),
                    status_distribution=dict(status_counts),
                )
            )

        board_summary = BoardSummary(
            id=board.id,
            name=board.name,
            description=board.description,
            tags=board.tags or [],
            total_cards=total_cards,
            columns=column_summaries,
        )

        definition = await self.definition_repo.get_by_board(board_id)
        definition_summary = (
            DefinitionSummary.model_validate(definition) if definition else None
        )

        notes = await self.note_repo.list_by_board(board_id)
        note_summaries = [NoteSummary.model_validate(n) for n in notes]

        git_repos = await self.git_repo_repo.list_by_board(board_id)
        git_repo_summaries = [GitRepoSummary.model_validate(r) for r in git_repos]

        activities = await self.activity_service.list_board_activity(
            board_id, limit=20
        )
        activity_summaries = [ActivitySummary.model_validate(a) for a in activities]

        return BoardContextRead(
            board=board_summary,
            definition=definition_summary,
            notes=note_summaries,
            git_repos=git_repo_summaries,
            recent_activity=activity_summaries,
        )
