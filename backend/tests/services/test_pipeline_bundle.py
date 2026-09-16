# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""WS2: portable versioned config bundle — service-layer TDD.

A bundle is ONE JSON envelope carrying a workspace's pipeline_config, its derived
setup_contract (the `description`), and its workspace-scoped prompt_configs. Import
validates (pipeline validator + drift), supports a dry-run preview that mutates
nothing, and applies atomically with an expected_version concurrency guard.
"""

from __future__ import annotations

import copy

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.agents.prompt_config import PromptConfigCreate
from app.services.agents.prompt_config import PromptConfigService
from app.services.export.pipeline_bundle import PipelineBundleService
from app.services.workspace_config import (
    DEFAULT_PIPELINE_CONFIG,
    WorkspaceConfigService,
)
from app.schemas.workspace_config import WorkspaceConfigUpdate


async def _seed_workspace_pipeline(db: AsyncSession, ws: Workspace, user: User) -> dict:
    """Give the workspace the default pipeline + one custom prompt; return config dict."""
    svc = WorkspaceConfigService(db)
    config = await svc.update_config(
        ws.id, WorkspaceConfigUpdate(pipeline_config=copy.deepcopy(DEFAULT_PIPELINE_CONFIG))
    )
    await PromptConfigService(db).create_config(
        ws.id,
        PromptConfigCreate(
            name="Implementer Prompt",
            slug="implementer-implement",
            stage="implement",
            content="Custom implement content",
            team_role="implementer",
        ),
        user.id,
    )
    return config


# --------------------------------------------------------------------------- export


async def test_export_bundle_envelope_shape(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    await _seed_workspace_pipeline(db_session, test_workspace, test_user)
    bundle = await PipelineBundleService(db_session).build_bundle(
        test_workspace.id, test_workspace.slug
    )

    assert bundle["schema_version"] == 1
    assert bundle["entity_type"] == "pipeline_bundle"
    assert bundle["source_workspace_slug"] == test_workspace.slug
    data = bundle["data"]
    assert data["pipeline_config"]["stages"]
    assert isinstance(data["pipeline_version"], int)
    # description == the derived setup_contract (WS3)
    assert data["description"]["version"] == 1
    assert {c["column_type"] for c in data["description"]["columns"]} == {
        "backlog",
        "active",
        "review",
        "done",
    }


async def test_export_bundle_includes_workspace_prompts(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    await _seed_workspace_pipeline(db_session, test_workspace, test_user)
    bundle = await PipelineBundleService(db_session).build_bundle(
        test_workspace.id, test_workspace.slug
    )
    prompts = bundle["data"]["prompt_configs"]
    slugs = {p["slug"] for p in prompts}
    assert "implementer-implement" in slugs
    sample = next(p for p in prompts if p["slug"] == "implementer-implement")
    assert sample["content"] == "Custom implement content"
    assert sample["team_role"] == "implementer"
    assert sample["stage"] == "implement"


# --------------------------------------------------------------------------- import


async def test_import_bundle_dry_run_mutates_nothing(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    await _seed_workspace_pipeline(db_session, test_workspace, test_user)
    src = PipelineBundleService(db_session)
    bundle = await src.build_bundle(test_workspace.id, test_workspace.slug)

    # Mutate the bundle so a real import WOULD change state.
    bundle["data"]["prompt_configs"].append(
        {
            "slug": "brand-new-prompt",
            "name": "Brand New",
            "agent_type": None,
            "team_role": "planner",
            "stage": "plan",
            "content": "new",
            "team_slug": None,
            "is_system": False,
            "version": 1,
        }
    )

    before = await PromptConfigService(db_session).list_configs(test_workspace.id)
    result = await src.import_bundle(
        test_workspace.id, test_user.id, bundle, dry_run=True
    )
    after = await PromptConfigService(db_session).list_configs(test_workspace.id)

    assert result["dry_run"] is True
    assert len(before) == len(after)  # nothing created
    assert any(p["slug"] == "brand-new-prompt" for p in result["preview"]["prompts"]["created"])


async def test_import_bundle_commit_creates_prompts(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    await _seed_workspace_pipeline(db_session, test_workspace, test_user)
    src = PipelineBundleService(db_session)
    bundle = await src.build_bundle(test_workspace.id, test_workspace.slug)
    bundle["data"]["prompt_configs"].append(
        {
            "slug": "brand-new-prompt",
            "name": "Brand New",
            "agent_type": None,
            "team_role": "planner",
            "stage": "plan",
            "content": "new",
            "team_slug": None,
            "is_system": False,
            "version": 1,
        }
    )

    result = await src.import_bundle(
        test_workspace.id, test_user.id, bundle, dry_run=False
    )
    assert result["dry_run"] is False

    after = await PromptConfigService(db_session).list_configs(test_workspace.id)
    assert any(p.slug == "brand-new-prompt" for p in after)


async def test_round_trip_export_import_preserves_pipeline(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    await _seed_workspace_pipeline(db_session, test_workspace, test_user)
    src = PipelineBundleService(db_session)
    bundle = await src.build_bundle(test_workspace.id, test_workspace.slug)

    await src.import_bundle(test_workspace.id, test_user.id, bundle, dry_run=False)

    cfg = await WorkspaceConfigService(db_session).get_config(test_workspace.id)
    roles = [s["role"] for s in cfg["pipeline_config"]["stages"]]
    assert roles == [s["role"] for s in bundle["data"]["pipeline_config"]["stages"]]


async def test_import_bundle_reimport_is_idempotent(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """Re-importing the same bundle skips existing prompts (no duplicates)."""
    await _seed_workspace_pipeline(db_session, test_workspace, test_user)
    src = PipelineBundleService(db_session)
    bundle = await src.build_bundle(test_workspace.id, test_workspace.slug)

    await src.import_bundle(test_workspace.id, test_user.id, bundle, dry_run=False)
    before = await PromptConfigService(db_session).list_configs(test_workspace.id)
    result = await src.import_bundle(
        test_workspace.id, test_user.id, bundle, dry_run=False
    )
    after = await PromptConfigService(db_session).list_configs(test_workspace.id)

    assert len(before) == len(after)  # no new rows
    assert result["preview"]["prompts"]["created"] == []


async def test_import_bundle_rejects_invalid_pipeline(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    await _seed_workspace_pipeline(db_session, test_workspace, test_user)
    src = PipelineBundleService(db_session)
    bundle = await src.build_bundle(test_workspace.id, test_workspace.slug)
    # Break the pipeline: a stage missing required keys.
    bundle["data"]["pipeline_config"]["stages"].append({"role": "broken"})

    result = await src.import_bundle(
        test_workspace.id, test_user.id, bundle, dry_run=True
    )
    assert result["validation"]["pipeline_errors"]
    # Dry-run surfaces errors but doesn't raise.

    with pytest.raises(Exception):
        await src.import_bundle(
            test_workspace.id, test_user.id, bundle, dry_run=False
        )


async def test_import_bundle_version_guard_rejects_stale(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    await _seed_workspace_pipeline(db_session, test_workspace, test_user)
    src = PipelineBundleService(db_session)
    bundle = await src.build_bundle(test_workspace.id, test_workspace.slug)
    bundle["data"]["expected_pipeline_version"] = 999  # never matches

    from app.exceptions import ConflictError

    with pytest.raises(ConflictError) as exc:
        await src.import_bundle(
            test_workspace.id, test_user.id, bundle, dry_run=False
        )
    assert exc.value.status_code == 409
    assert exc.value.error_code == "stale_version"


async def test_import_bundle_rejects_wrong_schema_version(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    await _seed_workspace_pipeline(db_session, test_workspace, test_user)
    src = PipelineBundleService(db_session)
    bundle = await src.build_bundle(test_workspace.id, test_workspace.slug)
    bundle["schema_version"] = 99

    from app.exceptions import BadRequestError

    with pytest.raises(BadRequestError) as exc:
        await src.import_bundle(
            test_workspace.id, test_user.id, bundle, dry_run=True
        )
    assert exc.value.status_code == 400
    assert exc.value.error_code == "bad_request"


async def test_import_bundle_rejects_wrong_entity_type(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    await _seed_workspace_pipeline(db_session, test_workspace, test_user)
    src = PipelineBundleService(db_session)
    bundle = await src.build_bundle(test_workspace.id, test_workspace.slug)
    bundle["entity_type"] = "pipeline"  # not a bundle

    from app.exceptions import BadRequestError

    with pytest.raises(BadRequestError) as exc:
        await src.import_bundle(
            test_workspace.id, test_user.id, bundle, dry_run=True
        )
    assert exc.value.status_code == 400
    assert exc.value.error_code == "bad_request"


async def test_import_bundle_atomic_no_partial_on_pipeline_error(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """A pipeline validation failure must not create any of the bundle's prompts."""
    await _seed_workspace_pipeline(db_session, test_workspace, test_user)
    src = PipelineBundleService(db_session)
    bundle = await src.build_bundle(test_workspace.id, test_workspace.slug)
    bundle["data"]["prompt_configs"].append(
        {
            "slug": "should-not-persist",
            "name": "Nope",
            "agent_type": None,
            "team_role": "planner",
            "stage": "plan",
            "content": "x",
            "team_slug": None,
            "is_system": False,
            "version": 1,
        }
    )
    bundle["data"]["pipeline_config"]["stages"].append({"role": "broken"})

    with pytest.raises(Exception):
        await src.import_bundle(
            test_workspace.id, test_user.id, bundle, dry_run=False
        )

    after = await PromptConfigService(db_session).list_configs(test_workspace.id)
    assert not any(p.slug == "should-not-persist" for p in after)
