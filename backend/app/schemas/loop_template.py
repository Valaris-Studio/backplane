# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Wire shapes for the loop-template manager.

Split from `schemas/kanban/loop.py` — that module serves a board's loop CONFIG,
these serve the template catalog behind it. The catalog's own listing entry
(`LoopTemplateRead` there) stays where it is; what changes is that the listing
now carries SUMMARIES, because prompts and tool lists are heavy and the Library
page renders neither.

Write shapes are `extra="forbid"` so a typo'd key fails loudly instead of being
dropped into a template that silently lacks the field the author meant to set.
"""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.completion import CompletionPolicyV1


class LoopTemplateProfile(BaseModel):
    """The human-facing identity a Library card renders."""

    model_config = ConfigDict(extra="allow")

    emoji: str = ""
    tagline: str = ""
    tags: list[str] = Field(default_factory=list)


class LoopTemplateSummary(BaseModel):
    """One listing entry — enough to render a card and sort the list.

    `id` is the system SLUG for code-defined templates and the row UUID for
    workspace ones; `source` says which namespace to read it in, so a client
    never has to guess from the string's shape.
    """

    id: str
    source: str
    name: str
    version: int
    is_system: bool
    is_draft: bool
    has_slots: bool
    profile: dict[str, Any]
    boards_using: int
    last_used_at: str | None = None
    updated_at: str | None = None
    # `updated_at` is the row's mtime and is what the Library sorts by; it is
    # NOT the lock. `draft_updated_at` is the only value `expected_updated_at`
    # is compared against — a client round-trips this one.
    draft_updated_at: str | None = None
    # Published, but the draft has moved since. `is_draft` cannot express this:
    # it means "never published".
    has_unpublished_changes: bool = False

    # P0 compatibility: the shipped BoardLoopDialog applies a template straight
    # from the listing. Kept until the bind step replaces that dialog (p3-05);
    # the manager reads content from GET /{ref} instead.
    description: str = ""
    system_prompt: str = ""
    loop_prompt: str = ""
    tools: list[str] = Field(default_factory=list)


class LoopTemplateDetailRead(BaseModel):
    """One template with its full content — the manager's editing payload."""

    id: str
    # `id` is the REF (system slug / workspace UUID) and keeps that grammar;
    # `slug` is the canonical name lineage and "duplicate as <slug>-copy" use.
    slug: str
    source: str
    name: str
    version: int
    is_system: bool
    is_draft: bool
    profile: dict[str, Any]
    content: dict[str, Any]
    lineage: dict[str, Any] | None = None
    updated_at: str | None = None
    draft_updated_at: str | None = None
    has_unpublished_changes: bool = False


class LoopTemplatePublishRead(LoopTemplateDetailRead):
    """The published template plus any repo-fact leak warnings (spec F12).

    A subclass rather than a `warnings` field on the detail shape itself: every
    read route returns that shape, and an always-empty key there would advertise
    a scan those routes do not run. Publish is the one moment a kernel becomes
    something boards RUN and exports can carry, so it is the one response that
    carries the findings. They never block — the publish already happened.
    """

    warnings: list[dict[str, Any]] = Field(default_factory=list)


class LoopTemplateCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    slug: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=255)
    profile: dict[str, Any] = Field(default_factory=dict)
    content: dict[str, Any] = Field(default_factory=dict)


class LoopTemplateUpdate(BaseModel):
    """Every field optional — this is the autosave path.

    `expected_updated_at` is the draft's optimistic lock, and the value it is
    compared against is `draft_updated_at` from the read shapes — never their
    `updated_at`, which tracks the whole row on a different clock. It is
    optional so the first save after a load, and every non-UI caller, need not
    carry one; when present it must match the token the caller was handed.
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=255)
    profile: dict[str, Any] | None = None
    content: dict[str, Any] | None = None
    expected_updated_at: str | None = None


class LoopTemplatePublish(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_version: int | None = None
    note: str | None = Field(default=None, max_length=500)


class LoopTemplateDuplicate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    new_slug: str | None = Field(default=None, min_length=1, max_length=100)
    new_name: str | None = Field(default=None, min_length=1, max_length=255)


class LoopTemplateVersionRead(BaseModel):
    version: int
    published_at: str
    note: str | None = None


class LoopTemplateTrackRecordBoard(BaseModel):
    """One board's share of a template's history."""

    board_id: str
    iterations: int
    spent_usd: float


class LoopTemplateTrackRecord(BaseModel):
    """Derived from stamped executions — never stored, so it cannot drift.

    Every outcome bucket is always present (a zero is a fact, not a missing
    key), and `unknown` holds iterations written before the runner's
    `outcome=` convention or by a run that never reported one.
    """

    iterations: int
    spent_usd: float
    duration_seconds_total: float
    last_used_at: str | None = None
    boards: list[LoopTemplateTrackRecordBoard] = Field(default_factory=list)
    outcomes: dict[str, int] = Field(default_factory=dict)
    self_terminations: int = 0


class LoopTemplateProfileRead(BaseModel):
    """The profile page: stored identity + derived track record + contract."""

    id: str
    slug: str
    source: str
    name: str
    version: int
    is_system: bool
    profile: dict[str, Any] = Field(default_factory=dict)
    boards_using: int = 0
    versions: list[LoopTemplateVersionRead] = Field(default_factory=list)
    rails_defaults: dict[str, Any] = Field(default_factory=dict)
    tools: list[str] = Field(default_factory=list)
    slots: list[dict[str, Any]] = Field(default_factory=list)
    setup_contract: dict[str, Any] = Field(default_factory=dict)
    track_record: LoopTemplateTrackRecord


class LoopTemplatePreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # A `list` slot takes an array; every other kind takes a string. Spelled
    # out rather than left as `Any` so the wire contract is visible in the
    # OpenAPI surface — the renderer still accepts a newline string for a list
    # (compat with bindings stored before the contract) and reports anything
    # else as `list_slot_expects_array`.
    slot_values: dict[str, str | list[str]] = Field(default_factory=dict)
    draft: bool = True
    version: int | None = Field(default=None, ge=1)
    loop_config: dict[str, Any] | None = None
    completion_policy: CompletionPolicyV1 | None = None


class LoopTemplatePreviewRead(BaseModel):
    """Exactly what the runner would receive, plus why.

    `loop_prompt_with_tools_manifest` is the string the AGENT reads: the runner
    appends its tools manifest after rendering, so a preview showing only
    `loop_prompt` would be missing the block that tells the agent what it may
    call. Both are served because the manager's editor pane shows the authored
    prompt while the bind step shows the runner view.

    `findings` never blocks — a preview that 422'd would hide the very problems
    the operator opened it to see. Errors belong on PUT /loop.
    """

    template: dict
    system_prompt: str
    loop_prompt: str
    loop_prompt_with_tools_manifest: str
    tools: list[str]
    rails: dict[str, Any]
    findings: list[dict]
    missing_required: list[str]
    used_values: dict[str, dict[str, Any]]


class LoopTemplateLintRead(BaseModel):
    """Repo-fact leak warnings for one template (spec F12).

    Wrapped in an object rather than served as a bare list so the response can
    grow a summary or a rule version without breaking callers — and so an empty
    result reads as `{"findings": []}`, which a UI can distinguish from a
    failed request more easily than `[]`.

    Never an error shape: findings are hints and the endpoint is always 200.
    """

    findings: list[dict[str, Any]] = Field(default_factory=list)
