# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Skill toolset fields on the wire schemas and in the committed OpenAPI spec
(MCP #3, card 3c690fb6).

RED phase. The design adds `toolsets` to six read schemas, `uncovered_toolsets`
to the two board-facing ones and `lint_warnings` to SkillRead. The live
schema (app.openapi()) and the committed docs/api/openapi.json must both say
so — the committed copy is what test_live_documentation_contract pins, so a
green here means `python scripts/export-openapi.py` was re-run.

Shape choice: only the schemas of routes that declare a response_model reach
the OpenAPI components today (SkillRead, SkillVersionDetailRead); the other
four return plain dicts. So every schema is pinned at the Pydantic level, and
the OpenAPI/committed-file pins apply to whichever of the six the spec
exposes — if a route later gains a response_model, the pin follows it.
"""

import json
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
COMMITTED_SPEC = REPO_ROOT / "docs" / "api" / "openapi.json"

EXPECTED_FIELDS = {
    "SkillRead": {"toolsets", "lint_warnings"},
    "SkillListItem": {"toolsets"},
    "SkillVersionDetailRead": {"toolsets"},
    "EffectiveSkillRead": {"toolsets", "uncovered_toolsets"},
    "BoardSkillBindingRow": {"toolsets", "uncovered_toolsets"},
    "SkillCatalogEntryRead": {"toolsets"},
}

STRING_LIST = {"type": "array", "items": {"type": "string"}}


def _schema_class(name: str):
    from app.schemas.skills import skill as skill_schemas

    return getattr(skill_schemas, name)


@pytest.mark.parametrize("schema_name,fields", sorted(EXPECTED_FIELDS.items()))
def test_skill_schema_declares_toolset_fields(schema_name: str, fields: set[str]):
    model_fields = _schema_class(schema_name).model_fields
    missing = fields - set(model_fields)
    assert not missing, f"{schema_name} missing {sorted(missing)}"
    for field in fields:
        assert model_fields[field].annotation == list[str], (schema_name, field)


def _components_declaring(spec: dict) -> dict[str, dict]:
    schemas = spec["components"]["schemas"]
    return {name: schemas[name] for name in EXPECTED_FIELDS if name in schemas}


def _assert_fields_in_spec(spec: dict, origin: str) -> None:
    exposed = _components_declaring(spec)
    # At least the response_model-backed schemas are in the spec today; a
    # spec that exposes none of the six is the wrong spec.
    assert {"SkillRead", "SkillVersionDetailRead"} <= set(exposed), (
        origin,
        sorted(exposed),
    )
    for name, component in exposed.items():
        properties = component["properties"]
        for field in EXPECTED_FIELDS[name]:
            assert field in properties, f"{origin}: {name}.{field} missing"
            assert properties[field]["type"] == "array", (origin, name, field)
            assert properties[field]["items"] == {"type": "string"}, (origin, name, field)
            # Always present on the wire — a client never has to null-check.
            assert field in component.get("required", []), (origin, name, field)


def test_live_openapi_declares_skill_toolset_fields():
    from app.main import app

    _assert_fields_in_spec(app.openapi(), "app.openapi()")


def test_committed_openapi_declares_skill_toolset_fields():
    spec = json.loads(COMMITTED_SPEC.read_text())
    _assert_fields_in_spec(spec, "docs/api/openapi.json")


def test_committed_openapi_skill_components_match_live():
    """Narrow parity pin (the full-spec pin lives in
    test_live_documentation_contract): the six skill schemas the spec exposes
    must be byte-equal between the committed file and the live app."""
    from app.main import app

    live = _components_declaring(app.openapi())
    committed = _components_declaring(json.loads(COMMITTED_SPEC.read_text()))
    assert committed == live
