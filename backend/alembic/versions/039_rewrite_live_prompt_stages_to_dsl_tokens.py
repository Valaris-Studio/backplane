# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""rewrite live prompt-config stages to DSL tokens

T0.4 (post-ST#8, 2026-04-17). The Go harness queries prompts by the DSL
stage token (`implement`, `review`, ...) but `prompt_defaults.py` was
seeding display-name stages (`Implement`, `Review Code`, ...). Every run
since the 3-role default silently fell back to hardcoded Go prompts.

This migration aligns existing rows with the new seed:
- For the 8 live stages Go queries, `stage = slug` (idempotent).
- Only touches seeded system rows (`is_system=true`). User-authored
  prompts are left alone — operators may have intentionally named their
  stages anything.

Revision ID: 039
Revises: 038
Create Date: 2026-04-17
"""

from alembic import op

revision = "039"
down_revision = "038"
branch_labels = None
depends_on = None

# DSL tokens Go's resolvePrompt actually queries. Slugs already match these,
# so `stage = slug` for these 8 rows is the canonical shape.
LIVE_STAGES = (
    "implement",
    "implement_after_approval",
    "mediate_rework",
    "rework_implement",
    "review",
    "document",
    "research",
    "plan",
)


def upgrade():
    bind = op.get_bind()
    placeholders = ",".join(f"'{s}'" for s in LIVE_STAGES)
    bind.exec_driver_sql(
        f"""
        UPDATE agent_prompt_configs
           SET stage = slug
         WHERE is_system = TRUE
           AND slug IN ({placeholders})
           AND stage <> slug
        """
    )


def downgrade():
    # No reliable way to reconstruct prior display names. This migration is
    # effectively one-way; an operator who needs to roll back must reseed.
    pass
