# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator

from app.core.json_response import UTCModel
from app.schemas.bounded import Str255, Str1024
from app.utils import SLUG_FORMAT


class SkillFile(UTCModel):
    path: Str1024
    content: str


class SkillCreate(UTCModel):
    slug: Str255
    files: list[SkillFile]
    reason: Str1024 | None = None
    base_version: int | None = Field(default=None, ge=1)

    @field_validator("slug")
    @classmethod
    def _validate_slug(cls, value: str) -> str:
        # The slug IS the skill's URL segment — an unvalidated one (e.g. "a/b")
        # creates a skill that no GET path can ever resolve.
        if not SLUG_FORMAT.match(value):
            raise ValueError(
                "slug must match ^[a-z0-9]+(-[a-z0-9]+)*$ "
                "(lowercase, hyphens, no spaces)"
            )
        return value


class SkillVersionCreate(UTCModel):
    files: list[SkillFile]
    reason: Str1024 | None = None
    base_version: int | None = Field(default=None, ge=1)


class SkillProposalCreate(SkillCreate):
    board_id: uuid.UUID | None = None


class SkillProposalRead(UTCModel):
    approval_id: uuid.UUID
    skill_slug: str
    version: int
    status: str


class SkillActorRead(UTCModel):
    user_id: uuid.UUID | None = None
    user_name: str | None = None
    agent_id: uuid.UUID | None = None
    agent_name: str | None = None
    credential_id: uuid.UUID | None = None
    authentication_method: str | None = None


class SkillVersionRead(UTCModel):
    """Version metadata; file contents ride version detail and diff responses."""

    id: uuid.UUID
    version: int
    status: str
    content_hash: str
    created_at: datetime
    created_by_user_id: uuid.UUID | None = None
    created_by_agent_id: uuid.UUID | None = None
    approval_id: uuid.UUID | None = None
    base_version: int | None = None
    reason: str | None = None
    provenance: SkillActorRead | None = None
    source_board_id: uuid.UUID | None = None
    source_card_id: uuid.UUID | None = None
    source_execution_id: uuid.UUID | None = None
    delegation_id: uuid.UUID | None = None
    # Tool names this version's prose references outside its declared
    # `toolsets` — a warning, never a rejection. [] when nothing is declared.
    lint_warnings: list[str]

    model_config = {"from_attributes": True, "populate_by_name": True}


class SkillVersionDetailRead(SkillVersionRead):
    files: list[SkillFile]
    # This version's own `toolsets:` declaration (the hand it plays in).
    toolsets: list[str]


class SkillVersionPageRead(UTCModel):
    items: list[SkillVersionRead]
    next_before_version: int | None


class SkillFileDiffRead(UTCModel):
    path: str
    change: Literal["added", "modified", "deleted"]
    before: str | None
    after: str | None


class SkillDiffRead(UTCModel):
    from_version: int
    to_version: int
    files: list[SkillFileDiffRead]


class SkillAuditEventRead(UTCModel):
    id: uuid.UUID
    skill_id: uuid.UUID
    version: int | None
    event_type: str
    actor: SkillActorRead | None
    reason: str | None
    details: dict | None
    created_at: datetime

    model_config = {"from_attributes": True}


class SkillAuditPageRead(UTCModel):
    items: list[SkillAuditEventRead]
    next_before_id: uuid.UUID | None


class SkillRead(UTCModel):
    id: uuid.UUID
    slug: str
    name: str
    description: str
    latest_published_version: int | None
    origin: str | None
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime
    versions: list[SkillVersionRead]
    # Derived from the resolving version (latest published, else newest):
    # the declared hand and the prose that strays outside it.
    toolsets: list[str]
    lint_warnings: list[str]

    model_config = {"from_attributes": True, "populate_by_name": True}


class SkillListItem(UTCModel):
    id: uuid.UUID
    slug: str
    name: str
    description: str
    latest_published_version: int | None
    origin: str | None
    archived_at: datetime | None
    updated_at: datetime
    toolsets: list[str]

    model_config = {"from_attributes": True, "populate_by_name": True}


class SkillCatalogEntryRead(UTCModel):
    catalog_id: str
    catalog_version: int
    name: str
    description: str
    toolsets: list[str]

    model_config = {"from_attributes": True, "populate_by_name": True}


class BoardSkillBindingPut(UTCModel):
    """Binding update where BOTH fields are tri-state on the wire: an
    OMITTED field leaves the stored value unchanged (a pin-only PUT must not
    re-enable a disabled skill, and an enabled-only PUT must not unpin),
    while `pinned_version: null` EXPLICITLY unpins back to tracking the
    latest published version. Distinguished via `model_fields_set`; the
    `enabled` default applies only when the PUT creates the binding."""

    enabled: bool = True
    pinned_version: int | None = None


class BoardSkillBindingRead(UTCModel):
    board_id: uuid.UUID
    skill_id: uuid.UUID
    enabled: bool
    pinned_version: int | None
    role: str | None
    bound_at: datetime

    model_config = {"from_attributes": True, "populate_by_name": True}


class BoardSkillBindingRow(UTCModel):
    """One RAW binding row — every skill an operator bound to the board,
    enabled or not, resolving or not.

    Distinct from `EffectiveSkillRead`: that answers "what would a runner
    materialize", this answers "what did an operator configure", so the
    board-settings dialog can render a disabled or unresolvable binding
    truthfully instead of as no binding at all. `resolved_version` is what the
    effective set WOULD use — null when the skill has nothing published and
    nothing pinned."""

    skill_id: uuid.UUID
    slug: str
    name: str
    enabled: bool
    pinned_version: int | None
    role: str | None
    resolved_version: int | None
    # The resolved version's declared hand ([] when nothing resolves) and the
    # toolsets the board's loop grant cannot cover — the drift banner path.
    toolsets: list[str]
    uncovered_toolsets: list[str]


class EffectiveSkillRead(UTCModel):
    """One entry of a board's effective set: what a runner would materialize."""

    skill_id: uuid.UUID
    slug: str
    name: str
    description: str
    version: int
    content_hash: str
    enabled: bool
    pinned_version: int | None
    role: str | None
    toolsets: list[str]
    # Declared toolsets whose tools the board's loop grant (`loop_config.tools`)
    # does not fully contain; an empty/absent grant is the whole surface.
    uncovered_toolsets: list[str]
