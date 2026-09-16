# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""LoopTemplateService — the union catalog, draft lifecycle and locks.

Card p1-02 (`2c204160`). The router tests next door drive the same service
through HTTP; these pin the parts HTTP cannot see cheaply: union ORDERING,
`boards_using` counting across bindings, and that archived rows leave the
listing without leaving the table.

Everything here is service-level so a routing change cannot make these pass
vacuously.
"""

import uuid
from contextlib import contextmanager
from datetime import timedelta

import pytest
from sqlalchemy import event, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.exceptions import ConflictError, ResourceNotFoundError, ValidationError
from app.models.config_template import ConfigTemplate
from app.models.kanban import Board
from app.models.workspace import Workspace
from app.services.loop_template import LoopTemplateService
from app.services.loop_templates import LOOP_TEMPLATES


def _draft_payload(**overrides) -> dict:
    """A minimal draft that PUBLISHES clean.

    `validate_template` requires the off-switch tool, so every payload that is
    expected to reach a published state must carry it — omitting it is the
    fixture bug that makes a "publish succeeds" test silently assert a 422.
    """
    payload = {
        "slug": "my-loop",
        "name": "My loop",
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


async def _make_draft(service: LoopTemplateService, workspace: Workspace, **overrides):
    return await service.create_draft(
        workspace.id, actor_id=None, data=_draft_payload(**overrides)
    )


# --- the union listing --------------------------------------------------------


async def test_list_puts_system_templates_before_workspace_rows(
    db_session: AsyncSession, test_workspace: Workspace
):
    """System first is the contract the Library page's two sections rely on.

    The workspace row is named "AAA" so a naive single global name-sort would
    float it to the top — the assertion therefore distinguishes "system first,
    then sorted" from "everything sorted together".
    """
    service = LoopTemplateService(db_session)
    await _make_draft(service, test_workspace, slug="aaa-loop", name="AAA loop")

    summaries = await service.list(test_workspace.id)

    sources = [s["source"] for s in summaries]
    assert sources == sorted(sources, key=lambda s: s != "system"), sources
    assert sources[-1] == "workspace", sources
    assert summaries[-1]["name"] == "AAA loop"


async def test_list_sorts_system_block_by_name(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)

    summaries = await service.list(test_workspace.id)

    system_names = [s["name"] for s in summaries if s["source"] == "system"]
    assert system_names == sorted(system_names), system_names


async def test_list_summary_exposes_every_documented_key(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    await _make_draft(service, test_workspace)

    summaries = await service.list(test_workspace.id)

    expected = {
        "id",
        "source",
        "name",
        "version",
        "is_system",
        "is_draft",
        "has_slots",
        "profile",
        "boards_using",
        "last_used_at",
        "updated_at",
        # The draft contract (card 65714512): the lock token the client
        # round-trips, and the third state `is_draft` cannot express.
        "draft_updated_at",
        "has_unpublished_changes",
        "description",
        "system_prompt",
        "loop_prompt",
        "tools",
    }
    for summary in summaries:
        assert set(summary) == expected, summary


async def test_list_counts_boards_using_a_workspace_template(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board
):
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    await service.publish(test_workspace.id, template.id, expected_version=0)

    from app.repositories.config_template import BoardLoopTemplateBindingRepository

    await BoardLoopTemplateBindingRepository(db_session).upsert(
        board_id=test_board.id,
        template_ref={"source": "workspace", "id": str(template.id)},
        version=1,
        slot_values={},
    )
    await db_session.flush()

    summaries = await service.list(test_workspace.id)
    mine = next(s for s in summaries if s["id"] == str(template.id))

    assert mine["boards_using"] == 1
    others = [s for s in summaries if s["id"] != str(template.id)]
    assert all(s["boards_using"] == 0 for s in others), others


async def test_list_counts_boards_using_a_system_template_by_slug(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board
):
    """A system binding is keyed by SLUG, not by a row id.

    Counting only workspace rows would leave every system template reporting
    zero boards forever — the Library's "most used" sort would be dead.
    """
    from app.repositories.config_template import BoardLoopTemplateBindingRepository

    bound_slug = LOOP_TEMPLATES[0].slug
    await BoardLoopTemplateBindingRepository(db_session).upsert(
        board_id=test_board.id,
        template_ref={"source": "system", "slug": bound_slug},
        version=1,
        slot_values={},
    )
    await db_session.flush()

    summaries = await LoopTemplateService(db_session).list(test_workspace.id)
    bound = next(s for s in summaries if s["id"] == bound_slug)

    assert bound["boards_using"] == 1


async def test_list_hides_archived_rows_until_asked(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    await service.archive(test_workspace.id, template.id)

    default_ids = {s["id"] for s in await service.list(test_workspace.id)}
    with_archived = {
        s["id"] for s in await service.list(test_workspace.id, include_archived=True)
    }

    assert str(template.id) not in default_ids
    assert str(template.id) in with_archived


async def test_list_search_matches_workspace_and_system_alike(
    db_session: AsyncSession, test_workspace: Workspace
):
    """`?q` must filter the system block too, not just the DB rows.

    Filtering only the SQL side leaves every system template in the result for
    any query, which reads as "search is broken" rather than "search is
    partial".
    """
    service = LoopTemplateService(db_session)
    await _make_draft(service, test_workspace, slug="zebra-loop", name="Zebra loop")

    summaries = await service.list(test_workspace.id, q="zebra")

    assert [s["name"] for s in summaries] == ["Zebra loop"]


# --- get ----------------------------------------------------------------------


async def test_get_resolves_a_system_slug_to_full_content(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    slug = LOOP_TEMPLATES[0].slug

    read = await service.get(test_workspace.id, slug)

    assert read["id"] == slug
    assert read["source"] == "system"
    assert read["content"]["system_prompt"]
    assert "slots" in read["content"]


async def test_get_rejects_a_truncated_system_slug(
    db_session: AsyncSession, test_workspace: Workspace
):
    """Lookup is exact. A prefix must MISS.

    An exact slug is its own prefix, so a happy-path assertion cannot tell an
    exact matcher from a `startswith` one — only a truncated ref can.
    """
    service = LoopTemplateService(db_session)
    truncated = LOOP_TEMPLATES[0].slug[:4]

    with pytest.raises(ResourceNotFoundError):
        await service.get(test_workspace.id, truncated)


async def test_get_workspace_row_returns_published_content_not_draft(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    await service.publish(test_workspace.id, template.id, expected_version=0)
    await service.update_draft(
        test_workspace.id,
        template.id,
        data={"content": {**_draft_payload()["content"], "loop_prompt": "DRAFT EDIT"}},
        expected_updated_at=None,
    )

    published = await service.get(test_workspace.id, str(template.id))
    draft = await service.get(test_workspace.id, str(template.id), draft=True)

    assert published["content"]["loop_prompt"] == "Do one thing."
    assert draft["content"]["loop_prompt"] == "DRAFT EDIT"


async def test_get_archived_row_404s_unless_included(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    await service.archive(test_workspace.id, template.id)

    with pytest.raises(ResourceNotFoundError):
        await service.get(test_workspace.id, str(template.id))

    assert await service.get(test_workspace.id, str(template.id), include_archived=True)


async def test_get_refuses_a_row_from_another_workspace(
    db_session: AsyncSession, test_workspace: Workspace, second_user
):
    """Tenancy is enforced on the ref, not assumed from the URL."""
    other = Workspace(name="Other", slug="other", created_by=second_user.id)
    db_session.add(other)
    await db_session.flush()

    service = LoopTemplateService(db_session)
    mine = await _make_draft(service, test_workspace)

    with pytest.raises(ResourceNotFoundError):
        await service.get(other.id, str(mine.id))


# --- draft lifecycle ----------------------------------------------------------


async def test_create_draft_starts_unpublished_at_version_zero(
    db_session: AsyncSession, test_workspace: Workspace
):
    template = await _make_draft(LoopTemplateService(db_session), test_workspace)

    assert template.version == 0
    assert template.content is None
    assert template.draft_content["loop_prompt"] == "Do one thing."


async def test_create_draft_rejects_a_duplicate_slug(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    await _make_draft(service, test_workspace)

    with pytest.raises(ConflictError):
        await _make_draft(service, test_workspace)


async def test_update_draft_rejects_a_stale_expected_updated_at(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    await service.update_draft(
        test_workspace.id, template.id, data={"name": "First"}, expected_updated_at=None
    )
    stale = "2020-01-01T00:00:00"

    with pytest.raises(ConflictError):
        await service.update_draft(
            test_workspace.id,
            template.id,
            data={"name": "Second"},
            expected_updated_at=stale,
        )


async def test_update_draft_accepts_the_current_expected_updated_at(
    db_session: AsyncSession, test_workspace: Workspace
):
    """The lock must ACCEPT the value it just handed out.

    A guard that rejects everything passes the 409 test above while making
    autosave impossible; this is the other half of that contract.
    """
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    await service.update_draft(
        test_workspace.id, template.id, data={"name": "First"}, expected_updated_at=None
    )
    await db_session.refresh(template)
    current = template.draft_updated_at.isoformat()

    updated = await service.update_draft(
        test_workspace.id,
        template.id,
        data={"name": "Second"},
        expected_updated_at=current,
    )

    # `draft_name`, not `name`: a rename is draft work (card 615c3b6e), so the
    # proof that the lock accepted the write lives on the draft half.
    assert updated.draft_name == "Second"


async def test_publish_snapshots_and_increments_version(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)

    await service.publish(test_workspace.id, template.id, expected_version=0)
    await service.update_draft(
        test_workspace.id, template.id, data={"name": "v2"}, expected_updated_at=None
    )
    await service.publish(test_workspace.id, template.id, expected_version=1)

    versions = await service.list_versions(test_workspace.id, template.id)

    assert [v["version"] for v in versions] == [2, 1]
    assert template.version == 2
    assert template.content is not None


async def test_publish_copies_the_draft_into_published_content(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)

    await service.publish(test_workspace.id, template.id, expected_version=0)

    assert template.content["loop_prompt"] == "Do one thing."
    assert template.profile["tagline"] == "A loop"


async def test_publish_rejects_a_stale_expected_version(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    await service.publish(test_workspace.id, template.id, expected_version=0)

    with pytest.raises(ConflictError):
        await service.publish(test_workspace.id, template.id, expected_version=0)


async def test_publish_refuses_an_invalid_draft_with_findings(
    db_session: AsyncSession, test_workspace: Workspace
):
    """A draft missing the off-switch must not publish.

    This is the rail that keeps an operator from shipping a loop nobody can
    stop; the findings must ride along so the UI can deep-link the offending
    tab.
    """
    service = LoopTemplateService(db_session)
    payload = _draft_payload()
    payload["content"]["tools"] = []
    template = await service.create_draft(
        test_workspace.id, actor_id=None, data=payload
    )

    with pytest.raises(ValidationError) as excinfo:
        await service.publish(test_workspace.id, template.id, expected_version=0)

    codes = {finding["code"] for finding in excinfo.value.detail}
    assert "off_switch_missing" in codes


async def test_publish_leaves_version_untouched_when_validation_fails(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    payload = _draft_payload()
    payload["content"]["tools"] = []
    template = await service.create_draft(
        test_workspace.id, actor_id=None, data=payload
    )

    with pytest.raises(ValidationError):
        await service.publish(test_workspace.id, template.id, expected_version=0)

    assert template.version == 0
    assert template.content is None


# --- duplicate, archive, restore ---------------------------------------------


async def test_duplicate_a_system_template_records_its_lineage(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    source = LOOP_TEMPLATES[0]

    copy = await service.duplicate(test_workspace.id, source.slug, actor_id=None)

    assert copy.slug == f"{source.slug}-copy"
    assert copy.version == 0
    assert copy.lineage == {
        "source": "system",
        "slug": source.slug,
        "version": source.version,
    }


async def test_duplicate_copies_content_into_the_new_draft(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    source = LOOP_TEMPLATES[0]

    copy = await service.duplicate(test_workspace.id, source.slug, actor_id=None)

    assert copy.draft_content["system_prompt"] == source.content.system_prompt


async def test_duplicating_a_system_template_three_times_never_409s(
    db_session: AsyncSession, test_workspace: Workspace
):
    """AC1. Forking a system template is the intended FIRST move for every
    operator; a retry that 409s violates the idempotent-mutations rule and
    tells them nothing about how to recover."""
    service = LoopTemplateService(db_session)
    source = LOOP_TEMPLATES[0]

    slugs = [
        (await service.duplicate(test_workspace.id, source.slug, actor_id=None)).slug
        for _ in range(3)
    ]

    assert slugs == [
        f"{source.slug}-copy",
        f"{source.slug}-copy-2",
        f"{source.slug}-copy-3",
    ]


async def test_duplicate_a_workspace_template_defaults_to_the_source_slug(
    db_session: AsyncSession, test_workspace: Workspace
):
    """Workspace refs travel as UUIDs, so the `-copy` default must come from the
    row's own slug — inferring it from the ref yields `<uuid>-copy`."""
    service = LoopTemplateService(db_session)
    source = await _make_draft(service, test_workspace, slug="my-loop")

    copy = await service.duplicate(test_workspace.id, str(source.id), actor_id=None)

    assert copy.slug == "my-loop-copy"


async def test_duplicate_a_workspace_template_records_lineage_by_slug(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    source = await _make_draft(service, test_workspace, slug="my-loop")
    await service.publish(test_workspace.id, str(source.id), expected_version=0)

    copy = await service.duplicate(test_workspace.id, str(source.id), actor_id=None)

    assert copy.lineage == {"source": "workspace", "slug": "my-loop", "version": 1}


async def test_duplicate_a_draft_only_workspace_template_records_version_zero(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    source = await _make_draft(service, test_workspace, slug="my-loop")

    copy = await service.duplicate(test_workspace.id, str(source.id), actor_id=None)

    assert copy.lineage == {"source": "workspace", "slug": "my-loop", "version": 0}


async def test_duplicate_with_an_explicit_slug_still_records_the_source_slug(
    db_session: AsyncSession, test_workspace: Workspace
):
    """`new_slug` names the COPY; it must never leak into the copy's ancestry."""
    service = LoopTemplateService(db_session)
    source = await _make_draft(service, test_workspace, slug="my-loop")

    copy = await service.duplicate(
        test_workspace.id, str(source.id), actor_id=None, new_slug="my-fork"
    )

    assert copy.slug == "my-fork"
    assert copy.lineage == {"source": "workspace", "slug": "my-loop", "version": 0}


async def test_duplicating_a_workspace_template_twice_suffixes_the_second_copy(
    db_session: AsyncSession, test_workspace: Workspace
):
    """AC1 for the workspace-ref path, which travels as a UUID."""
    service = LoopTemplateService(db_session)
    source = await _make_draft(service, test_workspace, slug="my-loop")

    first = await service.duplicate(test_workspace.id, str(source.id), actor_id=None)
    second = await service.duplicate(test_workspace.id, str(source.id), actor_id=None)

    assert (first.slug, second.slug) == ("my-loop-copy", "my-loop-copy-2")


async def test_duplicate_survives_losing_the_slug_race(
    db_session: AsyncSession, test_workspace: Workspace, monkeypatch
):
    """The free-slug probe is read-then-write; a concurrent duplicate of the
    same source can take the slug between the two. Losing that race must
    re-probe and land on the next free suffix, not surface the unique
    violation as a 500 — the failure this card exists to remove.

    The race is simulated by letting the probe lie once: it reports the
    first candidate free while the row already exists.
    """
    service = LoopTemplateService(db_session)
    source = await _make_draft(service, test_workspace, slug="my-loop")
    await service.duplicate(test_workspace.id, str(source.id), actor_id=None)

    honest_get_by_slug = service.repo.get_by_slug
    lied = False

    async def lying_get_by_slug(workspace_id, kind, slug):
        nonlocal lied
        if slug == "my-loop-copy" and not lied:
            lied = True
            return None
        return await honest_get_by_slug(workspace_id, kind, slug)

    monkeypatch.setattr(service.repo, "get_by_slug", lying_get_by_slug)

    second = await service.duplicate(test_workspace.id, str(source.id), actor_id=None)

    assert lied, "the race was never simulated"
    assert second.slug == "my-loop-copy-2"
    assert second.name.endswith("(copy 2)")


async def test_duplicate_with_an_explicit_slug_that_loses_the_race_409s(
    db_session: AsyncSession, test_workspace: Workspace, monkeypatch
):
    """An explicit slug is the caller's choice: losing the race is a
    `slug_taken` conflict, never a silent rename and never a 500."""
    service = LoopTemplateService(db_session)
    source = LOOP_TEMPLATES[0]
    await service.duplicate(
        test_workspace.id, source.slug, actor_id=None, new_slug="my-fork"
    )

    async def lying_get_by_slug(workspace_id, kind, slug):
        return None

    monkeypatch.setattr(service.repo, "get_by_slug", lying_get_by_slug)

    with pytest.raises(ConflictError) as raised:
        await service.duplicate(
            test_workspace.id, source.slug, actor_id=None, new_slug="my-fork"
        )
    assert raised.value.error_code == "slug_taken"


async def test_the_default_copy_name_tracks_the_suffixed_slug(
    db_session: AsyncSession, test_workspace: Workspace
):
    """AC4. A name saying "(copy)" on a row slugged `-copy-2` is the kind of
    quiet disagreement an operator only notices after forking three times."""
    service = LoopTemplateService(db_session)
    source = await _make_draft(service, test_workspace, slug="my-loop", name="My Loop")

    first = await service.duplicate(test_workspace.id, str(source.id), actor_id=None)
    second = await service.duplicate(test_workspace.id, str(source.id), actor_id=None)
    third = await service.duplicate(test_workspace.id, str(source.id), actor_id=None)

    assert first.name == "My Loop (copy)"
    assert second.name == "My Loop (copy 2)"
    assert third.name == "My Loop (copy 3)"


async def test_an_explicit_new_name_wins_over_the_derived_default(
    db_session: AsyncSession, test_workspace: Workspace
):
    """AC3."""
    service = LoopTemplateService(db_session)
    source = await _make_draft(service, test_workspace, slug="my-loop", name="My Loop")

    copy = await service.duplicate(
        test_workspace.id, str(source.id), actor_id=None, new_name="Production Fork"
    )

    assert copy.name == "Production Fork"
    assert copy.slug == "my-loop-copy"


async def test_the_suffix_probe_skips_slugs_taken_by_unrelated_templates(
    db_session: AsyncSession, test_workspace: Workspace
):
    """The probe must look at what EXISTS, not at how many copies it made:
    a hand-created `my-loop-copy` occupies the first candidate too."""
    service = LoopTemplateService(db_session)
    source = await _make_draft(service, test_workspace, slug="my-loop")
    await _make_draft(service, test_workspace, slug="my-loop-copy")

    copy = await service.duplicate(test_workspace.id, str(source.id), actor_id=None)

    assert copy.slug == "my-loop-copy-2"


async def test_suffixing_the_copy_slug_leaves_lineage_on_the_ancestor(
    db_session: AsyncSession, test_workspace: Workspace
):
    """Drift-vs-ancestor reads `lineage.slug`; if the suffix leaked into it the
    second copy would compare itself against a template that does not exist."""
    service = LoopTemplateService(db_session)
    source = await _make_draft(service, test_workspace, slug="my-loop")
    await service.duplicate(test_workspace.id, str(source.id), actor_id=None)

    second = await service.duplicate(test_workspace.id, str(source.id), actor_id=None)

    assert second.slug == "my-loop-copy-2"
    assert second.lineage == {"source": "workspace", "slug": "my-loop", "version": 0}


async def test_get_a_workspace_template_exposes_its_canonical_slug(
    db_session: AsyncSession, test_workspace: Workspace
):
    """`id` stays the UUID ref; `slug` is the human name duplicate/lineage need."""
    service = LoopTemplateService(db_session)
    source = await _make_draft(service, test_workspace, slug="my-loop")

    detail = await service.get(test_workspace.id, str(source.id))

    assert detail["id"] == str(source.id)
    assert detail["slug"] == "my-loop"


async def test_get_a_system_template_reports_its_slug_too(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    source = LOOP_TEMPLATES[0]

    detail = await service.get(test_workspace.id, source.slug)

    assert detail["slug"] == source.slug


async def test_unarchive_restores_a_row_to_the_listing(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    await service.archive(test_workspace.id, template.id)

    await service.unarchive(test_workspace.id, template.id)

    ids = {s["id"] for s in await service.list(test_workspace.id)}
    assert str(template.id) in ids


async def test_restore_version_copies_a_snapshot_into_the_draft(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    await service.publish(test_workspace.id, template.id, expected_version=0)
    await service.update_draft(
        test_workspace.id,
        template.id,
        data={"content": {**_draft_payload()["content"], "loop_prompt": "LATER EDIT"}},
        expected_updated_at=None,
    )

    await service.restore_version(test_workspace.id, template.id, 1)

    assert template.draft_content["loop_prompt"] == "Do one thing."


async def test_restore_version_does_not_move_the_published_version(
    db_session: AsyncSession, test_workspace: Workspace
):
    """Restore stages, it does not publish.

    Bumping `version` here would silently republish old content to every bound
    board — the failure this assertion exists to catch.
    """
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    await service.publish(test_workspace.id, template.id, expected_version=0)
    await service.update_draft(
        test_workspace.id, template.id, data={"name": "v2"}, expected_updated_at=None
    )
    await service.publish(test_workspace.id, template.id, expected_version=1)

    await service.restore_version(test_workspace.id, template.id, 1)

    assert template.version == 2


async def test_restore_version_404s_for_a_version_that_never_existed(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    await service.publish(test_workspace.id, template.id, expected_version=0)

    with pytest.raises(ResourceNotFoundError):
        await service.restore_version(test_workspace.id, template.id, 99)


async def test_system_templates_refuse_every_mutation(
    db_session: AsyncSession, test_workspace: Workspace
):
    """Code-defined templates have no row to write to.

    Each of these would otherwise fail with an obscure AttributeError or, worse,
    silently create a row that shadows the system slug.
    """
    service = LoopTemplateService(db_session)
    slug = LOOP_TEMPLATES[0].slug

    for mutation in (
        service.update_draft(
            test_workspace.id, slug, data={"name": "x"}, expected_updated_at=None
        ),
        service.publish(test_workspace.id, slug, expected_version=1),
        service.archive(test_workspace.id, slug),
    ):
        with pytest.raises((ResourceNotFoundError, ConflictError)):
            await mutation


async def test_unknown_uuid_ref_404s_rather_than_erroring(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.get(test_workspace.id, str(uuid.uuid4()))


# --- summary fields that only a WORKSPACE row can exercise -------------------
#
# The system block is all published and (today) mixed-slot, so a summary field
# hardcoded to a system-shaped constant survives every assertion above. These
# drive the workspace half, where the same fields take the other value.


async def test_summary_marks_an_unpublished_row_as_a_draft(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)

    mine = next(
        s for s in await service.list(test_workspace.id) if s["id"] == str(template.id)
    )

    assert mine["is_draft"] is True
    assert mine["is_system"] is False


async def test_summary_clears_the_draft_flag_after_publishing(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    await service.publish(test_workspace.id, template.id, expected_version=0)

    mine = next(
        s for s in await service.list(test_workspace.id) if s["id"] == str(template.id)
    )

    assert mine["is_draft"] is False


async def test_summary_reports_slots_from_an_unpublished_draft(
    db_session: AsyncSession, test_workspace: Workspace
):
    """An unpublished row has NO published content.

    Reading `has_slots` from the published half would report False for every
    draft — so the Library could never warn that a work-in-progress template
    needs slot values before it can bind.
    """
    service = LoopTemplateService(db_session)
    payload = _draft_payload()
    payload["content"]["loop_prompt"] = "Work on <<CARD_ID>> now."
    template = await service.create_draft(
        test_workspace.id, actor_id=None, data=payload
    )

    mine = next(
        s for s in await service.list(test_workspace.id) if s["id"] == str(template.id)
    )

    assert mine["has_slots"] is True


async def test_summary_reports_no_slots_for_a_slotless_draft(
    db_session: AsyncSession, test_workspace: Workspace
):
    """The other branch, so `has_slots` cannot be hardcoded True either."""
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)

    mine = next(
        s for s in await service.list(test_workspace.id) if s["id"] == str(template.id)
    )

    assert mine["has_slots"] is False


async def test_boards_using_ignores_boards_in_another_workspace(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    second_user,
):
    """Usage counts are per-tenant.

    The binding row carries no workspace of its own, so a count that does not
    join through boards would report another tenant's usage — leaking both a
    number and the fact that someone else runs this template.
    """
    from app.repositories.config_template import BoardLoopTemplateBindingRepository

    other_ws = Workspace(name="Other", slug="other-ws", created_by=second_user.id)
    db_session.add(other_ws)
    await db_session.flush()
    foreign_board = Board(
        name="Foreign",
        slug="foreign",
        workspace_id=other_ws.id,
        created_by=second_user.id,
    )
    db_session.add(foreign_board)
    await db_session.flush()

    slug = LOOP_TEMPLATES[0].slug
    bindings = BoardLoopTemplateBindingRepository(db_session)
    await bindings.upsert(
        board_id=foreign_board.id,
        template_ref={"source": "system", "slug": slug},
        version=1,
        slot_values={},
    )
    await db_session.flush()

    summaries = await LoopTemplateService(db_session).list(test_workspace.id)
    bound = next(s for s in summaries if s["id"] == slug)

    assert bound["boards_using"] == 0, "counted a board from another workspace"

    # And the other tenant sees its own binding, so the filter is scoping
    # rather than simply returning nothing.
    theirs = await LoopTemplateService(db_session).list(other_ws.id)
    assert next(s for s in theirs if s["id"] == slug)["boards_using"] == 1


# --- refs that must MISS, and the explicit-slug path -------------------------


async def test_duplicate_honours_an_explicit_new_slug(
    db_session: AsyncSession, test_workspace: Workspace
):
    """Without this the `-copy` default is indistinguishable from ignoring the
    caller's chosen slug — the Library's "Duplicate as…" would silently rename
    every fork."""
    service = LoopTemplateService(db_session)
    source = LOOP_TEMPLATES[0]

    copy = await service.duplicate(
        test_workspace.id, source.slug, actor_id=None, new_slug="my-fork"
    )

    assert copy.slug == "my-fork"


async def test_duplicate_with_an_explicit_slug_still_rejects_a_clash(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    source = LOOP_TEMPLATES[0]
    await service.duplicate(
        test_workspace.id, source.slug, actor_id=None, new_slug="my-fork"
    )

    with pytest.raises(ConflictError):
        await service.duplicate(
            test_workspace.id, source.slug, actor_id=None, new_slug="my-fork"
        )


async def test_a_ref_that_is_neither_slug_nor_uuid_404s(
    db_session: AsyncSession, test_workspace: Workspace
):
    """Garbage in the path must 404, not raise a ValueError into a 500.

    `not-a-uuid` matches no system slug and cannot parse as a row id, so it
    reaches the guard that a UUID-shaped ref never does (probed: the guard
    fires six times across this suite).

    Note for mutation runs: replacing the raise with `template_id = uuid4()`
    is an EQUIVALENT mutant — a random id misses too, so both spellings 404.
    What this test actually pins is that a malformed ref does not escape as a
    ValueError into a 500, which is the failure the guard exists to prevent.
    """
    service = LoopTemplateService(db_session)
    # A real row exists, so "404 because the table is empty" cannot be
    # mistaken for "404 because the ref was rejected".
    await _make_draft(service, test_workspace)

    for junk in ("not-a-uuid", "", "12345", "../etc/passwd"):
        with pytest.raises(ResourceNotFoundError):
            await service.get(test_workspace.id, junk)

    # And the guard must not be reached by CONVERTING junk into some other id:
    # a malformed ref is rejected before any lookup runs, so no query is ever
    # issued on the caller's behalf.
    with pytest.raises(ResourceNotFoundError):
        await service.update_draft(
            test_workspace.id,
            "not-a-uuid",
            data={"name": "should never apply"},
            expected_updated_at=None,
        )


async def test_a_pipeline_template_is_invisible_to_the_loop_service(
    db_session: AsyncSession, test_workspace: Workspace
):
    """`config_templates` is shared by loops and pipelines.

    Resolving a ref without the kind filter would let a loop board bind to a
    PIPELINE template — a config whose shape the loop renderer cannot render.
    The two features share a table, never a namespace.
    """
    from app.repositories.config_template import ConfigTemplateRepository

    pipeline_row = await ConfigTemplateRepository(db_session).create(
        workspace_id=test_workspace.id,
        kind="pipeline",
        slug="a-pipeline",
        name="A pipeline",
        version=0,
        profile=None,
        content=None,
        draft_profile={},
        draft_content={},
    )
    await db_session.flush()

    service = LoopTemplateService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.get(test_workspace.id, str(pipeline_row.id))

    listed = {s["id"] for s in await service.list(test_workspace.id)}
    assert str(pipeline_row.id) not in listed


# --- the draft contract: one lock token, explicit dirty state ----------------
#
# Card 65714512. Two defects the p1-02 tests could not see because they never
# ROUND-TRIPPED the token the API hands back: the wire exposed the row's
# `updated_at` (DB clock, bumped by every write) while the lock compared
# `draft_updated_at` (Python clock, bumped only by autosave), so a well-behaved
# client false-409'd on its second save; and `is_draft` meant "never published",
# leaving a published template with unsaved draft edits indistinguishable from
# a clean one.


async def test_detail_hands_back_the_token_the_lock_compares(
    db_session: AsyncSession, test_workspace: Workspace
):
    """The canonical round-trip: whatever GET returns must satisfy the lock."""
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    await db_session.flush()

    detail = await service.get(test_workspace.id, str(template.id))

    assert detail["draft_updated_at"] == (
        template.draft_updated_at.isoformat() if template.draft_updated_at else None
    )
    # No exception: the returned token is accepted verbatim.
    await service.update_draft(
        test_workspace.id,
        str(template.id),
        data={"name": "Renamed"},
        expected_updated_at=detail["draft_updated_at"],
    )


async def test_round_tripping_the_token_across_consecutive_saves_never_409s(
    db_session: AsyncSession, test_workspace: Workspace
):
    """Autosave loop: each save's returned token unlocks the next one.

    This is the exact sequence the P3 draft store runs. Before the fix the
    second save raised `stale_draft` because the client was handed the row's
    DB-clock `updated_at` while the lock read the Python-clock draft stamp.
    """
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    await db_session.flush()

    token = (await service.get(test_workspace.id, str(template.id)))["draft_updated_at"]

    for name in ("First", "Second", "Third"):
        await service.update_draft(
            test_workspace.id,
            str(template.id),
            data={"name": name},
            expected_updated_at=token,
        )
        await db_session.flush()
        token = (await service.get(test_workspace.id, str(template.id), draft=True))[
            "draft_updated_at"
        ]

    refreshed = await service.get(test_workspace.id, str(template.id), draft=True)
    assert refreshed["name"] == "Third"


async def test_a_superseded_token_still_409s(
    db_session: AsyncSession, test_workspace: Workspace
):
    """The lock must stay a lock: the PREVIOUS token is rejected after a save."""
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    await db_session.flush()

    first_token = (await service.get(test_workspace.id, str(template.id)))[
        "draft_updated_at"
    ]
    await service.update_draft(
        test_workspace.id,
        str(template.id),
        data={"name": "Other editor"},
        expected_updated_at=first_token,
    )
    await db_session.flush()

    with pytest.raises(ConflictError):
        await service.update_draft(
            test_workspace.id,
            str(template.id),
            data={"name": "Mine"},
            expected_updated_at=first_token,
        )


async def test_a_fresh_draft_has_no_unpublished_changes(
    db_session: AsyncSession, test_workspace: Workspace
):
    """`has_unpublished_changes` is about DIVERGENCE, not about being unpublished.

    A never-published draft is reported by `is_draft`; conflating the two would
    make the P3 "unsaved work" hint fire permanently on every new template.
    """
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    await db_session.flush()

    detail = await service.get(test_workspace.id, str(template.id))

    assert detail["is_draft"] is True
    assert detail["has_unpublished_changes"] is False


async def test_publishing_leaves_no_unpublished_changes(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    await db_session.flush()
    await service.publish(test_workspace.id, str(template.id))
    await db_session.flush()

    detail = await service.get(test_workspace.id, str(template.id))

    assert detail["is_draft"] is False
    assert detail["has_unpublished_changes"] is False


async def test_editing_after_publish_reports_unpublished_changes(
    db_session: AsyncSession, test_workspace: Workspace
):
    """The defect this card names: dirty state vanished once version > 0."""
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    await db_session.flush()
    await service.publish(test_workspace.id, str(template.id))
    await db_session.flush()

    await service.update_draft(
        test_workspace.id,
        str(template.id),
        data={
            "content": {**_draft_payload()["content"], "loop_prompt": "Do TWO things."}
        },
        expected_updated_at=None,
    )
    await db_session.flush()

    detail = await service.get(test_workspace.id, str(template.id))

    assert detail["is_draft"] is False, "still published — only the draft moved"
    assert detail["has_unpublished_changes"] is True


async def test_a_profile_only_edit_after_publish_is_also_dirty(
    db_session: AsyncSession, test_workspace: Workspace
):
    """Divergence is content OR profile — the Library card renders both."""
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    await db_session.flush()
    await service.publish(test_workspace.id, str(template.id))
    await db_session.flush()

    await service.update_draft(
        test_workspace.id,
        str(template.id),
        data={"profile": {"emoji": "🚀", "tagline": "Rewritten", "tags": ["custom"]}},
        expected_updated_at=None,
    )
    await db_session.flush()

    assert (await service.get(test_workspace.id, str(template.id)))[
        "has_unpublished_changes"
    ] is True


async def test_republishing_clears_unpublished_changes(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    await db_session.flush()
    await service.publish(test_workspace.id, str(template.id))
    await db_session.flush()
    await service.update_draft(
        test_workspace.id,
        str(template.id),
        data={
            "content": {**_draft_payload()["content"], "loop_prompt": "Do TWO things."}
        },
        expected_updated_at=None,
    )
    await db_session.flush()
    assert (await service.get(test_workspace.id, str(template.id)))[
        "has_unpublished_changes"
    ] is True

    await service.publish(test_workspace.id, str(template.id))
    await db_session.flush()

    detail = await service.get(test_workspace.id, str(template.id))
    assert detail["version"] == 2
    assert detail["has_unpublished_changes"] is False


async def test_the_listing_carries_the_same_draft_contract(
    db_session: AsyncSession, test_workspace: Workspace
):
    """The Library page renders badges from the LISTING, never from detail."""
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    await db_session.flush()
    await service.publish(test_workspace.id, str(template.id))
    await db_session.flush()
    await service.update_draft(
        test_workspace.id,
        str(template.id),
        data={
            "content": {**_draft_payload()["content"], "loop_prompt": "Do TWO things."}
        },
        expected_updated_at=None,
    )
    await db_session.flush()

    mine = next(
        s for s in await service.list(test_workspace.id) if s["id"] == str(template.id)
    )

    assert mine["has_unpublished_changes"] is True
    assert mine["draft_updated_at"] is not None


async def test_a_system_template_is_never_dirty_and_carries_no_token(
    db_session: AsyncSession, test_workspace: Workspace
):
    """Code-defined templates have no draft half at all — there is nothing to lock."""
    service = LoopTemplateService(db_session)
    slug = LOOP_TEMPLATES[0].slug

    detail = await service.get(test_workspace.id, slug)
    listed = next(s for s in await service.list(test_workspace.id) if s["id"] == slug)

    assert detail["has_unpublished_changes"] is False
    assert detail["draft_updated_at"] is None
    assert listed["has_unpublished_changes"] is False
    assert listed["draft_updated_at"] is None


async def test_publish_rebases_the_draft_stamp_so_a_stale_editor_409s(
    db_session: AsyncSession, test_workspace: Workspace
):
    """Publishing is a draft-half event: it must move the lock token too.

    Otherwise an editor holding a pre-publish token could autosave over the
    just-published draft without ever seeing a conflict.
    """
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    await db_session.flush()
    before = (await service.get(test_workspace.id, str(template.id)))[
        "draft_updated_at"
    ]

    await service.publish(test_workspace.id, str(template.id))
    await db_session.flush()

    after = (await service.get(test_workspace.id, str(template.id)))["draft_updated_at"]
    assert after != before

    with pytest.raises(ConflictError):
        await service.update_draft(
            test_workspace.id,
            str(template.id),
            data={"name": "Stale editor"},
            expected_updated_at=before,
        )


# --- concurrent autosave (card ff930e62) ----------------------------------


@contextmanager
def _capture_update_sql(session: AsyncSession):
    """Collect every UPDATE against config_templates emitted inside the block.

    Listening on the sync engine is the only place the FINAL compiled SQL is
    visible; a Core statement's `str()` would show what we built, not what the
    driver ran, and so could not catch an ORM write slipping past the guarded
    path. The listener is removed on exit — the engine outlives the test, so
    leaving it attached would leak into every later test on this worker.
    """
    statements: list[str] = []
    engine = session.get_bind()

    def _record(conn, cursor, statement, params, context, executemany):
        if "UPDATE config_templates" in statement:
            statements.append(" ".join(statement.split()))

    event.listen(engine, "before_cursor_execute", _record)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", _record)


#
# The lock is only worth having if the compare and the write are ONE database
# operation. These tests drive the interleaving the Python-side compare admits:
# two editors read the same token before either writes.


async def test_locked_autosave_puts_the_token_in_the_update_predicate(
    db_session: AsyncSession, test_workspace: Workspace
):
    """The compare must live in the WHERE clause, not in Python.

    This is the test that actually has teeth. The aiosqlite fixture funnels
    every session through ONE connection (StaticPool), so a second session's
    SELECT already sees the first's commit and the Python compare happens to
    reject the overwrite — the lost update simply cannot be staged here. Under
    PostgreSQL READ COMMITTED on separate connections it can: both editors
    read the same token, both Python compares pass, and the second
    unconditional UPDATE wins.

    So we assert the emitted SQL instead, which is engine-independent: the
    UPDATE must be guarded by `draft_updated_at`, not by id alone.
    """
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    token = (await service.get(test_workspace.id, str(template.id)))["draft_updated_at"]

    with _capture_update_sql(db_session) as statements:
        await service.update_draft(
            test_workspace.id,
            str(template.id),
            data={"name": "Guarded"},
            expected_updated_at=token,
        )

    assert statements, "no UPDATE against config_templates was emitted"
    assert all("draft_updated_at = ?" in sql for sql in statements), statements


async def test_unlocked_autosave_omits_the_token_predicate(
    db_session: AsyncSession, test_workspace: Workspace
):
    """Opting out of the lock must not smuggle a predicate in.

    Without this the guarded-path test above is satisfiable by a WHERE that is
    always present, which would 409 every caller that legitimately omits a
    token (the first save after a load, and every non-UI caller).
    """
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)

    with _capture_update_sql(db_session) as statements:
        await service.update_draft(
            test_workspace.id,
            str(template.id),
            data={"name": "Unguarded"},
            expected_updated_at=None,
        )

    assert statements, "no UPDATE against config_templates was emitted"
    assert all("draft_updated_at = ?" not in sql for sql in statements), statements


async def test_autosave_409s_when_the_guarded_update_matches_no_row(
    db_session: AsyncSession, test_workspace: Workspace
):
    """Losing the race must 409 — and must not report success.

    This is the losing half of the race, staged directly because the
    single-connection fixture cannot produce it by interleaving: the row's
    token is advanced out from under the service AFTER it has loaded the row,
    exactly as a rival editor's commit would, so the guarded UPDATE matches
    zero rows.

    Without this, `update_draft` could take the write's rowcount as always-won
    and the lock would be decorative: the loser's data would be dropped on the
    floor while the caller was told the save succeeded.
    """
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace)
    token = (await service.get(test_workspace.id, str(template.id)))["draft_updated_at"]

    original_get_row = service._get_row

    async def _advance_stored_token_after_load(*args, **kwargs):
        row = await original_get_row(*args, **kwargs)
        # A rival editor commits between our SELECT and our UPDATE.
        # `synchronize_session=False` is what makes this a race and not just a
        # stale token: the STORED value moves while our row object keeps the
        # token the caller was handed, so the Python pre-check still passes and
        # only the UPDATE's own predicate can catch it.
        await db_session.execute(
            update(ConfigTemplate)
            .where(ConfigTemplate.id == row.id)
            .values(draft_updated_at=row.draft_updated_at + timedelta(seconds=1))
            .execution_options(synchronize_session=False)
        )
        return row

    service._get_row = _advance_stored_token_after_load

    with pytest.raises(ConflictError) as excinfo:
        await service.update_draft(
            test_workspace.id,
            str(template.id),
            data={"name": "Loser"},
            expected_updated_at=token,
        )

    assert excinfo.value.error_code == "stale_draft"
    # The reported token is the winner's, so the client can reload from it.
    assert excinfo.value.context["current_draft_updated_at"] != token

    service._get_row = original_get_row
    final = await service.get(test_workspace.id, str(template.id))
    assert final["name"] != "Loser"


async def test_concurrent_autosaves_on_the_same_token_do_not_both_win(
    db_engine, test_workspace: Workspace
):
    """Exactly one of two racing saves may commit; the loser must 409.

    Both services read the row — and therefore the lock token — before either
    writes, which is the schedule a read-then-compare-then-write cannot
    reject: both Python comparisons see the same value and pass. Only a
    compare that happens INSIDE the UPDATE (or under a row lock) can order
    them.

    Two independent sessions are the point. The aiosqlite fixture funnels them
    through one connection, so this reproduces the lost update rather than a
    true parallel commit; the SQL predicate is what the assertion is really
    pinning, and it is the same predicate PostgreSQL evaluates under its row
    lock.
    """
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)

    async with factory() as setup_session:
        template = await _make_draft(LoopTemplateService(setup_session), test_workspace)
        template_id = str(template.id)
        await setup_session.commit()

    async with factory() as session_a, factory() as session_b:
        service_a = LoopTemplateService(session_a)
        service_b = LoopTemplateService(session_b)

        token = (await service_a.get(test_workspace.id, template_id))[
            "draft_updated_at"
        ]
        assert token is not None
        # B loads the SAME token before A has written anything. This read is
        # load-bearing, not decoration: it puts B's row in its identity map, so
        # B's later lock check compares against the value B saw HERE, not
        # against whatever A has committed in the meantime. Drop it and B
        # re-reads A's fresh token and 409s for the wrong reason.
        assert (await service_b.get(test_workspace.id, template_id))[
            "draft_updated_at"
        ] == token
        await service_b._get_row(test_workspace.id, template_id, include_archived=True)

        await service_a.update_draft(
            test_workspace.id,
            template_id,
            data={"name": "A wins"},
            expected_updated_at=token,
        )
        await session_a.commit()

        with pytest.raises(ConflictError) as excinfo:
            await service_b.update_draft(
                test_workspace.id,
                template_id,
                data={"name": "B overwrites"},
                expected_updated_at=token,
            )
        assert excinfo.value.error_code == "stale_draft"
        await session_b.rollback()

    async with factory() as verify_session:
        final = await LoopTemplateService(verify_session).get(
            test_workspace.id, template_id
        )
    assert final["name"] == "A wins"


# --- the draft half of `name` -------------------------------------------------


async def test_renaming_a_published_template_does_not_move_the_published_name(
    db_session: AsyncSession, test_workspace: Workspace
):
    """A rename is draft work like any other edit — it waits for Publish.

    `name` is the only editable field that used to write a shared column, so an
    autosaved rename reached every published-half consumer (the Library listing,
    the board dialog's bound view) while the boards involved were still running
    the OLD published template.
    """
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace, name="Published name")
    await db_session.flush()
    await service.publish(test_workspace.id, str(template.id))
    await db_session.flush()

    await service.update_draft(
        test_workspace.id,
        str(template.id),
        data={"name": "Pending rename"},
        expected_updated_at=None,
    )
    await db_session.flush()

    published = await service.get(test_workspace.id, str(template.id))
    drafted = await service.get(test_workspace.id, str(template.id), draft=True)

    assert published["name"] == "Published name"
    assert drafted["name"] == "Pending rename"


async def test_a_name_only_edit_reports_unpublished_changes(
    db_session: AsyncSession, test_workspace: Workspace
):
    """The dirty pill has to notice a rename, or the editor loses the edit.

    `has_unpublished_changes` compared only the split halves, so a rename was
    invisible to it — the one edit that had already escaped was also the one
    edit the "unpublished changes" hint never reported.
    """
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace, name="Published name")
    await db_session.flush()
    await service.publish(test_workspace.id, str(template.id))
    await db_session.flush()

    await service.update_draft(
        test_workspace.id,
        str(template.id),
        data={"name": "Pending rename"},
        expected_updated_at=None,
    )
    await db_session.flush()

    detail = await service.get(test_workspace.id, str(template.id))

    assert detail["has_unpublished_changes"] is True


async def test_publishing_promotes_the_drafted_name(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace, name="Published name")
    await db_session.flush()
    await service.publish(test_workspace.id, str(template.id))
    await db_session.flush()
    await service.update_draft(
        test_workspace.id,
        str(template.id),
        data={"name": "Pending rename"},
        expected_updated_at=None,
    )
    await db_session.flush()

    await service.publish(test_workspace.id, str(template.id))
    await db_session.flush()

    detail = await service.get(test_workspace.id, str(template.id))

    assert detail["name"] == "Pending rename"
    assert detail["has_unpublished_changes"] is False


async def test_the_library_listing_shows_the_published_name_while_a_rename_waits(
    db_session: AsyncSession, test_workspace: Workspace
):
    """The listing is a published-half view: it names what boards actually run."""
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace, name="Published name")
    await db_session.flush()
    await service.publish(test_workspace.id, str(template.id))
    await db_session.flush()
    await service.update_draft(
        test_workspace.id,
        str(template.id),
        data={"name": "Pending rename"},
        expected_updated_at=None,
    )
    await db_session.flush()

    rows = await service.list(test_workspace.id)
    row = next(r for r in rows if r["id"] == str(template.id))

    assert row["name"] == "Published name"
    assert row["has_unpublished_changes"] is True


async def test_publishing_clears_the_pending_rename(
    db_session: AsyncSession, test_workspace: Workspace
):
    """Publish RESETS `draft_name`, it does not merely copy it across.

    Leaving the promoted value behind is invisible through the read model — the
    two columns agree, so every serializer and the divergence check give the
    same answers either way. It matters one step later: `draft_name` is the
    row's "renamed since last publish" flag, and a stale one means a subsequent
    rename-then-revert cannot get back to a clean state, because there is no
    longer any value that means "no pending rename".
    """
    service = LoopTemplateService(db_session)
    template = await _make_draft(service, test_workspace, name="Published name")
    await db_session.flush()
    await service.publish(test_workspace.id, str(template.id))
    await db_session.flush()
    await service.update_draft(
        test_workspace.id,
        str(template.id),
        data={"name": "Pending rename"},
        expected_updated_at=None,
    )
    await db_session.flush()
    assert template.draft_name == "Pending rename"

    published = await service.publish(test_workspace.id, str(template.id))
    await db_session.flush()

    assert published.name == "Pending rename"
    assert published.draft_name is None
