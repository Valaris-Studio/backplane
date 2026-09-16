# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Unit tests for canonicalize_loop_config's merge base (card 622a4645).

RED phase: canonicalize_loop_config currently overlays the request onto
LOOP_CONFIG_DEFAULTS unconditionally — a partial PUT silently resets every
omitted field to its default instead of preserving the stored value. These
tests pin the locked design: overlay onto `stored` when given, onto
LOOP_CONFIG_DEFAULTS otherwise. Router/service-level behavior is covered in
tests/routers/kanban/test_board_loop_partial_put.py.
"""

import pytest

from app.services.loop_config_validation import (
    LOOP_CONFIG_DEFAULTS,
    LOOP_RUNNER_VARS,
    canonicalize_loop_config,
    unknown_runner_vars,
    validate_loop_config,
)


def test_canonicalize_no_stored_base_applies_defaults():
    canonical = canonicalize_loop_config({"loop_prompt": "x"})

    assert canonical["loop_prompt"] == "x"
    assert canonical["max_iterations"] == LOOP_CONFIG_DEFAULTS["max_iterations"]
    assert canonical["budget_usd"] == LOOP_CONFIG_DEFAULTS["budget_usd"]


def test_canonicalize_with_stored_base_preserves_omitted_fields():
    stored = {
        **LOOP_CONFIG_DEFAULTS,
        "tools": [],
        "max_iterations": 2,
        "budget_usd": 0.5,
        "loop_prompt": "x",
        "enabled": True,
        "version": 3,
        "disabled_reason": None,
        "updated_at": "2026-01-01T00:00:00+00:00",
    }

    canonical = canonicalize_loop_config({"enabled": False}, stored=stored)

    assert canonical["enabled"] is False
    assert canonical["max_iterations"] == 2, (
        "omitted operator field must inherit the STORED value, not the default"
    )
    assert canonical["budget_usd"] == 0.5
    assert canonical["loop_prompt"] == "x"


def test_canonicalize_explicit_null_and_omission_both_mean_unchanged():
    """LoopConfigPut fields are Optional — an explicit JSON null and an
    omitted key both decode to None and MUST be treated identically."""
    stored = {**LOOP_CONFIG_DEFAULTS, "max_iterations": 2, "loop_prompt": "x"}

    omitted = canonicalize_loop_config({"enabled": False}, stored=stored)
    explicit_null = canonicalize_loop_config(
        {"enabled": False, "max_iterations": None}, stored=stored
    )

    assert omitted["max_iterations"] == explicit_null["max_iterations"] == 2


def test_canonicalize_backfills_fields_missing_from_stored():
    """A stored config written before a new field existed (e.g.
    `starvation_policy`, added 2026-08-07) must gain the field's default on the
    next canonicalize — the runner json.Unmarshals the served object and a
    missing string would decode as ""."""
    stored = {**LOOP_CONFIG_DEFAULTS, "loop_prompt": "x", "version": 2}
    stored.pop("starvation_policy")

    canonical = canonicalize_loop_config({"enabled": False}, stored=stored)

    assert canonical["starvation_policy"] == "park"


def test_canonicalize_stored_base_still_applies_provided_overrides():
    stored = {**LOOP_CONFIG_DEFAULTS, "max_iterations": 2, "loop_prompt": "x"}

    canonical = canonicalize_loop_config({"max_iterations": 99}, stored=stored)

    assert canonical["max_iterations"] == 99
    assert canonical["loop_prompt"] == "x"  # still preserved


def test_canonicalize_empty_input_includes_merge_gate_default():
    canonical = canonicalize_loop_config({})

    assert canonical["merge_gate"] == "forge_ci"


def test_canonicalize_backfills_merge_gate_missing_from_stored():
    """A loop_config row written before merge_gate existed must gain the
    default on the next canonicalize — same backfill contract as
    starvation_policy above."""
    stored = {**LOOP_CONFIG_DEFAULTS, "loop_prompt": "x", "version": 2}
    stored.pop("merge_gate", None)

    canonical = canonicalize_loop_config({"enabled": False}, stored=stored)

    assert canonical["merge_gate"] == "forge_ci"


def test_validate_merge_gate_invalid_value_yields_finding():
    canonical = canonicalize_loop_config({"loop_prompt": "x", "merge_gate": "banana"})
    assert canonical["merge_gate"] == "banana"

    findings = validate_loop_config(canonical)

    merge_gate_findings = [f for f in findings if f["code"] == "invalid_merge_gate"]
    assert len(merge_gate_findings) == 1
    assert merge_gate_findings[0]["field"] == "merge_gate"


@pytest.mark.parametrize("gate", ["forge_ci", "none"])
def test_validate_merge_gate_allowed_values_clean(gate):
    canonical = canonicalize_loop_config({"loop_prompt": "x", "merge_gate": gate})
    assert canonical["merge_gate"] == gate

    assert validate_loop_config(canonical) == []


def test_validate_merge_gate_missing_key_uses_default_not_keyerror():
    """set_loop_state validates {**stored, enabled} WITHOUT canonicalizing —
    a pre-merge_gate stored row has no key to index, so validation must .get
    with the default (the loop_landing pattern), never config["merge_gate"]."""
    stored = {**LOOP_CONFIG_DEFAULTS, "loop_prompt": "x"}
    stored.pop("merge_gate", None)

    findings = validate_loop_config(stored)

    assert [f for f in findings if f.get("field") == "merge_gate"] == []


def test_canonicalize_stored_base_copies_tools_list_not_aliased():
    stored = {**LOOP_CONFIG_DEFAULTS, "tools": ["mcp__valaris__get_card"]}

    canonical = canonicalize_loop_config({}, stored=stored)
    canonical["tools"].append("mutated")

    assert stored["tools"] == ["mcp__valaris__get_card"], (
        "canonical configs must never share mutable list state with the "
        "stored config"
    )


def test_validate_tolerates_a_stored_row_missing_a_newer_numeric_field():
    """set_loop_state validates {**stored, enabled} WITHOUT canonicalizing, so
    a row written before a numeric field existed reaches validate with no such
    key. Indexing it there is a 500 on every loop enable/disable for that board
    (regression: max_blocked_on_human, card 102dc48e)."""
    stored = canonicalize_loop_config({"loop_prompt": "x"})
    stored.pop("max_blocked_on_human")

    findings = validate_loop_config({**stored, "enabled": True})

    assert findings == []


# --- runner var vocabulary (card cc298355) ----------------------------------


def test_unknown_runner_vars_flags_names_the_runner_does_not_fill():
    """A {{.Board}} typo renders as a Go template error at loop time, which the
    runner counts as a failed iteration — so it must be catchable at save time."""
    assert unknown_runner_vars("iteration {{.Iteration}} on {{.Board}}") == ["Board"]


def test_unknown_runner_vars_accepts_every_var_the_runner_fills():
    """All five, together: a helper that returned the KNOWN names instead of the
    unknown ones would pass a single-typo test but fail here."""
    text = " ".join(f"{{{{.{name}}}}}" for name in LOOP_RUNNER_VARS)

    assert unknown_runner_vars(text) == []


def test_unknown_runner_vars_reads_the_trim_and_whitespace_forms():
    """`{{- .X}}` and `{{ .X }}` are both legal Go template syntax. A pattern
    matching only the bare form would wave a typo written either way straight
    through to a burned iteration."""
    assert unknown_runner_vars("{{- .Bogus}}") == ["Bogus"]
    assert unknown_runner_vars("{{  .Alsobad  }}") == ["Alsobad"]
    assert unknown_runner_vars("{{- .BoardID}} {{ .Workspace }}") == []


def test_unknown_runner_vars_deduplicates_and_sorts():
    assert unknown_runner_vars("{{.Zed}} {{.Ack}} {{.Zed}}") == ["Ack", "Zed"]


# --- the `template` key is NOT a canonical config field (card 8669d136) ------


def test_canonicalize_never_stores_a_template_key():
    """`template` is binding state, not a loop_config field.

    The binding lives in its own table and is projected onto reads as a slim
    ref; letting the raw bind REQUEST (with its slot_values) settle into
    loop_config would ship authoring state to the runner, which json.Unmarshals
    this object and has no field for it.
    """
    canonical = canonicalize_loop_config(
        {"loop_prompt": "x", "template": {"source": "system", "ref": "coding-loop"}}
    )

    assert "template" not in canonical


def test_canonicalize_ignores_the_template_detach_lever():
    """`template: {}` detaches at the SERVICE layer (it deletes the binding
    row). Unlike `completion_query: {}` it is not a stored-field clear, so
    canonicalize must not mistake it for one and write an empty dict."""
    canonical = canonicalize_loop_config(
        {"template": {}}, stored={**LOOP_CONFIG_DEFAULTS, "loop_prompt": "kept"}
    )

    assert "template" not in canonical
    assert canonical["loop_prompt"] == "kept"


# --- loop_landing: three modes (card B9) -------------------------------------


@pytest.mark.parametrize("landing", ["human", "merge_queue", "self_merge"])
def test_validate_loop_landing_allowed_values_clean(landing):
    """`self_merge` — the agent lands its own PR and moves its own card — is
    the mode Loops #6–#8 actually ran, and had no name in the enum until B9."""
    canonical = canonicalize_loop_config({"loop_prompt": "x", "loop_landing": landing})
    assert canonical["loop_landing"] == landing

    assert validate_loop_config(canonical) == []


def test_validate_loop_landing_invalid_value_names_all_three_modes():
    canonical = canonicalize_loop_config(
        {"loop_prompt": "x", "loop_landing": "banana"}
    )

    findings = [
        f for f in validate_loop_config(canonical) if f["code"] == "invalid_loop_landing"
    ]

    assert len(findings) == 1
    assert findings[0]["field"] == "loop_landing"
    message = findings[0]["message"]
    for mode in ("human", "merge_queue", "self_merge"):
        assert mode in message, message
