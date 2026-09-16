# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from app.core.json_response import UTCModel

from app.models.channels.channel import ChannelType
from app.schemas.bounded import Str255, Str500


class ChannelCreate(UTCModel):
    name: Str255
    channel_type: ChannelType
    contact_value: Str500
    description: str = ""
    metadata_json: dict | None = None


class ChannelUpdate(UTCModel):
    name: Str255 | None = None
    channel_type: ChannelType | None = None
    contact_value: Str500 | None = None
    description: str | None = None
    metadata_json: dict | None = None


class ChannelRead(UTCModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    channel_type: ChannelType
    contact_value: str
    description: str
    metadata_json: dict | None
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ChannelListRead(UTCModel):
    """`?summary=true` shape for the channels list: ChannelRead without the
    unbounded `metadata_json` blob, which no list surface renders and the
    channel editor never round-trips on save."""

    id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    channel_type: ChannelType
    contact_value: str
    description: str
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
