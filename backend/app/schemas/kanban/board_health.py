# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import date, datetime

from app.core.json_response import UTCModel


class CardBriefInfo(UTCModel):
    id: uuid.UUID
    title: str
    column_name: str
    priority: str
    created_at: datetime

    model_config = {"from_attributes": True}


class StaleCardInfo(CardBriefInfo):
    last_activity_at: datetime | None = None
    days_stale: int


class OverdueCardInfo(CardBriefInfo):
    due_date: date
    days_overdue: int


class EscalatedCardInfo(UTCModel):
    card_id: str
    title: str
    days_stale: int
    actions: list[str]


class EscalationResult(UTCModel):
    escalated: list[EscalatedCardInfo]


class StaleMergeQueueEntryInfo(UTCModel):
    entry_id: uuid.UUID
    card_id: uuid.UUID
    state: str
    attempt_count: int
    age_seconds: int
    error_message: str | None = None
    # worker_stalled = attempts frozen at 0 with no error (the worker never ran
    # the entry); entry_failing = attempts climbing or an error persisted.
    classification: str


class MergeQueueHealth(UTCModel):
    active_count: int
    oldest_queued_age_seconds: int | None = None
    stale_entries: list[StaleMergeQueueEntryInfo]


class BoardHealthRead(UTCModel):
    health_score: int
    total_cards: int
    stale_cards: list[StaleCardInfo]
    overdue_cards: list[OverdueCardInfo]
    unassigned_cards: list[CardBriefInfo]
    cards_without_priority: list[CardBriefInfo]
    cards_without_description: list[CardBriefInfo]
    parked_cards: list[CardBriefInfo]
    priority_distribution: dict[str, int]
    column_distribution: dict[str, int]
    velocity_7d: int
    velocity_30d: int
    agent_efficiency_score: float | None = None
    handoff_friction_hours: float | None = None
    reversion_rate: float | None = None
    merge_queue: MergeQueueHealth
