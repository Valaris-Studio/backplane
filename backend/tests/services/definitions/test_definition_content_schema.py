# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import pytest
from pydantic import ValidationError

from app.schemas.definitions.definition import (
    DefinitionContent,
    DefinitionUpsert,
)


def test_definition_content_empty_uses_defaults():
    content = DefinitionContent()

    assert content.objectives == []
    assert content.exclusions == []
    assert content.milestones == []
    assert content.tech_stack == []
    assert content.stakeholders == []
    assert content.constraints == []
    assert content.decisions == []
    assert content.references == []
    assert content.custom_fields == []


def test_definition_content_structured_round_trips():
    raw = {
        "objectives": [{"text": "Launch beta", "priority": "high"}],
        "exclusions": ["No mobile app"],
        "milestones": [{"title": "Alpha", "date": "2026-04-01", "type": "deadline"}],
        "tech_stack": ["Python", "FastAPI"],
        "stakeholders": [
            {
                "name": "Alice",
                "role": "PO",
                "member_id": None,
                "channel_id": None,
            }
        ],
        "constraints": ["Tight timeline"],
        "decisions": [{"decision": "Use Postgres", "rationale": "Relational data"}],
        "references": [{"label": "Spec", "url": "https://example.com"}],
        "custom_fields": [{"key": "budget", "value": "10k"}],
    }

    dumped = DefinitionContent(**raw).model_dump()

    assert dumped["objectives"] == [{"text": "Launch beta", "priority": "high"}]
    assert dumped["milestones"] == [
        {"title": "Alpha", "date": "2026-04-01", "type": "deadline"}
    ]
    assert dumped["stakeholders"][0]["name"] == "Alice"
    assert dumped["decisions"][0]["decision"] == "Use Postgres"
    assert dumped["references"][0]["url"] == "https://example.com"
    assert dumped["custom_fields"][0]["key"] == "budget"


def test_definition_content_preserves_unknown_keys():
    raw = {
        "tech_stack": ["Go"],
        "coding_standards": "gofmt + golangci-lint",
        "weird_custom_key": {"nested": [1, 2, 3]},
        "_overflow": {"legacy": True},
    }

    dumped = DefinitionContent(**raw).model_dump()

    assert dumped["tech_stack"] == ["Go"]
    assert dumped["coding_standards"] == "gofmt + golangci-lint"
    assert dumped["weird_custom_key"] == {"nested": [1, 2, 3]}
    assert dumped["_overflow"] == {"legacy": True}


def test_definition_content_coerces_legacy_string_objectives():
    dumped = DefinitionContent(objectives=["Ship v1", "Onboard users"]).model_dump()

    assert dumped["objectives"] == [
        {"text": "Ship v1", "priority": None},
        {"text": "Onboard users", "priority": None},
    ]


def test_definition_content_rejects_grossly_wrong_objectives_type():
    with pytest.raises(ValidationError):
        DefinitionContent(objectives="not a list")


def test_definition_upsert_validates_content_through_definition_content():
    upsert = DefinitionUpsert(content={"objectives": ["Goal A"], "extra_key": 42})

    assert upsert.content["objectives"] == [{"text": "Goal A", "priority": None}]
    assert upsert.content["extra_key"] == 42


def test_definition_upsert_none_content_passes():
    upsert = DefinitionUpsert(scope="Only scope")

    assert upsert.content is None


def test_definition_upsert_rejects_invalid_content_shape():
    with pytest.raises(ValidationError):
        DefinitionUpsert(content={"objectives": "should be a list"})
