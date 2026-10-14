# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The server's answer to each content declaration of an acknowledged record,
in the contract's decision order (§7): deleted history, a key already stored,
the rich-capture policy, exclusions, the capture generation and its forward-
only bounds, quota, placement; then the body is kept inline, awaited as an
upload, or recorded without one."""

import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from fnmatch import fnmatchcase

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.local_paths import place_text
from app.core.time import as_utc
from app.models.agent_session import AgentSession, AgentSessionContent
from app.models.companion import CompanionInstallation, CompanionProjectMapping
from app.repositories.session_content import SessionContentRepository
from app.schemas.session_content import (
    CHUNK_BYTES,
    MAX_INSTALLATION_BODY_BYTES,
    MAX_SESSION_BODY_BYTES,
    STAGING_TTL,
    WITH_BODY,
    ContentAck,
    ContentDeclaration,
    RichCaptureRecord,
    UploadSlot,
)
from app.services.rich_capture import effective_capture, grants_bodies
from app.services.session_history_cutoff import MAX_CLOCK_SKEW

JSON_MEDIA_TYPES = frozenset({"application/json"})
NDJSON_MEDIA_TYPES = frozenset({"application/x-ndjson"})


@dataclass
class InstallationQuota:
    """The device's body total as this batch sees it: the stored figure plus
    what the batch's committed records reserved. Applied to the row once,
    atomically, after every session of the batch is locked."""

    stored: int
    reserved: int = 0

    def fits(self, size: int) -> bool:
        return self.stored + self.reserved + size <= MAX_INSTALLATION_BODY_BYTES


@dataclass
class DeclaredContents:
    acks: list[ContentAck] = field(default_factory=list)
    # The session they were declared in, how many new items it stored and
    # how many body bytes it reserved.
    session: AgentSession | None = None
    stored: int = 0
    reserved: int = 0


def ack_of(content: AgentSessionContent, capture_id: str) -> ContentAck:
    """The stored answer for `content`, so a replay hears exactly what the
    first upload heard (and an upload in progress, where it stands)."""
    if content.state == "pending":
        return ContentAck(
            capture_id=capture_id,
            content_key=content.content_key,
            outcome="upload_required",
            content_id=content.id,
            upload=upload_slot(content),
        )
    server_decided = (content.coverage, content.coverage_reason) != (
        content.declared_coverage,
        content.declared_coverage_reason,
    )
    if content.state == "recorded" and server_decided:
        return ContentAck(
            capture_id=capture_id,
            content_key=content.content_key,
            outcome="recorded",
            content_id=content.id,
            coverage=content.coverage,
            coverage_reason=content.coverage_reason,
        )
    return ContentAck(
        capture_id=capture_id,
        content_key=content.content_key,
        outcome="available",
        content_id=content.id,
    )


def upload_slot(content: AgentSessionContent) -> UploadSlot:
    return UploadSlot(
        chunk_bytes=CHUNK_BYTES,
        chunk_count=content.chunk_count,
        received_chunks=sorted(int(index) for index in content.received_chunks or {}),
        expires_at=as_utc(content.upload_expires_at),
    )


def is_placed(text: str, media_type: str, roots: list[str]) -> bool:
    """No local path left for placement to rewrite, in the text as sent and,
    for JSON, in every decoded string and member name."""
    if place_text(text, roots) != text:
        return False
    if media_type in JSON_MEDIA_TYPES:
        documents = [text]
    elif media_type in NDJSON_MEDIA_TYPES:
        documents = [line for line in text.splitlines() if line.strip()]
    else:
        return True
    for document in documents:
        try:
            decoded = json.loads(document)
        except (ValueError, RecursionError):
            continue
        if not all(place_text(value, roots) == value for value in _strings(decoded)):
            return False
    return True


def _strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, child in value.items():
            yield key
            yield from _strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from _strings(child)


def mapping_roots(mapping: CompanionProjectMapping) -> list[str]:
    return [mapping.root_path] if mapping.root_path else []


def excluded(display_path: str | None, installation: CompanionInstallation) -> bool:
    return display_path is not None and any(
        fnmatchcase(display_path, glob) for glob in installation.exclude_globs or []
    )


class SessionContentIngest:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = SessionContentRepository(db)

    def dropped(self, record: RichCaptureRecord) -> list[ContentAck]:
        return [
            ContentAck(
                capture_id=record.capture_id,
                content_key=item.content_key,
                outcome="dropped",
            )
            for item in record.contents
        ]

    async def stored_only(
        self, session: AgentSession, record: RichCaptureRecord
    ) -> DeclaredContents:
        """Answers from stored items alone; a key never stored is refused,
        since nothing admits it any more."""
        stored = await self.repo.by_keys(
            session.id, [item.content_key for item in record.contents]
        )
        return DeclaredContents(
            acks=[
                ack_of(stored[item.content_key], record.capture_id)
                if item.content_key in stored
                else self._rejected(record, item, "invalid")
                for item in record.contents
            ]
        )

    async def declare(
        self,
        *,
        installation: CompanionInstallation,
        mapping: CompanionProjectMapping,
        session: AgentSession,
        record: RichCaptureRecord,
        cutoff: datetime | None,
        quota: InstallationQuota,
    ) -> DeclaredContents:
        """Decide every declaration of `record` against the locked `session`;
        reservations land on the session and in `quota`."""
        declared = DeclaredContents()
        if not record.contents:
            return declared
        stored = await self.repo.by_keys(
            session.id, [item.content_key for item in record.contents]
        )
        generation = await self._generation(installation, record)
        bodies_granted = grants_bodies(mapping, installation)
        level = effective_capture(mapping, installation).effective_content_level
        now = datetime.now(timezone.utc)
        for item in record.contents:
            if cutoff is not None and as_utc(item.occurred_at) <= cutoff:
                declared.acks.append(self._ack(record, item, "dropped"))
                continue
            existing = stored.get(item.content_key)
            if existing is not None:
                if _same_declaration(existing, item):
                    declared.acks.append(ack_of(existing, record.capture_id))
                else:
                    declared.acks.append(self._rejected(record, item, "conflict"))
                continue
            if not bodies_granted:
                server_coverage = ("withheld_by_policy", "content_level")
            elif excluded(item.display_path, installation):
                server_coverage = ("withheld_by_policy", "excluded_path")
            else:
                rejection = self._rejection(record, item, generation, mapping)
                if rejection is not None:
                    declared.acks.append(self._rejected(record, item, rejection))
                    continue
                server_coverage = None
            content = self._content(
                installation, session, record, item, generation, level, now
            )
            if server_coverage is None and item.coverage in WITH_BODY:
                size = item.byte_count
                if (
                    session.content_bytes + size > MAX_SESSION_BODY_BYTES
                    or not quota.fits(declared.reserved + size)
                ):
                    server_coverage = ("withheld_by_policy", "quota_exceeded")
                elif item.delivery == "inline" and not is_placed(
                    item.inline_text, item.media_type, mapping_roots(mapping)
                ):
                    server_coverage = ("collection_failed", "placement_failed")
                else:
                    session.content_bytes += size
                    declared.reserved += size
                    self._accept_body(content, item, now)
            if server_coverage is not None:
                content.state = "recorded"
                content.coverage, content.coverage_reason = server_coverage
            session.content_count += 1
            await self.repo.add(content)
            stored[item.content_key] = content
            declared.stored += 1
            declared.acks.append(ack_of(content, record.capture_id))
        await self.db.flush()
        return declared

    async def _generation(self, installation, record: RichCaptureRecord):
        reference = record.capture_generation
        return await self.repo.generation(
            installation.id,
            reference.id,
            dict(
                mapping_id=record.mapping_id,
                harness=record.harness,
                policy_revision=reference.policy_revision,
                admitted_from=reference.admitted_from,
                first_seen_at=datetime.now(timezone.utc),
            ),
        )

    @staticmethod
    def _rejection(record, item: ContentDeclaration, generation, mapping) -> str | None:
        reference = record.capture_generation
        if (
            generation.mapping_id != record.mapping_id
            or generation.harness != record.harness
            or generation.policy_revision != reference.policy_revision
            or as_utc(generation.admitted_from) != as_utc(reference.admitted_from)
        ):
            return "generation_mismatch"
        occurred = as_utc(item.occurred_at)
        if occurred < as_utc(generation.admitted_from):
            return "before_admission"
        if occurred < as_utc(mapping.rich_since) - MAX_CLOCK_SKEW:
            return "before_admission"
        return None

    @staticmethod
    def _content(
        installation, session, record, item: ContentDeclaration, generation, level, now
    ) -> AgentSessionContent:
        """The item as declared, recorded without a body until accepted."""
        return AgentSessionContent(
            session_id=session.id,
            workspace_id=session.workspace_id,
            owner_id=session.owner_id,
            installation_id=installation.id,
            generation_id=generation.id,
            capture_id=record.capture_id,
            content_key=item.content_key,
            event_id=item.event_id,
            call_key=item.call_id,
            parent_call_key=item.parent_call_id,
            turn_id=item.turn_id,
            display_path=item.display_path,
            role=item.role,
            channel=item.channel,
            media_type=item.media_type,
            source_kind=item.source.kind,
            native_ref=item.source.native_ref,
            source_order=item.source.order,
            body_from=item.source.body_from,
            parser_version=item.source.parser,
            source_schema_version=item.source.schema_version,
            occurred_at=as_utc(item.occurred_at),
            observed_at=as_utc(item.observed_at),
            received_at=now,
            content_level=level,
            policy_revision=record.capture_generation.policy_revision,
            filter_version=item.redaction.filter_version,
            redactions=item.redaction.replacements,
            byte_count=item.byte_count,
            original_byte_count=item.original_byte_count,
            sha256=item.sha256,
            state="recorded",
            coverage=item.coverage,
            coverage_reason=item.coverage_reason,
            declared_coverage=item.coverage,
            declared_coverage_reason=item.coverage_reason,
            delivery=item.delivery,
            received_chunks={},
        )

    @staticmethod
    def _accept_body(content: AgentSessionContent, item: ContentDeclaration, now):
        if item.delivery == "inline" or item.byte_count == 0:
            content.inline_text = item.inline_text or ""
            content.state = "available"
            content.available_at = now
            return
        content.state = "pending"
        content.coverage, content.coverage_reason = "not_yet_uploaded", "upload_pending"
        content.chunk_count = max(1, math.ceil(item.byte_count / CHUNK_BYTES))
        content.upload_expires_at = now + STAGING_TTL

    @staticmethod
    def _ack(record, item: ContentDeclaration, outcome: str) -> ContentAck:
        return ContentAck(
            capture_id=record.capture_id, content_key=item.content_key, outcome=outcome
        )

    @staticmethod
    def _rejected(record, item: ContentDeclaration, reason: str) -> ContentAck:
        return ContentAck(
            capture_id=record.capture_id,
            content_key=item.content_key,
            outcome="rejected",
            rejection=reason,
        )


def _same_declaration(content: AgentSessionContent, item: ContentDeclaration) -> bool:
    return (
        content.sha256,
        content.byte_count,
        content.declared_coverage,
        content.delivery,
    ) == (
        item.sha256,
        item.byte_count,
        item.coverage,
        item.delivery,
    )
