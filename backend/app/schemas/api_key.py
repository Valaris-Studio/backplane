# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from app.core.json_response import UTCModel


class ApiKeyCreate(UTCModel):
    name: str


class ApiKeyRead(UTCModel):
    id: uuid.UUID
    name: str
    key_prefix: str
    created_at: datetime
    last_used_at: datetime | None = None

    model_config = {"from_attributes": True}


class ApiKeyCreated(ApiKeyRead):
    raw_key: str
