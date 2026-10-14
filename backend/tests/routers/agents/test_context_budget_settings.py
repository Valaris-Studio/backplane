# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Validate the actual environment-owned instance setting, not a shadow parser."""

import json

import pytest
from pydantic import ValidationError
from pydantic_settings import SettingsError

from app.config import Settings
from tests.routers.agents.context_budgets_support import DEFAULT_POLICY


DEFAULT_CEILINGS = {
    **DEFAULT_POLICY,
    "max_sources": 32,
    "max_diagnostic_entries": 64,
    "max_diagnostic_bytes": 65536,
    "max_json_depth": 128,
    "max_json_nodes": 100000,
}
NUMERIC_FIELDS = [name for name in DEFAULT_CEILINGS if name != "version"]


def instance_settings(monkeypatch, value=None, *, raw=None):
    monkeypatch.delenv("CONTEXT_BUDGET_CEILINGS", raising=False)
    if value is not None or raw is not None:
        monkeypatch.setenv("CONTEXT_BUDGET_CEILINGS", raw if raw is not None else json.dumps(value))
    return Settings(_env_file=None)


def ceiling_values(settings):
    value = settings.model_dump(mode="json").get("CONTEXT_BUDGET_CEILINGS")
    assert isinstance(value, dict), "Settings must expose the validated typed ceiling object"
    return value


def test_instance_ceilings_have_explicit_documented_defaults(monkeypatch):
    assert ceiling_values(instance_settings(monkeypatch)) == DEFAULT_CEILINGS


def test_empty_instance_object_inherits_version_and_all_defaults(monkeypatch):
    assert ceiling_values(instance_settings(monkeypatch, {})) == DEFAULT_CEILINGS


def test_partial_instance_override_preserves_other_default_ceilings(monkeypatch):
    configured = {"version": 1, "max_sources": 64}
    assert ceiling_values(instance_settings(monkeypatch, configured)) == {**DEFAULT_CEILINGS, **configured}


def test_instance_operator_can_explicitly_raise_supported_byte_maxima(monkeypatch):
    configured = {key: value * 2 for key, value in DEFAULT_POLICY.items() if key != "version"}
    configured["version"] = 1
    assert ceiling_values(instance_settings(monkeypatch, configured)) == {**DEFAULT_CEILINGS, **configured}


def test_instance_operator_can_raise_structural_and_diagnostic_ceilings(monkeypatch):
    configured = {key: DEFAULT_CEILINGS[key] * 2 for key in (
        "max_sources", "max_json_depth", "max_json_nodes", "max_diagnostic_entries", "max_diagnostic_bytes",
    )}
    assert ceiling_values(instance_settings(monkeypatch, configured)) == {**DEFAULT_CEILINGS, **configured}


@pytest.mark.parametrize("configured", [
    {"max_sources": 1, "max_json_depth": 1, "max_json_nodes": 1,
     "max_diagnostic_entries": 1, "max_diagnostic_bytes": 512},
    {key: 1 for key in DEFAULT_POLICY if key != "version"},
])
def test_instance_operator_can_lower_internally_consistent_ceilings(monkeypatch, configured):
    assert ceiling_values(instance_settings(monkeypatch, configured)) == {**DEFAULT_CEILINGS, **configured}


@pytest.mark.parametrize("value", [1, 511])
def test_diagnostic_bytes_reserve_the_minimum_complete_envelope(monkeypatch, value):
    with pytest.raises((ValidationError, SettingsError)):
        instance_settings(monkeypatch, {"max_diagnostic_bytes": value})


@pytest.mark.parametrize("field", NUMERIC_FIELDS)
@pytest.mark.parametrize("value", [True, False, 0, -1, "32", 32.0, None])
def test_instance_numeric_ceilings_are_strict_positive_integers(monkeypatch, field, value):
    with pytest.raises((ValidationError, SettingsError)):
        instance_settings(monkeypatch, {"version": 1, field: value})


@pytest.mark.parametrize("version", [True, False, 0, 2, "1", 1.0, None])
def test_instance_ceiling_version_is_strict_integer_one(monkeypatch, version):
    with pytest.raises((ValidationError, SettingsError)):
        instance_settings(monkeypatch, {"version": version})


@pytest.mark.parametrize("value", [
    {"version": 1, "max_souces": 32},
    {"version": 1, "unexpected": {"unbounded": True}},
    {"version": 1, "max_note_body_bytes": DEFAULT_CEILINGS["max_note_fetch_bytes"] + 1},
    {"version": 1, "max_optional_note_bytes": DEFAULT_CEILINGS["max_managed_context_bytes"] + 1},
    {"version": 1, "max_managed_context_bytes": DEFAULT_CEILINGS["max_invocation_bytes"] + 1},
])
def test_instance_ceiling_typos_and_inconsistent_relations_are_rejected(monkeypatch, value):
    with pytest.raises((ValidationError, SettingsError)):
        instance_settings(monkeypatch, value)


@pytest.mark.parametrize("raw", ["{", "[]", "null", '"unlimited"'])
def test_instance_ceiling_environment_requires_a_json_object(monkeypatch, raw):
    with pytest.raises((ValidationError, SettingsError)):
        instance_settings(monkeypatch, raw=raw)
