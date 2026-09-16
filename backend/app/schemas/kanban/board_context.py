# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from app.core.json_response import UTCModel


class ColumnSummary(UTCModel):
    id: uuid.UUID
    name: str
    color: str | None = None
    column_type: str | None = None
    position: float
    card_count: int
    priority_distribution: dict[str, int]
    status_distribution: dict[str, int]


class BoardSummary(UTCModel):
    id: uuid.UUID
    name: str
    description: str
    tags: list[str] = []
    total_cards: int
    columns: list[ColumnSummary]


class DefinitionSummary(UTCModel):
    scope: str
    content: dict
    updated_at: datetime
    model_config = {"from_attributes": True}


class NoteSummary(UTCModel):
    id: uuid.UUID
    title: str
    pinned: bool
    created_at: datetime
    model_config = {"from_attributes": True}


class GitRepoSummary(UTCModel):
    id: uuid.UUID
    name: str
    url: str
    provider: str
    default_branch: str
    model_config = {"from_attributes": True}


class ActivitySummary(UTCModel):
    id: uuid.UUID
    entity_type: str
    entity_id: uuid.UUID
    action: str
    summary: str
    created_at: datetime
    actor_name: str | None = None
    actor_email: str | None = None
    model_config = {"from_attributes": True}


class BoardContextRead(UTCModel):
    board: BoardSummary
    definition: DefinitionSummary | None = None
    notes: list[NoteSummary] = []
    git_repos: list[GitRepoSummary] = []
    recent_activity: list[ActivitySummary] = []
