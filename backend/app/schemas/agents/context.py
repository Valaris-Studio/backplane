# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import (
    BeforeValidator,
    ConfigDict,
    Field,
    StrictBool,
    model_serializer,
    model_validator,
)

from app.core.json_response import UTCModel

SHA256_HEX_PATTERN = r"^[0-9a-f]{64}$"


class ContextRecord(UTCModel):
    """One selected note occurrence, hashed over the exact bytes it rendered."""

    record_index: int
    note_id: uuid.UUID
    # Display metadata as selected, so history still names a note that was
    # later renamed, re-kinded or deleted.
    title: str
    kind: str
    workspace_id: uuid.UUID
    board_id: uuid.UUID | None = None
    card_id: uuid.UUID | None = None
    # Observed metadata only: the content identity is `revision_sha256`.
    updated_at: datetime
    revision_sha256: str
    rendered_sha256: str
    rendered_bytes: int


def _without_absent(dumped: dict, model: UTCModel, fields: tuple[str, ...]) -> dict:
    # Schema-2 additions are omitted, not null, on schema-1 manifests: legacy
    # payloads, retained v1 receipts and the v1 revision digest stay byte-identical.
    for name in fields:
        if getattr(model, name) is None:
            dumped.pop(name, None)
    return dumped


AdmissionOutcome = Literal["complete", "partial", "empty", "excluded"]
ExclusionReason = Literal[
    "raw_body_limit",
    "fetch_budget",
    "record_too_large",
    "source_budget",
    "total_budget",
    "structure_depth_limit",
    "structure_node_limit",
]


class ContextAdmission(UTCModel):
    """Budgeted admission of one source's bounded candidate window.

    Counts cover the selected window only; a more-candidates sentinel is
    metadata, never a candidate, and no unobserved tail count is invented."""

    required: bool
    outcome: AdmissionOutcome
    candidate_limit: int | None
    candidate_count: int
    has_more_candidates: bool
    admitted_count: int
    excluded_count: int
    max_rendered_bytes: int


class ContextSource(UTCModel):
    """One configured context source, in configuration order.

    `record_traced` sources list every admitted record; `source_only` sources
    carry the hash of their whole rendered block and no record provenance."""

    source_index: int
    kind: str
    alias: str
    filter: dict[str, Any] = Field(default_factory=dict)
    coverage: Literal["record_traced", "source_only"]
    rendered_sha256: str
    rendered_bytes: int
    records: list[ContextRecord] = Field(default_factory=list)
    admission: ContextAdmission | None = None

    @model_serializer(mode="wrap")
    def _omit_absent_admission(self, handler):
        return _without_absent(handler(self), self, ("admission",))


class ContextBudgetPolicyRead(UTCModel):
    version: int
    max_note_body_bytes: int
    max_note_fetch_bytes: int
    max_optional_note_bytes: int
    max_managed_context_bytes: int
    max_invocation_bytes: int


class ContextBudgetReport(UTCModel):
    """Effective policy and what this assembly spent. The invocation limit is
    carried for the final prompt+system gate; assembly does not enforce it."""

    policy: ContextBudgetPolicyRead
    policy_sha256: str
    raw_note_bytes_fetched: int
    managed_context_bytes: int
    raw_note_fetch_coverage: Literal["complete"]
    non_note_fetch_coverage: Literal["not_bounded"]


class ContextExclusion(UTCModel):
    """One candidate left out whole. Header-only exclusions carry no rendered
    size or revision; a non-note block has no note identity."""

    source_index: int
    # Null for board_definition's non-note definition part, ahead of its notes.
    candidate_index: int | None
    note_id: uuid.UUID | None
    title: str | None
    kind: str
    raw_body_bytes: int | None
    rendered_bytes: int | None
    revision_sha256: str | None
    reason: ExclusionReason


class ContextDiagnostics(UTCModel):
    """Whole entries bounded by count and serialized UTF-8 bytes; the counts
    always cover every exclusion in the inspected windows."""

    entries: list[ContextExclusion] = Field(default_factory=list)
    excluded_count: int
    reason_counts: dict[str, int] = Field(default_factory=dict)
    truncated: bool


class ContextManifest(UTCModel):
    schema_version: int
    renderer_version: str
    sources: list[ContextSource] = Field(default_factory=list)
    budget: ContextBudgetReport | None = None
    diagnostics: ContextDiagnostics | None = None

    @model_serializer(mode="wrap")
    def _omit_absent_budget(self, handler):
        return _without_absent(handler(self), self, ("budget", "diagnostics"))


class ExecutionContextRead(UTCModel):
    """Current context for one bound active execution (same shape as the
    assignment's `context` map plus its manifest and revision)."""

    execution_id: uuid.UUID
    context: dict[str, str] = Field(default_factory=dict)
    context_manifest: ContextManifest
    context_revision: str


CONTEXT_DISPATCH_PROTOCOL = "context-dispatch"
CONTEXT_DISPATCH_VERSION = 1
CONTEXT_DISPATCH_HEADER = "X-Backplane-Context-Dispatch-Version"

def _exact_integer(value: Any) -> Any:
    # True == 1.0 == 1 in Python; neither a boolean nor an integer-valued
    # float may negotiate an integer-only protocol version.
    if type(value) is not int:
        raise ValueError("expected the integer 1")
    return value


ProtocolVersion = Annotated[Literal[1], BeforeValidator(_exact_integer)]

DispatchMode = Literal["legacy", "required"]
InvocationKind = Literal["stage", "lifecycle", "mediation", "post_approval"]
PromptSlot = Literal["main", "mediate_rework", "implement_after_approval", "rework_implement"]


class ContextDispatchStamp(UTCModel):
    """The context-dispatch floor negotiated for an assignment or start."""

    version: int
    mode: DispatchMode
    policy_revision: str


class ContextDispatchContractRead(UTCModel):
    protocol: Literal["context-dispatch"] = CONTEXT_DISPATCH_PROTOCOL
    supported_versions: list[int] = Field(default_factory=lambda: [CONTEXT_DISPATCH_VERSION])
    agent_id: uuid.UUID
    workspace_id: uuid.UUID
    policy_revision: str
    mode: DispatchMode
    minimum_version: int
    supported_flows: list[str] = Field(default_factory=lambda: ["scheduled_active_execution"])


class ContextBindingRead(UTCModel):
    """The authorized assignment identity an execution was started under."""

    reservation_id: uuid.UUID
    agent_id: uuid.UUID
    workspace_id: uuid.UUID
    board_id: uuid.UUID
    card_id: uuid.UUID
    role: str
    created_at: datetime
    # NULL for a legacy start. Immutable: later policy changes never lower it.
    context_dispatch: ContextDispatchStamp | None = None

    model_config = {"from_attributes": True}


class ContextReceiptCreate(UTCModel):
    # No `context_manifest` field on purpose: provenance is computed by the
    # server, and an extra caller field is ignored like any unknown input.
    client_request_id: str = Field(min_length=1, max_length=255)
    context_revision: str = Field(pattern=SHA256_HEX_PATTERN)
    input_prompt: str
    system_prompt: str
    provider: str = Field(max_length=255)
    model: str = Field(max_length=255)


class DispatchInvocation(UTCModel):
    model_config = ConfigDict(extra="forbid")

    kind: InvocationKind
    step_name: str | None
    prompt_slot: PromptSlot


class InjectedBytes(UTCModel):
    """Distinct exact-block bytes per channel (union of spans, never a sum of
    provenance rows) and their total."""

    input: int
    system: int
    total: int


class DispatchSummary(UTCModel):
    protocol_version: int
    dispatch_revision: str
    invocation: DispatchInvocation
    inclusion_verification: Literal["required_blocks_exact", "no_required_sources"]
    injected_bytes: InjectedBytes


class ChannelContract(UTCModel):
    model_config = ConfigDict(extra="forbid")

    version: ProtocolVersion
    input: Literal["verbatim"]
    system: Literal["empty", "verbatim"]
    resume: StrictBool


class BlockSpan(UTCModel):
    """Half-open UTF-8 byte offsets of one exact block occurrence."""

    channel: Literal["input", "system"]
    start: int
    end: int


class SourceInclusion(UTCModel):
    source_index: int
    alias: str
    required: bool
    outcome: Literal["exact", "exact_block_not_observed", "empty"]
    spans: list[BlockSpan] = Field(default_factory=list)
    # None means unknown: an unmatched block may have been transformed or
    # omitted, and byte presence cannot tell which.
    contribution_bytes: int | None


class DispatchReceiptDetail(DispatchSummary):
    adapter: str
    resolution_kind: Literal["pinned", "tier"]
    resume_session_id: str | None
    channel_contract: ChannelContract
    required_source_indices: list[int]
    source_inclusions: list[SourceInclusion]


class ContextReceiptSummary(UTCModel):
    """History row: no prompt bodies and no manifest."""

    id: uuid.UUID
    execution_id: uuid.UUID
    ordinal: int
    client_request_id: str
    context_revision: str
    prompt_sha256: str
    prompt_bytes: int
    system_prompt_sha256: str
    system_prompt_bytes: int
    provider: str
    model: str
    status: str
    use_verification: str
    created_at: datetime
    # Context-dispatch v1 rows only; NULL on A1 receipts.
    dispatch_summary: DispatchSummary | None = None

    model_config = {"from_attributes": True}


class ContextReceiptRead(ContextReceiptSummary):
    """One retained invocation snapshot. `prepared`/`not_verified` records the
    input the caller declared, not proof that a provider ran or used it."""

    context_manifest: ContextManifest
    input_prompt: str
    system_prompt: str
    dispatch: DispatchReceiptDetail | None = None


class DispatchToolPolicy(UTCModel):
    deny: list[str] = Field(default_factory=list)


class DispatchPromptTarget(UTCModel):
    role: str
    stage: str


class DispatchFlags(UTCModel):
    post_process_kind: str
    approval_enabled: bool
    inject_directives: bool | None
    use_minimal_prompt_when_unauthored: bool | None


class DispatchSettings(UTCModel):
    """Server-owned rendering inputs for one invocation. `system_template` is
    always empty in v1: prompt configs carry a single content template."""

    provider: str
    model: str
    tier: str
    prompt_slug: str
    prompt_target: DispatchPromptTarget
    input_template: str
    system_template: str
    tool_policy: DispatchToolPolicy
    output_schema: str
    flags: DispatchFlags
    tools: list[str] | None
    required_source_indices: list[int]


class DispatchContextRead(UTCModel):
    protocol_version: int
    mode: DispatchMode
    execution_id: uuid.UUID
    context_binding: ContextBindingRead
    invocation: DispatchInvocation
    context: dict[str, str] = Field(default_factory=dict)
    context_manifest: ContextManifest
    context_revision: str
    dispatch_revision: str
    card: dict[str, Any]
    dispatch: DispatchSettings


class DispatchPreparationCreate(UTCModel):
    """Strict: an unknown member is a 422, never silently dropped, and every
    member takes part in request-key idempotency."""

    model_config = ConfigDict(extra="forbid")

    protocol_version: ProtocolVersion
    client_request_id: str = Field(min_length=1, max_length=255)
    context_revision: str = Field(pattern=SHA256_HEX_PATTERN)
    dispatch_revision: str = Field(pattern=SHA256_HEX_PATTERN)
    invocation: DispatchInvocation
    input_prompt: str
    system_prompt: str
    provider: str = Field(min_length=1, max_length=255)
    adapter: str = Field(min_length=1, max_length=255)
    model: str = Field(min_length=1, max_length=255)
    resolution_kind: Literal["pinned", "tier"]
    resume_session_id: str | None = Field(default=..., min_length=1, max_length=255)
    channel_contract: ChannelContract

    @model_validator(mode="after")
    def _channels_match_payload(self):
        if (self.channel_contract.system == "empty") != (self.system_prompt == ""):
            raise ValueError("channel_contract.system must be 'empty' exactly when system_prompt is empty")
        if self.channel_contract.resume != (self.resume_session_id is not None):
            raise ValueError("channel_contract.resume must match resume_session_id")
        return self


class DispatchPreparationAck(UTCModel):
    protocol_version: int
    acknowledged: Literal["prepared"]
    receipt_id: uuid.UUID
    execution_id: uuid.UUID
    client_request_id: str
    ordinal: int
    context_revision: str
    dispatch_revision: str
    prompt_sha256: str
    prompt_bytes: int
    system_prompt_sha256: str
    system_prompt_bytes: int
    inclusion_verification: Literal["required_blocks_exact", "no_required_sources"]
    use_verification: str
