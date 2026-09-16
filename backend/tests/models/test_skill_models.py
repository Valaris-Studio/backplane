# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Schema-level guarantees for the skill-registry tables (spec note f58cae0c).

These assert what the DATABASE enforces, not what a service chooses to do:
per-workspace slug uniqueness, per-skill version uniqueness, the status
CHECK, the board×skill composite PK, the `enabled` server default, and the
CASCADEs that keep deleted parents from leaving orphans. Also pins model
REGISTRATION: the tests' in-memory DB is built from Base.metadata, so a skill
model not importable from app.models simply has no table anywhere.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole


FILES = [{"path": "SKILL.md", "content": "---\nname: A\ndescription: B\n---\n\nbody\n"}]
CONTENT_HASH = "0" * 64


def test_skill_models_are_registered_in_app_models():
    # conftest's create_all only builds tables for models importable from
    # app.models — an unregistered model is a missing table in every test.
    from app import models

    for name in ("Skill", "SkillVersion", "BoardSkill"):
        assert hasattr(models, name), f"app.models must export {name}"

    from app.models.skills.skill import BoardSkill, Skill, SkillVersion

    assert Skill.__tablename__ == "skills"
    assert SkillVersion.__tablename__ == "skill_versions"
    assert BoardSkill.__tablename__ == "board_skills"


def _skill(workspace: Workspace, user: User, slug: str = "review-ritual"):
    from app.models.skills.skill import Skill

    return Skill(
        workspace_id=workspace.id,
        slug=slug,
        name="Review Ritual",
        description="How reviews run here.",
        created_by=user.id,
    )


def _version(skill, n: int = 1, status: str = "draft"):
    from app.models.skills.skill import SkillVersion

    return SkillVersion(
        skill_id=skill.id,
        version=n,
        files=FILES,
        status=status,
        content_hash=CONTENT_HASH,
    )


# --- skills ------------------------------------------------------------------


async def test_create_skill_row_defaults(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    skill = _skill(test_workspace, test_user)
    db_session.add(skill)
    await db_session.flush()

    assert skill.id is not None
    assert skill.latest_published_version is None
    assert skill.origin is None
    assert skill.created_at is not None


async def test_skill_slug_unique_per_workspace(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    db_session.add(_skill(test_workspace, test_user))
    await db_session.flush()

    db_session.add(_skill(test_workspace, test_user))
    with pytest.raises(IntegrityError):
        await db_session.flush()


async def test_skill_slug_reusable_across_workspaces(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    other = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(other)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=other.id, user_id=test_user.id, role=WorkspaceRole.owner
        )
    )

    db_session.add(_skill(test_workspace, test_user))
    db_session.add(_skill(other, test_user))
    await db_session.flush()


async def test_skill_requires_workspace(db_session: AsyncSession, test_user: User):
    from app.models.skills.skill import Skill

    db_session.add(
        Skill(slug="orphan", name="Orphan", description="x", created_by=test_user.id)
    )
    with pytest.raises(IntegrityError):
        await db_session.flush()


async def test_workspace_delete_cascades_to_skills(
    db_session: AsyncSession, test_user: User
):
    from app.models.skills.skill import Skill

    doomed = Workspace(name="Doomed", slug="doomed", created_by=test_user.id)
    db_session.add(doomed)
    await db_session.flush()
    db_session.add(_skill(doomed, test_user))
    await db_session.flush()

    await db_session.delete(doomed)
    await db_session.flush()

    remaining = (await db_session.execute(select(Skill))).scalars().all()
    assert remaining == []


# --- skill versions ----------------------------------------------------------


async def test_skill_version_unique_per_skill(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    skill = _skill(test_workspace, test_user)
    db_session.add(skill)
    await db_session.flush()
    db_session.add(_version(skill, n=1))
    await db_session.flush()

    db_session.add(_version(skill, n=1))
    with pytest.raises(IntegrityError):
        await db_session.flush()


async def test_skill_version_status_check_constraint(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    skill = _skill(test_workspace, test_user)
    db_session.add(skill)
    await db_session.flush()

    for n, status in enumerate(("draft", "proposed", "published", "rejected"), start=1):
        db_session.add(_version(skill, n=n, status=status))
    await db_session.flush()

    db_session.add(_version(skill, n=99, status="bogus"))
    with pytest.raises(IntegrityError):
        await db_session.flush()


async def test_skill_delete_cascades_to_versions(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    from app.models.skills.skill import SkillVersion

    skill = _skill(test_workspace, test_user)
    db_session.add(skill)
    await db_session.flush()
    db_session.add(_version(skill, n=1))
    await db_session.flush()

    await db_session.delete(skill)
    await db_session.flush()

    remaining = (await db_session.execute(select(SkillVersion))).scalars().all()
    assert remaining == []


# --- board skills ------------------------------------------------------------


async def test_board_skill_composite_pk(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    from app.models.skills.skill import BoardSkill

    skill = _skill(test_workspace, test_user)
    db_session.add(skill)
    await db_session.flush()
    db_session.add(BoardSkill(board_id=test_board.id, skill_id=skill.id))
    await db_session.flush()

    db_session.add(BoardSkill(board_id=test_board.id, skill_id=skill.id))
    with pytest.raises(IntegrityError):
        await db_session.flush()


async def test_board_skill_enabled_defaults_true(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    from app.models.skills.skill import BoardSkill

    skill = _skill(test_workspace, test_user)
    db_session.add(skill)
    await db_session.flush()

    binding = BoardSkill(board_id=test_board.id, skill_id=skill.id)
    db_session.add(binding)
    await db_session.flush()
    await db_session.refresh(binding)

    assert binding.enabled is True
    assert binding.pinned_version is None
    assert binding.role is None


async def test_board_delete_cascades_to_board_skills(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    from app.models.skills.skill import BoardSkill

    board = Board(
        workspace_id=test_workspace.id,
        name="Doomed Board",
        slug="doomed-board",
        created_by=test_user.id,
    )
    skill = _skill(test_workspace, test_user)
    db_session.add_all([board, skill])
    await db_session.flush()
    db_session.add(BoardSkill(board_id=board.id, skill_id=skill.id))
    await db_session.flush()

    await db_session.delete(board)
    await db_session.flush()

    remaining = (await db_session.execute(select(BoardSkill))).scalars().all()
    assert remaining == []
