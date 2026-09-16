# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from app.core.json_response import UTCModel

from app.models.alerts.alert_threshold import AlertMetric, AlertOperator
from app.schemas.bounded import Str255


class AlertThresholdCreate(UTCModel):
    name: Str255
    metric: AlertMetric
    operator: AlertOperator
    value: float
    board_id: uuid.UUID | None = None


class AlertThresholdUpdate(UTCModel):
    name: Str255 | None = None
    metric: AlertMetric | None = None
    operator: AlertOperator | None = None
    value: float | None = None
    is_active: bool | None = None


class AlertThresholdRead(UTCModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    board_id: uuid.UUID | None
    name: str
    metric: AlertMetric
    operator: AlertOperator
    value: float
    is_active: bool
    created_by_id: uuid.UUID
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
