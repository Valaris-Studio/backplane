# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime
from typing import Any, Literal
from app.core.json_response import UTCModel


class NoteRevisionActor(UTCModel):
    user_id: uuid.UUID | None = None
    user_name: str | None = None
    authentication_method: str | None = None
    principal_kind: str | None = None
    agent_id: uuid.UUID | None = None
    agent_name: str | None = None
    api_key_id: uuid.UUID | None = None
    api_key_name: str | None = None
    installation_id: uuid.UUID | None = None


class NoteRevisionSummary(UTCModel):
    revision: int
    recorded_at: datetime
    capture_kind: Literal["creation", "edit", "baseline", "gap_baseline"]
    operation: str
    changed_fields: list[str]
    content_bytes: int
    content_sha256: str
    revision_digest: str
    title: str
    pinned: bool
    card_id: uuid.UUID | None
    kind: str
    source_execution_id: uuid.UUID | None
    actor: NoteRevisionActor | None
    channel: Literal["unconfirmed", "mcp_reported"]


class NoteRevisionSnapshot(UTCModel):
    content: str
    title: str
    pinned: bool
    card_id: uuid.UUID | None
    kind: str
    failure_class: str | None
    findings: list[dict[str, Any]] | None
    source_execution_id: uuid.UUID | None


class NoteRevisionDetail(NoteRevisionSummary):
    snapshot: NoteRevisionSnapshot


class NoteCaptureBoundary(UTCModel):
    first_revision: int
    capture_kind: str


class NoteRevisionPage(UTCModel):
    items: list[NoteRevisionSummary]
    next_before_revision: int | None
    latest_recorded_revision: int
    capture_boundary: NoteCaptureBoundary | None


class NoteRevisionComparison(UTCModel):
    before: NoteRevisionDetail
    after: NoteRevisionDetail
    changed_fields: list[str]
