# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from pydantic import ConfigDict, field_validator, model_validator
from app.core.json_response import UTCModel


class Objective(UTCModel):
    text: str
    priority: str | None = None

    # Legacy/agent-authored definitions store objectives as bare strings; the
    # frontend normalizer wraps them, so the backend mirrors that tolerance.
    @model_validator(mode="before")
    @classmethod
    def coerce_legacy_string(cls, value):
        if isinstance(value, str):
            return {"text": value, "priority": None}
        return value


class Milestone(UTCModel):
    title: str
    date: str
    type: str | None = None


class Stakeholder(UTCModel):
    name: str
    role: str = ""
    member_id: str | None = None
    channel_id: str | None = None


class KeyDecision(UTCModel):
    decision: str
    rationale: str = ""


class Reference(UTCModel):
    label: str = ""
    url: str


class CustomField(UTCModel):
    key: str
    value: str = ""


class DefinitionContent(UTCModel):
    """Typed view over the board definition blob.

    Every field is optional with an empty-collection default so partial and
    legacy payloads validate. ``extra="allow"`` preserves the frontend's
    ``_overflow`` bag and any unknown keys on existing prod definitions, which
    is what makes the validation migration-safe (no data is ever dropped).
    """

    model_config = ConfigDict(extra="allow")

    objectives: list[Objective] = []
    exclusions: list[str] = []
    milestones: list[Milestone] = []
    tech_stack: list[str] = []
    stakeholders: list[Stakeholder] = []
    constraints: list[str] = []
    decisions: list[KeyDecision] = []
    references: list[Reference] = []
    custom_fields: list[CustomField] = []


class DefinitionUpsert(UTCModel):
    scope: str | None = None
    content: dict | None = None

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: dict | None) -> dict | None:
        if value is None:
            return None
        # None field-values are the shallow-merge delete sentinel; keep them out
        # of validation (a typed list field would reject None) and re-attach so
        # the service merge can drop those keys.
        delete_sentinels = {k: v for k, v in value.items() if v is None}
        to_validate = {k: v for k, v in value.items() if v is not None}
        # exclude_unset keeps only caller-supplied keys so the service's
        # shallow-merge semantics stay intact; default empty collections are
        # never injected over existing data.
        validated = DefinitionContent.model_validate(to_validate).model_dump(
            exclude_unset=True
        )
        return {**validated, **delete_sentinels}


class DefinitionRead(UTCModel):
    id: uuid.UUID
    board_id: uuid.UUID
    workspace_id: uuid.UUID
    scope: str
    content: dict
    updated_by: uuid.UUID
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
