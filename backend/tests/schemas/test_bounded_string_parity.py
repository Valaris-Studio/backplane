# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Bounded VARCHAR columns must be mirrored by a Pydantic `max_length`.

Postgres raises `StringDataRightTruncation` on an over-length write and it
escapes the router as an unhandled 500. Card `dafcf904` fixed that for
`CardCreate`/`CardUpdate`; this module pins the same contract for every other
client-settable field that feeds a bounded `String(N)` column.

SQLite (the test DB) silently accepts an over-length value, so nothing here may
assert through the DB — every assertion targets the Pydantic layer, which is the
only layer that rejects the value on BOTH engines.

The parity test is the load-bearing one: hand-written `max_length=` literals
drift from the column widths they mirror, which is the very failure this card
exists to prevent. It reads the width off the SQLAlchemy column and the limit
off the Pydantic field, so a model widening that forgets the schema fails here.
"""

from typing import get_args

import pytest
from pydantic import BaseModel, ValidationError
from sqlalchemy import String

from app.models.agents.agent import Agent
from app.models.agents.prompt_config import AgentPromptConfig
from app.models.agents.team import AgentTeam
from app.models.alerts.alert_threshold import AlertThreshold
from app.models.channels.channel import Channel
from app.models.git.git_repo import GitRepo
from app.models.kanban.board import Board
from app.models.kanban.column import Column
from app.models.notes.note import Note
from app.models.resources.resource import Resource
from app.models.webhooks.webhook import Webhook
from app.models.workspace import Workspace
from app.schemas.agents.agent import AgentCreate, AgentUpdate
from app.schemas.agents.prompt_config import PromptConfigCreate, PromptConfigUpdate
from app.schemas.agents.team import TeamCreate, TeamUpdate
from app.schemas.alerts.alert_threshold import (
    AlertThresholdCreate,
    AlertThresholdUpdate,
)
from app.schemas.channels.channel import ChannelCreate, ChannelUpdate
from app.schemas.git.git_repo import GitRepoCreate, GitRepoUpdate
from app.schemas.kanban.board import BoardCreate, BoardUpdate
from app.schemas.kanban.column import ColumnCreate, ColumnUpdate
from app.schemas.notes.note import NoteCreate, NoteUpdate
from app.schemas.resources.resource import ResourceCreate, ResourceUpdate
from app.schemas.webhooks.webhook import WebhookCreate, WebhookUpdate
from app.schemas.workspace import WorkspaceCreate, WorkspaceUpdate


# (model, schema, model_attr, schema_field). Only client-settable fields:
# server-set columns (health_*, key_hash, state, provider) are excluded because
# no request body can overrun them.
BOUNDED_FIELDS = [
    (Workspace, WorkspaceCreate, "name", "name"),
    (Workspace, WorkspaceCreate, "slug", "slug"),
    (Workspace, WorkspaceUpdate, "name", "name"),
    (Board, BoardCreate, "name", "name"),
    (Board, BoardCreate, "slug", "slug"),
    (Board, BoardUpdate, "name", "name"),
    (Board, BoardUpdate, "slug", "slug"),
    (Column, ColumnCreate, "name", "name"),
    (Column, ColumnCreate, "color", "color"),
    (Column, ColumnUpdate, "name", "name"),
    (Column, ColumnUpdate, "color", "color"),
    (Note, NoteCreate, "title", "title"),
    (Note, NoteUpdate, "title", "title"),
    (GitRepo, GitRepoCreate, "name", "name"),
    (GitRepo, GitRepoCreate, "slug", "slug"),
    (GitRepo, GitRepoCreate, "url", "url"),
    (GitRepo, GitRepoCreate, "default_branch", "default_branch"),
    (GitRepo, GitRepoCreate, "integration_branch", "integration_branch"),
    (GitRepo, GitRepoUpdate, "name", "name"),
    (GitRepo, GitRepoUpdate, "slug", "slug"),
    (GitRepo, GitRepoUpdate, "url", "url"),
    (GitRepo, GitRepoUpdate, "default_branch", "default_branch"),
    (GitRepo, GitRepoUpdate, "integration_branch", "integration_branch"),
    (Channel, ChannelCreate, "name", "name"),
    (Channel, ChannelCreate, "contact_value", "contact_value"),
    (Channel, ChannelUpdate, "name", "name"),
    (Channel, ChannelUpdate, "contact_value", "contact_value"),
    (Webhook, WebhookCreate, "url", "url"),
    (Webhook, WebhookCreate, "secret", "secret"),
    (Webhook, WebhookUpdate, "url", "url"),
    (Webhook, WebhookUpdate, "secret", "secret"),
    (AgentPromptConfig, PromptConfigCreate, "name", "name"),
    (AgentPromptConfig, PromptConfigCreate, "slug", "slug"),
    (AgentPromptConfig, PromptConfigCreate, "stage", "stage"),
    (AgentPromptConfig, PromptConfigUpdate, "name", "name"),
    (AgentPromptConfig, PromptConfigUpdate, "slug", "slug"),
    (AgentPromptConfig, PromptConfigUpdate, "stage", "stage"),
    (Agent, AgentCreate, "name", "name"),
    (Agent, AgentUpdate, "name", "name"),
    (AgentTeam, TeamCreate, "name", "name"),
    (AgentTeam, TeamCreate, "slug", "slug"),
    (AgentTeam, TeamUpdate, "name", "name"),
    (AgentTeam, TeamUpdate, "slug", "slug"),
    (AlertThreshold, AlertThresholdCreate, "name", "name"),
    (AlertThreshold, AlertThresholdUpdate, "name", "name"),
    (Resource, ResourceCreate, "name", "name"),
    (Resource, ResourceCreate, "mime_type", "mime_type"),
    (Resource, ResourceCreate, "gcs_path", "gcs_path"),
    (Resource, ResourceUpdate, "name", "name"),
]


def _column_width(model: type, attr: str) -> int:
    column = model.__table__.columns[attr]
    assert isinstance(
        column.type, String
    ), f"{model.__name__}.{attr} is {column.type!r}, not a bounded String"
    assert (
        column.type.length is not None
    ), f"{model.__name__}.{attr} is an unbounded String — nothing to mirror"
    return column.type.length


def _schema_max_length(schema: type[BaseModel], field: str) -> int | None:
    """The declared max_length, wherever Pydantic parked it.

    On a required `Str255` the constraint lands in `FieldInfo.metadata`; on an
    optional `Str255 | None` it stays inside the union arm's annotation, so the
    field's own metadata is empty. Checking only the first would silently pass
    every optional field regardless of whether it is bounded.
    """
    return _find_max_length(schema.model_fields[field])


def _find_max_length(node) -> int | None:
    """Walk a FieldInfo / annotation tree for a MaxLen constraint.

    Recursion is required, not defensive: an optional `Str255 | None` nests a
    whole FieldInfo (carrying the MaxLen in ITS metadata) inside the Annotated
    union arm, two levels below the outer field's own empty metadata.
    """
    if (limit := getattr(node, "max_length", None)) is not None:
        return limit
    for meta in getattr(node, "metadata", ()):
        if (limit := _find_max_length(meta)) is not None:
            return limit
    annotation = getattr(node, "annotation", None)
    for child in get_args(annotation) + get_args(node):
        if child is type(None):
            continue
        if (limit := _find_max_length(child)) is not None:
            return limit
    return None


# Placeholder values for a schema's OTHER required fields. Without them
# `model_validate` short-circuits on a `missing` error and never reaches the
# length check, which would make the rejection test vacuous.
REQUIRED_FILLERS = {
    "slug": "ok",
    "url": "https://example.com/r.git",
    "secret": "s3cret",
    "events": ["card.created"],
    "provider": "github",
    "channel_type": "email",
    "contact_value": "ops@example.com",
    "stage": "implement",
    "content": "body",
    "agent_type": "coding",
    "allowed_workspaces": ["ws"],
    "metric": "health_score",
    "operator": "gt",
    "value": 1.0,
    "name": "ok",
    "title": "ok",
    "column_id": "00000000-0000-0000-0000-000000000001",
}


def _over_length(field: str, width: int) -> str:
    """A too-long value that is otherwise WELL-FORMED for its field.

    `url` and `slug` carry format validators that run alongside the length
    check. A bare "xxx…" would trip those instead, and the test would pass on
    the wrong error — green whether or not the field is bounded at all.
    """
    if field == "url":
        prefix = "https://example.com/"
        return prefix + "r" * (width + 1 - len(prefix))
    if field == "slug":
        return "s" * (width + 1)
    return "x" * (width + 1)


def _payload(schema: type[BaseModel], field: str, value: str) -> dict:
    body = {
        other: REQUIRED_FILLERS[other]
        for other, info in schema.model_fields.items()
        if info.is_required() and other != field and other in REQUIRED_FILLERS
    }
    body[field] = value
    return body


def _case_id(case) -> str:
    model, schema, model_attr, schema_field = case
    return f"{schema.__name__}.{schema_field}->{model.__name__}.{model_attr}"


@pytest.mark.parametrize("case", BOUNDED_FIELDS, ids=_case_id)
def test_schema_max_length_mirrors_column_width(case):
    model, schema, model_attr, schema_field = case

    assert (
        schema_field in schema.model_fields
    ), f"{schema.__name__} has no field {schema_field!r}"
    assert _schema_max_length(schema, schema_field) == _column_width(model, model_attr)


@pytest.mark.parametrize("case", BOUNDED_FIELDS, ids=_case_id)
def test_over_length_value_is_rejected_by_pydantic(case):
    """One char past the column width must raise `string_too_long` at the
    Pydantic layer. Constructing the schema directly (rather than POSTing) is
    deliberate: SQLite would accept the over-length row, so a request-level test
    would pass on the unfixed code and prove nothing."""
    model, schema, model_attr, schema_field = case
    width = _column_width(model, model_attr)

    with pytest.raises(ValidationError) as excinfo:
        schema.model_validate(
            _payload(schema, schema_field, _over_length(schema_field, width))
        )

    errors = [e for e in excinfo.value.errors() if e["loc"][-1] == schema_field]
    assert errors, f"no error for {schema_field}: {excinfo.value.errors()}"
    assert errors[0]["type"] == "string_too_long"
    assert errors[0]["ctx"]["max_length"] == width
