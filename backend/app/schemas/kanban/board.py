# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from pydantic import field_validator
from app.core.json_response import UTCModel

from app.schemas.kanban.column import ColumnRead
from app.utils import SLUG_FORMAT
from app.schemas.bounded import Str255


def _validate_slug(value: str | None) -> str | None:
    if value is None:
        return None
    if not SLUG_FORMAT.match(value):
        raise ValueError(
            "slug must match ^[a-z0-9]+(-[a-z0-9]+)*$ (lowercase, hyphens, no spaces)"
        )
    return value


class BoardCreate(UTCModel):
    name: Str255
    slug: Str255 | None = None
    description: str = ""
    tags: list[str] = []
    skip_default_columns: bool = False

    _validate_slug = field_validator("slug")(lambda cls, v: _validate_slug(v))


class BoardUpdate(UTCModel):
    name: Str255 | None = None
    slug: Str255 | None = None
    description: str | None = None
    tags: list[str] | None = None
    # Tri-state, and the service reads `model_fields_set` to tell an omitted
    # field (leave the override alone) from an explicit null (clear it back to
    # inheriting the workspace flag). Admin/owner-only — enforced in the service.
    enforce_done_merge_gate: bool | None = None

    _validate_slug = field_validator("slug")(lambda cls, v: _validate_slug(v))


class BoardRead(UTCModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    slug: str | None = None
    description: str
    tags: list[str] = []
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime
    is_frozen: bool = False
    frozen_at: datetime | None = None
    frozen_by_id: uuid.UUID | None = None
    # None = inherit the workspace flag; true/false override it for this board.
    enforce_done_merge_gate: bool | None = None
    # Batched stats from the list endpoint (mirrors WorkspaceRead counts);
    # None on single-board responses, which don't compute them.
    card_count: int | None = None
    column_count: int | None = None
    last_activity_at: datetime | None = None
    # loop_configured reads a Board property (loop_config is always loaded);
    # has_definition is tri-state like card_count — stamped on list/detail
    # reads, None on paths that don't compute it.
    loop_configured: bool = False
    has_definition: bool | None = None

    model_config = {"from_attributes": True}


class BoardDetailRead(BoardRead):
    columns: list[ColumnRead] = []
