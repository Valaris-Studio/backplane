# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""unique (workspace_id, team_id, team_role, stage, slug) on agent_prompt_configs

Slug-portability initiative: a prompt's slug must be unique within its scope
so config export/import has a stable re-import key. Prior to this migration
duplicate slugs were possible within the same (workspace, team, role, stage),
which breaks round-tripping configs across environments.

Upgrade dedupes first, then adds the constraint:
- For each (workspace_id, team_id, team_role, stage, slug) group we keep the
  oldest row (lowest created_at; id as tiebreaker) and delete the rest. This
  matches repo.list_by_workspace's slug-ordered read, so consumers see the
  same canonical row they were already seeing.
- NULL values compare as distinct in both PostgreSQL (default) and SQLite, so
  system defaults (workspace_id=NULL, team_id=NULL) are untouched by the
  dedupe even if two workspaces share the same (role, stage, slug) triple.

Revision ID: 041
Revises: 040
Create Date: 2026-04-17
"""

from alembic import op

revision = "041"
down_revision = "040"
branch_labels = None
depends_on = None


_DEDUPE_SQL = """
DELETE FROM agent_prompt_configs
WHERE id IN (
    SELECT id FROM (
        SELECT
            id,
            ROW_NUMBER() OVER (
                PARTITION BY workspace_id, team_id, team_role, stage, slug
                ORDER BY created_at ASC, id ASC
            ) AS rn
        FROM agent_prompt_configs
    ) ranked
    WHERE ranked.rn > 1
)
"""


def upgrade():
    bind = op.get_bind()
    bind.exec_driver_sql(_DEDUPE_SQL)
    op.create_unique_constraint(
        "uq_agent_prompt_configs_scope_slug",
        "agent_prompt_configs",
        ["workspace_id", "team_id", "team_role", "stage", "slug"],
    )


def downgrade():
    op.drop_constraint(
        "uq_agent_prompt_configs_scope_slug",
        "agent_prompt_configs",
        type_="unique",
    )
