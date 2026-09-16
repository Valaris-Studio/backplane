# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Skills manifest on the next-assignment wire (Skills Registry W3).

The assignment bundle gains an optional `skills` list — the board's effective
skill set at reservation time, so the runner can materialize the bundles for
the stage. Contract pinned here:

  - `AssignmentSkill` wire schema carries EXACTLY slug, name, description,
    version, content_hash — no more (skill_id/enabled/pinned_version/role are
    board-authority fields, not wire fields).
  - `NextAssignmentResponse.skills` is optional and defaults to None: a board
    with no bound skills serializes None/absent (NOT []), so old runners see
    nothing new when the set is empty.
  - The manifest equals the board's effective set (enabled bindings resolved
    to a published version); a disabled binding or draft-only skill never
    reaches the wire.
  - Dual-maintain rail: the schema module must carry a sync-contract note
    naming the Go mirror (runner/internal/valaris/types.go) next to
    AssignmentSkill.
"""

from __future__ import annotations

import inspect

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

import app.schemas.agents.assignment as assignment_schema
from app.models.agents.agent import Agent
from app.models.kanban.board import Board
from app.models.skills.skill import BoardSkill, Skill, SkillVersion
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.agents.assignment import NextAssignmentResponse
from tests.routers.agents.test_assignments import (
    URL_TPL,
    _add_team_role,
    _make_card,
    _make_repo,
    _make_typed_columns,
    _seed_default_pipeline,
)

WIRE_FIELDS = {"slug", "name", "description", "version", "content_hash"}


async def _seed_bound_skill(
    db: AsyncSession,
    workspace: Workspace,
    board: Board,
    user: User,
    *,
    slug: str,
    name: str | None = None,
    description: str = "",
    version_status: str = "published",
    enabled: bool = True,
) -> tuple[Skill, SkillVersion]:
    """A workspace skill with one version, bound to the board.

    `version_status="published"` also stamps latest_published_version so the
    binding resolves; "draft" leaves it None (draft-only skill — resolves to
    nothing, excluded from the effective set).
    """
    skill = Skill(
        workspace_id=workspace.id,
        slug=slug,
        name=name or slug,
        description=description,
        latest_published_version=1 if version_status == "published" else None,
        created_by=user.id,
    )
    db.add(skill)
    await db.flush()
    version = SkillVersion(
        skill_id=skill.id,
        version=1,
        files=[{"path": "SKILL.md", "content": f"---\nname: {slug}\n---\nbody"}],
        status=version_status,
        created_by_user_id=user.id,
        content_hash=f"{slug:0>4}".encode().hex().ljust(64, "0")[:64],
    )
    db.add(version)
    db.add(
        BoardSkill(
            board_id=board.id,
            skill_id=skill.id,
            enabled=enabled,
            bound_by=user.id,
        )
    )
    await db.flush()
    return skill, version


async def _reservable_board(
    db: AsyncSession, workspace: Workspace, board: Board, user: User, agent: Agent
):
    """Minimum seed for an implementer to reserve one card via next-assignment.

    Mirrors test_assignments.py's happy path: default pipeline + typed columns
    + repo + implementer role + one card in `active`.
    """
    await _seed_default_pipeline(db, workspace)
    cols = await _make_typed_columns(db, board)
    await _make_repo(db, board, user)
    await _add_team_role(db, workspace, agent, user, "implementer")
    await _make_card(db, board, cols["active"], user, title="real work")


def test_assignment_skill_schema_has_exact_wire_fields():
    from app.schemas.agents.assignment import AssignmentSkill

    assert set(AssignmentSkill.model_fields) == WIRE_FIELDS


def test_next_assignment_response_skills_defaults_to_none():
    field = NextAssignmentResponse.model_fields.get("skills")
    assert field is not None, "NextAssignmentResponse must carry a `skills` field"
    assert field.default is None, "empty manifest must serialize as None, not []"


def test_assignment_skill_declares_go_mirror_sync_contract():
    """Dual-maintained wire schema: the AssignmentSkill definition must name
    its Go mirror (types.go / client.go) so both sides change together."""
    source = inspect.getsource(assignment_schema)
    idx = source.find("class AssignmentSkill")
    assert idx != -1, "AssignmentSkill not defined in app.schemas.agents.assignment"
    window = source[idx : idx + 1500]
    assert "types.go" in window or "client.go" in window, (
        "AssignmentSkill must carry a sync-contract note naming the runner's "
        "Go mirror (runner/internal/valaris/types.go)"
    )


@pytest.mark.asyncio
async def test_next_assignment_no_bound_skills_omits_manifest(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    # Schema pin first: the field must EXIST (None-by-default), not merely be
    # absent because nothing defines it yet.
    assert "skills" in NextAssignmentResponse.model_fields

    await _reservable_board(db_session, test_workspace, test_board, test_user, test_agent)

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200
    body = resp.json()
    # None-or-absent, NEVER [] — old runners must see nothing new when empty.
    assert body.get("skills") is None


@pytest.mark.asyncio
async def test_next_assignment_bundles_effective_skills_manifest(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    await _reservable_board(db_session, test_workspace, test_board, test_user, test_agent)
    skill_b, version_b = await _seed_bound_skill(
        db_session, test_workspace, test_board, test_user,
        slug="pdf-tables", name="PDF Tables", description="Extract tables from PDFs",
    )
    skill_a, version_a = await _seed_bound_skill(
        db_session, test_workspace, test_board, test_user,
        slug="api-conventions", name="API Conventions", description="House REST rules",
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200
    body = resp.json()
    # Exact dict equality pins the wire field set AND the effective-set order
    # (slug asc) in one shot.
    assert body["skills"] == [
        {
            "slug": "api-conventions",
            "name": "API Conventions",
            "description": "House REST rules",
            "version": 1,
            "content_hash": version_a.content_hash,
        },
        {
            "slug": "pdf-tables",
            "name": "PDF Tables",
            "description": "Extract tables from PDFs",
            "version": 1,
            "content_hash": version_b.content_hash,
        },
    ]


@pytest.mark.asyncio
async def test_next_assignment_skills_exclude_disabled_and_draft_only(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """W1 effective-set semantics through the assignment lens: a disabled
    binding and a draft-only skill never reach the runner."""
    await _reservable_board(db_session, test_workspace, test_board, test_user, test_agent)
    _, live_version = await _seed_bound_skill(
        db_session, test_workspace, test_board, test_user,
        slug="live-skill", name="Live Skill", description="ships",
    )
    await _seed_bound_skill(
        db_session, test_workspace, test_board, test_user,
        slug="disabled-skill", enabled=False,
    )
    await _seed_bound_skill(
        db_session, test_workspace, test_board, test_user,
        slug="draft-only-skill", version_status="draft",
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["skills"] == [
        {
            "slug": "live-skill",
            "name": "Live Skill",
            "description": "ships",
            "version": 1,
            "content_hash": live_version.content_hash,
        }
    ]
