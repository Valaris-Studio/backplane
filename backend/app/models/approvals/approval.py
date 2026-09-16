# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import enum
import uuid
from datetime import datetime

from sqlalchemy import Enum, ForeignKey, Integer, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from app.models.base import Base, TimestampMixin, UUIDMixin


class ApprovalStatus(str, enum.Enum):
    pending = "pending"
    approved = "approved"
    rejected = "rejected"
    expired = "expired"
    auto_approved = "auto_approved"


class ApprovalCategory(str, enum.Enum):
    deletion = "deletion"
    bulk_change = "bulk_change"
    deployment = "deployment"
    schema_change = "schema_change"
    permission_change = "permission_change"
    external_action = "external_action"
    skill_publication = "skill_publication"


class ApprovalRequest(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "approval_requests"

    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agents.id"), index=True
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    board_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="SET NULL"), nullable=True
    )
    category: Mapped[ApprovalCategory] = mapped_column(Enum(ApprovalCategory))
    action_description: Mapped[str] = mapped_column(Text)
    action_payload: Mapped[dict] = mapped_column(JSON, default=dict)
    risk_score: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[ApprovalStatus] = mapped_column(
        Enum(ApprovalStatus), default=ApprovalStatus.pending
    )
    decided_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    decided_at: Mapped[datetime | None] = mapped_column(nullable=True)
    decision_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(
        server_default=func.now() + "24:00:00"
    )
    execution_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )

    agent: Mapped["Agent"] = relationship("Agent", foreign_keys=[agent_id], lazy="raise")  # noqa: F821
    decided_by: Mapped["User | None"] = relationship(  # noqa: F821
        "User", foreign_keys=[decided_by_id], lazy="raise"
    )

    @property
    def agent_name(self) -> str | None:
        return self.agent.name if self.agent else None

    @property
    def decided_by_name(self) -> str | None:
        if not self.decided_by:
            return None
        return self.decided_by.name or self.decided_by.email
