# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add skills, skill_versions, board_skills + 'skill' activity entity

Skills Registry v1 (spec note f58cae0c, card cdcf94b7). Workspace-authored
SKILL.md bundles, their immutable version snapshots, and the board bindings
that decide which skills — at which version — a board's agents get.

ADDITIVE and rolling-deploy safe. All three tables are new: old code cannot
reference a table it does not know about, and new code writes to them only
when an operator authors or binds a skill. No existing table is touched, no
column is renamed or dropped, and there is no backfill.

`skill_versions.status` is VARCHAR(16) + a CHECK rather than a native enum:
widening the set later costs an in-place constraint swap inside a
transaction, and both SQLite (tests) and PostgreSQL (prod) enforce the CHECK
with engine parity.

`board_skills` uses the (board_id, skill_id) composite PK as the natural key:
a board binds a skill at most once, and a second binding row is a state the
database should refuse outright.

The `ALTER TYPE` needs no dialect guard: like every activity-enum migration
before it, this file is Postgres-only by construction — the SQLite test suite
builds its schema from `Base.metadata.create_all`, never from alembic.

Revision ID: 100
Revises: 099
Create Date: 2026-08-24
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "100"
down_revision = "099"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "skills",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "workspace_id",
            UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("slug", sa.String(255), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("latest_published_version", sa.Integer(), nullable=True),
        sa.Column("origin", sa.String(255), nullable=True),
        sa.Column(
            "created_by",
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
        sa.UniqueConstraint("workspace_id", "slug", name="uq_skills_workspace_slug"),
    )
    op.create_index("ix_skills_workspace", "skills", ["workspace_id"])

    op.create_table(
        "skill_versions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "skill_id",
            UUID(as_uuid=True),
            sa.ForeignKey("skills.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("files", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column(
            "created_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_by_agent_id",
            UUID(as_uuid=True),
            sa.ForeignKey("agents.id", ondelete="SET NULL"),
            nullable=True,
        ),
        # Bare UUID, no FK — approvals arrive with the proposals flow (W2) and
        # the reference must survive approval-row cleanup.
        sa.Column("approval_id", UUID(as_uuid=True), nullable=True),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'proposed', 'published', 'rejected')",
            name="ck_skill_versions_status",
        ),
        sa.UniqueConstraint(
            "skill_id", "version", name="uq_skill_versions_skill_version"
        ),
    )
    op.create_index("ix_skill_versions_skill_id", "skill_versions", ["skill_id"])

    op.create_table(
        "board_skills",
        sa.Column(
            "board_id",
            UUID(as_uuid=True),
            sa.ForeignKey("boards.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "skill_id",
            UUID(as_uuid=True),
            sa.ForeignKey("skills.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("pinned_version", sa.Integer(), nullable=True),
        sa.Column("role", sa.String(64), nullable=True),
        sa.Column(
            "bound_by",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "bound_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("ix_board_skills_skill_id", "board_skills", ["skill_id"])

    op.execute("ALTER TYPE activityentitytype ADD VALUE IF NOT EXISTS 'skill'")


def downgrade() -> None:
    op.drop_table("board_skills")
    op.drop_table("skill_versions")
    op.drop_table("skills")
    # PostgreSQL cannot drop an enum value without rewriting every dependent
    # column, and rows already written with it would be orphaned. Leaving
    # 'skill' in place is harmless — nothing emits it once the code is rolled
    # back. Same choice as 092 and 097.
