# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import asyncio
import logging
import uuid
from datetime import datetime, timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.core.events import (
    AGENT_HARD_DELETED,
    AGENT_HEARTBEAT_RECEIVED,
    AGENT_PAUSED,
    AGENT_POLL_REQUESTED,
    AGENT_RESTART_ACK,
    AGENT_RESTART_PROBE,
    AGENT_RESTART_REQUESTED,
    AGENT_RESUMED,
    AGENT_STATUS_CHANGED,
    CONFIG_CHANGED,
)
from app.exceptions import ConflictError, ResourceNotFoundError, ServiceUnavailableError
from app.models.activity import ActivityAction, ActivityEntityType
from app.models.agents.agent import Agent
from app.models.agents.execution import AgentExecution
from app.models.api_key import ApiKey
from app.models.approvals.approval import ApprovalRequest
from app.repositories.agents.agent import AgentRepository
from app.schemas.agents.agent import (
    AgentCreate,
    AgentUpdate,
    BudgetStatus,
    HeartbeatBody,
    PromptConfigSummary,
)
from app.services.agents.identity import verify_caller_owns_agent
from app.services.api_key import ApiKeyService
from app.services.events.connection_manager import connection_manager
from app.utils import utcnow

logger = logging.getLogger(__name__)


def _parse_naive_utc(value: str | None) -> datetime | None:
    """Heartbeat timestamps arrive as runner-formatted ISO strings; the health_*
    columns are naive, so tzinfo is stripped rather than converted. A malformed
    value degrades to None — a heartbeat is observability, never a 422."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except (ValueError, AttributeError):
        return None


def _agent_not_found() -> Exception:
    """Foreign *users* get 404, not 403, so responses cannot enumerate agent ids."""
    return ResourceNotFoundError("Agent not found")


# A worker that holds the socket answers in-process (bus dispatch is a local
# await) or one Postgres NOTIFY round-trip away. This budget is generous for the
# latter while staying well inside any sane HTTP client timeout.
_CONTROL_CHANNEL_PROBE_TIMEOUT_SECONDS = 2.0


async def _locate_control_channel(
    agent_id: uuid.UUID, probe_workspace_id: uuid.UUID
) -> uuid.UUID | None:
    """Find the workspace of the runner's live WS, wherever that socket lives.

    `connection_manager` is a per-process singleton but gunicorn runs N workers,
    so the registry in THIS process only sees ~1/N of live runners. Asking over
    the bus — the same cross-process path that already delivers the command —
    makes the answer topology-independent: whichever worker holds the socket
    acks with its workspace. Returns None when nobody answers in time, which is
    the honest "no control channel anywhere" the caller reports as 409/503.

    `probe_workspace_id` only addresses the probe/ack pair; the socket's OWN
    workspace comes back on the ack and is what the restart is published to. The
    two differ when a runner is connected to a workspace other than the first in
    its allowlist. A real UUID is required rather than a workspace-less
    broadcast because PostgresEventBus drops any NOTIFY whose workspace_id does
    not parse — a None here would never leave the process, defeating the fix.
    """
    correlation_id = str(uuid.uuid4())
    answered: asyncio.Future[uuid.UUID] = asyncio.get_running_loop().create_future()

    async def on_ack(event) -> None:
        if event.payload.get("correlation_id") != correlation_id or answered.done():
            return
        try:
            answered.set_result(uuid.UUID(event.payload["workspace_id"]))
        except (ValueError, TypeError, KeyError):
            pass

    unsubscribe = event_bus.subscribe(
        callback=on_ack, workspace_id=None, event_pattern=AGENT_RESTART_ACK
    )
    try:
        await event_bus.publish(
            event_type=AGENT_RESTART_PROBE,
            payload={
                "target_agent_id": str(agent_id),
                "correlation_id": correlation_id,
            },
            workspace_id=probe_workspace_id,
        )
        return await asyncio.wait_for(answered, _CONTROL_CHANNEL_PROBE_TIMEOUT_SECONDS)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        return None
    finally:
        unsubscribe()


class AgentService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = AgentRepository(db)

    async def create_agent(self, data: AgentCreate, user_id: uuid.UUID):
        # Idempotent on (owner, name): repeat calls return the existing row so
        # re-provisioning a runner from the UI / LLM retry does not spawn
        # duplicate agents. If the existing row was soft-deleted, reactivate
        # it — operators re-creating a deactivated runner want it back on.
        existing = await self.repo.get_by_owner_and_name(user_id, data.name)
        if existing is not None:
            if not existing.is_active:
                was_active = existing.is_active
                existing = await self.repo.update(existing, is_active=True)
                await self._emit_agent_events(existing, was_active, {"is_active": True})
            return existing, None, None

        key_service = ApiKeyService(self.db)
        api_key, raw_key = await key_service.create_key(user_id, f"agent:{data.name}")

        agent = await self.repo.create(
            name=data.name,
            agent_type=data.agent_type,
            description=data.description,
            created_by_id=user_id,
            api_key_id=api_key.id,
            allowed_workspaces=data.allowed_workspaces,
            allowed_actions=data.allowed_actions,
            max_requests_per_minute=data.max_requests_per_minute,
            budget_usd=data.budget_usd,
        )
        return agent, api_key, raw_key

    async def rotate_api_key(self, agent_id: uuid.UUID, user_id: uuid.UUID):
        # No verify_caller_owns_agent: POST /{id}/rotate-key carries
        # forbid_agent_callers, so an agent key never reaches this code and the
        # only caller shape left is the creating human.
        agent = await self.repo.get_by_id(agent_id)
        if not agent or agent.created_by_id != user_id:
            raise ResourceNotFoundError("Agent not found")

        key_service = ApiKeyService(self.db)
        new_key, raw_key = await key_service.create_key(user_id, f"agent:{agent.name}")

        old_key_id = agent.api_key_id
        updated = await self.repo.update(
            agent, api_key_id=new_key.id, last_key_rotated_at=utcnow()
        )

        if old_key_id:
            old_key = await key_service.get_key(old_key_id)
            if old_key:
                await key_service.repo.delete(old_key)

        return updated, new_key, raw_key

    async def list_agents(self, user_id: uuid.UUID, include_inactive: bool = False):
        return await self.repo.list_by_owner(user_id, include_inactive)

    async def get_agent(self, agent_id: uuid.UUID, user_id: uuid.UUID):
        agent = await self.repo.get_by_id(agent_id)
        if not agent:
            raise ResourceNotFoundError("Agent not found")
        verify_caller_owns_agent(
            agent, actor_id=user_id, foreign_user_error=_agent_not_found
        )
        return agent

    async def update_agent(
        self, agent_id: uuid.UUID, user_id: uuid.UUID, data: AgentUpdate
    ):
        # No verify_caller_owns_agent: PATCH /{id} carries forbid_agent_callers
        # (an agent must not widen its own allowed_workspaces), so agent keys
        # never reach here.
        agent = await self.repo.get_by_id(agent_id)
        if not agent or agent.created_by_id != user_id:
            raise ResourceNotFoundError("Agent not found")
        update_data = data.model_dump(exclude_unset=True)
        was_active = agent.is_active
        updated = await self.repo.update(agent, **update_data)
        await self._emit_agent_events(updated, was_active, update_data)
        return updated

    async def heartbeat(self, agent_id: uuid.UUID, body: HeartbeatBody | None = None):
        agent = await self.repo.get_by_id(agent_id)
        if not agent:
            raise ResourceNotFoundError("Agent not found")

        update_data: dict = {"last_seen_at": utcnow()}

        if body:
            if body.status is not None:
                update_data["health_status"] = body.status
            if body.version is not None:
                update_data["health_version"] = body.version
            if body.uptime_seconds is not None:
                update_data["health_uptime_seconds"] = body.uptime_seconds
            if body.cards_processed is not None:
                update_data["health_cards_processed"] = body.cards_processed
            if body.cards_failed is not None:
                update_data["health_cards_failed"] = body.cards_failed
            if body.current_card_id is not None:
                update_data["health_current_card_id"] = body.current_card_id
            elif body.status == "idle":
                update_data["health_current_card_id"] = None
            if body.last_error is not None:
                update_data["health_last_error"] = body.last_error
            if body.last_error_at is not None:
                try:
                    dt = datetime.fromisoformat(
                        body.last_error_at.replace("Z", "+00:00")
                    )
                    update_data["health_last_error_at"] = dt.replace(tzinfo=None)
                except (ValueError, AttributeError):
                    pass
            if body.go_version is not None:
                update_data["health_go_version"] = body.go_version
            if body.hostname is not None:
                update_data["health_hostname"] = body.hostname
            if body.started_at is not None:
                try:
                    dt = datetime.fromisoformat(body.started_at.replace("Z", "+00:00"))
                    update_data["health_started_at"] = dt.replace(tzinfo=None)
                except (ValueError, AttributeError):
                    pass
            if body.cards_skipped is not None:
                update_data["health_cards_skipped"] = body.cards_skipped
            if body.current_board_id is not None:
                update_data["health_current_board_id"] = body.current_board_id
            elif body.status == "idle":
                update_data["health_current_board_id"] = None
            if body.poll_interval is not None:
                update_data["health_poll_interval"] = body.poll_interval
            if body.card_timeout is not None:
                update_data["health_card_timeout"] = body.card_timeout
            if body.health_port is not None:
                update_data["health_port"] = body.health_port
            if body.config_errors is not None:
                update_data["health_config_errors"] = body.config_errors
            if body.sensor_catalog is not None:
                update_data["sensor_catalog"] = body.sensor_catalog
            if body.loop_board_id is not None:
                update_data["health_loop_board_id"] = body.loop_board_id
            if body.loop_state is not None:
                update_data["health_loop_state"] = body.loop_state
                if body.loop_state == "ticking":
                    # Waking up is the only signal the runner sends on wake, so
                    # the transition itself has to clear the park story — else
                    # a live runner stays annotated with an hour-old excuse.
                    update_data["health_loop_park_reason"] = body.loop_park_reason
                    update_data["health_loop_parked_since"] = _parse_naive_utc(
                        body.loop_parked_since
                    )
            if body.loop_park_reason is not None:
                update_data["health_loop_park_reason"] = body.loop_park_reason
            if body.loop_parked_since is not None:
                parked_since = _parse_naive_utc(body.loop_parked_since)
                if parked_since is not None:
                    update_data["health_loop_parked_since"] = parked_since

        return await self.repo.update(agent, **update_data)

    async def handle_ws_heartbeat(
        self,
        agent_id: uuid.UUID,
        payload: dict,
        workspace_id: uuid.UUID | None = None,
    ):
        """Heartbeat received over the workspace WebSocket event bus.

        Delegates to the HTTP-facing `heartbeat` path after parsing the raw
        payload into `HeartbeatBody` so both transports share byte-equivalent
        downstream state (see test_heartbeat_ws_parity.py). When
        `workspace_id` is supplied, publishes `agent.heartbeat_received`
        so frontend consumers can live-update last-seen indicators without
        polling.
        """
        body = HeartbeatBody.model_validate(payload) if payload else None
        updated = await self.heartbeat(agent_id, body)

        if workspace_id is not None:
            from app.services.agents.liveness import compute_liveness

            await event_bus.publish(
                event_type=AGENT_HEARTBEAT_RECEIVED,
                payload={
                    "agent_id": str(agent_id),
                    "status": updated.health_status,
                    "last_seen_at": updated.last_seen_at.isoformat()
                    if updated.last_seen_at
                    else None,
                    # By definition the agent just heartbeated → alive.
                    "liveness": compute_liveness(updated.last_seen_at),
                },
                workspace_id=workspace_id,
            )
        return updated

    async def poll_agent(self, agent_id: uuid.UUID, user_id: uuid.UUID) -> dict:
        """Request a poll cycle from the agent via the workspace event bus.

        Requires an active WebSocket connection for the agent (the runner
        subscribes to `agent.*` and triggers its work loop on receipt).
        """
        agent = await self.repo.get_by_id(agent_id)
        if not agent:
            raise ResourceNotFoundError("Agent not found")
        verify_caller_owns_agent(
            agent, actor_id=user_id, foreign_user_error=_agent_not_found
        )

        conn = connection_manager.get_connection_by_agent_id(agent_id)
        if conn is None:
            raise ServiceUnavailableError("agent offline")

        await event_bus.publish(
            event_type=AGENT_POLL_REQUESTED,
            payload={"target_agent_id": str(agent_id)},
            workspace_id=conn.workspace_id,
        )
        # The live connection's workspace, not allowed_workspaces[0]: that is
        # where the command was actually delivered, so that is where the audit
        # row belongs.
        await self._record_lifecycle(
            agent_id=agent_id,
            agent_name=agent.name,
            workspace_id=conn.workspace_id,
            verb="poll_requested",
            actor_id=user_id,
        )
        return {"status": "poll_triggered", "agent_id": str(agent_id)}

    async def get_budget_status(
        self, agent_id: uuid.UUID, user_id: uuid.UUID
    ) -> BudgetStatus:
        agent = await self.repo.get_by_id(agent_id)
        if not agent:
            raise ResourceNotFoundError("Agent not found")
        verify_caller_owns_agent(
            agent, actor_id=user_id, foreign_user_error=_agent_not_found
        )

        since = utcnow() - timedelta(days=30)
        stmt = select(func.coalesce(func.sum(AgentExecution.cost_usd), 0.0)).where(
            AgentExecution.agent_id == agent_id,
            AgentExecution.started_at >= since,
        )
        result = await self.db.execute(stmt)
        spent_usd = float(result.scalar_one())

        budget = agent.budget_usd
        if budget is not None:
            remaining = max(budget - spent_usd, 0.0)
            percentage = round((spent_usd / budget) * 100, 1) if budget > 0 else 0.0
            is_exceeded = spent_usd > budget
        else:
            remaining = None
            percentage = None
            is_exceeded = False

        return BudgetStatus(
            budget_usd=budget,
            spent_usd=round(spent_usd, 4),
            remaining_usd=round(remaining, 4) if remaining is not None else None,
            percentage_used=percentage,
            is_exceeded=is_exceeded,
        )

    async def get_budget_status_for_agent(self, agent_id: uuid.UUID) -> BudgetStatus:
        """Budget status without ownership check -- used by agent-facing endpoints."""
        agent = await self.repo.get_by_id(agent_id)
        if not agent:
            raise ResourceNotFoundError("Agent not found")

        since = utcnow() - timedelta(days=30)
        stmt = select(func.coalesce(func.sum(AgentExecution.cost_usd), 0.0)).where(
            AgentExecution.agent_id == agent_id,
            AgentExecution.started_at >= since,
        )
        result = await self.db.execute(stmt)
        spent_usd = float(result.scalar_one())

        budget = agent.budget_usd
        if budget is not None:
            remaining = max(budget - spent_usd, 0.0)
            percentage = round((spent_usd / budget) * 100, 1) if budget > 0 else 0.0
            is_exceeded = spent_usd > budget
        else:
            remaining = None
            percentage = None
            is_exceeded = False

        return BudgetStatus(
            budget_usd=budget,
            spent_usd=round(spent_usd, 4),
            remaining_usd=round(remaining, 4) if remaining is not None else None,
            percentage_used=percentage,
            is_exceeded=is_exceeded,
        )

    async def get_agent_config(
        self, agent_id: uuid.UUID, workspace_slug: str | None = None
    ) -> dict:
        """Build composite config for an agent (agent-facing, no ownership check).

        `workspace_slug` names the workspace the runner actually operates on and
        is the only way to get a deterministic answer: without it the workspace
        is derived from an arbitrary one of the agent's team memberships, which
        served the wrong pipeline_config to a two-workspace runner in production
        (2026-05-19). Team identity in the response stays team-derived either
        way; only the workspace-scoped config moves.
        """
        agent = await self.repo.get_by_id(agent_id)
        if not agent:
            raise ResourceNotFoundError("Agent not found")

        budget_status = await self.get_budget_status_for_agent(agent_id)

        from app.services.agents.team import TeamService

        team_service = TeamService(self.db)
        team_info = await team_service.get_agent_team_info(agent_id)

        team_roles = team_info.roles if team_info else []
        # Single-role projection retained as a wire-format back-compat shim
        # only — the Go runner reads `team_roles` (plural) for every business
        # decision and ignores `team_role` (verified 2026-04-25 via grep on
        # runner/internal: only types.go decodes it; loop.go consumes only
        # TeamRoles). Scope of `team_role`: external clients pinned to the
        # pre-multi-role response shape. TODO: deprecate when Phase B lands.
        team_role = team_roles[0] if team_roles else None
        workspace_id = None
        board_id = None

        if team_info:
            team = await team_service.get_team(team_info.team_id)
            workspace_id = team.workspace_id
            board_id = team.board_id

        if workspace_slug is not None:
            workspace_id = await self._resolve_scoped_workspace_id(
                agent_id, workspace_slug
            )

        prompt_configs = []
        if workspace_id:
            from app.services.agents.prompt_config import PromptConfigService

            prompt_service = PromptConfigService(self.db)
            # Fetch prompts matching any of the agent's roles
            all_configs: list = []
            seen_ids: set = set()
            for role in team_roles:
                configs = await prompt_service.list_configs(
                    workspace_id, team_role=role
                )
                for c in configs:
                    if c.id not in seen_ids:
                        seen_ids.add(c.id)
                        all_configs.append(c)
            # If no roles, fetch unfiltered
            if not team_roles:
                all_configs = await prompt_service.list_configs(workspace_id)

            # Auto-seed system defaults on first access for this workspace
            if not all_configs:
                await prompt_service.seed_defaults(workspace_id, agent.created_by_id)
                seen_ids.clear()
                all_configs.clear()
                for role in team_roles:
                    configs = await prompt_service.list_configs(
                        workspace_id, team_role=role
                    )
                    for c in configs:
                        if c.id not in seen_ids:
                            seen_ids.add(c.id)
                            all_configs.append(c)
                if not team_roles:
                    all_configs = await prompt_service.list_configs(workspace_id)

            prompt_configs = [
                PromptConfigSummary.model_validate(c) for c in all_configs
            ]

        workspace_config = {}
        if workspace_id:
            from app.services.workspace_config import WorkspaceConfigService

            ws_config_service = WorkspaceConfigService(self.db)
            workspace_config = await ws_config_service.get_config(workspace_id)

        agent_type = (
            agent.agent_type.value
            if hasattr(agent.agent_type, "value")
            else str(agent.agent_type)
        )

        return {
            "agent_id": agent.id,
            "name": agent.name,
            "agent_type": agent_type,
            "description": agent.description,
            "is_active": agent.is_active,
            "allowed_workspaces": agent.allowed_workspaces,
            "allowed_actions": agent.allowed_actions,
            "max_requests_per_minute": agent.max_requests_per_minute,
            "budget_usd": budget_status.budget_usd,
            "spent_usd": budget_status.spent_usd,
            "remaining_usd": budget_status.remaining_usd,
            "budget_exceeded": budget_status.is_exceeded,
            "team_id": team_info.team_id if team_info else None,
            "team_name": team_info.team_name if team_info else None,
            "team_role": team_role,
            "team_roles": team_roles,
            "board_id": board_id,
            "prompt_configs": prompt_configs,
            "workspace_config": workspace_config,
        }

    async def deactivate_agent(self, agent_id: uuid.UUID, user_id: uuid.UUID):
        # No verify_caller_owns_agent: DELETE /{id} carries forbid_agent_callers,
        # so agent keys never reach here.
        agent = await self.repo.get_by_id(agent_id)
        if not agent or agent.created_by_id != user_id:
            raise ResourceNotFoundError("Agent not found")
        was_active = agent.is_active
        updated = await self.repo.update(agent, is_active=False)
        # Recorded here rather than inside _emit_agent_events: that helper is
        # shared with update_agent, whose generic field edits are a different
        # event and out of this card's scope.
        await self._record_lifecycle(
            agent_id=updated.id,
            agent_name=updated.name,
            workspace_id=await self._resolve_workspace_id(updated),
            verb="deactivated",
            actor_id=user_id,
        )
        await self._emit_agent_events(updated, was_active, {"is_active": False})
        return updated

    async def _locate_control_channel(
        self, agent: Agent, agent_id: uuid.UUID
    ) -> uuid.UUID | None:
        """Workspace of the runner's live WS, or None if it has none anywhere.

        Checks this process first — that answer needs no bus round-trip and is
        the whole story under a single worker. Only when the local registry
        misses do we ask the other workers, because `connection_manager` is a
        per-process singleton and gunicorn runs N of them.
        """
        conn = connection_manager.get_connection_by_agent_id(agent_id)
        if conn is not None:
            return conn.workspace_id

        probe_workspace_id = await self._resolve_workspace_id(agent)
        if probe_workspace_id is None:
            # No addressable workspace, so no probe can be published — and an
            # agent with an empty allowlist has no socket to find either.
            return None
        return await _locate_control_channel(agent_id, probe_workspace_id)

    async def restart_agent(self, agent_id: uuid.UUID, user_id: uuid.UUID) -> dict:
        """Ask a running agent to finish its in-flight card and then exit.

        Same shape as poll_agent — a directed WS command, not a state change:
        the platform stores nothing, the runner decides when to act, and the
        supervisor that launched it is what actually brings it back.
        """
        agent = await self.repo.get_by_id(agent_id)
        if not agent:
            raise ResourceNotFoundError("Agent not found")
        verify_caller_owns_agent(
            agent, actor_id=user_id, foreign_user_error=_agent_not_found
        )

        workspace_id = await self._locate_control_channel(agent, agent_id)
        if workspace_id is None:
            # No worker answered. A heartbeating runner with no WS connection
            # anywhere is not offline — it is alive without a control channel.
            # Loop mode is the standing case: runLoopMode never constructs the
            # events client (only runPipelineMode wires SetRestartRequested), so
            # restart has nothing to reach even while the runner is actively
            # burning iterations. Telling the operator "offline" sends them to
            # restart the box or check the network for a process that is fine.
            from app.services.agents.liveness import compute_liveness

            if compute_liveness(agent.last_seen_at) == "alive":
                raise ConflictError(
                    "agent is running without a control channel (loop mode) — "
                    "restart applies to pipeline-mode runners; stop a loop run "
                    "from the board's loop switch",
                    error_code="no_control_channel",
                )
            raise ServiceUnavailableError("agent offline")

        await event_bus.publish(
            event_type=AGENT_RESTART_REQUESTED,
            payload={"target_agent_id": str(agent_id)},
            workspace_id=workspace_id,
        )
        await self._record_lifecycle(
            agent_id=agent_id,
            agent_name=agent.name,
            workspace_id=workspace_id,
            verb="restart_requested",
            actor_id=user_id,
        )
        return {"status": "restart_requested", "agent_id": str(agent_id)}

    async def hard_delete_agent(self, agent_id: uuid.UUID, user_id: uuid.UUID) -> None:
        """Permanently remove the agent row. Unlike deactivate_agent, unrecoverable.

        Idempotent by design: a already-deleted agent returns success, because a
        retried DELETE that 404s is indistinguishable from a delete that never
        landed and pushes callers into guessing.
        """
        # No verify_caller_owns_agent: the route carries forbid_agent_callers,
        # so agent keys never reach here and cannot delete themselves or peers.
        agent = await self.repo.get_by_id(agent_id)
        if not agent:
            return
        # "Not yours" is NOT the idempotent case: answering 204 tells the caller
        # their delete landed while the agent lives on. 404 rather than 403 so
        # the response can't be used to probe which agent ids exist — same
        # choice as deactivate_agent and the execution endpoints.
        if agent.created_by_id != user_id:
            raise _agent_not_found()

        # Deleting mid-card would strand the claim: the card keeps an agent_id
        # pointing at nothing and no runner is left to release it.
        if agent.health_current_card_id:
            raise ConflictError(
                "Agent has a card in flight — pause it and wait for the card to finish, "
                "or cancel the execution first."
            )

        workspace_id = await self._resolve_workspace_id(agent)
        api_key_id = agent.api_key_id
        # Read the name while the row still exists — after the delete the audit
        # summary is the only place it survives.
        agent_name = agent.name

        # approval_requests.agent_id has no ON DELETE rule (it is a non-nullable
        # FK), so the DB cannot clear it for us. Approvals only describe work by
        # this runner, so they go with it.
        await self.db.execute(
            delete(ApprovalRequest).where(ApprovalRequest.agent_id == agent_id)
        )
        # executions, team memberships and reservations ride the DB's ON DELETE CASCADE.
        await self.repo.delete_by_id(agent_id)

        # The key outlives the agent via ON DELETE SET NULL — a hard delete that
        # leaves a live credential behind is not a delete.
        if api_key_id is not None:
            await self.db.execute(delete(ApiKey).where(ApiKey.id == api_key_id))

        # Recorded AFTER the delete so the FK has already been cleared: the row
        # keeps entity_id (no FK) and drops agent_id (ON DELETE SET NULL),
        # which is what makes it outlive the agent it describes.
        await self._record_lifecycle(
            agent_id=agent_id,
            agent_name=agent_name,
            workspace_id=workspace_id,
            verb="hard_deleted",
            actor_id=user_id,
            action=ActivityAction.deleted,
            clear_agent_ref=True,
        )

        if workspace_id is not None:
            try:
                await event_bus.publish(
                    event_type=AGENT_HARD_DELETED,
                    payload={"agent_id": str(agent_id)},
                    workspace_id=workspace_id,
                )
            except Exception:
                logger.exception("Failed to publish agent.hard_deleted event")

    async def pause_agent(self, agent_id: uuid.UUID, user_id: uuid.UUID) -> Agent:
        return await self._set_paused(agent_id, user_id, paused=True)

    async def resume_agent(self, agent_id: uuid.UUID, user_id: uuid.UUID) -> Agent:
        return await self._set_paused(agent_id, user_id, paused=False)

    async def _set_paused(
        self, agent_id: uuid.UUID, user_id: uuid.UUID, *, paused: bool
    ) -> Agent:
        # No verify_caller_owns_agent: both /{id}/pause and /{id}/resume carry
        # forbid_agent_callers (a paused runner must not unpause itself), so
        # agent keys never reach here.
        agent = await self.repo.get_by_id(agent_id)
        if not agent or agent.created_by_id != user_id:
            raise ResourceNotFoundError("Agent not found")

        # Idempotent: no-op return when the target state already holds. The
        # WS event broadcast below is the part that must not double-fire —
        # frontends would otherwise see a flicker on every retry.
        if agent.is_paused == paused:
            return agent

        updated = await self.repo.update(agent, is_paused=paused)
        workspace_id = await self._resolve_workspace_id(updated)
        # Recorded after the early return above, so the audit log carries
        # transitions rather than requests — a retried pause is not a 2nd event.
        await self._record_lifecycle(
            agent_id=updated.id,
            agent_name=updated.name,
            workspace_id=workspace_id,
            verb="paused" if paused else "resumed",
            actor_id=user_id,
        )
        if workspace_id is not None:
            try:
                await event_bus.publish(
                    event_type=AGENT_PAUSED if paused else AGENT_RESUMED,
                    payload={
                        "agent_id": str(updated.id),
                        "is_paused": updated.is_paused,
                    },
                    workspace_id=workspace_id,
                )
            except Exception:
                logger.exception(
                    "Failed to publish %s event",
                    "agent.paused" if paused else "agent.resumed",
                )
        return updated

    async def _resolve_scoped_workspace_id(
        self, agent_id: uuid.UUID, slug: str
    ) -> uuid.UUID:
        """Resolve a requested workspace slug, holding the agent to its scope.

        Config is workspace-scoped data, so it goes through the same allowlist
        predicate as every other workspace-scoped route rather than a second
        copy of the rule. Scope is checked BEFORE existence so an out-of-scope
        agent cannot probe which workspace slugs exist.
        """
        from app.core.workspace import enforce_agent_scope
        from app.models.workspace import Workspace

        await enforce_agent_scope(agent_id, slug, self.db)

        workspace_id = (
            await self.db.execute(select(Workspace.id).where(Workspace.slug == slug))
        ).scalar_one_or_none()
        if not workspace_id:
            raise ResourceNotFoundError(f"Workspace '{slug}' not found")
        return workspace_id

    async def _resolve_workspace_id(self, agent) -> uuid.UUID | None:
        """Resolve workspace UUID from the agent's allowed_workspaces list (stores slugs)."""
        workspaces = agent.allowed_workspaces
        if not workspaces or not isinstance(workspaces, list) or len(workspaces) == 0:
            return None
        entry = str(workspaces[0])
        # Try as UUID first, then resolve slug
        try:
            return uuid.UUID(entry)
        except (ValueError, TypeError):
            pass
        from app.models.workspace import Workspace

        result = await self.db.execute(
            select(Workspace.id).where(Workspace.slug == entry)
        )
        ws_id = result.scalar_one_or_none()
        return ws_id

    async def _record_lifecycle(
        self,
        *,
        agent_id: uuid.UUID,
        agent_name: str,
        workspace_id: uuid.UUID | None,
        verb: str,
        actor_id: uuid.UUID,
        action: ActivityAction = ActivityAction.updated,
        clear_agent_ref: bool = False,
    ) -> None:
        """Persist one audit row for an agent lifecycle transition.

        The WS events these actions already publish are ephemeral; this is what
        answers "who disabled this runner, and when" a week later.

        `ActivityAction` has no paused/resumed/restarted/polled member, and
        adding four Postgres enum values to express what one JSON field already
        carries is not worth four more `ALTER TYPE` statements — so the verb
        lives in `changes["lifecycle"]` (and, human-readably, in `summary`)
        while `action` stays the generic updated/deleted pair.

        Best-effort by design, for two distinct reasons:
        - `Activity.workspace_id` is NOT NULL and an agent with an empty
          `allowed_workspaces` resolves to none. No workspace ⇒ no row.
        - a failure to WRITE the audit row must never fail the operator's
          pause; the transition is the user's intent, the log is a side effect.

        `clear_agent_ref` blanks the acting-agent contextvar for the duration of
        the write. ActivityService stamps `activities.agent_id` from
        `current_agent_id` — the ACTOR — so an agent deleting itself would have
        the row point at the id just removed and the INSERT would trip the FK.
        Catching that is not enough: the failed flush poisons the session, so
        the enclosing transaction (including the delete) rolls back. Never
        writing the reference is the fix; `entity_id` still names the agent, and
        it carries no FK.
        """
        if workspace_id is None:
            return
        from app.core.auth import current_agent_id
        from app.services.activity import ActivityService

        token = current_agent_id.set(None) if clear_agent_ref else None
        try:
            # SAVEPOINT, because the repository FLUSHES the audit row: a row the
            # database rejects fails inside THIS transaction, and on asyncpg that
            # aborts the whole thing — the operator's pause/delete would roll
            # back with it. Catching the exception is not enough without a
            # savepoint to roll back to. One savepoint per call, inside the try.
            async with self.db.begin_nested():
                await ActivityService(self.db).record(
                    workspace_id=workspace_id,
                    actor_id=actor_id,
                    entity_type=ActivityEntityType.agent,
                    entity_id=agent_id,
                    action=action,
                    summary=f"{verb} agent '{agent_name}'",
                    message_key=(
                        "activity.agent.paused"
                        if verb == "paused"
                        else "activity.agent.resumed"
                        if verb == "resumed"
                        else "activity.agent.poll_requested"
                        if verb == "poll_requested"
                        else "activity.agent.deactivated"
                        if verb == "deactivated"
                        else "activity.agent.restart_requested"
                        if verb == "restart_requested"
                        else "activity.agent.hard_deleted"
                    ),
                    message_params={"agent_name": agent_name},
                    changes={"lifecycle": verb},
                )
        except Exception:
            logger.exception("Failed to record agent %s activity", verb)
        finally:
            if token is not None:
                current_agent_id.reset(token)

    async def _emit_agent_events(self, agent, was_active: bool, update_data: dict):
        workspace_id = await self._resolve_workspace_id(agent)
        if not workspace_id:
            return

        # Emit config.changed for any agent update
        try:
            await event_bus.publish(
                event_type=CONFIG_CHANGED,
                payload={
                    "entity": "agent",
                    "action": "updated",
                    "entity_id": str(agent.id),
                },
                workspace_id=workspace_id,
            )
        except Exception:
            logger.exception("Failed to publish config.changed event")

        # Emit agent.status_changed when is_active changes
        if "is_active" in update_data and agent.is_active != was_active:
            try:
                await event_bus.publish(
                    event_type=AGENT_STATUS_CHANGED,
                    payload={
                        "agent_id": str(agent.id),
                        "is_active": agent.is_active,
                        "previous_active": was_active,
                    },
                    workspace_id=workspace_id,
                )
            except Exception:
                logger.exception("Failed to publish agent.status_changed event")
