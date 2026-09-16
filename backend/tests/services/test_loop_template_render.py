# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Renderer + validator contract (spec f52328b3 §3.1, rules 1-10).

The rules are numbered in the spec and each one has at least one test here
naming it, because the contract was paid for in corrupted prompts: a cosmetic
regex once rewrote `python3 -m venv .venv`, heredocs (`cat <<EOF`) look like
slots, and repo prose contains `{{`. A change that alters rendered output must
change the golden fixtures in the SAME PR — that is what makes them golden.
"""

import json
from pathlib import Path

import pytest

from app.services.loop_config_validation import LOOP_RUNNER_VARS, OFF_SWITCH_TOOL
from app.services.loop_template_render import (
    RenderError,
    SlotSpec,
    TemplateContent,
    effective_slot_values,
    render,
    resolve_variants,
    validate_template,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "loop_templates"


def _content(**overrides) -> TemplateContent:
    """A minimal VALID template; each test overrides only what it exercises."""
    base = {
        "system_prompt": "You are <<ROLE>>.",
        "loop_prompt": "Work on <<ROLE>>.",
        "slots": [{"name": "ROLE", "kind": "scalar", "required": True}],
        "tools": [OFF_SWITCH_TOOL],
    }
    base.update(overrides)
    return TemplateContent.model_validate(base)


def _codes(errors) -> list[str]:
    return [error["code"] for error in errors]


# ---------------------------------------------------------------- rule 1: grammar


@pytest.mark.parametrize(
    "text",
    [
        "cat <<EOF\nbody\nEOF",
        "command 2>>log",
        "std::cout << x",
        "a <<lowercase>> b",
        "<<9DIGIT>> leading digit is not a slot",
        "<<HAS SPACE>>",
    ],
)
def test_rule1_non_slot_text_survives_untouched(text):
    """`<<` is ordinary text everywhere except the exact `<<[A-Z][A-Z0-9_]*>>`."""
    content = _content(system_prompt=text, loop_prompt=text, slots=[])
    result = render(content, {})
    assert result.system_prompt == text
    assert result.loop_prompt == text


def test_rule1_slot_after_shell_redirect_still_renders():
    """A real slot next to heredoc-ish text is still a slot (no greedy match)."""
    content = _content(
        system_prompt="cat <<EOF then <<ROLE>> done",
        loop_prompt="x",
        slots=[
            {"name": "ROLE", "kind": "scalar", "required": True},
        ],
    )
    result = render(content, {"ROLE": "agent"})
    assert result.system_prompt == "cat <<EOF then agent done"


# ------------------------------------------------- rule 2: single pass, no nesting


def test_rule2_value_containing_a_slot_is_left_literal():
    """Values are DATA. A `<<X>>` inside a value must not be re-expanded, or an
    operator-supplied string could reach into the template's own catalog."""
    content = _content(
        system_prompt="<<ROLE>> and <<OTHER>>",
        loop_prompt="x",
        slots=[
            {"name": "ROLE", "kind": "scalar", "required": True},
            {"name": "OTHER", "kind": "scalar", "required": False},
        ],
    )
    result = render(content, {"ROLE": "<<OTHER>>", "OTHER": "leaked"})
    assert result.system_prompt == "<<OTHER>> and leaked"


# ------------------------------------------------------------ rule 3: block indent


def test_rule3_block_value_reindents_under_its_placeholder():
    content = _content(
        system_prompt="intro\n    <<BODY>>\noutro",
        loop_prompt="x",
        slots=[{"name": "BODY", "kind": "block", "required": True}],
    )
    result = render(content, {"BODY": "line1\nline2\nline3"})
    assert result.system_prompt == "intro\n    line1\n    line2\n    line3\noutro"


def test_rule3_block_indent_uses_the_placeholder_line_not_column_zero():
    """The indent comes from the LINE the placeholder sits on, so a placeholder
    preceded by prose still re-indents to that line's leading whitespace."""
    content = _content(
        system_prompt="  - item: <<BODY>>",
        loop_prompt="x",
        slots=[{"name": "BODY", "kind": "block", "required": True}],
    )
    result = render(content, {"BODY": "first\nsecond"})
    assert result.system_prompt == "  - item: first\n  second"


def test_rule3_single_line_block_value_is_unchanged():
    content = _content(
        system_prompt="    <<BODY>>",
        loop_prompt="x",
        slots=[{"name": "BODY", "kind": "block", "required": True}],
    )
    assert render(content, {"BODY": "solo"}).system_prompt == "    solo"


# ------------------------------------------------------------ rule 4: empty values


def test_rule4_whole_line_removed_when_placeholder_is_alone_on_it():
    content = _content(
        system_prompt="before\n<<NOTE>>\nafter",
        loop_prompt="x",
        slots=[{"name": "NOTE", "kind": "scalar", "required": False}],
    )
    assert render(content, {"NOTE": ""}).system_prompt == "before\nafter"


def test_rule4_indented_lone_placeholder_removes_the_whole_line():
    """ "Only non-whitespace on its line" — leading indentation does not save it."""
    content = _content(
        system_prompt="before\n      <<NOTE>>   \nafter",
        loop_prompt="x",
        slots=[{"name": "NOTE", "kind": "scalar", "required": False}],
    )
    assert render(content, {"NOTE": ""}).system_prompt == "before\nafter"


def test_rule4_inline_empty_removes_exactly_one_preceding_space():
    content = _content(
        system_prompt="alpha <<NOTE>> omega",
        loop_prompt="x",
        slots=[{"name": "NOTE", "kind": "scalar", "required": False}],
    )
    # ONE space is eaten (the one before), leaving the one after: "alpha omega".
    assert render(content, {"NOTE": ""}).system_prompt == "alpha omega"


def test_rule4_inline_empty_at_line_start_removes_the_following_space():
    """No space before => the space AFTER is the one removed (spec: "else")."""
    content = _content(
        system_prompt="x\n<<NOTE>> tail",
        loop_prompt="x",
        slots=[{"name": "NOTE", "kind": "scalar", "required": False}],
    )
    assert render(content, {"NOTE": ""}).system_prompt == "x\ntail"


def test_rule4_parenthesised_empty_placeholder_drops_the_parentheses():
    content = _content(
        system_prompt="name (<<NOTE>>) here",
        loop_prompt="x",
        slots=[{"name": "NOTE", "kind": "scalar", "required": False}],
    )
    assert render(content, {"NOTE": ""}).system_prompt == "name here"


def test_rule4_non_empty_value_keeps_its_parentheses():
    content = _content(
        system_prompt="name (<<NOTE>>) here",
        loop_prompt="x",
        slots=[{"name": "NOTE", "kind": "scalar", "required": False}],
    )
    assert render(content, {"NOTE": "v2"}).system_prompt == "name (v2) here"


# ------------------------------------------------------- rule 5: no cosmetic cleanup


def test_rule5_double_spaces_and_venv_prose_survive_verbatim():
    """The banned regex (04 §N1) rewrote `python3 -m venv .venv`. Anything the
    renderer did not explicitly substitute must come out byte-identical."""
    prose = "Run  python3 -m venv .venv  now .\n\n\nKeep   blank lines."
    content = _content(system_prompt=prose, loop_prompt=prose, slots=[])
    assert render(content, {}).system_prompt == prose


def test_rule5_no_cleanup_around_a_substituted_value():
    content = _content(
        system_prompt="a  <<ROLE>>  b .",
        loop_prompt="x",
        slots=[{"name": "ROLE", "kind": "scalar", "required": True}],
    )
    assert render(content, {"ROLE": "R"}).system_prompt == "a  R  b ."


# ------------------------------------------------------- rule 6: Go-template escape


def test_rule6_double_brace_in_value_is_escaped_to_a_go_literal():
    content = _content(
        system_prompt="<<ROLE>>",
        loop_prompt="x",
        slots=[{"name": "ROLE", "kind": "scalar", "required": True}],
    )
    result = render(content, {"ROLE": "{{.Iteration}} and {{x}}"})
    assert result.system_prompt == '{{"{{"}}.Iteration}} and {{"{{"}}x}}'


def test_rule6_closing_braces_alone_are_not_escaped():
    """`}}` outside an action is plain text to text/template — escaping it would
    be a second bug, not a fix."""
    content = _content(
        system_prompt="<<ROLE>>",
        loop_prompt="x",
        slots=[{"name": "ROLE", "kind": "scalar", "required": True}],
    )
    assert render(content, {"ROLE": "closes }} here"}).system_prompt == "closes }} here"


def test_rule6_kernel_runner_vars_are_not_escaped():
    """The KERNEL's own `{{.Iteration}}` is the runner's contract and must reach
    the runner unescaped — only VALUES are escaped."""
    content = _content(
        system_prompt="iteration {{.Iteration}} of <<ROLE>>",
        loop_prompt="x",
        slots=[{"name": "ROLE", "kind": "scalar", "required": True}],
    )
    result = render(content, {"ROLE": "R"})
    assert result.system_prompt == "iteration {{.Iteration}} of R"


# ------------------------------------------------------------------- rule 7: kinds


def test_rule7_scalar_rejects_newline():
    content = _content()
    with pytest.raises(RenderError) as excinfo:
        render(content, {"ROLE": "two\nlines"})
    assert _codes(excinfo.value.errors) == ["scalar_must_be_single_line"]


def test_rule7_block_allows_newline():
    content = _content(
        system_prompt="<<BODY>>",
        loop_prompt="x",
        slots=[{"name": "BODY", "kind": "block", "required": True}],
    )
    assert render(content, {"BODY": "a\nb"}).system_prompt == "a\nb"


def test_rule7_enum_rejects_a_value_outside_enum_values():
    content = _content(
        system_prompt="<<MODE>>",
        loop_prompt="x",
        slots=[
            {
                "name": "MODE",
                "kind": "enum",
                "required": True,
                "enum_values": ["fast", "slow"],
            }
        ],
    )
    with pytest.raises(RenderError) as excinfo:
        render(content, {"MODE": "sideways"})
    assert _codes(excinfo.value.errors) == ["enum_value_not_allowed"]


def test_rule7_enum_accepts_a_catalogued_value():
    content = _content(
        system_prompt="<<MODE>>",
        loop_prompt="x",
        slots=[
            {
                "name": "MODE",
                "kind": "enum",
                "required": True,
                "enum_values": ["fast", "slow"],
            }
        ],
    )
    assert render(content, {"MODE": "fast"}).system_prompt == "fast"


def test_rule7_list_joins_items_with_the_declared_join():
    content = _content(
        system_prompt="items:\n<<STEPS>>",
        loop_prompt="x",
        slots=[
            {"name": "STEPS", "kind": "list", "required": True, "join": "\n- "},
        ],
    )
    result = render(content, {"STEPS": ["one", "two", "three"]})
    assert result.system_prompt == "items:\none\n- two\n- three"


def test_rule7_empty_list_is_an_empty_value_and_takes_the_line():
    content = _content(
        system_prompt="before\n<<STEPS>>\nafter",
        loop_prompt="x",
        slots=[{"name": "STEPS", "kind": "list", "required": False, "join": ", "}],
    )
    assert render(content, {"STEPS": []}).system_prompt == "before\nafter"


# --------------------------------------------------------------- rule 8: leftovers


def test_rule8_uncatalogued_slot_left_in_the_kernel_is_a_render_error():
    content = TemplateContent.model_validate(
        {
            "system_prompt": "hello <<UNKNOWN>>",
            "loop_prompt": "x",
            "slots": [],
            "tools": [OFF_SWITCH_TOOL],
        }
    )
    with pytest.raises(RenderError) as excinfo:
        render(content, {})
    assert _codes(excinfo.value.errors) == ["unrendered_slot"]
    assert "UNKNOWN" in excinfo.value.errors[0]["message"]


def test_rule8_missing_required_value_is_reported_not_silently_blanked():
    with pytest.raises(RenderError) as excinfo:
        render(_content(), {})
    assert _codes(excinfo.value.errors) == ["required_slot_missing"]


# ------------------------------------------------------------------ size caps


def test_value_over_16kb_is_rejected():
    content = _content(
        system_prompt="<<BODY>>",
        loop_prompt="x",
        slots=[{"name": "BODY", "kind": "block", "required": True}],
    )
    with pytest.raises(RenderError) as excinfo:
        render(content, {"BODY": "x" * (16 * 1024 + 1)})
    assert _codes(excinfo.value.errors) == ["slot_value_too_large"]


def test_value_at_exactly_16kb_is_accepted():
    """The cap is a bound, not an off-by-one: exactly at the limit passes."""
    content = _content(
        system_prompt="<<BODY>>",
        loop_prompt="x",
        slots=[{"name": "BODY", "kind": "block", "required": True}],
    )
    assert len(render(content, {"BODY": "x" * (16 * 1024)}).system_prompt) == 16 * 1024


def test_total_render_over_128kb_is_rejected():
    big = "y" * (16 * 1024)
    slots = [{"name": f"S{i}", "kind": "block", "required": True} for i in range(9)]
    kernel = "\n".join(f"<<S{i}>>" for i in range(9))
    content = _content(system_prompt=kernel, loop_prompt=kernel, slots=slots)
    with pytest.raises(RenderError) as excinfo:
        render(content, {f"S{i}": big for i in range(9)})
    assert "render_too_large" in _codes(excinfo.value.errors)


# ------------------------------------------------------------------- variants


def test_resolve_variants_expands_fills_into_plain_slot_values():
    content = _content(
        system_prompt="<<LANDING_POLICY>> / <<ROLE>>",
        loop_prompt="x",
        slots=[
            {"name": "ROLE", "kind": "scalar", "required": True},
            {
                "name": "LANDING",
                "kind": "variant",
                "required": True,
                "variants": [
                    {
                        "id": "self_merge",
                        "label": "Self merge",
                        "fills": {"LANDING_POLICY": "merge it yourself"},
                        "tools_extra": ["mcp__valaris__enqueue_pr_for_merge"],
                        "rails": {"loop_landing": "merge_queue"},
                    }
                ],
            },
            {"name": "LANDING_POLICY", "kind": "scalar", "required": False},
        ],
    )
    values, tools_extra, rails = resolve_variants(content, {"LANDING": "self_merge"})
    assert values["LANDING_POLICY"] == "merge it yourself"
    assert tools_extra == ["mcp__valaris__enqueue_pr_for_merge"]
    assert rails == {"loop_landing": "merge_queue"}


def test_variant_selection_does_not_override_an_explicit_slot_value():
    """An operator who typed a value meant it; the variant only FILLS blanks."""
    content = _content(
        system_prompt="<<LANDING_POLICY>> <<ROLE>>",
        loop_prompt="x",
        slots=[
            {"name": "ROLE", "kind": "scalar", "required": True},
            {
                "name": "LANDING",
                "kind": "variant",
                "required": True,
                "variants": [
                    {
                        "id": "a",
                        "label": "A",
                        "fills": {"LANDING_POLICY": "from variant"},
                    }
                ],
            },
            {"name": "LANDING_POLICY", "kind": "scalar", "required": False},
        ],
    )
    values, _, _ = resolve_variants(
        content, {"LANDING": "a", "LANDING_POLICY": "operator typed"}
    )
    assert values["LANDING_POLICY"] == "operator typed"


def test_unknown_variant_id_is_rejected():
    content = _content(
        system_prompt="<<ROLE>>",
        loop_prompt="x",
        slots=[
            {"name": "ROLE", "kind": "scalar", "required": True},
            {
                "name": "LANDING",
                "kind": "variant",
                "required": True,
                "variants": [{"id": "a", "label": "A", "fills": {}}],
            },
        ],
    )
    with pytest.raises(RenderError) as excinfo:
        render(content, {"ROLE": "R", "LANDING": "nope"})
    assert _codes(excinfo.value.errors) == ["variant_not_found"]


def test_render_merges_variant_tools_into_the_result():
    content = _content(
        system_prompt="<<ROLE>>",
        loop_prompt="x",
        slots=[
            {"name": "ROLE", "kind": "scalar", "required": True},
            {
                "name": "LANDING",
                "kind": "variant",
                "required": True,
                "variants": [
                    {
                        "id": "c",
                        "label": "C",
                        "fills": {},
                        "tools_extra": ["mcp__valaris__enqueue_pr_for_merge"],
                    }
                ],
            },
        ],
    )
    result = render(content, {"ROLE": "R", "LANDING": "c"})
    assert result.tools == [OFF_SWITCH_TOOL, "mcp__valaris__enqueue_pr_for_merge"]


def _landing_content(*, required: bool, default=None) -> TemplateContent:
    """A LANDING variant whose two options differ in fills, tools AND rails, so
    a test can tell WHICH option was selected from any one of the three."""
    return _content(
        system_prompt="<<LANDING_POLICY>> / <<ROLE>>",
        loop_prompt="x",
        slots=[
            {"name": "ROLE", "kind": "scalar", "required": True},
            {
                "name": "LANDING",
                "kind": "variant",
                "required": required,
                "default": default,
                "variants": [
                    {
                        "id": "self_merge",
                        "label": "Self merge",
                        "fills": {"LANDING_POLICY": "merge it yourself"},
                        "tools_extra": ["mcp__valaris__enqueue_pr_for_merge"],
                        "rails": {"loop_landing": "merge_queue"},
                    },
                    {
                        "id": "human_review",
                        "label": "Human review",
                        "fills": {"LANDING_POLICY": "wait for a human"},
                        "tools_extra": ["mcp__valaris__request_approval"],
                        "rails": {"loop_landing": "human"},
                    },
                ],
            },
            {"name": "LANDING_POLICY", "kind": "scalar", "required": False},
        ],
    )


def test_a_required_variant_with_no_value_and_no_default_is_rejected():
    """Without this guard the whole fills/tools/rails bundle silently vanishes:
    render succeeds and the operator never learns the choice was skipped."""
    content = _landing_content(required=True)
    with pytest.raises(RenderError) as excinfo:
        render(content, {"ROLE": "R"})
    assert _codes(excinfo.value.errors) == ["required_slot_missing"]
    assert excinfo.value.errors[0]["field"] == "slot_values.LANDING"


def test_an_omitted_variant_falls_back_to_its_default_option():
    content = _landing_content(required=True, default="human_review")
    result = render(content, {"ROLE": "R"})
    assert result.system_prompt == "wait for a human / R"
    assert result.tools == [OFF_SWITCH_TOOL, "mcp__valaris__request_approval"]
    assert result.rails["loop_landing"] == "human"


def test_an_explicit_variant_selection_beats_the_default():
    content = _landing_content(required=True, default="human_review")
    result = render(content, {"ROLE": "R", "LANDING": "self_merge"})
    assert result.system_prompt == "merge it yourself / R"
    assert result.tools == [OFF_SWITCH_TOOL, "mcp__valaris__enqueue_pr_for_merge"]
    assert result.rails["loop_landing"] == "merge_queue"


def test_a_cleared_variant_select_falls_back_to_the_default_like_an_omission():
    """A UI select that was cleared sends `""`, not a missing key. Treating that
    as a selection would look up a variant named `""` and raise
    variant_not_found instead of applying the template author's default."""
    content = _landing_content(required=True, default="human_review")
    result = render(content, {"ROLE": "R", "LANDING": ""})
    assert result.rails["loop_landing"] == "human"


def test_a_cleared_required_variant_with_no_default_reports_it_as_missing():
    content = _landing_content(required=True)
    with pytest.raises(RenderError) as excinfo:
        render(content, {"ROLE": "R", "LANDING": ""})
    assert _codes(excinfo.value.errors) == ["required_slot_missing"]


def test_an_empty_string_default_is_no_default_at_all():
    """`default: ""` is what a template editor leaves behind when the author
    clears the field, so it must read as "unset" rather than as a variant id."""
    content = _landing_content(required=True, default="")
    with pytest.raises(RenderError) as excinfo:
        render(content, {"ROLE": "R"})
    assert _codes(excinfo.value.errors) == ["required_slot_missing"]


def test_an_optional_variant_with_no_value_and_no_default_stays_unselected():
    content = _landing_content(required=False)
    result = render(content, {"ROLE": "R"})
    assert result.system_prompt == "/ R"
    assert result.tools == [OFF_SWITCH_TOOL]
    assert "loop_landing" not in result.rails


# --------------------------------------------------------------- unknown keys


def test_an_unknown_slot_value_key_is_rejected_with_its_field_path():
    """Spec §2.2: a typo'd key must 422 with a field path. Dropping it silently
    lets a binding persist a value that will never reach a prompt."""
    content = _content()
    with pytest.raises(RenderError) as excinfo:
        render(content, {"ROLE": "R", "TYPO": "ignored"})
    assert _codes(excinfo.value.errors) == ["unknown_slot"]
    assert excinfo.value.errors[0]["field"] == "slot_values.TYPO"
    assert excinfo.value.errors[0]["value"] == "TYPO"


def test_every_unknown_key_is_reported_in_one_pass_in_sorted_order():
    content = _content()
    with pytest.raises(RenderError) as excinfo:
        render(content, {"ROLE": "R", "ZEBRA": 1, "ALPHA": 2})
    assert [error["field"] for error in excinfo.value.errors] == [
        "slot_values.ALPHA",
        "slot_values.ZEBRA",
    ]


def test_a_variant_fill_target_is_not_reported_as_an_unknown_key():
    """resolve_variants() injects fill targets into the value map; comparing the
    EXPANDED map against the catalog would still be correct, but comparing the
    operator's own keys is what makes the field path point at their input."""
    content = _landing_content(required=True)
    result = render(content, {"ROLE": "R", "LANDING": "self_merge"})
    assert result.system_prompt == "merge it yourself / R"


# ------------------------------------------------------------------ derived_rails


def test_validate_flags_a_derived_rail_referencing_an_uncatalogued_slot():
    """derived_rails are substituted like prompts but are NOT prompts, so rule
    8's leftover check never sees them. Unguarded, a typo ships a literal
    `<<RUN_LABEL>>` into completion_query.label and the run never completes."""
    content = _content(
        derived_rails={"completion_query": {"label": "<<RUN_LABEL>>"}},
    )
    errors = validate_template(content)
    assert "uncatalogued_slot" in _codes(errors)
    assert any("RUN_LABEL" in error["message"] for error in errors)


def test_validate_accepts_a_slot_used_only_by_a_derived_rail():
    """Driving completion_query is a real use; such a slot is not orphaned."""
    content = _content(
        system_prompt="<<ROLE>>",
        loop_prompt="x",
        slots=[
            {"name": "ROLE", "kind": "scalar", "required": True},
            {"name": "RUN_LABEL", "kind": "scalar", "required": True},
        ],
        derived_rails={"completion_query": {"label": "<<RUN_LABEL>>"}},
    )
    codes = _codes(validate_template(content))
    assert "unused_slot" not in codes
    assert "uncatalogued_slot" not in codes


def test_derived_rails_substitute_slots_and_land_in_the_result():
    content = _content(
        system_prompt="<<RUN_LABEL>>",
        loop_prompt="x",
        slots=[{"name": "RUN_LABEL", "kind": "scalar", "required": True}],
        derived_rails={
            "completion_query": {
                "label": "<<RUN_LABEL>>",
                "exclude_column_type": "done",
            }
        },
    )
    result = render(content, {"RUN_LABEL": "loop-templates"})
    assert result.rails["completion_query"] == {
        "label": "loop-templates",
        "exclude_column_type": "done",
    }


def test_derived_rails_get_the_raw_value_while_the_prompt_gets_the_go_escape():
    """Rule 6's `{{` escape exists because the runner feeds PROMPTS through Go
    text/template. Platform rails never touch text/template, so escaping there
    corrupts the value — a completion_query label would stop matching."""
    content = _content(
        system_prompt="<<RUN_LABEL>>",
        loop_prompt="x",
        slots=[{"name": "RUN_LABEL", "kind": "scalar", "required": True}],
        derived_rails={"completion_query": {"label": "<<RUN_LABEL>>"}},
    )
    result = render(content, {"RUN_LABEL": "a{{b"})
    assert result.system_prompt == 'a{{"{{"}}b'
    assert result.rails["completion_query"]["label"] == "a{{b"


# --------------------------------------------------------------------- hash


def test_hash_is_stable_across_identical_renders():
    content = _content()
    assert render(content, {"ROLE": "R"}).hash == render(content, {"ROLE": "R"}).hash


def test_hash_changes_when_a_rendered_prompt_changes():
    content = _content()
    assert render(content, {"ROLE": "R"}).hash != render(content, {"ROLE": "S"}).hash


def test_hash_covers_the_loop_prompt_independently_of_the_system_prompt():
    """`hash` is the binding's rendered_hash — the key drift and change detection
    compare on. A hash derived from only ONE prompt would report "unchanged" for
    a template whose loop_prompt was rewritten, so each prompt must move it on
    its own. (Found by mutation: dropping loop_prompt from the digest left the
    suite green.)"""
    content = _content(
        system_prompt="fixed text, no slots",
        loop_prompt="<<ROLE>>",
        slots=[{"name": "ROLE", "kind": "scalar", "required": True}],
    )
    first = render(content, {"ROLE": "R"})
    second = render(content, {"ROLE": "S"})
    assert first.system_prompt == second.system_prompt  # only the loop moved
    assert first.hash != second.hash


def test_hash_distinguishes_a_field_boundary_shift():
    """Concatenating the two prompts without a separator would collide: moving a
    character across the boundary must still change the digest."""
    left = _content(system_prompt="ab", loop_prompt="c", slots=[])
    right = _content(system_prompt="a", loop_prompt="bc", slots=[])
    assert render(left, {}).hash != render(right, {}).hash


# ---------------------------------------------------------------- validate_template


def test_validate_flags_a_slot_used_in_prompts_but_absent_from_the_catalog():
    content = TemplateContent.model_validate(
        {
            "system_prompt": "<<ROLE>> and <<GHOST>>",
            "loop_prompt": "x",
            "slots": [{"name": "ROLE", "kind": "scalar", "required": True}],
            "tools": [OFF_SWITCH_TOOL],
        }
    )
    errors = validate_template(content)
    assert "uncatalogued_slot" in _codes(errors)
    assert any("GHOST" in error["message"] for error in errors)


def test_validate_flags_a_catalogued_slot_no_prompt_uses():
    content = _content(
        slots=[
            {"name": "ROLE", "kind": "scalar", "required": True},
            {"name": "ORPHAN", "kind": "scalar", "required": False},
        ]
    )
    assert "unused_slot" in _codes(validate_template(content))


def test_validate_accepts_an_unused_slot_that_is_a_variant_fill_target():
    """Variant-only fills never appear in the prompts by name; flagging them
    would make every variant template unpublishable."""
    content = _content(
        system_prompt="<<ROLE>> <<LANDING_POLICY>>",
        loop_prompt="x",
        slots=[
            {"name": "ROLE", "kind": "scalar", "required": True},
            {"name": "LANDING_POLICY", "kind": "scalar", "required": False},
            {
                "name": "LANDING",
                "kind": "variant",
                "required": True,
                "variants": [
                    {"id": "a", "label": "A", "fills": {"LANDING_POLICY": "v"}}
                ],
            },
        ],
    )
    assert "unused_slot" not in _codes(validate_template(content))


def test_validate_flags_a_variant_filling_a_slot_that_does_not_exist():
    content = _content(
        system_prompt="<<ROLE>>",
        loop_prompt="x",
        slots=[
            {"name": "ROLE", "kind": "scalar", "required": True},
            {
                "name": "LANDING",
                "kind": "variant",
                "required": True,
                "variants": [{"id": "a", "label": "A", "fills": {"NOPE": "v"}}],
            },
        ],
    )
    assert "variant_fills_unknown_slot" in _codes(validate_template(content))


def test_validate_flags_duplicate_slot_names():
    content = _content(
        slots=[
            {"name": "ROLE", "kind": "scalar", "required": True},
            {"name": "ROLE", "kind": "block", "required": False},
        ]
    )
    assert "duplicate_slot_name" in _codes(validate_template(content))


def test_validate_flags_a_runner_var_the_runner_does_not_define():
    content = _content(system_prompt="<<ROLE>> {{.Board}}")
    errors = validate_template(content)
    assert "unknown_runner_var" in _codes(errors)
    assert any("Board" in error["message"] for error in errors)


def test_validate_accepts_every_documented_runner_var():
    kernel = " ".join(f"{{{{.{var}}}}}" for var in LOOP_RUNNER_VARS)
    content = _content(system_prompt=f"<<ROLE>> {kernel}")
    assert "unknown_runner_var" not in _codes(validate_template(content))


def test_validate_flags_tools_without_the_off_switch():
    content = _content(tools=["mcp__valaris__get_card"])
    assert "off_switch_missing" in _codes(validate_template(content))


def test_validate_flags_a_prompt_over_64kb():
    content = _content(system_prompt="<<ROLE>>" + "z" * (64 * 1024))
    assert "prompt_too_large" in _codes(validate_template(content))


def test_validate_returns_no_errors_for_a_well_formed_template():
    assert validate_template(_content()) == []


def test_validate_reports_every_independent_defect_in_one_pass():
    """An operator fixing a template should see the whole list, not a first
    error that hides the next one behind another round-trip."""
    content = TemplateContent.model_validate(
        {
            "system_prompt": "<<GHOST>> {{.Board}}",
            "loop_prompt": "x",
            "slots": [{"name": "ORPHAN", "kind": "scalar", "required": False}],
            "tools": [],
        }
    )
    codes = set(_codes(validate_template(content)))
    assert {
        "uncatalogued_slot",
        "unused_slot",
        "unknown_runner_var",
        "off_switch_missing",
    } <= codes


# ---------------------------------------------------------------- SlotSpec schema


@pytest.mark.parametrize("name", ["lower", "9LEAD", "HAS SPACE", "", "WITH-DASH"])
def test_slotspec_rejects_names_outside_the_grammar(name):
    with pytest.raises(ValueError):
        SlotSpec.model_validate({"name": name, "kind": "scalar"})


@pytest.mark.parametrize("name", ["A", "ROLE", "RUN_LABEL", "S3", "X_9_Z"])
def test_slotspec_accepts_names_inside_the_grammar(name):
    assert SlotSpec.model_validate({"name": name, "kind": "scalar"}).name == name


def test_slotspec_rejects_an_unknown_kind():
    with pytest.raises(ValueError):
        SlotSpec.model_validate({"name": "ROLE", "kind": "freeform"})


def test_slotspec_used_in_is_derived_not_accepted_from_input():
    """`used_in` is computed by scanning the prompts; accepting it would let a
    hand-kept list drift from the text it claims to describe."""
    spec = SlotSpec.model_validate(
        {"name": "ROLE", "kind": "scalar", "used_in": ["system_prompt"]}
    )
    assert spec.used_in == []


def test_validate_derives_used_in_from_the_prompts():
    content = _content(
        system_prompt="<<ROLE>>",
        loop_prompt="<<ROLE>> and <<OTHER>>",
        slots=[
            {"name": "ROLE", "kind": "scalar", "required": True},
            {"name": "OTHER", "kind": "scalar", "required": False},
        ],
    )
    validate_template(content)
    by_name = {slot.name: slot for slot in content.slots}
    assert by_name["ROLE"].used_in == ["system_prompt", "loop_prompt"]
    assert by_name["OTHER"].used_in == ["loop_prompt"]


# ------------------------------------------------------------------- purity


def test_module_imports_nothing_from_the_database_layer():
    """The renderer is called from services, routers, MCP and preview alike; a
    session import here would drag a DB dependency into all four."""
    source = (
        Path(__file__).resolve().parents[2]
        / "app"
        / "services"
        / "loop_template_render.py"
    ).read_text()
    for forbidden in ("sqlalchemy", "app.models", "app.repositories", "Session"):
        assert forbidden not in source


# ------------------------------------------------------------- golden fixtures


def _golden_binding() -> tuple[TemplateContent, dict]:
    payload = json.loads((FIXTURES / "kernel_v1_binding.json").read_text())
    return TemplateContent.model_validate(payload["content"]), payload["slot_values"]


def test_golden_render_matches_the_checked_in_fixtures():
    """Byte-for-byte. If this fails because you INTENDED to change the renderer,
    update the fixtures in the same PR — that is the contract (spec §3.1 r9)."""
    content, slot_values = _golden_binding()
    result = render(content, slot_values)
    assert result.system_prompt == (FIXTURES / "rendered-system.md").read_text()
    assert result.loop_prompt == (FIXTURES / "rendered-loop.md").read_text()


def test_golden_all_optional_empty_render_matches_the_minimal_fixtures():
    content, slot_values = _golden_binding()
    required = {slot.name for slot in content.slots if slot.required}
    minimal = {name: value for name, value in slot_values.items() if name in required}
    result = render(content, minimal)
    assert result.system_prompt == (FIXTURES / "rendered-minimal-system.md").read_text()
    assert result.loop_prompt == (FIXTURES / "rendered-minimal-loop.md").read_text()


def test_golden_render_introduces_no_dangling_punctuation_the_kernel_lacked():
    """Rule 4/5 in fixture form, stated as a DELTA against the kernel.

    An absolute ban would be wrong: the kernel deliberately contains
    `python3 -m venv .venv` (the string the banned cosmetic regex corrupted) and
    `2>>log`. What must never happen is the renderer INTRODUCING an artifact —
    a `()` left by an empty optional, or a new ` ,` / ` .` seam.
    """
    content, slot_values = _golden_binding()
    required = {slot.name for slot in content.slots if slot.required}
    minimal = {name: value for name, value in slot_values.items() if name in required}
    result = render(content, minimal)
    for field, rendered_text in (
        ("system_prompt", result.system_prompt),
        ("loop_prompt", result.loop_prompt),
    ):
        kernel = getattr(content, field)
        for artifact in ("()", " ,", " ."):
            assert rendered_text.count(artifact) <= kernel.count(
                artifact
            ), f"renderer introduced {artifact!r} into {field}"


def test_golden_render_leaves_no_parentheses_from_an_emptied_optional():
    """The `(<<WORKDIR>>)` wrapper is the case rule 4 exists for."""
    content, slot_values = _golden_binding()
    required = {slot.name for slot in content.slots if slot.required}
    minimal = {name: value for name, value in slot_values.items() if name in required}
    assert "(" in content.system_prompt  # the kernel really does wrap one
    assert "()" not in render(content, minimal).system_prompt
    assert "Working directory is yours." in render(content, minimal).system_prompt


# ------------------------------------------------- effective_slot_values


def _variant_content(**overrides) -> TemplateContent:
    """A template whose POLICY variant fills POLICY_TEXT."""
    base = {
        "system_prompt": "You are <<ROLE>>.",
        "loop_prompt": "Work on <<ROLE>> per <<POLICY_TEXT>>.",
        "slots": [
            {"name": "ROLE", "kind": "scalar", "required": True},
            {"name": "POLICY_TEXT", "kind": "scalar", "required": True},
            {
                "name": "POLICY",
                "kind": "variant",
                "default": "strict",
                "variants": [
                    {
                        "id": "strict",
                        "label": "Strict",
                        "fills": {"POLICY_TEXT": "the strict policy"},
                        "tools_extra": ["mcp__valaris__update_card"],
                        "rails": {"max_iterations": 7},
                    },
                    {
                        "id": "loose",
                        "label": "Loose",
                        "fills": {"POLICY_TEXT": "the loose policy"},
                    },
                ],
            },
        ],
        "tools": [OFF_SWITCH_TOOL],
    }
    base.update(overrides)
    return TemplateContent.model_validate(base)


def test_effective_values_apply_a_variants_fills():
    """A slot the operator never typed into is still FILLED once the variant
    that supplies it is selected — the one place a caller can ask "will this
    render?" without running the renderer."""
    values = effective_slot_values(_variant_content(), {"ROLE": "dev"})

    assert values["POLICY_TEXT"] == "the strict policy"


def test_effective_values_take_the_selected_variant_not_the_default():
    values = effective_slot_values(
        _variant_content(), {"ROLE": "dev", "POLICY": "loose"}
    )

    assert values["POLICY_TEXT"] == "the loose policy"


def test_effective_values_apply_a_slot_default():
    content = _content(
        system_prompt="You are <<ROLE>> on <<TEAM>>.",
        loop_prompt="Work on <<ROLE>> for <<TEAM>>.",
        slots=[
            {"name": "ROLE", "kind": "scalar", "required": True},
            {"name": "TEAM", "kind": "scalar", "required": True, "default": "core"},
        ],
    )

    assert effective_slot_values(content, {"ROLE": "dev"})["TEAM"] == "core"


def test_effective_values_let_an_explicit_value_beat_a_fill_and_a_default():
    values = effective_slot_values(
        _variant_content(), {"ROLE": "dev", "POLICY_TEXT": "my own policy"}
    )

    assert values["POLICY_TEXT"] == "my own policy"


def test_effective_values_keep_a_falsy_but_supplied_value():
    """`"0"` and `False` are ANSWERS. A truthiness check would read them as
    unfilled and demand the operator retype a value they just gave."""
    content = _content(
        system_prompt="You are <<ROLE>> (<<FLAG>>).",
        loop_prompt="Work on <<ROLE>> (<<FLAG>>).",
        slots=[
            {"name": "ROLE", "kind": "scalar", "required": True},
            {"name": "FLAG", "kind": "scalar", "required": True, "default": "yes"},
        ],
    )

    assert effective_slot_values(content, {"ROLE": "dev", "FLAG": "0"})["FLAG"] == "0"
    assert (
        effective_slot_values(content, {"ROLE": "dev", "FLAG": False})["FLAG"] is False
    )


def test_effective_values_omit_a_slot_with_no_value_fill_or_default():
    """Absence is what the caller tests for, so an unfilled slot must be ABSENT
    rather than present-and-empty."""
    values = effective_slot_values(_content(), {})

    assert "ROLE" not in values


def test_effective_values_omit_a_slot_whose_supplied_value_is_empty():
    """The renderer treats `""` and `[]` as unfilled (falling through to the
    default), so this must agree with it or the two disagree about whether a
    render will succeed."""
    values = effective_slot_values(_content(), {"ROLE": ""})

    assert "ROLE" not in values


def test_effective_values_carry_only_slot_values_never_rails_or_tools():
    """Variant selection also yields `tools_extra` and `rails`; leaking them
    here would let a caller seed rails from a guard that only meant to ask
    which slots have values."""
    values = effective_slot_values(_variant_content(), {"ROLE": "dev"})

    assert values == {"ROLE": "dev", "POLICY_TEXT": "the strict policy"}


def test_effective_values_exclude_the_variant_slot_itself():
    """A variant SELECTION is not a substitutable value — `render` skips
    variant slots entirely, so a selection appearing here would report a
    variant slot as "filled" for a caller asking which slots the render will
    actually receive."""
    values = effective_slot_values(
        _variant_content(), {"ROLE": "dev", "POLICY": "loose"}
    )

    assert "POLICY" not in values
    assert values["POLICY_TEXT"] == "the loose policy"


def test_effective_values_exclude_a_variant_slot_resolved_from_its_default():
    """The default path is the one a caller never types into, so it is the one
    most likely to leak the selection back out."""
    assert "POLICY" not in effective_slot_values(_variant_content(), {"ROLE": "dev"})


def test_effective_values_do_not_raise_on_a_template_the_renderer_will_refuse():
    """It runs BEFORE `render`, so raising here would replace the renderer's
    per-slot error contract with a different one."""
    content = _variant_content()
    values = effective_slot_values(content, {"POLICY": "nonexistent-variant"})

    assert "ROLE" not in values


# --------------------------------------------- rule 7: list slots demand a list


def _list_content(join: str = ", ", *, required: bool = False) -> TemplateContent:
    return _content(
        system_prompt="keys: <<DEFINITION_KEYS>>",
        loop_prompt="x",
        slots=[
            {
                "name": "DEFINITION_KEYS",
                "kind": "list",
                "required": required,
                "join": join,
            }
        ],
    )


def test_list_slot_accepts_an_array_and_joins_with_the_declared_join():
    """AC1 — the join comes from the template, not a hardcoded separator."""
    content = _list_content(join=" | ")
    result = render(content, {"DEFINITION_KEYS": ["a", "b"]})
    assert result.system_prompt == "keys: a | b"


def test_list_slot_accepts_a_string_by_splitting_it_on_newlines():
    """AC2 — compat: today's textarea and every stored binding send a string.

    Renders IDENTICALLY to the array form; blank lines are dropped so a
    trailing newline in a textarea does not become an empty item.
    """
    content = _list_content(join=", ")
    from_string = render(content, {"DEFINITION_KEYS": "a\nb"})
    from_array = render(content, {"DEFINITION_KEYS": ["a", "b"]})
    assert from_string.system_prompt == "keys: a, b"
    assert from_string.system_prompt == from_array.system_prompt


def test_list_slot_string_compat_drops_blank_and_whitespace_only_lines():
    content = _list_content(join=", ")
    result = render(content, {"DEFINITION_KEYS": "a\n\n   \nb\n"})
    assert result.system_prompt == "keys: a, b"


@pytest.mark.parametrize("value", [7, {"x": 1}, 3.5, True])
def test_list_slot_rejects_every_other_type_naming_the_slot(value):
    """AC3 — an int/dict/float/bool is a caller bug, not an empty list."""
    content = _list_content()
    with pytest.raises(RenderError) as excinfo:
        render(content, {"DEFINITION_KEYS": value})
    findings = excinfo.value.errors
    assert _codes(findings) == ["list_slot_expects_array"]
    assert findings[0]["field"] == "slot_values.DEFINITION_KEYS"
    assert findings[0]["params"]["slot"] == "DEFINITION_KEYS"


def test_list_slot_rejection_names_every_problem_in_one_pass():
    """RenderError carries a LIST — a bad list must not short-circuit the rest."""
    content = _content(
        system_prompt="keys: <<DEFINITION_KEYS>> role: <<ROLE>>",
        loop_prompt="x",
        slots=[
            {"name": "DEFINITION_KEYS", "kind": "list", "join": ", "},
            {"name": "ROLE", "kind": "scalar", "required": True},
        ],
    )
    with pytest.raises(RenderError) as excinfo:
        render(content, {"DEFINITION_KEYS": 7, "ROLE": "line\nbreak"})
    assert set(_codes(excinfo.value.errors)) == {
        "list_slot_expects_array",
        "scalar_must_be_single_line",
    }


def test_an_explicitly_empty_list_stays_a_legitimate_answer():
    """AC4 — `[]` is an answer ("no keys"), never a type error."""
    content = _list_content()
    assert render(content, {"DEFINITION_KEYS": []}).system_prompt == "keys:"


def test_an_empty_string_for_a_list_slot_is_not_a_type_error():
    """The empty textarea is the empty list, not a malformed value."""
    content = _list_content()
    assert render(content, {"DEFINITION_KEYS": ""}).system_prompt == "keys:"
