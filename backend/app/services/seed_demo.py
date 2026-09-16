# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Populate a fresh install with something worth looking at.

This is usually the second command a self-hoster runs, right after bringing the
stack up, so it is deliberately undemanding: no Go toolchain, no LLM key, no
network. It writes a small workspace whose board shows the shape of the product
— typed columns, cards spread across them, a couple of realistic descriptions.

Two properties matter more than the content:
  * re-running it changes nothing (people re-run after a failed compose), and
  * it refuses to touch an instance that already holds unrelated work.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ValarisError
from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardType, Priority
from app.models.kanban.column import Column, ColumnType
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole

DEMO_SLUG = "demo"
DEMO_WORKSPACE_NAME = "Demo Workspace"
DEMO_USER_EMAIL = "demo@backplane.local"
DEMO_BOARD_NAME = "Website Relaunch"

# Fractional indexing: new items get max_position + 1024 (see CLAUDE.md).
_POSITION_STEP = 1024.0


class SeedRefused(ValarisError):
    status_code = 409
    detail = "Refusing to seed: this instance already contains data"
    error_code = "seed_refused"


@dataclass(frozen=True)
class SeedResult:
    workspace_id: uuid.UUID
    created: bool


_COLUMNS: tuple[tuple[str, ColumnType], ...] = (
    ("Backlog", ColumnType.backlog),
    ("In Progress", ColumnType.active),
    ("Review", ColumnType.review),
    ("Done", ColumnType.done),
)

# (column index, title, type, priority, description)
_CARDS: tuple[tuple[int, str, CardType, Priority, str], ...] = (
    (
        0,
        "Draft the new pricing page copy",
        CardType.task,
        Priority.medium,
        "Three tiers, no feature table longer than the screen. Needs a pass "
        "from whoever owns positioning before it goes to design.",
    ),
    (
        0,
        "Audit third-party scripts on the marketing site",
        CardType.task,
        Priority.low,
        "We are loading five analytics tags and nobody can name what two of "
        "them do. List them, find an owner for each, drop the orphans.",
    ),
    (
        0,
        "Broken anchor links in the docs nav",
        CardType.bug,
        Priority.low,
        "Deep links into the API reference land at the top of the page "
        "instead of the section.",
    ),
    (
        1,
        "Rebuild the homepage hero",
        CardType.feature,
        Priority.high,
        "New illustration, one sentence of copy, one call to action. The "
        "current hero says four things and lands none of them.",
    ),
    (
        1,
        "Migrate image assets to the CDN",
        CardType.task,
        Priority.medium,
        "Cuts roughly 900KB from first paint on the landing pages.",
    ),
    (
        2,
        "Accessibility pass on the signup flow",
        CardType.task,
        Priority.high,
        "Keyboard traps in the plan picker, and the error text is not "
        "announced. Blocks launch.",
    ),
    (
        3,
        "Set up preview deployments per pull request",
        CardType.feature,
        Priority.medium,
        "Reviewers stopped guessing what a change looks like. Worth the hour "
        "it took.",
    ),
    (
        3,
        "Fix layout shift on the changelog page",
        CardType.bug,
        Priority.low,
        "Date badges were loading after the text and pushing it down.",
    ),
)


async def _ensure_owner_membership(
    db: AsyncSession, workspace_id: uuid.UUID, email: str
) -> None:
    """Give `email` owner access to the workspace, provisioning the user if needed."""
    from app.core.auth import normalize_email

    email = normalize_email(email)
    user = (
        await db.execute(select(User).where(User.email == email))
    ).scalar_one_or_none()
    if user is None:
        # Same derivation as auth auto-provision (app/core/auth.py) so the seed
        # and a later sign-in produce one identity with one display name.
        user = User(email=email, name=email.split("@")[0].replace(".", " ").title())
        db.add(user)
        await db.flush()

    membership = (
        await db.execute(
            select(WorkspaceMember).where(
                WorkspaceMember.workspace_id == workspace_id,
                WorkspaceMember.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if membership is None:
        db.add(
            WorkspaceMember(
                workspace_id=workspace_id, user_id=user.id, role=WorkspaceRole.owner
            )
        )
        await db.flush()


async def seed_demo(
    db: AsyncSession, *, force: bool = False, member_email: str | None = None
) -> SeedResult:
    """Create the demo workspace, or report the existing one.

    Raises `SeedRefused` when the instance already holds workspaces other than
    the demo — seeding is for empty installs, and silently adding clutter to
    someone's real deployment would be worse than doing nothing.

    `member_email` additionally grants that account owner access — without it
    the seeded workspace is invisible to the person who ran the seed, because
    `get_workspace` enforces membership. It works on the already-exists path
    too, so re-running with an email repairs access after the fact.
    """
    existing = (
        await db.execute(select(Workspace).where(Workspace.slug == DEMO_SLUG))
    ).scalar_one_or_none()
    if existing is not None:
        if member_email:
            await _ensure_owner_membership(db, existing.id, member_email)
        return SeedResult(workspace_id=existing.id, created=False)

    if not force:
        other_workspaces = (
            await db.scalar(
                select(func.count())
                .select_from(Workspace)
                .where(Workspace.slug != DEMO_SLUG)
            )
            or 0
        )
        if other_workspaces:
            raise SeedRefused(
                f"This instance already has {other_workspaces} workspace(s). "
                "Re-run with --force if you really want demo data here."
            )

    owner = (
        await db.execute(select(User).where(User.email == DEMO_USER_EMAIL))
    ).scalar_one_or_none()
    if owner is None:
        owner = User(email=DEMO_USER_EMAIL, name="Demo User")
        db.add(owner)
        await db.flush()

    workspace = Workspace(name=DEMO_WORKSPACE_NAME, slug=DEMO_SLUG, created_by=owner.id)
    db.add(workspace)
    await db.flush()

    # Without membership the owner cannot open the workspace they just created:
    # `get_workspace` resolves slug → workspace AND verifies membership.
    db.add(
        WorkspaceMember(
            workspace_id=workspace.id, user_id=owner.id, role=WorkspaceRole.owner
        )
    )

    board = Board(
        workspace_id=workspace.id,
        name=DEMO_BOARD_NAME,
        description="A sample board so you can see what a populated Backplane looks like.",
        created_by=owner.id,
    )
    db.add(board)
    await db.flush()

    columns: list[Column] = []
    for index, (name, column_type) in enumerate(_COLUMNS):
        column = Column(
            board_id=board.id,
            name=name,
            column_type=column_type,
            position=(index + 1) * _POSITION_STEP,
        )
        db.add(column)
        columns.append(column)
    await db.flush()

    per_column_position: dict[uuid.UUID, float] = {}
    for column_index, title, card_type, priority, description in _CARDS:
        column = columns[column_index]
        position = per_column_position.get(column.id, 0.0) + _POSITION_STEP
        per_column_position[column.id] = position
        db.add(
            Card(
                column_id=column.id,
                board_id=board.id,
                title=title,
                description=description,
                card_type=card_type,
                priority=priority,
                position=position,
                created_by=owner.id,
            )
        )
    await db.flush()

    if member_email:
        await _ensure_owner_membership(db, workspace.id, member_email)

    return SeedResult(workspace_id=workspace.id, created=True)
