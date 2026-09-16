# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, UUIDMixin


class BoardLoopTransition(Base, UUIDMixin):
    """One durable enable/disable of a board's loop.

    `loop_config.disabled_reason` holds only the LATEST stop: a re-enable
    nulls it and the next disable overwrites it. This table is the timeline
    behind it — append-only, never updated, so the story of a run survives the
    run.

    A dedicated table rather than enriched activity rows: activity is a
    polymorphic audit log with no board+loop index, so a chronological
    per-board loop query would scan it and discriminate on summary text.

    `agent_id` is the attribution primitive — non-null exactly when the caller
    authenticated with an agent API key, which is what separates a runner's
    rail stop from an operator's decision. `actor_id` is always the resolved
    user (an agent key resolves to its creating user), so the two are
    complementary, not alternatives.
    """

    __tablename__ = "board_loop_transitions"

    board_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="CASCADE"), index=True
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    # Null-or-meaningful, never "": enables carry no reason unless one is given.
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    agent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agents.id", ondelete="SET NULL"), nullable=True
    )
    # The board's all-time loop_iteration count at the moment of the flip —
    # snapshotted because it is what makes a stop legible later ("stopped at
    # 42 of 25" reads very differently from "stopped").
    iteration_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=lambda: datetime.now(timezone.utc).replace(tzinfo=None),
        index=True,
    )

    # lazy="raise" per house style: the timeline endpoint selectinloads both,
    # and an accidental lazy load here would be an N+1 across the whole page.
    actor: Mapped["User | None"] = relationship(  # noqa: F821
        "User", foreign_keys=[actor_id], lazy="raise"
    )
    agent: Mapped["Agent | None"] = relationship(  # noqa: F821
        "Agent", foreign_keys=[agent_id], lazy="raise"
    )
