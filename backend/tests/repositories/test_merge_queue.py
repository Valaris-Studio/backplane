# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Repository-level tests for the PAR-2 merge queue.

Pure data-access — no service orchestration. Service tests live in
tests/services/test_merge_queue.py and exercise transitions + WS events.
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.git.git_repo import GitProvider, GitRepo
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.user import User
from app.models.workspace import Workspace
from app.repositories.merge_queue import MergeQueueRepository


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
    title: str = "card",
    position: float = 1024.0,
) -> Card:
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title=title,
        description="",
        position=position,
        created_by=user.id,
    )
    db.add(card)
    await db.flush()
    return card


@pytest.mark.asyncio
async def test_enqueue_inserts_with_default_state_queued(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    entries_repo = MergeQueueRepository(db_session)
    entry = await entries_repo.enqueue(
        repo_id=repo.id,
        integration_branch="develop",
        card_id=card.id,
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )

    assert entry.id is not None
    assert entry.state == "queued"
    assert entry.attempt_count == 0
    assert entry.merged_at is None


@pytest.mark.asyncio
async def test_get_by_card_id_returns_existing(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    entries_repo = MergeQueueRepository(db_session)
    inserted = await entries_repo.enqueue(
        repo_id=repo.id,
        integration_branch="develop",
        card_id=card.id,
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )

    found = await entries_repo.get_by_card_id(card.id)
    assert found is not None
    assert found.id == inserted.id


@pytest.mark.asyncio
async def test_get_by_card_id_returns_none_for_unknown(
    db_session: AsyncSession,
    test_card: Card,
):
    entries_repo = MergeQueueRepository(db_session)
    assert await entries_repo.get_by_card_id(test_card.id) is None


@pytest.mark.asyncio
async def test_pop_next_returns_oldest_queued_entry(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    card_old = await _make_card(
        db_session, test_board, test_column, test_user, title="old", position=1.0
    )
    card_new = await _make_card(
        db_session, test_board, test_column, test_user, title="new", position=2.0
    )

    entries_repo = MergeQueueRepository(db_session)
    older = await entries_repo.enqueue(
        repo_id=repo.id,
        integration_branch="develop",
        card_id=card_old.id,
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/old",
        workspace_id=test_workspace.id,
    )
    await entries_repo.enqueue(
        repo_id=repo.id,
        integration_branch="develop",
        card_id=card_new.id,
        pr_url="https://github.com/acme/acme/pull/2",
        pr_branch="feat/new",
        workspace_id=test_workspace.id,
    )

    popped = await entries_repo.pop_next(
        repo_id=repo.id, integration_branch="develop"
    )
    assert popped is not None
    assert popped.id == older.id


@pytest.mark.asyncio
async def test_pop_next_returns_none_when_empty(
    db_session: AsyncSession,
    test_board: Board,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    entries_repo = MergeQueueRepository(db_session)

    popped = await entries_repo.pop_next(
        repo_id=repo.id, integration_branch="develop"
    )
    assert popped is None


@pytest.mark.asyncio
async def test_pop_next_skips_non_queued_states(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    entries_repo = MergeQueueRepository(db_session)
    entry = await entries_repo.enqueue(
        repo_id=repo.id,
        integration_branch="develop",
        card_id=card.id,
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )
    await entries_repo.mark_merging(entry.id)

    popped = await entries_repo.pop_next(
        repo_id=repo.id, integration_branch="develop"
    )
    assert popped is None


@pytest.mark.asyncio
async def test_state_transitions(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    from datetime import datetime

    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    entries_repo = MergeQueueRepository(db_session)
    entry = await entries_repo.enqueue(
        repo_id=repo.id,
        integration_branch="develop",
        card_id=card.id,
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )

    merging = await entries_repo.mark_merging(entry.id)
    assert merging.state == "merging"
    assert merging.attempt_count == 1

    merged_at = datetime.utcnow()
    merged = await entries_repo.mark_merged(entry.id, merged_at=merged_at)
    assert merged.state == "merged"
    assert merged.merged_at is not None


@pytest.mark.asyncio
async def test_mark_conflict_records_error(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    entries_repo = MergeQueueRepository(db_session)
    entry = await entries_repo.enqueue(
        repo_id=repo.id,
        integration_branch="develop",
        card_id=card.id,
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )

    conflicted = await entries_repo.mark_conflict(
        entry.id, error_message="merge conflict on file.py"
    )
    assert conflicted.state == "conflict"
    assert conflicted.error_message == "merge conflict on file.py"


@pytest.mark.asyncio
async def test_list_active_filters_by_state(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    card_a = await _make_card(
        db_session, test_board, test_column, test_user, title="a", position=1.0
    )
    card_b = await _make_card(
        db_session, test_board, test_column, test_user, title="b", position=2.0
    )

    entries_repo = MergeQueueRepository(db_session)
    queued = await entries_repo.enqueue(
        repo_id=repo.id,
        integration_branch="develop",
        card_id=card_a.id,
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/a",
        workspace_id=test_workspace.id,
    )
    merged_entry = await entries_repo.enqueue(
        repo_id=repo.id,
        integration_branch="develop",
        card_id=card_b.id,
        pr_url="https://github.com/acme/acme/pull/2",
        pr_branch="feat/b",
        workspace_id=test_workspace.id,
    )
    await entries_repo.mark_merging(merged_entry.id)
    from datetime import datetime

    await entries_repo.mark_merged(merged_entry.id, merged_at=datetime.utcnow())

    active = await entries_repo.list_active(
        repo_id=repo.id,
        integration_branch="develop",
        states=("queued", "merging"),
    )
    ids = [e.id for e in active]
    assert queued.id in ids
    assert merged_entry.id not in ids


@pytest.mark.asyncio
async def test_cancel_deletes_entry(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    entries_repo = MergeQueueRepository(db_session)
    entry = await entries_repo.enqueue(
        repo_id=repo.id,
        integration_branch="develop",
        card_id=card.id,
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
    )

    await entries_repo.cancel(entry.id)

    assert await entries_repo.get(entry.id) is None
