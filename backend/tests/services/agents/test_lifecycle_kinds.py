# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Unit tests for the LIFECYCLE_KINDS closed registry.

Phase 4 of the LLM-lifecycle contract redesign extends `create_note`'s
params_schema so the runner — not the LLM — owns note-writing. The schema
gains `kind` (required), `title`, `body_from` (enum), `failure_class`, and
drops the legacy `from_llm_output` flag.
"""

from __future__ import annotations

from app.services.agents.lifecycle_kinds import LIFECYCLE_KINDS


def _create_note_schema() -> dict:
    return LIFECYCLE_KINDS["create_note"]["params_schema"]


def test_create_note_schema_requires_kind():
    schema = _create_note_schema()
    assert "kind" in schema, "create_note params_schema must declare `kind`"
    assert schema["kind"].get("type") == "string"
    assert schema["kind"].get("required") is True, (
        "`kind` must be marked required so the validator rejects configs that omit it"
    )


def test_create_note_schema_includes_body_from_enum_with_4_values():
    schema = _create_note_schema()
    assert "body_from" in schema
    body_from = schema["body_from"]
    assert body_from.get("type") == "string"
    enum_values = body_from.get("enum")
    assert isinstance(enum_values, (list, tuple, frozenset, set))
    assert set(enum_values) == {"findings", "raw", "summary", "decision"}, (
        f"body_from enum must be exactly the 4 documented values, got {enum_values!r}"
    )


def test_create_note_schema_includes_title_optional():
    schema = _create_note_schema()
    assert "title" in schema
    assert schema["title"].get("type") == "string"
    # Optional: no `required` flag, or required is falsy.
    assert not schema["title"].get("required", False)


def test_create_note_schema_includes_failure_class_optional():
    schema = _create_note_schema()
    assert "failure_class" in schema
    assert schema["failure_class"].get("type") == "string"
    assert not schema["failure_class"].get("required", False)


def test_create_note_schema_drops_from_llm_output():
    schema = _create_note_schema()
    assert "from_llm_output" not in schema, (
        "from_llm_output is removed in Phase 4; the runner uses body_from instead"
    )


def test_create_note_terminal_flag_still_true():
    assert LIFECYCLE_KINDS["create_note"]["terminal"] is True


def test_create_note_produces_decision_still_false():
    assert LIFECYCLE_KINDS["create_note"]["produces_decision"] is False
