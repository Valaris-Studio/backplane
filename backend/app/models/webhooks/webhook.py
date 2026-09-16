# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, ForeignKey, Index, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.models.base import Base, TimestampMixin, UUIDMixin


class WebhookEvent(str, enum.Enum):
    # Bridge events (DEPRECATED): kept for backward compatibility while
    # subscribers migrate to the activity.* namespace. Sunset in a follow-up.
    card_created = "card.created"
    card_updated = "card.updated"
    card_moved = "card.moved"
    card_deleted = "card.deleted"
    column_created = "column.created"
    column_updated = "column.updated"
    column_deleted = "column.deleted"

    # activity.* namespace — every ActivityService.record callsite fans out here.
    # The list mirrors the (entity_type, action) pairs actually used by the
    # codebase (grep "entity_type=ActivityEntityType" in app/services).
    activity_card_created = "activity.card.created"
    activity_card_updated = "activity.card.updated"
    activity_card_moved = "activity.card.moved"
    activity_card_deleted = "activity.card.deleted"
    activity_card_dependency_added = "activity.card.dependency_added"
    activity_card_dependency_removed = "activity.card.dependency_removed"
    activity_card_dependencies_replaced = "activity.card.dependencies_replaced"
    activity_column_created = "activity.column.created"
    activity_column_updated = "activity.column.updated"
    activity_column_deleted = "activity.column.deleted"
    activity_board_created = "activity.board.created"
    activity_board_updated = "activity.board.updated"
    activity_board_deleted = "activity.board.deleted"
    activity_note_created = "activity.note.created"
    activity_note_updated = "activity.note.updated"
    activity_note_deleted = "activity.note.deleted"
    activity_resource_created = "activity.resource.created"
    activity_resource_updated = "activity.resource.updated"
    activity_resource_deleted = "activity.resource.deleted"
    activity_definition_created = "activity.definition.created"
    activity_definition_updated = "activity.definition.updated"
    activity_channel_created = "activity.channel.created"
    activity_channel_updated = "activity.channel.updated"
    activity_channel_deleted = "activity.channel.deleted"
    activity_git_repo_created = "activity.git_repo.created"
    activity_git_repo_updated = "activity.git_repo.updated"
    activity_git_repo_deleted = "activity.git_repo.deleted"
    activity_workspace_created = "activity.workspace.created"
    activity_workspace_updated = "activity.workspace.updated"
    activity_member_added = "activity.member.added_member"
    activity_member_removed = "activity.member.removed_member"

    # Non-activity event types (emitted directly by services other than ActivityService).
    approval_created = "approval.created"
    approval_updated = "approval.updated"
    execution_started = "execution.started"
    execution_completed = "execution.completed"
    agent_status_changed = "agent.status_changed"
    config_changed = "config.changed"
    cost_threshold_crossed = "cost.threshold_crossed"


class Webhook(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "webhooks"
    __table_args__ = (
        Index("ix_webhooks_workspace", "workspace_id"),
        Index("ix_webhooks_active", "is_active"),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    url: Mapped[str] = mapped_column(String(2048))
    events: Mapped[list] = mapped_column(JSON, default=list)
    secret: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    last_delivered_at: Mapped[datetime | None] = mapped_column(nullable=True)
    failure_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id")
    )
