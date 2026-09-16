# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from pydantic import Field
from app.core.json_response import UTCModel
from app.schemas.bounded import Str100, Str255


class PromptConfigRead(UTCModel):
    id: uuid.UUID
    name: str
    slug: str
    agent_type: str | None
    team_role: str | None
    stage: str
    content: str
    # Derived: `content` + the post_process imperative matching this prompt's
    # (team_role, stage) in the workspace pipeline_config. Operators edit
    # `content`; runners consume `resolved_content`. See B11 in
    # audits/runner-launch-walkthrough-2026-04-18.md.
    resolved_content: str
    is_system: bool
    workspace_id: uuid.UUID | None
    team_id: uuid.UUID | None
    version: int
    created_by_id: uuid.UUID
    created_at: datetime
    updated_at: datetime
    # Non-blocking context-source ↔ prompt wiring findings (severity="warning")
    # for the stage this prompt drives. Populated on read and after a save.
    context_source_warnings: list[dict] = Field(default_factory=list)

    model_config = {"from_attributes": True}


class PromptConfigCreate(UTCModel):
    name: Str255
    slug: Str255
    agent_type: str | None = None
    team_role: str | None = None
    stage: Str100
    content: str
    team_id: uuid.UUID | None = None


class PromptConfigUpdate(UTCModel):
    name: Str255 | None = None
    slug: Str255 | None = None
    agent_type: str | None = None
    team_role: str | None = None
    stage: Str100 | None = None
    content: str | None = None
    team_id: uuid.UUID | None = None


class PromptStageDefault(UTCModel):
    """Metadata + default content for a prompt stage."""
    slug: str
    role: str
    stage: str
    description: str
    template_variables: list[str]
    default_content: str
