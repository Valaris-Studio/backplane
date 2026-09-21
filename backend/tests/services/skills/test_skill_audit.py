# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import pytest
from sqlalchemy import select

from app.schemas.skills.skill import SkillCreate
from app.services.skills.skill_service import SkillService

FILES = [
    {
        "path": "SKILL.md",
        "content": "---\nname: Audit\ndescription: Audit skill\n---\nOriginal\n",
    }
]


async def test_skill_lifecycle_records_actor_and_idempotent_events(
    db_session, test_workspace, test_user
):
    from app.models.skills.skill import SkillAuditEvent

    service = SkillService(db_session)
    skill, _ = await service.get_or_create_skill(
        test_workspace.id, SkillCreate(slug="audit", files=FILES), test_user.id
    )
    await service.publish_version(test_workspace.id, "audit", 1, test_user.id)
    await service.publish_version(test_workspace.id, "audit", 1, test_user.id)
    await service.archive_skill(test_workspace.id, "audit", test_user.id)
    await service.archive_skill(test_workspace.id, "audit", test_user.id)
    await service.unarchive_skill(test_workspace.id, "audit", test_user.id)
    events = list(
        (
            await db_session.execute(
                select(SkillAuditEvent).where(SkillAuditEvent.skill_id == skill.id)
            )
        ).scalars()
    )
    assert sorted(e.event_type for e in events) == [
        "archived",
        "authored",
        "published",
        "unarchived",
    ]
    assert all(e.actor["user_id"] == str(test_user.id) for e in events)
    assert all("human" not in e.actor.values() for e in events)
    version = await service.get_version(test_workspace.id, "audit", 1)
    assert version.provenance["user_id"] == str(test_user.id)
    assert version.files == FILES


async def test_audit_failure_rolls_back_revision_and_skill(
    db_session, test_workspace, test_user, monkeypatch
):
    from app.models.skills.skill import Skill, SkillAuditEvent, SkillVersion
    from app.repositories.skills.skill import SkillAuditEventRepository

    await db_session.commit()

    async def fail(*args, **kwargs):
        raise RuntimeError("audit unavailable")

    monkeypatch.setattr(SkillAuditEventRepository, "create", fail)
    with pytest.raises(RuntimeError, match="audit unavailable"):
        async with db_session.begin():
            await SkillService(db_session).get_or_create_skill(
                test_workspace.id, SkillCreate(slug="audit", files=FILES), test_user.id
            )
    for model in (Skill, SkillVersion, SkillAuditEvent):
        assert list((await db_session.execute(select(model))).scalars()) == []


async def test_catalog_records_authorship_and_publication_once(
    db_session, test_workspace, test_user
):
    from app.models.skills.skill import SkillAuditEvent
    from app.services.skills.catalog import SKILL_CATALOG

    service = SkillService(db_session)
    catalog_id = SKILL_CATALOG[0].catalog_id
    skill, created = await service.activate_catalog(
        test_workspace.id, catalog_id, test_user.id
    )
    assert created
    _, repeated = await service.activate_catalog(
        test_workspace.id, catalog_id, test_user.id
    )
    assert not repeated
    events = list(
        (
            await db_session.execute(
                select(SkillAuditEvent).where(SkillAuditEvent.skill_id == skill.id)
            )
        ).scalars()
    )
    assert sorted(e.event_type for e in events) == ["authored", "published"]
    assert all(e.actor["user_id"] == str(test_user.id) for e in events)
    version = await service.get_version(test_workspace.id, catalog_id, 1)
    assert version.provenance["user_id"] == str(test_user.id)
