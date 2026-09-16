# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from pydantic import Field
from app.core.json_response import UTCModel

from app.schemas.kanban.card import CardRead


class NextAssignmentRequest(UTCModel):
    role_override: str | None = None
    board_id: uuid.UUID | None = None


class AssignmentBoard(UTCModel):
    id: uuid.UUID
    slug: str | None = None
    name: str


class AssignmentColumn(UTCModel):
    id: uuid.UUID
    name: str
    column_type: str


class AssignmentRepo(UTCModel):
    id: uuid.UUID
    slug: str | None = None
    name: str
    url: str
    default_branch: str
    integration_branch: str | None = None


class ReservationInfo(UTCModel):
    id: uuid.UUID
    expires_at: datetime


class AssignmentToolPolicy(UTCModel):
    """Backend-authoritative tool deny-list for the stage's LLM subprocess.

    `deny` holds claude-CLI tool/Bash-pattern strings (e.g.
    `Bash(gh pr merge:*)`) the autonomous agent must NOT run. The strings are
    opaque to the backend — it carries them verbatim; the runner applies them
    as `claude --permission-mode bypassPermissions --disallowedTools <entries>`.
    This is the security floor that protects the review gate (no self-merge,
    no force-push, no push-to-main). Deny-only — there is no allow-list.
    """

    deny: list[str] = Field(default_factory=list)


class AssignmentLLM(UTCModel):
    """Per-stage LLM dispatch info. Provider + model are backend-authoritative;
    the runner must use them rather than its yaml defaults. prompt_slug
    identifies which prompt template the runner should render — defaults to
    the stage name when no operator override exists. tool_policy carries the
    per-stage tool deny-list (empty `deny` for stages without a configured
    policy).

    tier carries the RAW tier name (premium/mid/low) when the stage's model is
    an abstract tier — empty for a concrete/literal model. It is the
    provider-agnostic intent: a runner may remap a tier to whichever local
    coding agent it has via its llm.tier_providers config, treating
    provider+model as the resolved hint/fallback. Empty for old configs and
    pinned models; old runners simply ignore it."""

    provider: str
    model: str
    prompt_slug: str
    tier: str = ""
    tool_policy: AssignmentToolPolicy = Field(default_factory=AssignmentToolPolicy)
    # Per-stage structured-output schema (JSON Schema string) for a
    # produces_decision stage whose decision enum differs from the default
    # approve/request_changes envelope. Empty → the runner applies its built-in
    # decisionOutputSchema. board_reconciler is the first role to set it (its
    # decisions are supersede/no_action/repair/park). Opaque to the backend: we
    # carry the string verbatim; the runner passes it to the agent via
    # --json-schema / --output-schema. Empty for every other stage and old
    # configs; old runners ignore it.
    output_schema: str = ""


class AssignmentSkill(UTCModel):
    """One entry of the board's effective skills manifest on the wire.

    Sync contract: mirrored by `AssignmentSkill` in
    runner/internal/valaris/client_skills.go (decoded by client.go) — the two sides
    change in the same commit. Wire fields are exactly what the runner needs
    to materialize and report a skill bundle: slug/name/description for the
    agent-facing catalog, version + content_hash to fetch and verify the
    published files. Board-authority fields (skill_id, enabled,
    pinned_version, role) deliberately stay off the wire. Additive: old
    runners simply ignore it."""

    slug: str
    name: str
    description: str
    version: int
    content_hash: str


class NextAssignmentResponse(UTCModel):
    card: CardRead
    board: AssignmentBoard
    column: AssignmentColumn
    repo: AssignmentRepo | None = None
    role: str
    stage_action: str
    reservation: ReservationInfo
    context: dict[str, str] = Field(
        default_factory=dict,
        description="Pre-rendered context_sources keyed by `as` alias.",
    )
    llm: AssignmentLLM
    # LIFECYCLE-1 A.1: when the stage carries a `lifecycle: [...]` array
    # (the new generic walker DSL), pass it through verbatim. The runner
    # walker in lane A.2 consumes this list directly. Empty/missing means
    # the runner falls back to the legacy hardcoded lifecycle.
    lifecycle: list[dict] | None = Field(
        default=None,
        description="Generic lifecycle steps for the runner walker (lane A.2).",
    )
    # Skills Registry W3: the board's effective skill set at reservation time,
    # slug-ascending, for the skills_setup lifecycle step. None (not []) when
    # the board has no bound skills so old runners see nothing new.
    skills: list[AssignmentSkill] | None = None
