# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Raw-prompt guards and size caps on validate_loop_config (card de3bbd77).

RED phase: validate_loop_config checks enums, the completion_query and numeric
bounds, but nothing about prompt CONTENT, the tools allowlist, or sizes. Three
findings close that:

  - unrendered_slot   — a literal `<<SLOT>>` reached a live loop prompt. Once
                        slotted templates exist (P1) an unrendered slot means
                        the render was skipped, and the runner would ship the
                        placeholder to the agent verbatim.
  - off_switch_removed — an enabled loop whose tools allowlist drops
                        set_board_loop cannot stop itself. No override flag
                        exists by design (owner decision F22).
  - prompt_too_large  — a prompt past PROMPT_MAX_BYTES.

Card 22386875 adds a fourth to the same validator:

  - unknown_runner_var — a `{{.Name}}` loop mode never fills. Half of these
                        render EMPTY rather than erroring (pipeline-only
                        PromptContext fields), so save time is the only place
                        the mistake is visible at all.

Router-level error-shape coverage lives in
tests/routers/kanban/test_board_loop.py.
"""

import pytest

from app.services.loop_config_validation import (
    LOOP_CONFIG_DEFAULTS,
    LOOP_RUNNER_VARS,
    OFF_SWITCH_TOOL,
    PROMPT_MAX_BYTES,
    SLOT_PATTERN,
    canonicalize_loop_config,
    unrendered_slots,
    validate_loop_config,
)


def _findings(config: dict, code: str) -> list[dict]:
    return [f for f in validate_loop_config(config) if f["code"] == code]


# --- the slot grammar itself -------------------------------------------------


@pytest.mark.parametrize(
    "text,expected",
    [
        ("<<RUN_LABEL>>", ["RUN_LABEL"]),
        ("<<A>>", ["A"]),
        ("<<BOARD_ID_2>>", ["BOARD_ID_2"]),
        ("prefix <<ONE>> middle <<TWO>> suffix", ["ONE", "TWO"]),
    ],
)
def test_unrendered_slots_finds_slot_grammar(text, expected):
    assert unrendered_slots(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        # Shell heredocs and redirects are the reason the grammar is
        # uppercase-only + bracketed: prompts legitimately contain both.
        "cat <<EOF\nhello\nEOF",
        "run 2>>log",
        "<<lowercase>>",
        "<<Mixed_Case>>",
        "<<9LEADING_DIGIT>>",
        "<< SPACED >>",
        "<<>>",
        "a << b",
        "{{.Iteration}}",
    ],
    ids=[
        "heredoc",
        "stderr_append",
        "lowercase",
        "mixed_case",
        "leading_digit",
        "spaced",
        "empty",
        "bare_shift",
        "runner_var",
    ],
)
def test_unrendered_slots_ignores_non_slot_text(text):
    assert unrendered_slots(text) == []


def test_unrendered_slots_reports_first_occurrence_order_deduplicated():
    """The message names the FIRST slot, so order must be source order (not
    sorted) and repeats must not inflate the list."""
    assert unrendered_slots("<<ZED>> then <<ACK>> then <<ZED>>") == ["ZED", "ACK"]


def test_slot_pattern_is_the_shared_grammar_constant():
    """The renderer card reuses this exact constant — pin the grammar here so a
    loosening shows up as a failure in the guard's own suite."""
    assert SLOT_PATTERN.pattern == r"<<[A-Z][A-Z0-9_]*>>"


# --- unrendered_slot ---------------------------------------------------------


@pytest.mark.parametrize("field", ["system_prompt", "loop_prompt"])
def test_validate_flags_unrendered_slot_per_prompt_field(field):
    canonical = canonicalize_loop_config(
        {"loop_prompt": "x", field: "Iteration {{.Iteration}} <<RUN_LABEL>>"}
    )

    findings = _findings(canonical, "unrendered_slot")

    assert len(findings) == 1
    assert findings[0]["field"] == field
    assert "RUN_LABEL" in findings[0]["message"]


def test_validate_unrendered_slot_message_names_the_first_slot():
    canonical = canonicalize_loop_config({"loop_prompt": "<<ALPHA>> and <<BETA>>"})

    message = _findings(canonical, "unrendered_slot")[0]["message"]

    assert "ALPHA" in message


def test_validate_unrendered_slot_reports_both_prompt_fields_independently():
    canonical = canonicalize_loop_config(
        {"loop_prompt": "<<IN_LOOP>>", "system_prompt": "<<IN_SYSTEM>>"}
    )

    findings = _findings(canonical, "unrendered_slot")

    assert {f["field"] for f in findings} == {"loop_prompt", "system_prompt"}


def test_validate_unrendered_slot_fires_on_a_disabled_config_too():
    """The guard is about what gets STORED: a disabled board's prompt is the
    same string the next enable would ship. Storing a placeholder and enabling
    later must not be a way around the guard."""
    canonical = canonicalize_loop_config(
        {"loop_prompt": "<<RUN_LABEL>>", "enabled": False}
    )

    assert len(_findings(canonical, "unrendered_slot")) == 1


def test_validate_clean_prompts_yield_no_slot_finding():
    canonical = canonicalize_loop_config(
        {
            "loop_prompt": "cat <<EOF\nIteration {{.Iteration}}\nEOF",
            "system_prompt": "2>>log",
        }
    )

    assert _findings(canonical, "unrendered_slot") == []


# --- off_switch_removed ------------------------------------------------------


def test_validate_flags_enabled_loop_whose_tools_drop_the_off_switch():
    canonical = canonicalize_loop_config(
        {
            "loop_prompt": "x",
            "enabled": True,
            "tools": ["mcp__valaris__get_card", "mcp__valaris__update_card"],
        }
    )

    findings = _findings(canonical, "off_switch_removed")

    assert len(findings) == 1
    assert findings[0]["field"] == "tools"
    assert OFF_SWITCH_TOOL in findings[0]["message"]


def test_validate_empty_tools_means_full_surface_and_is_clean():
    """An empty allowlist grants the whole platform surface — the off-switch
    included. Flagging it would reject the DEFAULT config."""
    canonical = canonicalize_loop_config(
        {"loop_prompt": "x", "enabled": True, "tools": []}
    )

    assert _findings(canonical, "off_switch_removed") == []


def test_validate_tools_containing_the_off_switch_are_clean():
    canonical = canonicalize_loop_config(
        {
            "loop_prompt": "x",
            "enabled": True,
            "tools": ["mcp__valaris__get_card", OFF_SWITCH_TOOL],
        }
    )

    assert _findings(canonical, "off_switch_removed") == []


def test_validate_disabled_loop_may_omit_the_off_switch():
    """A disabled loop cannot run, so it cannot fail to stop. The operator is
    free to stage an allowlist before enabling — PATCH /state then rejects it."""
    canonical = canonicalize_loop_config(
        {"loop_prompt": "x", "enabled": False, "tools": ["mcp__valaris__get_card"]}
    )

    assert _findings(canonical, "off_switch_removed") == []


def test_validate_off_switch_missing_tools_key_uses_default_not_keyerror():
    """set_loop_state validates {**stored, enabled} WITHOUT canonicalizing, so
    a stored row predating any field must not KeyError (the merge_gate pattern)."""
    stored = {**LOOP_CONFIG_DEFAULTS, "loop_prompt": "x", "enabled": True}
    stored.pop("tools", None)

    findings = validate_loop_config(stored)

    assert [f for f in findings if f["field"] == "tools"] == []


# --- prompt_too_large --------------------------------------------------------


@pytest.mark.parametrize("field", ["system_prompt", "loop_prompt"])
def test_validate_flags_prompt_one_byte_over_the_cap(field):
    canonical = canonicalize_loop_config(
        {"loop_prompt": "x", field: "a" * (PROMPT_MAX_BYTES + 1)}
    )

    findings = _findings(canonical, "prompt_too_large")

    assert len(findings) == 1
    assert findings[0]["field"] == field


@pytest.mark.parametrize("field", ["system_prompt", "loop_prompt"])
def test_validate_prompt_exactly_at_the_cap_is_accepted(field):
    canonical = canonicalize_loop_config(
        {"loop_prompt": "x", field: "a" * PROMPT_MAX_BYTES}
    )

    assert _findings(canonical, "prompt_too_large") == []


def test_validate_prompt_size_is_measured_in_utf8_bytes_not_characters():
    """A 3-byte character must count as 3. Measuring len(str) would let a
    prompt three times the cap through — the cap exists because the runner
    ships this string over the wire every iteration."""
    over_in_bytes = "中" * (PROMPT_MAX_BYTES // 3 + 1)
    assert len(over_in_bytes) < PROMPT_MAX_BYTES
    assert len(over_in_bytes.encode("utf-8")) > PROMPT_MAX_BYTES

    canonical = canonicalize_loop_config({"loop_prompt": over_in_bytes})

    assert len(_findings(canonical, "prompt_too_large")) == 1


def test_validate_prompt_size_missing_key_uses_default_not_keyerror():
    stored = {**LOOP_CONFIG_DEFAULTS, "loop_prompt": "x"}
    stored.pop("system_prompt", None)

    findings = validate_loop_config(stored)

    assert [f for f in findings if f["field"] == "system_prompt"] == []


# --- unknown_runner_var (card 22386875) --------------------------------------
#
# The helper existed (card cc298355) with no production caller: nothing
# validated runner vars on a save path. Two distinct failure modes motivate the
# guard, and only one of them is loud at render time:
#
#   {{.CardID}} — a pipeline-only field that EXISTS on the shared Go
#                 PromptContext. Loop mode leaves it at its zero value, so Go
#                 renders it as "" with no error: the prompt silently loses a
#                 sentence and the iteration burns anyway.
#   {{.Bogus}}  — absent from the struct entirely; Go errors and the runner
#                 counts a failed iteration.
#
# Both are operator typos with no valid loop-mode meaning, so both are a 422.


@pytest.mark.parametrize("field", ["system_prompt", "loop_prompt"])
def test_validate_flags_a_pipeline_only_var_that_would_render_empty(field):
    """The silent branch: CardID is a REAL PromptContext field, so Go never
    errors on it — without this guard the mistake is invisible until an
    operator reads a prompt with a hole in it."""
    canonical = canonicalize_loop_config({"loop_prompt": "x", field: "card {{.CardID}}"})

    findings = _findings(canonical, "unknown_runner_var")

    assert len(findings) == 1
    assert findings[0]["field"] == field


@pytest.mark.parametrize("field", ["system_prompt", "loop_prompt"])
def test_validate_flags_a_var_absent_from_the_runner_struct(field):
    canonical = canonicalize_loop_config({"loop_prompt": "x", field: "{{.Bogus}}"})

    findings = _findings(canonical, "unknown_runner_var")

    assert len(findings) == 1
    assert findings[0]["field"] == field


def test_validate_unknown_runner_var_message_names_the_first_name():
    canonical = canonicalize_loop_config({"loop_prompt": "{{.Zed}} and {{.Ack}}"})

    finding = _findings(canonical, "unknown_runner_var")[0]

    # sorted(), so "Ack" leads regardless of source order — the message names
    # one name and `value` carries the full set.
    assert "Ack" in finding["message"]
    assert finding["value"] == ["Ack", "Zed"]


def test_validate_unknown_runner_var_reports_both_prompt_fields_independently():
    canonical = canonicalize_loop_config(
        {"loop_prompt": "{{.CardID}}", "system_prompt": "{{.Branch}}"}
    )

    findings = _findings(canonical, "unknown_runner_var")

    assert {f["field"] for f in findings} == {"loop_prompt", "system_prompt"}
    assert [f["value"] for f in findings if f["field"] == "loop_prompt"] == [["CardID"]]


def test_validate_unknown_runner_var_fires_on_a_disabled_config_too():
    """AC4: a disabled save is how an unsupported var would otherwise be
    STAGED — PATCH /loop/state re-validates {**stored, enabled} but cannot
    reject what the PUT already accepted. Guarding the PUT closes the route."""
    canonical = canonicalize_loop_config({"loop_prompt": "{{.CardID}}", "enabled": False})

    assert len(_findings(canonical, "unknown_runner_var")) == 1


def test_validate_accepts_every_var_the_runner_actually_fills():
    text = " ".join(f"{{{{.{name}}}}}" for name in LOOP_RUNNER_VARS)
    canonical = canonicalize_loop_config({"loop_prompt": text, "system_prompt": text})

    assert _findings(canonical, "unknown_runner_var") == []


def test_validate_accepts_the_trim_and_whitespace_var_forms():
    """`{{- .X}}` and `{{ .X }}` are legal Go template syntax; the shared
    RUNNER_VAR_PATTERN reads both, so neither a false accept nor a false
    reject may depend on spelling."""
    canonical = canonicalize_loop_config(
        {"loop_prompt": "{{- .BoardID}} {{ .Workspace }}"}
    )

    assert _findings(canonical, "unknown_runner_var") == []


@pytest.mark.parametrize(
    "prompt",
    ["{{- .CardID}}", "{{ .CardID }}", "{{-.CardID}}"],
    ids=["trim_marker", "inner_whitespace", "trim_no_space"],
)
def test_validate_flags_an_unsupported_var_written_in_any_legal_form(prompt):
    """The accept-path test above cannot see a pattern that stopped matching —
    a narrower regex still "accepts" everything. Only a typo that MUST be
    rejected proves the guard reads the trim and whitespace spellings, which
    is exactly where an operator's mistake is easiest to miss by eye."""
    canonical = canonicalize_loop_config({"loop_prompt": prompt})

    findings = _findings(canonical, "unknown_runner_var")

    assert len(findings) == 1, prompt
    assert findings[0]["value"] == ["CardID"], prompt


def test_validate_unknown_runner_var_missing_key_uses_default_not_keyerror():
    stored = {**LOOP_CONFIG_DEFAULTS, "loop_prompt": "x"}
    stored.pop("system_prompt", None)

    findings = validate_loop_config(stored)

    assert [f for f in findings if f["field"] == "system_prompt"] == []


# --- the guards do not disturb the existing contract -------------------------


def test_validate_default_config_stays_clean():
    assert validate_loop_config(canonicalize_loop_config({"loop_prompt": "x"})) == []


def test_validate_runner_var_guard_leaves_the_other_findings_intact():
    """One prompt can trip several guards at once; each keeps its own code and
    field so the UI can point at every problem in one pass."""
    canonical = canonicalize_loop_config(
        {"loop_prompt": "<<RUN_LABEL>> {{.CardID}}", "enabled": False}
    )

    codes = sorted(f["code"] for f in validate_loop_config(canonical))

    assert codes == ["unknown_runner_var", "unrendered_slot"]
