# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import unicodedata
import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Annotated, Any, Literal

from pydantic import (
    AfterValidator,
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Discriminator,
    Field,
    StringConstraints,
    Tag,
    field_validator,
    model_validator,
)

from app.core.harness import CollectionMethod, HarnessName, NativeId
from app.core.json_response import UTCModel

if TYPE_CHECKING:
    from app.schemas.session_content import (
        MappingEffectiveCapture,
        RichCaptureOffer,
        RichCaptureStatus,
    )

# From most to least private. `rich` is full plus content bodies beside the
# events (app/schemas/session_content.py).
ContentLevel = Literal["metadata", "standard", "full", "rich"]
MAX_INGEST_RECORDS = 32
MAX_INGEST_BATCH_BYTES = 8 << 20
MAX_INGEST_RECORD_BYTES = 4 << 20
MAX_INGEST_EVENT_BYTES = 64 << 10
MAX_INGEST_EVENTS_PER_RECORD = 256

CaptureId = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{32}$")]
ExcludeGlob = Annotated[str, StringConstraints(min_length=1, max_length=512)]


def _absolute_root(value: str) -> str:
    """Accept POSIX (`/…`) and Windows (`C:\\…`) absolute roots, minus trailing
    separators, so one project spelled two ways cannot map twice."""
    value = value.strip()
    is_windows = len(value) > 2 and value[1] == ":" and value[2] in "\\/"
    if not (value.startswith("/") or is_windows) or "\x00" in value:
        raise ValueError("root_path must be an absolute path")
    trimmed = value.rstrip("/\\")
    return trimmed or "/"


RootPath = Annotated[str, StringConstraints(min_length=1, max_length=1024)]

# Explicit direction overrides can make a name display as something else.
_BIDI_CONTROLS = frozenset("\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069")


def _printable_name(value: str) -> str:
    if any(unicodedata.category(c) == "Cc" or c in _BIDI_CONTROLS for c in value):
        raise ValueError("name must not contain control characters")
    # Categories C* (format, unassigned) and Z* (separators) render as nothing.
    if not any(unicodedata.category(c)[0] not in "CZ" for c in value):
        raise ValueError("name needs a visible character")
    return value


DeviceName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=200),
    AfterValidator(_printable_name),
]


class InstallationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    installation_id: uuid.UUID
    name: DeviceName
    platform: str = Field(min_length=1, max_length=64)


class InstallationRename(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: DeviceName


class InstallationEnrollment(BaseModel):
    """`device_token` is present only on the response that minted it."""

    installation_id: uuid.UUID
    device_token: str | None
    token_prefix: str


class AgentKeyRead(UTCModel):
    id: uuid.UUID
    name: str
    key_prefix: str
    created_at: datetime
    last_used_at: datetime | None

    model_config = ConfigDict(from_attributes=True)


class AgentKeyCreated(UTCModel):
    """`key` is the raw API key; it is never stored and never returned again."""

    id: uuid.UUID
    name: str
    key_prefix: str
    key: str
    created_at: datetime


class CapturePolicy(BaseModel):
    paused: bool
    auto_match_repos: bool
    # Harnesses allowed to capture; [] disables capture for every agent.
    enabled_agents: list[str]
    exclude_globs: list[str] = Field(
        description="fnmatch patterns matched on the server against the mapping's "
        "repository URL (`host/owner/repo`) and each event's working directory "
        "relative to the mapping root (`.` for the root itself); `*` also crosses "
        "`/`. The device also applies them to local paths before capture."
    )
    retention_days: int | None = Field(
        description="Delete this device's sessions this many days after their last "
        "event; null keeps them until the owner deletes them."
    )


class CapturePolicyUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    paused: bool | None = None
    auto_match_repos: bool | None = None
    enabled_agents: list[HarnessName] | None = Field(None, max_length=64)
    retention_days: int | None = Field(None, ge=1, le=3650)
    exclude_globs: list[ExcludeGlob] | None = Field(None, max_length=128)


class InstallationRead(UTCModel):
    installation_id: uuid.UUID
    name: str
    platform: str
    token_prefix: str
    created_at: datetime
    last_seen_at: datetime | None
    revoked_at: datetime | None
    policy: CapturePolicy
    # The latest heartbeat's report, and when it was stored.
    status: "DeviceStatusReport | None"
    status_reported_at: datetime | None
    # Sessions this device captured in every workspace: what deleting its
    # sessions would remove.
    session_count: int


AgentCaptureState = Literal["capturing", "not_installed", "disabled", "error"]


class AgentStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")

    harness: HarnessName
    state: AgentCaptureState
    # Stored with every absolute path replaced by `[path]`.
    detail: str | None = Field(None, max_length=200)


class QueueStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")

    pending: int = Field(ge=0)
    dropped_total: int = Field(ge=0)
    oldest_pending_at: AwareDatetime | None = None


class DeviceStatusReport(BaseModel):
    """The companion's heartbeat: what it is capturing and how its queue is."""

    model_config = ConfigDict(extra="forbid")

    companion_version: str = Field(min_length=1, max_length=64)
    beacon_commit: str | None = Field(None, max_length=64)
    agents: list[AgentStatus] = Field(default_factory=list, max_length=16)
    queue: QueueStatus
    # Sent only to a server that offered rich capture.
    rich_capture: "RichCaptureStatus | None" = None


class HeartbeatResult(BaseModel):
    # False when a report arrived within a minute of the stored one.
    recorded: bool


class SessionDeletionResult(BaseModel):
    deleted: int


class MappingCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    workspace_id: uuid.UUID
    board_id: uuid.UUID | None = None
    root_path: RootPath
    repo_url: str | None = Field(
        None,
        max_length=1024,
        description="The git remote at this root. Without it, this mapping's "
        "content level and enabled state cannot carry over to the repository's "
        "auto-match on a reconnected device.",
    )
    content_level: ContentLevel | None = Field(
        None,
        description="Omitted: `rich` where rich capture is enabled, otherwise "
        "`standard`.",
    )
    enabled: bool = True

    _root = field_validator("root_path")(_absolute_root)


class MappingUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    board_id: uuid.UUID | None = None
    content_level: ContentLevel | None = None
    enabled: bool | None = None


class MappingRead(UTCModel):
    id: uuid.UUID
    installation_id: uuid.UUID
    workspace_id: uuid.UUID
    board_id: uuid.UUID | None
    # Null for auto-matched repositories.
    root_path: str | None
    repo_url_normalized: str | None
    origin: Literal["explicit", "auto_repo"]
    enabled: bool
    # To a device: the level it captures at (`capture.effective_content_level`).
    content_level: ContentLevel
    capture: "MappingEffectiveCapture"
    created_at: datetime
    updated_at: datetime


class RepoCatalogEntry(BaseModel):
    workspace_slug: str
    workspace_id: uuid.UUID
    workspace_name: str
    board_id: uuid.UUID
    board_name: str
    repo_url_normalized: str


class DevicePolicyInstallation(CapturePolicy):
    id: uuid.UUID


class DevicePolicy(BaseModel):
    installation: DevicePolicyInstallation
    mappings: list[MappingRead]
    repo_catalog: list[RepoCatalogEntry]
    api_base_url: str | None = Field(
        None,
        description=(
            "The https origin agents the device launches should call "
            "(backplane-mcp's VALARIS_API_URL). It can differ from the endpoint "
            "the device paired against, e.g. when only /api/companion/* is "
            "reachable there. Null when the server's API URL is unset or not "
            "https; the device then keeps using its endpoint."
        ),
    )
    rich_capture: "RichCaptureOffer | None" = Field(
        description="Present (possibly null) from rich capture's first release: "
        "null when this server offers no rich capture to this device."
    )


class AutoMappingRequest(BaseModel):
    """`repo_url` may be raw or already normalized. The device sends no local
    path: it keeps the repository's root on the machine."""

    model_config = ConfigDict(extra="forbid")

    repo_url: str = Field(min_length=1, max_length=1024)


class DeviceMappingCreate(BaseModel):
    """A device binding a local project to a board the owner chose. Without a
    `root_path` the mapping is rootless, like an auto-match: the device keeps
    the repository's local root."""

    model_config = ConfigDict(extra="forbid")

    workspace_id: uuid.UUID
    board_id: uuid.UUID
    root_path: RootPath | None = None
    repo_url: str | None = Field(None, min_length=1, max_length=1024)
    content_level: ContentLevel
    enabled: bool = True

    @field_validator("root_path")
    @classmethod
    def _absolute(cls, value: str | None) -> str | None:
        return None if value is None else _absolute_root(value)

    @model_validator(mode="after")
    def _located(self):
        if self.root_path is None and self.repo_url is None:
            raise ValueError("root_path or repo_url is required")
        return self


def _mapping_request_kind(body: Any) -> str:
    # Anything that is not an object falls to the original body's validation.
    if isinstance(body, dict):
        return "board_choice" if "workspace_id" in body else "repo_match"
    return "board_choice" if isinstance(body, DeviceMappingCreate) else "repo_match"


# The original `{repo_url}` auto-match body keeps working unchanged; naming a
# workspace switches to an explicit board choice.
DeviceMappingRequest = Annotated[
    Annotated[AutoMappingRequest, Tag("repo_match")]
    | Annotated[DeviceMappingCreate, Tag("board_choice")],
    Discriminator(_mapping_request_kind),
]


class DeviceMappingUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content_level: ContentLevel | None = None
    enabled: bool | None = None


class DeviceSettingsUpdate(BaseModel):
    """Retention and pausing are not here: retention is changed on the web only,
    and pausing is local to the device."""

    model_config = ConfigDict(extra="forbid")

    auto_match_repos: bool | None = None
    enabled_agents: list[HarnessName] | None = Field(None, max_length=64)
    exclude_globs: list[ExcludeGlob] | None = Field(None, max_length=128)


class DeviceOwner(BaseModel):
    email: str
    # Null when the owner has not set a name.
    display_name: str | None


class DeviceSelf(BaseModel):
    id: uuid.UUID
    name: str


class DeviceIdentity(BaseModel):
    user: DeviceOwner
    installation: DeviceSelf
    web_origin: str | None = Field(
        description="The web app's origin (`scheme://host[:port]`), for links "
        "the device opens; null when the server has none configured."
    )


class DeviceBoard(BaseModel):
    id: uuid.UUID
    name: str
    # Normalized `host/owner/repo`.
    repos: list[str]


class DeviceWorkspace(BaseModel):
    id: uuid.UUID
    slug: str
    name: str
    boards: list[DeviceBoard]


class DeviceBoardList(BaseModel):
    workspaces: list[DeviceWorkspace]


class BeaconProvenance(BaseModel):
    commit: str | None = Field(None, max_length=64)
    schema_version: str | None = Field(None, max_length=16)


class CaptureRecord(BaseModel):
    """One upload unit. Events are validated individually at ingest (see
    app/schemas/beacon.py) so a bad event rejects only its own record."""

    model_config = ConfigDict(extra="forbid")

    capture_id: CaptureId
    mapping_id: uuid.UUID
    harness: HarnessName
    harness_version: str | None = Field(None, max_length=64)
    collection_method: CollectionMethod
    native_session_id: NativeId
    # Set by subagent threads (e.g. a Codex child thread) to their root thread.
    parent_native_session_id: NativeId | None = None
    captured_at: AwareDatetime
    beacon: BeaconProvenance
    events: list[dict[str, Any]] = Field(
        min_length=1, max_length=MAX_INGEST_EVENTS_PER_RECORD
    )

    @model_validator(mode="after")
    def not_own_parent(self):
        return _not_own_parent(self)


def _not_own_parent(record: "CaptureRecord") -> "CaptureRecord":
    if record.parent_native_session_id == record.native_session_id:
        raise ValueError("A session cannot be its own parent")
    return record


class IngestRejectionReason:
    INVALID = "invalid"
    TOO_LARGE = "too_large"
    CONFLICT = "conflict"
    MAPPING_UNAVAILABLE = "mapping_unavailable"
    MAPPING_DISABLED = "mapping_disabled"
    PAUSED = "paused"
    AGENT_DISABLED = "agent_disabled"
    EXCLUDED = "excluded"


class IngestRejection(BaseModel):
    capture_id: str
    reason: Literal[
        "invalid",
        "too_large",
        "conflict",
        "mapping_unavailable",
        "mapping_disabled",
        "paused",
        "agent_disabled",
        "excluded",
    ]


class IngestDrop(BaseModel):
    capture_id: str
    reason: Literal["session_deleted"]


class HistoryDeleted(BaseModel):
    """This session's history under `mapping_id` was deleted through
    `deleted_through`, on the device's clock: the server drops anything
    observed at or before it and keeps what comes later, so the device need
    not upload the former. `reason`: `owner` deleted it, or `retention`
    removed it after the device's retention period."""

    mapping_id: uuid.UUID
    harness: str
    native_session_id: str
    deleted_through: datetime
    reason: Literal["owner", "retention"]


class IngestResult(BaseModel):
    """`acknowledged` records are done: stored, or deliberately dropped.
    `dropped` lists the acknowledged ones that were not stored (the owner
    deleted that part of the session); the device should delete its local
    copy. `history_deleted` names each session of the batch whose earlier
    history the owner deleted, whether or not this batch reached past it."""

    acknowledged: list[str]
    rejected: list[IngestRejection]
    dropped: list[IngestDrop] = Field(default_factory=list)
    history_deleted: list[HistoryDeleted] = Field(default_factory=list)


class IngestBatchSchema(BaseModel):
    """OpenAPI documentation of the ingest body; the endpoint parses records
    one at a time so it can reject them individually."""

    records: list[CaptureRecord] = Field(min_length=1, max_length=MAX_INGEST_RECORDS)


def ingest_request_schema(batch: type[BaseModel] = IngestBatchSchema) -> dict:
    """`batch`'s schema with its definitions inlined, for the ingest route's
    hand-parsed request body."""
    schema = batch.model_json_schema()
    definitions = schema.pop("$defs", {})

    def inline(value):
        if isinstance(value, dict):
            if "$ref" in value:
                return inline(definitions[value["$ref"].rsplit("/", 1)[-1]])
            return {key: inline(child) for key, child in value.items()}
        if isinstance(value, list):
            return [inline(child) for child in value]
        return value

    return inline(schema)


# The rich-capture models build on the capture record above, and the device
# models above carry them: session_content completes these models once both
# modules exist, whichever is imported first.
import app.schemas.session_content  # noqa: E402,F401
