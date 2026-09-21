# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from copy import deepcopy
from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from sqlalchemy import delete, select
from sqlalchemy.orm import selectinload

from app import models
from app.models.skills.skill import Skill
from app.models.user import User
from app.repositories.skills.skill import SkillVersionRepository


async def _skill(db_session, workspace, slug="revision-history"):
    skill = Skill(workspace_id=workspace.id, slug=slug, name=slug)
    db_session.add(skill)
    await db_session.flush()
    return skill


async def _version(db_session, skill, number=1, **kwargs):
    return await SkillVersionRepository(db_session).create(
        skill_id=skill.id,
        version=number,
        files=[{"path": "SKILL.md", "content": "Original"}],
        content_hash="a" * 64,
        status="draft",
        **kwargs,
    )


async def test_legacy_revision_provenance_remains_unknown(db_session, test_workspace):
    revision = await _version(db_session, await _skill(db_session, test_workspace))
    assert revision.base_version is None
    assert revision.reason is None
    assert revision.provenance is None
    for field in ("source_board_id", "source_card_id", "source_execution_id", "delegation_id"):
        assert getattr(revision, field) is None
    assert models.SkillAuditEvent.__tablename__ == "skill_audit_events"


@pytest.mark.parametrize(
    ("field", "replacement"),
    [
        ("files", [{"path": "SKILL.md", "content": "Rewritten"}]),
        ("content_hash", "b" * 64),
        ("base_version", 7),
        ("reason", "Rewritten reason"),
        ("provenance", {"source": "fabricated"}),
        ("version", 7),
        ("skill_id", uuid.uuid4()),
        ("created_by_user_id", uuid.uuid4()),
        ("source_board_id", uuid.uuid4()),
        ("source_card_id", uuid.uuid4()),
        ("source_execution_id", uuid.uuid4()),
        ("delegation_id", uuid.uuid4()),
        ("created_by_agent_id", uuid.uuid4()),
        ("id", uuid.uuid4()),
        ("created_at", datetime(2000, 1, 1)),
        ("updated_at", datetime(2000, 1, 1)),
    ],
)
async def test_revision_repository_rejects_immutable_updates(
    db_session, test_workspace, field, replacement
):
    revision = await _version(db_session, await _skill(db_session, test_workspace))
    original = deepcopy(getattr(revision, field))
    with pytest.raises(ValueError, match="immutable"):
        await SkillVersionRepository(db_session).update(revision, **{field: replacement})
    assert getattr(revision, field) == original


async def test_revision_direct_orm_update_rejects_content_rewrite(db_session, test_workspace):
    revision = await _version(db_session, await _skill(db_session, test_workspace))
    revision.files = [{"path": "SKILL.md", "content": "Tampered"}]
    with pytest.raises(ValueError, match="immutable"):
        await db_session.flush()


@pytest.mark.parametrize("operation", ["delete", "delete_by_id", "orm_delete"])
async def test_revision_cannot_be_deleted(db_session, test_workspace, operation):
    revision = await _version(db_session, await _skill(db_session, test_workspace))
    repository = SkillVersionRepository(db_session)
    with pytest.raises(ValueError, match="immutable"):
        if operation == "delete":
            await repository.delete(revision)
        elif operation == "delete_by_id":
            await repository.delete_by_id(revision.id)
        else:
            await db_session.delete(revision)
            await db_session.flush()


async def test_skill_delete_with_loaded_versions_keeps_tenant_cascade(db_session, test_workspace):
    skill = await _skill(db_session, test_workspace)
    await _version(db_session, skill)
    await db_session.scalar(select(Skill).where(Skill.id == skill.id).options(selectinload(Skill.versions)))
    await db_session.delete(skill)
    await db_session.flush()
    assert await SkillVersionRepository(db_session).list_history(skill.id) == []


async def test_revision_lifecycle_updates_preserve_snapshot(db_session, test_workspace):
    provenance = {"actor": {"user_id": str(uuid.uuid4()), "user_name": "Original name"}}
    revision = await _version(
        db_session, await _skill(db_session, test_workspace), 2,
        base_version=1, reason="Clarify installation", provenance=provenance,
    )
    approval_id = uuid.uuid4()
    await SkillVersionRepository(db_session).update(
        revision, status="proposed", approval_id=approval_id
    )
    assert revision.status == "proposed"
    assert revision.approval_id == approval_id
    assert revision.base_version == 1
    assert revision.reason == "Clarify installation"
    assert revision.provenance == provenance


async def test_revision_history_uses_bounded_skill_scoped_cursor(db_session, test_workspace):
    skill = await _skill(db_session, test_workspace)
    other = await _skill(db_session, test_workspace, "other")
    for number in range(1, 5):
        await _version(db_session, skill, number)
    await _version(db_session, other, 8)
    repository = SkillVersionRepository(db_session)
    assert [row.version for row in await repository.list_history(skill.id, limit=2)] == [4, 3]
    assert [row.version for row in await repository.list_history(
        skill.id, limit=2, before_version=3
    )] == [2, 1]


async def test_audit_survives_identity_deletion_and_revision_status_change(
    db_session, test_workspace
):
    from app.repositories.skills.skill import SkillAuditEventRepository

    skill = await _skill(db_session, test_workspace)
    author = User(email="revision-author@example.test", name="Original author")
    db_session.add(author)
    await db_session.flush()
    actor = {"user_id": str(author.id), "user_name": author.name}
    revision = await _version(
        db_session, skill, created_by_user_id=author.id, provenance={"actor": actor}
    )
    audit = await SkillAuditEventRepository(db_session).create(
        skill_id=skill.id, version=1, event_type="revision_created", actor=actor,
        reason="Initial revision", details={"source": "workspace"},
    )
    await db_session.execute(delete(User).where(User.id == author.id))
    await db_session.refresh(revision)
    await SkillVersionRepository(db_session).update(revision, status="published")
    await db_session.refresh(audit)
    assert revision.created_by_user_id is None
    assert revision.provenance == {"actor": actor}
    assert audit.actor == actor
    assert audit.created_at is not None
    assert audit.reason == "Initial revision"


async def test_audit_pagination_ties_and_cross_skill_cursors(db_session, test_workspace):
    from app.repositories.skills.skill import SkillAuditEventRepository

    repository = SkillAuditEventRepository(db_session)
    skill = await _skill(db_session, test_workspace)
    other = await _skill(db_session, test_workspace, "other")
    same_time = datetime(2026, 9, 18)
    for number in (1, 2, 3):
        await repository.create(
            id=uuid.UUID(int=number), skill_id=skill.id,
            event_type="revision_created", created_at=same_time,
        )
    foreign = await repository.create(
        skill_id=other.id, event_type="revision_created", created_at=same_time
    )
    assert [row.id.int for row in await repository.list_history(skill.id, limit=2)] == [3, 2]
    assert [row.id.int for row in await repository.list_history(
        skill.id, limit=2, before_id=uuid.UUID(int=2)
    )] == [1]
    assert await repository.list_history(skill.id, before_id=foreign.id) == []


async def test_audit_creation_time_orders_events_within_same_transaction(db_session, test_workspace):
    from app.repositories.skills.skill import SkillAuditEventRepository

    skill = await _skill(db_session, test_workspace)
    repository = SkillAuditEventRepository(db_session)
    first_time = datetime(2026, 9, 18, 12, 30, 0, 123000, tzinfo=timezone.utc)
    second_time = first_time.replace(microsecond=124000)
    with patch("app.models.skills.skill.datetime", wraps=datetime) as clock:
        clock.now.side_effect = [first_time, second_time]
        first = await repository.create(
            id=uuid.UUID(int=2), skill_id=skill.id, event_type="created"
        )
        second = await repository.create(
            id=uuid.UUID(int=1), skill_id=skill.id, event_type="published"
        )
    assert first.created_at.replace(tzinfo=timezone.utc) == first_time
    assert second.created_at.replace(tzinfo=timezone.utc) == second_time
    assert [event.id for event in await repository.list_history(skill.id)] == [second.id, first.id]


@pytest.mark.parametrize("operation", ["update", "delete", "delete_by_id"])
async def test_audit_repository_rejects_mutation(db_session, test_workspace, operation):
    from app.repositories.skills.skill import SkillAuditEventRepository

    repository = SkillAuditEventRepository(db_session)
    skill = await _skill(db_session, test_workspace)
    audit = await repository.create(skill_id=skill.id, event_type="created")
    with pytest.raises(ValueError, match="append-only"):
        if operation == "update":
            await repository.update(audit, reason="rewrite")
        elif operation == "delete":
            await repository.delete(audit)
        else:
            await repository.delete_by_id(audit.id)
    assert await repository.get_by_id(audit.id) is audit


async def test_audit_direct_orm_update_is_rejected(db_session, test_workspace):
    from app.repositories.skills.skill import SkillAuditEventRepository

    skill = await _skill(db_session, test_workspace)
    audit = await SkillAuditEventRepository(db_session).create(
        skill_id=skill.id, event_type="created"
    )
    audit.event_type = "rewritten"
    with pytest.raises(ValueError, match="append-only"):
        await db_session.flush()


async def test_audit_direct_orm_delete_is_rejected(db_session, test_workspace):
    from app.repositories.skills.skill import SkillAuditEventRepository

    skill = await _skill(db_session, test_workspace)
    audit = await SkillAuditEventRepository(db_session).create(
        skill_id=skill.id, event_type="created"
    )
    await db_session.delete(audit)
    with pytest.raises(ValueError, match="append-only"):
        await db_session.flush()


@pytest.mark.parametrize("limit", [0, -1, 102])
async def test_history_rejects_unbounded_limits(db_session, test_workspace, limit):
    from app.repositories.skills.skill import SkillAuditEventRepository

    skill = await _skill(db_session, test_workspace)
    for repository in (SkillVersionRepository(db_session), SkillAuditEventRepository(db_session)):
        with pytest.raises(ValueError, match="limit"):
            await repository.list_history(skill.id, limit=limit)


async def test_revision_keeps_source_identity_after_board_deletion(
    db_session, test_workspace, test_board
):
    source_board_id = test_board.id
    revision = await _version(
        db_session, await _skill(db_session, test_workspace), source_board_id=source_board_id
    )
    await db_session.delete(test_board)
    await db_session.flush()
    await db_session.refresh(revision)
    assert revision.source_board_id == source_board_id


async def test_skill_deletion_cascades_audit(db_session, test_workspace):
    from app.models.skills.skill import SkillAuditEvent
    from app.repositories.skills.skill import SkillAuditEventRepository

    skill = await _skill(db_session, test_workspace)
    await SkillAuditEventRepository(db_session).create(skill_id=skill.id, event_type="created")
    await db_session.delete(skill)
    await db_session.flush()
    assert (await db_session.scalars(select(SkillAuditEvent))).all() == []
