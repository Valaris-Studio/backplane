# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime, timedelta

from sqlalchemy import bindparam, func, or_, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import selectinload

from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.repositories.base import BaseRepository
from app.utils import utcnow

# A "needs prompt" badge driven by a month-old skipped execution is stale, so
# bounding the scan by recency costs no useful signal and keeps this
# every-board-view query from growing with append-only execution history.
SKIPPED_BADGE_HORIZON = timedelta(days=30)


class ExecutionRepository(BaseRepository[AgentExecution]):
    model = AgentExecution

    async def update(self, instance: AgentExecution, **kwargs) -> AgentExecution:
        for key, value in kwargs.items():
            setattr(instance, key, value)
        await self.db.flush()
        await self.db.refresh(instance)
        # Eager-load relationship after refresh so lazy="raise" doesn't trigger
        await self.db.refresh(instance, attribute_names=["tool_invocations"])
        return instance

    async def create(self, **kwargs) -> AgentExecution:
        instance = AgentExecution(**kwargs)
        self.db.add(instance)
        await self.db.flush()
        await self.db.refresh(instance)
        await self.db.refresh(instance, attribute_names=["tool_invocations"])
        return instance

    async def get_by_id(self, id: uuid.UUID) -> AgentExecution | None:
        result = await self.db.execute(
            select(AgentExecution)
            .where(AgentExecution.id == id)
            .options(selectinload(AgentExecution.tool_invocations))
        )
        return result.scalar_one_or_none()

    async def list_inflight_by_agent(self, agent_id: uuid.UUID) -> list[AgentExecution]:
        result = await self.db.execute(
            select(AgentExecution)
            .where(
                AgentExecution.agent_id == agent_id,
                AgentExecution.status.in_(
                    (ExecutionStatus.started, ExecutionStatus.running)
                ),
            )
            .options(selectinload(AgentExecution.tool_invocations))
        )
        return list(result.scalars().all())

    async def list_inflight_by_workspace(
        self, workspace_id: uuid.UUID
    ) -> list[AgentExecution]:
        """Every genuinely in-flight execution in the workspace — status in
        {started,running} AND completed_at IS NULL. NO limit: the "who's working
        now" surfaces must never lose an active row behind a page of completed
        rows (the newest-first 50-row window would otherwise hide it)."""
        result = await self.db.execute(
            select(AgentExecution)
            .where(
                AgentExecution.workspace_id == workspace_id,
                AgentExecution.status.in_(
                    (ExecutionStatus.started, ExecutionStatus.running)
                ),
                AgentExecution.completed_at.is_(None),
            )
            .options(selectinload(AgentExecution.tool_invocations))
            .order_by(AgentExecution.started_at.desc())
        )
        return list(result.scalars().all())

    async def has_inflight_loop_iteration(self, board_id: uuid.UUID) -> bool:
        """Board-scoped in-flight probe: an unfinished loop_iteration on THIS
        board. Same belt-and-braces predicate as list_inflight_by_workspace —
        status in {started,running} AND completed_at IS NULL."""
        result = await self.db.execute(
            select(AgentExecution.id)
            .where(
                AgentExecution.board_id == board_id,
                AgentExecution.action == "loop_iteration",
                AgentExecution.status.in_(
                    (ExecutionStatus.started, ExecutionStatus.running)
                ),
                AgentExecution.completed_at.is_(None),
            )
            .limit(1)
        )
        return result.scalar_one_or_none() is not None

    async def latest_loop_iteration(self, board_id: uuid.UUID) -> AgentExecution | None:
        result = await self.db.execute(
            select(AgentExecution)
            .where(
                AgentExecution.board_id == board_id,
                AgentExecution.action == "loop_iteration",
            )
            .order_by(AgentExecution.started_at.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def list_by_agent(
        self,
        agent_id: uuid.UUID,
        limit: int = 50,
        role: str | None = None,
        offset: int = 0,
        with_tool_invocations: bool = True,
    ) -> list[AgentExecution]:
        stmt = select(AgentExecution).where(AgentExecution.agent_id == agent_id)
        if with_tool_invocations:
            stmt = stmt.options(selectinload(AgentExecution.tool_invocations))
        if role:
            stmt = stmt.where(AgentExecution.role == role)
        # `id` breaks ties on started_at for the same reason as the workspace
        # page query: same-second rows would otherwise repeat or skip across pages.
        stmt = (
            stmt.order_by(AgentExecution.started_at.desc(), AgentExecution.id.desc())
            .limit(limit)
            .offset(offset)
        )
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    @staticmethod
    def _list_by_card_stmt(
        *,
        workspace_id: uuid.UUID,
        card_id: uuid.UUID,
        dialect_name: str,
        limit: int = 200,
    ):
        """Newest-first select of executions touching `card_id`, dialect-split so
        the SQL prefilter is index-served where possible.

        Postgres: `cards_affected @> '["<card>"]'` — JSONB containment served by
        the GIN index on the column (migration 075). The card id is JSON-serialized
        into a one-element array, so the operator is a true membership test (no
        substring collision) and the LHS is the bare column so the GIN index applies.

        Other dialects (SQLite test backend — no JSONB/GIN): the portable
        `coalesce(cast(cards_affected AS TEXT), '') LIKE '%<card>%'` prefilter, the
        same trick metrics.py uses for allowed_workspaces. It can over-match on a
        substring collision, which the Python post-filter in `list_by_card` corrects.

        Split out as a pure builder so a compiled-SQL test can pin the operator per
        dialect without a live database."""
        card_str = str(card_id)
        if dialect_name == "postgresql":
            card_filter = AgentExecution.cards_affected.op("@>", return_type=JSONB)(
                bindparam("cards_affected_card", [card_str], type_=JSONB)
            )
        else:
            from sqlalchemy import String as SAString

            card_filter = func.coalesce(
                AgentExecution.cards_affected.cast(SAString), ""
            ).contains(card_str)
        return (
            select(AgentExecution)
            .where(AgentExecution.workspace_id == workspace_id, card_filter)
            .options(selectinload(AgentExecution.tool_invocations))
            .order_by(AgentExecution.started_at.desc())
            .limit(limit)
        )

    async def list_by_card(
        self,
        workspace_id: uuid.UUID,
        card_id: uuid.UUID,
        limit: int = 200,
    ) -> list[AgentExecution]:
        """Every execution that touched a card, newest-first. The SQL prefilter is
        dialect-split (see `_list_by_card_stmt`): GIN-served JSONB `@>` on Postgres,
        portable text-cast LIKE on SQLite. The Python exact-match post-filter runs on
        both — it's the sole membership guard for the text-scan branch and a cheap
        no-op backstop for `@>`. The limit is generous (a full pipeline is ~5-10
        stages) and card-scoped, so a done card's history is never hidden behind the
        workspace-wide 50-row window — the bug this method exists to fix."""
        card_str = str(card_id)
        dialect_name = self.db.bind.dialect.name if self.db.bind is not None else ""
        stmt = self._list_by_card_stmt(
            workspace_id=workspace_id,
            card_id=card_id,
            dialect_name=dialect_name,
            limit=limit,
        )
        result = await self.db.execute(stmt)
        return [
            e
            for e in result.scalars().all()
            if e.cards_affected and card_str in e.cards_affected
        ]

    async def skipped_card_ids(self, workspace_id: uuid.UUID) -> list[str]:
        """Every distinct card id touched by a recent `skipped` execution in the
        workspace. Selecting only the JSON `cards_affected` column (no rows,
        no relationships) and flattening in Python keeps this portable across
        PostgreSQL and SQLite. NO row limit — like `list_inflight_by_workspace`,
        a "needs prompt" card must never hide behind a page window; the board
        renders one badge per id, so completeness matters more than paging.
        The scan is bounded by recency instead: executions are append-only, so
        an unbounded scan grows forever on an endpoint every board view hits."""
        result = await self.db.execute(
            select(AgentExecution.cards_affected).where(
                AgentExecution.workspace_id == workspace_id,
                AgentExecution.status == ExecutionStatus.skipped,
                AgentExecution.started_at >= utcnow() - SKIPPED_BADGE_HORIZON,
            )
        )
        seen: dict[str, None] = {}
        for (cards,) in result.all():
            for raw in cards or []:
                seen[str(raw)] = None
        return list(seen)

    def _workspace_filters(
        self,
        workspace_id: uuid.UUID,
        status: str | None = None,
        agent_id: uuid.UUID | None = None,
        role: str | None = None,
        board_id: uuid.UUID | None = None,
        action: str | None = None,
        outcome: str | None = None,
        q: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
    ) -> list:
        """The WHERE clauses shared by the page query and its unpaged count.

        Keeping them in one place is what makes `X-Total-Count` honest: a
        second hand-written filter list would drift and the UI would render
        "showing 20 of <wrong>".
        """
        filters = [AgentExecution.workspace_id == workspace_id]
        if status:
            filters.append(AgentExecution.status == status)
        if agent_id:
            filters.append(AgentExecution.agent_id == agent_id)
        if role:
            filters.append(AgentExecution.role == role)
        if board_id:
            filters.append(AgentExecution.board_id == board_id)
        if action:
            filters.append(AgentExecution.action == action)
        if outcome:
            # The runner encodes a loop iteration's outcome as an
            # `outcome=<value>` token at the head of output_summary
            # (runner/internal/workloop/loopmode.go), so this matches the
            # TOKEN, never a bare substring — a plain LIKE '%worked%' would
            # also match every summary whose prose happens to say "worked".
            filters.append(AgentExecution.output_summary.ilike(f"%outcome={outcome}%"))
        if q:
            # The iteration number lives in input_summary ("loop iteration 7")
            # while the outcome and prose live in output_summary, so a useful
            # search has to read both.
            term = f"%{q}%"
            filters.append(
                or_(
                    AgentExecution.input_summary.ilike(term),
                    AgentExecution.output_summary.ilike(term),
                )
            )
        if since:
            filters.append(AgentExecution.started_at >= since)
        if until:
            filters.append(AgentExecution.started_at <= until)
        return filters

    async def list_by_workspace(
        self,
        workspace_id: uuid.UUID,
        limit: int = 50,
        status: str | None = None,
        agent_id: uuid.UUID | None = None,
        role: str | None = None,
        board_id: uuid.UUID | None = None,
        action: str | None = None,
        outcome: str | None = None,
        q: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        offset: int = 0,
        with_tool_invocations: bool = True,
    ) -> list[AgentExecution]:
        stmt = (
            select(AgentExecution)
            .where(
                *self._workspace_filters(
                    workspace_id,
                    status=status,
                    agent_id=agent_id,
                    role=role,
                    board_id=board_id,
                    action=action,
                    outcome=outcome,
                    q=q,
                    since=since,
                    until=until,
                )
            )
        )
        # The eager load is what makes a 50-row page N+1-free when the caller
        # needs tool_invocations — and pure overhead (a second query plus the
        # rows) when it asked for the trimmed `summary=true` shape.
        if with_tool_invocations:
            stmt = stmt.options(selectinload(AgentExecution.tool_invocations))
        # `id` breaks ties on started_at: rows written in the same second (the
        # SQLite test DB's resolution, and possible in prod for fast
        # iterations) would otherwise page non-deterministically and could
        # repeat or skip rows across pages.
        stmt = (
            stmt.order_by(
                AgentExecution.started_at.desc(),
                AgentExecution.id.desc(),
            )
            .limit(limit)
            .offset(offset)
        )
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def count_by_workspace(
        self,
        workspace_id: uuid.UUID,
        status: str | None = None,
        agent_id: uuid.UUID | None = None,
        role: str | None = None,
        board_id: uuid.UUID | None = None,
        action: str | None = None,
        outcome: str | None = None,
        q: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
    ) -> int:
        """The count BEFORE limit/offset, so the UI can say "showing N of M"
        without walking every page to discover how deep the history goes."""
        result = await self.db.execute(
            select(func.count())
            .select_from(AgentExecution)
            .where(
                *self._workspace_filters(
                    workspace_id,
                    status=status,
                    agent_id=agent_id,
                    role=role,
                    board_id=board_id,
                    action=action,
                    outcome=outcome,
                    q=q,
                    since=since,
                    until=until,
                )
            )
        )
        return int(result.scalar_one())

    async def loop_iteration_stats_by_template(
        self, workspace_id: uuid.UUID, template_key: str
    ) -> dict:
        """Aggregate a loop template's iterations — the profile track record.

        Keyed on the `loop-template:` stamp in `prompt_slug`, which is written
        at execution start and never rewritten, so the numbers survive a
        detach, a rebind and a version upgrade. The match is EXACT: the
        version is part of the stamp, so a v1 run is never credited to v2.

        `outcomes` is deliberately absent — the outcome lives as a text token
        at the head of `output_summary`, and parsing it is the service's job
        (this layer stays pure data access). The summaries come back with the
        rows so the caller needs no second query.
        """
        totals = (
            await self.db.execute(
                select(
                    func.count(AgentExecution.id),
                    func.coalesce(func.sum(AgentExecution.cost_usd), 0.0),
                    func.coalesce(func.sum(AgentExecution.duration_seconds), 0.0),
                    func.max(AgentExecution.started_at),
                ).where(
                    AgentExecution.workspace_id == workspace_id,
                    AgentExecution.action == "loop_iteration",
                    AgentExecution.prompt_slug == template_key,
                )
            )
        ).one()

        per_board = (
            await self.db.execute(
                select(
                    AgentExecution.board_id,
                    func.count(AgentExecution.id),
                    func.coalesce(func.sum(AgentExecution.cost_usd), 0.0),
                )
                .where(
                    AgentExecution.workspace_id == workspace_id,
                    AgentExecution.action == "loop_iteration",
                    AgentExecution.prompt_slug == template_key,
                    AgentExecution.board_id.is_not(None),
                )
                .group_by(AgentExecution.board_id)
            )
        ).all()

        summaries = (
            await self.db.execute(
                select(AgentExecution.output_summary).where(
                    AgentExecution.workspace_id == workspace_id,
                    AgentExecution.action == "loop_iteration",
                    AgentExecution.prompt_slug == template_key,
                )
            )
        ).scalars()

        return {
            "iterations": int(totals[0]),
            "spent_usd": float(totals[1]),
            "duration_seconds_total": float(totals[2]),
            "last_used_at": totals[3],
            "boards": [
                {
                    "board_id": row[0],
                    "iterations": int(row[1]),
                    "spent_usd": float(row[2]),
                }
                for row in per_board
            ],
            "output_summaries": list(summaries),
        }
