# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add config_templates, config_template_versions, board_loop_template_bindings

Durable storage for workspace-authored loop/pipeline templates, their published
version snapshots, and the one template a board's loop is bound to. System
templates stay code-defined, so this migration seeds NOTHING — every row here
is something a workspace wrote.

ADDITIVE and rolling-deploy safe. All three tables are new: old code cannot
reference a table it does not know about, and the new code writes to them only
when an operator creates or binds a template. No existing table is touched, no
column is renamed or dropped, and there is no backfill — a deployment mid-roll
has old pods ignoring the tables entirely while new pods use them.

`kind` is VARCHAR(16) + a CHECK rather than a native PostgreSQL enum. Adding
'pipeline' — or any later kind — then costs an in-place constraint swap inside
a transaction, whereas `ALTER TYPE ... ADD VALUE` cannot be rolled back in one.
Both SQLite (tests) and PostgreSQL (prod) enforce the CHECK, so the constraint
has engine parity rather than being a test-only fiction.

`board_loop_template_bindings.board_id` is the primary key, not a surrogate
UUID with a unique index: a board runs exactly one loop, so a second binding
row is a state the database should refuse outright.

Rollback: leave the tables in place. They are inert to code that does not read
them, and dropping them would discard operator-authored templates that no other
store holds. `downgrade()` is therefore intentionally a no-op.

Revision ID: 096
Revises: 093
Create Date: 2026-08-17
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "096"
down_revision = "093"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "config_templates",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "workspace_id",
            UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("slug", sa.String(100), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("profile", sa.JSON(), nullable=True),
        sa.Column("content", sa.JSON(), nullable=True),
        sa.Column("draft_profile", sa.JSON(), nullable=False),
        sa.Column("draft_content", sa.JSON(), nullable=False),
        sa.Column("draft_updated_at", sa.DateTime(), nullable=True),
        sa.Column("lineage", sa.JSON(), nullable=True),
        sa.Column("is_archived", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column(
            "created_by_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(
            "kind IN ('loop', 'pipeline')", name="ck_config_templates_kind"
        ),
        sa.UniqueConstraint(
            "workspace_id", "kind", "slug", name="uq_config_templates_scope_slug"
        ),
    )
    # The library page is always "this workspace, this kind" — the composite
    # keeps that an index scan instead of a workspace-wide filter.
    op.create_index(
        "ix_config_templates_workspace_kind",
        "config_templates",
        ["workspace_id", "kind"],
    )

    op.create_table(
        "config_template_versions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "template_id",
            UUID(as_uuid=True),
            sa.ForeignKey("config_templates.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("profile", sa.JSON(), nullable=False),
        sa.Column("content", sa.JSON(), nullable=False),
        sa.Column("published_at", sa.DateTime(), nullable=False),
        sa.Column(
            "published_by_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("note", sa.Text(), nullable=True),
        sa.UniqueConstraint(
            "template_id",
            "version",
            name="uq_config_template_versions_template_version",
        ),
    )
    op.create_index(
        "ix_config_template_versions_template_id",
        "config_template_versions",
        ["template_id"],
    )

    op.create_table(
        "board_loop_template_bindings",
        sa.Column(
            "board_id",
            UUID(as_uuid=True),
            sa.ForeignKey("boards.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("template_ref", sa.JSON(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("slot_values", sa.JSON(), nullable=False),
        sa.Column("rendered_at", sa.DateTime(), nullable=False),
        sa.Column(
            "rendered_by_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("rendered_hash", sa.String(64), nullable=True),
    )


def downgrade() -> None:
    """Intentionally a no-op — see the rollback note in the module docstring.

    These tables hold operator-authored templates that live nowhere else, and
    they are inert to code that does not read them, so unwinding the schema
    would destroy data to solve a problem that leaving them in place does not
    have.
    """
