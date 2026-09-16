# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from app.core.json_response import UTCModel

from app.models.approvals.approval import ApprovalCategory, ApprovalStatus


class ApprovalCreate(UTCModel):
    agent_id: uuid.UUID
    category: ApprovalCategory
    action_description: str
    action_payload: dict = {}
    board_id: uuid.UUID | None = None
    execution_id: uuid.UUID | None = None


class ApprovalDecide(UTCModel):
    decision: ApprovalStatus  # approved or rejected
    reason: str | None = None


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
