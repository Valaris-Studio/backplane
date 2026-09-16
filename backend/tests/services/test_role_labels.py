# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Phase A Piece 1 — role-label registry.

Backend-served labels dictionary that frontend (ROLE_COLORS, capitalize) and
Go runner (capitalizeRole) will consume in Phases B/C. The seam is workspace-
scoped, defaults are platform-level, overrides ride on WorkspaceConfig.
"""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.workspace import Workspace
from app.models.workspace_config import WorkspaceConfig
from app.services.agents.role_labels import (
    DEFAULT_ROLE_LABELS,
    get_role_labels,
)


async def test_default_role_labels_include_known_roles(
    db_session: AsyncSession, test_workspace: Workspace
):
    labels = await get_role_labels(db_session, test_workspace.id)

    for role in ("orchestrator", "reviewer", "documentator", "hero", "implementer"):
        assert role in labels, f"missing platform-default label for {role!r}"
        entry = labels[role]
        assert isinstance(entry.get("display_name"), str) and entry["display_name"]
        color = entry.get("color")
        assert isinstance(color, str) and color.startswith("#")


async def test_default_role_labels_returned_when_no_config_row(
    db_session: AsyncSession, test_workspace: Workspace
):
    labels = await get_role_labels(db_session, test_workspace.id)
    assert labels == DEFAULT_ROLE_LABELS


async def test_workspace_role_labels_overrides_defaults(
    db_session: AsyncSession, test_workspace: Workspace
):
    config = WorkspaceConfig(
        workspace_id=test_workspace.id,
        role_labels={"reviewer": {"display_name": "Auditor", "color": "#ffff00"}},
    )
    db_session.add(config)
    await db_session.flush()

    labels = await get_role_labels(db_session, test_workspace.id)

    assert labels["reviewer"]["display_name"] == "Auditor"
    assert labels["reviewer"]["color"] == "#ffff00"
    assert labels["orchestrator"] == DEFAULT_ROLE_LABELS["orchestrator"]
    assert labels["documentator"] == DEFAULT_ROLE_LABELS["documentator"]


async def test_workspace_role_labels_can_introduce_new_role(
    db_session: AsyncSession, test_workspace: Workspace
):
    """North-star acceptance: a workspace registers a brand-new role
    via config alone — no platform code change required."""
    config = WorkspaceConfig(
        workspace_id=test_workspace.id,
        role_labels={"archivist": {"display_name": "Archivist", "color": "#abcdef"}},
    )
    db_session.add(config)
    await db_session.flush()

    labels = await get_role_labels(db_session, test_workspace.id)

    assert "archivist" in labels
    assert labels["archivist"]["display_name"] == "Archivist"
    assert labels["archivist"]["color"] == "#abcdef"
    assert "orchestrator" in labels


async def test_role_labels_unknown_workspace_returns_defaults(
    db_session: AsyncSession,
):
    labels = await get_role_labels(db_session, uuid.uuid4())
    assert labels == DEFAULT_ROLE_LABELS
