# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Repository-level tests for the config-template tables.

Pure data access — no service orchestration, no authorization. The service
layer (p1-02) owns publish rules, slug generation and admin gating; everything
asserted here is a query or a write the repository must get right on its own.
"""

from __future__ import annotations

import re

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.config_template import BoardLoopTemplateBinding, ConfigTemplate
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace
from app.repositories.config_template import (
    BoardLoopTemplateBindingRepository,
    ConfigTemplateRepository,
)


async def _make_workspace(db: AsyncSession, owner: User, slug: str) -> Workspace:
    workspace = Workspace(name=slug, slug=slug, created_by=owner.id)
    db.add(workspace)
    await db.flush()
    return workspace


async def _make_template(
    repo: ConfigTemplateRepository,
    workspace: Workspace,
    slug: str = "coding-loop",
    *,
    kind: str = "loop",
    name: str | None = None,
    is_archived: bool = False,
) -> ConfigTemplate:
    return await repo.create(
        workspace_id=workspace.id,
        kind=kind,
        slug=slug,
        name=name or slug.replace("-", " ").title(),
        draft_profile={},
        draft_content={},
        is_archived=is_archived,
    )


@pytest.fixture
def repo(db_session: AsyncSession) -> ConfigTemplateRepository:
    return ConfigTemplateRepository(db_session)


@pytest.fixture
def binding_repo(db_session: AsyncSession) -> BoardLoopTemplateBindingRepository:
    return BoardLoopTemplateBindingRepository(db_session)


@pytest_asyncio.fixture
async def other_board(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
) -> Board:
    """A second board in the same workspace — the control that makes
    per-board scoping falsifiable."""
    board = Board(
        workspace_id=test_workspace.id,
        name="Other Board",
        slug="other-board",
        created_by=test_user.id,
    )
    db_session.add(board)
    await db_session.flush()
    return board


class TestGetBySlug:
    async def test_finds_a_template_in_its_own_workspace_and_kind(
        self, repo: ConfigTemplateRepository, test_workspace: Workspace
    ):
        created = await _make_template(repo, test_workspace)

        found = await repo.get_by_slug(test_workspace.id, "loop", "coding-loop")

        assert found is not None
        assert found.id == created.id

    async def test_does_not_cross_the_workspace_boundary(
        self,
        repo: ConfigTemplateRepository,
        db_session: AsyncSession,
        test_workspace: Workspace,
        test_user: User,
    ):
        await _make_template(repo, test_workspace)
        other = await _make_workspace(db_session, test_user, "other-ws")

        assert await repo.get_by_slug(other.id, "loop", "coding-loop") is None

    async def test_does_not_cross_the_kind_boundary(
        self, repo: ConfigTemplateRepository, test_workspace: Workspace
    ):
        """Loops and pipelines are different runner features — a pipeline
        template must never answer a loop lookup."""
        await _make_template(repo, test_workspace, kind="pipeline")

        assert await repo.get_by_slug(test_workspace.id, "loop", "coding-loop") is None

    async def test_returns_none_for_an_unknown_slug(
        self, repo: ConfigTemplateRepository, test_workspace: Workspace
    ):
        assert await repo.get_by_slug(test_workspace.id, "loop", "nope") is None


class TestListByWorkspace:
    async def test_lists_only_the_requested_workspace(
        self,
        repo: ConfigTemplateRepository,
        db_session: AsyncSession,
        test_workspace: Workspace,
        test_user: User,
    ):
        await _make_template(repo, test_workspace, "mine")
        other = await _make_workspace(db_session, test_user, "other-ws")
        await _make_template(repo, other, "theirs")

        rows = await repo.list_by_workspace(test_workspace.id, kind="loop")

        assert [t.slug for t in rows] == ["mine"]

    async def test_lists_only_the_requested_kind(
        self, repo: ConfigTemplateRepository, test_workspace: Workspace
    ):
        await _make_template(repo, test_workspace, "a-loop", kind="loop")
        await _make_template(repo, test_workspace, "a-pipeline", kind="pipeline")

        rows = await repo.list_by_workspace(test_workspace.id, kind="pipeline")

        assert [t.slug for t in rows] == ["a-pipeline"]

    async def test_hides_archived_templates_by_default(
        self, repo: ConfigTemplateRepository, test_workspace: Workspace
    ):
        await _make_template(repo, test_workspace, "live")
        await _make_template(repo, test_workspace, "retired", is_archived=True)

        rows = await repo.list_by_workspace(test_workspace.id, kind="loop")

        assert [t.slug for t in rows] == ["live"]

    async def test_includes_archived_when_asked(
        self, repo: ConfigTemplateRepository, test_workspace: Workspace
    ):
        await _make_template(repo, test_workspace, "live")
        await _make_template(repo, test_workspace, "retired", is_archived=True)

        rows = await repo.list_by_workspace(
            test_workspace.id, kind="loop", include_archived=True
        )

        assert {t.slug for t in rows} == {"live", "retired"}

    async def test_search_matches_name_case_insensitively(
        self, repo: ConfigTemplateRepository, test_workspace: Workspace
    ):
        await _make_template(repo, test_workspace, "a", name="Coding Loop")
        await _make_template(repo, test_workspace, "b", name="Triage Sweep")

        rows = await repo.list_by_workspace(test_workspace.id, kind="loop", q="cODiNg")

        assert [t.name for t in rows] == ["Coding Loop"]

    def test_search_is_case_insensitive_on_postgres_too(self):
        """SQLite's LIKE already ignores ASCII case, so the query above passes
        against `like` as readily as `ilike` — it cannot tell prod's behaviour
        apart. PostgreSQL's LIKE *is* case-sensitive, so the guarantee has to
        be asserted where prod enforces it: in the SQL compiled for the
        postgresql dialect, where `ilike` emits ILIKE and `like` emits LIKE.
        """
        compiled = str(
            ConfigTemplateRepository.build_search_filter("cODiNg").compile(
                dialect=postgresql.dialect()
            )
        )

        # Both halves of the OR, or a pasted slug would lose case-insensitivity
        # while a typed name kept it.
        assert compiled.count("ILIKE") == 2
        assert not re.search(r"(?<!I)LIKE", compiled)

    async def test_search_also_matches_the_slug(
        self, repo: ConfigTemplateRepository, test_workspace: Workspace
    ):
        """Operators paste slugs as often as they type names; matching only
        `name` would make a pasted slug return nothing."""
        await _make_template(repo, test_workspace, "nightly-sweep", name="Zeta")
        await _make_template(repo, test_workspace, "other", name="Alpha")

        rows = await repo.list_by_workspace(test_workspace.id, kind="loop", q="nightly")

        assert [t.slug for t in rows] == ["nightly-sweep"]

    async def test_defaults_to_name_ordering(
        self, repo: ConfigTemplateRepository, test_workspace: Workspace
    ):
        await _make_template(repo, test_workspace, "z", name="Zeta")
        await _make_template(repo, test_workspace, "a", name="Alpha")
        await _make_template(repo, test_workspace, "m", name="Mu")

        rows = await repo.list_by_workspace(test_workspace.id, kind="loop")

        assert [t.name for t in rows] == ["Alpha", "Mu", "Zeta"]

    async def test_can_sort_by_most_recently_updated(
        self,
        repo: ConfigTemplateRepository,
        db_session: AsyncSession,
        test_workspace: Workspace,
    ):
        """`updated_at` has second resolution on the SQLite test DB, so the
        ordering is pinned through an explicit, distinct draft stamp rather
        than through wall-clock writes that would tie."""
        from datetime import datetime

        old = await _make_template(repo, test_workspace, "old", name="Alpha")
        recent = await _make_template(repo, test_workspace, "recent", name="Zeta")
        await repo.update(old, draft_updated_at=datetime(2026, 1, 1))
        await repo.update(recent, draft_updated_at=datetime(2026, 6, 1))

        rows = await repo.list_by_workspace(
            test_workspace.id, kind="loop", sort="recent"
        )

        assert [t.slug for t in rows] == ["recent", "old"]


class TestUpdate:
    async def test_refreshes_the_instance_after_flush(
        self, repo: ConfigTemplateRepository, test_workspace: Workspace
    ):
        """`refresh()` after `flush()` is the house rule — without it the
        `onupdate` timestamp raises MissingGreenlet on first access."""
        template = await _make_template(repo, test_workspace)

        updated = await repo.update(template, name="Renamed")

        assert updated.name == "Renamed"
        assert updated.updated_at is not None

    async def test_persists_the_change(
        self,
        repo: ConfigTemplateRepository,
        db_session: AsyncSession,
        test_workspace: Workspace,
    ):
        template = await _make_template(repo, test_workspace)
        await repo.update(template, is_archived=True)

        # Read the column back through a fresh SELECT rather than the
        # identity-mapped instance: an in-memory attribute would pass even if
        # the flush never reached the database.
        stored = (
            await db_session.execute(
                select(ConfigTemplate.is_archived).where(
                    ConfigTemplate.id == template.id
                )
            )
        ).scalar_one()

        assert stored is True


class TestVersions:
    async def test_add_version_stores_the_snapshot(
        self, repo: ConfigTemplateRepository, test_workspace: Workspace
    ):
        template = await _make_template(repo, test_workspace)

        version = await repo.add_version(
            template.id, version=1, profile={"slots": []}, content={"system": "hi"}
        )

        assert version.template_id == template.id
        assert version.version == 1
        assert version.content == {"system": "hi"}

    async def test_list_versions_is_newest_first(
        self, repo: ConfigTemplateRepository, test_workspace: Workspace
    ):
        template = await _make_template(repo, test_workspace)
        for n in (1, 2, 3):
            await repo.add_version(template.id, version=n, profile={}, content={})

        rows = await repo.list_versions(template.id)

        assert [v.version for v in rows] == [3, 2, 1]

    async def test_list_versions_is_scoped_to_its_template(
        self, repo: ConfigTemplateRepository, test_workspace: Workspace
    ):
        mine = await _make_template(repo, test_workspace, "mine")
        theirs = await _make_template(repo, test_workspace, "theirs")
        await repo.add_version(mine.id, version=1, profile={}, content={})
        await repo.add_version(theirs.id, version=1, profile={}, content={})

        rows = await repo.list_versions(mine.id)

        assert [v.template_id for v in rows] == [mine.id]

    async def test_get_version_selects_the_requested_one(
        self, repo: ConfigTemplateRepository, test_workspace: Workspace
    ):
        template = await _make_template(repo, test_workspace)
        await repo.add_version(
            template.id, version=1, profile={}, content={"system": "v1"}
        )
        await repo.add_version(
            template.id, version=2, profile={}, content={"system": "v2"}
        )

        found = await repo.get_version(template.id, 1)

        assert found is not None
        assert found.content == {"system": "v1"}

    async def test_get_version_does_not_cross_templates(
        self, repo: ConfigTemplateRepository, test_workspace: Workspace
    ):
        mine = await _make_template(repo, test_workspace, "mine")
        theirs = await _make_template(repo, test_workspace, "theirs")
        await repo.add_version(theirs.id, version=7, profile={}, content={})

        assert await repo.get_version(mine.id, 7) is None

    async def test_get_version_returns_none_when_unpublished(
        self, repo: ConfigTemplateRepository, test_workspace: Workspace
    ):
        template = await _make_template(repo, test_workspace)

        assert await repo.get_version(template.id, 1) is None


class TestBindingRepository:
    """Every assertion that names a board also needs a SECOND bound board.

    With one board in the fixture set, `where(board_id == ...)` is
    indistinguishable from no filter at all: a `get_by_board` that ignored its
    argument and a `delete_for_board` that truncated the table both passed the
    single-board tests. The `other_board` fixture is what makes those two
    queries falsifiable.
    """

    async def test_get_by_board_is_none_before_any_bind(
        self, binding_repo: BoardLoopTemplateBindingRepository, test_board
    ):
        assert await binding_repo.get_by_board(test_board.id) is None

    async def test_upsert_creates_the_first_binding(
        self, binding_repo: BoardLoopTemplateBindingRepository, test_board
    ):
        binding = await binding_repo.upsert(
            test_board.id,
            template_ref={"source": "system", "slug": "coding-loop"},
            version=1,
            slot_values={"REPO": "acme"},
            rendered_hash="a" * 64,
        )

        assert binding.board_id == test_board.id
        assert binding.version == 1
        assert binding.slot_values == {"REPO": "acme"}

    async def test_a_second_upsert_updates_in_place(
        self,
        binding_repo: BoardLoopTemplateBindingRepository,
        db_session: AsyncSession,
        test_board,
    ):
        """One row per board: rebinding must overwrite, never accumulate — the
        board_id PK would otherwise turn a rebind into an IntegrityError."""
        await binding_repo.upsert(
            test_board.id,
            template_ref={"source": "system", "slug": "coding-loop"},
            version=1,
            slot_values={"REPO": "acme"},
            rendered_hash="a" * 64,
        )

        await binding_repo.upsert(
            test_board.id,
            template_ref={"source": "workspace", "slug": "nightly"},
            version=4,
            slot_values={"REPO": "beta"},
            rendered_hash="b" * 64,
        )

        rows = (
            (
                await db_session.execute(
                    select(BoardLoopTemplateBinding).where(
                        BoardLoopTemplateBinding.board_id == test_board.id
                    )
                )
            )
            .scalars()
            .all()
        )
        assert len(rows) == 1
        assert rows[0].version == 4
        assert rows[0].template_ref == {"source": "workspace", "slug": "nightly"}
        assert rows[0].slot_values == {"REPO": "beta"}
        assert rows[0].rendered_hash == "b" * 64

    async def test_upsert_returns_the_stored_row_on_rebind(
        self, binding_repo: BoardLoopTemplateBindingRepository, test_board
    ):
        await binding_repo.upsert(
            test_board.id,
            template_ref={"source": "system", "slug": "coding-loop"},
            version=1,
            slot_values={},
        )

        rebound = await binding_repo.upsert(
            test_board.id,
            template_ref={"source": "system", "slug": "coding-loop"},
            version=2,
            slot_values={},
        )

        assert rebound.version == 2

    async def test_delete_removes_the_binding(
        self, binding_repo: BoardLoopTemplateBindingRepository, test_board
    ):
        await binding_repo.upsert(
            test_board.id,
            template_ref={"source": "system", "slug": "coding-loop"},
            version=1,
            slot_values={},
        )

        await binding_repo.delete_for_board(test_board.id)

        assert await binding_repo.get_by_board(test_board.id) is None

    async def test_delete_is_idempotent(
        self, binding_repo: BoardLoopTemplateBindingRepository, test_board
    ):
        """Detaching an already-detached board is a retry, not an error —
        the house idempotency rule for agent callers."""
        await binding_repo.delete_for_board(test_board.id)
        await binding_repo.delete_for_board(test_board.id)

        assert await binding_repo.get_by_board(test_board.id) is None

    async def test_get_by_board_does_not_return_another_boards_binding(
        self,
        binding_repo: BoardLoopTemplateBindingRepository,
        test_board,
        other_board: Board,
    ):
        await binding_repo.upsert(
            other_board.id,
            template_ref={"source": "system", "slug": "theirs"},
            version=9,
            slot_values={},
        )

        assert await binding_repo.get_by_board(test_board.id) is None

    async def test_delete_leaves_other_boards_bindings_alone(
        self,
        binding_repo: BoardLoopTemplateBindingRepository,
        test_board,
        other_board: Board,
    ):
        await binding_repo.upsert(
            test_board.id,
            template_ref={"source": "system", "slug": "mine"},
            version=1,
            slot_values={},
        )
        await binding_repo.upsert(
            other_board.id,
            template_ref={"source": "system", "slug": "theirs"},
            version=9,
            slot_values={},
        )

        await binding_repo.delete_for_board(test_board.id)

        survivor = await binding_repo.get_by_board(other_board.id)
        assert survivor is not None
        assert survivor.version == 9
