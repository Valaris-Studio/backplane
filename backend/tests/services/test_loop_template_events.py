# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Loop-template observability — config.changed + activity rows.

Card p2-05 (`1ebeb37f`). Template CRUD was silent: no WS event, no durable
trace. The frontend's `useLoopTemplateSync` (shipped in P1) already listens for
`config.changed {entity: "loop_template"}` and invalidates the whole template
key space — it was subscribing to an event nothing published. These tests pin
the publisher half of that contract.

Payload note: templates extend the four-publisher `{entity, action, entity_id}`
shape (tests/services/test_config_changed_payload.py) with `slug` and
`version`. The extra keys are additive — the frontend filter reads only
`entity` — and they let a future consumer show "which template moved" without
a round-trip. The action vocabulary is likewise wider than created/updated/
deleted because publish/archive/restore are distinct operator intents that a
flat "updated" would erase.
"""

import uuid
from datetime import datetime
from unittest.mock import AsyncMock, patch

from sqlalchemy import select
from sqlalchemy.exc import PendingRollbackError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.config_template import ConfigTemplate
from app.models.user import User
from app.models.workspace import Workspace
from app.services.activity import ActivityService
from app.services.loop_template import LoopTemplateService


def _event_type(call) -> str:
    return call.kwargs.get("event_type") or (call.args[0] if call.args else "")


def _payload(call) -> dict:
    return call.kwargs.get("payload") or (call.args[1] if len(call.args) > 1 else {})


def _config_changed_calls(mock_bus):
    return [
        c
        for c in mock_bus.publish.await_args_list
        if _event_type(c) == events.CONFIG_CHANGED
    ]


def _draft_payload(**overrides) -> dict:
    """Mirrors tests/services/test_loop_template_service.py's fixture.

    The off-switch tool is required by `validate_template`, so a payload that
    must reach a published state has to carry it.
    """
    payload = {
        "slug": "obs-loop",
        "name": "Observable loop",
        "profile": {"emoji": "🔁", "tagline": "A loop", "tags": ["custom"]},
        "content": {
            "system_prompt": "You are a careful agent.",
            "loop_prompt": "Do one thing.",
            "slots": [],
            "rails_defaults": {},
            "tools": ["mcp__valaris__set_board_loop"],
            "setup_contract": {},
            "derived_rails": {},
        },
    }
    payload.update(overrides)
    return payload


async def _activity_rows(db_session: AsyncSession, workspace: Workspace):
    result = await db_session.execute(
        select(Activity).where(Activity.workspace_id == workspace.id)
    )
    return list(result.scalars())


# --- config.changed -----------------------------------------------------------


async def test_create_draft_emits_config_changed(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)

    with patch("app.services.loop_template.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()
        row = await service.create_draft(
            test_workspace.id, actor_id=test_user.id, data=_draft_payload()
        )

        calls = _config_changed_calls(mock_bus)
        assert len(calls) == 1
        assert _payload(calls[0]) == {
            "entity": "loop_template",
            "action": "created",
            "entity_id": str(row.id),
            "slug": "obs-loop",
            # A brand-new draft has never been published; version 0 is the
            # signal that binding it would 422, not a missing field.
            "version": 0,
        }


async def test_publish_emits_config_changed_with_the_new_version(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """The published version is what a consumer needs — not the draft's."""
    service = LoopTemplateService(db_session)
    row = await service.create_draft(
        test_workspace.id, actor_id=test_user.id, data=_draft_payload()
    )

    with patch("app.services.loop_template.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()
        published = await service.publish(
            test_workspace.id, str(row.id), actor_id=test_user.id
        )

        calls = _config_changed_calls(mock_bus)
        assert len(calls) == 1
        payload = _payload(calls[0])
        assert payload["entity"] == "loop_template"
        assert payload["action"] == "published"
        assert payload["entity_id"] == str(row.id)
        assert payload["slug"] == "obs-loop"
        # Distinguishes "published" from "still a draft": a v0 here would mean
        # the event fired before the version bump landed.
        assert payload["version"] == 1 == published.version


async def test_archive_and_unarchive_emit_distinct_actions(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    row = await service.create_draft(
        test_workspace.id, actor_id=test_user.id, data=_draft_payload()
    )

    with patch("app.services.loop_template.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()
        await service.archive(test_workspace.id, str(row.id), actor_id=test_user.id)
        calls = _config_changed_calls(mock_bus)
        assert len(calls) == 1
        assert _payload(calls[0])["action"] == "archived"

    with patch("app.services.loop_template.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()
        await service.unarchive(test_workspace.id, str(row.id), actor_id=test_user.id)
        calls = _config_changed_calls(mock_bus)
        assert len(calls) == 1
        # Collapsing this into "archived" would leave the library unable to
        # tell a restore from a removal.
        assert _payload(calls[0])["action"] == "unarchived"


async def test_restore_reports_the_restored_snapshot_not_the_published_version(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """Restoring v1 while the row publishes at v2 must announce v1.

    Reporting `row.version` here would tell every consumer "v2 changed" when
    what actually happened is "the v1 snapshot is now staged as the draft" —
    the row's published half did not move at all.
    """
    service = LoopTemplateService(db_session)
    row = await service.create_draft(
        test_workspace.id, actor_id=test_user.id, data=_draft_payload()
    )
    await service.publish(test_workspace.id, str(row.id), actor_id=test_user.id)
    await service.update_draft(
        test_workspace.id,
        str(row.id),
        data={"name": "Second"},
        expected_updated_at=None,
    )
    published = await service.publish(
        test_workspace.id, str(row.id), actor_id=test_user.id
    )
    assert published.version == 2

    with patch("app.services.loop_template.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()
        await service.restore_version(
            test_workspace.id, str(row.id), 1, actor_id=test_user.id
        )

        calls = _config_changed_calls(mock_bus)
        assert len(calls) == 1
        payload = _payload(calls[0])
        assert payload["action"] == "restored"
        assert payload["version"] == 1


async def test_a_write_with_no_actor_still_publishes_but_records_no_activity(
    db_session: AsyncSession, test_workspace: Workspace
):
    """System-initiated writes have no actor, and the activity FK is NOT NULL.

    The bus event must still fire — cache invalidation does not depend on
    knowing who did it — but attempting the activity row would raise.
    """
    service = LoopTemplateService(db_session)

    with patch("app.services.loop_template.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()
        await service.create_draft(
            test_workspace.id, actor_id=None, data=_draft_payload()
        )
        assert len(_config_changed_calls(mock_bus)) == 1

    assert not [
        a
        for a in await _activity_rows(db_session, test_workspace)
        if a.entity_type == ActivityEntityType.loop_template
    ]


async def test_a_failed_publish_of_a_bus_event_does_not_break_the_write(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """Observability is best-effort — a dead bus must not lose the template."""
    service = LoopTemplateService(db_session)

    with patch("app.services.loop_template.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock(side_effect=RuntimeError("bus down"))
        row = await service.create_draft(
            test_workspace.id, actor_id=test_user.id, data=_draft_payload()
        )

    assert row.slug == "obs-loop"


# --- activity rows ------------------------------------------------------------


async def test_create_and_publish_write_activity_rows(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    row = await service.create_draft(
        test_workspace.id, actor_id=test_user.id, data=_draft_payload()
    )
    await service.publish(test_workspace.id, str(row.id), actor_id=test_user.id)

    rows = [
        a
        for a in await _activity_rows(db_session, test_workspace)
        if a.entity_type == ActivityEntityType.loop_template
    ]
    assert len(rows) == 2

    created, published = sorted(rows, key=lambda a: a.seq)
    assert created.action == ActivityAction.created
    assert created.entity_id == row.id
    assert published.action == ActivityAction.published
    # slug@version is what makes the timeline readable without a join.
    assert "obs-loop@v1" in published.summary


async def test_activity_actor_is_the_publisher_not_the_creator(
    db_session: AsyncSession,
    test_user: User,
    second_user: User,
    test_workspace: Workspace,
):
    """Who published is the audit question; inheriting the creator hides it."""
    other = second_user
    service = LoopTemplateService(db_session)
    row = await service.create_draft(
        test_workspace.id, actor_id=test_user.id, data=_draft_payload()
    )
    await service.publish(test_workspace.id, str(row.id), actor_id=other.id)

    rows = [
        a
        for a in await _activity_rows(db_session, test_workspace)
        if a.entity_type == ActivityEntityType.loop_template
        and a.action == ActivityAction.published
    ]
    assert len(rows) == 1
    assert rows[0].actor_id == other.id


# --- savepoint: a failed activity insert must not poison the write ------------
#
# Card B5. `_record_activity` swallows activity failures so observability can
# never lose the template — but swallowing a Python exception is not enough when
# the failure happened at the DATABASE. `ActivityRepository.record` FLUSHES, so a
# rejected row leaves the SQLAlchemy Session marked rollback-only: every later
# statement raises PendingRollbackError and `get_db`'s commit degrades to a
# rollback, silently discarding the template write the request was actually for.
# On asyncpg the same shape surfaces as InFailedSQLTransactionError.
#
# These tests assert the OUTCOME (the primary write survives a subsequent read
# AND a commit), not the Postgres error class — SQLite reproduces the poisoning
# at the Session layer, which is where the fix lives, but it does not raise
# InFailedSQLTransactionError. Do not "fix" these to expect that class.


def _poison_activity_insert(monkeypatch, db_session: AsyncSession):
    """Make the activity INSERT fail the way a real rejected row does.

    An `actor_id` pointing at no user violates the NOT-NULL-checked FK, so the
    repo's own `flush()` raises IntegrityError from inside the driver — the
    genuine article, not a synthetic `side_effect` that never reaches the DB.
    A mock that merely raised would be swallowed by today's bare `except` and
    the test would pass against the unfixed code.
    """
    from app.repositories.activity import ActivityRepository

    async def record_with_a_doomed_row(self, **kwargs):
        kwargs["actor_id"] = uuid.uuid4()  # no such user
        activity = Activity(created_at=datetime.utcnow(), **kwargs)
        self.db.add(activity)
        await self.db.flush()
        return activity

    monkeypatch.setattr(ActivityRepository, "record", record_with_a_doomed_row)


async def _session_is_usable(db_session: AsyncSession) -> bool:
    """A poisoned Session raises PendingRollbackError on the next statement."""
    try:
        await db_session.execute(select(Activity))
        return True
    except PendingRollbackError:
        return False


async def test_publish_survives_an_activity_row_the_database_rejects(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    monkeypatch,
):
    """AC1 — the version bump is still readable and the txn still commits."""
    service = LoopTemplateService(db_session)
    row = await service.create_draft(
        test_workspace.id, actor_id=test_user.id, data=_draft_payload()
    )
    template_id = row.id

    _poison_activity_insert(monkeypatch, db_session)
    published = await service.publish(
        test_workspace.id, str(template_id), actor_id=test_user.id
    )

    assert published.version == 1
    assert await _session_is_usable(db_session)

    # The commit is the real assertion: get_db commits at request end, and a
    # rollback-only session turns that into a silent discard of the publish.
    await db_session.commit()
    reread = await db_session.get(ConfigTemplate, template_id)
    assert reread is not None
    assert reread.version == 1


async def test_duplicate_survives_an_activity_row_the_database_rejects(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    monkeypatch,
):
    """AC2 — the copy row exists after the failed audit insert."""
    service = LoopTemplateService(db_session)
    source = await service.create_draft(
        test_workspace.id, actor_id=test_user.id, data=_draft_payload()
    )

    _poison_activity_insert(monkeypatch, db_session)
    copy = await service.duplicate(
        test_workspace.id, str(source.id), actor_id=test_user.id
    )
    copy_id = copy.id

    assert copy.slug == "obs-loop-copy"
    assert await _session_is_usable(db_session)

    await db_session.commit()
    reread = await db_session.get(ConfigTemplate, copy_id)
    assert reread is not None
    assert reread.slug == "obs-loop-copy"


async def test_the_rejected_activity_row_is_not_half_written(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    monkeypatch,
):
    """AC4 — the savepoint rolls the failed insert back; nothing pretends it worked.

    Without this, a savepoint that swallowed too little (or a fix that made the
    insert succeed with a bogus actor) would look identical from AC1's angle.
    """
    service = LoopTemplateService(db_session)
    row = await service.create_draft(
        test_workspace.id, actor_id=test_user.id, data=_draft_payload()
    )

    before = len(await _activity_rows(db_session, test_workspace))
    _poison_activity_insert(monkeypatch, db_session)
    await service.publish(test_workspace.id, str(row.id), actor_id=test_user.id)
    await db_session.commit()

    assert len(await _activity_rows(db_session, test_workspace)) == before


async def test_a_dead_bus_still_does_not_roll_back_the_write(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    """AC6 — the bus publish keeps its own independent best-effort behavior.

    Distinct from the existing create_draft bus test: this one commits, proving
    a bus failure leaves the transaction committable rather than merely leaving
    the in-memory object populated.
    """
    service = LoopTemplateService(db_session)
    row = await service.create_draft(
        test_workspace.id, actor_id=test_user.id, data=_draft_payload()
    )
    template_id = row.id

    with patch("app.services.loop_template.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock(side_effect=RuntimeError("bus down"))
        published = await service.publish(
            test_workspace.id, str(template_id), actor_id=test_user.id
        )

    assert published.version == 1
    await db_session.commit()
    reread = await db_session.get(ConfigTemplate, template_id)
    assert reread.version == 1


async def test_an_activity_failure_AFTER_the_row_flushed_leaves_no_half_written_row(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    monkeypatch,
):
    """AC4, the case that distinguishes WHERE the savepoint sits.

    `ActivityService.record` keeps working after the repo flushes — entity-title
    resolution, notification generation, event emission — so a failure can land
    with the row already written. Only a savepoint whose `__aexit__` SEES the
    exception rolls that row back.

    Put the savepoint OUTSIDE the try (so the `except` swallows inside it) and
    `__aexit__` exits cleanly, RELEASEing the savepoint: the half-written audit
    row survives a record() that failed. The publish-path tests cannot catch
    that — their injected failure happens AT the flush, where the session is
    already rollback-only and either shape discards the row. This one can.
    """
    service = LoopTemplateService(db_session)
    row = await service.create_draft(
        test_workspace.id, actor_id=test_user.id, data=_draft_payload()
    )
    before = len(await _activity_rows(db_session, test_workspace))

    real_record = ActivityService.record

    async def record_then_fail(self, **kwargs):
        await real_record(self, **kwargs)
        # Not a DB error: the row is already flushed and the session is healthy.
        raise RuntimeError("notification fan-out blew up after the insert")

    monkeypatch.setattr(ActivityService, "record", record_then_fail)
    published = await service.publish(
        test_workspace.id, str(row.id), actor_id=test_user.id
    )

    assert published.version == 1
    await db_session.commit()
    assert len(await _activity_rows(db_session, test_workspace)) == before
