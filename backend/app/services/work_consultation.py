# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import logging
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import current_agent_id
from app.core.mcp_invocation import current_mcp_invocation_id
from app.repositories.mcp_invocation import MCPInvocationRepository

logger = logging.getLogger(__name__)


class WorkConsultationService:
    """Records that a card or note was read under an MCP invocation.

    Called by the card and note services after they have authorized and loaded
    the entity. Best-effort by design: it runs in a savepoint and never lets a
    failure turn a successful read into an error.
    """

    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = MCPInvocationRepository(db)

    async def record(
        self,
        workspace_id: uuid.UUID,
        reader_id: uuid.UUID,
        entity_type: str,
        entity_id: uuid.UUID,
    ) -> None:
        invocation_id = current_mcp_invocation_id.get()
        if invocation_id is None:
            return
        agent_id = current_agent_id.get()
        try:
            async with self.db.begin_nested():
                await self.repo.record_consultation(
                    {
                        "invocation_id": invocation_id,
                        "actor_id": reader_id,
                        "principal_key": str(agent_id) if agent_id else "",
                        "workspace_id": workspace_id,
                        "entity_type": entity_type,
                        "entity_id": entity_id,
                    }
                )
        except Exception:
            logger.exception(
                "consultation not recorded entity=%s:%s", entity_type, entity_id
            )
