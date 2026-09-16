# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import logging
import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.core.auth import current_agent_id
from app.core.event_bus import event_bus
from app.core.workspace import enforce_agent_scope
from app.exceptions import ResourceNotFoundError, ValidationError
from app.models.agents.agent import Agent
from app.models.agents.execution import ExecutionStatus
from app.models.workspace import Workspace
from app.utils import utcnow
from app.repositories.agents.execution import ExecutionRepository
from app.repositories.agents.reservation import AgentReservationRepository
from app.repositories.config_template import BoardLoopTemplateBindingRepository
from app.repositories.kanban.board import BoardRepository
from app.repositories.kanban.card import CardRepository
from app.services.agents.identity import verify_caller_owns_agent
from app.services.loop_template_stamp import STAMP_PREFIX, binding_template_key
from app.schemas.agents.execution import (
    CardRef,
    ExecutionCreate,
    ExecutionUpdate,
    ExecutionWarningCreate,
)

logger = logging.getLogger(__name__)

# The card_id and inflight branches count by re-fetching their (scope-bounded)
# row set rather than by SQL, so the fetch needs an explicit ceiling. A card's
# pipeline history and a workspace's in-flight rows are both small by
# construction; this only exists so a pathological board cannot fetch
# unbounded rows to compute a number.
_UNPAGED_CEILING = 1000


def _has_outcome(output_summary: str | None, outcome: str) -> bool:
    """Mirror of the SQL `outcome=<value>` token match — see
    ExecutionRepository._workspace_filters."""
    if not output_summary:
        return False
    return f"outcome={outcome}".lower() in output_summary.lower()


def _guard_skills_manifest(execution, update_data: dict) -> None:
    """Skills-manifest honesty, the completed-stays-completed sibling: the
    manifest records what actually ran, so it lands exactly once — onto a
    still-NULL row. `exclude_unset` keeps an explicit skills=None visible in
    update_data, so a confused retry would otherwise clear it."""
    if "skills" in update_data and (
        update_data["skills"] is None or execution.skills is not None
    ):
        update_data.pop("skills")


def _matches_search(execution, term: str) -> bool:
    """Mirror of the SQL search: case-insensitive across BOTH summaries,
    because the iteration number lives in input_summary and the outcome prose
    lives in output_summary."""
    needle = term.lower()
    return any(
        field and needle in field.lower()
        for field in (execution.input_summary, execution.output_summary)
    )


class ExecutionService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = ExecutionRepository(db)
        self.reservation_repo = AgentReservationRepository(db)
        self.card_repo = CardRepository(db)
        self.board_repo = BoardRepository(db)
        self.binding_repo = BoardLoopTemplateBindingRepository(db)

    async def _resolve_workspace(self, slug: str) -> uuid.UUID:
        # The slug arrives in the request body, not the path, so no route
        # dependency has vetted it — an agent could name any workspace and write
        # its execution, cost and cards_affected rows there.
        await enforce_agent_scope(current_agent_id.get(), slug, self.db)

        result = await self.db.execute(select(Workspace).where(Workspace.slug == slug))
        ws = result.scalar_one_or_none()
        if not ws:
            raise ResourceNotFoundError(f"Workspace '{slug}' not found")
        return ws.id

    async def _get_agent(
        self, agent_id: uuid.UUID, user_id: uuid.UUID | None = None
    ) -> Agent:
        result = await self.db.execute(select(Agent).where(Agent.id == agent_id))
        agent = result.scalar_one_or_none()
        if not agent:
            raise ResourceNotFoundError("Agent not found")
        verify_caller_owns_agent(
            agent,
            actor_id=user_id,
            foreign_user_error=lambda: ResourceNotFoundError("Agent not found"),
        )
        return agent

    async def _loop_template_stamp(self, data: ExecutionCreate) -> str | None:
        """Which loop template rendered this iteration, as a `prompt_slug`.

        Only loop iterations on a bound board are stamped: a pipeline stage
        sharing the board runs its own prompt, and crediting it to the loop
        template would inflate the track record with work the template never
        drove.
        """
        if data.action != "loop_iteration" or data.board_id is None:
            return None
        binding = await self.binding_repo.get_by_board(data.board_id)
        return binding_template_key(binding)

    async def _verify_board_tenancy(
        self, board_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> None:
        """The slug and the board id arrive from the SAME caller, so nothing has
        yet established that they belong together.

        Pairing workspace A's slug with workspace B's board id used to write the
        row under A while reading B's loop-template binding — leaking which
        template another tenant runs and crediting B's track record with A's
        work. A board that does not exist and a board owned by someone else are
        indistinguishable to the caller by design.
        """
        board = await self.board_repo.get_by_id(board_id)
        if board is None or board.workspace_id != workspace_id:
            raise ResourceNotFoundError(f"Board '{board_id}' not found")

    def _reject_reserved_prompt_slug(self, data: ExecutionCreate) -> None:
        """Only the server mints `loop-template:` keys.

        The stamp's writer and reader must never drift onto different key
        formats (see `services/loop_template_stamp`), and the track record is
        the one number an operator reads to decide whether a loop works — a
        caller that could hand-write the namespace could redirect it.
        """
        if data.prompt_slug and data.prompt_slug.startswith(STAMP_PREFIX):
            raise ValidationError(
                f"prompt_slug '{data.prompt_slug}' uses the reserved "
                f"'{STAMP_PREFIX}' namespace, which only the server may mint",
                error_code="reserved_prompt_slug",
                error_params={"prompt_slug": data.prompt_slug},
            )

    async def start_execution(
        self,
        agent_id: uuid.UUID,
        data: ExecutionCreate,
        user_id: uuid.UUID | None = None,
    ):
        await self._get_agent(agent_id, user_id)
        self._reject_reserved_prompt_slug(data)
        workspace_id = await self._resolve_workspace(data.workspace_slug)
        if data.board_id is not None:
            # BEFORE the binding read and before the row is created: a
            # cross-tenant call must neither observe a foreign binding nor
            # leave a row behind.
            await self._verify_board_tenancy(data.board_id, workspace_id)

        # Bind the reserved card at START so `agent_presence='active'` is
        # authoritative the moment work begins. The runner never sets
        # cards_affected (only the LLM sometimes does, via log_execution_update),
        # which is why the board stayed blind to in-flight work while
        # activity/history — keyed on Activity.agent_id — reflected it. A card
        # binding here closes that gap; later updates may extend the list.
        cards_affected = [str(data.card_id)] if data.card_id else None

        # A loop iteration is attributed by the SERVER, never by the runner:
        # the stamp wins outright, and an unbound board stamps nothing rather
        # than falling back to whatever the caller typed. Every other action
        # keeps the caller's value — a pipeline stage names its own prompt.
        stamp = await self._loop_template_stamp(data)
        prompt_slug = stamp if data.action == "loop_iteration" else data.prompt_slug

        execution = await self.repo.create(
            agent_id=agent_id,
            workspace_id=workspace_id,
            board_id=data.board_id,
            session_id=data.session_id,
            action=data.action,
            status=ExecutionStatus.started,
            input_summary=data.input_summary,
            cards_affected=cards_affected,
            parent_execution_id=data.parent_execution_id,
            role=data.role,
            input_prompt=data.input_prompt,
            prompt_slug=prompt_slug,
            model=data.model,
            provider=data.provider,
            skills=data.skills,
        )

        try:
            await event_bus.publish(
                event_type=events.EXECUTION_STARTED,
                payload={
                    "execution_id": str(execution.id),
                    "agent_id": str(agent_id),
                    "action": data.action,
                    "input_summary": data.input_summary,
                    "board_id": str(data.board_id) if data.board_id else None,
                    "card_id": str(data.card_id) if data.card_id else None,
                },
                workspace_id=workspace_id,
            )
        except Exception:
            logger.exception("Failed to publish EXECUTION_STARTED event")

        return await self._attach_card_refs_one(execution)

    async def update_execution(
        self,
        agent_id: uuid.UUID,
        execution_id: uuid.UUID,
        data: ExecutionUpdate,
        user_id: uuid.UUID | None = None,
    ):
        await self._get_agent(agent_id, user_id)
        execution = await self.repo.get_by_id(execution_id)
        if not execution or execution.agent_id != agent_id:
            # Fat-finger fallback: LLM stages free-type their execution_id and
            # a one-digit typo used to 404 the model into a flail loop (run-B
            # B3). With exactly ONE in-flight execution for this agent the
            # target is unambiguous — apply the update there. Two or more, or
            # none (only terminal rows), stays a hard 404: never guess.
            inflight = await self.repo.list_inflight_by_agent(agent_id)
            if len(inflight) != 1:
                raise ResourceNotFoundError("Execution not found")
            execution = inflight[0]
            logger.warning(
                "execution-update fallback: unknown execution_id %s for agent %s "
                "— applied to its single in-flight execution %s",
                execution_id,
                agent_id,
                execution.id,
            )

        # Telemetry honesty: a COMPLETED stage stays completed. A late
        # `failed` write (a confused model retry) keeps its forensics fields
        # but must not downgrade the status the runner already finalized.
        # The reverse (failed → completed) stays allowed — the runner's
        # authoritative stage-end close heals a wrong model self-fail.
        demote_to_field_update = (
            execution.status == ExecutionStatus.completed
            and data.status == ExecutionStatus.failed
        )
        if demote_to_field_update:
            logger.warning(
                "execution %s is completed; ignoring late failed-status write",
                execution.id,
            )
            update_data = data.model_dump(exclude_unset=True)
            update_data.pop("status", None)
            _guard_skills_manifest(execution, update_data)
            if update_data:
                return await self._attach_card_refs_one(
                    await self.repo.update(execution, **update_data)
                )
            return await self._attach_card_refs_one(execution)

        is_terminal = data.status in (
            ExecutionStatus.completed,
            ExecutionStatus.failed,
            ExecutionStatus.aborted,
            ExecutionStatus.skipped,
        )

        update_data = data.model_dump(exclude_unset=True)
        _guard_skills_manifest(execution, update_data)
        if is_terminal:
            update_data["completed_at"] = utcnow()

        result = await self.repo.update(execution, **update_data)

        # Explicit reservation cleanup on stage completion. Mirrors the
        # execution lifecycle so the happy path no longer relies on the
        # next /next-assignment poll's `_reservation_still_eligible` filter
        # to drop stale rows. The TTL sweep + eligibility check remain as
        # defense-in-depth fallbacks (see assignment_service.py).
        # Scoped to completed | failed per task 6a3695c1; aborted/skipped
        # still drain via TTL so we don't conflate "stage finished" with
        # "stage was never really run".
        if data.status in (ExecutionStatus.completed, ExecutionStatus.failed):
            cleared_card_id = self._reservation_card_id_for(result)
            if cleared_card_id is not None and result.role:
                await self.reservation_repo.delete_by_keys(
                    agent_id=result.agent_id,
                    card_id=cleared_card_id,
                    role=result.role,
                )

        if is_terminal:
            try:
                # board_id/card_id/agent_id let the frontend board filter
                # (payload.board_id === boardUuid) clear a card's active
                # indicator on terminal — especially the failed path — and
                # let the runner match its own agent for self-suppression.
                card_id = self._reservation_card_id_for(result)
                await event_bus.publish(
                    event_type=events.EXECUTION_COMPLETED,
                    payload={
                        # execution.id, not the path arg — the fat-finger
                        # fallback may have resolved a typo'd execution_id.
                        "execution_id": str(execution.id),
                        "status": data.status.value,
                        "cost_usd": data.cost_usd,
                        "tokens_used": data.tokens_used,
                        "output_summary": data.output_summary,
                        "error_message": data.error_message,
                        "board_id": str(result.board_id) if result.board_id else None,
                        "card_id": str(card_id) if card_id else None,
                        "agent_id": str(result.agent_id) if result.agent_id else None,
                    },
                    workspace_id=execution.workspace_id,
                )
            except Exception:
                logger.exception("Failed to publish EXECUTION_COMPLETED event")

            # Lower-latency cost-breaker eval: don't wait for the next
            # /next-assignment poll to discover that an execution-complete
            # tipped the workspace over its threshold.
            try:
                from app.services.agents.cost import evaluate_circuit_breaker
                from app.services.workspace_config import WorkspaceConfigService

                # include_warnings=False: the breaker reads only
                # cost_circuit_breaker — skip the prompt-content wiring lint.
                ws_config = await WorkspaceConfigService(self.db).get_config(
                    execution.workspace_id, include_warnings=False
                )
                await evaluate_circuit_breaker(
                    self.db,
                    workspace_id=execution.workspace_id,
                    breaker_config=ws_config.get("cost_circuit_breaker"),
                )
            except Exception:
                logger.exception(
                    "Cost circuit-breaker eval failed on execution complete"
                )

        return await self._attach_card_refs_one(result)

    @staticmethod
    def _reservation_card_id_for(execution) -> uuid.UUID | None:
        """Return the card UUID a reservation would key off, or None.

        The execution model stores cards as a JSON list of stringified UUIDs
        (`cards_affected`). Reservations are card-bound, so a non-card
        execution (e.g. mcp_session, standup) has no matching reservation
        — return None and let the deletion be a no-op.
        """
        cards = execution.cards_affected or []
        if not cards:
            return None
        raw = cards[0]
        if isinstance(raw, uuid.UUID):
            return raw
        try:
            return uuid.UUID(str(raw))
        except (ValueError, TypeError):
            return None

    @staticmethod
    def _parse_card_ids(execution) -> list[uuid.UUID]:
        """Coerce an execution's cards_affected (JSON str list) to UUIDs,
        preserving order and dropping unparseable entries — same tolerance as
        `_reservation_card_id_for`."""
        parsed: list[uuid.UUID] = []
        for raw in execution.cards_affected or []:
            if isinstance(raw, uuid.UUID):
                parsed.append(raw)
                continue
            try:
                parsed.append(uuid.UUID(str(raw)))
            except (ValueError, TypeError):
                continue
        return parsed

    async def _attach_card_refs(self, executions: list) -> list:
        """Set the transient `cards_affected_detail` on each execution.

        Collects the UNION of every cards_affected UUID across the whole batch
        and resolves it in ONE query (no N+1), then per execution keeps only the
        cards that resolved (deleted cards drop out; their id stays in the raw
        cards_affected). ExecutionRead.from_attributes reads the plain attribute.
        """
        all_ids: set[uuid.UUID] = set()
        parsed_by_execution: dict[uuid.UUID, list[uuid.UUID]] = {}
        for execution in executions:
            parsed = self._parse_card_ids(execution)
            parsed_by_execution[execution.id] = parsed
            all_ids.update(parsed)

        resolved = await self.card_repo.get_refs_by_ids(all_ids)

        for execution in executions:
            execution.cards_affected_detail = [
                CardRef(
                    id=str(cid),
                    title=resolved[cid][0],
                    board_id=str(resolved[cid][1]) if resolved[cid][1] else None,
                )
                for cid in parsed_by_execution[execution.id]
                if cid in resolved
            ]
        return executions

    async def _attach_card_refs_one(self, execution):
        await self._attach_card_refs([execution])
        return execution

    async def record_warning(
        self,
        agent_id: uuid.UUID,
        execution_id: uuid.UUID,
        data: ExecutionWarningCreate,
        user_id: uuid.UUID | None = None,
    ):
        """Append a typed warning to the execution AND fan out as a WS event.

        Same-kind duplicates are intentionally not deduped — the operator
        wants to see the rate of repeated deadline trips, not just the
        first one. Backend storage is append-only.
        """
        await self._get_agent(agent_id, user_id)
        execution = await self.repo.get_by_id(execution_id)
        if not execution or execution.agent_id != agent_id:
            raise ResourceNotFoundError("Execution not found")

        existing = list(execution.ship_warnings or [])
        existing.append(f"[{data.kind}] {data.message}")
        await self.repo.update(execution, ship_warnings=existing)

        try:
            await event_bus.publish(
                event_type=events.EXECUTION_WARNING,
                payload={
                    "execution_id": str(execution_id),
                    "agent_id": str(agent_id),
                    "card_id": str(data.card_id) if data.card_id else None,
                    "board_id": str(execution.board_id) if execution.board_id else None,
                    "kind": data.kind,
                    "message": data.message,
                },
                workspace_id=execution.workspace_id,
            )
        except Exception:
            logger.exception("Failed to publish EXECUTION_WARNING event")

    async def list_executions(
        self,
        agent_id: uuid.UUID,
        limit: int = 50,
        role: str | None = None,
        user_id: uuid.UUID | None = None,
        offset: int = 0,
        with_tool_invocations: bool = True,
    ):
        await self._get_agent(agent_id, user_id)
        return await self._attach_card_refs(
            await self.repo.list_by_agent(
                agent_id,
                limit,
                role=role,
                offset=offset,
                with_tool_invocations=with_tool_invocations,
            )
        )

    async def skipped_card_ids(self, workspace_id: uuid.UUID) -> list[str]:
        """Union of card ids across the workspace's `skipped` executions — the
        board's single-request source for per-card "needs prompt" badges."""
        return await self.repo.skipped_card_ids(workspace_id)

    async def get_workspace_execution(
        self, workspace_id: uuid.UUID, execution_id: uuid.UUID
    ):
        """One execution, scoped to the workspace. Returns None both when the id
        is unknown and when it belongs to another workspace, so the router's 404
        never reveals that an id exists somewhere else."""
        execution = await self.repo.get_by_id(execution_id)
        if execution is None or execution.workspace_id != workspace_id:
            return None
        return await self._attach_card_refs_one(execution)

    async def list_workspace_executions_page(
        self,
        workspace_id: uuid.UUID,
        limit: int = 50,
        status: str | None = None,
        agent_id: uuid.UUID | None = None,
        role: str | None = None,
        card_id: uuid.UUID | None = None,
        board_id: uuid.UUID | None = None,
        action: str | None = None,
        outcome: str | None = None,
        q: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        offset: int = 0,
        with_tool_invocations: bool = True,
    ) -> tuple[list, int]:
        """The paged rows plus the UNPAGED total for the same filter set.

        Split from `list_workspace_executions` (which stays the bare-list API
        every existing caller uses) because the total rides an
        `X-Total-Count` header rather than an envelope — the response body
        must remain a plain array for the frontend's `Execution[]` typing and
        the six backward-compat tests in test_workspace_executions_filters.py.
        """
        rows = await self.list_workspace_executions(
            workspace_id,
            limit,
            status=status,
            agent_id=agent_id,
            role=role,
            card_id=card_id,
            board_id=board_id,
            action=action,
            outcome=outcome,
            q=q,
            since=since,
            until=until,
            offset=offset,
            with_tool_invocations=with_tool_invocations,
        )
        # The card_id and inflight branches are scope-bounded and post-filtered
        # in Python (see below), so their total is what that branch actually
        # matched, unpaged — asking the repo for a SQL count would ignore the
        # very post-filters that produced the rows.
        if card_id is not None or status == "inflight":
            unpaged = await self.list_workspace_executions(
                workspace_id,
                limit=_UNPAGED_CEILING,
                status=status,
                agent_id=agent_id,
                role=role,
                card_id=card_id,
                board_id=board_id,
                action=action,
                outcome=outcome,
                q=q,
                since=since,
                until=until,
            )
            return rows, len(unpaged)
        total = await self.repo.count_by_workspace(
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
        return rows, total

    async def list_workspace_executions(
        self,
        workspace_id: uuid.UUID,
        limit: int = 50,
        status: str | None = None,
        agent_id: uuid.UUID | None = None,
        role: str | None = None,
        card_id: uuid.UUID | None = None,
        board_id: uuid.UUID | None = None,
        action: str | None = None,
        outcome: str | None = None,
        q: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        offset: int = 0,
        with_tool_invocations: bool = True,
    ):
        # The two scope branches below bypass list_by_workspace's SQL filters,
        # so the remaining filters must be applied as post-filters over the
        # (small, scope-bounded) fetched rows — otherwise agent_id/role/status
        # are silently dropped and e.g. `agent_id=A&status=inflight` hands the
        # caller OTHER agents' running rows straight before cancel_execution.
        # board_id/action join the same closure so the board-scoped loop-mode
        # telemetry feed (card ea43b848) gets the same guarantee regardless of
        # which branch a given request happens to take.
        def _matches_agent_and_role(e) -> bool:
            if agent_id is not None and e.agent_id != agent_id:
                return False
            if role is not None and e.role != role:
                return False
            if board_id is not None and e.board_id != board_id:
                return False
            if action is not None and e.action != action:
                return False
            # outcome/q/since/until mirror the SQL filters in
            # ExecutionRepository._workspace_filters. They have to be repeated
            # here for the same reason agent_id/role are: these two branches
            # never reach that query, and a filter silently dropped on one
            # code path is worse than one that never existed.
            if outcome is not None and not _has_outcome(e.output_summary, outcome):
                return False
            if q is not None and not _matches_search(e, q):
                return False
            if since is not None and e.started_at is not None and e.started_at < since:
                return False
            if until is not None and e.started_at is not None and e.started_at > until:
                return False
            return True

        # card_id is a server-side scope: a card's full pipeline history must not
        # depend on falling inside the workspace-wide newest-50 window (a done
        # card's executions are older than that → the card-detail sheet read
        # empty before this branch existed).
        if card_id is not None:
            rows = [
                e
                for e in await self.repo.list_by_card(workspace_id, card_id)
                if _matches_agent_and_role(e)
            ]
            if status == "inflight":
                # `inflight` is virtual (see below) — string equality against a
                # stored status would silently match nothing here.
                rows = [
                    e
                    for e in rows
                    if e.status in (ExecutionStatus.started, ExecutionStatus.running)
                    and e.completed_at is None
                ]
            elif status is not None:
                rows = [e for e in rows if e.status == status]
            return await self._attach_card_refs(rows)
        # `inflight` is a virtual status meaning "actively working now" — the
        # union of started+running with no completed_at, unbounded by the page
        # window so the board/dashboard "working" surfaces never miss a row.
        if status == "inflight":
            return await self._attach_card_refs(
                [
                    e
                    for e in await self.repo.list_inflight_by_workspace(workspace_id)
                    if _matches_agent_and_role(e)
                ]
            )
        return await self._attach_card_refs(
            await self.repo.list_by_workspace(
                workspace_id,
                limit,
                status=status,
                agent_id=agent_id,
                role=role,
                board_id=board_id,
                action=action,
                outcome=outcome,
                q=q,
                since=since,
                until=until,
                offset=offset,
                with_tool_invocations=with_tool_invocations,
            )
        )
