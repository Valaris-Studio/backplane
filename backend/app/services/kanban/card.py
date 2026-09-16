# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import logging
import uuid
from collections.abc import Iterable
from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.exceptions import (
    BadGatewayError,
    ConflictError,
    ResourceNotFoundError,
    ValidationError,
)
from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.kanban.card import Card, CardDependency
from app.models.kanban.column import Column, ColumnType
from app.repositories.git.git_repo import GitRepoRepository
from app.repositories.kanban.board import BoardRepository
from app.repositories.kanban.card import CardRepository
from app.repositories.kanban.column import ColumnRepository
from app.repositories.user import UserRepository
from app.schemas.kanban.card import CardCreate, CardMoveRequest, CardUpdate
from app.services.activity import ActivityService
from app.services.completion_policy import CompletionPolicyService
from app.utils import utcnow
from app.services.github_client import (  # noqa: F401 — patched by tests
    ForgeAuthError,
    GitHubClient,
    PRStatus,
    is_github_pr_url,
)
from app.services.kanban.freeze_guard import assert_board_not_frozen
from app.services.kanban.labels import stamp_label
from app.services.kanban.pr_extract import extract_pr_url
from app.services.notes.content_serializer import prosemirror_to_markdown
from app.services.kanban.snapshots import snapshot_card
from app.services.mentions.notify import notify_new_mentions

logger = logging.getLogger(__name__)

# Label stamped on a card when the Done-gate could not verify PR-merged status
# (GitHub unavailable after retries). The move is allowed to unblock the runner;
# the marker is the audit trail. Re-verification on a future move is a follow-up.
VERIFICATION_DEFERRED_LABEL = "verification-deferred"

# Label stamped when the card's PR url is a non-GitHub forge (Gitea/GitLab):
# PR-merged status gating is OFF for those until a forge-native status client
# lands (the runner owns the real merge), so the Done-gate soft-passes rather
# than crash on the github-only get_pr_status (cell #12, sibling of cell #11).
MERGE_GATE_UNSUPPORTED_FORGE_LABEL = "merge-gate-forge-unsupported"


async def attach_pending_approvals(
    db: AsyncSession,
    cards: Iterable[Card],
    *,
    workspace_id: uuid.UUID | None = None,
) -> None:
    """Annotate each Card with transient `has_pending_approval` + `pending_approval_id`.

    One batched SELECT covers N cards (see `CardRepository.pending_approvals_by_card`).
    The attributes are *not* mapped columns — they're set directly on the
    instance so Pydantic's `from_attributes=True` picks them up during
    response serialization. No N+1.

    Cards whose column is `done`-typed are forced to `has_pending_approval =
    False` even when an approval row still claims them (card 50016881):
    once a card lands in Done the approval is moot, and a still-pending
    row is a stuck artifact of a runner that died mid-cycle. The card
    surface should track the operator's mental model, not the table.
    """
    card_list = [c for c in cards if c is not None]
    if not card_list:
        return

    repo = CardRepository(db)
    mapping = await repo.pending_approvals_by_card(
        {c.id for c in card_list}, workspace_id=workspace_id
    )
    done_column_ids = await _done_column_ids(db, {c.column_id for c in card_list})
    for card in card_list:
        if card.column_id in done_column_ids:
            card.has_pending_approval = False
            card.pending_approval_id = None
            continue
        approval_id = mapping.get(card.id)
        card.has_pending_approval = approval_id is not None
        card.pending_approval_id = approval_id


async def _done_column_ids(
    db: AsyncSession, column_ids: set[uuid.UUID]
) -> set[uuid.UUID]:
    """Return the subset of `column_ids` whose `column_type` is `done`."""
    if not column_ids:
        return set()
    result = await db.execute(
        select(Column.id).where(
            Column.id.in_(column_ids),
            Column.column_type == ColumnType.done,
        )
    )
    return {row for row in result.scalars().all()}


# AgentExecution statuses that mean "work is in flight on this card right now".
# `completed_at IS NULL` is enforced alongside so a status stuck at `running`
# due to a crashed tick doesn't keep the indicator lit forever — the shipping
# lifecycle sets completed_at on every terminal transition.
_ACTIVE_EXECUTION_STATUSES: frozenset[ExecutionStatus] = frozenset(
    {ExecutionStatus.started, ExecutionStatus.running}
)

# How recently an in-flight execution must have started to still count as
# 'active' presence. Longer than any normal stage (so real long-running work is
# never suppressed), shorter than the 45min stale-execution reap (so a crashed
# runner's zombie row stops masking heartbeat staleness well before cleanup).
ACTIVE_PRESENCE_HORIZON = timedelta(minutes=20)

# Label the runner stamps on a card it budget-suspends mid-implementation
# (runner/internal/workloop/budget_suspend.go:budgetSuspendedLabel). A card
# carrying it with no live execution is parked, not working — it derives the
# `suspended` presence so the board shows a paused badge. Kept in sync with the
# Go constant by name; both are board state, no migration.
BUDGET_SUSPENDED_LABEL = "budget-suspended"


async def attach_agent_presence(
    db: AsyncSession,
    cards: Iterable[Card],
) -> None:
    """Annotate each Card with `agent_presence`, `active_execution_id`, `last_agent_activity_at`.

    Two batched SELECTs (executions + activities) cover any number of cards.
    The card-linkage resolution for `cards_affected` happens in Python so we
    stay dialect-neutral — SQLite's JSON type has no portable list-containment
    operator, and the pending-approvals repo already established this pattern.
    The working set per board is small (pending approvals + in-flight runs +
    latest activity per card), so the Python loop is negligible.

    Precedence: active > touched > eligible > none.
    `last_agent_activity_at` is independent of the state enum — a card can be
    `active` AND expose a past activity timestamp for sort ordering.
    """
    card_list = [c for c in cards if c is not None]
    if not card_list:
        return

    card_ids = {c.id for c in card_list}
    target_id_strs = {str(cid) for cid in card_ids}
    board_ids = {c.board_id for c in card_list}

    # --- 1. In-flight executions. cards_affected is a JSON list of card-id
    # strings; resolve membership in Python across dialects.
    #
    # Recency horizon: a crashed runner leaves a started/running row with
    # completed_at=NULL, and reaping only fires on the next reservation attempt
    # (past 45min). Without a started_at floor such a zombie would pin the card
    # 'active' indefinitely and the "working overrides stale" badge would mask a
    # genuinely dead runner. We only treat an execution as 'active' if it started
    # within ACTIVE_PRESENCE_HORIZON; older in-flight rows fall through to the
    # heartbeat/activity-derived state. The horizon is comfortably longer than a
    # normal stage so real long-running work is never suppressed, and shorter
    # than the 45min reap so crash visibility returns well before cleanup.
    horizon_start = utcnow() - ACTIVE_PRESENCE_HORIZON
    execution_stmt = select(AgentExecution.id, AgentExecution.cards_affected).where(
        AgentExecution.board_id.in_(board_ids),
        AgentExecution.status.in_(_ACTIVE_EXECUTION_STATUSES),
        AgentExecution.completed_at.is_(None),
        AgentExecution.started_at >= horizon_start,
    )
    exec_result = await db.execute(execution_stmt)
    active_by_card: dict[uuid.UUID, uuid.UUID] = {}
    for execution_id, cards_affected in exec_result.all():
        if not isinstance(cards_affected, list):
            continue
        for raw in cards_affected:
            if not isinstance(raw, str):
                continue
            if raw not in target_id_strs:
                continue
            # First execution seen wins; a card shouldn't be under two
            # concurrent runs but if it is, the active-indicator still flips on.
            active_by_card.setdefault(uuid.UUID(raw), execution_id)

    # --- 2. Latest agent-originated activity timestamp per card.
    activity_stmt = (
        select(Activity.entity_id, func.max(Activity.created_at))
        .where(
            Activity.entity_type == ActivityEntityType.card,
            Activity.entity_id.in_(card_ids),
            Activity.agent_id.isnot(None),
        )
        .group_by(Activity.entity_id)
    )
    activity_result = await db.execute(activity_stmt)
    latest_activity_by_card: dict[uuid.UUID, datetime] = dict(activity_result.all())

    for card in card_list:
        active_exec = active_by_card.get(card.id)
        latest = latest_activity_by_card.get(card.id)
        has_agent_participant = any(
            p.agent_id is not None for p in (card.participants or [])
        )

        # A budget-suspended card is PARKED mid-implementation, not working. It
        # routinely keeps a stale hero (the re-claim race) and an activity row
        # (the suspend stamped its labels), which would otherwise read as
        # `eligible`/`touched` — making a paused card look like live-ish work the
        # operator has to decode. Surface `suspended` as its own state so the
        # board renders a distinct paused badge. A LIVE execution still wins
        # (`active`): a suspended card that got re-claimed and is mid-tick right
        # now is genuinely working again, and the truth (a running execution)
        # always trumps the parked label.
        is_suspended = BUDGET_SUSPENDED_LABEL in (card.labels or [])

        if active_exec is not None:
            presence = "active"
        elif is_suspended:
            presence = "suspended"
        elif latest is not None:
            presence = "touched"
        elif has_agent_participant:
            presence = "eligible"
        else:
            presence = "none"

        card.agent_presence = presence
        card.active_execution_id = active_exec
        card.last_agent_activity_at = latest


async def attach_column_labels(
    db: AsyncSession,
    cards: Iterable[Card],
) -> None:
    """Annotate each Card with `column_name` and `column_type`.

    One batched SELECT over the distinct `column_id`s covers N cards, so a
    search response becomes self-describing — the caller learns WHERE a card
    sits without a follow-up board fetch — at constant query cost.
    """
    card_list = [c for c in cards if c is not None]
    if not card_list:
        return

    column_ids = {c.column_id for c in card_list}
    result = await db.execute(
        select(Column.id, Column.name, Column.column_type).where(Column.id.in_(column_ids))
    )
    labels_by_column = {cid: (name, ctype) for cid, name, ctype in result.all()}

    for card in card_list:
        name, ctype = labels_by_column.get(card.column_id, (None, None))
        card.column_name = name
        card.column_type = ctype


async def attach_dependency_counts(
    db: AsyncSession,
    cards: Iterable[Card],
) -> None:
    """Annotate each Card with `depends_on_count`, `blocks_count`, `dependency_status`.

    Batch edge counts and resolve prerequisite satisfaction through the shared
    completion contract. The board payload carries the resulting dependency
    status so clients do not reimplement policy or make per-card requests.

    Skipped when the `card_dependencies` table is absent (pre-DEP-1
    deployments) — mirrors the scheduler's `all_dependencies_done` probe.
    """
    card_list = [c for c in cards if c is not None]
    if not card_list:
        return

    # Default-init so callers that hit the no-table branch still get well-
    # formed CardRead instances.
    for card in card_list:
        card.depends_on_count = 0
        card.blocks_count = 0
        card.dependency_status = "ready"

    if not await _card_dependencies_table_exists(db):
        return

    card_ids = {c.id for c in card_list}

    # Forward edges: how many cards each card depends on.
    forward_stmt = (
        select(CardDependency.card_id, func.count())
        .where(CardDependency.card_id.in_(card_ids))
        .group_by(CardDependency.card_id)
    )
    forward_result = await db.execute(forward_stmt)
    depends_on_by_card: dict[uuid.UUID, int] = dict(forward_result.all())

    # Reverse edges: how many cards depend on each card.
    reverse_stmt = (
        select(CardDependency.depends_on_card_id, func.count())
        .where(CardDependency.depends_on_card_id.in_(card_ids))
        .group_by(CardDependency.depends_on_card_id)
    )
    reverse_result = await db.execute(reverse_stmt)
    blocks_by_card: dict[uuid.UUID, int] = dict(reverse_result.all())

    from app.services.kanban.completion_dependencies import CompletionDependencyService
    blocked_ids = await CompletionDependencyService(db).blocked_ids(card_ids=card_ids)

    for card in card_list:
        card.depends_on_count = depends_on_by_card.get(card.id, 0)
        card.blocks_count = blocks_by_card.get(card.id, 0)
        if card.depends_on_count == 0:
            card.dependency_status = "ready"
            continue
        if card.id in blocked_ids:
            card.dependency_status = "blocked"
        else:
            card.dependency_status = "unblocked"


def _carries_pr_url(pr_url: str | None, description: str | None) -> bool:
    # Done-merge-gate doctrine: the structured column wins, the description
    # scan is the hand-authored/legacy fallback.
    return bool(pr_url) or bool(extract_pr_url(description or ""))


async def compute_loop_readiness(db: AsyncSession, board_id: uuid.UUID) -> dict:
    """Board-level starvation probe for loop mode (docs/loop-mode-contract.md).

    Lets the loop runner ask "is there anything to do?" for the price of one
    GET instead of a paid agent session. Classification comes straight from
    `attach_dependency_counts` — the cards are annotated by it, never
    re-classified here. Untyped columns are excluded everywhere (human
    scratchpads, per the search_cards doctrine).

    `awaiting_merge_count` is visibility/parking metadata. Each prerequisite's
    effective policy determines whether its accepted revision or Done transition
    releases dependents. Accepted work awaiting manual Done is not an open PR.
    """
    stmt = (
        select(Card, Column.column_type)
        .join(Column, Column.id == Card.column_id)
        .where(
            Card.board_id == board_id,
            Column.column_type.in_(
                [ColumnType.backlog, ColumnType.active, ColumnType.review]
            ),
        )
    )
    rows = (await db.execute(stmt)).all()
    explicitly_blocked_ids = list((await db.scalars(
        select(Card.id).join(Column, Column.id == Card.column_id).where(
            Card.board_id == board_id, Column.column_type == ColumnType.blocked,
        ).order_by(Card.id)
    )).all())
    from app.services.kanban.completion_dependencies import CompletionDependencyService
    completion_dependencies = CompletionDependencyService(db)
    accepted_ids = await completion_dependencies.accepted_ids(board_id=board_id)
    work_cards = [c for c, t in rows if t != ColumnType.review and c.id not in accepted_ids]
    review_cards = [c for c, t in rows if t == ColumnType.review and c.id not in accepted_ids]

    await attach_dependency_counts(db, work_cards)
    blocked = [c for c in work_cards if c.dependency_status == "blocked"]
    ready_count = len(work_cards) - len(blocked)

    awaiting_merge_count = 0
    if blocked:
        # Per blocked card: is EVERY unsatisfied (non-done) blocker sitting in
        # a review-typed column with a PR url? Same join shape as the
        # annotator's target probe, widened with the blocker's PR fields.
        blocker_stmt = (
            select(
                CardDependency.card_id,
                Card.id,
                Column.column_type,
                Card.pr_url,
                Card.description,
            )
            .join(Card, Card.id == CardDependency.depends_on_card_id)
            .join(Column, Column.id == Card.column_id)
            .where(CardDependency.card_id.in_({c.id for c in blocked}))
        )
        mergeable_by_card: dict[uuid.UUID, list[bool]] = {}
        blocker_rows = (await db.execute(blocker_stmt)).all()
        target_ids = {target for _, target, _, _, _ in blocker_rows}
        satisfied = await completion_dependencies.satisfied_ids(target_ids)
        accepted_blockers = await completion_dependencies.accepted_ids(card_ids=target_ids)
        for cid, target, ctype, pr_url, description in blocker_rows:
            if target in satisfied:
                continue
            mergeable_by_card.setdefault(cid, []).append(
                target not in accepted_blockers and ctype == ColumnType.review and _carries_pr_url(pr_url, description)
            )
        awaiting_merge_count = sum(
            1
            for c in blocked
            if mergeable_by_card.get(c.id) and all(mergeable_by_card[c.id])
        )

    return {
        "ready_count": ready_count,
        "blocked_count": len(blocked),
        "explicitly_blocked_count": len(explicitly_blocked_ids),
        "explicitly_blocked_card_ids": explicitly_blocked_ids,
        "awaiting_merge_count": awaiting_merge_count,
        "review_open_pr_count": sum(
            1 for c in review_cards if _carries_pr_url(c.pr_url, c.description)
        ),
        "actionable": ready_count > 0,
    }


# Cache ONLY a True result: `card_dependencies` existence is monotonic within a
# process (a migration creates it once), so once we've seen it we never re-probe.
# A False stays uncached — a migration can create the table mid-life and we must
# notice. Single event loop, so a plain module bool needs no lock. Tests share
# the process; clear this via `_reset_card_dependencies_table_probe`.
_card_dependencies_table_confirmed = False


def _reset_card_dependencies_table_probe() -> None:
    """Test seam: forget a cached True so the next call re-probes."""
    global _card_dependencies_table_confirmed
    _card_dependencies_table_confirmed = False


async def _probe_card_dependencies_table(db: AsyncSession) -> bool:
    from sqlalchemy import inspect as sa_inspect

    def _has_table(sync_conn) -> bool:
        return sa_inspect(sync_conn).has_table("card_dependencies")

    try:
        conn = await db.connection()
        return await conn.run_sync(_has_table)
    except Exception:  # pragma: no cover — defensive
        return False


async def _card_dependencies_table_exists(db: AsyncSession) -> bool:
    global _card_dependencies_table_confirmed
    if _card_dependencies_table_confirmed:
        return True
    exists = await _probe_card_dependencies_table(db)
    if exists:
        _card_dependencies_table_confirmed = True
    return exists


class CardService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.card_repo = CardRepository(db)
        self.column_repo = ColumnRepository(db)
        self.git_repo_repo = GitRepoRepository(db)
        self.board_repo = BoardRepository(db)

    async def search_cards(
        self,
        board_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        q: str | None = None,
        priority: str | None = None,
        card_type: str | None = None,
        status: str | None = None,
        label: str | None = None,
        has_assignee: bool | None = None,
        assignee_id: uuid.UUID | None = None,
        column_id: uuid.UUID | None = None,
        column_type: str | None = None,
        exclude_column_type: str | None = None,
        include_untyped: bool = True,
        overdue: bool | None = None,
        all_dependencies_done: bool = False,
        limit: int = 50,
    ):
        board_repo = BoardRepository(self.db)
        board = await board_repo.get_by_id(board_id)
        if not board or board.workspace_id != workspace_id:
            raise ResourceNotFoundError(
                "Board not found in this workspace", error_code="board_not_found"
            )

        from app.services.kanban.completion_dependencies import CompletionDependencyService
        ineligible_ids = set()
        if all_dependencies_done:
            eligibility = CompletionDependencyService(self.db)
            ineligible_ids = await eligibility.blocked_ids(board_id=board_id, workspace_id=workspace_id)
            ineligible_ids |= await eligibility.accepted_ids(board_id=board_id, workspace_id=workspace_id)

        cards = await self.card_repo.search(
            board_id,
            q=q,
            priority=priority,
            card_type=card_type,
            status=status,
            label=label,
            has_assignee=has_assignee,
            assignee_id=assignee_id,
            column_id=column_id,
            column_type=column_type,
            exclude_column_type=exclude_column_type,
            include_untyped=include_untyped,
            overdue=overdue,
            ineligible_ids=ineligible_ids,
            limit=limit,
        )
        await attach_column_labels(self.db, cards)
        await attach_pending_approvals(self.db, cards, workspace_id=workspace_id)
        await attach_agent_presence(self.db, cards)
        await attach_dependency_counts(self.db, cards)
        return cards

    async def create_card(
        self,
        board_id: uuid.UUID,
        data: CardCreate,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID | None = None,
    ):
        await assert_board_not_frozen(self.db, board_id)
        column = await self.column_repo.get_by_id(data.column_id)
        if not column or column.board_id != board_id:
            raise ResourceNotFoundError(
                "Column not found in this board", error_code="column_not_found"
            )

        completion = CompletionPolicyService(self.db)
        board = await completion.lock_board_for_completion(board_id, workspace_id)
        if "completion_mode" in data.model_fields_set:
            await completion.assert_mode_selection(board, user_id, data.completion_mode)
        if column.column_type == ColumnType.done:
            await completion.assert_card_complete(board, None)

        # A slug matching no board repo (e.g. a runner-stamped stale slug)
        # would park the new card forever at assignment time
        # (repo-slug-unresolved) and can deadlock a dep-blocked source card.
        # Drop it (NULL → board-primary default) and record the rejection —
        # never 422, agent retries must stay idempotent.
        git_repo_slug = data.git_repo_slug
        rejected_repo_slug: str | None = None
        if git_repo_slug and not await self.git_repo_repo.get_by_slug(
            board_id, git_repo_slug
        ):
            if await completion.effective_policy(board) is not None:
                raise ValidationError("Repository slug not found in this board; explicit completion requires the configured source repository")
            rejected_repo_slug = git_repo_slug
            git_repo_slug = None
            logger.warning(
                "create_card on board %s: dropping git_repo_slug %r — "
                "matches no registered repo; board-primary default applies",
                board_id,
                rejected_repo_slug,
            )

        max_pos = await self.card_repo.get_max_position(data.column_id)
        card = await self.card_repo.create(
            board_id=board_id,
            column_id=data.column_id,
            title=data.title,
            description=data.description,
            card_type=data.card_type,
            priority=data.priority,
            created_by=user_id,
            position=max_pos + 1024.0,
            due_date=data.due_date,
            status=data.status,
            labels=data.labels,
            git_repo_slug=git_repo_slug,
            completion_mode=data.completion_mode,
        )
        if workspace_id:
            activity = ActivityService(self.db)
            await activity.record(
                workspace_id=workspace_id,
                actor_id=user_id,
                entity_type=ActivityEntityType.card,
                entity_id=card.id,
                action=ActivityAction.created,
                board_id=board_id,
                summary=f"created card '{data.title}'",
                message_key="activity.card.created",
                message_params={"card_title": data.title},
                after_state=snapshot_card(card),
            )
            # @mention producer (before='' — every mention in a new card's
            # description is new). Isolated by its own savepoint; never raises.
            await notify_new_mentions(
                self.db,
                workspace_id=workspace_id,
                board_id=board_id,
                actor_id=user_id,
                entity_type="card",
                entity_id=card.id,
                card_id=card.id,
                before_content="",
                after_content=data.description,
            )
            if rejected_repo_slug:
                await activity.record(
                    workspace_id=workspace_id,
                    actor_id=user_id,
                    entity_type=ActivityEntityType.card,
                    entity_id=card.id,
                    action=ActivityAction.updated,
                    board_id=board_id,
                    summary=(
                        f"dropped unknown git_repo_slug '{rejected_repo_slug}' "
                        f"on card '{data.title}': matches no repo on this "
                        "board — board-primary repo default applies"
                    ),
                    message_key="activity.card.unknown_git_repo_slug_dropped",
                    message_params={
                        "card_title": data.title,
                        "git_repo_slug": rejected_repo_slug,
                    },
                )
        await self._enrich([card], workspace_id=workspace_id)
        return card

    async def bulk_create_cards(
        self,
        board_id: uuid.UUID,
        cards_data: list[CardCreate],
        user_id: uuid.UUID,
        workspace_id: uuid.UUID | None = None,
    ) -> list["Card"]:
        await assert_board_not_frozen(self.db, board_id)
        requested_column_ids = {c.column_id for c in cards_data}
        valid_column_ids = await self.column_repo.get_ids_for_board(
            board_id, requested_column_ids
        )
        invalid_ids = requested_column_ids - valid_column_ids
        if invalid_ids:
            raise ValidationError(
                f"Column(s) not found in this board: {', '.join(str(i) for i in invalid_ids)}"
            )

        completion = CompletionPolicyService(self.db)
        board = await completion.lock_board_for_completion(board_id, workspace_id)
        for item in cards_data:
            if "completion_mode" in item.model_fields_set:
                await completion.assert_mode_selection(board, user_id, item.completion_mode)
        if await _done_column_ids(self.db, requested_column_ids):
            await completion.assert_card_complete(board, None)

        # Validate the entire batch before inserting: an explicit target must
        # never silently become the board's primary repository.
        requested_repo_slugs = {
            c.git_repo_slug for c in cards_data if c.git_repo_slug is not None
        }
        if requested_repo_slugs:
            board_repos = await self.git_repo_repo.list_by_board(board_id)
            invalid_slugs = requested_repo_slugs - {repo.slug for repo in board_repos}
            if invalid_slugs:
                raise ValidationError(
                    "Repository slug(s) not found in this board: "
                    + ", ".join(repr(slug) for slug in sorted(invalid_slugs))
                    + ". Use null for the board's default repository."
                )

        column_ids = {c.column_id for c in cards_data}
        max_positions = await self.card_repo.get_max_positions(column_ids)

        created_cards = []
        for card_data in cards_data:
            max_positions[card_data.column_id] += 1024.0
            card = await self.card_repo.create(
                board_id=board_id,
                **card_data.model_dump(),
                created_by=user_id,
                position=max_positions[card_data.column_id],
            )
            created_cards.append(card)

        if workspace_id:
            activity = ActivityService(self.db)
            # Use the first card's ID as the entity_id for the activity record
            await activity.record(
                workspace_id=workspace_id,
                actor_id=user_id,
                entity_type=ActivityEntityType.card,
                entity_id=created_cards[0].id,
                action=ActivityAction.created,
                board_id=board_id,
                summary=f"bulk created {len(created_cards)} cards",
                message_key="activity.card.bulk_created",
                message_params={"card_count": len(created_cards)},
            )

        await self._enrich(created_cards, workspace_id=workspace_id)
        return created_cards

    async def _enrich(self, cards: list, workspace_id: uuid.UUID | None = None):
        """Annotate cards with the same derived fields every read path serves.

        Write paths (create/update/move/claim/participants) previously
        returned raw ORM models and CardRead's class-level defaults filled the
        gap — a PATCH response claimed a heavily-depended card was edge-less
        (card c59e75bb). Every card-returning mutation must enrich.
        """
        await attach_pending_approvals(self.db, cards, workspace_id=workspace_id)
        await attach_agent_presence(self.db, cards)
        await attach_dependency_counts(self.db, cards)

    async def get_card(
        self,
        card_id: uuid.UUID,
        board_id: uuid.UUID,
        *,
        as_markdown: bool = False,
    ):
        card = await self.card_repo.get_by_id(card_id)
        if not card or card.board_id != board_id:
            raise ResourceNotFoundError("Card not found", error_code="card_not_found")
        await attach_pending_approvals(self.db, [card])
        await attach_agent_presence(self.db, [card])
        await attach_dependency_counts(self.db, [card])
        if as_markdown:
            # Project on a schema copy, never on the ORM instance — the
            # session auto-commits and would persist the markdown back.
            from app.schemas.kanban.card import CardRead

            read = CardRead.model_validate(card)
            return read.model_copy(
                update={"description": prosemirror_to_markdown(card.description)}
            )
        return card

    # Shortest prefix accepted by the resolve endpoint. Fewer than 4 hex chars
    # would match a large slice of any board's cards — the caller almost
    # certainly holds a longer fragment, and a 3-char lookup is a mistake, not a
    # query. Enforced as a 422 (not a silent broadening) so the contract is clear.
    RESOLVE_MIN_PREFIX_LEN = 4

    async def resolve_card_by_prefix(
        self,
        board_id: uuid.UUID,
        prefix: str,
        *,
        workspace_id: uuid.UUID | None = None,
    ):
        """Resolve a card on `board_id` from a UUID prefix fragment.

        Returns the single matching card (with the same transient annotations
        get_card attaches) when exactly one matches. Raises:
          - ValidationError (422) if the prefix is shorter than the minimum.
          - ResourceNotFoundError (404) if nothing matches.
          - ConflictError (409), listing candidate ids+titles, if >1 match.
        """
        cleaned = (prefix or "").strip()
        if len(cleaned) < self.RESOLVE_MIN_PREFIX_LEN:
            raise ValidationError(
                f"prefix must be at least {self.RESOLVE_MIN_PREFIX_LEN} "
                "characters to resolve a card",
                error_code="prefix_too_short",
            )

        matches = await self.card_repo.find_by_id_prefix(board_id, cleaned)
        if not matches:
            raise ResourceNotFoundError(
                f"No card on this board matches prefix '{cleaned}'",
                error_code="card_not_found",
            )
        if len(matches) > 1:
            candidates = ", ".join(f"{c.id} ({c.title})" for c in matches)
            raise ConflictError(
                f"Prefix '{cleaned}' is ambiguous; matches {len(matches)} cards: "
                f"{candidates}",
                error_code="ambiguous_prefix",
            )

        card = matches[0]
        await attach_pending_approvals(self.db, [card], workspace_id=workspace_id)
        await attach_agent_presence(self.db, [card])
        await attach_dependency_counts(self.db, [card])
        return card

    async def update_card(
        self,
        card_id: uuid.UUID,
        board_id: uuid.UUID,
        data: CardUpdate,
        workspace_id: uuid.UUID | None = None,
        actor_id: uuid.UUID | None = None,
    ):
        await assert_board_not_frozen(self.db, board_id)
        card = await self.card_repo.get_by_id(card_id)
        if not card or card.board_id != board_id:
            raise ResourceNotFoundError("Card not found", error_code="card_not_found")
        completion = CompletionPolicyService(self.db)
        board = await completion.lock_board_for_completion(board_id, workspace_id)
        if "completion_mode" in data.model_fields_set:
            if data.completion_mode is None:
                raise ValidationError("completion_mode cannot be null")
            await completion.assert_mode_selection(board, actor_id, data.completion_mode)
        before_state = snapshot_card(card)
        # Prior description for the @mention diff — snapshot_card omits it, and
        # the repo update mutates the instance in place, so capture it now.
        before_description = card.description
        updates = data.model_dump(exclude_unset=True)
        # Explicit null description means "no change" — the column is NOT NULL
        # and clearing is spelled "" (see CardUpdate).
        if updates.get("description") is None:
            updates.pop("description", None)
        changed_fields = list(updates.keys())
        contract_fields = {"pr_url", "git_repo_slug", "completion_mode", "branch_name", "title", "description"}
        if any(key in contract_fields and getattr(card, key) != value for key, value in updates.items()):
            from app.services.completion import CompletionService
            await CompletionService(self.db).invalidate_card(board, card)
        updated = await self.card_repo.update(card, **updates)
        if actor_id and workspace_id:
            activity = ActivityService(self.db)
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.card,
                entity_id=card_id,
                action=ActivityAction.updated,
                board_id=board_id,
                summary=f"updated card '{updated.title}': changed {', '.join(changed_fields)}",
                message_key="activity.card.updated",
                message_params={
                    "card_title": updated.title,
                    "fields": changed_fields,
                },
                changes={"fields": changed_fields},
                before_state=before_state,
                after_state=snapshot_card(updated),
            )
            # @mention producer — only NEW ids (after - before) fire (MEN-2). A
            # description left untouched yields an empty diff → no-op.
            await notify_new_mentions(
                self.db,
                workspace_id=workspace_id,
                board_id=board_id,
                actor_id=actor_id,
                entity_type="card",
                entity_id=card_id,
                card_id=card_id,
                before_content=before_description,
                after_content=updated.description,
            )
        await self._enrich([updated], workspace_id=workspace_id)
        return updated

    async def delete_card(
        self,
        card_id: uuid.UUID,
        board_id: uuid.UUID,
        workspace_id: uuid.UUID | None = None,
        actor_id: uuid.UUID | None = None,
    ):
        await assert_board_not_frozen(self.db, board_id)
        card = await self.card_repo.get_by_id(card_id)
        if not card or card.board_id != board_id:
            raise ResourceNotFoundError("Card not found", error_code="card_not_found")
        if actor_id and workspace_id:
            activity = ActivityService(self.db)
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.card,
                entity_id=card_id,
                action=ActivityAction.deleted,
                board_id=board_id,
                summary=f"deleted card '{card.title}'",
                message_key="activity.card.deleted",
                message_params={"card_title": card.title},
                before_state=snapshot_card(card),
            )
        await self.card_repo.delete(card)

    async def move_card(
        self,
        card_id: uuid.UUID,
        board_id: uuid.UUID,
        data: CardMoveRequest,
        workspace_id: uuid.UUID | None = None,
        actor_id: uuid.UUID | None = None,
        activity_summary: str | None = None,
    ):
        await assert_board_not_frozen(self.db, board_id)
        card = await self.card_repo.get_by_id(card_id)
        if not card or card.board_id != board_id:
            raise ResourceNotFoundError("Card not found", error_code="card_not_found")
        # Snapshot before the gate (may stamp a label in-place) or the move mutates the card.
        before_state = snapshot_card(card)

        target_column = await self.column_repo.get_by_id(data.column_id)
        if not target_column or target_column.board_id != board_id:
            raise ResourceNotFoundError("Target column not found in this board")

        # An omitted position means "append": follow the board's fractional-indexing
        # convention (max + 1024) so callers who only care about the column don't
        # have to invent a float.
        position = data.position
        if position is None:
            position = await self.card_repo.get_max_position(data.column_id) + 1024.0

        if target_column.column_type == ColumnType.done:
            completion = CompletionPolicyService(self.db)
            board = await completion.lock_board_for_completion(board_id, workspace_id)
            await completion.assert_card_complete(board, card)

        # Short-circuit no-op moves: same column, negligible position change.
        if card.column_id == data.column_id and abs(card.position - position) < 1.0:
            await self._enrich([card], workspace_id=workspace_id)
            return card

        old_column = await self.column_repo.get_by_id(card.column_id)
        await self._enforce_done_merge_gate(
            card, target_column, old_column, workspace_id=workspace_id
        )
        old_column_id = card.column_id
        moved = await self.card_repo.move_card(
            card, column_id=data.column_id, board_id=board_id, position=position
        )
        if actor_id and workspace_id:
            activity = ActivityService(self.db)
            old_col_name = old_column.name if old_column else "unknown"
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.card,
                entity_id=card_id,
                action=ActivityAction.moved,
                board_id=board_id,
                summary=activity_summary
                or f"moved card '{moved.title}' from '{old_col_name}' to '{target_column.name}'",
                # Reconciler moves intentionally carry a distinct legacy
                # summary. Do not replace that operator-facing distinction with
                # the generic localized card-move message.
                message_key=("activity.card.moved" if activity_summary is None else None),
                message_params=(
                    {
                        "card_title": moved.title,
                        "from_column_name": old_column.name if old_column else None,
                        "from_column_known": old_column is not None,
                        "to_column_name": target_column.name,
                    }
                    if activity_summary is None
                    else None
                ),
                changes={
                    "column_id": {
                        "old": str(old_column_id),
                        "new": str(data.column_id),
                    },
                    "from_column": old_col_name,
                    "to_column": target_column.name,
                },
                before_state=before_state,
                after_state=snapshot_card(moved),
            )
        await self._enrich([moved], workspace_id=workspace_id)
        return moved

    async def _enforce_done_merge_gate(
        self,
        card,
        target_column,
        old_column,
        *,
        workspace_id: uuid.UUID | None = None,
    ):
        """Backend-owned gate: agent moves into a Done-type column require a merged PR.

        Skipped when:
        - the gate is off for this board. Two levers, board-first: the board's
          own `enforce_done_merge_gate` override wins outright when set
          (true = enforced even if the workspace opted out, false = off even if
          the workspace enforces), and only a NULL override falls through to
          `workspace_config.enforce_done_merge_gate`.
        - the caller is a human (no `current_agent_id` in context). Humans
          on the web UI / MCP routinely move spike/doc/ad-hoc cards to Done
          that never had a PR; blocking them breaks the manual workflow.
          The gate exists to stop autonomous runners from prematurely
          declaring Done, not to gate every Done transition.
        - already in a Done column (idempotent move within Done).
        - target isn't a Done column.
        - the move is a same-column no-op (handled by caller).
        - the card's board has no git repo linked. Such a board cannot
          produce a mergeable PR by construction (ops/triage/doc boards), so
          the gate is unsatisfiable and every agent move dead-ends. Boards
          WITH a repo keep the full gate — this is deliberately narrower than
          a blanket agent bypass, which would reopen the self-merge hole.
          Structural, so it outranks both flags: an `enforce_done_merge_gate`
          override of `true` cannot conjure a PR onto a repo-less board.

        Fail-soft: if GitHub is unreachable after the client's bounded retry,
        stamp `verification-deferred` on the card and allow the move. The
        runner gets unstuck; the marker preserves the audit trail. Pre-fix
        behavior raised BadGatewayError straight through (smoke 2026-04-24:
        card 475e3a6f stuck 40+ min while its PR was already merged).
        """
        from app.core.auth import current_agent_id

        board = await self.board_repo.get_by_id(card.board_id)
        if board and await CompletionPolicyService(self.db).effective_policy(board) is not None:
            return  # The explicit completion invariant replaces legacy soft gates.
        if current_agent_id.get() is None:
            return
        if target_column.column_type != ColumnType.done:
            return
        if old_column is not None and old_column.column_type == ColumnType.done:
            return
        if not await self._gate_enabled_for_board(card.board_id, workspace_id):
            return
        if not await self.git_repo_repo.exists_for_board(card.board_id):
            logger.debug(
                "done_gate: board %s has no linked git repo (card=%s); exempt "
                "from PR-merge gating",
                card.board_id,
                card.id,
            )
            return
        pr_url = extract_pr_url(card.description or "")
        if not pr_url:
            raise ValidationError(
                "Card has no PR URL; required to transition to Done",
                error_code="pr_url_missing",
            )
        # White-label soft-pass (cell #12): only the *PR-status* sub-gate is forge-
        # coupled. get_pr_status raises ValueError on a non-github.com url (NOT
        # caught by `except BadGatewayError`), so a Gitea/GitLab card would hard-
        # fail the move. PR-merge verification is OFF for non-GitHub forges (no
        # forge-native status client yet; the runner owns the real merge) — mirror
        # the scheduler's _pr_is_open soft-pass discipline + the BadGatewayError
        # fail-soft below. We skip ONLY the status check; the reviewer-approval
        # backstop below is forge-independent (a workspace-local verdict lookup),
        # so it MUST still run — else a non-GitHub card reaches Done with neither
        # merge-proof nor an approving verdict, reopening the self-merge hole.
        if not is_github_pr_url(pr_url):
            logger.warning(
                "done_gate: non-GitHub PR url (card=%s pr=%s); PR-status gating "
                "unsupported for this forge, marking %s (reviewer-approval check "
                "still enforced)",
                card.id,
                pr_url,
                MERGE_GATE_UNSUPPORTED_FORGE_LABEL,
            )
            stamp_label(card, MERGE_GATE_UNSUPPORTED_FORGE_LABEL)
        else:
            try:
                status = await self._pr_status_for_board(card.board_id, pr_url)
            except BadGatewayError as exc:
                logger.warning(
                    "done_gate: GitHub unreachable after retries (card=%s pr=%s); "
                    "marking %s and allowing move",
                    card.id,
                    pr_url,
                    VERIFICATION_DEFERRED_LABEL,
                    exc_info=exc,
                )
                stamp_label(card, VERIFICATION_DEFERRED_LABEL)
                return
            if status is None:
                # No credential could read this PR. Same posture as an
                # unreachable GitHub: defer verification rather than wedge the
                # card, and leave the marker as the audit trail. The reason was
                # already logged with the repo's own detail.
                stamp_label(card, VERIFICATION_DEFERRED_LABEL)
                return
            if not status.merged:
                raise ConflictError(
                    "Cannot move card to Done: PR is not merged",
                    error_code="pr_not_merged",
                )
        # Defense-in-depth (card 7f1d289d): a merged PR is necessary but not
        # sufficient. The reviewer is the only quality gate (free-plan org, no
        # branch protection), so an agent may only land a card whose PR carries
        # an approving reviewer verdict on record. This closes the self-merge
        # hole where an implementer bypassed review via a Bash `gh pr merge`.
        # Scoped to workspace-context calls because the approving verdict is a
        # workspace-scoped lookup; human/no-workspace paths are unaffected. This
        # runs for BOTH GitHub and non-GitHub forges (it never touches a forge).
        if workspace_id is not None and not await self._card_has_reviewer_approval(
            card.id, workspace_id
        ):
            raise ConflictError(
                "Cannot move card to Done: PR merged without an approving "
                "reviewer verdict on record",
                error_code="merge_requires_review",
            )

    async def _pr_status_for_board(self, board_id: uuid.UUID, pr_url: str):
        """PR status read with the BOARD's repo credential, or None when no
        credential can read it.

        None is a soft-pass signal, not an error: a workspace whose forge the
        platform has no account on must not have its cards wedged in review by
        a gate that cannot see their PRs. The caller stamps
        `verification-deferred`, exactly as it does for an unreachable GitHub.
        """
        from app.services.git.repo_credentials import credential_for_board

        credential = await credential_for_board(self.db, board_id)
        if credential.token is None:
            credential.warn("done_gate", board=board_id, pr=pr_url)
            return None

        client = GitHubClient(
            token=credential.token, base_url=settings.GITHUB_API_URL
        )
        try:
            status = await client.get_pr_status(pr_url)
        except (BadGatewayError, ResourceNotFoundError):
            raise
        except ForgeAuthError as exc:
            await credential.record_failure(self.db, str(exc))
            raise
        await credential.record_success(self.db)
        return status

    async def _card_has_reviewer_approval(
        self, card_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> bool:
        from app.services.notes.note import NoteService

        verdict = await NoteService(self.db).get_card_verdict(card_id, workspace_id)
        return bool(verdict and verdict.get("approved"))

    async def _gate_enabled_for_board(
        self, board_id: uuid.UUID, workspace_id: uuid.UUID | None
    ) -> bool:
        """Effective on/off for this board: board override, else workspace flag.

        A set override is authoritative and skips the workspace-config read
        entirely. Without a workspace_id there is no config to inherit from, so
        a NULL override keeps the historical default-on behavior.
        """
        override = await self.board_repo.get_done_merge_gate_override(board_id)
        if override is not None:
            return override
        if workspace_id is None:
            return True
        return await self._gate_enabled_for_workspace(workspace_id)

    async def _gate_enabled_for_workspace(self, workspace_id: uuid.UUID) -> bool:
        """Return True unless the workspace has explicitly opted out.

        Default-on: a missing row, a NULL column on legacy rows, or `True`
        all keep the historical gate behavior.
        """
        from app.models.workspace_config import WorkspaceConfig

        flag = await self.db.scalar(
            select(WorkspaceConfig.enforce_done_merge_gate).where(
                WorkspaceConfig.workspace_id == workspace_id
            )
        )
        if flag is None:
            return True
        return bool(flag)

    async def add_participant(
        self,
        card_id: uuid.UUID,
        board_id: uuid.UUID,
        user_id: uuid.UUID,
        role: str,
        workspace_id: uuid.UUID | None = None,
        actor_id: uuid.UUID | None = None,
        agent_id: uuid.UUID | None = None,
        pipeline_role: str | None = None,
    ):
        await assert_board_not_frozen(self.db, board_id)
        card = await self.card_repo.get_by_id(card_id)
        if not card or card.board_id != board_id:
            raise ResourceNotFoundError("Card not found", error_code="card_not_found")
        before_state = snapshot_card(card)  # participants pre-add

        # Resolve agent_id → agent.created_by_id (mirrors claim_card pattern).
        if agent_id:
            from app.models.agents.agent import Agent as AgentModel
            from sqlalchemy import select

            agent_result = await self.db.execute(
                select(AgentModel.created_by_id).where(AgentModel.id == agent_id)
            )
            agent_owner_id = agent_result.scalar_one_or_none()
            if not agent_owner_id:
                raise ResourceNotFoundError("Agent not found")
            user_id = agent_owner_id

        existing = await self.card_repo.get_participant(card_id, user_id)
        if existing:
            # Idempotent backfill: a runner retrying a claim with a freshly
            # plumbed pipeline_role should migrate a legacy NULL row in place.
            # A non-NULL value is left alone — overwriting silently would mask
            # a routing bug, so we log and keep the original.
            if pipeline_role:
                if existing.pipeline_role is None:
                    await self.card_repo.backfill_pipeline_role(existing, pipeline_role)
                    self.db.expire(card, ["participants"])
                elif existing.pipeline_role != pipeline_role:
                    logger.warning(
                        "add_participant: pipeline_role conflict on card=%s user=%s "
                        "existing=%s incoming=%s; keeping existing",
                        card_id,
                        user_id,
                        existing.pipeline_role,
                        pipeline_role,
                    )
            return await self.card_repo.get_by_id(card_id)

        if role == "hero":
            hero = await self.card_repo.get_hero(card_id)
            if hero:
                raise ConflictError(
                    "Card already has a hero", error_code="already_claimed"
                )

        await self.card_repo.add_participant(
            card_id,
            user_id,
            role,
            agent_id=agent_id,
            pipeline_role=pipeline_role,
        )

        # Expire cached participants so selectinload re-fetches the new row.
        self.db.expire(card, ["participants"])
        refreshed = await self.card_repo.get_by_id(card_id)

        if actor_id and workspace_id:
            user_repo = UserRepository(self.db)
            participant = await user_repo.get_by_id(user_id)
            user_email = participant.email if participant else str(user_id)
            activity = ActivityService(self.db)
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.card,
                entity_id=card_id,
                action=ActivityAction.updated,
                board_id=board_id,
                summary=f"added {user_email} to card '{card.title}' as {role}",
                message_key="activity.card.participant_added",
                message_params={
                    "card_title": card.title,
                    "participant_email": user_email,
                    "role": role,
                },
                changes={"participant_added": {"user_id": str(user_id), "role": role}},
                before_state=before_state,
                after_state=snapshot_card(refreshed),
            )

        if refreshed is not None:
            await self._enrich([refreshed], workspace_id=workspace_id)
        return refreshed

    async def remove_participant(
        self,
        card_id: uuid.UUID,
        board_id: uuid.UUID,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID | None = None,
        actor_id: uuid.UUID | None = None,
    ):
        await assert_board_not_frozen(self.db, board_id)
        card = await self.card_repo.get_by_id(card_id)
        if not card or card.board_id != board_id:
            raise ResourceNotFoundError("Card not found", error_code="card_not_found")
        before_state = snapshot_card(card)  # participants pre-remove

        removed = await self.card_repo.remove_participant(card_id, user_id)
        if not removed:
            return None

        # Expire cached participants so selectinload re-fetches the post-remove set.
        self.db.expire(card, ["participants"])
        refreshed = await self.card_repo.get_by_id(card_id)

        if actor_id and workspace_id:
            user_repo = UserRepository(self.db)
            participant = await user_repo.get_by_id(user_id)
            user_email = participant.email if participant else str(user_id)
            activity = ActivityService(self.db)
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.card,
                entity_id=card_id,
                action=ActivityAction.updated,
                board_id=board_id,
                summary=f"removed {user_email} from card '{card.title}'",
                message_key="activity.card.participant_removed",
                message_params={
                    "card_title": card.title,
                    "participant_email": user_email,
                },
                changes={"participant_removed": {"user_id": str(user_id)}},
                before_state=before_state,
                after_state=snapshot_card(refreshed),
            )

        if refreshed is not None:
            await self._enrich([refreshed], workspace_id=workspace_id)
        return refreshed

    async def remove_participants_by_pipeline_role(
        self,
        card_id: uuid.UUID,
        board_id: uuid.UUID,
        pipeline_role: str,
        *,
        workspace_id: uuid.UUID | None = None,
        actor_id: uuid.UUID | None = None,
    ):
        await assert_board_not_frozen(self.db, board_id)
        card = await self.card_repo.get_by_id(card_id)
        if not card or card.board_id != board_id:
            raise ResourceNotFoundError("Card not found", error_code="card_not_found")
        before_state = snapshot_card(card)  # participants pre-remove

        removed = await self.card_repo.remove_participants_by_pipeline_role(
            card_id, pipeline_role
        )
        if not removed:
            return None

        # Expire cached participants so selectinload re-fetches the post-remove set.
        self.db.expire(card, ["participants"])
        refreshed = await self.card_repo.get_by_id(card_id)

        if actor_id and workspace_id:
            activity = ActivityService(self.db)
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.card,
                entity_id=card_id,
                action=ActivityAction.updated,
                board_id=board_id,
                summary=f"removed {removed} {pipeline_role} participant(s) from card '{card.title}'",
                message_key="activity.card.pipeline_role_participants_removed",
                message_params={
                    "card_title": card.title,
                    "pipeline_role": pipeline_role,
                    "participant_count": removed,
                },
                changes={
                    "participants_removed_by_role": {
                        "pipeline_role": pipeline_role,
                        "count": removed,
                    }
                },
                before_state=before_state,
                after_state=snapshot_card(refreshed),
            )

        if refreshed is not None:
            await self._enrich([refreshed], workspace_id=workspace_id)
        return refreshed

    async def claim_card(
        self,
        card_id: uuid.UUID,
        board_id: uuid.UUID,
        agent_id: uuid.UUID,
        workspace_id: uuid.UUID | None = None,
        actor_id: uuid.UUID | None = None,
    ):
        """Atomically claim a card: lock row, check no hero, assign agent, move to In Progress."""
        card = await self.card_repo.get_for_update(card_id)
        if not card or card.board_id != board_id:
            raise ResourceNotFoundError("Card not found", error_code="card_not_found")
        await assert_board_not_frozen(self.db, board_id)

        hero = await self.card_repo.get_hero(card_id)
        if hero:
            raise ConflictError("Card already claimed", error_code="already_claimed")

        # `card` came from get_for_update (no eager loads). Snapshot the
        # eager-loaded pre-claim view so we never trigger a lazy participant load.
        before_card = await self.card_repo.get_by_id(card_id)
        before_state = snapshot_card(before_card) if before_card else None

        # Resolve the agent's owner for the user_id FK, store agent_id for observability.
        from app.models.agents.agent import Agent as AgentModel
        from sqlalchemy import select

        agent_result = await self.db.execute(
            select(AgentModel.created_by_id).where(AgentModel.id == agent_id)
        )
        agent_owner_id = agent_result.scalar_one_or_none()
        if not agent_owner_id:
            raise ResourceNotFoundError("Agent not found")

        await self.card_repo.add_participant(
            card_id, agent_owner_id, "hero", agent_id=agent_id
        )

        # Move to the active-typed column if one exists. Resolved by
        # column_type, never by column NAME — boards rename columns freely.
        columns = await self.column_repo.list_by_board(board_id)
        in_progress = next(
            (c for c in columns if c.column_type == ColumnType.active), None
        )
        if in_progress:
            await self.card_repo.move_card(card, in_progress.id, board_id, 1024.0)

        self.db.expire(card, ["participants"])
        refreshed = await self.card_repo.get_by_id(card_id)

        if actor_id and workspace_id:
            activity = ActivityService(self.db)
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.card,
                entity_id=card_id,
                action=ActivityAction.updated,
                board_id=board_id,
                summary=f"claimed card '{card.title}'",
                message_key="activity.card.claimed",
                message_params={"card_title": card.title},
                before_state=before_state,
                after_state=snapshot_card(refreshed) if refreshed else None,
            )

        if refreshed is not None:
            await self._enrich([refreshed], workspace_id=workspace_id)
        return refreshed
