# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Write-path hook: canonicalise stored-object links before rich text is saved.

The pure rewrite lives in `links.py`; this adds the two lookups it needs (the
workspace slug, and resource ids for resource-shaped keys) and skips both
when the value cannot contain a storage URL, which is almost every save.
"""

import copy
import logging
import uuid
from dataclasses import replace

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.workspace import Workspace
from app.repositories.resources.resource import ResourceRepository
from app.services.notes.media_markdown import strip_unsafe_media_text
from app.services.media.links import (
    GCS_HOST,
    LOCAL_DOWNLOAD_PREFIX,
    STABLE_PATH_PREFIX,
    LinkRewriteReport,
    MediaLinkContext,
    app_origins_from_settings,
    canonicalize_definition,
    canonicalize_rich_text,
    collect_definition_resource_keys,
    collect_resource_keys,
    definition_rich_text_leaves,
)

logger = logging.getLogger(__name__)


def may_hold_storage_link(value: object) -> bool:
    if isinstance(value, dict):
        return any(may_hold_storage_link(v) for v in value.values())
    if isinstance(value, list):
        return any(may_hold_storage_link(v) for v in value)
    return isinstance(value, str) and (
        GCS_HOST in value
        or LOCAL_DOWNLOAD_PREFIX in value
        or ("://" in value and STABLE_PATH_PREFIX in value)
    )


class MediaLinkCanonicalizer:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def _context(self, workspace_id: uuid.UUID) -> MediaLinkContext:
        slug = await self.db.scalar(select(Workspace.slug).where(Workspace.id == workspace_id))
        return MediaLinkContext(
            workspace_id=workspace_id,
            workspace_slug=slug,
            bucket=settings.GCS_BUCKET,
            app_origins=app_origins_from_settings(),
        )

    async def _with_resources(self, ctx: MediaLinkContext, keys: set[str]) -> MediaLinkContext:
        resource_ids = await ResourceRepository(self.db).ids_by_gcs_path(ctx.workspace_id, keys)
        return replace(ctx, resource_ids_by_key=resource_ids)

    @staticmethod
    def _log_unmapped(report: LinkRewriteReport, workspace_id: uuid.UUID) -> None:
        for link in report.unmapped:
            logger.info(
                "media link left as-is workspace=%s reason=%s", workspace_id, link.reason
            )

    async def rich_text(self, workspace_id: uuid.UUID, value: str | None) -> str | None:
        value = strip_unsafe_media_text(value)
        if not may_hold_storage_link(value):
            return value
        ctx = await self._context(workspace_id)
        ctx = await self._with_resources(ctx, collect_resource_keys(value, ctx))
        canonical, report = canonicalize_rich_text(value, ctx)
        self._log_unmapped(report, workspace_id)
        return canonical

    async def definition(
        self, workspace_id: uuid.UUID, scope: str | None, content: dict | None
    ) -> tuple[str | None, dict | None]:
        scope, content = _strip_unsafe_definition_media(scope, content)
        if not (may_hold_storage_link(scope) or may_hold_storage_link(content)):
            return scope, content
        ctx = await self._context(workspace_id)
        ctx = await self._with_resources(
            ctx, collect_definition_resource_keys(scope, content, ctx)
        )
        new_scope, new_content, report = canonicalize_definition(scope, content, ctx)
        self._log_unmapped(report, workspace_id)
        return new_scope, new_content


def _strip_unsafe_definition_media(
    scope: str | None, content: dict | None
) -> tuple[str | None, dict | None]:
    """Definitions never pass the note normalizer, so this is where their rich
    text gets the image/attachment src allowlist. Unchanged inputs are returned
    as the same objects (callers detect "nothing to do" by identity)."""
    scope = strip_unsafe_media_text(scope)
    if not isinstance(content, dict):
        return scope, content
    stripped = copy.deepcopy(content)
    changed = False
    for container, key in definition_rich_text_leaves(stripped):
        cleaned = strip_unsafe_media_text(container[key])
        if cleaned != container[key]:
            container[key] = cleaned
            changed = True
    return scope, (stripped if changed else content)
