# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""SkillService unit tests — RED phase for the Skills Registry (note f58cae0c).

Pins the pieces the router tests can't see directly: the content-hash
canonicalization, the frontmatter→row mirror, effective-set resolution
mechanics, and catalog-activation idempotency at the service layer.
"""

import hashlib
import json

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace


def _skill_md(name: str, description: str, body: str = "body\n") -> str:
    return f"---\nname: {name}\ndescription: {description}\n---\n\n{body}"


def _files(name: str = "Standup Notes", description: str = "How to run standup."):
    return [
        {"path": "SKILL.md", "content": _skill_md(name, description)},
        {"path": "references/example.md", "content": "example\n"},
    ]


def _as_dict(item):
    """Effective-set items may be schema objects or dicts — the contract is
    the fields, not the container."""
    return item if isinstance(item, dict) else item.model_dump()


# --- content hash ------------------------------------------------------------


def test_content_hash_matches_pinned_algorithm():
    from app.services.skills.skill_service import compute_content_hash

    files = _files()
    canonical = json.dumps(
        sorted(files, key=lambda f: f["path"]),
        sort_keys=True,
        separators=(",", ":"),
    )
    expected = hashlib.sha256(canonical.encode()).hexdigest()
    assert compute_content_hash(files) == expected


def test_content_hash_is_order_independent():
    from app.services.skills.skill_service import compute_content_hash

    files = _files()
    reversed_files = list(reversed(files))
    assert compute_content_hash(files) == compute_content_hash(reversed_files)


def test_content_hash_changes_with_content():
    from app.services.skills.skill_service import compute_content_hash

    files = _files()
    edited = [dict(f) for f in files]
    edited[1]["content"] = "different\n"
    assert compute_content_hash(files) != compute_content_hash(edited)


# --- frontmatter mirror ------------------------------------------------------


async def test_create_skill_mirrors_frontmatter_to_row(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    from app.schemas.skills.skill import SkillCreate
    from app.services.skills.skill_service import SkillService

    service = SkillService(db_session)
    skill = await service.create_skill(
        test_workspace.id,
        SkillCreate(slug="standup-notes", files=_files("Standup Notes", "How to run standup.")),
        test_user.id,
    )

    assert skill.slug == "standup-notes"
    assert skill.name == "Standup Notes"
    assert skill.description == "How to run standup."
    assert skill.workspace_id == test_workspace.id
    assert skill.latest_published_version is None
    assert skill.created_by == test_user.id


# --- effective-set resolution ------------------------------------------------


async def _seed_skill_rows(
    db: AsyncSession,
    workspace: Workspace,
    user: User,
    slug: str,
    version_statuses: list[str],
):
    """Skill + versions written straight through the models, so resolution is
    tested in isolation from the create/publish flows."""
    from app.models.skills.skill import Skill, SkillVersion
    from app.services.skills.skill_service import compute_content_hash

    published = [
        n for n, status in enumerate(version_statuses, start=1) if status == "published"
    ]
    skill = Skill(
        workspace_id=workspace.id,
        slug=slug,
        name=slug,
        description=f"{slug} description",
        latest_published_version=max(published) if published else None,
        created_by=user.id,
    )
    db.add(skill)
    await db.flush()
    for n, status in enumerate(version_statuses, start=1):
        files = [
            {
                "path": "SKILL.md",
                "content": _skill_md(slug, f"{slug} description", body=f"v{n}\n"),
            }
        ]
        db.add(
            SkillVersion(
                skill_id=skill.id,
                version=n,
                files=files,
                status=status,
                content_hash=compute_content_hash(files),
                created_by_user_id=user.id,
            )
        )
    await db.flush()
    return skill


async def _bind(db: AsyncSession, board: Board, skill, **kwargs):
    from app.models.skills.skill import BoardSkill

    binding = BoardSkill(board_id=board.id, skill_id=skill.id, **kwargs)
    db.add(binding)
    await db.flush()
    return binding


async def test_effective_set_resolution_rules(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    from app.services.skills.skill_service import SkillService

    # latest: v1+v2 published, v3 draft → resolves to 2.
    latest = await _seed_skill_rows(
        db_session, test_workspace, test_user, "latest", ["published", "published", "draft"]
    )
    await _bind(db_session, test_board, latest, enabled=True)
    # pinned: v2 is latest published, pin says 1 → pin wins.
    pinned = await _seed_skill_rows(
        db_session, test_workspace, test_user, "pinned", ["published", "published"]
    )
    await _bind(db_session, test_board, pinned, enabled=True, pinned_version=1)
    # disabled: published but switched off → excluded.
    disabled = await _seed_skill_rows(
        db_session, test_workspace, test_user, "disabled", ["published"]
    )
    await _bind(db_session, test_board, disabled, enabled=False)
    # unpublished: draft only, no pin → resolves to nothing → excluded.
    unpublished = await _seed_skill_rows(
        db_session, test_workspace, test_user, "unpublished", ["draft"]
    )
    await _bind(db_session, test_board, unpublished, enabled=True)

    service = SkillService(db_session)
    effective = {
        item["slug"]: item
        for item in (_as_dict(i) for i in await service.get_board_effective_skills(test_board.id))
    }

    assert set(effective) == {"latest", "pinned"}
    assert effective["latest"]["version"] == 2
    assert effective["pinned"]["version"] == 1
    assert effective["pinned"]["pinned_version"] == 1


async def test_effective_set_content_hash_matches_resolved_version(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    from app.models.skills.skill import SkillVersion
    from app.services.skills.skill_service import SkillService

    skill = await _seed_skill_rows(
        db_session, test_workspace, test_user, "hashed", ["published", "published"]
    )
    await _bind(db_session, test_board, skill, enabled=True, pinned_version=1)

    v1 = (
        await db_session.execute(
            select(SkillVersion).where(
                SkillVersion.skill_id == skill.id, SkillVersion.version == 1
            )
        )
    ).scalar_one()

    service = SkillService(db_session)
    items = [_as_dict(i) for i in await service.get_board_effective_skills(test_board.id)]
    assert len(items) == 1
    assert items[0]["content_hash"] == v1.content_hash


# --- catalog activation ------------------------------------------------------


async def test_activate_catalog_skill_idempotent_at_service_layer(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    from app.models.skills.skill import Skill
    from app.services.skills.catalog import SKILL_CATALOG
    from app.services.skills.skill_service import SkillService

    entry = SKILL_CATALOG[0]
    catalog_id = entry["catalog_id"] if isinstance(entry, dict) else entry.catalog_id

    service = SkillService(db_session)
    first = await service.activate_catalog_skill(
        test_workspace.id, catalog_id, test_user.id
    )
    again = await service.activate_catalog_skill(
        test_workspace.id, catalog_id, test_user.id
    )

    assert again.id == first.id
    assert first.latest_published_version == 1
    assert first.origin.startswith(f"catalog:{catalog_id}@")

    rows = (
        (
            await db_session.execute(
                select(Skill).where(Skill.workspace_id == test_workspace.id)
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1


async def test_activate_catalog_skill_unknown_id_raises(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    from app.exceptions import ResourceNotFoundError
    from app.services.skills.skill_service import SkillService

    service = SkillService(db_session)
    with pytest.raises(ResourceNotFoundError):
        await service.activate_catalog_skill(
            test_workspace.id, "not-a-catalog-entry", test_user.id
        )
