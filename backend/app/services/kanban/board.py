# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.core.events import BOARD_LOOP_UPDATED
from app.exceptions import (
    BoardFrozenError,
    ConflictError,
    ForbiddenError,
    ResourceNotFoundError,
    ValidationError,
)
from app.models.activity import ActivityAction, ActivityEntityType
from app.models.kanban.column import ColumnType
from app.models.kanban.loop_transition import BoardLoopTransition
from app.models.workspace import WorkspaceRole
from app.repositories.definitions.definition import DefinitionRepository
from app.repositories.kanban.board import BoardRepository
from app.repositories.kanban.column import ColumnRepository
from app.repositories.git.git_repo import GitRepoRepository
from app.repositories.kanban.loop_transition import BoardLoopTransitionRepository
from app.schemas.kanban.board import BoardCreate, BoardRead, BoardUpdate
from app.schemas.kanban.loop import LoopConfigPut, LoopStatePatch
from app.services.activity import ActivityService
from app.services.loop_config_validation import (
    LOOP_CONFIG_DEFAULTS,
    SKILLS_PROPOSAL_TOOL,
    canonicalize_loop_config,
    validate_loop_config,
)
from app.services.kanban.card import (
    attach_agent_presence,
    attach_dependency_counts,
    attach_pending_approvals,
    compute_loop_readiness,
)
from app.services.kanban.loop_binding import (
    DIFFABLE_DRIFT_KINDS,
    BindingNotFoundError,
    LoopBindingService,
    raw_edited_for,
    slim_ref,
)
from app.services.kanban.snapshots import snapshot_column
from app.utils import slugify

logger = logging.getLogger(__name__)


def _snapshot_board(board) -> dict:
    return {
        "id": str(board.id),
        "name": board.name,
        "description": board.description,
        "slug": board.slug,
        # Admin-tier security control: the audit trail must show the
        # override's old→new transition, not just that the field changed.
        "enforce_done_merge_gate": board.enforce_done_merge_gate,
    }


DEFAULT_COLUMNS = [
    ("To Do", "#6b7280", ColumnType.backlog),
    ("In Progress", "#3b82f6", ColumnType.active),
    ("Blocked", "#ef4444", ColumnType.blocked),
    ("Done", "#22c55e", ColumnType.done),
]

_DISABLED_LOOP_FIELDS = (
    "disabled_reason",
    "disabled_reason_code",
    "disabled_reason_params",
    "disabled_diagnostic",
)


class BoardService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.board_repo = BoardRepository(db)
        self.column_repo = ColumnRepository(db)
        self.definition_repo = DefinitionRepository(db)
        self.git_repo_repo = GitRepoRepository(db)
        self.loop_transition_repo = BoardLoopTransitionRepository(db)

    async def list_boards(self, workspace_id: uuid.UUID):
        rows = await self.board_repo.list_by_workspace_with_stats(workspace_id)
        with_definition = await self.definition_repo.board_ids_with_definition(
            [board.id for board, _, _, _ in rows]
        )
        return [
            BoardRead.model_validate(board).model_copy(
                update={
                    "card_count": card_count,
                    "column_count": column_count,
                    "last_activity_at": last_activity_at,
                    "has_definition": board.id in with_definition,
                }
            )
            for board, card_count, column_count, last_activity_at in rows
        ]

    async def _next_available_slug(self, workspace_id: uuid.UUID, base: str) -> str:
        # Linear probe: "foo", "foo-2", "foo-3", ... Board counts per workspace
        # stay low enough that O(n) is fine here.
        if not await self.board_repo.slug_exists(workspace_id, base):
            return base
        counter = 2
        while True:
            candidate = f"{base}-{counter}"
            if not await self.board_repo.slug_exists(workspace_id, candidate):
                return candidate
            counter += 1

    async def create_board(
        self, workspace_id: uuid.UUID, data: BoardCreate, user_id: uuid.UUID
    ):
        # Idempotent on user-supplied slug collision (LLM-retry resilience).
        if data.slug:
            existing = await self.board_repo.get_by_slug(workspace_id, data.slug)
            if existing:
                return existing
            slug = data.slug
        else:
            slug = await self._next_available_slug(
                workspace_id, slugify(data.name, fallback="board")
            )

        board = await self.board_repo.create(
            workspace_id=workspace_id,
            name=data.name,
            slug=slug,
            description=data.description,
            tags=data.tags,
            created_by=user_id,
        )
        activity = ActivityService(self.db)
        if not data.skip_default_columns:
            for i, (name, color, column_type) in enumerate(DEFAULT_COLUMNS):
                column = await self.column_repo.create(
                    board_id=board.id,
                    name=name,
                    position=float((i + 1) * 1024),
                    color=color,
                    column_type=column_type,
                )
                await activity.record(
                    workspace_id=workspace_id,
                    actor_id=user_id,
                    entity_type=ActivityEntityType.column,
                    entity_id=column.id,
                    action=ActivityAction.created,
                    board_id=board.id,
                    summary=f"created column '{name}'",
                    message_key="activity.column.created",
                    message_params={"column_name": name},
                    after_state=snapshot_column(column),
                )
        await activity.record(
            workspace_id=workspace_id,
            actor_id=user_id,
            entity_type=ActivityEntityType.board,
            entity_id=board.id,
            action=ActivityAction.created,
            board_id=board.id,
            summary=f"created board '{data.name}'",
            message_key="activity.board.created",
            message_params={"board_name": data.name},
            after_state=_snapshot_board(board),
        )
        return board

    async def get_full_board(self, board_id: uuid.UUID, workspace_id: uuid.UUID):
        board = await self.board_repo.get_full_board(board_id)
        if not board or board.workspace_id != workspace_id:
            raise ResourceNotFoundError("Board not found")
        all_cards = [card for column in board.columns for card in column.cards]
        await attach_pending_approvals(self.db, all_cards, workspace_id=workspace_id)
        await attach_agent_presence(self.db, all_cards)
        await attach_dependency_counts(self.db, all_cards)
        # Stamped plain attribute, not a column_property: an unloaded
        # column_property would lazy-load on create paths (MissingGreenlet).
        board.has_definition = bool(
            await self.definition_repo.board_ids_with_definition([board.id])
        )
        return board

    async def get_board_by_identifier(self, identifier: str, workspace_id: uuid.UUID):
        """Resolve a board by UUID first, falling back to slug within the workspace."""
        try:
            board_uuid = uuid.UUID(identifier)
        except ValueError:
            board_uuid = None
        if board_uuid is not None:
            return await self.get_full_board(board_uuid, workspace_id)

        board = await self.board_repo.get_by_slug(workspace_id, identifier)
        if not board:
            raise ResourceNotFoundError("Board not found")
        return await self.get_full_board(board.id, workspace_id)

    async def update_board(
        self,
        board_id: uuid.UUID,
        workspace_id: uuid.UUID,
        data: BoardUpdate,
        actor_id: uuid.UUID | None = None,
        actor_role: WorkspaceRole | None = None,
    ):
        board = await self.board_repo.get_by_id(board_id)
        if not board or board.workspace_id != workspace_id:
            raise ResourceNotFoundError("Board not found")
        if board.is_frozen:
            raise BoardFrozenError()
        # The route is member-gated as a whole; the done-gate override alone is
        # admin/owner tier (same as freeze — it decides whether agents may
        # self-declare Done). Keyed on model_fields_set so a member's ordinary
        # PATCH keeps working, and an explicit null still counts as a change.
        #
        # A board's own CREATOR is admitted alongside owner/admin (card B10):
        # the operator who makes a board and configures a self-merging loop on
        # it should not need to find an admin to un-arm the gate they just
        # armed. Deliberately narrow — it is THIS board only, and it is the
        # field rather than one value of it, so a creator can also re-arm.
        # Agent-key callers are rejected at the route by forbid_agent_callers,
        # so this branch only ever sees human actors.
        may_set_gate_override = actor_role in (
            WorkspaceRole.owner,
            WorkspaceRole.admin,
        ) or (actor_id is not None and actor_id == board.created_by)
        if (
            "enforce_done_merge_gate" in data.model_fields_set
            and not may_set_gate_override
        ):
            raise ForbiddenError(
                "Only a workspace admin or the board's creator may change the "
                "done-merge gate override",
                error_code="admin_required",
            )
        if data.slug is not None and data.slug != board.slug:
            if await self.board_repo.slug_exists(
                workspace_id, data.slug, exclude_id=board.id
            ):
                raise ConflictError(
                    f"Board slug '{data.slug}' already exists in this workspace"
                )
        before_state = _snapshot_board(board)
        changed_fields = list(data.model_dump(exclude_unset=True).keys())
        updated = await self.board_repo.update(
            board, **data.model_dump(exclude_unset=True)
        )
        if actor_id:
            activity = ActivityService(self.db)
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.board,
                entity_id=board_id,
                action=ActivityAction.updated,
                board_id=board_id,
                summary=f"updated board '{updated.name}': changed {', '.join(changed_fields)}",
                message_key="activity.board.updated",
                message_params={
                    "board_name": updated.name,
                    "fields": changed_fields,
                },
                changes={"fields": changed_fields},
                before_state=before_state,
                after_state=_snapshot_board(updated),
            )
        return updated

    async def delete_board(
        self,
        board_id: uuid.UUID,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID | None = None,
    ):
        board = await self.board_repo.get_by_id(board_id)
        if not board or board.workspace_id != workspace_id:
            raise ResourceNotFoundError("Board not found")
        if board.is_frozen:
            raise BoardFrozenError()
        if actor_id:
            activity = ActivityService(self.db)
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.board,
                entity_id=board_id,
                action=ActivityAction.deleted,
                board_id=board_id,
                summary=f"deleted board '{board.name}'",
                message_key="activity.board.deleted",
                message_params={"board_name": board.name},
                before_state=_snapshot_board(board),
            )
        await self.board_repo.delete_by_id(board.id)

    async def freeze_board(
        self, board_id: uuid.UUID, workspace_id: uuid.UUID, actor_id: uuid.UUID
    ):
        return await self._set_frozen(board_id, workspace_id, actor_id, frozen=True)

    async def unfreeze_board(
        self, board_id: uuid.UUID, workspace_id: uuid.UUID, actor_id: uuid.UUID
    ):
        return await self._set_frozen(board_id, workspace_id, actor_id, frozen=False)

    async def _set_frozen(
        self,
        board_id: uuid.UUID,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID,
        *,
        frozen: bool,
    ):
        board = await self.board_repo.get_by_id(board_id)
        if not board or board.workspace_id != workspace_id:
            raise ResourceNotFoundError("Board not found")
        # Idempotent: re-freezing keeps the original frozen_at/frozen_by_id
        # and records no duplicate activity.
        if board.is_frozen == frozen:
            return board
        before_state = _snapshot_board(board)
        updated = await self.board_repo.update(
            board,
            is_frozen=frozen,
            # Naive UTC: frozen_at is TIMESTAMP WITHOUT TIME ZONE — asyncpg
            # rejects tz-aware values (500 in prod; SQLite tests strip the tz).
            frozen_at=datetime.utcnow() if frozen else None,
            frozen_by_id=actor_id if frozen else None,
        )
        activity = ActivityService(self.db)
        await activity.record(
            workspace_id=workspace_id,
            actor_id=actor_id,
            entity_type=ActivityEntityType.board,
            entity_id=board_id,
            action=ActivityAction.updated,
            board_id=board_id,
            summary=f"{'froze' if frozen else 'unfroze'} board '{updated.name}'",
            message_key=(
                "activity.board.frozen" if frozen else "activity.board.unfrozen"
            ),
            message_params={"board_name": updated.name},
            changes={"fields": ["is_frozen"]},
            before_state=before_state,
            after_state=_snapshot_board(updated),
        )
        return updated

    # --- loop mode (docs/loop-mode-contract.md) ---

    async def _get_board_or_404(self, board_id: uuid.UUID, workspace_id: uuid.UUID):
        board = await self.board_repo.get_by_id(board_id)
        if not board or board.workspace_id != workspace_id:
            raise ResourceNotFoundError("Board not found")
        return board

    async def get_loop_config(
        self, board_id: uuid.UUID, workspace_id: uuid.UUID, *, completion_protocol_version: str | None = None
    ) -> dict:
        board = await self._get_board_or_404(board_id, workspace_id)
        if board.loop_config is None:
            # 404 is reserved strictly for "unconfigured" — the runner exits
            # fatal on it by design. Never collapse other errors into 404.
            raise ResourceNotFoundError("Loop mode not configured for this board")
        config = await self._with_template_ref(board_id, board.loop_config)
        from app.core.auth import current_agent_id
        from app.services.completion_policy import CompletionPolicyService
        from app.services.completion_context import assemble_mandatory_completion_context

        resolution = await CompletionPolicyService(self.db).resolve(board)
        if resolution["effective_policy"] is not None:
            if current_agent_id.get() is not None and completion_protocol_version != "1":
                raise ConflictError(
                    "Upgrade this runner to completion protocol 1 before executing an explicit completion policy",
                    error_code="completion_runner_upgrade_required",
                )
            if resolution["incompatibilities"] and (current_agent_id.get() is not None or completion_protocol_version is not None):
                raise ConflictError(resolution["incompatibilities"], error_code="completion_policy_incompatible")
            config["completion_policy"] = resolution["effective_policy"]
            config["completion_policy_hash"] = resolution["policy_hash"]
            context, report = await assemble_mandatory_completion_context(self.db, board, resolution["effective_policy"])
            if not report["within_limit"] and (current_agent_id.get() is not None or completion_protocol_version is not None):
                raise ConflictError("Mandatory completion context exceeds 128 KiB; reduce pinned context before running", error_code="completion_context_too_large")
            config["completion_context_size"] = report
            config["completion_context"] = context if report["within_limit"] else ""
        # Serve-side strip: with proposals off, the config the runner reads
        # must not hand the session the propose tool at all. Only the SERVED
        # copy narrows — the stored allowlist keeps the tool for when the flag
        # flips back. An empty allowlist grants the full platform surface, so
        # there is nothing to strip from and no narrower list is fabricated.
        proposals_enabled = config.get(
            "skills_proposal_enabled",
            LOOP_CONFIG_DEFAULTS["skills_proposal_enabled"],
        )
        if not proposals_enabled and config.get("tools"):
            config["tools"] = [t for t in config["tools"] if t != SKILLS_PROPOSAL_TOOL]
        return config

    async def _with_template_ref(self, board_id: uuid.UUID, config: dict) -> dict:
        """Attach the slim `template` ref (and its drift verdict) to a config.

        Drift is computed on READ rather than stored, because it is a statement
        about the CATALOG, not about this board: a system template bumped by a
        deploy must show as drifted without anyone re-saving every bound board.
        The rendered prompts themselves are still save-time only.
        """
        binding_service = LoopBindingService(self.db)
        return {
            **config,
            "template": await binding_service.resolve_slim_ref(board_id, config),
        }

    async def get_loop_binding(
        self, board_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> dict:
        board = await self._get_board_or_404(board_id, workspace_id)
        binding_service = LoopBindingService(self.db)
        binding = await binding_service.get_binding(board_id)
        if binding is None:
            raise BindingNotFoundError()

        current_version = await binding_service.current_version_for(binding)
        drift = await binding_service.full_drift_for(binding, board.loop_config)
        return {
            "template": slim_ref(
                binding,
                current_version,
                raw_edited=raw_edited_for(binding, board.loop_config),
            ),
            "slot_values": binding.slot_values,
            "rendered_at": binding.rendered_at.isoformat(),
            "rendered_hash": binding.rendered_hash,
            "drift": drift,
            # A diff only means something once the TEMPLATE moved; offering
            # the link otherwise would render an empty panel. `raw_edited` and
            # `binding_corrupt` are both drift ABOUT THE BINDING, with two
            # identical template snapshots behind them.
            "diff_available": drift["kind"] in DIFFABLE_DRIFT_KINDS,
        }

    async def get_loop_binding_diff(
        self, board_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> dict:
        await self._get_board_or_404(board_id, workspace_id)
        binding_service = LoopBindingService(self.db)
        binding = await binding_service.get_binding(board_id)
        if binding is None:
            raise BindingNotFoundError()
        return await binding_service.diff_for(binding)

    async def get_loop_readiness(
        self, board_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> dict:
        # A pure board read: answers even with no loop_config stored. 404 here
        # means "board not found" only — the runner treats a readiness 404 as
        # "pre-rollout backend" and falls back to always_run, so conflating it
        # with "loop unconfigured" would silently disable parking.
        from app.services.completion import CompletionService

        board = await self._get_board_or_404(board_id, workspace_id)
        readiness = await compute_loop_readiness(self.db, board_id)
        completion = await CompletionService(self.db).work_counts(board)
        return {
            **readiness,
            "pending_completion": completion["pending_count"],
            "failed_completion": completion["failed_count"],
        }

    async def get_loop_history(
        self, board_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> dict:
        """Cross-run continuity aggregate: all-time loop_iteration count +
        cost_usd summed since the config's budget_epoch (all-time when no
        epoch — conservative on money). Pure board read like readiness."""
        board = await self._get_board_or_404(board_id, workspace_id)
        return await self._loop_iteration_totals(board)

    async def _loop_iteration_totals(self, board) -> dict:
        """History aggregates for an already-loaded board — split out so
        get_loop_status can reuse the computation without a second board
        fetch per poll."""
        from sqlalchemy import func, select

        from app.models.agents.execution import AgentExecution

        board_id = board.id
        budget_epoch = (board.loop_config or {}).get("budget_epoch")

        base = select(
            func.count(),
            func.coalesce(func.sum(AgentExecution.cost_usd), 0.0),
        ).where(
            AgentExecution.board_id == board_id,
            AgentExecution.action == "loop_iteration",
        )
        count, _ = (await self.db.execute(base)).one()
        spent_stmt = select(func.coalesce(func.sum(AgentExecution.cost_usd), 0.0)).where(
            AgentExecution.board_id == board_id,
            AgentExecution.action.in_(("loop_iteration", "completion_review", "completion_evidence_review", "completion_validation")),
        )
        lifetime_spent = await self.db.scalar(spent_stmt)

        if budget_epoch:
            since = datetime.fromisoformat(budget_epoch)
            # SQLite (tests) strips tzinfo; compare naive-to-naive.
            since = since.replace(tzinfo=None)
            spent_stmt = spent_stmt.where(AgentExecution.started_at >= since)
        spent = await self.db.scalar(spent_stmt)

        return {
            "iteration_count": int(count),
            "spent_usd": float(spent),
            "lifetime_spent_usd": float(lifetime_spent),
            "budget_epoch": budget_epoch,
        }

    async def get_loop_status(
        self, board_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> dict:
        """Loop truth layer: config + in-flight iterations + bound-agent
        liveness stitched into one state. Pure board read like readiness —
        unconfigured serves state="off", never 404 (404 stays board-not-found
        only). `off` wins even over an in-flight iteration, but the in-flight
        fact is still reported truthfully so the UI can show "off (draining)".
        """
        from app.repositories.agents.execution import ExecutionRepository
        from app.repositories.agents.team import TeamRepository
        from app.services.agents.liveness import compute_liveness

        board = await self._get_board_or_404(board_id, workspace_id)
        config = board.loop_config or {}
        enabled = bool(config.get("enabled"))

        execution_repo = ExecutionRepository(self.db)
        has_inflight = await execution_repo.has_inflight_loop_iteration(board_id)
        last_iteration = await execution_repo.latest_loop_iteration(board_id)

        bound_agents = await TeamRepository(self.db).list_bound_agents_by_board(
            board_id
        )
        alive_agents = [
            agent
            for agent in bound_agents
            if compute_liveness(agent.last_seen_at) == "alive"
        ]
        alive_count = len(alive_agents)

        # Parked is runner truth, not a readiness guess: only an ALIVE agent
        # that reported parking ON THIS BOARD counts. Liveness is what expires
        # the claim — a killed runner's last heartbeat says `parked` forever,
        # and honoring that would invert the whole point of the distinction.
        board_key = str(board_id)
        parked_agent = next(
            (
                agent
                for agent in alive_agents
                if agent.health_loop_state == "parked"
                and agent.health_loop_board_id == board_key
            ),
            None,
        )

        readiness = await compute_loop_readiness(self.db, board_id)
        history = await self._loop_iteration_totals(board)

        park_reason = None
        if not enabled:
            state = "off"
        elif has_inflight:
            # An in-flight iteration is newer than any heartbeat that set the
            # parked flag, so `running` still wins.
            state = "running"
        elif parked_agent is not None:
            state = "parked"
            park_reason = parked_agent.health_loop_park_reason
        elif alive_count > 0:
            state = "waiting"
        else:
            state = "unattended"

        last_at = last_iteration and (
            last_iteration.completed_at or last_iteration.started_at
        )
        # Survives a re-enable, unlike disabled_reason: the chip must still be
        # able to explain the previous run's ending while the next one turns.
        last_stop = await self.loop_transition_repo.last_stop_for_board(board_id)

        return {
            "state": state,
            "enabled": enabled,
            "disabled_reason": config.get("disabled_reason"),
            "last_stop_reason": last_stop.reason if last_stop else None,
            "last_stop_at": last_stop.occurred_at.isoformat() if last_stop else None,
            "park_reason": park_reason,
            "actionable": readiness["actionable"],
            "has_inflight_iteration": has_inflight,
            "last_iteration_at": last_at.isoformat() if last_at else None,
            "last_iteration_status": (
                last_iteration.status.value if last_iteration else None
            ),
            "bound_agent_count": len(bound_agents),
            "alive_agent_count": alive_count,
            "spent_usd": history["spent_usd"],
            "budget_usd": config.get("budget_usd"),
        }

    async def put_loop_config(
        self,
        board_id: uuid.UUID,
        workspace_id: uuid.UUID,
        data: LoopConfigPut,
        actor_id: uuid.UUID,
    ) -> dict:
        from app.services.completion_policy import CompletionPolicyService
        board = await CompletionPolicyService(self.db).lock_board_for_completion(board_id, workspace_id)
        if board.is_frozen:
            raise BoardFrozenError()
        existing = board.loop_config
        if (
            data.expected_version is not None
            and existing
            and existing["version"] != data.expected_version
        ):
            raise ConflictError(
                f"Loop config version mismatch: expected {data.expected_version}, "
                f"current {existing['version']}"
            )
        policy_changed = "completion_policy" in data.model_fields_set
        if policy_changed:
            # The outer request transaction rolls back both policy and loop if
            # rendering or validation fails. Validate their composed result below.
            await CompletionPolicyService(self.db).set_policy(
                board_id, workspace_id, actor_id, data.completion_policy, validate=False,
            )

        # relax_done_merge_gate is deliberately NOT excluded here: it is a
        # board-column write, and canonicalize_loop_config only ever copies
        # keys present in LOOP_CONFIG_DEFAULTS, so a non-config key cannot
        # reach the stored object or the runner's wire shape. Adding it to the
        # exclude set would read as load-bearing when it is not.
        body = data.model_dump(exclude={"expected_version", "template", "completion_policy"})
        binding_service = LoopBindingService(self.db)
        binding = await binding_service.get_binding(board_id)
        # The template key is three-state like completion_query: a dict binds,
        # {} detaches, None (or absent) leaves the binding alone.
        binds = bool(data.template)
        detaches = data.template == {}
        binding_service.guard_raw_prompts(
            body, is_bound=binding is not None and not detaches, binds=binds
        )

        template_ref = None
        # Naming the template is what lets the board timeline distinguish a
        # rebind from a budget tweak; entity_type stays `board` either way.
        # `template_event` carries the localized twin: (slug, version) feed the
        # message params, and which of the three literal callsites below runs.
        template_summary = None
        template_event: dict | None = None
        if detaches:
            detached_slug = await binding_service.detach(board_id, binding)
            binding = None
            if detached_slug:
                template_summary = f"detached loop template {detached_slug}"
                template_event = {"kind": "detached", "slug": detached_slug}
        elif binds:
            bound = await binding_service.bind(
                board_id=board_id,
                workspace_id=workspace_id,
                request=data.template,
                actor_id=actor_id,
                existing_binding=binding,
                # A rail the SAME body set explicitly outranks the template's
                # default — the operator typed it here on purpose.
                explicit_fields={k for k, v in body.items() if v is not None},
                stored_config=existing,
                proposed_config=body,
            )
            body.update(bound["config"])
            template_ref = bound["template"]
            verb = "re-rendered" if bound["rebind"] else "bound"
            template_summary = (
                f"{verb} loop template {bound['slug']}@v{bound['version']}"
            )
            template_event = {
                "kind": "rerendered" if bound["rebind"] else "bound",
                "slug": bound["slug"],
                "version": bound["version"],
            }
        elif binding is not None:
            template_ref = await binding_service.resolve_slim_ref(board_id)

        config = canonicalize_loop_config(
            # `or None`: this method treats any falsy loop_config as
            # unconfigured (see the version bump below) — keep canonicalize's
            # first-write path on the same definition.
            body,
            stored=existing or None,
        )
        findings = validate_loop_config(config)
        if findings:
            raise ValidationError(detail=[dict(f) for f in findings])

        if config["enabled"] or policy_changed:
            await self._assert_completion_compatible(board, config)
        elif config.get("disabled_reason") == "objective_complete":
            await self._assert_completion_finished(board)

        # Read the CANONICAL landing, not the request body: a PUT that omits
        # loop_landing inherits the stored value (or the `human` default), and
        # relaxing the gate is only coherent under the landing that trips it.
        # Refusing beats ignoring — a silently dropped consent leaves the
        # operator believing the gate is off while it is still armed.
        # Consent to drop the gate is a human act. PUT /loop admits agent keys
        # on purpose (it is the loop's own off-switch) and an agent key carries
        # its creating admin's role, so without this the agent the gate exists
        # to constrain could un-arm it in one call. Lazy import as in
        # activity.py / merge_queue.py: core.auth and the service layer load
        # each other lazily.
        from app.core.auth import current_agent_id

        caller_is_agent = current_agent_id.get() is not None
        if data.relax_done_merge_gate and caller_is_agent:
            raise ForbiddenError(
                "Only a human workspace admin or the board's creator may relax "
                "the done-merge gate — not an agent key",
                error_code="admin_required",
            )
        if data.relax_done_merge_gate and config["loop_landing"] != "self_merge":
            raise ValidationError(
                "The done-merge gate can only be relaxed for a self_merge "
                f"landing, not '{config['loop_landing']}'",
                error_code="relax_gate_requires_self_merge",
                error_params={"loop_landing": config["loop_landing"]},
            )

        config["version"] = existing["version"] + 1 if existing else 1
        config["updated_at"] = datetime.now(timezone.utc).isoformat()
        # Enabling clears the full stop record; a disabled save keeps it so the
        # board still shows why the loop stopped. Missing keys on historical
        # configs become explicit nulls on the next write.
        for field in _DISABLED_LOOP_FIELDS:
            config[field] = None if config["enabled"] else (existing or {}).get(field)
        # budget_epoch is server-owned: a disabled→enabled transition starts a
        # fresh budget window; anything else (edits while enabled, disabled
        # saves) preserves it — moving it on an edit would silently reset the
        # cumulative budget rail.
        was_enabled = bool(existing and existing.get("enabled"))
        if config["enabled"] and not was_enabled:
            config["budget_epoch"] = datetime.now(timezone.utc).isoformat()
        else:
            config["budget_epoch"] = (existing or {}).get("budget_epoch")
        # The stamp rides the loop save rather than a follow-up PATCH from the
        # client: a second round-trip leaves a window where the loop is saved,
        # enabled, and the gate still armed. Only ever writes THIS board's
        # override — the workspace flag is a tenant-wide lever and not ours.
        #
        # A human save landing on self_merge relaxes the gate by DEFAULT: that
        # landing can never satisfy the gate (it merges with no reviewed PR by
        # construction), so choosing it is the consent — explicit
        # relax_done_merge_gate=false is the decline lever. Agents never
        # auto-relax; for them the armed gate is the security boundary.
        #
        # "Choosing" means THIS request: the landing was in the body or came
        # from a template bound in the same PUT (both live in `body` by now).
        # A landing merely inherited from the stored config never stamps —
        # agents may store self_merge, and keying on the inherited value would
        # let that staged landing convert any later innocent human save (a
        # budget tweak) into consent the human never gave. The implicit stamp
        # is further limited to where the dialog shows its notice — override
        # unset, workspace gate on, a repo linked — because a consent the UI
        # never surfaced is not consent; and it never softens an explicit True
        # (an admin hardening act). The EXPLICIT signal predates all of that
        # and keeps its unconditional shape: asked for by name, it stamps.
        stored_landing = (existing or {}).get("loop_landing")
        requested_landing = body.get("loop_landing")
        gate_override_before = board.enforce_done_merge_gate
        if data.relax_done_merge_gate is True:
            auto_relax = True
        elif caller_is_agent or data.relax_done_merge_gate is False:
            auto_relax = False
        else:
            auto_relax = (
                requested_landing == "self_merge"
                and gate_override_before is None
                and await self._done_gate_bites(board_id, workspace_id)
            )
        # The relax follows the landing: moving off self_merge restores the
        # override to NULL (inherit) so the gate re-arms for a landing that
        # can satisfy it. Caller-agnostic on purpose — re-arming is the safe
        # direction, and a human-only rule would let an agent carry a relaxed
        # gate into a landing the gate should cover. This deliberately
        # clobbers a coincidental MANUAL False set via board PATCH — there is
        # no provenance marker, and a re-armed gate is the recoverable mistake
        # (BoardSettingsDialog can turn it back off) while a silently-off
        # gate is not.
        rearm = (
            stored_landing == "self_merge"
            and config["loop_landing"] != "self_merge"
            and gate_override_before is False
        )
        from app.services.completion_policy import CompletionPolicyService
        if await CompletionPolicyService(self.db).effective_policy(board) is not None:
            auto_relax = False
            rearm = False
        if auto_relax:
            await self.board_repo.update(
                board, loop_config=config, enforce_done_merge_gate=False
            )
        elif rearm:
            await self.board_repo.update(
                board, loop_config=config, enforce_done_merge_gate=None
            )
        else:
            await self.board_repo.update(board, loop_config=config)
        # A PUT that flips the switch is the same domain event as PATCH
        # /state; a PUT that only edits knobs is not, and recording those
        # would bury the timeline under prompt tweaks. The first-ever PUT
        # counts as a transition only when it lands enabled — a board created
        # in the default disabled state has not "stopped".
        if config["enabled"] != was_enabled:
            await self._record_loop_transition(
                board,
                workspace_id,
                config["enabled"],
                config.get("disabled_reason"),
                actor_id,
            )

        activity = ActivityService(self.db)
        # Four literal callsites rather than one parameterized call: the
        # activity-message contract audits keys and param names statically, and
        # a computed message_key would slip past it unaudited.
        if template_event is None:
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.board,
                entity_id=board_id,
                action=ActivityAction.updated,
                board_id=board_id,
                summary="updated loop config",
                message_key="activity.board.loop_config_updated",
                message_params={},
                changes={"fields": ["loop_config"]},
            )
        elif template_event["kind"] == "detached":
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.board,
                entity_id=board_id,
                action=ActivityAction.updated,
                board_id=board_id,
                summary=template_summary,
                message_key="activity.board.loop_template_detached",
                message_params={"template_slug": template_event["slug"]},
                changes={"fields": ["loop_config"]},
            )
        else:
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.board,
                entity_id=board_id,
                action=ActivityAction.updated,
                board_id=board_id,
                summary=template_summary,
                message_key=(
                    "activity.board.loop_template_rerendered"
                    if template_event["kind"] == "rerendered"
                    else "activity.board.loop_template_bound"
                ),
                message_params={
                    "template_slug": template_event["slug"],
                    "template_version": template_event["version"],
                },
                changes={"fields": ["loop_config"]},
            )
        # Flipping an admin-tier safety control gets its own timeline entry —
        # riding it on "updated loop config" would bury it. Only on an actual
        # transition: idempotent re-saves of a relaxed board stay quiet.
        if auto_relax and gate_override_before is not False:
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.board,
                entity_id=board_id,
                action=ActivityAction.updated,
                board_id=board_id,
                summary="relaxed the done-merge gate for a self_merge loop",
                message_key="activity.board.done_gate_auto_relaxed",
                message_params={},
                changes={"fields": ["enforce_done_merge_gate"]},
            )
        elif rearm:
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.board,
                entity_id=board_id,
                action=ActivityAction.updated,
                board_id=board_id,
                summary="re-armed the done-merge gate",
                message_key="activity.board.done_gate_rearmed",
                message_params={},
                changes={"fields": ["enforce_done_merge_gate"]},
            )
        await self._publish_loop_updated(workspace_id, board_id, config)
        resolution = await CompletionPolicyService(self.db).resolve(board)
        return {**config, "template": template_ref, "completion_context_size": resolution["context_size"]}

    async def _done_gate_bites(
        self, board_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> bool:
        """Would the done gate actually block this board's loop?

        Mirrors the gate's own resolution (CardService._gate_enabled_for_*):
        default-on workspace flag, and the structural repo-less exemption. The
        board override is checked by the caller — by the time this runs it is
        known to be NULL.
        """
        from app.models.workspace_config import WorkspaceConfig

        from sqlalchemy import select

        flag = await self.db.scalar(
            select(WorkspaceConfig.enforce_done_merge_gate).where(
                WorkspaceConfig.workspace_id == workspace_id
            )
        )
        if flag is not None and not flag:
            return False
        return await self.git_repo_repo.exists_for_board(board_id)

    async def set_loop_state(
        self,
        board_id: uuid.UUID,
        workspace_id: uuid.UUID,
        data: LoopStatePatch,
        actor_id: uuid.UUID,
    ) -> dict:
        from app.services.completion_policy import CompletionPolicyService
        board = await CompletionPolicyService(self.db).lock_board_for_completion(board_id, workspace_id)
        if board.is_frozen:
            raise BoardFrozenError()
        if not data.enabled and (data.reason == "objective_complete" or data.reason_code == "objective_complete"):
            await self._assert_completion_finished(board)
        existing = board.loop_config
        if existing is None:
            raise ResourceNotFoundError("Loop mode not configured for this board")
        if data.enabled:
            await self._assert_completion_compatible(board, existing)
        # Idempotent: same-state returns the current object untouched — no
        # version bump, no activity, no WS event (mirrors _set_frozen).
        if existing["enabled"] == data.enabled:
            return await self._with_template_ref(board_id, existing)

        config = {**existing, "enabled": data.enabled}
        findings = validate_loop_config(config)  # enable requires loop_prompt
        if findings:
            raise ValidationError(detail=[dict(f) for f in findings])

        config["version"] = existing["version"] + 1
        config["updated_at"] = datetime.now(timezone.utc).isoformat()
        if data.enabled:
            for field in _DISABLED_LOOP_FIELDS:
                config[field] = None
            # Re-enable = a fresh budget window (this is the operator's budget
            # reset lever); disable preserves the epoch.
            config["budget_epoch"] = datetime.now(timezone.utc).isoformat()
        else:
            # Empty reason stores null — disabled_reason is null-or-meaningful,
            # never "". Structured metadata is present only as a complete,
            # schema-validated set; the diagnostic remains server state and is
            # deliberately excluded from the thin websocket payload.
            config["disabled_reason"] = data.reason or None
            config["disabled_reason_code"] = data.reason_code
            config["disabled_reason_params"] = (
                dict(data.reason_params) if data.reason_code is not None else None
            )
            config["disabled_diagnostic"] = (
                data.diagnostic if data.reason_code is not None else None
            )
        await self.board_repo.update(board, loop_config=config)
        await self._record_loop_transition(
            board, workspace_id, config["enabled"], data.reason, actor_id
        )

        activity = ActivityService(self.db)
        await activity.record(
            workspace_id=workspace_id,
            actor_id=actor_id,
            entity_type=ActivityEntityType.board,
            entity_id=board_id,
            action=ActivityAction.updated,
            board_id=board_id,
            summary=(
                "enabled loop"
                if data.enabled
                else f"disabled loop: {data.reason}"
                if data.reason
                else "disabled loop"
            ),
            # A free-form stop reason carries user-authored meaning that cannot
            # be reconstructed from safe params. Keep that case on the exact
            # legacy summary fallback instead of publishing a lossy key.
            message_key=(
                "activity.board.loop_enabled"
                if data.enabled
                else (
                    "activity.board.loop_disabled"
                    if data.reason_code is not None or not data.reason
                    else None
                )
            ),
            message_params=(
                {}
                if data.enabled or data.reason_code is not None or not data.reason
                else None
            ),
            changes={"fields": ["loop_config"]},
        )
        await self._publish_loop_updated(workspace_id, board_id, config)
        return await self._with_template_ref(board_id, config)

    async def _assert_completion_finished(self, board):
        from app.core.auth import current_agent_id
        from app.services.completion import CompletionService
        from app.services.completion_policy import CompletionPolicyService
        if current_agent_id.get() is None or await CompletionPolicyService(self.db).effective_policy(board) is None:
            return
        work = await CompletionService(self.db).work_counts(board)
        if work["pending_count"] or work["failed_count"]:
            raise ConflictError("Completion acceptance is still pending or failed", error_code="completion_work_pending")

    async def _assert_completion_compatible(self, board, config):
        from app.services.completion_policy import CompletionPolicyService
        service = CompletionPolicyService(self.db)
        findings = await service.incompatibilities(board, await service.effective_policy(board), loop_config=config)
        if findings:
            raise ConflictError(findings, error_code="completion_policy_incompatible")

    async def _record_loop_transition(
        self,
        board,
        workspace_id: uuid.UUID,
        enabled: bool,
        reason: str | None,
        actor_id: uuid.UUID,
    ) -> None:
        """Append one row to the board's loop timeline.

        Called ONLY on an actual state change — a prompt edit or a same-state
        PATCH is not a transition, and recording those would bury the handful
        of rows an operator opened the timeline to read.
        """
        from app.core.auth import current_agent_id

        totals = await self._loop_iteration_totals(board)
        self.db.add(
            BoardLoopTransition(
                board_id=board.id,
                workspace_id=workspace_id,
                enabled=enabled,
                # Null-or-meaningful, never "" — mirrors disabled_reason.
                reason=reason or None,
                actor_id=actor_id,
                agent_id=current_agent_id.get(),
                iteration_count=totals["iteration_count"],
            )
        )
        await self.db.flush()

    async def get_loop_transitions(
        self,
        board_id: uuid.UUID,
        workspace_id: uuid.UUID,
        limit: int,
        offset: int,
    ) -> dict:
        # A pure history read: an unconfigured board has an empty timeline,
        # not a 404. The UI renders every board's loop panel without
        # special-casing "never configured".
        await self._get_board_or_404(board_id, workspace_id)
        rows = await self.loop_transition_repo.list_for_board(board_id, limit, offset)
        total = await self.loop_transition_repo.count_for_board(board_id)
        return {
            "transitions": [_serialize_loop_transition(row) for row in rows],
            "total": total,
        }

    async def _publish_loop_updated(
        self, workspace_id: uuid.UUID, board_id: uuid.UUID, config: dict
    ) -> None:
        # No board rooms exist — clients filter on the stringified board_id, so
        # the thin payload must carry it (7900-byte NOTIFY cap: ids + state only).
        try:
            await event_bus.publish(
                event_type=BOARD_LOOP_UPDATED,
                payload={
                    "workspace_id": str(workspace_id),
                    "board_id": str(board_id),
                    "enabled": config["enabled"],
                    "version": config["version"],
                    "disabled_reason": config["disabled_reason"],
                },
                workspace_id=workspace_id,
            )
        except Exception:
            logger.exception("Failed to publish BOARD_LOOP_UPDATED")


def _serialize_loop_transition(row) -> dict:
    """Wire shape for one timeline row.

    `source` is derived from the credential that made the flip, never from the
    reason text: an agent API key means the runner stopped itself (a rail or
    its own objective_complete), anything else is a person at the console.
    """
    return {
        "id": str(row.id),
        "enabled": row.enabled,
        "reason": row.reason,
        "source": "runner" if row.agent_id else "human",
        "actor_name": row.actor.name if row.actor else None,
        "agent_name": row.agent.name if row.agent else None,
        "iteration_count": row.iteration_count,
        "occurred_at": row.occurred_at.isoformat(),
    }
