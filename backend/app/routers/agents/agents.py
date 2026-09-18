# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import logging
import uuid

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app import config as _config
from app.core.auth import current_agent_id, forbid_agent_callers, get_current_user
from app.database import get_db
from app.exceptions import ResourceNotFoundError
from app.models.agents.agent import Agent
from app.models.user import User
from app.schemas.agents.agent import (
    AgentConfigResponse,
    AgentCreate,
    AgentCreated,
    AgentListRead,
    AgentRead,
    AgentUpdate,
    BudgetStatus,
    HeartbeatBody,
)
from app.services.agents.agent import AgentService
from app.services.agents.export import build_export_zip
from app.services.agents.team import TeamService
from app.services.api_key import ApiKeyService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/agents", tags=["agents"])


async def get_current_agent(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> Agent:
    agent_id_val = current_agent_id.get()
    if agent_id_val is None:
        raise ResourceNotFoundError("No agent linked to this API key")
    service = AgentService(db)
    agent = await service.repo.get_by_id(agent_id_val)
    if not agent:
        raise ResourceNotFoundError("Agent not found")
    return agent


@router.get("", response_model=list[AgentListRead] | list[AgentRead])
async def list_agents(
    include_inactive: bool = Query(False),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
    summary: bool = Query(
        default=False,
        description=(
            "Drop `sensor_catalog` from each row. Default false — the runner "
            "and any unaware client keep the full rows."
        ),
    ),
):
    service = AgentService(db)
    agents = await service.list_agents(user.id, include_inactive)
    schema = AgentListRead if summary else AgentRead
    result = []
    for agent in agents:
        read = schema.model_validate(agent)
        if agent.api_key_id:
            key = await ApiKeyService(db).get_key(agent.api_key_id)
            read.api_key_prefix = key.key_prefix if key else None
        result.append(read)
    return result


@router.post(
    "", response_model=AgentCreated, dependencies=[Depends(forbid_agent_callers)]
)
async def create_agent(
    data: AgentCreate,
    response: Response,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = AgentService(db)
    agent, api_key, raw_key = await service.create_agent(data, user.id)

    # Idempotent hit: service returns (agent, None, None) for a repeat call.
    # Respond 200 with raw_api_key=None; prefix comes from the agent's
    # existing api_key_id so clients can still identify the live key.
    if api_key is None:
        response.status_code = 200
        prefix = None
        if agent.api_key_id:
            existing_key = await ApiKeyService(db).get_key(agent.api_key_id)
            prefix = existing_key.key_prefix if existing_key else None
        agent_dict = AgentRead.model_validate(agent).model_dump()
        agent_dict["api_key_prefix"] = prefix
        agent_dict["raw_api_key"] = None
        return AgentCreated(**agent_dict)

    response.status_code = 201
    agent_dict = AgentRead.model_validate(agent).model_dump()
    agent_dict["api_key_prefix"] = api_key.key_prefix
    agent_dict["raw_api_key"] = raw_key
    return AgentCreated(**agent_dict)


@router.get("/me", response_model=AgentRead)
async def get_agent_me(
    agent: Agent = Depends(get_current_agent),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    from app.schemas.agents.agent import TeamMembershipInfoCompat

    read = AgentRead.model_validate(agent)
    if agent.api_key_id:
        key = await ApiKeyService(db).get_key(agent.api_key_id)
        read.api_key_prefix = key.key_prefix if key else None
    team_service = TeamService(db)
    read.team_memberships = await team_service.get_agent_team_memberships(agent.id)
    team_info = await team_service.get_agent_team_info(agent.id)
    if team_info:
        # Backward compat: singular field with first role
        read.team_membership = TeamMembershipInfoCompat(
            team_id=team_info.team_id,
            team_name=team_info.team_name,
            role=team_info.roles[0] if team_info.roles else "",
        )
    return read


@router.post("/me/heartbeat", response_model=AgentRead)
async def heartbeat(
    body: HeartbeatBody | None = None,
    agent: Agent = Depends(get_current_agent),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    # DEPRECATED (WS-2): heartbeats now ride the workspace WebSocket as
    # `{"type":"heartbeat","payload":{...}}` frames. This HTTP path stays
    # live for one release so mismatched runner/backend pairs still work.
    # Release schedule: N=warn (here), N+1=403, N+2=remove. If you're an
    # runner maintainer seeing this log line, upgrade the runner to a
    # build that uses events.Client.SendHeartbeat.
    logger.warning(
        "deprecated HTTP heartbeat from agent=%s — migrate to WS frames "
        "(events.Client.SendHeartbeat). This endpoint is scheduled for removal.",
        agent.id,
    )
    service = AgentService(db)
    updated = await service.heartbeat(agent.id, body)
    read = AgentRead.model_validate(updated)
    if updated.api_key_id:
        key = await ApiKeyService(db).get_key(updated.api_key_id)
        read.api_key_prefix = key.key_prefix if key else None
    return read


@router.get("/me/budget-status", response_model=BudgetStatus)
async def get_my_budget_status(
    agent: Agent = Depends(get_current_agent),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = AgentService(db)
    return await service.get_budget_status_for_agent(agent.id)


@router.get("/me/config", response_model=AgentConfigResponse)
async def get_agent_config(
    workspace_slug: str | None = Query(
        None,
        description=(
            "Serve the pipeline_config and prompt_configs of this workspace. "
            "Omit for the legacy team-derived workspace, which is arbitrary "
            "for an agent on teams in more than one workspace."
        ),
    ),
    agent: Agent = Depends(get_current_agent),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = AgentService(db)
    return await service.get_agent_config(agent.id, workspace_slug=workspace_slug)


@router.post("/{agent_id}/poll", dependencies=[Depends(forbid_agent_callers)])
async def poll_agent(
    agent_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Trigger an immediate poll cycle on a running agent.

    Operator-to-runner push, so agent keys are refused even on their own agent:
    nothing in the runner calls this route (it reacts to AGENT_POLL_REQUESTED
    over the workspace WS instead), and self-poll would let a looping runner
    amplify its own work loop.
    """
    service = AgentService(db)
    return await service.poll_agent(agent_id, user.id)


@router.post("/{agent_id}/restart", dependencies=[Depends(forbid_agent_callers)])
async def restart_agent(
    agent_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Ask a running agent to finish its in-flight card and then exit.

    Agent keys are refused for the same reason poll is: a runner restarting
    itself on its own signal is a loop the operator cannot interrupt. Whether
    the process comes back is the supervisor's business, not the platform's.
    """
    service = AgentService(db)
    return await service.restart_agent(agent_id, user.id)


@router.post(
    "/{agent_id}/pause",
    response_model=AgentRead,
    dependencies=[Depends(forbid_agent_callers)],
)
async def pause_agent(
    agent_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Stop the runner from picking up NEW cards.

    Idempotent: pausing a paused runner returns 200 with the current
    state and no WS event. In-flight executions are not affected — the
    runner finishes its current card and then idles. Heartbeats and
    auth continue to work normally.
    """
    service = AgentService(db)
    agent = await service.pause_agent(agent_id, user.id)
    return AgentRead.model_validate(agent)


@router.post(
    "/{agent_id}/resume",
    response_model=AgentRead,
    dependencies=[Depends(forbid_agent_callers)],
)
async def resume_agent(
    agent_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Re-enable card pickup for a paused runner. Idempotent."""
    service = AgentService(db)
    agent = await service.resume_agent(agent_id, user.id)
    return AgentRead.model_validate(agent)


@router.post(
    "/{agent_id}/rotate-key",
    response_model=AgentCreated,
    dependencies=[Depends(forbid_agent_callers)],
)
async def rotate_agent_key(
    agent_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = AgentService(db)
    agent, api_key, raw_key = await service.rotate_api_key(agent_id, user.id)
    agent_dict = AgentRead.model_validate(agent).model_dump()
    agent_dict["api_key_prefix"] = api_key.key_prefix
    agent_dict["raw_api_key"] = raw_key
    return AgentCreated(**agent_dict)


@router.get("/{agent_id}/budget-status", response_model=BudgetStatus)
async def get_budget_status(
    agent_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = AgentService(db)
    return await service.get_budget_status(agent_id, user.id)


@router.get(
    "/{agent_id}/export-config",
    response_class=Response,
    responses={200: {"content": {"application/zip": {}}}},
)
async def export_agent_config(
    agent_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Return a ZIP bundle: runner-{name}.yaml + mcp-config-{name}.json.

    The runner YAML expands `VALARIS_API_KEY`, but the sibling MCP JSON keeps
    the literal `${VALARIS_API_KEY}` sentinel so no secret is written into the
    downloaded archive. Before launch, materialize a private MCP JSON copy with
    the real key, protect it as a credential, and keep the YAML pointed at it.

    The runner currently passes that JSON to the coding-agent CLI verbatim; it
    does not expand environment variables inside the JSON document.
    """
    service = AgentService(db)
    agent = await service.get_agent(agent_id, user.id)

    workspace_slug = ""
    if agent.allowed_workspaces:
        workspace_slug = agent.allowed_workspaces[0]

    budget = agent.budget_usd if agent.budget_usd is not None else 10.0

    zip_bytes = build_export_zip(
        name=agent.name,
        agent_id=str(agent.id),
        workspace_slug=workspace_slug,
        budget_usd=budget,
        api_url=_config.settings.API_URL,
        docs_url=_config.settings.FRONTEND_URL,
    )

    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="runner-{agent.name}.zip"',
        },
    )


@router.get("/{agent_id}", response_model=AgentRead)
async def get_agent(
    agent_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = AgentService(db)
    agent = await service.get_agent(agent_id, user.id)
    read = AgentRead.model_validate(agent)
    if agent.api_key_id:
        key = await ApiKeyService(db).get_key(agent.api_key_id)
        read.api_key_prefix = key.key_prefix if key else None
    read.team_memberships = await TeamService(db).get_agent_team_memberships(agent.id)
    return read


@router.patch(
    "/{agent_id}",
    response_model=AgentRead,
    dependencies=[Depends(forbid_agent_callers)],
)
async def update_agent(
    agent_id: uuid.UUID,
    data: AgentUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = AgentService(db)
    agent = await service.update_agent(agent_id, user.id, data)
    return AgentRead.model_validate(agent)


@router.delete(
    "/{agent_id}/hard",
    status_code=204,
    dependencies=[Depends(forbid_agent_callers)],
)
async def hard_delete_agent(
    agent_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Permanently delete the agent and everything that only described it.

    Declared above DELETE /{agent_id} so "hard" is matched as a literal
    segment rather than parsed as a UUID path param.
    """
    service = AgentService(db)
    await service.hard_delete_agent(agent_id, user.id)
    return Response(status_code=204)


@router.delete(
    "/{agent_id}",
    response_model=AgentRead,
    dependencies=[Depends(forbid_agent_callers)],
)
async def deactivate_agent(
    agent_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = AgentService(db)
    agent = await service.deactivate_agent(agent_id, user.id)
    return AgentRead.model_validate(agent)
