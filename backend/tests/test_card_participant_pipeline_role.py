# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""CardParticipant.pipeline_role column round-trip tests.

The pipeline_role column is the canonical role discriminator (planner,
implementer, reviewer, documentator, rework_mediator, plus any user-defined
role). The legacy `role` column stays as a display hint.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardParticipant, Priority
from app.models.kanban.column import Column, ColumnType
from app.models.user import User
from app.models.workspace import Workspace


@pytest.mark.asyncio
async def test_card_participant_persists_pipeline_role(
    db_session: AsyncSession,
):
    user = User(email="pr@valaris.dev", name="P")
    db_session.add(user)
    await db_session.flush()
    workspace = Workspace(
        name="pr", slug=f"pr-{uuid.uuid4().hex[:8]}", created_by=user.id
    )
    db_session.add(workspace)
    await db_session.flush()
    board = Board(
        workspace_id=workspace.id, name="b",
        slug=f"b-{uuid.uuid4().hex[:8]}", created_by=user.id,
    )
    db_session.add(board)
    await db_session.flush()
    column = Column(
        board_id=board.id, name="active", position=1.0, color="#888",
        column_type=ColumnType.active,
    )
    db_session.add(column)
    await db_session.flush()
    card = Card(
        board_id=board.id, column_id=column.id, title="t", position=1.0,
        priority=Priority.medium, created_by=user.id,
    )
    db_session.add(card)
    await db_session.flush()

    participant = CardParticipant(
        card_id=card.id,
        user_id=user.id,
        role="helper",
        pipeline_role="reviewer",
    )
    db_session.add(participant)
    await db_session.flush()

    result = await db_session.execute(
        select(CardParticipant).where(CardParticipant.card_id == card.id)
    )
    fetched = result.scalar_one()
    assert fetched.pipeline_role == "reviewer"
    assert fetched.role == "helper"


@pytest.mark.asyncio
async def test_card_participant_pipeline_role_defaults_to_null(
    db_session: AsyncSession,
):
    """Pre-migration code paths that don't set pipeline_role still work;
    the column is nullable and role-aware filters short-circuit on NULL."""
    user = User(email="pr2@valaris.dev", name="P2")
    db_session.add(user)
    await db_session.flush()
    workspace = Workspace(
        name="pr2", slug=f"pr-{uuid.uuid4().hex[:8]}", created_by=user.id
    )
    db_session.add(workspace)
    await db_session.flush()
    board = Board(
        workspace_id=workspace.id, name="b",
        slug=f"b-{uuid.uuid4().hex[:8]}", created_by=user.id,
    )
    db_session.add(board)
    await db_session.flush()
    column = Column(
        board_id=board.id, name="active", position=1.0, color="#888",
        column_type=ColumnType.active,
    )
    db_session.add(column)
    await db_session.flush()
    card = Card(
        board_id=board.id, column_id=column.id, title="t", position=1.0,
        priority=Priority.medium, created_by=user.id,
    )
    db_session.add(card)
    await db_session.flush()

    participant = CardParticipant(
        card_id=card.id,
        user_id=user.id,
        role="hero",
    )
    db_session.add(participant)
    await db_session.flush()

    result = await db_session.execute(
        select(CardParticipant).where(CardParticipant.card_id == card.id)
    )
    fetched = result.scalar_one()
    assert fetched.pipeline_role is None
