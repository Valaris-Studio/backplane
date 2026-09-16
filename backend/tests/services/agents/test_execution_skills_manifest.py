# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Execution rows record the materialized skills manifest (Skills Registry W3).

The runner reports WHICH skills (slug/name/description/version/content_hash)
it actually materialized for a stage, persisted on `agent_executions.skills`
(nullable JSON — NULL means "never reported", the ship_warnings precedent).
Honesty rule mirrors the completed-stays-completed demotion in
`update_execution`: a late update carrying skills=None must NOT clear a
manifest that was already recorded.
"""

from __future__ import annotations

import re
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.agents.execution import ExecutionCreate, ExecutionUpdate
from app.services.agents.execution import ExecutionService

MANIFEST = [
    {
        "slug": "pdf-tables",
        "name": "PDF Tables",
        "description": "Extract tables from PDFs",
        "version": 3,
        "content_hash": "ab" * 32,
    },
    {
        "slug": "api-conventions",
        "name": "API Conventions",
        "description": "House REST rules",
        "version": 1,
        "content_hash": "cd" * 32,
    },
]


def test_execution_create_schema_accepts_skills():
    assert "skills" in ExecutionCreate.model_fields
    assert ExecutionCreate.model_fields["skills"].default is None


def test_execution_update_schema_accepts_skills():
    assert "skills" in ExecutionUpdate.model_fields
    assert ExecutionUpdate.model_fields["skills"].default is None


async def test_start_execution_persists_skills_manifest(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_agent: Agent,
    test_board: Board,
    test_card: Card,
):
    service = ExecutionService(db_session)
    execution = await service.start_execution(
        test_agent.id,
        ExecutionCreate(
            workspace_slug=test_workspace.slug,
            board_id=test_board.id,
            card_id=test_card.id,
            action="implement_card",
            input_summary="work the card",
            skills=MANIFEST,
        ),
    )
    assert execution.skills == MANIFEST


async def test_start_execution_without_skills_persists_none(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_agent: Agent,
    test_board: Board,
):
    service = ExecutionService(db_session)
    execution = await service.start_execution(
        test_agent.id,
        ExecutionCreate(
            workspace_slug=test_workspace.slug,
            board_id=test_board.id,
            action="triage",
            input_summary="no skills reported",
        ),
    )
    # NULL = never reported (old runner / no skills), same as ship_warnings.
    assert execution.skills is None


async def test_update_execution_sets_skills_when_previously_none(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_agent: Agent,
    test_board: Board,
):
    """The runner may only know the manifest after materialization — a late
    report onto a still-None row must land."""
    service = ExecutionService(db_session)
    execution = await service.start_execution(
        test_agent.id,
        ExecutionCreate(
            workspace_slug=test_workspace.slug,
            board_id=test_board.id,
            action="implement_card",
            input_summary="late manifest",
        ),
    )
    assert execution.skills is None

    updated = await service.update_execution(
        test_agent.id,
        execution.id,
        ExecutionUpdate(skills=MANIFEST),
    )
    assert updated.skills == MANIFEST


async def test_update_execution_none_does_not_clear_manifest(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_agent: Agent,
    test_board: Board,
):
    """Telemetry honesty (the completed-stays-completed precedent at
    execution.py:234-240): an update explicitly carrying skills=None keeps the
    recorded manifest — a confused retry must not erase what ran."""
    service = ExecutionService(db_session)
    execution = await service.start_execution(
        test_agent.id,
        ExecutionCreate(
            workspace_slug=test_workspace.slug,
            board_id=test_board.id,
            action="implement_card",
            input_summary="manifest recorded at start",
            skills=MANIFEST,
        ),
    )

    updated = await service.update_execution(
        test_agent.id,
        execution.id,
        ExecutionUpdate(skills=None, output_summary="late write"),
    )
    assert updated.skills == MANIFEST
    assert updated.output_summary == "late write"


def test_migration_102_adds_nullable_skills_column():
    """Additive-only, rolling-deploy-safe: 102 revises 101 and adds a nullable
    `skills` column to agent_executions."""
    versions_dir = Path(__file__).resolve().parents[3] / "alembic" / "versions"
    matches = sorted(versions_dir.glob("102_*.py"))
    assert matches, f"no 102_*.py migration in {versions_dir}"
    text = matches[0].read_text()

    assert re.search(r"revision(?::\s*str)?\s*=\s*['\"]102['\"]", text)
    assert re.search(r"down_revision(?::[^=]+)?\s*=\s*['\"]101['\"]", text)
    assert "agent_executions" in text
    assert re.search(r"['\"]skills['\"]", text)
    assert "nullable=True" in text
