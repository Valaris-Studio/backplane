# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Phase 3 — Notification HTTP API schemas.

White-label (INV-5): every payload carries STRUCTURED data only — stable category
keys, structured `params`, channel keys. No human-readable copy; the FE composes
display strings from `category` + `params` via i18n.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import Field
from app.core.json_response import UTCModel


class NotificationRead(UTCModel):
    id: uuid.UUID
    recipient_user_id: uuid.UUID
    workspace_id: uuid.UUID
    board_id: uuid.UUID | None
    category: str
    actor_id: uuid.UUID | None
    is_agent_actor: bool
    entity_type: str
    entity_id: uuid.UUID | None
    params: dict
    link: dict | None
    read_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}


class UnreadCountRead(UTCModel):
    count: int


class NotificationPreferenceRead(UTCModel):
    """Raw prefs (the user's stored knobs) plus the resolved `effective` map the
    FE renders the grid from: category -> {channel_key: bool}. The effective map
    is total over CATEGORY_DEFAULTS × registered channels so the grid stays
    data-driven (a new channel/category needs no FE change)."""

    relevance_scope: str
    category_overrides: dict
    muted: bool
    effective: dict[str, dict[str, bool]]


class NotificationPreferenceUpdate(UTCModel):
    relevance_scope: str | None = None
    category_overrides: dict | None = None
    muted: bool | None = None


class ChannelsRead(UTCModel):
    channels: list[str] = Field(default_factory=list)
