# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Loop templates — the backend-authoritative catalog and draft lifecycle.

Two populations share one surface. **System** templates are defined in code
(`app.services.loop_templates`), versioned with the app, and are read-only:
there is no row to write to, so every mutation against a system ref is a 404.
**Workspace** templates are `config_templates` rows with a published half
(`version`/`content`/`profile`) and a draft half (`draft_content`/
`draft_profile`), edited freely and promoted by an explicit publish.

`ref` grammar, per the card's Direction: a system template is addressed by its
SLUG, a workspace template by its full UUID. The two namespaces never mix — a
slug is never resolved against the rows, and a UUID is never resolved against
the code catalog — so a template cannot be shadowed by naming a row after a
system slug.

Locks differ by half because the two halves change at different rates. The
draft autosaves, so it carries a timestamp lock (`expected_updated_at`); the
published half moves only on publish, so it carries the coarser integer lock
(`expected_version`), matching the loop-config idiom next door.
"""

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.core.events import CONFIG_CHANGED
from app.exceptions import ConflictError, ResourceNotFoundError, ValidationError
from app.models.activity import ActivityAction, ActivityEntityType
from app.models.config_template import ConfigTemplate
from app.repositories.agents.execution import ExecutionRepository
from app.repositories.config_template import (
    BoardLoopTemplateBindingRepository,
    ConfigTemplateRepository,
)
from app.services.loop_config_validation import SLOT_PATTERN
from app.services.loop_template_lint import Finding, lint_template_content
from app.services.loop_template_stamp import count_outcomes, template_key
from app.services.loop_template_render import TemplateContent, validate_template
from app.services import loop_templates as system_catalog
from app.services.loop_templates import get_system_template

logger = logging.getLogger(__name__)

TEMPLATE_KIND = "loop"

# Forking the same template repeatedly is normal (an operator tries a variation,
# discards it, tries again), so the probe has to tolerate a long tail. It is
# still bounded: without a cap a workspace holding every candidate would spin
# the request instead of failing it.
MAX_COPY_SLUG_ATTEMPTS = 50

SORT_KEYS = ("name", "updated_at", "boards_using")

# The service's catalog method is `list()` per the card's API, which shadows the
# builtin inside the class body and breaks every `list[...]` annotation after
# it. Annotate against this alias instead of renaming the public method.
Summaries = list
# `LoopTemplateService.list` shadows the builtin inside the class body, so
# `list[...]` in a method annotation there subscripts the METHOD. These aliases
# are the module's existing way around it — see `Summaries` above.
Findings = list


def _naive_utc_now() -> datetime:
    """Match the columns' own defaults, which store naive UTC."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _lock_token(row: ConfigTemplate) -> str | None:
    """The ONE value `expected_updated_at` is compared against.

    Every wire shape that hands a client a lock token, and the lock check
    itself, go through here — the two must never be able to drift onto
    different clocks again (card 65714512).
    """
    return row.draft_updated_at.isoformat() if row.draft_updated_at else None


def _draft_name(row: ConfigTemplate) -> str:
    """The name the EDITOR is working on — pending rename, else the live one.

    `draft_name` is NULL on every row that has not been renamed since its last
    publish, which is most of them, so this fallback is the common path rather
    than an edge case. Routing every draft-half name read through here is what
    keeps the serializer, the divergence check and publish from drifting onto
    different answers (the shape card 65714512 imposed on the lock token).
    """
    return row.draft_name if row.draft_name is not None else row.name


def _has_unpublished_changes(row: ConfigTemplate) -> bool:
    """Does the draft half differ from what was last published?

    Distinct from `is_draft`, which answers "was this EVER published". A
    published template whose draft has since moved is neither a draft nor
    clean, and the Library badge and the editor's unsaved-work hint both need
    that third state. An unpublished row is by definition not yet divergent —
    its `is_draft` already says everything there is to say.
    """
    if row.version == 0:
        return False
    return (
        (row.draft_content or {}) != (row.content or {})
        or (row.draft_profile or {}) != (row.profile or {})
        or _draft_name(row) != row.name
    )


def _default_copy_name(source_name: str, copy_ordinal: int) -> str:
    """Name the copy so it agrees with the slug the probe landed on.

    The first fork is "(copy)" rather than "(copy 1)" because that is what the
    slug says too — `-copy`, not `-copy-1`.
    """
    suffix = "(copy)" if copy_ordinal == 1 else f"(copy {copy_ordinal})"
    return f"{source_name} {suffix}"


def _as_uuid(ref: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(ref))
    except (ValueError, AttributeError, TypeError):
        return None


def _content_has_slots(content: dict[str, Any] | None) -> bool:
    if not content:
        return False
    return any(
        SLOT_PATTERN.search(content.get(field) or "")
        for field in ("system_prompt", "loop_prompt")
    )


class LoopTemplateService:
    """Business rules for the loop-template catalog.

    Holds the union, the uniqueness message, the lineage shape and both locks;
    the repositories below it stay pure data access.
    """

    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = ConfigTemplateRepository(db)
        self.bindings = BoardLoopTemplateBindingRepository(db)

    # --- listing --------------------------------------------------------

    async def list(
        self,
        workspace_id: uuid.UUID,
        *,
        q: str | None = None,
        sort: str = "name",
        include_archived: bool = False,
    ) -> list[dict[str, Any]]:
        """System summaries first, then workspace rows, each block sorted.

        The two blocks are never interleaved: the Library page renders them as
        separate sections, and a global sort would scatter the system trio
        through the workspace list.
        """
        usage = await self._binding_usage(workspace_id)

        # Read the catalog through the MODULE, not a from-import: the binding
        # is what tests patch to prove `has_slots` is derived rather than
        # hardcoded, and a from-import would freeze the list at import time.
        #
        # `listed` is filtered HERE rather than via `listed_templates()` for the
        # same reason: the helper closes over the unpatched module-level list,
        # so a patched catalog would be ignored.
        system = [
            self._system_summary(template, usage)
            for template in system_catalog.LOOP_TEMPLATES
            if template.listed
        ]
        rows = await self.repo.list_by_workspace(
            workspace_id, TEMPLATE_KIND, include_archived=include_archived, q=q
        )
        workspace = [self._row_summary(row, usage) for row in rows]

        if q:
            needle = q.casefold()
            system = [
                summary
                for summary in system
                if needle in summary["name"].casefold()
                or needle in summary["id"].casefold()
            ]

        return [*self._sorted(system, sort), *self._sorted(workspace, sort)]

    @staticmethod
    def _sorted(summaries: Summaries, sort: str) -> Summaries:
        if sort == "boards_using":
            return sorted(
                summaries, key=lambda s: (-s["boards_using"], s["name"].casefold())
            )
        if sort == "updated_at":
            # Nulls last: a system template has no row and so no mtime, and
            # sorting None against a datetime raises rather than degrading.
            return sorted(
                summaries,
                key=lambda s: (s["updated_at"] is None, s["updated_at"] or ""),
                reverse=False,
            )
        return sorted(summaries, key=lambda s: s["name"].casefold())

    async def _binding_usage(self, workspace_id: uuid.UUID) -> dict[str, int]:
        """How many boards are bound to each template, keyed as the ref is.

        System bindings carry a slug and workspace bindings carry a row id, so
        one dict serves both populations without a second query.
        """
        counts: dict[str, int] = {}
        for binding in await self.bindings.list_for_workspace(workspace_id):
            ref = binding.template_ref or {}
            key = ref.get("id") if ref.get("source") == "workspace" else ref.get("slug")
            if key:
                counts[str(key)] = counts.get(str(key), 0) + 1
        return counts

    def _system_summary(self, template, usage: dict[str, int]) -> dict[str, Any]:
        return {
            "id": template.slug,
            "source": "system",
            "name": template.name,
            "version": template.version,
            "is_system": True,
            "is_draft": False,
            "has_slots": template.has_slots,
            "profile": dict(template.profile),
            "boards_using": usage.get(template.slug, 0),
            "last_used_at": None,
            "updated_at": None,
            # Code-defined: no draft half exists, so there is nothing to lock
            # and nothing that can diverge.
            "draft_updated_at": None,
            "has_unpublished_changes": False,
            **self._p0_compat(
                description=template.description,
                content=template.content.model_dump(),
            ),
        }

    @staticmethod
    def _p0_compat(*, description: str, content: dict[str, Any]) -> dict[str, Any]:
        """The P0 listing fields the shipped Loop dialog still reads.

        `BoardLoopDialog` applies a template straight from the LISTING — it
        copies `system_prompt`/`loop_prompt`/`tools` into the raw textareas and
        re-derives `hasSlots()` from the prompt text rather than trusting the
        marker. Dropping these when the listing gained summary fields would
        have broken template selection in production, so the listing is a
        superset: summary fields for the new Library, content fields for the
        existing dialog. The manager reads content from `GET /{ref}`; these
        stay until that dialog is replaced by the bind step (p3-05).
        """
        return {
            "description": description,
            "system_prompt": content.get("system_prompt", ""),
            "loop_prompt": content.get("loop_prompt", ""),
            "tools": list(content.get("tools") or []),
        }

    def _row_summary(
        self, row: ConfigTemplate, usage: dict[str, int]
    ) -> dict[str, Any]:
        published = row.version > 0
        return {
            "id": str(row.id),
            "source": "workspace",
            # Published-half view, matching the content/profile picks below: the
            # Library names what boards actually RUN, so a pending rename shows
            # only as the `has_unpublished_changes` pill until it is published.
            "name": row.name if published else _draft_name(row),
            "version": row.version,
            "is_system": False,
            "is_draft": not published,
            "has_slots": _content_has_slots(
                row.content if published else row.draft_content
            ),
            "profile": dict(row.profile or row.draft_profile or {}),
            "boards_using": usage.get(str(row.id), 0),
            **self._p0_compat(
                description=(row.profile or row.draft_profile or {}).get("tagline", ""),
                content=(row.content if published else row.draft_content) or {},
            ),
            "last_used_at": None,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
            "draft_updated_at": _lock_token(row),
            "has_unpublished_changes": _has_unpublished_changes(row),
        }

    # --- reads ----------------------------------------------------------

    async def get(
        self,
        workspace_id: uuid.UUID,
        ref: str,
        *,
        draft: bool = False,
        include_archived: bool = False,
    ) -> dict[str, Any]:
        template = get_system_template(ref)
        if template is not None:
            return {
                "id": template.slug,
                "slug": template.slug,
                "source": "system",
                "name": template.name,
                "version": template.version,
                "is_system": True,
                "is_draft": False,
                "profile": dict(template.profile),
                "content": template.content.model_dump(),
                "lineage": None,
                "updated_at": None,
                "draft_updated_at": None,
                "has_unpublished_changes": False,
            }

        row = await self._get_row(workspace_id, ref, include_archived=include_archived)
        published = row.version > 0
        show_draft = draft or not published
        return {
            "id": str(row.id),
            # The ref grammar keeps `id` a UUID for workspace rows; `slug` is the
            # canonical human name that lineage and the `-copy` default need.
            "slug": row.slug,
            "source": "workspace",
            "name": _draft_name(row) if show_draft else row.name,
            "version": row.version,
            "is_system": False,
            "is_draft": not published,
            "profile": dict((row.draft_profile if show_draft else row.profile) or {}),
            "content": dict((row.draft_content if show_draft else row.content) or {}),
            "lineage": row.lineage,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
            "draft_updated_at": _lock_token(row),
            "has_unpublished_changes": _has_unpublished_changes(row),
        }

    async def resolve_for_binding(
        self, workspace_id: uuid.UUID, ref: str, version: int | None = None
    ) -> dict[str, Any]:
        """The exact content a board should be bound to, plus its identity.

        Distinct from `get()` because binding needs three things the read model
        does not carry: the SLUG (the read model exposes only the uuid), the
        PUBLISHED content specifically (never the draft — an unpublished edit
        must not reach a running loop), and an arbitrary historical version.
        """
        row = await self._get_row(workspace_id, ref)
        if not row.version:
            raise ValidationError(
                detail=[
                    {
                        "code": "template_not_published",
                        "field": "template.ref",
                        "message": (
                            f"{row.slug} has no published version to bind — "
                            "publish it first"
                        ),
                    }
                ]
            )

        content = dict(row.content or {})
        bound_version = row.version
        if version is not None and version != row.version:
            snapshot = await self.repo.get_version(row.id, version)
            if snapshot is None:
                raise ResourceNotFoundError(
                    f"Version {version} of {row.slug} not found"
                )
            content = dict(snapshot.content or {})
            bound_version = version

        return {
            "id": str(row.id),
            "slug": row.slug,
            "version": bound_version,
            "latest_version": row.version,
            "content": content,
        }

    async def list_versions(self, workspace_id: uuid.UUID, ref: str) -> Summaries:
        """Published history, newest first — as wire-shaped dicts, never ORM rows.

        A system template has no version rows: that is an EMPTY history, not a
        missing template, and every per-tab endpoint must serve both sources
        (the Versions tab 404'd for every system template until it did).
        """
        if get_system_template(ref) is not None:
            return []
        row = await self._get_row(workspace_id, ref, include_archived=True)
        return [
            {
                "version": v.version,
                "published_at": v.published_at.isoformat(),
                "note": v.note,
            }
            for v in await self.repo.list_versions(row.id)
        ]

    async def profile(self, workspace_id: uuid.UUID, ref: str) -> dict[str, Any]:
        """The profile page: what this template IS, plus how it has DONE.

        The track record is derived from stamped executions rather than stored
        (spec §2.3), so it cannot drift from reality and survives detach,
        rebind and upgrade — a counter on the template row would lose its
        history the moment a board detached.
        """
        template = await self.get(workspace_id, ref, include_archived=True)
        content = TemplateContent(**(template["content"] or {}))

        usage = await self._binding_usage(workspace_id)
        versions = await self.list_versions(workspace_id, ref)

        return {
            "id": template["id"],
            "slug": template["slug"],
            "source": template["source"],
            "name": template["name"],
            "version": template["version"],
            "is_system": template["is_system"],
            "profile": template["profile"],
            "boards_using": usage.get(str(template["id"]), 0),
            "versions": versions,
            "rails_defaults": content.rails_defaults,
            "tools": content.tools,
            "slots": [slot.model_dump() for slot in content.slots],
            "setup_contract": content.setup_contract,
            "track_record": await self._track_record(workspace_id, template),
        }

    async def _track_record(
        self, workspace_id: uuid.UUID, template: dict[str, Any]
    ) -> dict[str, Any]:
        """Aggregate the executions this template's exact version rendered."""
        key = template_key(
            template["source"], template["slug"], int(template["version"])
        )
        stats = await ExecutionRepository(self.db).loop_iteration_stats_by_template(
            workspace_id, key
        )
        outcomes = count_outcomes(stats.pop("output_summaries"))
        last_used_at = stats["last_used_at"]

        return {
            **stats,
            "last_used_at": last_used_at.isoformat() if last_used_at else None,
            "boards": [
                {**board, "board_id": str(board["board_id"])}
                for board in stats["boards"]
            ],
            "outcomes": outcomes,
            # The loop terminating ITSELF is the run-quality signal the profile
            # page leads with, so it is named rather than left for the reader
            # to pick out of the outcome tally.
            "self_terminations": outcomes["objective_complete"],
        }

    # --- draft lifecycle ------------------------------------------------

    async def create_draft(
        self,
        workspace_id: uuid.UUID,
        *,
        actor_id: uuid.UUID | None,
        data: dict[str, Any],
    ) -> ConfigTemplate:
        """A new template starts unpublished: version 0, no published content.

        Deliberately NOT idempotent. A repeated slug is an authoring mistake
        (two operators naming the same thing), not a retried agent call, so it
        409s rather than returning the existing row and silently discarding the
        second author's content.
        """
        slug = data["slug"]
        await self._require_slug_free(workspace_id, slug)

        row = await self.repo.create(
            workspace_id=workspace_id,
            kind=TEMPLATE_KIND,
            slug=slug,
            name=data["name"],
            version=0,
            profile=None,
            content=None,
            draft_profile=data.get("profile") or {},
            draft_content=data.get("content") or {},
            draft_updated_at=_naive_utc_now(),
            lineage=data.get("lineage"),
            created_by_id=actor_id,
        )
        await self._record_activity(
            row,
            action="created",
            summary=f"created loop template {row.slug}@v{row.version}",
            message_key="activity.loop_template.created",
            message_params={
                "template_slug": row.slug,
                "template_version": row.version,
            },
            activity_action=ActivityAction.created,
            actor_id=actor_id,
        )
        return row

    async def update_draft(
        self,
        workspace_id: uuid.UUID,
        ref: str,
        *,
        data: dict[str, Any],
        expected_updated_at: str | None,
    ) -> ConfigTemplate:
        """Autosave the draft half under a timestamp lock.

        `expected_updated_at` is optional so the first save after a load — and
        every non-UI caller — need not carry one; when present it must match
        the stamp the caller was handed, or a second editor's work would be
        overwritten without either of them seeing a conflict.
        """
        row = await self._get_row(workspace_id, ref, include_archived=True)
        # Cheap pre-check: turns an obviously-stale token into a 409 without a
        # write attempt, and is the only thing that can reject a token that
        # never parses. It is NOT the lock — the UPDATE predicate below is.
        self._check_draft_lock(row, expected_updated_at)

        updates: dict[str, Any] = {"draft_updated_at": _naive_utc_now()}
        if "name" in data:
            # The draft half, like every other autosaved field — a rename must
            # not reach the boards still running the published template.
            updates["draft_name"] = data["name"]
        if "profile" in data:
            updates["draft_profile"] = data["profile"] or {}
        if "content" in data:
            updates["draft_content"] = data["content"] or {}

        won = await self.repo.update_draft_if_unchanged(
            row.id,
            expected_draft_updated_at=row.draft_updated_at
            if expected_updated_at is not None
            else None,
            values=updates,
        )
        if not won:
            # Another editor committed between our read and our write. The row
            # object is stale by definition, so re-read it to report the token
            # the caller must reload from.
            await self.db.refresh(row)
            raise ConflictError(
                "Draft has changed since it was loaded",
                error_code="stale_draft",
                context={"current_draft_updated_at": _lock_token(row)},
            )

        # No refresh on the winning path: the UPDATE synchronizes this
        # session's row itself, so the object already carries the new values.
        return row

    async def publish(
        self,
        workspace_id: uuid.UUID,
        ref: str,
        *,
        expected_version: int | None = None,
        note: str | None = None,
        actor_id: uuid.UUID | None = None,
    ) -> ConfigTemplate:
        """Promote the draft, snapshot it, and bump the version.

        Validation runs BEFORE anything is written so a rejected publish leaves
        the row exactly as it was — a half-published template would be bound to
        boards that then render prompts nobody approved.
        """
        row = await self._get_row(workspace_id, ref, include_archived=True)
        if expected_version is not None and row.version != expected_version:
            raise ConflictError(
                f"Template version mismatch: expected {expected_version}, "
                f"current {row.version}",
                error_code="stale_version",
                context={
                    "current_version": row.version,
                    "expected_version": expected_version,
                },
            )

        findings = validate_template(TemplateContent(**(row.draft_content or {})))
        blocking = [f for f in findings if f.get("severity", "error") == "error"]
        if blocking:
            raise ValidationError(detail=[dict(f) for f in blocking])

        next_version = row.version + 1
        await self.repo.add_version(
            template_id=row.id,
            version=next_version,
            profile=dict(row.draft_profile or {}),
            content=dict(row.draft_content or {}),
            published_by_id=actor_id,
            note=note,
        )
        # Publishing moves the draft half too: it rebases the lock token, so an
        # editor still holding a pre-publish token gets its conflict instead of
        # silently autosaving over the content that was just approved.
        updated = await self.repo.update(
            row,
            version=next_version,
            name=_draft_name(row),
            # Back to NULL: the pending rename has landed, so the row is once
            # again "not renamed since its last publish" and every draft-half
            # reader falls through to the name just published.
            draft_name=None,
            profile=dict(row.draft_profile or {}),
            content=dict(row.draft_content or {}),
            draft_updated_at=_naive_utc_now(),
        )
        await self._record_activity(
            updated,
            action="published",
            summary=f"published loop template {updated.slug}@v{updated.version}",
            message_key="activity.loop_template.published",
            message_params={
                "template_slug": updated.slug,
                "template_version": updated.version,
            },
            activity_action=ActivityAction.published,
            actor_id=actor_id,
        )
        return updated

    async def duplicate(
        self,
        workspace_id: uuid.UUID,
        ref: str,
        *,
        actor_id: uuid.UUID | None,
        new_slug: str | None = None,
        new_name: str | None = None,
    ) -> ConfigTemplate:
        """Copy any template — system or workspace — into a fresh draft.

        The copy records where it came from so a later drift check can tell an
        operator their fork is now three versions behind its ancestor.
        """
        source = await self.get(workspace_id, ref, include_archived=True)
        source_slug = source["slug"]
        # The slug probe is read-then-write, so a concurrent duplicate of the
        # same source can take the slug between the two; the unique constraint
        # then fires at flush. A savepoint keeps that from poisoning the
        # request transaction: the loser re-probes (derived slug) or reports
        # the conflict (explicit slug) instead of surfacing a 500.
        for _ in range(MAX_COPY_SLUG_ATTEMPTS):
            if new_slug:
                # The caller named it. Silently renaming their choice would be
                # worse than the conflict: they would not learn the slug is taken.
                slug = new_slug
                await self._require_slug_free(workspace_id, slug)
                copy_ordinal = 1
            else:
                slug, copy_ordinal = await self._derive_free_copy_slug(
                    workspace_id, source_slug
                )
            name = new_name or _default_copy_name(source["name"], copy_ordinal)
            try:
                async with self.db.begin_nested():
                    copy = await self.repo.create(
                        workspace_id=workspace_id,
                        kind=TEMPLATE_KIND,
                        slug=slug,
                        name=name,
                        version=0,
                        profile=None,
                        content=None,
                        draft_profile=dict(source["profile"] or {}),
                        draft_content=dict(source["content"] or {}),
                        draft_updated_at=_naive_utc_now(),
                        lineage={
                            "source": source["source"],
                            "slug": source_slug,
                            "version": source["version"],
                        },
                        created_by_id=actor_id,
                    )
                break
            except IntegrityError:
                if new_slug:
                    raise ConflictError(
                        f"A loop template with slug {slug!r} already exists "
                        "in this workspace",
                        error_code="slug_taken",
                        error_params={"slug": slug},
                        context={"slug": slug},
                    ) from None
        else:
            raise ConflictError(
                f"Could not derive a free slug for a copy of {source_slug!r} "
                f"after {MAX_COPY_SLUG_ATTEMPTS} attempts",
                error_code="slug_taken",
                error_params={"slug": f"{source_slug}-copy"},
                context={"slug": f"{source_slug}-copy"},
            )
        # A duplicate is a new template, not a mutation of its ancestor: the
        # event names the COPY so the library refreshes on the row that
        # actually appeared.
        await self._record_activity(
            copy,
            action="created",
            summary=f"created loop template {copy.slug}@v{copy.version}",
            message_key="activity.loop_template.created",
            message_params={
                "template_slug": copy.slug,
                "template_version": copy.version,
            },
            activity_action=ActivityAction.created,
            actor_id=actor_id,
        )
        return copy

    async def archive(
        self,
        workspace_id: uuid.UUID,
        ref: str,
        *,
        actor_id: uuid.UUID | None = None,
    ) -> ConfigTemplate:
        row = await self._get_row(workspace_id, ref, include_archived=True)
        archived = await self.repo.update(row, is_archived=True)
        await self._record_activity(
            archived,
            action="archived",
            summary=f"archived loop template {archived.slug}@v{archived.version}",
            message_key="activity.loop_template.archived",
            message_params={
                "template_slug": archived.slug,
                "template_version": archived.version,
            },
            activity_action=ActivityAction.archived,
            actor_id=actor_id,
        )
        return archived

    async def unarchive(
        self,
        workspace_id: uuid.UUID,
        ref: str,
        *,
        actor_id: uuid.UUID | None = None,
    ) -> ConfigTemplate:
        row = await self._get_row(workspace_id, ref, include_archived=True)
        restored = await self.repo.update(row, is_archived=False)
        await self._record_activity(
            restored,
            action="unarchived",
            summary=(
                f"unarchived loop template {restored.slug}@v{restored.version}"
            ),
            message_key="activity.loop_template.unarchived",
            message_params={
                "template_slug": restored.slug,
                "template_version": restored.version,
            },
            activity_action=ActivityAction.unarchived,
            actor_id=actor_id,
        )
        return restored

    async def restore_version(
        self,
        workspace_id: uuid.UUID,
        ref: str,
        version: int,
        *,
        actor_id: uuid.UUID | None = None,
    ) -> ConfigTemplate:
        """Stage an old snapshot as the draft — it does NOT republish.

        Leaving `version` alone is the point: restoring is an editing step, and
        bumping here would push old content to every bound board without anyone
        reviewing it.
        """
        row = await self._get_row(workspace_id, ref, include_archived=True)
        snapshot = await self.repo.get_version(row.id, version)
        if snapshot is None:
            raise ResourceNotFoundError(f"Version {version} not found")

        staged = await self.repo.update(
            row,
            draft_profile=dict(snapshot.profile or {}),
            draft_content=dict(snapshot.content or {}),
            draft_updated_at=_naive_utc_now(),
        )
        # The restored SNAPSHOT's number, not the row's published version —
        # "restored v3" is the operator's action; the row still publishes at
        # whatever it was.
        await self._record_activity(
            staged,
            action="restored",
            summary=f"restored loop template {staged.slug}@v{version}",
            message_key="activity.loop_template.restored",
            message_params={
                "template_slug": staged.slug,
                "template_version": version,
            },
            activity_action=ActivityAction.updated,
            actor_id=actor_id,
            version=version,
        )
        return staged

    async def lint(self, workspace_id: uuid.UUID, ref: str) -> Findings[Finding]:
        """Repo-fact warnings for the half an author is editing (spec F12).

        Reads the DRAFT half deliberately: the manager lints what is on screen,
        and linting the published half would report the state before the edit
        that prompted the check. A system template has only one half, so `get`
        serves the same content either way.
        """
        detail = await self.get(workspace_id, ref, draft=True, include_archived=True)
        return lint_template_content(detail["content"])

    # --- observability --------------------------------------------------

    async def _record_activity(
        self,
        row: ConfigTemplate,
        *,
        action: str,
        activity_action: ActivityAction,
        summary: str,
        message_key: str,
        message_params: dict,
        actor_id: uuid.UUID | None,
        version: int | None = None,
    ) -> None:
        """Announce a template mutation on the bus and in the activity log.

        Two surfaces because they answer different questions: the WS event
        drives live cache invalidation (`useLoopTemplateSync` filters on
        `entity`), while the activity row is the durable "who changed what,
        when" an operator reads days later — the bus keeps nothing.

        Best-effort by design: observability must never fail the write that
        produced it, so a dead bus or a rejected activity row is logged and
        swallowed. The template itself is already persisted by this point.
        """
        published_version = row.version if version is None else version
        try:
            await event_bus.publish(
                event_type=CONFIG_CHANGED,
                payload={
                    "entity": "loop_template",
                    "action": action,
                    "entity_id": str(row.id),
                    # `slug` and `version` extend the four-publisher
                    # {entity, action, entity_id} shape. Additive: consumers
                    # filter on `entity`, and these spare them a round-trip
                    # just to learn which template moved.
                    "slug": row.slug,
                    "version": published_version,
                },
                workspace_id=row.workspace_id,
            )
        except Exception:
            logger.exception("Failed to publish config.changed event")

        if actor_id is None:
            # ActivityService requires an actor (non-null FK). System-initiated
            # writes have none; the bus event above still fired.
            return
        try:
            from app.services.activity import ActivityService

            # SAVEPOINT, because the repository FLUSHES the audit row: a row the
            # database rejects fails inside THIS transaction, and on asyncpg that
            # aborts the whole thing (InFailedSQLTransactionError on every later
            # statement, get_db's commit degrading to a rollback). Catching the
            # exception is not enough — without the savepoint to roll back to,
            # "best-effort observability" would silently discard the template
            # write it was reporting on. One savepoint per call, inside the try.
            async with self.db.begin_nested():
                await ActivityService(self.db).record(
                    workspace_id=row.workspace_id,
                    actor_id=actor_id,
                    entity_type=ActivityEntityType.loop_template,
                    entity_id=row.id,
                    action=activity_action,
                    summary=summary,
                    # The key arrives from each literal callsite rather than
                    # being derived from `action`: the activity-message contract
                    # audits keys statically and an f-string key would be
                    # invisible to it.
                    message_key=message_key,
                    message_params=message_params,
                )
        except Exception:
            logger.exception("Failed to record loop-template activity")

    # --- internals ------------------------------------------------------

    async def _derive_free_copy_slug(
        self, workspace_id: uuid.UUID, source_slug: str
    ) -> tuple[str, int]:
        """Find the first unused `<source>-copy`, `<source>-copy-2`, … slug.

        Returns the slug AND its ordinal, because the copy's NAME has to carry
        the same number — a row slugged `-copy-3` named "… (copy)" reads like a
        different template every time an operator scans the library.

        Probes what EXISTS rather than counting prior copies: a slug can be
        occupied by a hand-created template that was never a fork at all.
        """
        for ordinal in range(1, MAX_COPY_SLUG_ATTEMPTS + 1):
            candidate = (
                f"{source_slug}-copy"
                if ordinal == 1
                else f"{source_slug}-copy-{ordinal}"
            )
            if not await self.repo.get_by_slug(workspace_id, TEMPLATE_KIND, candidate):
                return candidate, ordinal
        raise ConflictError(
            f"Could not derive a free slug for a copy of {source_slug!r} "
            f"after {MAX_COPY_SLUG_ATTEMPTS} attempts",
            error_code="slug_taken",
            error_params={"slug": f"{source_slug}-copy"},
            context={"slug": f"{source_slug}-copy"},
        )

    async def _require_slug_free(self, workspace_id: uuid.UUID, slug: str) -> None:
        if await self.repo.get_by_slug(workspace_id, TEMPLATE_KIND, slug):
            raise ConflictError(
                f"A loop template with slug {slug!r} already exists in this workspace",
                error_code="slug_taken",
                # `error_params` is what the frontend catalog interpolates;
                # `context` alone never reaches the operator, so a generic
                # "try again" was all the Library could say.
                error_params={"slug": slug},
                context={"slug": slug},
            )

    async def _get_row(
        self, workspace_id: uuid.UUID, ref: str, *, include_archived: bool = False
    ) -> ConfigTemplate:
        """Resolve a workspace ref, enforcing tenancy and the kind boundary.

        A system slug lands here only on a mutation path, where the right answer
        is 404: there is no row to change.
        """
        template_id = _as_uuid(ref)
        if template_id is None:
            raise ResourceNotFoundError(f"Loop template {ref!r} not found")

        row = await self.repo.get_by_id(template_id)
        if (
            row is None
            or row.workspace_id != workspace_id
            or row.kind != TEMPLATE_KIND
            or (row.is_archived and not include_archived)
        ):
            raise ResourceNotFoundError(f"Loop template {ref!r} not found")
        return row

    @staticmethod
    def _check_draft_lock(row: ConfigTemplate, expected_updated_at: str | None) -> None:
        if expected_updated_at is None:
            return
        current = _lock_token(row)
        if current != expected_updated_at:
            raise ConflictError(
                "Draft has changed since it was loaded",
                error_code="stale_draft",
                context={"current_draft_updated_at": current},
            )
