# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Pydantic shapes for card_dependencies (DEP-3, spec note 233e4429 §A5)."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import ConfigDict
from app.core.json_response import UTCModel


class CardDependencyCreate(UTCModel):
    depends_on_card_id: uuid.UUID


class CardDependencyRead(UTCModel):
    """Wire shape for one card_dependencies row.

    `depends_on_*` projections are denormalised for the scheduler-friendly
    detail view (no client-side N+1). The list_for_card endpoint fills them
    via a single bounded join.
    """

    model_config = ConfigDict(from_attributes=True)

    card_id: uuid.UUID
    depends_on_card_id: uuid.UUID
    depends_on_title: str | None = None
    depends_on_status: str | None = None
    depends_on_column_type: str | None = None
    satisfied: bool = False
    created_at: datetime
    created_by: uuid.UUID


class CardDependenciesView(UTCModel):
    ready: bool = True
    depends_on: list[CardDependencyRead]
    blocks: list[CardDependencyRead]


class CardDependencyBulkSet(UTCModel):
    depends_on_card_ids: list[uuid.UUID]


class BoardDependencyEdge(UTCModel):
    """One directed edge for the board-level tree view: `card_id` depends on
    `depends_on_card_id`. Bare ids — the client already holds the card data."""

    card_id: uuid.UUID
    depends_on_card_id: uuid.UUID


class CycleInfo(UTCModel):
    """One strongly-connected component of >=2 mutually-reachable cards (a
    self-loop is impossible — the model's CHECK constraint forbids it)."""

    card_ids: list[uuid.UUID]
    titles: list[str]
    summary: str


class ConflictInfo(UTCModel):
    """A card in a done-typed column that still depends on at least one card
    that is NOT in a done-typed column — an unsatisfied prerequisite on
    something already marked done."""

    card_id: uuid.UUID
    title: str
    unsatisfied_dependency_ids: list[uuid.UUID]
    unsatisfied_dependency_titles: list[str]
    summary: str


class OrphanInfo(UTCModel):
    """A dangling edge: one endpoint is not a live card on this board (e.g. a
    cross-board reference). `*_on_board` flags say which endpoint is missing."""

    card_id: uuid.UUID
    depends_on_card_id: uuid.UUID
    card_on_board: bool
    depends_on_on_board: bool
    summary: str


class BoardDependencyValidation(UTCModel):
    ok: bool
    cycles: list[CycleInfo]
    conflicts: list[ConflictInfo]
    orphans: list[OrphanInfo]
