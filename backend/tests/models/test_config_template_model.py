# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Schema-level guarantees for the config-template tables (migration 096).

These assert what the DATABASE enforces, not what a service chooses to do:
the `kind` CHECK, the per-workspace slug uniqueness, and the CASCADE that
keeps a deleted workspace from leaving orphan templates behind.
"""

from __future__ import annotations

import pytest
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.config_template import (
    BoardLoopTemplateBinding,
    ConfigTemplate,
    ConfigTemplateVersion,
)
from app.models.user import User
from app.models.workspace import Workspace


async def _make_workspace(db: AsyncSession, owner: User, slug: str) -> Workspace:
    workspace = Workspace(name=slug, slug=slug, created_by=owner.id)
    db.add(workspace)
    await db.flush()
    return workspace


def _template(workspace: Workspace, **overrides) -> ConfigTemplate:
    fields: dict = {
        "workspace_id": workspace.id,
        "kind": "loop",
        "slug": "coding-loop",
        "name": "Coding Loop",
        "draft_profile": {},
        "draft_content": {},
    }
    fields.update(overrides)
    return ConfigTemplate(**fields)


class TestKindCheckConstraint:
    """`kind` is VARCHAR + CHECK per the operator Direction — adding
    'pipeline' must need no ALTER TYPE, and anything else must be rejected by
    the database rather than by a service guard.

    SQLite (tests) and PostgreSQL (prod) both enforce a table CHECK declared
    through SQLAlchemy's CheckConstraint, so this assertion has PG parity.
    """

    @pytest.mark.parametrize("kind", ["loop", "pipeline"])
    async def test_accepts_both_declared_kinds(
        self, db_session: AsyncSession, test_workspace: Workspace, kind: str
    ):
        db_session.add(_template(test_workspace, kind=kind, slug=f"t-{kind}"))
        await db_session.flush()

        stored = (
            await db_session.execute(
                select(ConfigTemplate.kind).where(ConfigTemplate.slug == f"t-{kind}")
            )
        ).scalar_one()
        assert stored == kind

    async def test_rejects_an_undeclared_kind(
        self, db_session: AsyncSession, test_workspace: Workspace
    ):
        db_session.add(_template(test_workspace, kind="foo"))

        with pytest.raises(IntegrityError):
            await db_session.flush()


class TestSlugUniqueness:
    async def test_same_slug_and_kind_in_one_workspace_is_rejected(
        self, db_session: AsyncSession, test_workspace: Workspace
    ):
        db_session.add(_template(test_workspace))
        await db_session.flush()
        db_session.add(_template(test_workspace, name="Coding Loop (copy)"))

        with pytest.raises(IntegrityError):
            await db_session.flush()

    async def test_same_slug_under_a_different_kind_is_allowed(
        self, db_session: AsyncSession, test_workspace: Workspace
    ):
        """Uniqueness is scoped by kind: loops and pipelines are different
        runner features and must not collide in one namespace."""
        db_session.add(_template(test_workspace, kind="loop"))
        db_session.add(_template(test_workspace, kind="pipeline"))

        await db_session.flush()

        count = len(
            (
                await db_session.execute(
                    select(ConfigTemplate).where(ConfigTemplate.slug == "coding-loop")
                )
            )
            .scalars()
            .all()
        )
        assert count == 2

    async def test_same_slug_in_another_workspace_is_allowed(
        self, db_session: AsyncSession, test_workspace: Workspace, test_user: User
    ):
        other = await _make_workspace(db_session, test_user, "other-ws")
        db_session.add(_template(test_workspace))
        db_session.add(_template(other))

        await db_session.flush()

        rows = (
            (
                await db_session.execute(
                    select(ConfigTemplate.workspace_id).where(
                        ConfigTemplate.slug == "coding-loop"
                    )
                )
            )
            .scalars()
            .all()
        )
        assert set(rows) == {test_workspace.id, other.id}


class TestVersionUniqueness:
    async def test_one_row_per_template_and_version(
        self, db_session: AsyncSession, test_workspace: Workspace
    ):
        template = _template(test_workspace)
        db_session.add(template)
        await db_session.flush()
        db_session.add(
            ConfigTemplateVersion(
                template_id=template.id, version=1, profile={}, content={}
            )
        )
        await db_session.flush()
        db_session.add(
            ConfigTemplateVersion(
                template_id=template.id, version=1, profile={}, content={}
            )
        )

        with pytest.raises(IntegrityError):
            await db_session.flush()


class TestCascades:
    async def test_deleting_a_workspace_removes_its_templates(
        self, db_session: AsyncSession, test_user: User
    ):
        workspace = await _make_workspace(db_session, test_user, "doomed-ws")
        db_session.add(_template(workspace))
        await db_session.flush()

        # Bulk DELETE, not session.delete(): the house style (BaseRepository
        # .delete_by_id) relies on the DB's ON DELETE rules rather than ORM
        # cascade walking, and that is what prod exercises.
        await db_session.execute(delete(Workspace).where(Workspace.id == workspace.id))
        await db_session.flush()

        remaining = (
            (
                await db_session.execute(
                    select(ConfigTemplate).where(
                        ConfigTemplate.workspace_id == workspace.id
                    )
                )
            )
            .scalars()
            .all()
        )
        assert remaining == []

    async def test_deleting_a_template_removes_its_versions(
        self, db_session: AsyncSession, test_workspace: Workspace
    ):
        template = _template(test_workspace)
        db_session.add(template)
        await db_session.flush()
        db_session.add(
            ConfigTemplateVersion(
                template_id=template.id, version=1, profile={}, content={}
            )
        )
        await db_session.flush()
        template_id = template.id

        await db_session.execute(
            delete(ConfigTemplate).where(ConfigTemplate.id == template_id)
        )
        await db_session.flush()

        remaining = (
            (
                await db_session.execute(
                    select(ConfigTemplateVersion).where(
                        ConfigTemplateVersion.template_id == template_id
                    )
                )
            )
            .scalars()
            .all()
        )
        assert remaining == []


class TestBindingIsOneRowPerBoard:
    async def test_board_id_is_the_primary_key(self, test_board):
        """Operator Direction: a board binds at most one loop template, so
        board_id is the PK — not a UUID surrogate with a unique index."""
        pk_columns = {c.name for c in BoardLoopTemplateBinding.__table__.primary_key}
        assert pk_columns == {"board_id"}

    async def test_a_second_binding_row_for_one_board_is_rejected(
        self, db_session: AsyncSession, test_board
    ):
        db_session.add(
            BoardLoopTemplateBinding(
                board_id=test_board.id,
                template_ref={"source": "system", "slug": "coding-loop"},
                version=1,
                slot_values={},
            )
        )
        await db_session.flush()
        db_session.add(
            BoardLoopTemplateBinding(
                board_id=test_board.id,
                template_ref={"source": "workspace", "slug": "other"},
                version=2,
                slot_values={},
            )
        )

        with pytest.raises(IntegrityError):
            await db_session.flush()


class TestDefaults:
    async def test_a_never_published_template_is_version_zero_with_null_content(
        self, db_session: AsyncSession, test_workspace: Workspace
    ):
        """0 means "never published" — the service distinguishes a draft-only
        template from v1 by this, so it must come from the column default
        rather than from any caller remembering to pass it."""
        template = _template(test_workspace)
        db_session.add(template)
        await db_session.flush()
        await db_session.refresh(template)

        assert template.version == 0
        assert template.content is None
        assert template.profile is None
        assert template.is_archived is False

    async def test_created_by_is_nulled_not_cascaded_when_the_author_leaves(
        self, db_session: AsyncSession, test_workspace: Workspace, second_user: User
    ):
        template = _template(test_workspace, created_by_id=second_user.id)
        db_session.add(template)
        await db_session.flush()
        template_id = template.id

        await db_session.execute(delete(User).where(User.id == second_user.id))
        await db_session.flush()
        db_session.expire_all()

        survivor = (
            await db_session.execute(
                select(ConfigTemplate).where(ConfigTemplate.id == template_id)
            )
        ).scalar_one()
        assert survivor.created_by_id is None
