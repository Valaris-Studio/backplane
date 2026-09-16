# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""P4: portable loop-template bundle (spec f52328b3 §7 + Q5).

"Share" v1 is a FILE. A template proven in one workspace travels to another as
one JSON envelope (`entity_type="loop_template"`), the same unit pipelines
already use — so backup, promotion and hand-off need no new transport.

What travels is the AUTHORED artifact and nothing else:

  - content (kernels, slots, rails, tools, setup contract) and profile;
  - lineage by `{slug, version, source_workspace_slug}` — never UUIDs, which
    mean nothing in the receiving workspace (operator direction, F12);
  - `leak_findings`, so the importer sees the same repo-fact warnings the
    exporter saw instead of discovering them after binding a board.

What deliberately does NOT travel: the track record, board names, and ids.
Those are facts about the ORIGIN's boards; a bundle carrying them would be one
workspace's loop wearing a template's clothes.

Import is defensive, in this order:
  1. Envelope guard — schema_version + entity_type (400 otherwise), so a
     pipeline bundle can never be applied as a template.
  2. Content validation — the same `validate_template` pass the manager runs.
     A dry run REPORTS the findings; a commit refuses them (422), because an
     unrenderable template must not be parked in someone else's workspace.
  3. dry_run=True mutates NOTHING and returns the action it would take.
  4. The commit lands a DRAFT — version 0, published half untouched. Publishing
     stays a separate explicit act by someone in the receiving workspace
     (Q6/F9), so an import can never change what a running board executes.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from app.exceptions import BadRequestError, ValidationError
from app.models.config_template import ConfigTemplate
from app.services.export.envelope import SCHEMA_VERSION, build_envelope
from app.services.loop_template import TEMPLATE_KIND, LoopTemplateService
from app.services.loop_template_lint import lint_template_content
from app.schemas.loop_template import LoopTemplateProfile
from app.services.loop_template_render import (
    SLOT_VALUE_MAX_BYTES,
    TemplateContent,
    validate_template,
)

from sqlalchemy.ext.asyncio import AsyncSession

ENTITY_TYPE = "loop_template"

# The fields whose text a human reads to decide whether an import is the change
# they meant. Compared field-by-field so the summary names WHAT differs rather
# than reporting one opaque "content changed".
_DIFFED_FIELDS = ("system_prompt", "loop_prompt")


# Matched to SLOT_VALUE_MAX_BYTES rather than invented: a profile is human-
# facing identity (emoji, tagline, tags), so the same bound that holds one slot
# value is already generous, and a shared number keeps the two caps from
# drifting into a confusing pair.
PROFILE_MAX_BYTES = SLOT_VALUE_MAX_BYTES


class LoopTemplateBundleService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.templates = LoopTemplateService(db)

    # ------------------------------------------------------------------ export

    async def build_bundle(
        self, workspace_id: uuid.UUID, workspace_slug: str, ref: str
    ) -> dict[str, Any]:
        """Assemble the portable envelope for one template.

        Exporting a SYSTEM template is allowed — it is the natural way to fork
        a shipped loop — and is marked `is_system_origin` so the receiving side
        knows the draft it gets started life as code, not as someone's edit.
        """
        detail = await self.templates.get(
            workspace_id, ref, draft=True, include_archived=True
        )
        content = detail["content"] or {}

        return build_envelope(
            entity_type=ENTITY_TYPE,
            source_workspace_slug=workspace_slug,
            data={
                "slug": detail["slug"],
                "name": detail["name"],
                "kind": TEMPLATE_KIND,
                "version": detail["version"],
                "is_system_origin": bool(detail["is_system"]),
                "profile": detail["profile"] or {},
                "content": content,
                "lineage": {
                    "source": "export",
                    "slug": detail["slug"],
                    "version": detail["version"],
                    "source_workspace_slug": workspace_slug,
                },
                # Carried, not enforced: the lint warns and never blocks, and
                # the receiving operator is the one who can judge whether a
                # repo fact is a leak or the point of that slot.
                "leak_findings": lint_template_content(content),
            },
        )

    # ------------------------------------------------------------------ import

    async def import_bundle(
        self,
        workspace_id: uuid.UUID,
        created_by_id: uuid.UUID,
        bundle: dict,
        *,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        """Validate and (unless `dry_run`) apply a bundle as a DRAFT.

        `dry_run` defaults to False here and True on the route, mirroring the
        pipeline precedent exactly: a service call is explicit about writing,
        while an HTTP caller must opt IN to mutation.
        """
        self._guard_envelope(bundle)
        data = bundle.get("data") or {}

        slug = data.get("slug")
        if not slug or not isinstance(slug, str):
            raise BadRequestError("bundle.data.slug is required")

        content = data.get("content")
        if not isinstance(content, dict):
            raise BadRequestError(
                "bundle.data.content is required and must be an object"
            )

        findings = self._validate_content(content)
        existing = await self.templates.repo.get_by_slug(
            workspace_id, TEMPLATE_KIND, slug
        )
        action = "updated" if existing is not None else "created"

        result: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "dry_run": dry_run,
            "action": action,
            "slug": slug,
            "findings": findings,
            "diff_summary": self._diff_summary(existing, content),
            "leak_findings": lint_template_content(content),
            "template_id": None,
        }

        if dry_run:
            return result

        # A preview SHOWS problems; a commit refuses them. Same findings, and
        # the decision about what to do with them belongs to the caller.
        if findings:
            raise ValidationError(detail=findings)

        row = await self._apply(
            workspace_id,
            created_by_id,
            data=data,
            slug=slug,
            content=content,
            existing=existing,
        )
        result["template_id"] = str(row.id)
        return result

    # ----------------------------------------------------------------- helpers

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
        if entity_type != ENTITY_TYPE:
            raise BadRequestError(
                f"expected entity_type {ENTITY_TYPE!r}, got {entity_type!r}"
            )

    @staticmethod
    def _validate_content(content: dict) -> list[dict]:
        """The manager's own validation pass, reused verbatim.

        A malformed `content` is a bundle-level error rather than a finding:
        there is no template to report findings ABOUT.
        """
        try:
            parsed = TemplateContent.model_validate(content)
        except Exception as exc:
            raise BadRequestError(f"bundle.data.content is not a valid template: {exc}")
        return [dict(error) for error in validate_template(parsed)]

    @staticmethod
    def _validate_profile(data: dict) -> dict:
        """The profile is stored verbatim, so it is bounded HERE or nowhere.

        Content already has caps and a schema; the profile had neither, which
        let an import park an arbitrary object in the column the Library page
        renders. Validation only REJECTS — `LoopTemplateProfile` is
        `extra="allow"`, so an unknown future key must survive a round-trip
        rather than be normalized away.
        """
        profile = data.get("profile")
        if profile is None:
            return {}
        if not isinstance(profile, dict):
            raise BadRequestError("bundle.data.profile must be an object")
        size = len(json.dumps(profile, default=str).encode())
        if size > PROFILE_MAX_BYTES:
            raise BadRequestError(
                f"bundle.data.profile is {size} bytes, over {PROFILE_MAX_BYTES}"
            )
        try:
            LoopTemplateProfile.model_validate(profile)
        except Exception as exc:
            raise BadRequestError(
                f"bundle.data.profile is not a valid profile: {exc}"
            ) from exc
        return profile

    @staticmethod
    def _diff_summary(existing: ConfigTemplate | None, content: dict) -> list[str]:
        """What an operator would see change, in words, before committing.

        Compared against the DRAFT half — the half an import overwrites — so
        the summary describes the write that is actually about to happen.
        """
        if existing is None:
            return []
        current = existing.draft_content or {}
        return [
            field
            for field in _DIFFED_FIELDS
            if (current.get(field) or "") != (content.get(field) or "")
        ]

    async def _apply(
        self,
        workspace_id: uuid.UUID,
        created_by_id: uuid.UUID,
        *,
        data: dict,
        slug: str,
        content: dict,
        existing: ConfigTemplate | None,
    ) -> ConfigTemplate:
        lineage = {
            "source": "import",
            "slug": data.get("lineage", {}).get("slug", slug)
            if isinstance(data.get("lineage"), dict)
            else slug,
            "version": data.get("version", 0),
            "source_workspace_slug": (
                data.get("lineage", {}).get("source_workspace_slug")
                if isinstance(data.get("lineage"), dict)
                else None
            ),
        }
        profile = self._validate_profile(data)
        name = data.get("name") or slug

        if existing is None:
            return await self.templates.create_draft(
                workspace_id,
                actor_id=created_by_id,
                data={
                    "slug": slug,
                    "name": name,
                    "profile": profile,
                    "content": content,
                    "lineage": lineage,
                },
            )

        # Update the DRAFT half only. `expected_updated_at=None` on purpose:
        # an import is not an interactive edit racing another editor, and
        # demanding a lock token would make the file unusable from a script.
        await self.templates.update_draft(
            workspace_id,
            str(existing.id),
            # Deliberately WITHOUT lineage: provenance is written once, by the
            # create branch, and `update_draft` maps only name/profile/content
            # — so passing it here would be a key nobody reads, and rewriting
            # it on every pass would let a doctored bundle relabel where an
            # existing template came from.
            data={"name": name, "profile": profile, "content": content},
            expected_updated_at=None,
        )
        return existing
