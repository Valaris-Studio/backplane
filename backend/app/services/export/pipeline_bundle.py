# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""WS2: portable versioned config bundle (pipeline + prompts + setup contract).

A bundle is ONE JSON envelope (`entity_type="pipeline_bundle"`) carrying a
workspace's `pipeline_config`, its derived `setup_contract` (the human+agent
`description`), and its workspace-scoped `prompt_configs`. It is the portable unit
for promoting a battle-tested pipeline (e.g. the 6-role default) to another
workspace.

Import is defensive:
  1. Envelope guard — schema_version + entity_type must match (400 otherwise).
  2. Pipeline validation — reuses `validate_pipeline_config` (422 on blocking).
  3. Optimistic concurrency — `expected_pipeline_version` must match the target's
     current config version (409 on stale), mirroring PATCH /config.
  4. dry_run=True returns a preview (created/updated/skipped prompts + validation
     findings) and mutates NOTHING.
  5. dry_run=False applies atomically: the pipeline_config update and every
     prompt create share the request's DB transaction (get_db commits on success,
     rolls back on any exception) — a validation error leaves no partial state.

Prompt scope: a bundle exports every WORKSPACE-scoped prompt (workspace_id ==
source), including the seeded `is_system` rows. Platform-level rows
(workspace_id IS NULL) are intentionally excluded — they re-seed on the target.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import BadRequestError, ValidationError
from app.models.agents.team import AgentTeam
from app.schemas.agents.prompt_config import PromptConfigCreate
from app.schemas.workspace_config import WorkspaceConfigUpdate
from app.services.agents.prompt_config import PromptConfigService
from app.services.export.envelope import SCHEMA_VERSION, build_envelope
from app.services.pipeline_config_validation import validate_pipeline_config
from app.services.setup_contract import build_setup_contract
from app.services.workspace_config import WorkspaceConfigService


class PipelineBundleService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.workspace_config = WorkspaceConfigService(db)
        self.prompt_config = PromptConfigService(db)

    # ------------------------------------------------------------------ export

    async def build_bundle(
        self, workspace_id: uuid.UUID, workspace_slug: str
    ) -> dict:
        """Assemble a portable bundle envelope for the workspace."""
        config_record = await self.workspace_config.repo.get_by_workspace(workspace_id)
        pipeline_config = (
            config_record.pipeline_config if config_record else None
        ) or {}
        pipeline_version = config_record.version if config_record else 0

        # The bundle's human+agent `description` IS the WS3 setup contract,
        # derived from the live config so it can't drift.
        setup_contract = (
            build_setup_contract(pipeline_config).to_dict() if pipeline_config else None
        )

        prompt_configs = await self._export_workspace_prompts(workspace_id)

        return build_envelope(
            entity_type="pipeline_bundle",
            source_workspace_slug=workspace_slug,
            data={
                "pipeline_config": pipeline_config,
                "pipeline_version": pipeline_version,
                "description": setup_contract,
                "prompt_configs": prompt_configs,
                # Carried for the importer's optimistic-concurrency guard when it
                # round-trips back to the SAME workspace. Cross-workspace imports
                # omit/ignore it (a fresh target's version differs by design).
                "expected_pipeline_version": None,
            },
        )

    async def _export_workspace_prompts(self, workspace_id: uuid.UUID) -> list[dict]:
        configs = await self.prompt_config.repo.list_by_workspace(workspace_id)
        # team_id → slug, resolved in one pass so the bundle is portable across
        # workspaces (import re-resolves slug → the target's team_id).
        team_slugs = await self._team_slug_map(
            {c.team_id for c in configs if c.team_id is not None}
        )
        return [
            {
                "slug": c.slug,
                "name": c.name,
                "agent_type": c.agent_type,
                "team_role": c.team_role,
                "stage": c.stage,
                "content": c.content,
                "team_slug": team_slugs.get(c.team_id) if c.team_id else None,
                "is_system": c.is_system,
                "version": c.version,
            }
            for c in configs
            # Workspace-scoped only; platform rows (workspace_id NULL) re-seed.
            if c.workspace_id == workspace_id
        ]

    async def _team_slug_map(self, team_ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
        if not team_ids:
            return {}
        rows = await self.db.execute(
            select(AgentTeam.id, AgentTeam.slug).where(AgentTeam.id.in_(team_ids))
        )
        return {tid: slug for tid, slug in rows.all()}

    # ------------------------------------------------------------------ import

    async def import_bundle(
        self,
        workspace_id: uuid.UUID,
        created_by_id: uuid.UUID,
        bundle: dict,
        *,
        dry_run: bool = False,
    ) -> dict:
        """Validate + (optionally) apply a bundle. See module docstring for the
        defensive ordering. Returns a result with `dry_run`, `validation`, and a
        `preview` of prompt actions."""
        if not dry_run:
            await self.prompt_config.authorize_mutation(workspace_id, created_by_id)
        self._guard_envelope(bundle)
        data = bundle.get("data") or {}

        pipeline_config = data.get("pipeline_config")
        if not isinstance(pipeline_config, dict) or not pipeline_config:
            raise BadRequestError(
                "bundle.data.pipeline_config is required and must be an object"
            )

        pipeline_errors = [
            dict(e)
            for e in validate_pipeline_config(pipeline_config)
            if e.get("severity", "error") == "error"
        ]

        prompt_configs = data.get("prompt_configs") or []
        team_id_by_slug = await self._resolve_team_slugs(
            workspace_id, prompt_configs
        )
        preview = await self._preview_prompts(
            workspace_id, prompt_configs, team_id_by_slug
        )

        result = {
            "schema_version": SCHEMA_VERSION,
            "dry_run": dry_run,
            "validation": {
                "pipeline_errors": pipeline_errors,
                "missing_teams": sorted(
                    {
                        p.get("team_slug")
                        for p in prompt_configs
                        if p.get("team_slug")
                        and team_id_by_slug.get(p["team_slug"]) is None
                    }
                ),
            },
            "preview": {
                "pipeline_will_update": True,
                "prompts": preview,
            },
        }

        if dry_run:
            return result

        # ---- commit path: guard, then apply atomically in the request txn ----
        if pipeline_errors:
            raise ValidationError(detail=pipeline_errors)

        missing = result["validation"]["missing_teams"]
        if missing:
            raise ValidationError(
                f"bundle references teams not in target workspace: {missing}"
            )

        expected_version = data.get("expected_pipeline_version")
        await self.workspace_config.update_config(
            workspace_id,
            WorkspaceConfigUpdate(
                pipeline_config=pipeline_config,
                expected_version=expected_version,
            ),
            actor_id=created_by_id,
        )

        await self._apply_prompts(
            workspace_id, created_by_id, prompt_configs, team_id_by_slug, preview
        )
        return result

    def _guard_envelope(self, bundle: dict) -> None:
        if not isinstance(bundle, dict):
            raise BadRequestError("bundle must be a JSON object")
        schema_version = bundle.get("schema_version")
        if schema_version != SCHEMA_VERSION:
            raise BadRequestError(
                f"unsupported bundle schema_version {schema_version!r} "
                f"(this backend supports {SCHEMA_VERSION})"
            )
        entity_type = bundle.get("entity_type")
        if entity_type != "pipeline_bundle":
            raise BadRequestError(
                f"expected entity_type 'pipeline_bundle', got {entity_type!r}"
            )

    async def _resolve_team_slugs(
        self, workspace_id: uuid.UUID, prompt_configs: list[dict]
    ) -> dict[str, uuid.UUID | None]:
        slugs = {
            p["team_slug"]
            for p in prompt_configs
            if isinstance(p, dict) and p.get("team_slug")
        }
        if not slugs:
            return {}
        rows = await self.db.execute(
            select(AgentTeam.slug, AgentTeam.id).where(
                AgentTeam.workspace_id == workspace_id,
                AgentTeam.slug.in_(slugs),
            )
        )
        found = {slug: tid for slug, tid in rows.all()}
        # Slugs with no match map to None so the caller can flag missing teams.
        return {slug: found.get(slug) for slug in slugs}

    async def _preview_prompts(
        self,
        workspace_id: uuid.UUID,
        prompt_configs: list[dict],
        team_id_by_slug: dict[str, uuid.UUID | None],
    ) -> dict:
        """Classify each incoming prompt as created / updated / skipped without
        mutating anything. `updated` = exists with different content; `skipped` =
        exists with identical content (idempotent re-import)."""
        created: list[dict] = []
        updated: list[dict] = []
        skipped: list[dict] = []
        for p in prompt_configs:
            if not isinstance(p, dict) or not p.get("slug"):
                continue
            team_id = (
                team_id_by_slug.get(p["team_slug"]) if p.get("team_slug") else None
            )
            existing = await self.prompt_config.repo.get_by_scope_slug(
                workspace_id=workspace_id,
                team_id=team_id,
                team_role=p.get("team_role"),
                stage=p.get("stage"),
                slug=p["slug"],
            )
            entry = {"slug": p["slug"], "stage": p.get("stage")}
            if existing is None:
                created.append(entry)
            elif existing.content != p.get("content"):
                updated.append(entry)
            else:
                skipped.append(entry)
        return {"created": created, "updated": updated, "skipped": skipped}

    async def _apply_prompts(
        self,
        workspace_id: uuid.UUID,
        created_by_id: uuid.UUID,
        prompt_configs: list[dict],
        team_id_by_slug: dict[str, uuid.UUID | None],
        preview: dict,
    ) -> None:
        """Create new prompts; update content on existing rows whose content
        differs. Identical rows are left untouched (idempotent)."""
        updated_keys = {(e["slug"], e["stage"]) for e in preview["updated"]}
        for p in prompt_configs:
            if not isinstance(p, dict) or not p.get("slug"):
                continue
            team_id = (
                team_id_by_slug.get(p["team_slug"]) if p.get("team_slug") else None
            )
            key = (p["slug"], p.get("stage"))
            if key in updated_keys:
                existing = await self.prompt_config.repo.get_by_scope_slug(
                    workspace_id=workspace_id,
                    team_id=team_id,
                    team_role=p.get("team_role"),
                    stage=p.get("stage"),
                    slug=p["slug"],
                )
                if existing is not None:
                    from app.schemas.agents.prompt_config import PromptConfigUpdate

                    await self.prompt_config.update_config(
                        existing.id,
                        PromptConfigUpdate(content=p.get("content")),
                        workspace_id=workspace_id,
                        actor_id=created_by_id,
                    )
                continue
            # create_config is idempotent on scope-slug — skipped rows no-op.
            await self.prompt_config.create_config(
                workspace_id,
                PromptConfigCreate(
                    name=p.get("name") or p["slug"],
                    slug=p["slug"],
                    agent_type=p.get("agent_type"),
                    team_role=p.get("team_role"),
                    stage=p.get("stage"),
                    content=p.get("content") or "",
                    team_id=team_id,
                ),
                created_by_id,
            )
