# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""LoopTemplateBundleService — portable export/import of a loop template.

Card p4-01 (`5061acba`). The envelope is the same unit pipelines already use
(`services/export/envelope.py`), so these tests pin the parts that are specific
to templates and would silently rot otherwise:

  - the export carries CONTENT and PROFILE but no track record, no board names
    and no UUIDs — a bundle that names its origin's boards is that workspace's
    loop wearing a template's clothes (spec F12);
  - lineage travels by {slug, version, source_workspace_slug}, never by id,
    because ids are meaningless in the receiving workspace;
  - dry_run mutates NOTHING (the default on the route, per the pipeline
    precedent), and the commit path always lands a DRAFT — publish stays a
    separate, explicit act (Q6/F9);
  - a bundle whose kernels reference an uncatalogued <<SLOT>> is refused, so an
    unrenderable template cannot be parked in someone else's workspace.

The entity-type guard is tested in BOTH directions: the two importers must
reject each other's bundles, or a pipeline bundle could be applied as a
template.
"""

import uuid

import pytest

from app.exceptions import BadRequestError, ValidationError
from app.models.config_template import ConfigTemplate
from app.models.workspace import Workspace
from app.services.export.envelope import SCHEMA_VERSION, EntityType, build_envelope
from app.services.export.loop_template_bundle import (
    PROFILE_MAX_BYTES,
    LoopTemplateBundleService,
)
from app.services.export.pipeline_bundle import PipelineBundleService
from app.services.loop_template import LoopTemplateService

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


def _content(**overrides) -> dict:
    """A template that renders and publishes clean.

    Carries the off-switch tool because `validate_template` requires it; a
    payload without it turns every "this import succeeds" assertion into a
    silent 422.
    """
    content = {
        "system_prompt": "You are a careful agent working in <<WORKSPACE_NAME>>.",
        "loop_prompt": "Advance one card. Stop when done.",
        "slots": [
            {
                "name": "WORKSPACE_NAME",
                "kind": "scalar",
                "label": "Workspace name",
                "default": "acme",
            }
        ],
        "rails_defaults": {},
        "tools": ["mcp__valaris__set_board_loop"],
        "setup_contract": {},
        "derived_rails": {},
    }
    content.update(overrides)
    return content


def _draft_payload(**overrides) -> dict:
    payload = {
        "slug": "portable-loop",
        "name": "Portable loop",
        "profile": {"emoji": "🔁", "tagline": "A portable loop", "tags": ["custom"]},
        "content": _content(),
    }
    payload.update(overrides)
    return payload


async def _seed_draft(db: AsyncSession, workspace: Workspace, **overrides):
    service = LoopTemplateService(db)
    return await service.create_draft(
        workspace.id, actor_id=None, data=_draft_payload(**overrides)
    )


async def _other_workspace(db: AsyncSession, owner) -> Workspace:
    workspace = Workspace(name="Receiving", slug="receiving", created_by=owner.id)
    db.add(workspace)
    await db.flush()
    return workspace


# --------------------------------------------------------------- export


async def test_export_envelope_shape_no_track_record(
    db_session: AsyncSession, test_workspace: Workspace
):
    row = await _seed_draft(db_session, test_workspace)
    bundle = await LoopTemplateBundleService(db_session).build_bundle(
        test_workspace.id, test_workspace.slug, str(row.id)
    )

    assert bundle["schema_version"] == SCHEMA_VERSION
    assert bundle["entity_type"] == "loop_template"
    assert bundle["source_workspace_slug"] == test_workspace.slug

    data = bundle["data"]
    assert data["slug"] == "portable-loop"
    assert data["kind"] == "loop"
    assert data["content"] == _content()
    assert data["profile"]["tagline"] == "A portable loop"
    assert data["lineage"] == {
        "source": "export",
        "slug": "portable-loop",
        "version": 0,
        "source_workspace_slug": test_workspace.slug,
    }

    # The portability contract, asserted as an absence: a track record is a
    # fact about the EXPORTING workspace's boards and must never travel.
    assert "track_record" not in data
    assert "boards_using" not in data
    # No identifier from this workspace may appear anywhere in the payload.
    assert str(row.id) not in repr(data)


async def test_export_carries_leak_findings(
    db_session: AsyncSession, test_workspace: Workspace
):
    """The receiving side must see the same warning the exporter saw, so the
    findings ride along in the file rather than living only in the export UI."""
    leaky = _content(
        system_prompt="Clone https://github.com/Valaris-Studio/valaris-intern and go."
    )
    row = await _seed_draft(db_session, test_workspace, content=leaky)

    bundle = await LoopTemplateBundleService(db_session).build_bundle(
        test_workspace.id, test_workspace.slug, str(row.id)
    )

    codes = {finding["code"] for finding in bundle["data"]["leak_findings"]}
    assert "url" in codes


async def test_export_of_a_system_template_is_marked(
    db_session: AsyncSession, test_workspace: Workspace
):
    bundle = await LoopTemplateBundleService(db_session).build_bundle(
        test_workspace.id, test_workspace.slug, "coding-loop-v1"
    )
    assert bundle["data"]["is_system_origin"] is True
    assert bundle["data"]["slug"] == "coding-loop-v1"


async def test_a_workspace_export_is_not_marked_system(
    db_session: AsyncSession, test_workspace: Workspace
):
    row = await _seed_draft(db_session, test_workspace)
    bundle = await LoopTemplateBundleService(db_session).build_bundle(
        test_workspace.id, test_workspace.slug, str(row.id)
    )
    assert bundle["data"]["is_system_origin"] is False


# --------------------------------------------------------------- guards


async def test_import_rejects_wrong_entity_type(
    db_session: AsyncSession, test_workspace: Workspace
):
    foreign = build_envelope(
        entity_type="pipeline_bundle",
        source_workspace_slug="somewhere",
        data={"pipeline_config": {"stages": []}},
    )
    with pytest.raises(BadRequestError):
        await LoopTemplateBundleService(db_session).import_bundle(
            test_workspace.id, uuid.uuid4(), foreign
        )


async def test_the_pipeline_importer_rejects_a_loop_template_bundle(
    db_session: AsyncSession, test_workspace: Workspace
):
    """The other direction of the same guard. Without this, a template bundle
    posted to the pipeline endpoint would be read as a pipeline config."""
    row = await _seed_draft(db_session, test_workspace)
    bundle = await LoopTemplateBundleService(db_session).build_bundle(
        test_workspace.id, test_workspace.slug, str(row.id)
    )

    with pytest.raises(BadRequestError):
        await PipelineBundleService(db_session).import_bundle(
            test_workspace.id, uuid.uuid4(), bundle
        )


async def test_import_rejects_wrong_schema_version(
    db_session: AsyncSession, test_workspace: Workspace
):
    row = await _seed_draft(db_session, test_workspace)
    bundle = await LoopTemplateBundleService(db_session).build_bundle(
        test_workspace.id, test_workspace.slug, str(row.id)
    )
    bundle["schema_version"] = SCHEMA_VERSION + 1

    with pytest.raises(BadRequestError):
        await LoopTemplateBundleService(db_session).import_bundle(
            test_workspace.id, uuid.uuid4(), bundle
        )


async def test_every_entity_type_literal_is_in_the_valid_frozenset():
    """`build_envelope` enforces the frozenset while type checking reads the
    Literal; a member added to one and not the other fails only at runtime, on
    the export path, in production."""
    from app.services.export.envelope import _VALID_ENTITY_TYPES
    from typing import get_args

    assert set(get_args(EntityType)) == _VALID_ENTITY_TYPES


# --------------------------------------------------------------- import


async def test_import_dry_run_mutates_nothing(
    db_session: AsyncSession, test_workspace: Workspace, test_user
):
    row = await _seed_draft(db_session, test_workspace)
    bundle = await LoopTemplateBundleService(db_session).build_bundle(
        test_workspace.id, test_workspace.slug, str(row.id)
    )
    target = await _other_workspace(db_session, test_user)

    before = (
        await db_session.execute(
            select(ConfigTemplate).where(ConfigTemplate.workspace_id == target.id)
        )
    ).scalars().all()
    assert before == []

    result = await LoopTemplateBundleService(db_session).import_bundle(
        target.id, uuid.uuid4(), bundle, dry_run=True
    )

    assert result["dry_run"] is True
    assert result["action"] == "created"
    assert result.get("template_id") is None

    after = (
        await db_session.execute(
            select(ConfigTemplate).where(ConfigTemplate.workspace_id == target.id)
        )
    ).scalars().all()
    assert after == [], "dry run wrote a row"


async def test_import_creates_draft_with_lineage(
    db_session: AsyncSession, test_workspace: Workspace, test_user
):
    row = await _seed_draft(db_session, test_workspace)
    bundle = await LoopTemplateBundleService(db_session).build_bundle(
        test_workspace.id, test_workspace.slug, str(row.id)
    )
    target = await _other_workspace(db_session, test_user)

    result = await LoopTemplateBundleService(db_session).import_bundle(
        target.id, test_user.id, bundle, dry_run=False
    )

    assert result["dry_run"] is False
    assert result["action"] == "created"

    imported = (
        await db_session.execute(
            select(ConfigTemplate).where(ConfigTemplate.workspace_id == target.id)
        )
    ).scalars().one()

    # Lands as a DRAFT: version 0, published halves empty. Publishing is a
    # separate deliberate act by someone in the RECEIVING workspace.
    assert imported.version == 0
    assert not imported.content
    assert imported.draft_content == _content()
    assert imported.lineage == {
        "source": "import",
        "slug": "portable-loop",
        "version": 0,
        "source_workspace_slug": test_workspace.slug,
    }
    assert result["template_id"] == str(imported.id)


async def test_import_same_slug_updates_draft_only(
    db_session: AsyncSession, test_workspace: Workspace, test_user
):
    """A re-import is an update of the DRAFT half. The published content of a
    template boards may be running must survive it untouched."""
    row = await _seed_draft(db_session, test_workspace)
    bundle = await LoopTemplateBundleService(db_session).build_bundle(
        test_workspace.id, test_workspace.slug, str(row.id)
    )
    target = await _other_workspace(db_session, test_user)
    service = LoopTemplateBundleService(db_session)

    created = await service.import_bundle(
        target.id, test_user.id, bundle, dry_run=False
    )
    published = await LoopTemplateService(db_session).publish(
        target.id, created["template_id"], actor_id=None
    )
    published_content = dict(published.content)
    assert published.version == 1

    revised = dict(bundle)
    revised["data"] = dict(bundle["data"])
    revised["data"]["content"] = _content(loop_prompt="Advance one card, carefully.")

    preview = await service.import_bundle(
        target.id, uuid.uuid4(), revised, dry_run=True
    )
    assert preview["action"] == "updated"
    assert preview["diff_summary"], "an update preview must say what changes"

    await service.import_bundle(target.id, test_user.id, revised, dry_run=False)

    # Re-read from the DATABASE through a fresh identity rather than refreshing
    # the object the service returned: the draft write goes out as a Core
    # UPDATE, so asserting on a still-attached instance would report Python
    # state that may never have been persisted.
    db_session.expunge_all()
    reloaded = (
        await db_session.execute(
            select(ConfigTemplate).where(ConfigTemplate.workspace_id == target.id)
        )
    ).scalars().one()

    assert reloaded.draft_content["loop_prompt"] == "Advance one card, carefully."
    # The half a running board reads is untouched — pinned to the LITERAL
    # published text, so the assertion cannot travel with the write it guards.
    assert reloaded.content["loop_prompt"] == "Advance one card. Stop when done."
    assert reloaded.content == published_content
    assert reloaded.version == 1


async def test_import_rejects_an_uncatalogued_slot(
    db_session: AsyncSession, test_workspace: Workspace, test_user
):
    """An unrenderable template must not be parked in someone's workspace: the
    slot has no spec, so the loop would render `<<MISSING>>` literally."""
    row = await _seed_draft(db_session, test_workspace)
    bundle = await LoopTemplateBundleService(db_session).build_bundle(
        test_workspace.id, test_workspace.slug, str(row.id)
    )
    bundle["data"]["content"] = _content(
        loop_prompt="Advance <<MISSING>> and stop.", slots=[]
    )
    target = await _other_workspace(db_session, test_user)

    with pytest.raises(ValidationError):
        await LoopTemplateBundleService(db_session).import_bundle(
            target.id, test_user.id, bundle, dry_run=False
        )

    assert (
        await db_session.execute(
            select(ConfigTemplate).where(ConfigTemplate.workspace_id == target.id)
        )
    ).scalars().all() == []


async def test_dry_run_reports_findings_instead_of_raising(
    db_session: AsyncSession, test_workspace: Workspace, test_user
):
    """A preview exists to SHOW problems; raising would deny the operator the
    list they asked for."""
    row = await _seed_draft(db_session, test_workspace)
    bundle = await LoopTemplateBundleService(db_session).build_bundle(
        test_workspace.id, test_workspace.slug, str(row.id)
    )
    bundle["data"]["content"] = _content(
        loop_prompt="Advance <<MISSING>> and stop.", slots=[]
    )
    target = await _other_workspace(db_session, test_user)

    result = await LoopTemplateBundleService(db_session).import_bundle(
        target.id, uuid.uuid4(), bundle, dry_run=True
    )

    assert result["dry_run"] is True
    assert any(
        finding["code"] == "uncatalogued_slot" for finding in result["findings"]
    ), result["findings"]


async def test_round_trip_preserves_content(
    db_session: AsyncSession, test_workspace: Workspace, test_user
):
    row = await _seed_draft(db_session, test_workspace)
    service = LoopTemplateBundleService(db_session)
    exported = await service.build_bundle(
        test_workspace.id, test_workspace.slug, str(row.id)
    )
    target = await _other_workspace(db_session, test_user)

    imported = await service.import_bundle(
        target.id, test_user.id, exported, dry_run=False
    )
    # By UUID, not slug: the ref grammar resolves workspace rows by id and only
    # SYSTEM templates by slug (`LoopTemplateService._get_row`), so the id the
    # import hands back is the only handle a caller has to its own new draft.
    re_exported = await service.build_bundle(
        target.id, target.slug, imported["template_id"]
    )

    assert re_exported["data"]["content"] == exported["data"]["content"]
    assert re_exported["data"]["profile"] == exported["data"]["profile"]
    # Lineage is the one thing that legitimately differs: the re-export records
    # where IT came from, which is now the receiving workspace.
    assert re_exported["data"]["lineage"]["source_workspace_slug"] == target.slug


async def test_export_sends_the_draft_of_a_published_template(
    db_session: AsyncSession, test_workspace: Workspace
):
    """The half an author is LOOKING AT is the half they mean to share.

    Only reachable once the template is published: while `version == 0` the
    read model serves the draft whichever half is asked for, so an export that
    requested the published half would look correct on every unpublished
    fixture and diverge only after the first publish.
    """
    row = await _seed_draft(db_session, test_workspace)
    service = LoopTemplateService(db_session)
    await service.publish(test_workspace.id, str(row.id), actor_id=None)

    await service.update_draft(
        test_workspace.id,
        str(row.id),
        data={"content": _content(loop_prompt="Edited but not yet published.")},
        expected_updated_at=None,
    )

    bundle = await LoopTemplateBundleService(db_session).build_bundle(
        test_workspace.id, test_workspace.slug, str(row.id)
    )

    assert (
        bundle["data"]["content"]["loop_prompt"] == "Edited but not yet published."
    )


async def test_import_without_a_slug_is_rejected(
    db_session: AsyncSession, test_workspace: Workspace
):
    """Slug is the portable identity — lineage, dedupe and the filename all key
    off it, so a bundle missing one has nowhere to land."""
    row = await _seed_draft(db_session, test_workspace)
    bundle = await LoopTemplateBundleService(db_session).build_bundle(
        test_workspace.id, test_workspace.slug, str(row.id)
    )
    del bundle["data"]["slug"]

    with pytest.raises(BadRequestError):
        await LoopTemplateBundleService(db_session).import_bundle(
            test_workspace.id, uuid.uuid4(), bundle, dry_run=True
        )


async def test_import_without_content_is_rejected(
    db_session: AsyncSession, test_workspace: Workspace
):
    row = await _seed_draft(db_session, test_workspace)
    bundle = await LoopTemplateBundleService(db_session).build_bundle(
        test_workspace.id, test_workspace.slug, str(row.id)
    )
    # Any non-dict is refused, but note WHERE: `TemplateContent.model_validate`
    # rejects every non-dict on its own, so the explicit isinstance check above
    # it is belt-and-braces rather than the sole guard — deleting it keeps this
    # test green. It stays for the clearer message on the commonest bad file.
    bundle["data"]["content"] = []

    with pytest.raises(BadRequestError):
        await LoopTemplateBundleService(db_session).import_bundle(
            test_workspace.id, uuid.uuid4(), bundle, dry_run=True
        )


# ------------------------------------------- re-import keeps lineage (B8 j)


async def test_reimport_preserves_the_lineage_the_first_import_recorded(
    db_session: AsyncSession, test_workspace: Workspace, test_user
):
    """Provenance is written once, on create, and must survive every later pass.

    A REGRESSION pin, not a fix: the update branch sends only {name, profile,
    content} and `update_draft` maps exactly those three, so lineage is never
    reached by a re-import. Nothing in either signature says that, which is
    why it is asserted here — adding `lineage` to `update_draft`'s mapping
    later would silently let a re-import relabel an existing template's origin.
    """
    row = await _seed_draft(db_session, test_workspace)
    bundle = await LoopTemplateBundleService(db_session).build_bundle(
        test_workspace.id, test_workspace.slug, str(row.id)
    )
    target = await _other_workspace(db_session, test_user)
    service = LoopTemplateBundleService(db_session)

    await service.import_bundle(target.id, test_user.id, bundle, dry_run=False)

    revised = dict(bundle)
    revised["data"] = dict(bundle["data"])
    revised["data"]["content"] = _content(loop_prompt="Advance one card, twice.")
    result = await service.import_bundle(
        target.id, test_user.id, revised, dry_run=False
    )
    assert result["action"] == "updated"

    db_session.expunge_all()
    reloaded = (
        await db_session.execute(
            select(ConfigTemplate).where(ConfigTemplate.workspace_id == target.id)
        )
    ).scalars().one()

    assert reloaded.lineage == {
        "source": "import",
        "slug": "portable-loop",
        "version": 0,
        "source_workspace_slug": test_workspace.slug,
    }


# ------------------------------------------------- import validates profile


@pytest.mark.parametrize("bad_profile", ["not-an-object", ["a", "list"], 42])
async def test_import_rejects_a_profile_that_is_not_an_object(
    db_session: AsyncSession, test_workspace: Workspace, test_user, bad_profile
):
    row = await _seed_draft(db_session, test_workspace)
    bundle = await LoopTemplateBundleService(db_session).build_bundle(
        test_workspace.id, test_workspace.slug, str(row.id)
    )
    bundle["data"] = dict(bundle["data"])
    bundle["data"]["profile"] = bad_profile
    target = await _other_workspace(db_session, test_user)

    with pytest.raises(BadRequestError) as excinfo:
        await LoopTemplateBundleService(db_session).import_bundle(
            target.id, test_user.id, bundle, dry_run=False
        )
    assert "profile" in str(excinfo.value.detail)


async def test_import_rejects_an_oversized_profile(
    db_session: AsyncSession, test_workspace: Workspace, test_user
):
    row = await _seed_draft(db_session, test_workspace)
    bundle = await LoopTemplateBundleService(db_session).build_bundle(
        test_workspace.id, test_workspace.slug, str(row.id)
    )
    bundle["data"] = dict(bundle["data"])
    bundle["data"]["profile"] = {"tagline": "x" * (PROFILE_MAX_BYTES + 1)}
    target = await _other_workspace(db_session, test_user)

    with pytest.raises(BadRequestError) as excinfo:
        await LoopTemplateBundleService(db_session).import_bundle(
            target.id, test_user.id, bundle, dry_run=False
        )
    assert "profile" in str(excinfo.value.detail)


async def test_a_valid_profile_imports_unchanged(
    db_session: AsyncSession, test_workspace: Workspace, test_user
):
    """The cap must not become a rewrite: extra keys are allowed on the profile
    model (`extra="allow"`), so validation may reject but never normalize."""
    row = await _seed_draft(db_session, test_workspace)
    bundle = await LoopTemplateBundleService(db_session).build_bundle(
        test_workspace.id, test_workspace.slug, str(row.id)
    )
    bundle["data"] = dict(bundle["data"])
    bundle["data"]["profile"] = {
        "emoji": "🚀",
        "tagline": "Ships fast",
        "tags": ["custom"],
        "unknown_future_key": "kept",
    }
    target = await _other_workspace(db_session, test_user)

    await LoopTemplateBundleService(db_session).import_bundle(
        target.id, test_user.id, bundle, dry_run=False
    )

    db_session.expunge_all()
    reloaded = (
        await db_session.execute(
            select(ConfigTemplate).where(ConfigTemplate.workspace_id == target.id)
        )
    ).scalars().one()
    assert reloaded.draft_profile == {
        "emoji": "🚀",
        "tagline": "Ships fast",
        "tags": ["custom"],
        "unknown_future_key": "kept",
    }
