# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from collections.abc import Callable

from app.core.auth import current_agent_id
from app.exceptions import ForbiddenError
from app.models.agents.agent import Agent


def verify_caller_owns_agent(
    agent: Agent,
    *,
    actor_id: uuid.UUID | None,
    foreign_user_error: Callable[[], Exception] | None = None,
) -> None:
    """IDOR guard: the URL agent_id must belong to the caller (cards f47816b9, 8a41dea9).

    Without this, any workspace member could pass ANY agent_id and reserve
    cards / mutate that agent's reservation and execution state. Two caller
    shapes:
      - Agent-key caller (current_agent_id set): the API key linkage IS the
        identity, so the URL agent_id must equal it exactly — even a
        same-owner sibling agent is a different caller. One owner commonly
        runs several runners, so created_by_id alone cannot tell them apart.
      - Plain user caller (no linked agent, e.g. legacy human/MCP-triggered
        calls): allowed only for agents they created, mirroring the
        platform's created_by-only agent authz model (agent.py, execution.py).

    `actor_id=None` means the caller has already been authorized upstream
    (internal service-to-service use); the agent-key branch still applies.

    `foreign_user_error` overrides what the plain-user branch raises. The
    execution endpoints answer a stranger with 404 rather than 403 so the
    response cannot be used to enumerate which agent ids exist; the
    reservation path predates that choice and keeps its 403.
    """
    caller_agent_id = current_agent_id.get()
    if caller_agent_id is not None:
        if caller_agent_id != agent.id:
            raise ForbiddenError(
                "API key is not linked to this agent",
                error_code="agent_identity_mismatch",
            )
        return
    if actor_id is not None and agent.created_by_id != actor_id:
        if foreign_user_error is not None:
            raise foreign_user_error()
        raise ForbiddenError(
            "You did not create this agent",
            error_code="agent_identity_mismatch",
        )
