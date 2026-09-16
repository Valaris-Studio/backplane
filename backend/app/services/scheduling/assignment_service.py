# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Backend-owned scheduler — replaces runner-side discover/claim.

POST /api/workspaces/{slug}/agents/{agent_id}/next-assignment hands a
runner one card to work, atomically, role-aware, with a TTL reservation
so a crashed runner cannot starve the board.

The runner becomes a dumb executor: it calls this endpoint, receives a
bundle (card + board + column + repo + role + stage_action), runs the
action, and posts an AgentExecution against the reserved card. There is
no client-side filtering left to drift out of sync with platform config.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.exceptions import (
    BadRequestError,
    ConflictError,
    ForbiddenError,
    ResourceNotFoundError,
)
from app.models.agents.agent import Agent
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.agents.reservation import AgentReservation
from app.models.git.git_repo import GitRepo
from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardParticipant
from app.models.kanban.column import Column
from app.models.workspace import Workspace, WorkspaceMember
from app.services.activity import ActivityAction, ActivityEntityType, ActivityService
from app.services.agents.identity import verify_caller_owns_agent
from app.services.agents.team import TeamService
from app.services.kanban.card import (
    ACTIVE_PRESENCE_HORIZON,
    BUDGET_SUSPENDED_LABEL,
)
from app.services.reviews.stuck_loop import NEEDS_ADVISOR_LABEL
from app.services.scheduling.preconditions import (
    PreconditionContext,
    _text_has_pr_url,
    evaluate_preconditions,
)
from app.services.workspace_config import WorkspaceConfigService

logger = logging.getLogger(__name__)


# Default reservation lifetime. Long enough to cover normal runner
# startup + first commit, short enough to recover from kills without
# operator intervention. Tuneable via workspace config in the future;
# hardcoded here until we observe a workspace that needs to differ.
RESERVATION_TTL_SECONDS = 600


# A `running`/`started` execution older than this is treated as a zombie and
# reaped by the busy-guard instead of 409ing forever. Set safely ABOVE the
# runner's longest single tick — the runner heartbeats only between ticks, so a
# live long tick (`card_timeout`, default 30m) must NOT be mistaken for dead.
# 45m = 30m max tick + a 15m margin for slow pushes / clones / clock skew.
STALE_EXECUTION_REAP_SECONDS = 2700


# How long a budget-suspended card may sit in `active` carrying a hero (no live
# execution) before the scheduler sheds that hero so the implementer can
# re-discover and resume it. The suspend path already sheds the hero; this only
# catches the re-claim race that re-attached one and then died mid-tick (cost
# breaker paused). Set ABOVE the reservation TTL (600s) so a normal in-flight
# reservation is never mistaken for a strand, and above the active-presence
# horizon so a recently-touched card resolves itself first. The implementer
# gets several of its own poll cycles to re-pick before we intervene.
STRAND_REAP_SECONDS = 1200


_PRIORITY_ORDER = {
    "urgent": 0, "high": 1, "medium": 2, "low": 3, "none": 4, None: 4,
}


# Park label stamped when a card's git_repo_slug matches no repo on its
# board. An unknown slug must NOT degrade to an arbitrary repo — that
# silently implements the card against the wrong codebase. Mirrors the
# `needs-advisor` label-park: the card stalls loudly with a fixable reason
# until an operator corrects the slug and removes the label.
REPO_SLUG_UNRESOLVED_LABEL = "repo-slug-unresolved"


# FCH-2: durable park label stamped when a card has been reserved+worked by a
# code-writing role N times WITHOUT producing any artifact (no pr_url, never left
# its active column) — the "completed-no-commit" money-loop (a live run: 249× /
# $250+ on one stub card). Reuses the existing `blocked` label so it inherits the
# role-agnostic discover exclusion AND `_reservation_still_eligible`'s honoring of
# it for free (no new split-brain surface — the #10 lesson). Reversible: a human
# removing the label restores discoverability (the card was re-scoped to runnable).
BLOCKED_LABEL = "blocked"


# How many terminal code-writing executions a card may accumulate WITHOUT
# producing an artifact before the scheduler parks it instead of re-reserving.
# Set ONE ABOVE the runner's in-memory `maxConsecutiveNoChangeImplements` (2) so
# the Go counter still wins first WHEN IT IS ALIVE; this backend cap is the
# restart-proof / multi-runner backstop that catches the case the Go counter
# can't (it dies on process restart, which is how the production loop reached
# 249×). At ~$1/implement that bounds worst-case waste to ~$3 vs $250 today.
NO_PROGRESS_RESERVATION_CAP = 3


# Stable substring embedded in the FCH-2 park Activity's summary so
# `_latest_no_progress_park_at` can find prior parks with a dialect-agnostic
# SQL `LIKE` pre-filter (the `changes.fch2_park` sentinel is the exact check,
# confirmed in Python). Keep this phrase in the park summary verbatim.
_NO_PROGRESS_PARK_SUMMARY_MARKER = "the completed-no-commit"


# `Activity.summary` is String(500) and `Card.title` is String(500), so ANY
# summary interpolating a title can overflow — Postgres raises
# StringDataRightTruncation and takes the whole request down with it. SQLite
# (the test dialect) silently stores the overflow, so this is invisible to the
# suite and can only ever surface in prod. Every helper below composes with a
# BOUNDED title prefix, and each keeps its fixed operator-facing detail (the
# marker, the unresolved slug, the role) AHEAD of the title so a long title can
# never push the diagnostic out.
_MAX_TITLE_IN_SUMMARY = 200


def _truncate_title(title: str, *, limit: int = _MAX_TITLE_IN_SUMMARY) -> str:
    """Bound a user-controlled card title for embedding in an Activity summary.

    The result is at most `limit` characters INCLUDING the ellipsis, so callers
    can budget their fixed text against a hard ceiling.
    """
    if len(title) <= limit:
        return title
    return title[: limit - 1] + "…"


def _no_progress_park_summary(
    *, title: str, attempts: int, execution_action: str
) -> str:
    """FCH-2 park summary. The marker leads so
    `_executions_spent_before_last_park` can always find this park with its
    `LIKE` pre-filter, whatever the title."""
    return (
        f"parked ({_NO_PROGRESS_PARK_SUMMARY_MARKER} loop): {attempts} "
        f"'{execution_action}' executions produced no PR/commit — re-scope the "
        f"card to be runnable and remove the `{BLOCKED_LABEL}` label to "
        f"resume. Card: '{_truncate_title(title)}'"
    )


def _repo_slug_park_summary(*, title: str, git_repo_slug: str | None) -> str:
    """Unresolved-repo-slug park summary. The slug leads: it is the whole
    diagnostic, and the operator cannot fix the card without it."""
    return (
        f"parked: git_repo_slug '{git_repo_slug}' matches no repo on this "
        f"board — fix the card's git_repo_slug and remove the "
        f"`{REPO_SLUG_UNRESOLVED_LABEL}` label to resume. "
        f"Card: '{_truncate_title(title)}'"
    )


def _reserved_card_summary(*, title: str, role: str) -> str:
    """Reservation summary — written on EVERY successful next_assignment, so
    this is the highest-traffic of the three title-interpolating summaries."""
    return f"reserved card for role {role}: '{_truncate_title(title)}'"


# SCH-1: one-shot WARN flag for the soft-pass branch of all_dependencies_done.
# Reset on process restart (module reload). Mirrors the `_PR_OPEN_*` one-shot
# pattern used by the repo_has_no_open_pr precondition. See spec note 233e4429.
_ALL_DEPS_DONE_SOFT_PASS_WARNED = False


class AgentBusyError(ConflictError):
    """409 raised when the agent has an in-flight execution on another card.

    Carries the conflicting card_id and execution_id so the router can
    surface them in the response body — clients use these to decide
    whether to wait, resume, or cancel.
    """

    error_code = "agent_busy"

    def __init__(
        self,
        *,
        active_card_id: uuid.UUID | None,
        execution_id: uuid.UUID | None,
    ):
        super().__init__(
            "Agent has an active execution on another card",
            error_code="agent_busy",
        )
        self.active_card_id = active_card_id
        self.execution_id = execution_id


class AssignmentService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def next_assignment(
        self,
        *,
        workspace: Workspace,
        agent: Agent,
        actor_id: uuid.UUID,
        role_override: str | None = None,
        board_filter: uuid.UUID | None = None,
    ) -> dict[str, Any] | None:
        """Reserve and return the next eligible card, or None for 204."""
        self._verify_caller_owns_agent(agent, actor_id=actor_id)
        await self._verify_agent_workspace_access(workspace.id, agent.id)

        # Paused runners stop picking up NEW cards but keep heartbeating
        # and finishing in-flight work. Surface as 204 (no eligible card)
        # so the runner's existing "sleep then poll" branch handles it
        # without needing a separate paused-state code path.
        if getattr(agent, "is_paused", False):
            return None

        await self._reject_if_busy(agent, workspace.id)

        # Reap budget-suspend strands on ANY role's poll (not just the
        # implementer that would re-pick them) so a card whose re-claim race
        # left a dead hero can't sit in `active` forever behind the
        # implementer's board-wide repo_has_no_open_pr gate. Workspace-scoped,
        # side-effect only — independent of which role is asking for work.
        await self._reap_stranded_suspended_cards(workspace.id, board_filter)

        # Hot path: skip the context-source lint (loads every authored prompt)
        # — this poll never reads context_source_warnings.
        config = await WorkspaceConfigService(self.db).get_config(
            workspace.id, include_warnings=False
        )
        pipeline = config.get("pipeline_config") or {}
        stages = pipeline.get("stages") or []

        role = await self._resolve_role(agent.id, stages, role_override)
        stage = next((s for s in stages if s.get("role") == role), None)
        if stage is None:
            raise BadRequestError(
                f"No pipeline stage for role {role!r}",
                error_code="unknown_role",
            )

        existing = await self._existing_active_reservation(
            agent.id, workspace_id=workspace.id, board_filter=board_filter
        )
        if existing is not None:
            # Cross-role guard (card 40369bc9): a multi-role runner asking
            # for `role_override=reviewer` must not consume an orchestrator
            # reservation belonging to its own agent_id. Match by role
            # explicitly. When role_override is omitted (legacy single-role
            # retry), `role` falls back to the agent's first role and will
            # naturally match the reservation's stored role for that runner.
            if existing.role == role:
                # Re-validate the card's current column against the role's
                # discover filter. Without this, a card that finished its
                # stage (e.g. reviewer moved In Review -> Done) keeps coming
                # back to the same role on every poll until the 600s TTL
                # expires — a cost-monotonic re-claim loop. Card 69270bf2.
                if await self._reservation_still_eligible(
                    existing, stages, workspace_id=workspace.id
                ):
                    bundle = await self._build_bundle(existing, existing.role)
                    if bundle is not None:
                        return bundle
                await self.db.delete(existing)
                await self.db.flush()
            # Cross-role: leave the reservation alive for its rightful role.
            # Fall through to a fresh candidate scan with the requested
            # role's filters.

        await self._sweep_expired_reservations()

        candidates = await self._candidate_cards(
            workspace_id=workspace.id,
            stage=stage,
            board_filter=board_filter,
            agent_id=agent.id,
        )

        preconditions = list((stage.get("discover") or {}).get("preconditions") or [])

        for card in candidates:
            # Cheap local check before any precondition that may call out
            # to a git provider: a card whose declared slug resolves to no
            # board repo is misconfigured and must never be reserved.
            if await self._park_if_repo_slug_unresolved(
                card, workspace_id=workspace.id, actor_id=actor_id
            ):
                continue

            # FCH-2: a card that keeps coming back to a code-writing role without
            # ever producing an artifact is the completed-no-commit money-loop.
            # Park it (persisted, restart-proof) rather than reserve+burn another
            # implement pass. Only engages for code-writing stages, only at the cap.
            if await self._park_if_no_progress(
                card, stage, role, workspace_id=workspace.id, actor_id=actor_id
            ):
                continue

            ctx = PreconditionContext(
                db=self.db,
                card=card,
                board_id=card.board_id,
                role=role,
                # Per CARD, not per call: candidates span boards, and each
                # board's repo may authenticate with a different workspace
                # connection.
                github_client_factory=self._github_client_factory(card.board_id),
            )
            if not await evaluate_preconditions(preconditions, ctx):
                continue

            reservation = AgentReservation(
                agent_id=agent.id,
                card_id=card.id,
                workspace_id=workspace.id,
                board_id=card.board_id,
                role=role,
                expires_at=datetime.utcnow()
                + timedelta(seconds=RESERVATION_TTL_SECONDS),
            )
            from app.services.kanban.completion_dependencies import CompletionDependencyService
            if not await CompletionDependencyService(self.db).source_work_allowed(
                card.id, workspace_id=workspace.id,
                require_dependencies=bool(((stage.get("discover") or {}).get("filters") or {}).get("all_dependencies_done")),
                lock=True,
            ):
                continue

            # SAVEPOINT around the INSERT so a unique-key collision
            # rolls back ONLY this attempt — preserving any prior
            # delete/insert in the request (sweep, abandoned-existing
            # cleanup) and keeping the rest of the candidate ORM cache
            # alive for the next iteration.
            try:
                async with self.db.begin_nested():
                    self.db.add(reservation)
                    await self.db.flush()
            except IntegrityError:
                continue

            await ActivityService(self.db).record(
                workspace_id=workspace.id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.card,
                entity_id=card.id,
                action=ActivityAction.updated,
                board_id=card.board_id,
                summary=_reserved_card_summary(title=card.title, role=role),
                message_key="activity.card.reserved",
                message_params={"card_title": card.title, "role": role},
            )

            bundle = await self._build_bundle(reservation, role, stage=stage)
            return bundle

        return None

    def _verify_caller_owns_agent(self, agent: Agent, *, actor_id: uuid.UUID) -> None:
        verify_caller_owns_agent(agent, actor_id=actor_id)

    async def _verify_agent_workspace_access(
        self, workspace_id: uuid.UUID, agent_id: uuid.UUID
    ) -> None:
        """Agent's owner must be a workspace member."""
        result = await self.db.execute(
            select(Agent.created_by_id).where(Agent.id == agent_id)
        )
        owner = result.scalar_one_or_none()
        if owner is None:
            raise ResourceNotFoundError("Agent not found")

        result = await self.db.execute(
            select(WorkspaceMember.user_id).where(
                WorkspaceMember.workspace_id == workspace_id,
                WorkspaceMember.user_id == owner,
            )
        )
        if result.scalar_one_or_none() is None:
            raise ForbiddenError(
                "Agent's owner is not a member of this workspace",
                error_code="agent_not_in_workspace",
            )

    async def _reject_if_busy(
        self, agent: Agent, workspace_id: uuid.UUID
    ) -> None:
        """409 if the agent has a still-plausibly-live execution on another card.

        Scoped to *this* workspace, and card-bound only. An agent may be
        a member of multiple workspaces — being busy in workspace A must
        not gate work in workspace B. Non-card-bound rows (mcp_session,
        anything with empty cards_affected) are pure instrumentation and
        cannot conflict with a card claim, so they never gate.

        Symmetric to `_existing_active_reservation`'s workspace scoping
        (lines 244-247) — the reservation path already enforces this and
        the execution path has to match.

        Age-based zombie reaping: an execution left `started`/`running` by a
        runner that died, or by a tick that finished without closing it
        (the budget-suspend leak), gates every role on every poll under a
        single-agent deployment and starves the whole pipeline. We reap such
        a row to `aborted` (instead of 409ing forever) ONLY once it is older
        than STALE_EXECUTION_REAP_SECONDS — a horizon set safely ABOVE the
        runner's longest possible single tick (`card_timeout`, default 30m).
        Liveness/heartbeat is deliberately NOT the signal: a runner heartbeats
        only between ticks, so a genuinely-busy long tick looks "offline" yet
        its execution is live and must not be reaped; conversely the
        budget-suspend zombie keeps the runner alive, so a liveness check would
        never fire. Execution AGE is the only signal that distinguishes "still
        possibly running" from "certainly abandoned". The reap is committed in
        its own unit so a later raise in next_assignment can't roll it back —
        otherwise the zombie would survive every poll (a write-that-never-
        persists, the exact class of bug this fix exists to kill).
        """
        result = await self.db.execute(
            select(AgentExecution).where(
                AgentExecution.agent_id == agent.id,
                AgentExecution.workspace_id == workspace_id,
                AgentExecution.status.in_(("started", "running")),
                AgentExecution.action != "mcp_session",
            )
        )
        reap_before = datetime.utcnow() - timedelta(
            seconds=STALE_EXECUTION_REAP_SECONDS
        )
        reaped = False
        for execution in result.scalars().all():
            # Age-reap FIRST, before the card-bound check. A leaked execution
            # whose cards_affected was never populated (the runner opened it but
            # the tick died before recording the card, or the close that would
            # have set it never ran) is still a zombie once it's past the reap
            # horizon — it pollutes analytics and masks liveness. The old
            # `if not cards_affected: continue` short-circuited above this check,
            # so such rows sat `running` forever (field incident: 3 leaked rows).
            if execution.started_at and execution.started_at < reap_before:
                execution.status = ExecutionStatus.aborted
                execution.completed_at = datetime.utcnow()
                execution.error_message = (
                    "reaped by scheduler: execution open past the reap horizon "
                    "(zombie lock from a crashed runner or an unclosed tick)"
                )
                reaped = True
                logger.warning(
                    "Reaped stale execution %s for agent %s (card %s, "
                    "started_at=%s) instead of 409",
                    execution.id, agent.id,
                    execution.cards_affected[0] if execution.cards_affected
                    else "<none>",
                    execution.started_at,
                )
                continue
            # Within the horizon: only a CARD-BOUND execution can conflict with a
            # card claim, so a recent non-card-bound row (mcp_session filtered
            # above, or a live tick that hasn't recorded its card yet) never
            # gates. This keeps the 409 card-bound and false-positive-free.
            if not execution.cards_affected:
                continue
            raise AgentBusyError(
                active_card_id=execution.cards_affected[0],
                execution_id=execution.id,
            )
        # Persist the reap independently: next_assignment continues past this
        # point (role/stage resolution can raise BadRequestError on a
        # misconfigured pipeline) and that raise would otherwise roll back the
        # abort via get_db's rollback-on-exception.
        if reaped:
            await self.db.commit()

    async def _reap_stranded_suspended_cards(
        self,
        workspace_id: uuid.UUID,
        board_filter: uuid.UUID | None,
    ) -> None:
        """Shed the stale hero from budget-suspend strands so they re-enter the
        implementer's `unassigned_or_rework` scan.

        The strand: a card the runner budget-suspended (which sheds the hero)
        got re-reserved+re-claimed by the storm — re-attaching a hero — then a
        later tick died/paused (cost breaker) without releasing it. Result: a
        card in `active`, carrying a hero, labelled `budget-suspended`, with no
        live execution. The implementer would re-pick it, but its discover is
        gated board-wide by `repo_has_no_open_pr`; with any sibling PR open the
        whole role stalls and the strand sits indefinitely (field incident:
        a client production run, 15h). No role reaps a CARD-level strand — the existing
        zombie reap clears stale execution ROWS only.

        We only shed the hero (not move the card, not strip the suspend label):
        resuming from branch HEAD is the entire point of suspend, and the
        surviving `budget-suspended` label drives the runner's resume brief on
        re-pickup. The hero is the one thing blocking re-discovery.

        Guards against false reaps:
          - A LIVE execution on the card means the hero is real (re-claimed and
            working again) → keep it. Reuses the active-presence horizon so a
            genuinely-busy long tick is never pulled out from under.
          - `updated_at` (bumped by the suspend's own label writes) must be
            older than STRAND_REAP_SECONDS, giving the implementer several of
            its own poll cycles to re-pick before we intervene.

        Committed in its own unit (mirrors the zombie-execution reap) so a later
        raise in next_assignment can't roll the release back — otherwise the
        strand would survive every poll, the write-that-never-persists class
        this whole fix exists to kill.
        """
        from sqlalchemy import String as SAString

        strand_before = datetime.utcnow() - timedelta(seconds=STRAND_REAP_SECONDS)

        # Candidate strands: budget-suspended, in an `active` column, stranded
        # past the horizon. Board-scoped via the workspace's boards (Card has no
        # workspace_id). The JSON-LIKE keys on the quoted label so a substring
        # can't false-match. `board_filter` narrows to one board when the poll
        # was board-scoped, mirroring the rest of next_assignment.
        board_ids = select(Board.id).where(
            Board.workspace_id == workspace_id,
            Board.is_frozen.is_(False),
        )
        if board_filter is not None:
            board_ids = board_ids.where(Board.id == board_filter)

        query = (
            select(Card)
            .join(Column, Card.column_id == Column.id)
            .where(
                Card.board_id.in_(board_ids),
                Column.column_type == "active",
                Card.labels.cast(SAString).like(
                    f'%"{BUDGET_SUSPENDED_LABEL}"%'
                ),
                Card.updated_at < strand_before,
            )
            .options(selectinload(Card.participants))
        )
        result = await self.db.execute(query)
        cards = result.scalars().unique().all()
        if not cards:
            return

        # A live execution on the card means the hero is real (re-claimed and
        # working again) → keep it. Resolve cards_affected membership in Python
        # — SQLite's JSON has no portable list-containment op, the same reason
        # attach_agent_presence does it this way. One batched SELECT.
        horizon_start = datetime.utcnow() - ACTIVE_PRESENCE_HORIZON
        candidate_id_strs = {str(c.id) for c in cards}
        live_exec_result = await self.db.execute(
            select(AgentExecution.cards_affected).where(
                AgentExecution.status.in_(("started", "running")),
                AgentExecution.completed_at.is_(None),
                AgentExecution.started_at >= horizon_start,
            )
        )
        cards_with_live_exec: set[str] = set()
        for (cards_affected,) in live_exec_result.all():
            if not isinstance(cards_affected, list):
                continue
            for raw in cards_affected:
                if isinstance(raw, str) and raw in candidate_id_strs:
                    cards_with_live_exec.add(raw)

        reaped = False
        for card in cards:
            if str(card.id) in cards_with_live_exec:
                continue  # working again — never pull a live tick's hero
            heroes = [p for p in (card.participants or []) if p.role == "hero"]
            if not heroes:
                continue
            for hero in heroes:
                await self.db.delete(hero)
            reaped = True
            # Log-only (mirrors the zombie-execution reap, which also writes no
            # activity row): the reaper runs in an agent-authenticated poll with
            # no human actor, and the participant-list change is itself the
            # auditable record. A fabricated actor_id would just muddy the feed.
            logger.warning(
                "Reaped budget-suspend strand: shed %d hero(es) from card %s "
                "(suspended, in active, no live execution, stranded since %s) "
                "so the implementer can resume from branch HEAD",
                len(heroes), card.id, card.updated_at,
            )

        # Persist independently — see the zombie-execution reap rationale above.
        if reaped:
            await self.db.commit()

    async def _existing_active_reservation(
        self,
        agent_id: uuid.UUID,
        *,
        workspace_id: uuid.UUID,
        board_filter: uuid.UUID | None,
    ) -> AgentReservation | None:
        """Active reservation scoped to *this* workspace (and board, if set).

        An agent can be a member of multiple workspaces — without scoping
        we'd hand back a reservation from workspace A while the runner
        is asking workspace B for work.
        """
        query = select(AgentReservation).where(
            AgentReservation.agent_id == agent_id,
            AgentReservation.workspace_id == workspace_id,
            AgentReservation.expires_at > datetime.utcnow(),
        )
        if board_filter is not None:
            query = query.where(AgentReservation.board_id == board_filter)
        result = await self.db.execute(query)
        return result.scalars().first()

    async def _reservation_still_eligible(
        self,
        reservation: AgentReservation,
        stages: list[dict],
        *,
        workspace_id: uuid.UUID,
    ) -> bool:
        """Does the reserved card still match its role's discover filter?

        Returns False when:
          - The card has moved into a column whose column_type no longer
            matches `discover.column_type` (or matches `column_type_exclude`).
          - The role's strategy is `unassigned_or_rework` and the card now
            has any `hero` participant — the orchestrator's job is done
            once it ships, but the reservation outlives that move and
            would otherwise re-issue on every poll until the 600s TTL
            drained, producing a claim_card 409 loop.
          - The role gates on `filters.column_id` (wave gating) and the card
            has moved out of the gated column(s) — column_type alone cannot
            catch this when the sibling columns share a type.
          - The card no longer satisfies the role's label filters
            (`include_label`/`label`, `require_label`, `exclude_label`) — a
            stage that clears its discover-qualifying label on completion
            (e.g. ui_validator removing `needs-ui-validation` on a pass)
            would otherwise re-issue the same card every poll and re-run a
            paid stage on already-finished work.
          - The card now carries a participant with the role's
            `skip_if_pipeline_role` — once the agent has done the work it is
            attached with that pipeline_role, so a fresh scan would skip it.

        Each check mirrors a predicate in `_candidate_cards`; the two must
        stay in sync or an idempotent re-issue can resurrect a card a fresh
        scan would reject (cost-monotonic re-claim loop). The caller deletes
        the reservation when this returns False so the runner advances
        instead of re-claiming finished work.
        """
        stage = next(
            (s for s in stages if s.get("role") == reservation.role), None
        )
        if stage is None:
            return False

        # Frozen-board check runs UNCONDITIONALLY (like the untyped-column
        # invariant below): a live reservation on a board frozen after the
        # reserve must be dropped, not re-issued until its 600s TTL drains.
        board_frozen = await self.db.scalar(
            select(Board.is_frozen)
            .join(Card, Card.board_id == Board.id)
            .where(Card.id == reservation.card_id)
        )
        if board_frozen:
            return False

        discover = stage.get("discover") or {}
        required = discover.get("column_type") or None
        excluded = discover.get("column_type_exclude") or None
        strategy = discover.get("strategy") or ""
        filters = discover.get("filters") or {}

        # Untyped-column invariant (1ff4e9a): untyped columns are NEVER
        # agent-claimable. _candidate_cards enforces this UNCONDITIONALLY
        # (Column.column_type.isnot(None)), independent of whether the role
        # declares a column_type filter — so the reservation re-check must too,
        # or a column-filter-less role (board_reconciler scans board-wide by
        # label) re-hands a card a human dragged into an untyped column every
        # poll until TTL. So this lookup + null-guard runs ALWAYS, not only when
        # required/excluded are set.
        result = await self.db.execute(
            select(Column.column_type)
            .join(Card, Card.column_id == Column.id)
            .where(Card.id == reservation.card_id)
        )
        column_type = result.scalar_one_or_none()
        if column_type is None:
            return False
        if required or excluded:
            # SQLAlchemy returns the enum value; compare as strings.
            column_type_str = (
                column_type.value
                if hasattr(column_type, "value")
                else column_type
            )
            if required and column_type_str != required:
                return False
            if excluded and column_type_str == excluded:
                return False

        # column_id wave gate — mirror _candidate_cards. A human dragging the
        # reserved card back into the parked wave column must not have it
        # re-issued every poll until the 600s TTL drains.
        gated_column_ids = _as_column_id_list(filters.get("column_id"))
        if gated_column_ids:
            current_column_id = await self.db.scalar(
                select(Card.column_id).where(Card.id == reservation.card_id)
            )
            if current_column_id not in gated_column_ids:
                return False

        if strategy == "unassigned_or_rework":
            heroed = await self.db.execute(
                select(CardParticipant.card_id).where(
                    CardParticipant.card_id == reservation.card_id,
                    CardParticipant.role == "hero",
                )
            )
            if heroed.first() is not None:
                return False

        # Label filters — mirror _candidate_cards. A reservation predates any
        # label change the stage makes on completion, so re-check against the
        # card's CURRENT labels: must carry every include/require label and no
        # exclude label, or it is no longer discover-eligible.
        include_labels = _as_label_list(
            filters.get("include_label") or filters.get("label")
        )
        require_labels = _as_label_list(filters.get("require_label"))
        exclude_labels = _as_label_list(filters.get("exclude_label"))
        # Unknown-repo-slug park — mirror _candidate_cards' role-agnostic
        # exclusion so a live reservation cannot resurrect a parked card.
        exclude_labels.append(REPO_SLUG_UNRESOLVED_LABEL)
        # needs-advisor park — mirror _candidate_cards' reviewer/coder-scoped
        # exclusion. The stuck-loop detector flips the label mid-reservation;
        # without this re-check the same reviewer is re-issued the parked card
        # every poll until the TTL drains — the exact loop the park breaks.
        if reservation.role in ("reviewer", "coder"):
            exclude_labels.append(NEEDS_ADVISOR_LABEL)
        if include_labels or require_labels or exclude_labels:
            labels_result = await self.db.execute(
                select(Card.labels).where(Card.id == reservation.card_id)
            )
            card_labels = set(labels_result.scalar_one_or_none() or [])
            if any(label not in card_labels for label in include_labels):
                return False
            if any(label not in card_labels for label in require_labels):
                return False
            if any(label in card_labels for label in exclude_labels):
                return False

        # skip_if_pipeline_role — mirror _candidate_cards. Once the agent has
        # done the work it is attached with this pipeline_role; a fresh scan
        # would skip the card, so the reservation must not resurrect it.
        skip_pipeline_role = filters.get("skip_if_pipeline_role")
        if skip_pipeline_role:
            participated = await self.db.execute(
                select(CardParticipant.card_id).where(
                    CardParticipant.card_id == reservation.card_id,
                    CardParticipant.pipeline_role == skip_pipeline_role,
                )
            )
            if participated.first() is not None:
                return False

        # require_note_kind_newer_than — mirror _candidate_cards (the freshness
        # gate). WITHOUT this, a rework_mediator reservation made when the gate
        # was TRUE (a fresh review_verdict, no newer brief) keeps being re-issued
        # every poll even AFTER the mediator writes its brief — because the
        # re-issue path used to skip this check while the fresh-scan path
        # enforced it. That split-brain is the 2nd-cycle infinite-mediate loop
        # (M-07): mediate#2 writes a brief newer than the verdict, the fresh
        # scan would now reject the card, but the live reservation re-handed it
        # → mediate#3, forever. Re-evaluate against the card's CURRENT notes and
        # drop the reservation once the brief is fresh, identical to the
        # _candidate_cards predicate.
        newer_than = filters.get("require_note_kind_newer_than")
        if isinstance(newer_than, dict):
            kind = newer_than.get("kind")
            than_kind = newer_than.get("than_kind")
            if kind and than_kind:
                from sqlalchemy import func

                from app.models.notes.note import Note

                newest_kind = await self.db.scalar(
                    select(func.max(Note.created_at)).where(
                        Note.card_id == reservation.card_id, Note.kind == kind
                    )
                )
                newest_than = await self.db.scalar(
                    select(func.max(Note.created_at)).where(
                        Note.card_id == reservation.card_id,
                        Note.kind == than_kind,
                    )
                )
                # Eligible iff a `kind` note exists AND (no `than_kind` note OR
                # the newest `kind` note is strictly newer). Otherwise the brief
                # is current — drop the reservation.
                if newest_kind is None:
                    return False
                if newest_than is not None and newest_kind <= newest_than:
                    return False

        # ---- Cluster B (cell #10): mirror the remaining advanced discover
        # predicates so a reservation made when each was TRUE is dropped once
        # board state flips it FALSE. Each mirrors a `_candidate_cards` gate; the
        # two MUST stay in sync or the re-issue path resurrects a card the fresh
        # scan rejects (cost-monotonic re-claim loop). The gates AND-compose, so
        # the order here is independent of `_candidate_cards`'s; cheapest first.

        # require_git_repo — the board must still have a registered repo.
        if bool(filters.get("require_git_repo", True)):
            has_repo = await self.db.scalar(
                select(GitRepo.board_id)
                .join(Card, Card.board_id == GitRepo.board_id)
                .where(Card.id == reservation.card_id)
                .limit(1)
            )
            if has_repo is None:
                return False

        # require_note_kind (+ optional require_note_failure_class) — the card
        # must still carry a note of the required kind/class.
        require_note_kind = filters.get("require_note_kind")
        if require_note_kind:
            from app.models.notes.note import Note

            note_q = select(Note.card_id).where(
                Note.card_id == reservation.card_id,
                Note.kind == require_note_kind,
            )
            failure_class = filters.get("require_note_failure_class")
            if failure_class:
                note_q = note_q.where(Note.failure_class == failure_class)
            if await self.db.scalar(note_q.limit(1)) is None:
                return False

        # no_other_card_in_flight — a sibling card may have entered active/review
        # WITH a participant or live reservation since this card was reserved.
        if filters.get("no_other_card_in_flight"):
            from sqlalchemy import exists as sa_exists
            from sqlalchemy.orm import aliased

            from app.models.kanban.column import ColumnType

            SiblingCard = aliased(Card)
            SiblingColumn = aliased(Column)
            sibling_has_participant = sa_exists(
                select(CardParticipant.card_id).where(
                    CardParticipant.card_id == SiblingCard.id
                )
            )
            sibling_has_live_reservation = sa_exists(
                select(AgentReservation.card_id).where(
                    AgentReservation.card_id == SiblingCard.id,
                    AgentReservation.card_id != reservation.card_id,
                    AgentReservation.expires_at > datetime.utcnow(),
                )
            )
            in_flight_sibling = await self.db.scalar(
                select(SiblingCard.id)
                .join(SiblingColumn, SiblingCard.column_id == SiblingColumn.id)
                .join(Card, Card.id == reservation.card_id)
                .where(
                    SiblingCard.board_id == Card.board_id,
                    SiblingCard.id != reservation.card_id,
                    SiblingColumn.column_type.in_(
                        (ColumnType.active, ColumnType.review)
                    ),
                    sibling_has_participant | sibling_has_live_reservation,
                )
                .limit(1)
            )
            if in_flight_sibling is not None:
                return False

        from app.services.kanban.completion_dependencies import CompletionDependencyService
        if not await CompletionDependencyService(self.db).source_work_allowed(
            reservation.card_id, workspace_id=workspace_id,
            require_dependencies=bool(filters.get("all_dependencies_done")), lock=True,
        ):
            return False

        # require_pr_url + approval-park both need the Card row — fetch it once.
        # A card deleted mid-reservation (row gone) is no longer eligible.
        card_row = await self.db.scalar(
            select(Card).where(Card.id == reservation.card_id)
        )
        if card_row is None:
            return False

        # require_pr_url — the card's PR url may have been cleared (PR closed).
        if bool(filters.get("require_pr_url", False)) and not _card_has_pr_url(
            card_row
        ):
            return False

        # approval-park — a pending approval may have been raised on this card
        # since the reservation; handing it back would re-derive the analysis.
        remaining = await self._drop_approval_parked(
            [card_row], workspace_id=workspace_id
        )
        if not remaining:
            return False

        return True

    async def _sweep_expired_reservations(self) -> None:
        await self.db.execute(
            delete(AgentReservation).where(
                AgentReservation.expires_at <= datetime.utcnow()
            )
        )
        await self.db.flush()

    async def _resolve_role(
        self,
        agent_id: uuid.UUID,
        stages: list[dict],
        role_override: str | None,
    ) -> str:
        team_info = await TeamService(self.db).get_agent_team_info(agent_id)
        agent_roles: list[str] = list(team_info.roles) if team_info else []
        stage_roles = [s.get("role") for s in stages if s.get("role")]

        if role_override:
            if agent_roles and role_override not in agent_roles:
                raise BadRequestError(
                    f"Agent does not have role {role_override!r}",
                    error_code="role_not_assigned",
                )
            if role_override not in stage_roles:
                raise BadRequestError(
                    f"Pipeline has no stage for role {role_override!r}",
                    error_code="unknown_role",
                )
            return role_override

        for role in agent_roles:
            if role in stage_roles:
                return role

        if not stage_roles:
            raise BadRequestError(
                "Pipeline config has no stages",
                error_code="empty_pipeline",
            )
        return stage_roles[0]

    async def _candidate_cards(
        self,
        *,
        workspace_id: uuid.UUID,
        stage: dict,
        board_filter: uuid.UUID | None,
        agent_id: uuid.UUID,
    ) -> list[Card]:
        discover = stage.get("discover") or {}
        column_type = discover.get("column_type") or None
        exclude_column_type = discover.get("column_type_exclude") or None
        filters = discover.get("filters") or {}

        query = (
            select(Card)
            .join(Board, Card.board_id == Board.id)
            .join(Column, Card.column_id == Column.id)
            .where(
                Board.workspace_id == workspace_id,
                Board.is_frozen.is_(False),
            )
        )
        if board_filter is not None:
            query = query.where(Card.board_id == board_filter)

        # Untyped columns are NEVER agent-claimable (1ff4e9a invariant).
        query = query.where(Column.column_type.isnot(None))

        if column_type:
            query = query.where(Column.column_type == column_type)
        if exclude_column_type:
            query = query.where(Column.column_type != exclude_column_type)

        # Wave gating by column identity. `column_type` cannot separate sibling
        # columns that share a type (Backlog vs To Do, both backlog), so a board
        # split into waves was invisible to discovery. Absent filter = no
        # restriction; mirrored in _reservation_still_eligible.
        gated_column_ids = _as_column_id_list(filters.get("column_id"))
        if gated_column_ids:
            query = query.where(Card.column_id.in_(gated_column_ids))

        # Reserved cards (active reservation rows) are off-limits to other
        # agents and to this agent in this same call. We exclude them
        # entirely; the unique INSERT below is the second line of defense
        # against a race that slips past the SELECT.
        active_reservation_card_ids = select(AgentReservation.card_id).where(
            AgentReservation.expires_at > datetime.utcnow()
        )
        query = query.where(Card.id.notin_(active_reservation_card_ids))

        # PAR-2: a card whose merge is in flight (queued or merging) is owned
        # by the backend merge worker. Re-handing it to a runner would re-fork
        # work that's already on its way to integration_branch.
        from app.models.agents.merge_queue import MergeQueueEntry

        active_merge_card_ids = select(MergeQueueEntry.card_id).where(
            MergeQueueEntry.state.in_(("queued", "merging"))
        )
        query = query.where(Card.id.notin_(active_merge_card_ids))

        # `unassigned_or_rework` strategy skips heroed cards (the legacy
        # orchestrator path). Other strategies (column_scan for reviewer
        # and documentator) must NOT skip them — review cards by design
        # always carry the implementer's hero participant. Mirrors the
        # Go runner's strategy_generic.go discoverColumnScan vs.
        # Loop.discover split.
        strategy = discover.get("strategy") or ""
        if strategy == "unassigned_or_rework":
            hero_exists = (
                select(CardParticipant.card_id)
                .where(CardParticipant.role == "hero")
                .subquery()
            )
            query = query.where(Card.id.notin_(select(hero_exists.c.card_id)))

        # Canonical role-aware skip filter: matches participants by the new
        # pipeline_role column. The legacy `skip_if_participant_role` is kept
        # as a back-compat alias that reads the display-only `role` column;
        # using it logs a deprecation warning.
        skip_pipeline_role = filters.get("skip_if_pipeline_role")
        if skip_pipeline_role:
            same_pipeline_role = (
                select(CardParticipant.card_id)
                .where(CardParticipant.pipeline_role == skip_pipeline_role)
                .subquery()
            )
            query = query.where(
                Card.id.notin_(select(same_pipeline_role.c.card_id))
            )

        skip_role = filters.get("skip_if_participant_role")
        if skip_role:
            logger.warning(
                "discover.filters.skip_if_participant_role is deprecated; "
                "use skip_if_pipeline_role (matches the new pipeline_role "
                "column). Sunset target: end of Q3 2026."
            )
            same_role = (
                select(CardParticipant.card_id)
                .where(
                    CardParticipant.role == skip_role,
                    CardParticipant.agent_id == agent_id,
                )
                .subquery()
            )
            query = query.where(Card.id.notin_(select(same_role.c.card_id)))

        # Symmetric twin of skip_if_pipeline_role: only allow cards where SOME
        # participant carries the named pipeline_role. Useful as "only pick up
        # cards that a planner has already touched". Validator accepts this key
        # (see _DISCOVER_FILTER_KEYS); the consumer landed in bug ab0f39e4.
        require_pipeline_role = filters.get("require_pipeline_role")
        if require_pipeline_role:
            has_pipeline_role = (
                select(CardParticipant.card_id)
                .where(CardParticipant.pipeline_role == require_pipeline_role)
                .subquery()
            )
            query = query.where(
                Card.id.in_(select(has_pipeline_role.c.card_id))
            )

        require_role = filters.get("require_participant_role")
        if require_role:
            logger.warning(
                "discover.filters.require_participant_role is deprecated; "
                "use require_pipeline_role (matches the new pipeline_role "
                "column). Sunset target: end of Q3 2026."
            )
            has_role = (
                select(CardParticipant.card_id)
                .where(CardParticipant.role == require_role)
                .subquery()
            )
            query = query.where(Card.id.in_(select(has_role.c.card_id)))

        # SWE-AF #2: cards flipped to `needs-advisor` by the stuck-loop
        # detector are parked — reviewer/coder roles must skip them. The
        # advisor role (not yet implemented) will be the one to pick them
        # up. We exclude implicitly for the two stuck-loop-relevant roles;
        # other roles (orchestrator, documentator) are unaffected.
        role = stage.get("role")
        if role in ("reviewer", "coder"):
            from sqlalchemy import String as SAString

            query = query.where(
                ~Card.labels.cast(SAString).like(f'%"{NEEDS_ADVISOR_LABEL}"%')
            )

        # Label filters accept a string OR a list (Cluster II Gap 3). A list
        # AND-composes per token: include/require keep cards carrying EVERY
        # listed label; exclude rejects a card carrying ANY listed label. A
        # plain string is treated as a one-element list (back-compat). The
        # JSON-LIKE match keys on the quoted label so `"ui"` never matches
        # `"ui-polish"`.
        from sqlalchemy import String as SAString

        # Unknown-repo-slug park: a card stamped repo-slug-unresolved cannot
        # be routed to any repo, so NO role may pick it up until an operator
        # fixes the slug and removes the label. Role-agnostic, unlike the
        # reviewer/coder-scoped needs-advisor exclusion above.
        query = query.where(
            ~Card.labels.cast(SAString).like(
                f'%"{REPO_SLUG_UNRESOLVED_LABEL}"%'
            )
        )

        for label in _as_label_list(
            filters.get("include_label") or filters.get("label")
        ):
            query = query.where(Card.labels.cast(SAString).like(f'%"{label}"%'))

        for label in _as_label_list(filters.get("exclude_label")):
            query = query.where(~Card.labels.cast(SAString).like(f'%"{label}"%'))

        # Symmetric twin of exclude_label. Distinct from include_label/label
        # above: require_label is the canonical name used by the rework_mediator
        # role's degraded-mode discover filter (see 02-role-redesign.md
        # generic-primitives audit).
        for label in _as_label_list(filters.get("require_label")):
            query = query.where(Card.labels.cast(SAString).like(f'%"{label}"%'))

        # Note-attribute filters (rework_mediator pre-requisites). The two
        # primitives AND-compose: require_note_failure_class only kicks in
        # alongside require_note_kind so it scopes to notes of that kind.
        require_note_kind = filters.get("require_note_kind")
        require_note_failure_class = filters.get("require_note_failure_class")
        if require_note_kind:
            from app.models.notes.note import Note

            note_query = select(Note.card_id).where(
                Note.card_id.isnot(None),
                Note.kind == require_note_kind,
            )
            if require_note_failure_class:
                note_query = note_query.where(
                    Note.failure_class == require_note_failure_class
                )
            query = query.where(Card.id.in_(note_query))

        # Cluster II Gap 2: note-freshness gate. A card is eligible only when
        # its newest `kind` note is strictly newer than its newest `than_kind`
        # note. The rework_mediator uses {kind: review_verdict, than_kind:
        # rework_brief}: it picks up a card only when a fresh review landed
        # AFTER its last brief — replacing the live `exclude_label:
        # rework-brief-ready` workaround that papered over the re-spin. When
        # there is NO `than_kind` note yet, a `kind` note alone qualifies
        # (first mediation pass). When there is no `kind` note, the card is
        # never eligible.
        newer_than = filters.get("require_note_kind_newer_than")
        if isinstance(newer_than, dict):
            kind = newer_than.get("kind")
            than_kind = newer_than.get("than_kind")
            if kind and than_kind:
                from sqlalchemy import func

                from app.models.notes.note import Note

                newest_kind = (
                    select(func.max(Note.created_at))
                    .where(Note.card_id == Card.id, Note.kind == kind)
                    .scalar_subquery()
                )
                newest_than = (
                    select(func.max(Note.created_at))
                    .where(Note.card_id == Card.id, Note.kind == than_kind)
                    .scalar_subquery()
                )
                # Eligible iff a `kind` note exists AND (no `than_kind` note
                # OR the newest `kind` note is strictly newer). func.max over
                # an empty set is NULL; `newest_kind IS NOT NULL` enforces the
                # verdict-exists half, and `newest_than IS NULL OR >` covers
                # the freshness half.
                query = query.where(
                    newest_kind.isnot(None),
                    (newest_than.is_(None)) | (newest_kind > newest_than),
                )

        require_repo = bool(filters.get("require_git_repo", True))
        if require_repo:
            board_with_repo = select(GitRepo.board_id).distinct()
            query = query.where(Card.board_id.in_(board_with_repo))

        # SCH-1: board-scoped in-flight gate. When set, the planner (or any
        # opted-in role) refuses to claim a card on a board that already has
        # another card ACTIVELY WORKED in active/review. Excludes the candidate
        # itself so a column_scan over active doesn't self-block. Spec note
        # 233e4429 §Part B (B2).
        #
        # "In flight" requires a participant or a live reservation — a card
        # merely sitting in active/review with neither is dead state no role
        # can act on (e.g. a fail-path moved a dep-blocked card back to
        # active), and counting it here deadlocks the whole board: the card
        # can't leave the column and the planner can't plan anything else.
        if filters.get("no_other_card_in_flight"):
            from sqlalchemy import exists as sa_exists
            from sqlalchemy.orm import aliased

            from app.models.kanban.column import ColumnType

            SiblingCard = aliased(Card)
            SiblingColumn = aliased(Column)
            sibling_has_participant = sa_exists(
                select(CardParticipant.card_id).where(
                    CardParticipant.card_id == SiblingCard.id
                )
            )
            sibling_has_live_reservation = sa_exists(
                select(AgentReservation.card_id).where(
                    AgentReservation.card_id == SiblingCard.id,
                    AgentReservation.expires_at > datetime.utcnow(),
                )
            )
            sibling_exists = (
                select(SiblingCard.id)
                .join(SiblingColumn, SiblingCard.column_id == SiblingColumn.id)
                .where(
                    SiblingCard.board_id == Card.board_id,
                    SiblingCard.id != Card.id,
                    SiblingColumn.column_type.in_(
                        (ColumnType.active, ColumnType.review)
                    ),
                    sibling_has_participant | sibling_has_live_reservation,
                )
            )
            query = query.where(~sa_exists(sibling_exists))

        from app.services.kanban.completion_dependencies import CompletionDependencyService
        eligibility = CompletionDependencyService(self.db)
        ineligible = await eligibility.accepted_ids(board_id=board_filter, workspace_id=workspace_id)
        if filters.get("all_dependencies_done"):
            ineligible |= await eligibility.blocked_ids(board_id=board_filter, workspace_id=workspace_id)
        if ineligible:
            query = query.where(Card.id.notin_(ineligible))

        query = query.options(
            selectinload(Card.participants).selectinload(CardParticipant.user),
            selectinload(Card.participants).selectinload(CardParticipant.agent),
        )
        # Order on position/created_at for cheap tie-breaks; final
        # priority order is applied in Python via _PRIORITY_ORDER below
        # because SQL string ordering of "urgent/high/medium/low/none"
        # is alphabetical and wrong. LIMIT is generous (500) so the
        # priority re-sort sees a real cross-section without unbounded
        # memory growth on huge boards.
        query = query.order_by(Card.position.asc(), Card.created_at.asc()).limit(500)

        result = await self.db.execute(query)
        cards = list(result.scalars().all())

        cards.sort(
            key=lambda c: (
                _PRIORITY_ORDER.get(getattr(c, "priority", None), 99),
                c.position or 0,
                c.created_at or datetime.utcnow(),
            )
        )

        require_pr_url = bool(filters.get("require_pr_url", False))
        if require_pr_url:
            cards = [c for c in cards if _card_has_pr_url(c)]

        # Cluster I: structural approval park. A card with an undecided
        # pending approval is awaiting a human decision — handing it to any
        # role makes a fresh runner re-derive the analysis and file ANOTHER
        # approval (the M6-03 3x-duplicate / M3-05 88-turn runaway root). The
        # gate is role-agnostic and lives here so every role inherits it.
        # Reuses the same repo query the operator-facing has_pending_approval
        # flag uses, so the expiry + done-column-moot semantics match exactly
        # (an expired `pending` row or a card already in Done does not park).
        cards = await self._drop_approval_parked(cards, workspace_id=workspace_id)

        return cards

    async def _park_if_repo_slug_unresolved(
        self, card: Card, *, workspace_id: uuid.UUID, actor_id: uuid.UUID
    ) -> bool:
        """Park a card whose git_repo_slug matches no repo on its board.

        Returns True when the card was parked (caller skips it). A set-but-
        unknown slug used to silently fall through to the board's "first"
        repo — manufacturing wrong work in the wrong codebase. Hard-fail >
        graceful-degrade for invalid routing input: stamp the reason label
        (the candidate scan excludes it from then on) and surface the
        misconfiguration via WARN log + activity record. NULL slug is the
        legacy default-repo path and is not touched here.
        """
        if not card.git_repo_slug:
            return False

        match = await self.db.scalar(
            select(GitRepo.id)
            .where(
                GitRepo.board_id == card.board_id,
                GitRepo.slug == card.git_repo_slug,
            )
            .limit(1)
        )
        if match is not None:
            return False

        labels = list(card.labels or [])
        if REPO_SLUG_UNRESOLVED_LABEL not in labels:
            labels.append(REPO_SLUG_UNRESOLVED_LABEL)
            card.labels = labels
            await self.db.flush()

        # A parked card holding an open PR can wedge repo_has_no_open_pr-gated
        # roles board-wide — surface the PR in the WARN log + activity detail
        # so operators see the wedge risk, not just the park.
        logger.warning(
            "parking card %s: git_repo_slug %r matches no registered repo "
            "on board %s — fix the slug and remove the %r label to resume%s",
            card.id,
            card.git_repo_slug,
            card.board_id,
            REPO_SLUG_UNRESOLVED_LABEL,
            (
                f" (card holds open PR {card.pr_url} — may wedge "
                "repo_has_no_open_pr-gated roles board-wide)"
                if card.pr_url
                else ""
            ),
        )
        wedge_detail = (
            {
                "pr_url": card.pr_url,
                "wedge_risk": (
                    "parked card holds an open PR — can wedge "
                    "repo_has_no_open_pr-gated roles board-wide"
                ),
            }
            if card.pr_url
            else None
        )
        await ActivityService(self.db).record(
            workspace_id=workspace_id,
            actor_id=actor_id,
            entity_type=ActivityEntityType.card,
            entity_id=card.id,
            action=ActivityAction.updated,
            board_id=card.board_id,
            summary=_repo_slug_park_summary(
                title=card.title, git_repo_slug=card.git_repo_slug
            ),
            message_key="activity.card.parked_unresolved_git_repo",
            message_params={
                "card_title": card.title,
                "git_repo_slug": card.git_repo_slug,
                "label": REPO_SLUG_UNRESOLVED_LABEL,
            },
            changes=wedge_detail,
        )
        return True

    @staticmethod
    def _stage_writes_code(stage: dict) -> str | None:
        """Return the code-writing stage's execution_action, or None if the stage
        does not write code.

        FCH-2 only caps stages whose LLM step is post-processed as `writes_code`
        (implement-class) — a planner/reviewer/board_reconciler that produces a
        note/decision and never a commit must NOT be parked for "no artifact".
        Reads the AUTHORITATIVE lifecycle llm step, not the flat top-level
        `stage.llm` block (which is a partial legacy fallback whose
        post_process_kind is None for the implementer — the b8024b15 split-brain).
        """
        for step in stage.get("lifecycle") or []:
            if step.get("kind") == "llm":
                if (step.get("params") or {}).get("post_process_kind") == "writes_code":
                    return (stage.get("claim") or {}).get("execution_action")
        return None

    async def _park_if_no_progress(
        self,
        card: Card,
        stage: dict,
        role: str,
        *,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID,
    ) -> bool:
        """Park a card that keeps being worked by a code-writing role without
        producing an artifact (FCH-2 — the completed-no-commit money-loop).

        Returns True when the card was parked (caller skips it). The runner can
        return a SUCCESS decision (`completed`) yet produce no commit/PR on a card
        too under-scoped to build — the card never leaves `active`, keeps no
        pr_url, and is re-reserved every poll, burning a full implement pass each
        cycle (a live run: 249× / $250+). No other park covers it: every other
        park keys on the stage FLAGGING trouble; this one signals success.

        The cap is PERSISTED (it counts terminal AgentExecution rows) so it
        survives the runner restart / multi-runner case that defeats the Go
        in-memory `maxConsecutiveNoChangeImplements` counter — the actual reason
        the production loop ran unbounded. Keyed strictly on the SIGNAL
        (artifact-less terminal executions ≥ cap), never on role or card identity.
        """
        execution_action = self._stage_writes_code(stage)
        if execution_action is None:
            return False  # non-code-writing stage — no artifact is expected

        # A card that already produced an artifact is making progress — never park
        # it. The artifact is a pr_url on the card (a commit/PR landed). A card
        # that left `active` is no longer a candidate here, so the only state to
        # check is the pr_url.
        if card.pr_url:
            return False

        cap = self._no_progress_cap(stage)
        if cap <= 0:
            return False  # cap disabled for this workspace/stage

        # Reversible-park reset: count only executions NEWER than the most recent
        # FCH-2 park of this card. A human (or a future recovery lane) removing the
        # `blocked` label is an explicit "re-scoped, try again" — the immutable old
        # executions must NOT instantly re-park it, or the park is a dead-end (the
        # one outcome the north star forbids). After a park the card gets a fresh
        # budget of `cap` artifact-less attempts. The park Activity carries a
        # `fch2_park` sentinel so we find the boundary cheaply (entity index).
        spent = await self._executions_spent_before_last_park(card.id)

        # Count this card's TERMINAL code-writing executions. `cards_affected` is
        # JSON, so pre-filter in SQL on the substring (mirrors the established
        # repositories/agents/execution.py pattern) and refine membership in
        # Python — a card-id substring match can't false-positive across distinct
        # UUIDs, but the refine keeps it exact and cheap (terminal-only set).
        from sqlalchemy import String as SAString
        from sqlalchemy import func

        card_str = str(card.id)
        conds = [
            # Scope to this workspace (indexed) — both a correctness guard against
            # a foreign execution that references the same card-id and a perf
            # bound so the cards_affected scan never spans the whole table.
            AgentExecution.workspace_id == workspace_id,
            AgentExecution.action == execution_action,
            AgentExecution.status.in_(
                (
                    ExecutionStatus.completed,
                    ExecutionStatus.failed,
                    ExecutionStatus.aborted,
                )
            ),
            func.coalesce(
                AgentExecution.cards_affected.cast(SAString), ""
            ).contains(card_str),
        ]
        rows = await self.db.execute(
            select(AgentExecution.id, AgentExecution.cards_affected).where(*conds)
        )
        counted_ids = [
            execution_id
            for execution_id, cards_affected in rows.all()
            if isinstance(cards_affected, list) and card_str in cards_affected
        ]
        # The reset boundary is the SET of executions a previous park already
        # spent, never a timestamp: comparing the park's wall clock against each
        # execution's would invert under a backwards clock step (an NTP
        # correction on a fresh CI VM), resurrecting pre-park executions and
        # instantly re-parking a just-unparked card — the dead-end park FCH-2
        # forbids. Set difference is monotonic under any clock.
        fresh_ids = [str(eid) for eid in counted_ids if str(eid) not in spent]
        attempts = len(fresh_ids)
        if attempts < cap:
            return False

        labels = list(card.labels or [])
        if BLOCKED_LABEL not in labels:
            labels.append(BLOCKED_LABEL)
            card.labels = labels
            await self.db.flush()

        logger.warning(
            "parking card %s for role %s: %d artifact-less %r executions "
            "(>= cap %d) with no pr_url — the completed-no-commit loop. Re-scope "
            "the card to be runnable and remove the %r label to resume.",
            card.id,
            role,
            attempts,
            execution_action,
            cap,
            BLOCKED_LABEL,
        )
        await ActivityService(self.db).record(
            workspace_id=workspace_id,
            actor_id=actor_id,
            entity_type=ActivityEntityType.card,
            entity_id=card.id,
            action=ActivityAction.updated,
            board_id=card.board_id,
            summary=_no_progress_park_summary(
                title=card.title,
                attempts=attempts,
                execution_action=execution_action,
            ),
            message_key="activity.card.parked_no_progress",
            message_params={
                "card_title": card.title,
                "attempt_count": attempts,
                "execution_action": execution_action,
                "label": BLOCKED_LABEL,
            },
            changes={
                "fch2_park": True,
                "artifact_less_attempts": attempts,
                "cap": cap,
                # Every execution this park has now SPENT — the reset boundary a
                # later unpark reads back. Union of the previously-spent set so a
                # card parked repeatedly never re-counts an older generation.
                "spent_execution_ids": sorted(spent | set(fresh_ids)),
            },
        )
        return True

    async def _executions_spent_before_last_park(self, card_id: uuid.UUID) -> set[str]:
        """Ids of the artifact-less executions already SPENT by prior FCH-2 parks
        of this card — empty if it has never been parked. Subtracting this set is
        what makes the park reversible: after an unpark the card gets a fresh
        budget of `cap` NEW artifact-less attempts, and the immutable old
        executions can never re-park it.

        An explicit id set, not a timestamp: a `completed_at > park_created_at`
        comparison assumes the app clock only moves forward, and a backwards step
        (NTP correction on a freshly-booted CI VM) inverts it — every pre-park
        execution counts again and the just-unparked card re-parks on the very
        next poll. Set membership is immune to that, and to clock resolution.

        The park Activity tags its `changes` with `fch2_park`; the sentinel is
        confirmed in Python rather than via a JSON-path predicate
        (`changes["fch2_park"].as_boolean()`) on purpose: that operator compiles
        differently across Postgres (prod) and SQLite (tests), and a dialect skew
        in a reversibility gate would silently re-park an unparked card. A stable
        `summary` substring is the dialect-agnostic SQL pre-filter (entity-indexed
        scan, park activities are rare), then the `fch2_park` flag is the exact
        check. Newest-first; the first park marker wins, and it already carries
        the union of every earlier park's spent ids.

        Parks recorded before this field existed carry no `spent_execution_ids`.
        They fall back to the legacy `created_at` boundary so an in-flight parked
        card keeps its reset across the deploy that ships this change.
        """
        from app.models.activity import Activity

        result = await self.db.execute(
            select(Activity.created_at, Activity.changes)
            .where(
                Activity.entity_type == ActivityEntityType.card,
                Activity.entity_id == card_id,
                Activity.summary.like(f"%{_NO_PROGRESS_PARK_SUMMARY_MARKER}%"),
            )
            .order_by(Activity.created_at.desc())
        )
        for created_at, changes in result.all():
            if not (isinstance(changes, dict) and changes.get("fch2_park") is True):
                continue
            spent = changes.get("spent_execution_ids")
            if isinstance(spent, list):
                return {str(eid) for eid in spent}
            return await self._executions_completed_before(card_id, created_at)
        return set()

    async def _executions_completed_before(
        self, card_id: uuid.UUID, boundary
    ) -> set[str]:
        """Legacy reset boundary, kept only for parks written before
        `spent_execution_ids` existed: the executions a pre-upgrade park would
        have excluded by timestamp. Reads the same rows the caller counts, so it
        stays a pure translation of the old rule into the new set form.
        """
        from sqlalchemy import String as SAString
        from sqlalchemy import func

        card_str = str(card_id)
        rows = await self.db.execute(
            select(AgentExecution.id, AgentExecution.cards_affected).where(
                AgentExecution.completed_at <= boundary,
                func.coalesce(
                    AgentExecution.cards_affected.cast(SAString), ""
                ).contains(card_str),
            )
        )
        return {
            str(execution_id)
            for execution_id, cards_affected in rows.all()
            if isinstance(cards_affected, list) and card_str in cards_affected
        }

    def _no_progress_cap(self, stage: dict) -> int:
        """The artifact-less-execution cap for this stage. A per-stage discover
        override wins; else the platform default. Lets a workspace tune (or
        disable, with 0) the FCH-2 backstop without a code change.
        """
        filters = (stage.get("discover") or {}).get("filters") or {}
        raw = filters.get("no_progress_reservation_cap")
        if isinstance(raw, int):
            return raw
        return NO_PROGRESS_RESERVATION_CAP

    async def _drop_approval_parked(
        self, cards: list[Card], *, workspace_id: uuid.UUID
    ) -> list[Card]:
        if not cards:
            return cards
        from app.repositories.kanban.card import CardRepository

        parked = await CardRepository(self.db).pending_approvals_by_card(
            {c.id for c in cards}, workspace_id=workspace_id
        )
        if not parked:
            return cards
        return [c for c in cards if c.id not in parked]

    async def _build_bundle(
        self,
        reservation: AgentReservation,
        role: str,
        *,
        stage: dict | None = None,
    ) -> dict[str, Any] | None:
        result = await self.db.execute(
            select(Card)
            .where(Card.id == reservation.card_id)
            .options(
                selectinload(Card.participants).selectinload(CardParticipant.user),
                selectinload(Card.participants).selectinload(CardParticipant.agent),
            )
        )
        card = result.scalar_one_or_none()
        if card is None:
            return None

        result = await self.db.execute(
            select(Column).where(Column.id == card.column_id)
        )
        column = result.scalar_one_or_none()
        if column is None:
            return None

        result = await self.db.execute(
            select(Board).where(Board.id == card.board_id)
        )
        board = result.scalar_one_or_none()
        if board is None:
            return None

        # Multi-repo boards: a card may target a specific repo by slug. NULL
        # (every legacy card) → the board's primary repo: oldest created_at,
        # id tie-break — deterministic, never DB default row order. A SET but
        # UNKNOWN slug must NOT degrade to an arbitrary repo (silent misroute
        # → wrong-repo work): refuse the bundle so the caller drops the
        # reservation and the next candidate scan parks the card loudly via
        # _park_if_repo_slug_unresolved.
        repo_query = select(GitRepo).where(GitRepo.board_id == card.board_id)
        if card.git_repo_slug:
            result = await self.db.execute(
                repo_query.where(GitRepo.slug == card.git_repo_slug).limit(1)
            )
            repo = result.scalar_one_or_none()
            if repo is None:
                logger.warning(
                    "refusing bundle for card %s: git_repo_slug %r matches "
                    "no registered repo on board %s",
                    card.id,
                    card.git_repo_slug,
                    card.board_id,
                )
                return None
        else:
            result = await self.db.execute(
                repo_query.order_by(
                    GitRepo.created_at.asc(), GitRepo.id.asc()
                ).limit(1)
            )
            repo = result.scalar_one_or_none()

        if stage is None:
            workspace_id = board.workspace_id
            config = await WorkspaceConfigService(self.db).get_config(
                workspace_id, include_warnings=False
            )
            stages = (config.get("pipeline_config") or {}).get("stages") or []
            stage = next((s for s in stages if s.get("role") == role), {}) or {}

        stage_action = (stage.get("claim") or {}).get("execution_action") or ""

        return {
            "card": card,
            "column": column,
            "board": board,
            "repo": repo,
            "role": role or reservation.role,
            "stage_action": stage_action,
            "reservation": reservation,
            "stage": stage,
        }

    def _github_client_factory(self, board_id):
        """The client the open-PR preconditions gate with, built from the
        BOARD's repo credential rather than one process-wide token."""
        from app.services.scheduling.preconditions import board_github_client_factory

        return board_github_client_factory(self.db, board_id)


def _as_label_list(value: object) -> list[str]:
    """Normalize a label filter value (string | list | None) to a clean list.

    Cluster II Gap 3: discover label filters accept either a single string or
    a list of strings. A non-empty string becomes a one-element list (back-
    compat); a list keeps its non-empty string entries; anything else (None,
    empty string, empty list) yields no tokens — the filter is skipped.
    """
    if isinstance(value, str):
        return [value] if value else []
    if isinstance(value, list):
        return [v for v in value if isinstance(v, str) and v]
    return []


def _as_column_id_list(value: object) -> list[uuid.UUID]:
    """Normalize the `column_id` wave-gating filter to a list of UUIDs.

    Accepts a UUID string or a list of them (list = union of columns); the
    validator rejects other shapes at save time, so anything unparseable here
    is dropped rather than allowed to widen discovery. An empty result means
    no restriction — identical to the filter being absent.
    """
    raw_values = (
        [value] if isinstance(value, str)
        else value if isinstance(value, list)
        else []
    )
    parsed: list[uuid.UUID] = []
    for raw in raw_values:
        if not isinstance(raw, str) or not raw:
            continue
        try:
            parsed.append(uuid.UUID(raw))
        except ValueError:
            continue
    return parsed


def _card_has_pr_url(card: "Card") -> bool:
    """The `require_pr_url` discover filter, preferring the structured `pr_url`
    column over a provider-agnostic PR/MR link in the description.

    The runner persists `pr_url` as a first-class column at PR-creation time, so
    a card can carry a real PR with a description that never embeds the footer
    (the F0-04 shape). The old description-only scan silently dropped such cards
    from assignment even though `preconditions.pr_is_open` already recognized
    the same PR via the column — the two gates disagreed on one card.

    The footer fallback recognizes every forge the runner can target (cell #11:
    GitHub /pull/, Gitea /pulls/, GitLab /-/merge_requests/) by sharing
    `preconditions._text_has_pr_url` / `_PR_URL_IN_TEXT` with the
    pr_is_open precondition — the two layers must never diverge on which URLs
    they accept, or a non-GitHub card is discoverable by one gate and invisible
    to the other (the white-label split-brain)."""
    if getattr(card, "pr_url", None):
        return True
    return _text_has_pr_url(card.description or "")
