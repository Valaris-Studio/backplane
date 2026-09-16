# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""preview() — render(), but it never refuses to answer.

render() raises on the first finding because it runs at SAVE time, where a
partial answer would persist a half-bound board. Preview is the opposite
situation: the operator is LOOKING, has not committed to anything, and the
whole point is to SEE the problems. So the same pure core runs with findings
collected instead of raised, and the prompts render as far as the values allow.
"""

import pytest

from app.services.loop_template_render import (
    SlotSpec,
    SlotVariant,
    TemplateContent,
    preview,
    render_runner_tools_manifest,
)

# Copied verbatim from runner/internal/workloop/loopmode.go:776-788
# (func toolManifest). If the runner changes that function, update BOTH this
# constant and render_runner_tools_manifest.
GO_EMPTY_MANIFEST = (
    "\n\n## Tools available\n\n"
    "(the board granted no explicit allowlist)\n"
    '\nIf keyword search misses a tool listed here, load it with ToolSearch("select:<name>").\n'
)
GO_TWO_TOOL_MANIFEST = (
    "\n\n## Tools available\n\n"
    "mcp__valaris__get_card\n"
    "mcp__valaris__set_board_loop\n"
    '\nIf keyword search misses a tool listed here, load it with ToolSearch("select:<name>").\n'
)


def _content(**overrides) -> TemplateContent:
    base = dict(
        system_prompt="Run <<RUN_LABEL>> on <<REPO_URL>>.",
        loop_prompt="Advance <<RUN_LABEL>>.",
        slots=[
            SlotSpec(name="RUN_LABEL", kind="scalar", required=True, example="loop-8"),
            SlotSpec(
                name="REPO_URL", kind="scalar", default="https://example.test/repo"
            ),
        ],
        tools=["mcp__valaris__get_card", "mcp__valaris__set_board_loop"],
        rails_defaults={"budget_usd": 30.0, "max_iterations": 50},
    )
    base.update(overrides)
    return TemplateContent(**base)


def test_preview_falls_back_default_then_example():
    """Precedence is supplied > autofill > default > example, and `source`
    reports which rung actually answered — the bind form colours the field by
    it, so a wrong label is a wrong UI."""
    result = preview(_content(), slot_values={}, autofill={})

    assert result.used_values["REPO_URL"] == {
        "value": "https://example.test/repo",
        "source": "default",
    }
    assert result.used_values["RUN_LABEL"] == {"value": "loop-8", "source": "example"}
    assert result.system_prompt == "Run loop-8 on https://example.test/repo."


def test_preview_default_outranks_example_when_a_slot_carries_both():
    """`default` is the value the author intends to SHIP; `example` only shows
    the shape. A slot carrying both must render the default, or a preview
    teaches the operator a value the bind step would never use."""
    content = _content(
        system_prompt="Run <<RUN_LABEL>>.",
        loop_prompt="Advance <<RUN_LABEL>>.",
        slots=[
            SlotSpec(
                name="RUN_LABEL",
                kind="scalar",
                default="the-default",
                example="the-example",
            )
        ],
    )

    result = preview(content, slot_values={}, autofill={})

    assert result.used_values["RUN_LABEL"] == {
        "value": "the-default",
        "source": "default",
    }
    assert result.loop_prompt == "Advance the-default."


def test_preview_autofill_outranks_default_and_is_outranked_by_supplied():
    """Autofill sits BETWEEN supplied and default: a board fact beats the
    template author's guess, and an operator's keystroke beats the board."""
    content = _content(
        slots=[
            SlotSpec(name="RUN_LABEL", kind="scalar", required=True, example="loop-8"),
            SlotSpec(name="REPO_URL", kind="scalar", default="https://default.test"),
        ]
    )

    result = preview(
        content,
        slot_values={"RUN_LABEL": "typed-by-hand"},
        autofill={
            "RUN_LABEL": {"value": "from-board", "source": "completion_query"},
            "REPO_URL": {"value": "https://board.test", "source": "git_repo:x"},
        },
    )

    assert result.used_values["RUN_LABEL"] == {
        "value": "typed-by-hand",
        "source": "supplied",
    }
    assert result.used_values["REPO_URL"] == {
        "value": "https://board.test",
        "source": "autofill",
    }


def test_preview_reports_missing_required_without_raising():
    """A required slot with no supplied value, no autofill, no default and no
    example is exactly what preview exists to SHOW. render() would raise here."""
    content = _content(
        slots=[SlotSpec(name="RUN_LABEL", kind="scalar", required=True)],
        system_prompt="Run <<RUN_LABEL>>.",
        loop_prompt="Advance <<RUN_LABEL>>.",
    )

    result = preview(content, slot_values={}, autofill={})

    assert result.missing_required == ["RUN_LABEL"]
    assert "RUN_LABEL" not in result.used_values
    codes = [f["code"] for f in result.findings]
    assert "required_slot_missing" in codes
    # Still rendered as far as it could: the unfilled slot stays literal so the
    # operator sees WHERE the hole is rather than a blank line.
    assert result.loop_prompt == "Advance <<RUN_LABEL>>."


def test_preview_unknown_slot_is_a_finding_not_a_raise():
    result = preview(_content(), slot_values={"NOPE": "x"}, autofill={})

    assert [f["code"] for f in result.findings] == ["unknown_slot"]
    assert result.findings[0]["field"] == "slot_values.NOPE"
    assert "NOPE" not in result.used_values


def test_preview_escapes_go_braces_in_prompts_only():
    """A value containing `{{` reaches the runner's text/template. Rule 6's
    escape is what stops it from being parsed as an action — and preview must
    show the ESCAPED form, because that is the literal string the runner gets."""
    content = _content(
        slots=[SlotSpec(name="RUN_LABEL", kind="scalar")],
        system_prompt="S <<RUN_LABEL>>",
        loop_prompt="L <<RUN_LABEL>>",
        derived_rails={"completion_query": {"label": "<<RUN_LABEL>>"}},
    )

    result = preview(content, slot_values={"RUN_LABEL": "a{{b"}, autofill={})

    assert result.loop_prompt == 'L a{{"{{"}}b'
    assert result.system_prompt == 'S a{{"{{"}}b'
    # Rails are platform config, never seen by text/template: escaping the
    # completion_query label would simply stop it matching cards.
    assert result.rails["completion_query"] == {"label": "a{{b"}
    assert result.used_values["RUN_LABEL"]["value"] == "a{{b"


def test_preview_surfaces_template_validation_findings():
    """Kernel-level problems (an unknown runner var) belong in the same finding
    list as value-level ones — the operator does not care which layer noticed."""
    content = _content(loop_prompt="Advance <<RUN_LABEL>> as {{.NotAVar}}.")

    result = preview(content, slot_values={}, autofill={})

    unknown = [f for f in result.findings if f["code"] == "unknown_runner_var"]
    assert [f["value"] for f in unknown] == ["NotAVar"]


def test_preview_variant_contributes_tools_and_rails():
    """A variant is the one slot kind that changes more than text, so preview
    must resolve it — otherwise the tools manifest and rails it shows are the
    wrong ones."""
    content = _content(
        slots=[
            SlotSpec(name="RUN_LABEL", kind="scalar", example="loop-8"),
            SlotSpec(
                name="MODE",
                kind="variant",
                default="deep",
                variants=[
                    SlotVariant(
                        id="deep",
                        label="Deep",
                        tools_extra=["mcp__valaris__create_note"],
                        rails={"budget_usd": 99.0},
                    )
                ],
            ),
        ]
    )

    result = preview(content, slot_values={}, autofill={})

    assert "mcp__valaris__create_note" in result.tools
    assert result.rails["budget_usd"] == 99.0


def test_preview_variant_not_found_is_a_finding_not_a_raise():
    """resolve_variants() raises for a bogus selection. Preview downgrades it:
    a typo in a variant id is a thing to SHOW, and the rest of the render is
    still worth seeing."""
    content = _content(
        system_prompt="Run <<RUN_LABEL>>.",
        slots=[
            SlotSpec(name="RUN_LABEL", kind="scalar", example="loop-8"),
            SlotSpec(
                name="MODE",
                kind="variant",
                variants=[SlotVariant(id="deep", label="Deep")],
            ),
        ],
    )

    result = preview(content, slot_values={"MODE": "nope"}, autofill={})

    assert [f["code"] for f in result.findings] == ["variant_not_found"]
    assert result.loop_prompt == "Advance loop-8."


def test_preview_required_variant_with_no_selection_still_returns():
    """The one path where preview would otherwise RAISE: a required variant
    with nothing selected and no default. resolve_variants() refuses, and the
    soft retry has to relax `required` or the whole preview dies on the very
    template the operator opened it to finish filling in."""
    content = _content(
        system_prompt="Run <<RUN_LABEL>>.",
        slots=[
            SlotSpec(name="RUN_LABEL", kind="scalar", example="loop-8"),
            SlotSpec(
                name="MODE",
                kind="variant",
                required=True,
                variants=[SlotVariant(id="deep", label="Deep")],
            ),
        ],
    )

    result = preview(content, slot_values={}, autofill={})

    assert [f["code"] for f in result.findings] == ["required_slot_missing"]
    assert result.findings[0]["field"] == "slot_values.MODE"
    assert result.loop_prompt == "Advance loop-8."


def test_preview_enum_violation_is_a_finding_and_the_value_still_shows():
    content = _content(
        slots=[
            SlotSpec(name="RUN_LABEL", kind="enum", enum_values=["a", "b"]),
        ],
        system_prompt="S <<RUN_LABEL>>",
        loop_prompt="L <<RUN_LABEL>>",
    )

    result = preview(content, slot_values={"RUN_LABEL": "z"}, autofill={})

    assert [f["code"] for f in result.findings] == ["enum_value_not_allowed"]
    assert result.loop_prompt == "L z"


def test_manifest_matches_go_source_when_tools_empty():
    """Golden string, byte for byte, from loopmode.go's toolManifest.

    The empty branch is not cosmetic: a preview that silently showed an empty
    list would hide that the runner tells the agent it has NO allowlist.
    """
    assert render_runner_tools_manifest([]) == GO_EMPTY_MANIFEST


def test_manifest_matches_go_source_with_tools():
    assert (
        render_runner_tools_manifest(
            ["mcp__valaris__get_card", "mcp__valaris__set_board_loop"]
        )
        == GO_TWO_TOOL_MANIFEST
    )


def test_preview_loop_prompt_with_tools_manifest_is_the_runner_view():
    """The runner appends the manifest AFTER rendering (loopmode.go:636), so
    the concatenation order here is the contract, not a formatting choice."""
    result = preview(_content(), slot_values={}, autofill={})

    assert result.loop_prompt_with_tools_manifest == (
        result.loop_prompt + GO_TWO_TOOL_MANIFEST
    )
    assert not result.loop_prompt.endswith(GO_TWO_TOOL_MANIFEST)


def test_preview_manifest_reflects_variant_tools():
    """The manifest must be built from the RESOLVED tool list — a variant's
    tools_extra is exactly the case where the template's static list lies."""
    content = _content(
        tools=["mcp__valaris__get_card"],
        slots=[
            SlotSpec(name="RUN_LABEL", kind="scalar", example="loop-8"),
            SlotSpec(
                name="MODE",
                kind="variant",
                default="deep",
                variants=[
                    SlotVariant(
                        id="deep", label="Deep", tools_extra=["mcp__valaris__get_note"]
                    )
                ],
            ),
        ],
    )

    result = preview(content, slot_values={}, autofill={})

    assert result.loop_prompt_with_tools_manifest.endswith(
        "\n\n## Tools available\n\n"
        "mcp__valaris__get_card\n"
        "mcp__valaris__get_note\n"
        '\nIf keyword search misses a tool listed here, load it with ToolSearch("select:<name>").\n'
    )


def test_preview_reports_a_leftover_uncatalogued_slot():
    """`<<TYPO>>` in the kernel reaches the runner as literal noise. render()
    422s on it; preview names it so the author can fix the prompt."""
    content = _content(loop_prompt="Advance <<RUN_LABEL>> then <<TYPO>>.")

    result = preview(content, slot_values={}, autofill={})

    leftover = [f for f in result.findings if f["code"] == "unrendered_slot"]
    assert [f["value"] for f in leftover] == ["TYPO"]
    assert leftover[0]["field"] == "loop_prompt"


@pytest.mark.parametrize("field", ["system_prompt", "loop_prompt"])
def test_preview_reports_oversize_prompts_as_findings(field):
    from app.services.loop_config_validation import PROMPT_MAX_BYTES

    result = preview(
        _content(**{field: "x" * (PROMPT_MAX_BYTES + 1)}),
        slot_values={},
        autofill={},
    )

    too_large = [f for f in result.findings if f["code"] == "prompt_too_large"]
    assert [f["field"] for f in too_large] == [field]
