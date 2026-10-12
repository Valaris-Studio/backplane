# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import unicodedata
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

# card.status is free text and agents sometimes write progress prose into it, so a
# busy column can carry one distinct ~255-char status per card (a real board had
# 164 in one column, ~31K chars of the briefing). Keep the most common few, fold
# the long tail into one count, and clip each key.
STATUS_DISTRIBUTION_TOP_N = 8
STATUS_KEY_MAX_CHARS = 60
OTHER_STATUS_KEY = "_other"
NO_STATUS_KEY = "null"


_ZERO_WIDTH_JOINER = "\u200d"


def _extends_previous_character(char: str) -> bool:
    """True for code points that belong to the cluster before them: combining
    marks, variation selectors, emoji skin-tone modifiers and tag characters."""
    return (
        unicodedata.category(char) in ("Mn", "Me")
        or "\U0001f3fb" <= char <= "\U0001f3ff"
        or "\U000e0020" <= char <= "\U000e007f"
    )


def _status_key(status: str | None) -> str:
    if not status:
        return NO_STATUS_KEY
    if len(status) <= STATUS_KEY_MAX_CHARS:
        return status
    # Back the cut off to a cluster boundary, so a ZWJ emoji sequence or an
    # accented letter is dropped whole rather than split before the ellipsis.
    cut = STATUS_KEY_MAX_CHARS - 1
    while cut > 0 and (
        _extends_previous_character(status[cut])
        or status[cut] == _ZERO_WIDTH_JOINER
        or status[cut - 1] == _ZERO_WIDTH_JOINER
    ):
        cut -= 1
    return status[:cut] + "…"


def bounded_status_distribution(statuses: list[str | None]) -> dict[str, int]:
    counts = Counter(_status_key(s) for s in statuses)
    # A lone tail entry costs no more than the "_other" bucket that would replace it.
    if len(counts) <= STATUS_DISTRIBUTION_TOP_N + 1:
        return dict(counts)
    # A card literally titled "_other" joins the bucket rather than taking a top slot.
    literal_other_count = counts.pop(OTHER_STATUS_KEY, 0)
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    distribution = dict(ranked[:STATUS_DISTRIBUTION_TOP_N])
    tail_count = sum(count for _, count in ranked[STATUS_DISTRIBUTION_TOP_N:])
    distribution[OTHER_STATUS_KEY] = literal_other_count + tail_count
    return distribution


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

            column_summaries.append(
                ColumnSummary(
                    id=col.id,
                    name=col.name,
                    color=col.color,
                    column_type=col.column_type.value if col.column_type else None,
                    position=col.position,
                    card_count=card_count,
                    priority_distribution=dict(priority_counts),
                    status_distribution=bounded_status_distribution(
                        [c.status for c in cards]
                    ),
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
