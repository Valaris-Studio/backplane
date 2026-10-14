# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Rich session capture: the wire contract between a companion and the
server for session content (prompts, replies, tool input and output, diffs,
native records, attachments) that is too large or too raw for an event.

An event stays bounded (app/schemas/companion.py); a content item is
declared beside it in the same capture record and its body travels either
inline (small text) or as a chunked, resumable upload. A body is readable
only once the server has verified and published it. The examples under
contracts/rich-capture/wire/ are validated against these models.
"""

import hashlib
import uuid
from datetime import datetime, timedelta
from typing import Annotated, Any, Literal

from pydantic import (
    AfterValidator,
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)

from app.core.harness import HarnessName, NativeId
from app.core.json_response import UTCModel
from app.schemas import companion
from app.schemas.companion import (
    MAX_INGEST_RECORDS,
    CaptureId,
    CaptureRecord,
    ContentLevel,
    IngestResult,
)

RICH_CAPTURE_VERSION = 1
# Sent by the device on GET /api/companion/policy; a server that offers rich
# capture answers with `rich_capture`, an older one ignores the header.
CAPABILITIES_HEADER = "Backplane-Capture-Capabilities"
RICH_CAPTURE_CAPABILITY = "rich_capture_v1"
CHUNK_DIGEST_HEADER = "Backplane-Chunk-SHA256"

MAX_CONTENTS_PER_RECORD = 256
MAX_INLINE_BODY_BYTES = 16 << 10
MAX_INLINE_BYTES_PER_RECORD = 1 << 20
MAX_TEXT_BODY_BYTES = 32 << 20
MAX_ATTACHMENT_BYTES = 20 << 20
CHUNK_BYTES = 4 << 20
MAX_CHUNKS = 8
PREVIEW_BYTES = 2 << 10
MAX_BODY_PAGE_BYTES = 256 << 10
MAX_SESSION_BODY_BYTES = 512 << 20
MAX_INSTALLATION_BODY_BYTES = 10 << 30
MAX_RICH_MAPPINGS = 1000
# An upload not finalized by then is abandoned and its staging deleted.
STAGING_TTL = timedelta(days=7)

ContentKey = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
Sha256 = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
GenerationId = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{32}$")]
MediaType = Annotated[
    str,
    StringConstraints(
        max_length=127,
        pattern=r"^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$",
    ),
]
VersionLabel = Annotated[
    str, StringConstraints(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._:/+-]+$")
]

ContentRole = Literal["user", "assistant", "tool", "system", "developer", "unknown"]
ContentChannel = Literal[
    "prompt",
    "reply",
    "reasoning",
    "tool_input",
    "tool_output",
    "diff",
    "file_content",
    "command_output",
    "error",
    "summary",
    "instruction",
    "native_record",
    "attachment",
]
SourceKind = Literal[
    "hook", "otlp", "plugin", "claude_transcript", "codex_rollout", "pi_session"
]
Delivery = Literal["inline", "upload", "none"]
# A body read from a file the harness keeps beside the record, which names
# it: Claude Code's per-session tool-results store, Pi's full bash log.
BodySource = Literal["harness_session_store", "harness_temp_log"]


def _placed_path(value: str) -> str:
    """A path as placement leaves it: relative to the mapped root, or `~/…`
    under the home directory. Never absolute, so no local path is stored."""
    is_drive = len(value) > 1 and value[1] == ":"
    if value.startswith(("/", "\\")) or is_drive or any(ord(c) < 0x20 for c in value):
        raise ValueError("display_path must be a placed path, never absolute")
    return value


DisplayPath = Annotated[
    str, StringConstraints(min_length=1, max_length=1024), AfterValidator(_placed_path)
]

Coverage = Literal[
    "captured",
    "partially_redacted",
    "withheld_by_policy",
    "source_unavailable",
    "not_yet_uploaded",
    "collection_failed",
    "truncated",
    "expired",
]
CoverageReason = Literal[
    "secret_filter",
    "content_level",
    "excluded_path",
    "outside_mapped_root",
    "media_type_not_permitted",
    "attachment_oversized",
    "quota_exceeded",
    "pre_admission_context",
    "harness_context",
    "file_missing",
    "remote_reference",
    "source_not_supported",
    "source_replaced",
    "encrypted_at_source",
    "parse_error",
    "record_too_large",
    "file_changed",
    "spool_full",
    "source_stalled",
    "upload_failed",
    "placement_failed",
    "body_limit",
    "source_limit",
    "upload_pending",
    "staging_expired",
]
# Which reasons explain which coverage; `captured` needs none.
COVERAGE_REASONS: dict[str, frozenset[str]] = {
    "captured": frozenset(),
    "partially_redacted": frozenset({"secret_filter"}),
    "withheld_by_policy": frozenset(
        {
            "content_level",
            "excluded_path",
            "outside_mapped_root",
            "media_type_not_permitted",
            "attachment_oversized",
            "quota_exceeded",
            # A summary or re-attached context restating activity from before
            # the capture generation began.
            "pre_admission_context",
            # Harness-authored system prompt, tool/skill catalogs and context
            # blocks, which can carry account identity.
            "harness_context",
        }
    ),
    "source_unavailable": frozenset(
        {
            "file_missing",
            "remote_reference",
            "source_not_supported",
            "source_replaced",
            "encrypted_at_source",
        }
    ),
    "collection_failed": frozenset(
        {
            "parse_error",
            "record_too_large",
            "file_changed",
            "spool_full",
            "source_stalled",
            "upload_failed",
            "placement_failed",
        }
    ),
    # body_limit: cut by the device; source_limit: the agent stored it cut.
    "truncated": frozenset({"body_limit", "source_limit"}),
    "not_yet_uploaded": frozenset({"upload_pending"}),
    "expired": frozenset({"staging_expired"}),
}
WITH_BODY = frozenset({"captured", "partially_redacted", "truncated"})
# Only the server knows a body has not arrived yet or never will.
SERVER_ONLY_COVERAGE = frozenset({"not_yet_uploaded", "expired"})

# Raster formats cannot carry script; SVG, HTML and PDF are documents and
# are only ever downloaded (see app/services/storage/local.py).
INLINE_IMAGE_MEDIA_TYPES = frozenset(
    {"image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"}
)
ATTACHMENT_MEDIA_TYPES = INLINE_IMAGE_MEDIA_TYPES | frozenset(
    {"application/pdf", "text/plain", "text/markdown", "application/json"}
)
TEXT_MEDIA_TYPES = frozenset(
    {
        "text/plain",
        "text/markdown",
        "text/x-diff",
        "application/json",
        "application/x-ndjson",
    }
)


def _check_coverage(coverage: str, reason: str | None) -> None:
    allowed = COVERAGE_REASONS[coverage]
    if (reason is None) != (not allowed) or (
        reason is not None and reason not in allowed
    ):
        raise ValueError(f"coverage {coverage} does not take reason {reason}")


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RedactionFact(_Request):
    """That the secret filter ran and how often it replaced text; what it
    removed is never kept."""

    filter_version: VersionLabel
    replacements: int = Field(ge=0)


class ContentSource(_Request):
    kind: SourceKind
    # The source's own id for the item (a transcript entry's uuid, a rollout
    # item id); never a local path.
    native_ref: NativeId | None = None
    # Position within the source (line number or byte offset), so items with
    # equal timestamps keep their native order.
    order: int = Field(ge=0, le=(1 << 62))
    parser: VersionLabel
    schema_version: VersionLabel
    body_from: BodySource | None = None


class ContentDeclaration(_Request):
    """One content item of a session, declared beside the events of a capture
    record. `content_key` is the device's stable identity for the item,
    derived from native identities (session, native item id, part), never
    from the content: two identical messages are two items. Every surveyed
    source is final-only, so an item is declared once and never revised; a
    source that rewrites items needs a new contract version."""

    content_key: ContentKey
    event_id: str | None = Field(None, min_length=1, max_length=64)
    call_id: NativeId | None = None
    # The enclosing call when the agent nests tools, e.g. a Codex code-mode
    # script around the commands it ran; null when the source can't tell.
    parent_call_id: NativeId | None = None
    turn_id: NativeId | None = None
    role: ContentRole
    channel: ContentChannel
    source: ContentSource
    # The file an instruction or attachment names, placed.
    display_path: DisplayPath | None = None
    occurred_at: AwareDatetime
    observed_at: AwareDatetime
    media_type: MediaType
    coverage: Coverage
    coverage_reason: CoverageReason | None = None
    delivery: Delivery
    byte_count: int | None = Field(None, ge=0, le=MAX_TEXT_BODY_BYTES)
    sha256: Sha256 | None = None
    # The size before truncation or withholding, when the device knew it.
    original_byte_count: int | None = Field(None, ge=0)
    inline_text: str | None = None
    redaction: RedactionFact

    @model_validator(mode="after")
    def _consistent(self):
        if self.coverage in SERVER_ONLY_COVERAGE:
            raise ValueError(f"only the server reports {self.coverage}")
        _check_coverage(self.coverage, self.coverage_reason)
        has_body = self.coverage in WITH_BODY
        if has_body == (self.delivery == "none"):
            raise ValueError(f"coverage {self.coverage} contradicts delivery")
        if has_body != (self.byte_count is not None and self.sha256 is not None):
            raise ValueError("a body, and only a body, states byte_count and sha256")
        if self.source.body_from is not None and not has_body:
            raise ValueError("body_from names where a body came from")
        if (self.coverage == "partially_redacted") != (self.redaction.replacements > 0):
            raise ValueError("partially_redacted means the filter replaced text")
        if self.coverage == "truncated":
            self._check_truncated()
        if self.channel == "attachment":
            self._check_attachment()
        elif has_body and self.media_type not in TEXT_MEDIA_TYPES:
            raise ValueError(f"{self.channel} content is text, not {self.media_type}")
        if (self.delivery == "inline") != (self.inline_text is not None):
            raise ValueError("inline_text comes with inline delivery only")
        if self.inline_text is not None:
            self._check_inline(self.inline_text.encode())
        return self

    def _check_truncated(self) -> None:
        # The agent's own cut (source_limit) may not say how much it cut;
        # the device's cut (body_limit) always knows.
        unstated = self.original_byte_count is None
        if unstated and self.coverage_reason == "source_limit":
            return
        if (
            unstated
            or self.byte_count is None
            or self.original_byte_count <= self.byte_count
        ):
            raise ValueError("truncated needs the larger original_byte_count")

    def _check_attachment(self) -> None:
        if self.delivery == "inline":
            raise ValueError("attachments are uploaded, never inline")
        # A withheld attachment may name any type: that is why it was withheld.
        if self.coverage in WITH_BODY and self.media_type not in ATTACHMENT_MEDIA_TYPES:
            raise ValueError(f"{self.media_type} is not a permitted attachment type")
        if self.byte_count is not None and self.byte_count > MAX_ATTACHMENT_BYTES:
            raise ValueError("attachment exceeds MAX_ATTACHMENT_BYTES")

    def _check_inline(self, encoded: bytes) -> None:
        if len(encoded) > MAX_INLINE_BODY_BYTES:
            raise ValueError("inline_text exceeds MAX_INLINE_BODY_BYTES")
        if self.byte_count != len(encoded):
            raise ValueError("byte_count must be inline_text's UTF-8 size")
        if self.sha256 != hashlib.sha256(encoded).hexdigest():
            raise ValueError("sha256 must be inline_text's digest")


class CaptureGenerationRef(_Request):
    """The forward-only capture generation a record's content belongs to: an
    unbroken run of the device's capture windows for (mapping, harness) with
    unchanged settings. A daemon restart continues it; a settings change, a
    pause, a disconnect or a lost offer ends it. `id` is 128 random bits the
    device persists before first use; `policy_revision` is an opaque device
    label the server stores and never verifies."""

    id: GenerationId
    profile: Literal["rich"]
    admitted_from: AwareDatetime
    policy_revision: Sha256


class RichCaptureRecord(CaptureRecord):
    """A capture record that may also declare content. A record may carry
    only content (late enrichment from a native transcript), never neither.
    Sent only to a server that offered rich capture: older servers forbid
    the extra members."""

    events: list[dict[str, Any]] = Field(default_factory=list, max_length=256)
    contents: list[ContentDeclaration] = Field(
        default_factory=list, max_length=MAX_CONTENTS_PER_RECORD
    )
    capture_generation: CaptureGenerationRef | None = None

    @model_validator(mode="after")
    def _contents_consistent(self):
        if not self.events and not self.contents:
            raise ValueError("a record carries events, contents or both")
        if bool(self.contents) != (self.capture_generation is not None):
            raise ValueError("contents come with their capture_generation")
        keys = [item.content_key for item in self.contents]
        if len(set(keys)) != len(keys):
            raise ValueError("a content item is declared once per record")
        inline = sum(item.byte_count or 0 for item in self.contents if item.inline_text)
        if inline > MAX_INLINE_BYTES_PER_RECORD:
            raise ValueError("inline bodies exceed MAX_INLINE_BYTES_PER_RECORD")
        return self


class RichIngestBatchSchema(BaseModel):
    """OpenAPI documentation of the ingest body (see IngestBatchSchema)."""

    records: list[RichCaptureRecord] = Field(
        min_length=1, max_length=MAX_INGEST_RECORDS
    )


class UploadSlot(BaseModel):
    """Where an upload stands; chunks are PUT by index, in any order."""

    chunk_bytes: int = Field(gt=0, le=CHUNK_BYTES)
    chunk_count: int = Field(ge=1, le=MAX_CHUNKS)
    received_chunks: list[int] = Field(default_factory=list, max_length=MAX_CHUNKS)
    expires_at: AwareDatetime

    @model_validator(mode="after")
    def _chunks_in_range(self):
        if any(not 0 <= index < self.chunk_count for index in self.received_chunks):
            raise ValueError("received_chunks must index this upload's chunks")
        return self


ContentOutcome = Literal[
    "available", "recorded", "upload_required", "dropped", "rejected"
]
ContentRejectionReason = Literal[
    "invalid",
    "conflict",
    "before_admission",
    "generation_mismatch",
]


class ContentAck(BaseModel):
    """The server's answer to one declaration. `available`: the body is
    durable (or there is none to send). `recorded`: the metadata is kept but
    no body will be accepted (`coverage` says why, e.g. quota). Both, and
    `dropped` (deleted history) and `rejected`, let the device delete its
    spooled body; `upload_required` keeps it until the upload is available."""

    capture_id: CaptureId
    content_key: ContentKey
    outcome: ContentOutcome
    content_id: uuid.UUID | None = None
    coverage: Coverage | None = None
    coverage_reason: CoverageReason | None = None
    rejection: ContentRejectionReason | None = None
    upload: UploadSlot | None = None

    @model_validator(mode="after")
    def _consistent(self):
        stored = self.outcome in ("available", "recorded", "upload_required")
        if stored != (self.content_id is not None):
            raise ValueError("stored outcomes, and only they, name the content_id")
        if (self.outcome == "upload_required") != (self.upload is not None):
            raise ValueError("upload comes with upload_required only")
        if (self.outcome == "rejected") != (self.rejection is not None):
            raise ValueError("rejection comes with rejected only")
        if (self.outcome == "recorded") != (self.coverage is not None):
            raise ValueError("recorded states the coverage the server applied")
        if self.coverage is not None:
            _check_coverage(self.coverage, self.coverage_reason)
        elif self.coverage_reason is not None:
            raise ValueError("coverage_reason needs coverage")
        return self


class RichIngestResult(IngestResult):
    """IngestResult plus one ContentAck per declaration of every acknowledged
    record, repeated when the record is replayed so a device that lost an
    ack can resume. A record ack never settles its bodies. A rejected record
    gets no content acks: its rejection settles every declaration it carried,
    and the device deletes their spooled bodies."""

    contents: list[ContentAck] = Field(default_factory=list)

    @model_validator(mode="after")
    def _acks_follow_their_records(self):
        acknowledged = set(self.acknowledged)
        dropped = {drop.capture_id for drop in self.dropped}
        for ack in self.contents:
            if ack.capture_id not in acknowledged:
                raise ValueError("content acks belong to acknowledged records")
            if ack.capture_id in dropped and ack.outcome != "dropped":
                raise ValueError("a dropped record's declarations are dropped")
        return self


class ChunkUploadHeaders(_Request):
    """Headers of `PUT /api/companion/contents/{content_id}/chunks/{index}`,
    whose body is the chunk's raw bytes. Every chunk but the last is exactly
    `chunk_bytes` long."""

    content_type: Literal["application/octet-stream"]
    content_length: int = Field(gt=0, le=CHUNK_BYTES)
    backplane_chunk_sha256: Sha256


class ChunkReceipt(BaseModel):
    content_id: uuid.UUID
    index: int = Field(ge=0, lt=MAX_CHUNKS)
    received_chunks: list[int] = Field(max_length=MAX_CHUNKS)
    chunk_count: int = Field(ge=1, le=MAX_CHUNKS)
    complete: bool

    @model_validator(mode="after")
    def _consistent(self):
        if self.index not in self.received_chunks:
            raise ValueError("a receipt's chunk is among the received ones")
        if self.complete != (len(set(self.received_chunks)) == self.chunk_count):
            raise ValueError("complete means every chunk was received")
        return self


class FinalizeRequest(_Request):
    """`POST /api/companion/contents/{content_id}/finalize`: the whole body's
    size and digest, which must match the declaration."""

    byte_count: int = Field(ge=0, le=MAX_TEXT_BODY_BYTES)
    sha256: Sha256


# A deleted row answers 404 like an unknown one; 404 and 410 are terminal.
UploadState = Literal["pending", "available", "recorded"]


class ContentUploadState(BaseModel):
    """Finalize's answer and `GET /api/companion/contents/{content_id}`."""

    content_id: uuid.UUID
    state: UploadState
    coverage: Coverage
    coverage_reason: CoverageReason | None = None
    upload: UploadSlot | None = None

    @model_validator(mode="after")
    def _consistent(self):
        _check_coverage(self.coverage, self.coverage_reason)
        if (self.state == "pending") != (self.upload is not None):
            raise ValueError("a pending upload states its slot")
        if self.state == "available" and self.coverage not in WITH_BODY:
            raise ValueError("an available body has body coverage")
        return self


ContentErrorCode = Literal[
    "content_not_found",
    "upload_expired",
    "upload_incomplete",
    "chunk_out_of_range",
    "chunk_too_large",
    "chunk_size_mismatch",
    "chunk_checksum_mismatch",
    "chunk_conflict",
    "body_checksum_mismatch",
    "rich_capture_unavailable",
    # Transient: retry later (the permanent 501 `storage_unavailable` means
    # no storage is configured at all).
    "storage_backend_unavailable",
]


class ContentError(BaseModel):
    """The app's error envelope (app/main.py) with the content codes."""

    detail: str
    error_code: ContentErrorCode
    error_params: dict[str, Any] = Field(default_factory=dict)
    context: None = None


class RichCaptureLimits(BaseModel):
    max_contents_per_record: int = Field(ge=1, le=MAX_CONTENTS_PER_RECORD)
    max_inline_body_bytes: int = Field(ge=0, le=MAX_INLINE_BODY_BYTES)
    max_inline_bytes_per_record: int = Field(ge=0, le=MAX_INLINE_BYTES_PER_RECORD)
    max_text_body_bytes: int = Field(ge=1, le=MAX_TEXT_BODY_BYTES)
    max_attachment_bytes: int = Field(ge=0, le=MAX_ATTACHMENT_BYTES)
    chunk_bytes: int = Field(ge=1, le=CHUNK_BYTES)
    max_chunks: int = Field(ge=1, le=MAX_CHUNKS)
    staging_ttl_seconds: int = Field(ge=1)
    session_body_bytes: int = Field(ge=0, le=MAX_SESSION_BODY_BYTES)
    installation_body_bytes: int = Field(ge=0, le=MAX_INSTALLATION_BODY_BYTES)

    @model_validator(mode="after")
    def _bodies_fit_the_chunks(self):
        room = self.chunk_bytes * self.max_chunks
        if max(self.max_text_body_bytes, self.max_attachment_bytes) > room:
            raise ValueError("a largest body must fit in chunk_bytes x max_chunks")
        return self


class RichMappingGrant(BaseModel):
    """A mapping this device may capture rich, since when on the server's
    clock. `rich_since` is part of the device's capture settings, so leaving
    and re-entering rich (even between two policy fetches) starts a new
    generation, and the server rejects content observed before it."""

    mapping_id: uuid.UUID
    rich_since: AwareDatetime


class RichCaptureOffer(BaseModel):
    """DevicePolicy.rich_capture: present only when this server accepts rich
    capture and the device declared RICH_CAPTURE_CAPABILITY. The device uses
    the smaller of these limits and its own, and captures rich only for the
    mappings listed."""

    version: Literal[1]
    limits: RichCaptureLimits
    rich_mappings: list[RichMappingGrant] = Field(max_length=MAX_RICH_MAPPINGS)

    @model_validator(mode="after")
    def _one_grant_per_mapping(self):
        mapping_ids = [grant.mapping_id for grant in self.rich_mappings]
        if len(set(mapping_ids)) != len(mapping_ids):
            raise ValueError("a mapping has one rich_since")
        return self


RichSourceState = Literal[
    "capturing", "unsupported", "source_unavailable", "stalled", "error"
]


class RichSourceStatus(_Request):
    harness: HarnessName
    state: RichSourceState
    # Stored with every absolute path replaced by `[path]`, like AgentStatus.
    detail: str | None = Field(None, max_length=200)


class SpoolStatus(_Request):
    pending_bodies: int = Field(ge=0)
    pending_bytes: int = Field(ge=0)
    oldest_pending_at: AwareDatetime | None = None
    failed_total: int = Field(ge=0)


class RichCaptureStatus(_Request):
    """DeviceStatusReport.rich_capture: sent only to a server that offered
    rich capture (older servers forbid the member)."""

    sources: list[RichSourceStatus] = Field(default_factory=list, max_length=16)
    spool: SpoolStatus


MappingCaptureReason = Literal["device_unsupported", "server_disabled"]


class MappingEffectiveCapture(BaseModel):
    """What a mapping captures: the owner's choice and what this device and
    server can honour. A rich mapping on a device without rich capture
    captures `full` (never more than chosen) and says why."""

    content_level: ContentLevel
    effective_content_level: ContentLevel
    reason: MappingCaptureReason | None = None

    @model_validator(mode="after")
    def _explained(self):
        downgraded = self.effective_content_level != self.content_level
        if downgraded != (self.reason is not None):
            raise ValueError("a downgrade, and only a downgrade, has a reason")
        if downgraded and (self.content_level, self.effective_content_level) != (
            "rich",
            "full",
        ):
            raise ValueError("only rich falls back, and only to full")
        return self


ContentRender = Literal["text", "image", "download", "none"]


class ContentPreview(UTCModel):
    text: str = Field(max_length=PREVIEW_BYTES)
    truncated: bool


class ContentSourceRead(UTCModel):
    kind: SourceKind
    order: int


class ContentRead(UTCModel):
    """One content item as its owner reads it. `render`: `text` pages through
    /body, `image` may be shown inline from /download, `download` is offered
    as a file only, `none` has no body (see coverage)."""

    id: uuid.UUID
    session_id: uuid.UUID
    event_id: str | None
    call_id: str | None
    parent_call_id: str | None
    turn_id: str | None
    role: ContentRole
    channel: ContentChannel
    display_path: str | None
    media_type: str
    coverage: Coverage
    coverage_reason: CoverageReason | None
    byte_count: int | None
    original_byte_count: int | None
    sha256: str | None
    redaction: RedactionFact
    source: ContentSourceRead
    occurred_at: datetime
    render: ContentRender
    preview: ContentPreview | None

    @model_validator(mode="after")
    def _renderable(self):
        _check_coverage(self.coverage, self.coverage_reason)
        if (self.render == "none") != (self.coverage not in WITH_BODY):
            raise ValueError("only a body renders")
        if self.render == "image" and self.media_type not in INLINE_IMAGE_MEDIA_TYPES:
            raise ValueError(f"{self.media_type} never renders inline")
        if self.render == "text" and self.media_type not in TEXT_MEDIA_TYPES:
            raise ValueError(f"{self.media_type} is not text")
        return self


class ContentPage(UTCModel):
    items: list[ContentRead]
    next_cursor: str | None


class ContentBodyPage(UTCModel):
    """`GET …/contents/{id}/body?offset=` for text: at most
    MAX_BODY_PAGE_BYTES, cut on a UTF-8 boundary."""

    content_id: uuid.UUID
    offset: int = Field(ge=0)
    next_offset: int | None = Field(ge=0)
    total_bytes: int = Field(ge=0)
    text: str

    @model_validator(mode="after")
    def _bounded(self):
        size = len(self.text.encode())
        if size > MAX_BODY_PAGE_BYTES:
            raise ValueError("a page holds at most MAX_BODY_PAGE_BYTES")
        end = self.offset + size
        if end > self.total_bytes or (self.next_offset is None) != (
            end == self.total_bytes
        ):
            raise ValueError("next_offset is the page's end, null at the body's end")
        if self.next_offset is not None and self.next_offset != end:
            raise ValueError("next_offset is the page's end")
        return self


WIRE_MODELS: dict[str, type[BaseModel]] = {
    model.__name__: model
    for model in (
        RichCaptureOffer,
        RichCaptureRecord,
        ContentDeclaration,
        RichIngestResult,
        ChunkUploadHeaders,
        ChunkReceipt,
        FinalizeRequest,
        ContentUploadState,
        ContentError,
        RichCaptureStatus,
        MappingEffectiveCapture,
        ContentPage,
        ContentBodyPage,
    )
}

for _device_model in (
    companion.MappingRead,
    companion.DeviceStatusReport,
    companion.InstallationRead,
    companion.DevicePolicy,
):
    _device_model.model_rebuild(
        _types_namespace={
            "MappingEffectiveCapture": MappingEffectiveCapture,
            "RichCaptureOffer": RichCaptureOffer,
            "RichCaptureStatus": RichCaptureStatus,
        }
    )
