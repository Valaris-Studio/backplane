# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tests for ConsolidatorCardCreator (PAR-3c).

Asserts the conflict-consolidator-card creation flow:
  - Creates a card when workspace_config.conflict_consolidator is enabled.
  - Gracefully no-ops (returns None) when config unset or disabled.
  - Idempotent: re-running with the same parent + label returns the existing
    consolidator card instead of duplicating.
  - The created card carries parent_card_id pointing back at the original and
    the configured label.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.merge_queue import MergeQueueEntry
from app.models.git.git_repo import GitProvider, GitRepo
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.user import User
from app.models.workspace import Workspace
from app.models.workspace_config import WorkspaceConfig
from app.services.conflict_consolidator import ConsolidatorCardCreator
from app.services.kanban.card import CardService


async def _make_repo(db: AsyncSession, board: Board, user: User) -> GitRepo:
    repo = GitRepo(
        board_id=board.id,
        workspace_id=board.workspace_id,
        name="acme",
        slug="acme",
        url="https://github.com/acme/acme",
        provider=GitProvider.github,
        default_branch="main",
        integration_branch="develop",
        added_by=user.id,
    )
    db.add(repo)
    await db.flush()
    return repo


async def _make_card(
    db: AsyncSession,
    board: Board,
    column: Column,
    user: User,
    title: str = "original",
) -> Card:
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title=title,
        description="",
        position=1024.0,
        created_by=user.id,
    )
    db.add(card)
    await db.flush()
    return card


async def _enqueued_entry(
    db: AsyncSession,
    *,
    workspace: Workspace,
    repo: GitRepo,
    card: Card,
) -> MergeQueueEntry:
    entry = MergeQueueEntry(
        repo_id=repo.id,
        integration_branch="develop",
        card_id=card.id,
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=workspace.id,
        state="conflict",
    )
    db.add(entry)
    await db.flush()
    return entry


async def _set_consolidator_config(
    db: AsyncSession,
    *,
    workspace: Workspace,
    config: dict[str, Any] | None,
) -> WorkspaceConfig:
    cfg = WorkspaceConfig(
        workspace_id=workspace.id,
        conflict_consolidator=config,
    )
    db.add(cfg)
    await db.flush()
    return cfg


class _RecordingBus:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict, uuid.UUID]] = []

    async def publish(
        self, *, event_type: str, payload: dict, workspace_id: uuid.UUID
    ) -> None:
        self.events.append((event_type, payload, workspace_id))


@pytest.mark.asyncio
async def test_creates_card_when_config_enabled(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    original = await _make_card(db_session, test_board, test_column, test_user)
    entry = await _enqueued_entry(
        db_session, workspace=test_workspace, repo=repo, card=original
    )
    await _set_consolidator_config(
        db_session,
        workspace=test_workspace,
        config={
            "enabled": True,
            "board_id": str(test_board.id),
            "column_id": str(test_column.id),
            "label": "consolidate-merge-conflict",
        },
    )

    bus = _RecordingBus()
    creator = ConsolidatorCardCreator(
        db_session,
        card_service=CardService(db_session),
        event_bus=bus,
    )

    consolidator = await creator.create_for_entry(
        entry, conflict_message="rebase conflict in: app/foo.py"
    )

    assert consolidator is not None
    assert consolidator.parent_card_id == original.id
    assert "consolidate-merge-conflict" in (consolidator.labels or [])
    event_types = [e[0] for e in bus.events]
    assert "merge_queue.conflict_consolidator_created" in event_types


@pytest.mark.asyncio
async def test_returns_none_when_config_unset(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    original = await _make_card(db_session, test_board, test_column, test_user)
    entry = await _enqueued_entry(
        db_session, workspace=test_workspace, repo=repo, card=original
    )
    # No WorkspaceConfig row at all — graceful degradation.

    creator = ConsolidatorCardCreator(
        db_session, card_service=CardService(db_session)
    )
    result = await creator.create_for_entry(entry, conflict_message="boom")
    assert result is None


@pytest.mark.asyncio
async def test_returns_none_when_config_disabled(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    original = await _make_card(db_session, test_board, test_column, test_user)
    entry = await _enqueued_entry(
        db_session, workspace=test_workspace, repo=repo, card=original
    )
    await _set_consolidator_config(
        db_session,
        workspace=test_workspace,
        config={
            "enabled": False,
            "board_id": str(test_board.id),
            "column_id": str(test_column.id),
            "label": "consolidate-merge-conflict",
        },
    )

    creator = ConsolidatorCardCreator(
        db_session, card_service=CardService(db_session)
    )
    result = await creator.create_for_entry(entry, conflict_message="boom")
    assert result is None


@pytest.mark.asyncio
async def test_idempotent_skips_existing_consolidator_card(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    original = await _make_card(db_session, test_board, test_column, test_user)
    entry = await _enqueued_entry(
        db_session, workspace=test_workspace, repo=repo, card=original
    )
    await _set_consolidator_config(
        db_session,
        workspace=test_workspace,
        config={
            "enabled": True,
            "board_id": str(test_board.id),
            "column_id": str(test_column.id),
            "label": "consolidate-merge-conflict",
        },
    )

    bus = _RecordingBus()
    creator = ConsolidatorCardCreator(
        db_session, card_service=CardService(db_session), event_bus=bus
    )

    first = await creator.create_for_entry(entry, conflict_message="first")
    second = await creator.create_for_entry(entry, conflict_message="second")

    assert first is not None and second is not None
    assert first.id == second.id
    created_events = [
        e for e in bus.events if e[0] == "merge_queue.conflict_consolidator_created"
    ]
    assert len(created_events) == 1, "second call must not re-emit creation event"


@pytest.mark.asyncio
async def test_card_carries_parent_card_id_and_label(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    original = await _make_card(
        db_session, test_board, test_column, test_user, title="Add widgets"
    )
    entry = await _enqueued_entry(
        db_session, workspace=test_workspace, repo=repo, card=original
    )
    await _set_consolidator_config(
        db_session,
        workspace=test_workspace,
        config={
            "enabled": True,
            "board_id": str(test_board.id),
            "column_id": str(test_column.id),
            "label": "needs-merge-resolve",
        },
    )

    creator = ConsolidatorCardCreator(
        db_session, card_service=CardService(db_session)
    )
    consolidator = await creator.create_for_entry(
        entry, conflict_message="rebase conflict in: README.md"
    )

    assert consolidator is not None
    assert consolidator.parent_card_id == original.id
    assert consolidator.column_id == test_column.id
    assert consolidator.board_id == test_board.id
    assert consolidator.title.startswith("Resolve merge conflict")
    assert "Add widgets" in consolidator.title
    assert "needs-merge-resolve" in (consolidator.labels or [])
    # Description carries original-card pointer + raw conflict body.
    assert "README.md" in (consolidator.description or "")
    assert original.title in (consolidator.description or "")
