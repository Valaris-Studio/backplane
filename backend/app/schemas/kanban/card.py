# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import date, datetime
from enum import Enum
from typing import Any, Literal

from pydantic import ConfigDict, Field, field_validator
from app.core.json_response import UTCModel

from app.schemas.completion import CompletionMode
from app.models.kanban.card import CardType, ParticipantRole, Priority
from app.models.kanban.column import ColumnType
from app.services.notes.content_normalizer import (
    InvalidContentError,
    normalize_note_content,
)


AgentPresence = Literal["none", "eligible", "touched", "suspended", "active"]
DependencyStatus = Literal["ready", "blocked", "unblocked"]


# Mirror the Card model's VARCHAR widths so over-length input is rejected as a
# 422 here instead of escaping as a 500 from Postgres StringDataRightTruncation.
TITLE_MAX_LENGTH = 500
STATUS_MAX_LENGTH = 255


# Card WRITE schemas forbid unknown keys. Pydantic's default (`extra="ignore"`)
# made a misspelled field indistinguishable from a successful write — the caller
# got a 200 echoing the unchanged card and never learned the value was dropped.
# Read schemas keep the permissive default so response shapes stay additive.
STRICT_WRITE = ConfigDict(extra="forbid")


def _normalize_description(value: Any) -> str:
    """Canonical PM JSON for non-empty descriptions (same normalizer as note
    content). Empty stays "" — never inflated to an empty-doc blob, so
    description-less cards carry no PM ballast and `if card.description`
    checks keep working."""
    if value is None or value == "":
        return ""
    try:
        return normalize_note_content(value)
    except InvalidContentError as exc:
        raise ValueError(str(exc)) from exc


class CardFormat(str, Enum):
    """Wire format for a single card read. `prosemirror` (default) returns the
    stored description; `markdown` serializes it back to CommonMark."""

    prosemirror = "prosemirror"
    markdown = "markdown"


class CardCreate(UTCModel):
    model_config = STRICT_WRITE

    title: str = Field(max_length=TITLE_MAX_LENGTH)
    description: str = ""
    card_type: CardType = CardType.task
    priority: Priority = Priority.none
    column_id: uuid.UUID
    due_date: date | None = None
    status: str | None = Field(default=None, max_length=STATUS_MAX_LENGTH)
    labels: list[str] | None = None
    # Multi-repo boards: which of the board's git_repos this card targets,
    # matched against GitRepo.slug. NULL = the board's primary/first repo.
    git_repo_slug: str | None = None
    completion_mode: CompletionMode = "source"

    @field_validator("description", mode="before")
    @classmethod
    def _normalize(cls, v: Any) -> str:
        return _normalize_description(v)


class CardUpdate(UTCModel):
    model_config = STRICT_WRITE

    title: str | None = Field(default=None, max_length=TITLE_MAX_LENGTH)
    # Explicit null is "no change", never "clear" — clearing is spelled "".
    # The service drops a None description before the repo update (the column
    # is NOT NULL).
    description: str | None = None

    @field_validator("description", mode="before")
    @classmethod
    def _normalize(cls, v: Any) -> str | None:
        if v is None:
            return None
        return _normalize_description(v)
    card_type: CardType | None = None
    priority: Priority | None = None
    due_date: date | None = None
    status: str | None = Field(default=None, max_length=STATUS_MAX_LENGTH)
    labels: list[str] | None = None
    pr_url: str | None = None
    branch_name: str | None = None
    git_repo_slug: str | None = None
    completion_mode: CompletionMode | None = None


class CardMoveRequest(UTCModel):
    model_config = STRICT_WRITE

    column_id: uuid.UUID
    # Omitted → the service appends to the end of the target column
    # (max_position + 1024), so a claim-style move need not invent a position.
    position: float | None = None


class ParticipantUserRead(UTCModel):
    id: uuid.UUID
    name: str
    email: str
    avatar_url: str | None = None

    model_config = {"from_attributes": True}


class ParticipantAgentRead(UTCModel):
    id: uuid.UUID
    name: str
    agent_type: str

    model_config = {"from_attributes": True}


class CardParticipantRead(UTCModel):
    user_id: uuid.UUID
    agent_id: uuid.UUID | None = None
    role: str
    # Pipeline-stage role discriminator. NULL on legacy rows and on rows added
    # via the human UI before the column existed. See models.kanban.card for
    # the column-level rationale.
    pipeline_role: str | None = None
    added_at: datetime
    user: ParticipantUserRead
    agent: ParticipantAgentRead | None = None

    model_config = {"from_attributes": True}


class ParticipantAdd(UTCModel):
    user_id: uuid.UUID
    role: ParticipantRole
    agent_id: uuid.UUID | None = None
    # Free-form pipeline-stage role (planner, implementer, reviewer,
    # documentator, rework_mediator, …). Bounded to 64 chars to match the
    # column type; user-defined roles ride the same field.
    pipeline_role: str | None = Field(default=None, max_length=64)


class CardClaimRequest(UTCModel):
    agent_id: uuid.UUID


class CardRead(UTCModel):
    id: uuid.UUID
    column_id: uuid.UUID
    # Derived column labels so a card payload is self-describing: a caller can
    # tell WHERE a card sits without a second board lookup. Populated by
    # `attach_column_labels` (one batched SELECT per response). Default None
    # keeps every existing CardRead construction site valid.
    column_name: str | None = None
    column_type: ColumnType | None = None
    board_id: uuid.UUID
    title: str
    description: str
    card_type: CardType
    priority: Priority
    position: float
    created_by: uuid.UUID
    due_date: date | None = None
    status: str | None = None
    labels: list[str] | None = None
    # PAR-3a: set on conflict-resolution consolidator cards (PAR-3c) to point
    # back at the original card whose merge failed. Read-only on the API; the
    # value is written by the consolidator-creation path, not by clients.
    parent_card_id: uuid.UUID | None = None
    # UX-3: first-class PR URL + branch. Authoritative replacement for the
    # legacy description footer. NULL for cards predating the rollout.
    pr_url: str | None = None
    branch_name: str | None = None
    # Cluster I: optional per-card budget runway (USD). NULL = use the
    # workspace-global max_budget_usd ceiling. Surfaced in the next-assignment
    # bundle so the runner's budget-SUSPEND classifier can read it.
    budget_usd_override: float | None = None
    # Multi-repo boards: the card's target repo slug (NULL = board primary).
    git_repo_slug: str | None = None
    completion_mode: CompletionMode = "source"
    participants: list[CardParticipantRead] = []
    # Derived: true iff a pending ApprovalRequest references this card, either
    # through `action_payload.card_id` (canonical signal — see prompt_defaults)
    # or `execution.cards_affected` (fallback). Populated by the repo layer
    # via a single batched SELECT; never stored. Frontend uses this to warn
    # operators that the card's runner is blocked on a human decision.
    has_pending_approval: bool = False
    pending_approval_id: uuid.UUID | None = None
    # Derived four-state runner presence. Resolved server-side to avoid the
    # UX wart where a runner participant on the card unconditionally renders
    # an "actively working" indicator. States:
    #   none     -> no signal
    #   eligible -> a participant has agent_id; a runner can pick this up
    #   touched  -> at least one agent-originated activity log row exists
    #   active   -> a started/running AgentExecution lists this card in
    #               cards_affected; `active_execution_id` points to it
    # Precedence: active > touched > eligible > none.
    agent_presence: AgentPresence = "none"
    active_execution_id: uuid.UUID | None = None
    # Latest agent-originated Activity.created_at for this card, regardless
    # of the resolved state — a currently-active card may still expose a
    # past activity timestamp so the "sort by agent activity" column works.
    last_agent_activity_at: datetime | None = None
    # Derived dependency counts so the board view can render the dep-chip
    # without N+1 dependency queries. Populated by `attach_dependency_counts`
    # on every surface that builds CardRead. `dependency_status` is the
    # three-state derivation used by the chip ("blocked" iff any depends_on
    # target sits outside a done-typed column).
    depends_on_count: int = 0
    blocks_count: int = 0
    dependency_status: DependencyStatus = "ready"
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class CardSummary(UTCModel):
    """Browse-view card WITHOUT description, participants, or derived ballast.

    Returned by the search endpoint when `?summary_only=true`. A label query on
    a busy board returns full CardRead payloads well past 100KB — enough to
    overflow an MCP client's token budget on what is meant to be a cheap triage
    scan. The retained fields are exactly what a caller needs to decide which
    card to fetch in full: identity, where it sits, and how it is classified.

    `position` is part of that decision, not ballast: the documented triage rule
    breaks priority ties by lowest position, and omitting it sent agents back to
    the unsummarised payload for ordering alone — defeating the projection.
    """

    id: uuid.UUID
    title: str
    column_id: uuid.UUID
    column_name: str | None = None
    column_type: ColumnType | None = None
    labels: list[str] | None = None
    position: float
    priority: Priority
    status: str | None = None
    card_type: CardType

    model_config = {"from_attributes": True}


class BulkCardCreate(UTCModel):
    cards: list[CardCreate]

    @field_validator("cards")
    @classmethod
    def validate_card_count(cls, v):
        if len(v) == 0:
            raise ValueError("At least one card is required")
        if len(v) > 50:
            raise ValueError("Maximum 50 cards per bulk request")
        return v


class BulkCardCreateResponse(UTCModel):
    created: int
    cards: list[CardRead]
