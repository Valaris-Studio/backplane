# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from pydantic import BaseModel


class SubscribeMessage(BaseModel):
    subscribe: list[str]


class UnsubscribeMessage(BaseModel):
    unsubscribe: list[str]


class EventMessage(BaseModel):
    event: str
    payload: dict
    timestamp: str
    event_id: str
