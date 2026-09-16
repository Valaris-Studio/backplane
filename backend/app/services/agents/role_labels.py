# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Role-label registry — backend-served seam for the multi-role north star.

Phase A Piece 1 (card 86ca1421): the frontend's hardcoded `ROLE_COLORS` and
the Go runner's `capitalizeRole` are platform-authority violations — every
new role would otherwise need code in three repos. This service serves the
labels dictionary; Phase B/C consumers replace their hardcoded maps with a
fetch from `/api/workspaces/{slug}/role-labels`.

Defaults cover the five known roles. Workspaces override or add new roles
via `WorkspaceConfig.role_labels` (JSON: `{role: {display_name, color}}`).
NULL means "use platform defaults". Per feedback_extensibility_no_limits.md,
there is NO allow-list — workspaces can register any role.
"""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.workspace_config import WorkspaceConfigRepository

# Color palette mirrors the seed values frontend ROLE_COLORS used pre-extraction
# (Phase C will swap the frontend constant for a fetch). Hex strings keep the
# wire format trivially consumable from both Go and TS.
DEFAULT_ROLE_LABELS: dict[str, dict[str, str]] = {
    "orchestrator": {"display_name": "Orchestrator", "color": "#3b82f6"},
    "reviewer": {"display_name": "Reviewer", "color": "#a855f7"},
    "documentator": {"display_name": "Documentator", "color": "#10b981"},
    "hero": {"display_name": "Hero", "color": "#f59e0b"},
    "implementer": {"display_name": "Implementer", "color": "#6366f1"},
    "helper": {"display_name": "Helper", "color": "#94a3b8"},
}


async def get_role_labels(
    db: AsyncSession, workspace_id: uuid.UUID
) -> dict[str, dict[str, str]]:
    """Merge `WorkspaceConfig.role_labels` over platform defaults.

    Per-role overrides replace the default entry wholesale (display_name and
    color must both be supplied per role). Unknown workspace_id silently
    returns defaults — the endpoint that calls this is membership-gated, so
    by the time we're here the caller has already been authorized.
    """
    repo = WorkspaceConfigRepository(db)
    config = await repo.get_by_workspace(workspace_id)
    merged = {role: dict(entry) for role, entry in DEFAULT_ROLE_LABELS.items()}
    overrides = config.role_labels if config and config.role_labels else None
    if isinstance(overrides, dict):
        for role, entry in overrides.items():
            if isinstance(role, str) and isinstance(entry, dict):
                merged[role] = dict(entry)
    return merged
