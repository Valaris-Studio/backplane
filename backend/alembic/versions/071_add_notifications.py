# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add notifications and notification_preferences tables

Phase 1 of the notification system (docs/notification-system-contract.md).
Two new tables:
  - notifications: durable per-recipient row written in-txn with its triggering
    event (INV-1). UNIQUE(recipient_user_id, dedupe_key) backstops INV-6
    idempotency. board_id is ON DELETE SET NULL so a deleted board orphans the
    deep-link context but the notification survives in the recipient's history.
  - notification_preferences: one row per (user, workspace); a missing row =
    all defaults (lazy-created on first PUT).

Adding tables is always rolling-deploy safe. All booleans carry server_default;
no backfill needed.

Revision ID: 071
Revises: 070
Create Date: 2026-06-14
"""

import sqlalchemy as sa
from alembic import op

revision = "071"
down_revision = "070"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "notifications",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "recipient_user_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "workspace_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "board_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("boards.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("category", sa.String(length=48), nullable=False),
        sa.Column(
            "actor_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=True,
        ),
        sa.Column(
            "is_agent_actor",
            sa.Boolean,
            nullable=False,
            server_default="false",
        ),
        sa.Column("entity_type", sa.String(length=32), nullable=False),
        sa.Column(
            "entity_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
        sa.Column("params", sa.JSON, nullable=False),
        sa.Column("link", sa.JSON, nullable=True),
        sa.Column("read_at", sa.DateTime, nullable=True),
        sa.Column("dedupe_key", sa.String(length=255), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "recipient_user_id",
            "dedupe_key",
            name="uq_notifications_recipient_dedupe",
        ),
    )
    op.create_index(
        "ix_notifications_recipient_user_id", "notifications", ["recipient_user_id"]
    )
    op.create_index(
        "ix_notifications_workspace_id", "notifications", ["workspace_id"]
    )
    op.create_index("ix_notifications_category", "notifications", ["category"])
    op.create_index(
        "ix_notifications_recipient_created",
        "notifications",
        ["recipient_user_id", "created_at"],
    )
    op.create_index(
        "ix_notifications_recipient_workspace_unread",
        "notifications",
        ["recipient_user_id", "workspace_id", "read_at"],
    )

    op.create_table(
        "notification_preferences",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "workspace_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "relevance_scope",
            sa.String(length=16),
            nullable=False,
            server_default="watching",
        ),
        sa.Column("category_overrides", sa.JSON, nullable=False),
        sa.Column(
            "muted", sa.Boolean, nullable=False, server_default="false"
        ),
        sa.Column(
            "created_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "user_id", "workspace_id", name="uq_notif_prefs_user_workspace"
        ),
    )
    op.create_index(
        "ix_notification_preferences_user_id",
        "notification_preferences",
        ["user_id"],
    )
    op.create_index(
        "ix_notification_preferences_workspace_id",
        "notification_preferences",
        ["workspace_id"],
    )


def downgrade():
    op.drop_index(
        "ix_notification_preferences_workspace_id",
        table_name="notification_preferences",
    )
    op.drop_index(
        "ix_notification_preferences_user_id",
        table_name="notification_preferences",
    )
    op.drop_table("notification_preferences")

    op.drop_index(
        "ix_notifications_recipient_workspace_unread", table_name="notifications"
    )
    op.drop_index(
        "ix_notifications_recipient_created", table_name="notifications"
    )
    op.drop_index("ix_notifications_category", table_name="notifications")
    op.drop_index("ix_notifications_workspace_id", table_name="notifications")
    op.drop_index(
        "ix_notifications_recipient_user_id", table_name="notifications"
    )
    op.drop_table("notifications")
