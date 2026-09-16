# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UUIDMixin


class AgentReservation(Base, UUIDMixin):
    """Soft hold on a card while an agent decides whether to start work.

    The scheduler endpoint (POST .../next-assignment) writes one of these
    inside the same transaction that picks the card, so two concurrent
    callers cannot both receive the same card. The reservation expires
    after `expires_at`; an expired row is treated as if it didn't exist
    and the next caller can take the same card. When the runner records
    its first AgentExecution against the reserved card, the reservation
    is cleared and a permanent CardParticipant takes over.
    """

    __tablename__ = "agent_reservations"
    __table_args__ = (
        UniqueConstraint("card_id", name="uq_agent_reservations_card"),
    )

    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agents.id", ondelete="CASCADE"),
        index=True,
    )
    card_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cards.id", ondelete="CASCADE"),
        index=True,
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        index=True,
    )
    board_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("boards.id", ondelete="CASCADE"),
    )
    role: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
