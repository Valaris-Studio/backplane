# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from app.models.kanban.column import ColumnType
from app.repositories.kanban.completion_dependencies import (
    CompletionDependencyRepository,
)
from app.services.completion import CompletionService
from app.services.completion_policy import CompletionPolicyService


class CompletionDependencyService:
    def __init__(self, db):
        self.db = db
        self.repo = CompletionDependencyRepository(db)
        self.completion = CompletionService(db)
        self.policy = CompletionPolicyService(db)

    async def edges(self, **scope):
        from app.services.kanban.card import _card_dependencies_table_exists

        if not await _card_dependencies_table_exists(self.db):
            return []
        return await self.repo.edges(**scope)

    async def satisfied_ids(self, card_ids, *, workspace_id=None):
        if not card_ids:
            return set()
        satisfied = set()
        policies = {}
        for card, board, column_type in await self.repo.cards(
            card_ids=card_ids, workspace_id=workspace_id
        ):
            if board.id not in policies:
                policies[board.id] = await self.policy.effective_policy(board)
            policy = policies[board.id]
            if policy is None:
                if column_type == ColumnType.done:
                    satisfied.add(card.id)
            elif (
                policy.dependency_release == "accepted"
                or column_type == ColumnType.done
            ) and await self.completion.is_accepted(board, card):
                satisfied.add(card.id)
        return satisfied

    async def accepted_ids(self, *, card_ids=None, board_id=None, workspace_id=None):
        accepted = set()
        for card, board, _ in await self.repo.cards(
            card_ids=card_ids,
            board_id=board_id,
            workspace_id=workspace_id,
            accepted_only=True,
        ):
            if await self.completion.is_accepted(board, card):
                accepted.add(card.id)
        return accepted

    async def blocked_ids(self, *, card_ids=None, board_id=None, workspace_id=None):
        edges = await self.edges(
            card_ids=card_ids, board_id=board_id, workspace_id=workspace_id
        )
        satisfied = await self.satisfied_ids(
            {target for _, target in edges}, workspace_id=workspace_id
        )
        return {source for source, target in edges if target not in satisfied}

    async def source_work_allowed(
        self, card_id, *, workspace_id, require_dependencies, lock=False
    ):
        if lock:
            await self.repo.lock_workspace(workspace_id)
        rows = await self.repo.cards(
            card_ids={card_id}, workspace_id=workspace_id, fresh=lock
        )
        if not rows:
            return False
        edges = (
            await self.edges(card_ids={card_id}, workspace_id=workspace_id)
            if require_dependencies
            else []
        )
        if lock:
            await self.repo.lock_cards(
                workspace_id, {card_id} | {target for _, target in edges}
            )
        if card_id in await self.accepted_ids(
            card_ids={card_id}, workspace_id=workspace_id
        ):
            return False
        satisfied = await self.satisfied_ids(
            {target for _, target in edges}, workspace_id=workspace_id
        )
        return all(target in satisfied for _, target in edges)
