# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from datetime import datetime, timezone

import pytest

from app.services.export.envelope import build_envelope


def test_build_envelope_pipeline_shape():
    envelope = build_envelope(
        entity_type="pipeline",
        source_workspace_slug="acme",
        data={"pipeline_config": {"roles": []}, "version": 3, "empty": False},
    )

    assert envelope["schema_version"] == 1
    assert envelope["entity_type"] == "pipeline"
    assert envelope["source_workspace_slug"] == "acme"
    assert envelope["source_board_slug"] is None
    assert envelope["data"] == {
        "pipeline_config": {"roles": []},
        "version": 3,
        "empty": False,
    }
    parsed = datetime.fromisoformat(envelope["exported_at"].replace("Z", "+00:00"))
    assert parsed.tzinfo is not None
    assert parsed.utcoffset() == timezone.utc.utcoffset(parsed)


def test_build_envelope_includes_board_slug_when_provided():
    envelope = build_envelope(
        entity_type="definition",
        source_workspace_slug="acme",
        data={"scope": "team", "content": {}},
        source_board_slug="quarterly-goals",
    )

    assert envelope["entity_type"] == "definition"
    assert envelope["source_board_slug"] == "quarterly-goals"


@pytest.mark.parametrize(
    "entity_type",
    ["pipeline", "team", "definition", "prompt_config", "notes_bundle"],
)
def test_build_envelope_accepts_all_entity_types(entity_type):
    envelope = build_envelope(
        entity_type=entity_type,
        source_workspace_slug="acme",
        data={},
    )

    assert envelope["entity_type"] == entity_type


def test_build_envelope_rejects_unknown_entity_type():
    with pytest.raises(ValueError):
        build_envelope(
            entity_type="something_else",
            source_workspace_slug="acme",
            data={},
        )


def test_build_envelope_exported_at_is_recent_utc():
    before = datetime.now(timezone.utc)
    envelope = build_envelope(
        entity_type="team",
        source_workspace_slug="acme",
        data={},
    )
    after = datetime.now(timezone.utc)

    parsed = datetime.fromisoformat(envelope["exported_at"].replace("Z", "+00:00"))
    assert before <= parsed <= after
