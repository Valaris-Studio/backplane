# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import logging
import uuid
from datetime import datetime, timedelta, date

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.exceptions import ResourceNotFoundError
from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.kanban.card import Card
from app.utils import utcnow
from app.repositories.kanban.board import BoardRepository
from app.config import settings
from app.repositories.merge_queue import MergeQueueRepository
from app.services.merge_queue import MERGE_QUEUE_STALE
from app.services.reviews.stuck_loop import NEEDS_ADVISOR_LABEL
from app.schemas.kanban.board_health import (
    BoardHealthRead,
    CardBriefInfo,
    MergeQueueHealth,
    OverdueCardInfo,
    StaleCardInfo,
    StaleMergeQueueEntryInfo,
)

# States a merge-queue entry can sit in while still expecting the worker to act.
# merged/failed/conflict/blocked_pending_consolidation are terminal or already
# operator-visible, so they never count as stuck.
_MERGE_QUEUE_ACTIVE_STATES = ("queued", "merging")

logger = logging.getLogger(__name__)


class BoardHealthService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.board_repo = BoardRepository(db)
        self.merge_queue_repo = MergeQueueRepository(db)

    async def escalate_stale_cards(
        self, board_id: uuid.UUID, workspace_id: uuid.UUID, actor_id: uuid.UUID,
    ) -> list[dict]:
        """Move stale cards back to To Do and remove hero participants."""
        from app.services.kanban.freeze_guard import assert_board_not_frozen

        await assert_board_not_frozen(self.db, board_id)
        health = await self.get_health(board_id, workspace_id)
        if not health.stale_cards:
            return []

        from app.services.kanban.card import CardService
        from app.repositories.kanban.card import CardRepository
        from app.schemas.kanban.card import CardMoveRequest

        card_service = CardService(self.db)
        card_repo = CardRepository(self.db)

        board = await self.board_repo.get_full_board(board_id)
        columns_sorted = sorted(board.columns, key=lambda c: c.position)
        todo_column = next((c for c in columns_sorted if c.name == "To Do"), None)

        escalated = []
        for stale in health.stale_cards:
            card_id = stale.id
            actions = []

            hero = await card_repo.get_hero(card_id)
            if hero:
                await card_service.remove_participant(
                    card_id, board_id, hero.user_id,
                    workspace_id=workspace_id, actor_id=actor_id,
                )
                actions.append("unassigned_hero")

            if todo_column:
                await card_service.move_card(
                    card_id, board_id,
                    CardMoveRequest(column_id=todo_column.id, position=1024.0),
                    workspace_id=workspace_id, actor_id=actor_id,
                )
                actions.append("moved_to_todo")

            escalated.append({
                "card_id": str(card_id),
                "title": stale.title,
                "days_stale": stale.days_stale,
                "actions": actions,
            })

        return escalated

    async def get_health(self, board_id: uuid.UUID, workspace_id: uuid.UUID) -> BoardHealthRead:
        board = await self.board_repo.get_full_board(board_id)
        if not board or board.workspace_id != workspace_id:
            raise ResourceNotFoundError("Board not found")

        columns_sorted = sorted(board.columns, key=lambda c: c.position)
        all_cards: list[Card] = []
        column_name_map: dict[uuid.UUID, str] = {}
        for col in columns_sorted:
            column_name_map[col.id] = col.name
            all_cards.extend(col.cards)

        total_cards = len(all_cards)
        if total_cards == 0:
            return BoardHealthRead(
                health_score=100,
                total_cards=0,
                stale_cards=[],
                overdue_cards=[],
                unassigned_cards=[],
                cards_without_priority=[],
                cards_without_description=[],
                parked_cards=[],
                priority_distribution={},
                column_distribution={col.name: 0 for col in columns_sorted},
                velocity_7d=0,
                velocity_30d=0,
                agent_efficiency_score=None,
                handoff_friction_hours=None,
                reversion_rate=None,
                merge_queue=await self._compute_merge_queue_health(board_id),
            )

        now = utcnow()
        today = date.today()
        stale_cutoff = now - timedelta(hours=48)

        # Determine "in progress" columns (not first or last)
        in_progress_column_ids: set[uuid.UUID] = set()
        if len(columns_sorted) > 2:
            for col in columns_sorted[1:-1]:
                in_progress_column_ids.add(col.id)

        # Build card brief helper
        def _card_brief(card: Card) -> CardBriefInfo:
            return CardBriefInfo(
                id=card.id,
                title=card.title,
                column_name=column_name_map[card.column_id],
                priority=card.priority.value if hasattr(card.priority, "value") else str(card.priority),
                created_at=card.created_at,
            )

        # Collect metrics in one pass
        overdue_cards: list[OverdueCardInfo] = []
        unassigned_cards: list[CardBriefInfo] = []
        cards_without_priority: list[CardBriefInfo] = []
        cards_without_description: list[CardBriefInfo] = []
        parked_cards: list[CardBriefInfo] = []
        priority_distribution: dict[str, int] = {}
        column_distribution: dict[str, int] = {col.name: 0 for col in columns_sorted}

        hero_count = 0
        described_count = 0
        prioritized_count = 0
        in_progress_card_ids: list[uuid.UUID] = []

        for card in all_cards:
            brief = _card_brief(card)
            priority_val = card.priority.value if hasattr(card.priority, "value") else str(card.priority)

            # Priority distribution
            priority_distribution[priority_val] = priority_distribution.get(priority_val, 0) + 1

            # Column distribution
            col_name = column_name_map[card.column_id]
            column_distribution[col_name] = column_distribution.get(col_name, 0) + 1

            # Priority check
            if priority_val != "none":
                prioritized_count += 1
            else:
                cards_without_priority.append(brief)

            # Description check
            if card.description and card.description.strip():
                described_count += 1
            else:
                cards_without_description.append(brief)

            # Hero assignee check
            has_hero = any(p.role == "hero" for p in card.participants)
            if has_hero:
                hero_count += 1
            else:
                unassigned_cards.append(brief)

            # Parked by the stuck-loop detector: routing state, not a hygiene
            # defect — surfaced for operators but excluded from the score.
            if NEEDS_ADVISOR_LABEL in (card.labels or []):
                parked_cards.append(brief)

            # Overdue check
            if card.due_date and card.due_date < today:
                days_overdue = (today - card.due_date).days
                overdue_cards.append(OverdueCardInfo(
                    **brief.model_dump(),
                    due_date=card.due_date,
                    days_overdue=days_overdue,
                ))

            # Track in-progress cards for stale detection
            if card.column_id in in_progress_column_ids:
                in_progress_card_ids.append(card.id)

        # Stale detection: batch query last activity for in-progress cards
        stale_cards: list[StaleCardInfo] = []
        if in_progress_card_ids:
            last_activity_map = await self._get_last_activity_map(in_progress_card_ids)
            for card in all_cards:
                if card.column_id not in in_progress_column_ids:
                    continue
                last_activity_at = last_activity_map.get(card.id)
                # Strip tz if present — all comparisons use naive UTC
                cmp_activity = last_activity_at.replace(tzinfo=None) if last_activity_at and last_activity_at.tzinfo else last_activity_at
                if cmp_activity is None or cmp_activity < stale_cutoff:
                    reference = last_activity_at or card.created_at
                    if reference.tzinfo is not None:
                        reference = reference.replace(tzinfo=None)
                    days_stale = max(0, (now - reference).days)
                    brief = _card_brief(card)
                    stale_cards.append(StaleCardInfo(
                        **brief.model_dump(),
                        last_activity_at=last_activity_at,
                        days_stale=days_stale,
                    ))

        # Velocity: count "moved" activities to last column in 7d and 30d
        last_column_id = columns_sorted[-1].id if columns_sorted else None
        velocity_7d = 0
        velocity_30d = 0
        if last_column_id:
            velocity_30d = await self._count_velocity(board_id, last_column_id, now - timedelta(days=30))
            velocity_7d = await self._count_velocity(board_id, last_column_id, now - timedelta(days=7))

        # Health score
        health_score = self._compute_health_score(
            total_cards=total_cards,
            prioritized_count=prioritized_count,
            hero_count=hero_count,
            described_count=described_count,
            overdue_count=len(overdue_cards),
            stale_count=len(stale_cards),
            column_distribution=column_distribution,
        )

        # Extended agent metrics
        agent_efficiency = await self._compute_agent_efficiency(board_id)
        handoff_friction = await self._compute_handoff_friction(board_id)
        column_positions = {col.id: i for i, col in enumerate(columns_sorted)}
        reversion_rate = await self._compute_reversion_rate(board_id, column_positions)
        merge_queue = await self._compute_merge_queue_health(board_id)

        return BoardHealthRead(
            health_score=health_score,
            total_cards=total_cards,
            stale_cards=stale_cards,
            overdue_cards=overdue_cards,
            unassigned_cards=unassigned_cards,
            cards_without_priority=cards_without_priority,
            cards_without_description=cards_without_description,
            parked_cards=parked_cards,
            priority_distribution=priority_distribution,
            column_distribution=column_distribution,
            velocity_7d=velocity_7d,
            velocity_30d=velocity_30d,
            agent_efficiency_score=agent_efficiency,
            handoff_friction_hours=handoff_friction,
            reversion_rate=reversion_rate,
            merge_queue=merge_queue,
        )

    async def _compute_merge_queue_health(self, board_id: uuid.UUID) -> MergeQueueHealth:
        entries = await self.merge_queue_repo.list_board_active(
            board_id=board_id, states=_MERGE_QUEUE_ACTIVE_STATES
        )
        if not entries:
            return MergeQueueHealth(
                active_count=0, oldest_queued_age_seconds=None, stale_entries=[]
            )

        now = utcnow()
        threshold = settings.MERGE_QUEUE_STALE_THRESHOLD_SECONDS

        def _age_seconds(entry) -> int:
            # first_enqueued_at, not enqueued_at: the latter is the FIFO
            # position and re_enqueue bumps it on every retry, so measuring
            # from it kept a continuously-churning entry permanently "fresh".
            # NULL means the row predates migration 088 — fall back.
            origin = entry.first_enqueued_at or entry.enqueued_at
            if origin.tzinfo is not None:
                origin = origin.replace(tzinfo=None)
            return max(0, int((now - origin).total_seconds()))

        stale_entries = [
            StaleMergeQueueEntryInfo(
                entry_id=entry.id,
                card_id=entry.card_id,
                state=entry.state,
                attempt_count=entry.attempt_count,
                age_seconds=age,
                error_message=entry.error_message,
                classification=(
                    "entry_failing"
                    if entry.attempt_count > 0 or entry.error_message
                    else "worker_stalled"
                ),
            )
            for entry, age in ((entry, _age_seconds(entry)) for entry in entries)
            if age >= threshold
        ]

        await self._notify_newly_stale(board_id, entries, stale_entries, now)

        return MergeQueueHealth(
            active_count=len(entries),
            oldest_queued_age_seconds=max(_age_seconds(entry) for entry in entries),
            stale_entries=stale_entries,
        )

    async def _notify_newly_stale(
        self,
        board_id: uuid.UUID,
        entries: list,
        stale_entries: list[StaleMergeQueueEntryInfo],
        now: datetime,
    ) -> None:
        """Push a merge_queue.stale event the first time an entry goes stale.

        Board health is pull-only, so a wedged queue is invisible to an operator
        who is not looking at it -- the 2aa905f incident's real failure mode.
        The event fires once per entry: the health field keeps reporting the
        entry on every poll, but the notification does not repeat.
        """
        if not stale_entries:
            return

        entries_by_id = {entry.id: entry for entry in entries}
        for stale in stale_entries:
            entry = entries_by_id[stale.entry_id]
            claimed = await self.merge_queue_repo.claim_stale_notification(
                entry.id, now=now
            )
            if not claimed:
                continue
            payload = {
                "entry_id": str(entry.id),
                "card_id": str(entry.card_id),
                "board_id": str(board_id),
                "repo_id": str(entry.repo_id),
                "integration_branch": entry.integration_branch,
                "pr_url": entry.pr_url,
                "state": stale.state,
                "attempt_count": stale.attempt_count,
                "age_seconds": stale.age_seconds,
                "classification": stale.classification,
            }
            if stale.error_message is not None:
                payload["error_message"] = stale.error_message
            try:
                await event_bus.publish(
                    event_type=MERGE_QUEUE_STALE,
                    payload=payload,
                    workspace_id=entry.workspace_id,
                )
            except Exception:
                # The latch is already stamped and is NOT released: losing this
                # event is preferable to re-notifying on every subsequent poll,
                # and board health still reports the entry on the pull path.
                logger.exception(
                    "Failed to publish %s for entry %s", MERGE_QUEUE_STALE, entry.id
                )

    async def _compute_agent_efficiency(self, board_id: uuid.UUID) -> float | None:
        """Ratio of completed executions to total executions for this board."""
        stmt = (
            select(
                func.count().filter(AgentExecution.status == ExecutionStatus.completed),
                func.count(),
            )
            .where(AgentExecution.board_id == board_id)
        )
        result = await self.db.execute(stmt)
        row = result.one()
        completed, total = row[0], row[1]
        if total == 0:
            return None
        return round(completed / total, 3)

    async def _compute_handoff_friction(self, board_id: uuid.UUID) -> float | None:
        """Avg hours between agent-initiated move and next human action on same card."""
        # Get agent-initiated moves (activities with agent_id set)
        agent_moves_stmt = (
            select(Activity)
            .where(
                Activity.board_id == board_id,
                Activity.agent_id.isnot(None),
                Activity.action == ActivityAction.moved,
                Activity.entity_type == ActivityEntityType.card,
            )
            .order_by(Activity.created_at)
        )
        result = await self.db.execute(agent_moves_stmt)
        agent_moves = list(result.scalars().all())

        if not agent_moves:
            return None

        # For each agent move, find the next human action on the same card
        frictions: list[float] = []
        for move in agent_moves:
            human_followup_stmt = (
                select(Activity.created_at)
                .where(
                    Activity.board_id == board_id,
                    Activity.entity_id == move.entity_id,
                    Activity.entity_type == ActivityEntityType.card,
                    Activity.agent_id.is_(None),
                    Activity.created_at > move.created_at,
                )
                .order_by(Activity.created_at)
                .limit(1)
            )
            followup_result = await self.db.execute(human_followup_stmt)
            followup_at = followup_result.scalar_one_or_none()
            if followup_at:
                move_time = move.created_at
                if move_time.tzinfo is not None:
                    move_time = move_time.replace(tzinfo=None)
                if followup_at.tzinfo is not None:
                    followup_at = followup_at.replace(tzinfo=None)
                hours = (followup_at - move_time).total_seconds() / 3600
                frictions.append(hours)

        if not frictions:
            return None
        return round(sum(frictions) / len(frictions), 1)

    async def _compute_reversion_rate(
        self, board_id: uuid.UUID, column_positions: dict[uuid.UUID, int]
    ) -> float | None:
        """Ratio of backward moves to total moves in last 30 days."""
        since = utcnow() - timedelta(days=30)
        stmt = (
            select(Activity)
            .where(
                Activity.board_id == board_id,
                Activity.action == ActivityAction.moved,
                Activity.entity_type == ActivityEntityType.card,
                Activity.created_at >= since,
            )
        )
        result = await self.db.execute(stmt)
        moves = list(result.scalars().all())

        if not moves:
            return None

        backward_count = 0
        for move in moves:
            if not move.changes:
                continue
            col_change = move.changes.get("column_id", {})
            from_col_id = col_change.get("old")
            to_col_id = col_change.get("new")
            if not from_col_id or not to_col_id:
                continue
            from_pos = None
            to_pos = None
            for col_id, pos in column_positions.items():
                if str(col_id) == from_col_id:
                    from_pos = pos
                if str(col_id) == to_col_id:
                    to_pos = pos
            if from_pos is not None and to_pos is not None and to_pos < from_pos:
                backward_count += 1

        return round(backward_count / len(moves), 3)

    async def _get_last_activity_map(self, card_ids: list[uuid.UUID]) -> dict[uuid.UUID, datetime]:
        """Get the most recent activity timestamp for each card."""
        stmt = (
            select(Activity.entity_id, func.max(Activity.created_at))
            .where(
                Activity.entity_type == ActivityEntityType.card,
                Activity.entity_id.in_(card_ids),
            )
            .group_by(Activity.entity_id)
        )
        result = await self.db.execute(stmt)
        return {row[0]: row[1] for row in result.all()}

    async def _count_velocity(
        self, board_id: uuid.UUID, last_column_id: uuid.UUID, since: datetime
    ) -> int:
        """Count cards moved to the last column (done) since the given datetime."""
        stmt = (
            select(func.count())
            .select_from(Activity)
            .where(
                Activity.board_id == board_id,
                Activity.action == ActivityAction.moved,
                Activity.entity_type == ActivityEntityType.card,
                Activity.created_at >= since,
            )
        )
        result = await self.db.execute(stmt)
        all_moves = result.scalar_one()

        # Filter by checking `changes` JSON for `to_column` matching last_column_id
        # SQLite and Postgres handle JSON differently, so query all and filter in Python
        if all_moves == 0:
            return 0

        stmt_full = (
            select(Activity)
            .where(
                Activity.board_id == board_id,
                Activity.action == ActivityAction.moved,
                Activity.entity_type == ActivityEntityType.card,
                Activity.created_at >= since,
            )
        )
        result = await self.db.execute(stmt_full)
        activities = result.scalars().all()

        count = 0
        last_col_str = str(last_column_id)
        for activity in activities:
            if not activity.changes:
                continue
            col_change = activity.changes.get("column_id", {})
            if col_change.get("new") == last_col_str:
                count += 1
        return count

    @staticmethod
    def _compute_health_score(
        total_cards: int,
        prioritized_count: int,
        hero_count: int,
        described_count: int,
        overdue_count: int,
        stale_count: int,
        column_distribution: dict[str, int],
    ) -> int:
        if total_cards == 0:
            return 100

        # Priority: 20 points
        priority_score = 20 * (prioritized_count / total_cards)

        # Hero assignee: 20 points
        hero_score = 20 * (hero_count / total_cards)

        # Description: 15 points
        description_score = 15 * (described_count / total_cards)

        # Overdue ratio < 10%: 15 points (proportional)
        overdue_ratio = overdue_count / total_cards
        if overdue_ratio >= 0.10:
            overdue_score = 0.0
        else:
            overdue_score = 15 * (1 - overdue_ratio / 0.10)

        # Stale ratio < 15%: 15 points (proportional)
        stale_ratio = stale_count / total_cards
        if stale_ratio >= 0.15:
            stale_score = 0.0
        else:
            stale_score = 15 * (1 - stale_ratio / 0.15)

        # Balanced columns: 15 points (no column > 50% of cards)
        if column_distribution:
            max_in_column = max(column_distribution.values())
            if max_in_column > total_cards * 0.5:
                balance_score = 0.0
            else:
                balance_score = 15.0
        else:
            balance_score = 15.0

        total_score = priority_score + hero_score + description_score + overdue_score + stale_score + balance_score
        return round(total_score)
