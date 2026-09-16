# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from app.services.agents.context_source_lint import lint_context_source_wiring


def _stage(role: str, stage_name: str, sources: list[dict]) -> dict:
    return {
        "role": role,
        "discover": {"strategy": "unassigned_or_rework"},
        "claim": {"participant_role": "hero"},
        "git": {"action": "none"},
        "llm": {
            "enabled": True,
            "stage": stage_name,
            "context_sources": sources,
        },
    }


def _config(stages: list[dict]) -> dict:
    return {"stages": stages, "scheduling": {"priority_order": [], "mode": "priority"}}


def test_declared_but_unreferenced_warns():
    config = _config(
        [_stage("implementer", "implement", [{"kind": "pipeline_expectations"}])]
    )
    prompts = {("implementer", "implement"): "Do the work. No context here."}

    findings = lint_context_source_wiring(config, prompts)

    codes = [f["code"] for f in findings]
    assert "context_source_declared_but_unreferenced" in codes
    finding = next(
        f for f in findings if f["code"] == "context_source_declared_but_unreferenced"
    )
    assert finding["severity"] == "warning"
    assert finding["value"] == "pipeline_expectations"


def test_declared_and_referenced_does_not_warn():
    config = _config(
        [_stage("implementer", "implement", [{"kind": "pipeline_expectations"}])]
    )
    prompts = {
        ("implementer", "implement"): (
            'Expectations:\n{{ index .ContextSources "pipeline_expectations" }}'
        )
    }

    findings = lint_context_source_wiring(config, prompts)

    assert findings == []


def test_referenced_but_undeclared_warns():
    config = _config([_stage("implementer", "implement", [])])
    prompts = {
        ("implementer", "implement"): '{{ index .ContextSources "linked_cards" }}'
    }

    findings = lint_context_source_wiring(config, prompts)

    codes = [f["code"] for f in findings]
    assert "context_source_referenced_but_undeclared" in codes
    finding = next(
        f for f in findings if f["code"] == "context_source_referenced_but_undeclared"
    )
    assert finding["severity"] == "warning"
    assert finding["value"] == "linked_cards"


def test_whitespace_variants_in_reference_match():
    config = _config(
        [_stage("implementer", "implement", [{"kind": "pipeline_expectations"}])]
    )
    prompts = {
        ("implementer", "implement"): '{{index .ContextSources "pipeline_expectations"}}'
    }

    findings = lint_context_source_wiring(config, prompts)

    assert findings == []


def test_custom_alias_via_as_is_honored():
    config = _config(
        [
            _stage(
                "implementer",
                "implement",
                [{"kind": "linked_cards", "as": "deps"}],
            )
        ]
    )
    prompts = {("implementer", "implement"): '{{ index .ContextSources "deps" }}'}

    findings = lint_context_source_wiring(config, prompts)

    assert findings == []


def test_board_definition_legacy_bridge_does_not_warn():
    # board_definition reaches the prompt via {{.ProjectDirectives}}, not the
    # index form — must NOT warn as declared-but-unreferenced.
    config = _config(
        [_stage("implementer", "implement", [{"kind": "board_definition"}])]
    )
    prompts = {
        ("implementer", "implement"): "Directives:\n{{.ProjectDirectives}}"
    }

    findings = lint_context_source_wiring(config, prompts)

    assert findings == []


def test_review_history_legacy_bridge_does_not_warn():
    config = _config([_stage("reviewer", "review", [{"kind": "review_history"}])])
    prompts = {("reviewer", "review"): "History:\n{{.ReviewHistory}}"}

    findings = lint_context_source_wiring(config, prompts)

    assert findings == []


def test_board_definition_declared_with_no_reference_anywhere_warns():
    # If neither the index form NOR the legacy {{.ProjectDirectives}} appears,
    # the source is genuinely inert and should warn.
    config = _config(
        [_stage("implementer", "implement", [{"kind": "board_definition"}])]
    )
    prompts = {("implementer", "implement"): "No directives referenced."}

    findings = lint_context_source_wiring(config, prompts)

    codes = [f["code"] for f in findings]
    assert "context_source_declared_but_unreferenced" in codes


def test_referencing_legacy_alias_via_index_does_not_warn_as_undeclared():
    # The two legacy aliases are always reachable; referencing them via the
    # index form without declaring is not an error.
    config = _config([_stage("implementer", "implement", [])])
    prompts = {
        ("implementer", "implement"): '{{ index .ContextSources "board_definition" }}'
    }

    findings = lint_context_source_wiring(config, prompts)

    codes = [f["code"] for f in findings]
    assert "context_source_referenced_but_undeclared" not in codes


def test_missing_prompt_content_skips_stage():
    # A stage with no authored prompt (uses hardcoded default) can't be linted
    # from content — skip rather than false-warn.
    config = _config(
        [_stage("implementer", "implement", [{"kind": "pipeline_expectations"}])]
    )

    findings = lint_context_source_wiring(config, {})

    assert findings == []


def test_field_path_points_at_stage_context_source():
    config = _config(
        [_stage("implementer", "implement", [{"kind": "pipeline_expectations"}])]
    )
    prompts = {("implementer", "implement"): "nothing"}

    findings = lint_context_source_wiring(config, prompts)

    finding = next(
        f for f in findings if f["code"] == "context_source_declared_but_unreferenced"
    )
    assert "implementer" in finding["field"] or "implement" in finding["field"]
