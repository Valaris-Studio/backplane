# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime
from typing import Literal

from pydantic import field_validator
from app.core.json_response import UTCModel

from app.utils import SLUG_FORMAT
from app.schemas.bounded import Str255


def _validate_slug(value: str | None) -> str | None:
    if value is None:
        return None
    if not SLUG_FORMAT.match(value):
        raise ValueError(
            "slug must match ^[a-z0-9][a-z0-9-]*$ (lowercase, digits, hyphens; no leading hyphen)"
        )
    return value


class TeamCreate(UTCModel):
    name: Str255
    slug: Str255 | None = None
    description: str = ""
    board_id: uuid.UUID | None = None

    @field_validator("slug")
    @classmethod
    def slug_format(cls, v: str | None) -> str | None:
        return _validate_slug(v)


class TeamUpdate(UTCModel):
    name: Str255 | None = None
    slug: Str255 | None = None
    description: str | None = None
    board_id: uuid.UUID | None = None
    is_active: bool | None = None

    @field_validator("slug")
    @classmethod
    def slug_format(cls, v: str | None) -> str | None:
        return _validate_slug(v)


class TeamMemberAdd(UTCModel):
    agent_id: uuid.UUID
    # Empty list = role-agnostic default: the runner claims every pipeline
    # role declared by the workspace. A non-empty list narrows the runner to
    # that subset (sharding) — the Go runner will emit a loud Warn at startup
    # listing the pipeline roles it's silently skipping. See
    # feedback_runner_role_agnostic.md.
    roles: list[str] = []

    @field_validator("roles")
    @classmethod
    def roles_well_formed(cls, v: list[str]) -> list[str]:
        for role in v:
            if not role or not role.strip():
                raise ValueError("each role must be a non-empty string")
        return v


class RoleWarning(UTCModel):
    role: str
    reason: Literal["not_in_pipeline"]


class TeamMemberRead(UTCModel):
    agent_id: uuid.UUID
    agent_name: str
    agent_type: str
    roles: list[str]
    added_at: datetime
    role_warnings: list[RoleWarning] = []

    model_config = {"from_attributes": True}


class TeamRead(UTCModel):
    id: uuid.UUID
    name: str
    slug: str | None
    description: str
    workspace_id: uuid.UUID
    board_id: uuid.UUID | None
    created_by_id: uuid.UUID
    is_active: bool
    members: list[TeamMemberRead] = []
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
