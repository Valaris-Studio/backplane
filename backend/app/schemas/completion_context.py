# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class CompletionContextContributor(BaseModel):
    source: str
    bytes: int
    id: str | None = None
    title: str | None = None


class CompletionContextSize(BaseModel):
    bytes: int
    limit_bytes: int
    within_limit: bool
    contributors: list[CompletionContextContributor]


class CompletionContextAffectedAttempt(BaseModel):
    attempt_id: uuid.UUID
    execution_id: uuid.UUID
    board_id: uuid.UUID
    kind: str
    role: str
    expires_at: datetime
    binding_known: bool


class CompletionContextImpact(BaseModel):
    attempts: list[CompletionContextAffectedAttempt]


ContextSourceKind = Literal["note", "definition", "prompt", "configuration"]
