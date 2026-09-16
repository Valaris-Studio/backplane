# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import delete

from app.models.agents.reservation import AgentReservation
from app.repositories.base import BaseRepository


class AgentReservationRepository(BaseRepository[AgentReservation]):
    model = AgentReservation

    async def delete_by_keys(
        self,
        *,
        agent_id: uuid.UUID,
        card_id: uuid.UUID,
        role: str,
    ) -> int:
        """Delete the reservation matching (agent_id, card_id, role).

        Returns the number of rows deleted (0 or 1). Idempotent: a missing
        row is not an error — callers (e.g. execution-completion path) may
        be retried by LLM/runner code.
        """
        result = await self.db.execute(
            delete(AgentReservation).where(
                AgentReservation.agent_id == agent_id,
                AgentReservation.card_id == card_id,
                AgentReservation.role == role,
            )
        )
        await self.db.flush()
        return result.rowcount or 0
