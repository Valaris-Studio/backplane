# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime
from enum import Enum

from app.core.json_response import UTCModel

from app.schemas.kanban.card import CardRead
from app.schemas.bounded import Str7, Str255


class ColumnTypeEnum(str, Enum):
    backlog = "backlog"
    active = "active"
    review = "review"
    done = "done"
    blocked = "blocked"


class ColumnCreate(UTCModel):
    name: Str255
    color: Str7 | None = None
    column_type: ColumnTypeEnum | None = None


class ColumnUpdate(UTCModel):
    name: Str255 | None = None
    color: Str7 | None = None
    column_type: ColumnTypeEnum | None = None


class ColumnReorderRequest(UTCModel):
    column_ids: list[uuid.UUID]


class ColumnRead(UTCModel):
    id: uuid.UUID
    board_id: uuid.UUID
    name: str
    position: float
    color: str | None = None
    column_type: ColumnTypeEnum | None = None
    created_at: datetime
    updated_at: datetime
    cards: list[CardRead] = []

    model_config = {"from_attributes": True}
