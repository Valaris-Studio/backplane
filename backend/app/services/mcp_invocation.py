# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import json
from datetime import datetime, timezone

from pydantic import ValidationError as SchemaValidationError

from app.core.auth import current_agent_id
from app.exceptions import ConflictError, ResourceNotFoundError, ValidationError
from app.repositories.mcp_invocation import MCPInvocationRepository
from app.schemas.mcp_invocation import MCPInvocationCreate
from app.services.session_events import queue_after_commit
from app.services.session_work_link import SessionWorkLinkService


class MCPInvocationService:
    def __init__(self, db):
        self.db = db
        self.repo = MCPInvocationRepository(db)

    async def _principal(self, owner_id):
        agent_id = current_agent_id.get()
        if agent_id is None:
            return None
        agent = await self.repo.agent(agent_id)
        if agent is None or not agent.is_active or agent.created_by_id != owner_id:
            raise ResourceNotFoundError()
        return agent

    async def _workspace(self, owner_id, agent, **lookup):
        workspace = await self.repo.workspace(owner_id, **lookup)
        if workspace is not None and agent is not None and agent.allowed_workspaces:
            if workspace.slug not in agent.allowed_workspaces:
                return None
        return workspace

    async def _visible(self, row, owner_id, agent):
        if row is None:
            raise ResourceNotFoundError()
        if (
            row.workspace_id is not None
            and await self._workspace(owner_id, agent, workspace_id=row.workspace_id)
            is None
        ):
            raise ResourceNotFoundError()
        return row

    async def get(self, owner_id, invocation_id):
        agent = await self._principal(owner_id)
        row = await self.repo.get(invocation_id, owner_id, agent.id if agent else None)
        return await self._visible(row, owner_id, agent)

    async def record(self, owner_id, data: MCPInvocationCreate):
        try:
            data = MCPInvocationCreate.model_validate(data.model_dump())
        except (SchemaValidationError, TypeError, ValueError):
            raise ValidationError("Invalid invocation outcome") from None
        agent = await self._principal(owner_id)
        agent_id = agent.id if agent else None
        # Canonicalize equivalent timestamps before hashing a retry receipt.
        data.started_at = data.started_at.astimezone(timezone.utc)
        data.completed_at = data.completed_at.astimezone(timezone.utc)
        digest = hashlib.sha256(
            json.dumps(data.model_dump(mode="json"), sort_keys=True).encode()
        ).hexdigest()
        existing = await self.repo.get(data.id, owner_id, agent_id)
        if existing is not None:
            await self._visible(existing, owner_id, agent)
        else:
            workspace = (
                await self._workspace(owner_id, agent, slug=data.workspace_slug)
                if data.workspace_slug
                else None
            )
            inserted = await self.repo.insert(
                {
                    **data.model_dump(),
                    "owner_id": owner_id,
                    "agent_id": agent_id,
                    "workspace_id": workspace.id if workspace else None,
                    "scope_status": "authorized"
                    if workspace
                    else "unavailable"
                    if data.workspace_slug
                    else "unscoped",
                    "payload_hash": digest,
                    "created_at": datetime.now(timezone.utc),
                }
            )
            # The unique ID may belong to an invisible caller. Never return that
            # row (or its content/conflict reason) to make a retry look successful.
            existing = await self.repo.get(data.id, owner_id, agent_id)
            await self._visible(existing, owner_id, agent)
            if inserted is not None:
                refreshes = await SessionWorkLinkService(self.db).link_invocation(
                    existing
                )
                queue_after_commit(self.db, refreshes)
        if existing.payload_hash != digest:
            raise ConflictError("Invocation ID already has a different outcome")
        return existing
