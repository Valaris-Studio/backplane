# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from app.core.json_response import UTCModel

from app.models.webhooks.webhook import WebhookEvent
from app.schemas.bounded import Str255, Str2048


class WebhookCreate(UTCModel):
    url: Str2048
    events: list[WebhookEvent]
    secret: Str255


class WebhookUpdate(UTCModel):
    url: Str2048 | None = None
    events: list[WebhookEvent] | None = None
    secret: Str255 | None = None
    is_active: bool | None = None


class WebhookRead(UTCModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    url: str
    events: list[str]
    is_active: bool
    last_delivered_at: datetime | None
    failure_count: int
    created_by_id: uuid.UUID
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
