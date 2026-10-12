# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import uuid
from datetime import datetime

from pydantic import Field, field_validator

from app.core.json_response import UTCModel

from app.models.approvals.approval import ApprovalCategory, ApprovalStatus
from app.services.approvals.rich_text import sanitise_action_payload, sanitise_rich_text


# Same cap as a completion's output/summary. These fields are scrubbed for
# unsafe URLs inside the request handler, so their size must be bounded.
APPROVAL_TEXT_MAX_LENGTH = 16_384
ACTION_PAYLOAD_MAX_BYTES = 65_536


class ApprovalCreate(UTCModel):
    agent_id: uuid.UUID
    category: ApprovalCategory
    action_description: str = Field(max_length=APPROVAL_TEXT_MAX_LENGTH)
    action_payload: dict = {}
    board_id: uuid.UUID | None = None
    execution_id: uuid.UUID | None = None

    @field_validator("action_payload")
    @classmethod
    def _bounded_payload(cls, value: dict) -> dict:
        if len(json.dumps(value).encode()) > ACTION_PAYLOAD_MAX_BYTES:
            raise ValueError(f"action_payload must serialise to at most {ACTION_PAYLOAD_MAX_BYTES} bytes of JSON")
        return value


class ApprovalDecide(UTCModel):
    decision: ApprovalStatus  # approved or rejected
    reason: str | None = Field(default=None, max_length=APPROVAL_TEXT_MAX_LENGTH)


class ApprovalRead(UTCModel):
    id: uuid.UUID
    agent_id: uuid.UUID
    workspace_id: uuid.UUID
    board_id: uuid.UUID | None
    category: ApprovalCategory
    action_description: str
    action_payload: dict
    risk_score: int
    status: ApprovalStatus
    decided_by_id: uuid.UUID | None
    decided_at: datetime | None
    decision_reason: str | None
    expires_at: datetime
    execution_id: uuid.UUID | None
    agent_name: str | None = None
    decided_by_name: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}

    # Rows saved before the write-path strip existed must not reach a reader raw.
    @field_validator("action_description", "decision_reason")
    @classmethod
    def _sanitise_rich_text(cls, value: str | None) -> str | None:
        return sanitise_rich_text(value)

    @field_validator("action_payload")
    @classmethod
    def _sanitise_action_payload(cls, value: dict) -> dict:
        return sanitise_action_payload(value)
