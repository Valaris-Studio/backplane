# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""`make seed-demo` — a populated workspace an evaluator can click through.

The seed is the first thing a new self-hoster runs, so it must be safe to run
twice (people re-run it after a failed docker compose), must not need a Go
build or an LLM key, and must never touch a database that already holds real
work.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column, ColumnType
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.services.seed_demo import DEMO_SLUG, SeedRefused, seed_demo


@pytest_asyncio.fixture
async def seed_db(db_engine):
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session


async def _count(db: AsyncSession, model) -> int:
    return await db.scalar(select(func.count()).select_from(model)) or 0


@pytest.mark.asyncio
async def test_seed_creates_a_usable_workspace(seed_db):
    result = await seed_demo(seed_db)

    workspace = (
        await seed_db.execute(select(Workspace).where(Workspace.slug == DEMO_SLUG))
    ).scalar_one()
    assert workspace.name
    assert result.created is True


@pytest.mark.asyncio
async def test_seed_creates_board_columns_and_cards(seed_db):
    await seed_demo(seed_db)

    board = (await seed_db.execute(select(Board))).scalars().first()
    assert board is not None

    columns = (await seed_db.execute(select(Column))).scalars().all()
    assert len(columns) >= 3, "a demo board needs enough columns to show flow"
    # Typed columns are what the runner and board views key off — an untyped
    # demo board would look broken in the very screens it exists to show.
    assert {c.column_type for c in columns} >= {
        ColumnType.backlog,
        ColumnType.active,
        ColumnType.done,
    }

    assert await _count(seed_db, Card) >= 5, "an empty board demos nothing"


@pytest.mark.asyncio
async def test_seeded_cards_are_spread_across_columns(seed_db):
    """All cards in one column would misrepresent what the board looks like."""
    await seed_demo(seed_db)

    cards = (await seed_db.execute(select(Card))).scalars().all()
    assert len({card.column_id for card in cards}) >= 3


@pytest.mark.asyncio
async def test_seed_owner_is_a_workspace_member(seed_db):
    """Otherwise the demo user cannot open the workspace they just created."""
    await seed_demo(seed_db)

    workspace = (
        await seed_db.execute(select(Workspace).where(Workspace.slug == DEMO_SLUG))
    ).scalar_one()
    member = (
        await seed_db.execute(
            select(WorkspaceMember).where(
                WorkspaceMember.workspace_id == workspace.id,
                WorkspaceMember.user_id == workspace.created_by,
            )
        )
    ).scalar_one_or_none()
    assert member is not None


# ── idempotency: people re-run this ──


@pytest.mark.asyncio
async def test_running_twice_creates_nothing_extra(seed_db):
    await seed_demo(seed_db)
    counts = (
        await _count(seed_db, Workspace),
        await _count(seed_db, Board),
        await _count(seed_db, Column),
        await _count(seed_db, Card),
        await _count(seed_db, User),
    )

    second = await seed_demo(seed_db)

    assert second.created is False
    assert (
        await _count(seed_db, Workspace),
        await _count(seed_db, Board),
        await _count(seed_db, Column),
        await _count(seed_db, Card),
        await _count(seed_db, User),
    ) == counts


@pytest.mark.asyncio
async def test_second_run_reports_the_existing_workspace(seed_db):
    first = await seed_demo(seed_db)
    second = await seed_demo(seed_db)
    assert second.workspace_id == first.workspace_id


# ── safety: never scribble on someone's real data ──


@pytest.mark.asyncio
async def test_refuses_when_unrelated_workspaces_exist(seed_db):
    """A populated instance is someone's real work — don't add demo clutter."""
    owner = User(email="real@corp.example", name="Real User")
    seed_db.add(owner)
    await seed_db.flush()
    seed_db.add(Workspace(name="Real Work", slug="real-work", created_by=owner.id))
    await seed_db.flush()

    with pytest.raises(SeedRefused):
        await seed_demo(seed_db)

    assert await _count(seed_db, Board) == 0


@pytest.mark.asyncio
async def test_force_overrides_the_safety_check(seed_db):
    owner = User(email="real@corp.example", name="Real User")
    seed_db.add(owner)
    await seed_db.flush()
    seed_db.add(Workspace(name="Real Work", slug="real-work", created_by=owner.id))
    await seed_db.flush()

    result = await seed_demo(seed_db, force=True)
    assert result.created is True


@pytest.mark.asyncio
async def test_reseeding_after_demo_exists_is_not_refused(seed_db):
    """The demo workspace itself must not trip the 'existing data' guard."""
    await seed_demo(seed_db)
    result = await seed_demo(seed_db)  # no force needed
    assert result.created is False


# ── member_email: the person who ran the seed must be able to open it ──
#
# Dev mode auto-authenticates as dev@valaris.dev and `get_workspace` enforces
# membership, so a seed that only enrolls demo@backplane.local produces a
# workspace the seeder cannot see.


async def _memberships_for(db: AsyncSession, workspace_id, email: str):
    user = (
        await db.execute(select(User).where(User.email == email))
    ).scalar_one_or_none()
    if user is None:
        return []
    return (
        (
            await db.execute(
                select(WorkspaceMember).where(
                    WorkspaceMember.workspace_id == workspace_id,
                    WorkspaceMember.user_id == user.id,
                )
            )
        )
        .scalars()
        .all()
    )


@pytest.mark.asyncio
async def test_seed_with_member_email_grants_owner_membership(seed_db):
    result = await seed_demo(seed_db, member_email="dev@valaris.dev")

    memberships = await _memberships_for(seed_db, result.workspace_id, "dev@valaris.dev")
    assert len(memberships) == 1
    assert memberships[0].role == WorkspaceRole.owner


@pytest.mark.asyncio
async def test_seed_with_member_email_creates_user_with_auth_style_name(seed_db):
    """Name derivation must match auth auto-provision, or the same person ends
    up with a different display name depending on which path created them."""
    await seed_demo(seed_db, member_email="jane.doe@corp.example")

    user = (
        await seed_db.execute(select(User).where(User.email == "jane.doe@corp.example"))
    ).scalar_one()
    assert user.name == "Jane Doe"


@pytest.mark.asyncio
async def test_seed_with_member_email_reuses_existing_user(seed_db):
    existing = User(email="dev@valaris.dev", name="Dev User")
    seed_db.add(existing)
    await seed_db.flush()

    await seed_demo(seed_db, member_email="dev@valaris.dev")

    users = (
        (await seed_db.execute(select(User).where(User.email == "dev@valaris.dev")))
        .scalars()
        .all()
    )
    assert len(users) == 1
    assert users[0].id == existing.id


@pytest.mark.asyncio
async def test_reseed_with_member_email_repairs_existing_workspace_access(seed_db):
    """People who seeded before member_email existed re-run with --email to
    get in — the already-exists path must attach the membership too."""
    first = await seed_demo(seed_db)

    second = await seed_demo(seed_db, member_email="dev@valaris.dev")

    assert second.created is False
    assert second.workspace_id == first.workspace_id
    memberships = await _memberships_for(seed_db, first.workspace_id, "dev@valaris.dev")
    assert len(memberships) == 1
    assert memberships[0].role == WorkspaceRole.owner


@pytest.mark.asyncio
async def test_reseeding_with_same_member_email_keeps_one_membership(seed_db):
    result = await seed_demo(seed_db, member_email="dev@valaris.dev")
    await seed_demo(seed_db, member_email="dev@valaris.dev")

    memberships = await _memberships_for(seed_db, result.workspace_id, "dev@valaris.dev")
    assert len(memberships) == 1


@pytest.mark.asyncio
async def test_member_email_does_not_bypass_the_safety_check(seed_db):
    owner = User(email="real@corp.example", name="Real User")
    seed_db.add(owner)
    await seed_db.flush()
    seed_db.add(Workspace(name="Real Work", slug="real-work", created_by=owner.id))
    await seed_db.flush()

    with pytest.raises(SeedRefused):
        await seed_demo(seed_db, member_email="dev@valaris.dev")


@pytest.mark.asyncio
async def test_member_email_leaves_demo_user_as_creator(seed_db):
    """Demo content stays attributed to Demo User — member_email only adds
    access, it does not take over the workspace."""
    result = await seed_demo(seed_db, member_email="dev@valaris.dev")

    workspace = (
        await seed_db.execute(select(Workspace).where(Workspace.id == result.workspace_id))
    ).scalar_one()
    demo_user = (
        await seed_db.execute(select(User).where(User.email == "demo@backplane.local"))
    ).scalar_one()
    assert workspace.created_by == demo_user.id
    demo_memberships = await _memberships_for(
        seed_db, result.workspace_id, "demo@backplane.local"
    )
    assert len(demo_memberships) == 1
    assert demo_memberships[0].role == WorkspaceRole.owner


@pytest.mark.asyncio
async def test_reseed_restores_stripped_owner_membership(seed_db):
    """Ownership invariant pin (card cd87225e): the already-exists repair path
    re-mints role=owner for a membership row that has gone missing (legacy
    state / manual cleanup) — not some lesser role. Note the repair only
    covers an ABSENT row: a row downgraded in place is deliberately left
    alone (`_ensure_owner_membership` early-outs on any existing row)."""
    result = await seed_demo(seed_db, member_email="dev@valaris.dev")
    memberships = await _memberships_for(seed_db, result.workspace_id, "dev@valaris.dev")
    assert len(memberships) == 1
    await seed_db.delete(memberships[0])
    await seed_db.flush()

    second = await seed_demo(seed_db, member_email="dev@valaris.dev")

    assert second.created is False
    memberships = await _memberships_for(seed_db, result.workspace_id, "dev@valaris.dev")
    assert len(memberships) == 1
    assert memberships[0].role == WorkspaceRole.owner
