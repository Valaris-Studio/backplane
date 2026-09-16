# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.execution import AgentExecution
from app.models.kanban.completion import CompletionAttempt, CompletionCandidate


class CompletionCandidateRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def candidate(self, board_id, candidate_id):
        return await self.db.scalar(
            select(CompletionCandidate).where(
                CompletionCandidate.id == candidate_id,
                CompletionCandidate.board_id == board_id,
            )
        )

    async def current(self, board_id, card_id, *, lock=False):
        stmt = select(CompletionCandidate).where(
            CompletionCandidate.board_id == board_id,
            CompletionCandidate.card_id == card_id,
            CompletionCandidate.is_current.is_(True),
        )
        if lock:
            stmt = stmt.with_for_update().execution_options(populate_existing=True)
        return await self.db.scalar(stmt)

    async def board_candidates(self, board_id):
        return list(
            (
                await self.db.scalars(
                    select(CompletionCandidate)
                    .where(
                        CompletionCandidate.board_id == board_id,
                        CompletionCandidate.is_current.is_(True),
                    )
                    .order_by(CompletionCandidate.created_at, CompletionCandidate.id)
                )
            ).all()
        )

    async def workflow_page(
        self, board_id, *, cursor=None, limit=100, invalid_candidate_ids=()
    ):
        ranked = (
            select(
                CompletionCandidate.id,
                func.row_number()
                .over(
                    partition_by=CompletionCandidate.card_id,
                    order_by=(
                        CompletionCandidate.is_current.desc(),
                        CompletionCandidate.created_at.desc(),
                        CompletionCandidate.id.desc(),
                    ),
                )
                .label("rank"),
            )
            .where(CompletionCandidate.board_id == board_id)
            .subquery()
        )
        priority = case(
            (
                or_(
                    CompletionCandidate.is_current.is_(False),
                    CompletionCandidate.id.in_(invalid_candidate_ids),
                ),
                0,
            ),
            (
                CompletionCandidate.status.in_(
                    ("awaiting_review", "awaiting_validation", "awaiting_merge")
                ),
                1,
            ),
            (CompletionCandidate.status == "accepted", 2),
            else_=0,
        )
        query = (
            select(CompletionCandidate, priority.label("priority"))
            .join(
                ranked,
                ranked.c.id == CompletionCandidate.id,
            )
            .where(ranked.c.rank == 1)
        )
        if cursor is not None:
            after_priority, after_card = cursor
            query = query.where(
                or_(
                    priority > after_priority,
                    and_(
                        priority == after_priority,
                        CompletionCandidate.card_id > after_card,
                    ),
                )
            )
        return list(
            (
                await self.db.execute(
                    query.order_by(priority, CompletionCandidate.card_id).limit(
                        limit + 1
                    )
                )
            ).all()
        )

    async def latest_attempts(self, candidate_ids):
        if not candidate_ids:
            return {}
        ranked = (
            select(
                CompletionAttempt.id,
                func.row_number()
                .over(
                    partition_by=CompletionAttempt.candidate_id,
                    order_by=(
                        CompletionAttempt.created_at.desc(),
                        CompletionAttempt.id.desc(),
                    ),
                )
                .label("rank"),
            )
            .where(CompletionAttempt.candidate_id.in_(candidate_ids))
            .subquery()
        )
        rows = await self.db.scalars(
            select(CompletionAttempt)
            .join(
                ranked,
                ranked.c.id == CompletionAttempt.id,
            )
            .where(ranked.c.rank == 1)
        )
        return {row.candidate_id: row for row in rows}

    async def history(self, board_id, card_id):
        return list(
            (
                await self.db.scalars(
                    select(CompletionCandidate)
                    .where(
                        CompletionCandidate.board_id == board_id,
                        CompletionCandidate.card_id == card_id,
                    )
                    .order_by(CompletionCandidate.created_at.desc())
                    .limit(20)
                )
            ).all()
        )

    async def attempt(self, board_id, attempt_id, *, lock=False):
        stmt = select(CompletionAttempt).where(
            CompletionAttempt.board_id == board_id, CompletionAttempt.id == attempt_id
        )
        if lock:
            stmt = stmt.with_for_update().execution_options(populate_existing=True)
        return await self.db.scalar(stmt)

    async def attempts(self, candidate_ids):
        if not candidate_ids:
            return []
        return list(
            (
                await self.db.scalars(
                    select(CompletionAttempt)
                    .where(
                        CompletionAttempt.candidate_id.in_(candidate_ids),
                    )
                    .order_by(CompletionAttempt.created_at.desc())
                    .limit(100)
                )
            ).all()
        )

    async def active_attempt(self, candidate_id, *, lock=True):
        query = select(CompletionAttempt)
        query = query.where(
            CompletionAttempt.candidate_id == candidate_id,
            CompletionAttempt.status == "claimed",
        )
        if lock:
            query = query.with_for_update()
        return await self.db.scalar(query)

    async def source_execution(self, execution_id, workspace_id, board_id, agent_id):
        return await self.db.scalar(
            select(AgentExecution).where(
                AgentExecution.id == execution_id,
                AgentExecution.workspace_id == workspace_id,
                AgentExecution.board_id == board_id,
                AgentExecution.agent_id == agent_id,
            )
        )

    async def execution(self, execution_id):
        return await self.db.get(AgentExecution, execution_id)

    async def create_candidate(self, **values):
        candidate = CompletionCandidate(**values)
        self.db.add(candidate)
        await self.db.flush()
        await self.db.refresh(candidate)
        return candidate

    async def create_execution(self, **values):
        execution = AgentExecution(**values)
        self.db.add(execution)
        await self.db.flush()
        await self.db.refresh(execution)
        return execution

    async def create_attempt(self, **values):
        attempt = CompletionAttempt(**values)
        self.db.add(attempt)
        await self.db.flush()
        await self.db.refresh(attempt)
        return attempt

    async def update(self, row, **values):
        for key, value in values.items():
            setattr(row, key, value)
        await self.db.flush()
        await self.db.refresh(row)
        return row
