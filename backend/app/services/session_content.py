# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The owner reading their sessions' captured content.

Bodies are owner-private: only the person whose device captured them, while
they belong to the session's workspace. No role, board or card link widens
that, and neither does a key acting for the owner, an agent's or the one the
companion hands the agents it launches. A content id is found only under its
own session, so a path through another session answers like an unknown id.
A body is served only once it is available, and only as stored."""

import base64
import json
import logging
import uuid
from collections.abc import Iterator
from datetime import datetime
from pathlib import PurePosixPath

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import current_agent_id, current_api_key_installation_id
from app.core.time import as_utc
from app.exceptions import (
    ConflictError,
    ForbiddenError,
    PayloadTooLargeError,
    ResourceNotFoundError,
    StorageBackendUnavailableError,
    ValidationError,
)
from app.models.agent_session import AgentSessionContent
from app.repositories.agent_session import AgentSessionRepository
from app.repositories.session_content import SessionContentRepository
from app.schemas.session_content import (
    INLINE_IMAGE_MEDIA_TYPES,
    MAX_BODY_PAGE_BYTES,
    PREVIEW_BYTES,
    TEXT_MEDIA_TYPES,
    WITH_BODY,
    ContentBodyPage,
    ContentPage,
    ContentPreview,
    ContentRead,
    ContentSourceRead,
    RedactionFact,
)
from app.services.storage.session_content import (
    ContentObject,
    ContentStore,
    store_for,
    stored,
)

logger = logging.getLogger(__name__)


def _not_found() -> ResourceNotFoundError:
    return ResourceNotFoundError("Content not found", error_code="content_not_found")


def has_body(content: AgentSessionContent) -> bool:
    return content.state == "available" and content.coverage in WITH_BODY


def render_of(content: AgentSessionContent) -> str:
    if not has_body(content):
        return "none"
    if content.media_type in TEXT_MEDIA_TYPES:
        return "text"
    if content.media_type in INLINE_IMAGE_MEDIA_TYPES:
        return "image"
    return "download"


def preview_of(content: AgentSessionContent) -> ContentPreview | None:
    if render_of(content) != "text":
        return None
    if content.inline_text is not None:
        encoded = content.inline_text.encode()
        text = encoded[:PREVIEW_BYTES].decode("utf-8", errors="ignore")
    else:
        text = content.preview or ""
    return ContentPreview(
        text=text, truncated=len(text.encode()) < (content.byte_count or 0)
    )


def content_read(content: AgentSessionContent) -> ContentRead:
    return ContentRead(
        id=content.id,
        session_id=content.session_id,
        event_id=content.event_id,
        call_id=content.call_key,
        parent_call_id=content.parent_call_key,
        turn_id=content.turn_id,
        role=content.role,
        channel=content.channel,
        display_path=content.display_path,
        media_type=content.media_type,
        coverage=content.coverage,
        coverage_reason=content.coverage_reason,
        byte_count=content.byte_count,
        original_byte_count=content.original_byte_count,
        sha256=content.sha256,
        redaction=RedactionFact(
            filter_version=content.filter_version, replacements=content.redactions
        ),
        source=ContentSourceRead(kind=content.source_kind, order=content.source_order),
        occurred_at=content.occurred_at,
        render=render_of(content),
        preview=preview_of(content),
    )


def encode_cursor(content: AgentSessionContent) -> str:
    raw = json.dumps(
        [as_utc(content.occurred_at).isoformat(), content.source_order, str(content.id)]
    ).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> tuple[datetime, int, uuid.UUID] | None:
    if cursor is None:
        return None
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        at, order, row_id = json.loads(base64.urlsafe_b64decode(padded))
        if not isinstance(order, int) or isinstance(order, bool):
            raise ValueError
        return as_utc(datetime.fromisoformat(at)), order, uuid.UUID(row_id)
    except (ValueError, TypeError):
        raise ValidationError("Invalid cursor") from None


def download_name(content: AgentSessionContent) -> str:
    if content.display_path:
        name = PurePosixPath(content.display_path.replace("\\", "/")).name
        if name:
            return name
    extension = {
        "text/markdown": ".md",
        "application/json": ".json",
        "application/x-ndjson": ".ndjson",
        "text/x-diff": ".diff",
        "application/pdf": ".pdf",
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "image/avif": ".avif",
    }.get(content.media_type, ".txt")
    return f"content-{content.id}{extension}"


class AgentSessionContentService:
    def __init__(self, db: AsyncSession):
        self.sessions = AgentSessionRepository(db)
        self.repo = SessionContentRepository(db)

    async def _authorize(self, workspace_id: uuid.UUID, owner_id: uuid.UUID) -> None:
        # Both keys resolve to the owner; neither may read what they captured.
        if current_agent_id.get() is not None:
            raise ForbiddenError("Agent keys cannot read captured content")
        if current_api_key_installation_id.get() is not None:
            raise ForbiddenError(
                "Agents launched by the companion cannot read captured content"
            )
        if not await self.sessions.is_member(workspace_id, owner_id):
            raise ForbiddenError("Not a member of this workspace")

    async def _owned_session(self, workspace_id, owner_id, session_id):
        await self._authorize(workspace_id, owner_id)
        session = await self.sessions.get_owned(workspace_id, owner_id, session_id)
        if session is None:
            raise ResourceNotFoundError("Session not found")
        return session

    async def _owned(self, workspace_id, owner_id, session_id, content_id):
        await self._owned_session(workspace_id, owner_id, session_id)
        content = await self.repo.of_owner(
            content_id, session_id, workspace_id, owner_id
        )
        if content is None:
            raise _not_found()
        return content

    async def list_contents(
        self,
        workspace_id: uuid.UUID,
        owner_id: uuid.UUID,
        session_id: uuid.UUID,
        *,
        cursor: str | None,
        limit: int,
        channel: str | None = None,
        call_id: str | None = None,
        event_id: str | None = None,
    ) -> ContentPage:
        await self._owned_session(workspace_id, owner_id, session_id)
        rows = await self.repo.page(
            session_id,
            channel=channel,
            call_key=call_id,
            event_id=event_id,
            after=decode_cursor(cursor),
            limit=limit + 1,
        )
        page = rows[:limit]
        return ContentPage(
            items=[content_read(row) for row in page],
            next_cursor=encode_cursor(page[-1]) if len(rows) > limit else None,
        )

    async def body_page(
        self, workspace_id, owner_id, session_id, content_id, offset: int
    ) -> ContentBodyPage:
        content = await self._owned(workspace_id, owner_id, session_id, content_id)
        if render_of(content) != "text":
            raise _not_found()
        total = content.byte_count
        if offset > total:
            raise ValidationError("offset is past the end of the body")
        if content.inline_text is not None:
            data = content.inline_text.encode()[
                offset : offset + MAX_BODY_PAGE_BYTES + 3
            ]
        else:
            stored_object = await self._verified_object(content)
            data = await stored(
                self._store_of(content).read,
                stored_object.key,
                offset,
                MAX_BODY_PAGE_BYTES + 3,
            )
        if data and data[0] & 0xC0 == 0x80:
            raise ValidationError("offset is not on a character boundary")
        end = len(data)
        if end > MAX_BODY_PAGE_BYTES:
            end = MAX_BODY_PAGE_BYTES
            # Back off to the start of the character the limit cuts.
            while end > 0 and data[end] & 0xC0 == 0x80:
                end -= 1
        try:
            text = data[:end].decode("utf-8")
        except UnicodeDecodeError:
            raise ValidationError(
                "This body is not UTF-8 text; download it instead"
            ) from None
        next_offset = offset + end
        return ContentBodyPage(
            content_id=content.id,
            offset=offset,
            next_offset=next_offset if next_offset < total else None,
            total_bytes=total,
            text=text,
        )

    async def download(
        self, workspace_id, owner_id, session_id, content_id
    ) -> tuple[AgentSessionContent, Iterator[bytes] | bytes]:
        content = await self._owned(workspace_id, owner_id, session_id, content_id)
        if not has_body(content):
            raise _not_found()
        if content.inline_text is not None:
            return content, content.inline_text.encode()
        stored_object = await self._verified_object(content)
        store = self._store_of(content)
        return content, await stored(store.iter_bytes, stored_object.key)

    async def verify_excerpt_source(
        self,
        workspace_id: uuid.UUID,
        owner_id: uuid.UUID,
        session_id: uuid.UUID,
        expected_digests: dict[uuid.UUID, str],
        *,
        max_total_bytes: int,
    ) -> None:
        """The owner may publish these text bodies as they are stored now.

        Every selected item must be readable text of this session (not an
        attachment), still carry the digest the owner reviewed, and, when
        uploaded, still be stored at its finalized size. One failure fails all.
        """
        await self._owned_session(workspace_id, owner_id, session_id)
        contents = await self.repo.many_of_owner(
            list(expected_digests), session_id, workspace_id, owner_id
        )
        if len(contents) != len(expected_digests) or any(
            render_of(content) != "text" or content.channel == "attachment"
            for content in contents
        ):
            raise _not_found()
        if any(content.sha256 != expected_digests[content.id] for content in contents):
            raise ConflictError(
                "The selected content changed since it was reviewed",
                error_code="excerpt_source_stale",
            )
        if sum(content.byte_count for content in contents) > max_total_bytes:
            raise PayloadTooLargeError(
                f"Selected content exceeds {max_total_bytes} bytes"
            )
        for content in contents:
            if content.inline_text is None:
                await self._verified_object(content)

    async def _verified_object(self, content: AgentSessionContent) -> ContentObject:
        """The stored body, as long as it is the size finalize verified; its
        digest was checked then and is not recomputed per read."""
        store = self._store_of(content)
        try:
            found = await stored(store.stat, content.storage_key)
        except (FileNotFoundError, ValueError):
            found = None
        if found is None or found.size != content.byte_count:
            logger.error(
                "session content %s is available but its body %s is %s",
                content.id,
                content.storage_key,
                "missing" if found is None else f"{found.size} bytes",
            )
            raise StorageBackendUnavailableError(
                "Content storage is unavailable; retry later"
            )
        return found

    @staticmethod
    def _store_of(content: AgentSessionContent) -> ContentStore:
        store = store_for(content.storage_backend)
        if store is None:
            logger.error(
                "session content %s is stored in %s, which is not configured",
                content.id,
                content.storage_backend,
            )
            raise StorageBackendUnavailableError(
                "Content storage is unavailable; retry later"
            )
        return store
