# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import copy

from app.services.pipeline_config_validation import (
    canonicalize_pipeline_config,
    validate_pipeline_config,
)


def _minimal_stage(role: str) -> dict:
    return {
        "role": role,
        "discover": {"strategy": "unassigned_or_rework"},
        "claim": {"participant_role": "hero"},
        "git": {"action": "none"},
        "llm": {"enabled": False},
        "on_success": {},
    }


def _stage_with_context_sources(role: str, sources: list[dict]) -> dict:
    stage = _minimal_stage(role)
    stage["llm"] = {"enabled": False, "context_sources": sources}
    return stage


def test_canonicalize_defaults_scheduling_mode_to_priority():
    config = {
        "stages": [_minimal_stage("orchestrator")],
        "scheduling": {"priority_order": ["orchestrator"]},
    }

    canonicalize_pipeline_config(config)

    assert config["scheduling"]["mode"] == "priority"


def test_canonicalize_preserves_existing_mode():
    config = {
        "stages": [_minimal_stage("orchestrator")],
        "scheduling": {"priority_order": ["orchestrator"], "mode": "round_robin"},
    }

    canonicalize_pipeline_config(config)

    assert config["scheduling"]["mode"] == "round_robin"


def test_validate_rejects_unknown_scheduling_mode():
    config = {
        "stages": [_minimal_stage("orchestrator")],
        "scheduling": {"priority_order": ["orchestrator"], "mode": "turbo"},
    }

    errors = validate_pipeline_config(config)

    matching = [
        e for e in errors
        if e.get("code") == "unknown_scheduling_mode"
        and e.get("field") == "scheduling.mode"
    ]
    assert matching, f"expected unknown_scheduling_mode error, got {errors!r}"


def test_validation_finding_adds_localizable_params_without_replacing_raw_message():
    config = {
        "stages": [_minimal_stage("orchestrator")],
        "scheduling": {"priority_order": ["orchestrator"], "mode": "turbo"},
    }

    errors = validate_pipeline_config(config)

    finding = next(e for e in errors if e["code"] == "unknown_scheduling_mode")
    assert finding["field"] == "scheduling.mode"
    assert finding["value"] == "turbo"
    assert finding["params"] == {
        "field": "scheduling.mode",
        "value": "turbo",
    }
    assert finding["message"] == (
        "unknown scheduling.mode 'turbo' "
        "(expected one of ['priority', 'round_robin'])"
    )


def test_lifecycle_dangling_branch_exposes_step_branch_and_target_params():
    stage = _minimal_stage("orchestrator")
    stage["lifecycle"] = [
        {
            "name": "decide",
            "kind": "branch",
            "params": {"expression": "decision"},
            "branches": {"approve": "missing-step"},
        }
    ]

    errors = validate_pipeline_config({"stages": [stage]})

    finding = next(
        e
        for e in errors
        if e["code"] == "lifecycle_step_dangling_reference"
        and ".branches.approve" in e["field"]
    )
    assert finding["params"] == {
        "field": "stages[0].lifecycle[0].branches.approve",
        "value": "missing-step",
        "step": "decide",
        "branch": "approve",
        "target": "missing-step",
        "reference": "branch",
    }


def test_validate_accepts_deprecated_scheduling_fields():
    config = {
        "stages": [_minimal_stage("orchestrator")],
        "scheduling": {
            "priority_order": ["orchestrator"],
            "max_consecutive_same_role": 5,
            "max_consecutive": 5,
            "starvation_prevention": True,
        },
    }

    errors = validate_pipeline_config(config)

    assert errors == [], f"deprecated fields must be tolerated silently, got {errors!r}"


def test_canonicalize_defaults_unique_true_for_legacy_roles():
    """Existing workspaces persisted their pipeline_config before the `unique`
    field existed. Legacy role names (orchestrator/reviewer/documentator) must
    inherit `unique=True` so their one-per-team semantics survive the upgrade."""
    config = {
        "stages": [
            _minimal_stage("orchestrator"),
            _minimal_stage("reviewer"),
            _minimal_stage("documentator"),
        ],
    }

    canonicalize_pipeline_config(config)

    assert config["stages"][0]["unique"] is True
    assert config["stages"][1]["unique"] is True
    assert config["stages"][2]["unique"] is True


def test_canonicalize_defaults_unique_false_for_non_legacy_roles():
    config = {
        "stages": [
            _minimal_stage("security-auditor"),
            _minimal_stage("db-migrator"),
        ],
    }

    canonicalize_pipeline_config(config)

    assert config["stages"][0]["unique"] is False
    assert config["stages"][1]["unique"] is False


def test_canonicalize_preserves_explicit_unique_flag():
    """Operator intent wins over the legacy-role default."""
    stage_a = _minimal_stage("orchestrator")
    stage_a["unique"] = False
    stage_b = _minimal_stage("security-auditor")
    stage_b["unique"] = True
    config = {"stages": [stage_a, stage_b]}

    canonicalize_pipeline_config(config)

    assert config["stages"][0]["unique"] is False
    assert config["stages"][1]["unique"] is True


# ---------------------------------------------------------------------------
# CTX-1: llm.context_sources schema validation
# ---------------------------------------------------------------------------


def test_validate_accepts_three_starter_context_source_kinds():
    stage = _stage_with_context_sources(
        "orchestrator",
        [
            {"kind": "card_notes", "filter": {"kind": "user_note"}, "as": "notes"},
            {"kind": "board_definition"},
            {"kind": "pinned_notes"},
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    assert errors == [], f"expected no errors, got {errors!r}"


def test_validate_rejects_unknown_context_source_kind():
    stage = _stage_with_context_sources(
        "orchestrator",
        [{"kind": "definitely_not_a_real_context_kind"}],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e for e in errors
        if e.get("code") == "unknown_context_source_kind"
        and "context_sources[0].kind" in (e.get("field") or "")
    ]
    assert matching, f"expected unknown_context_source_kind error, got {errors!r}"


def test_validate_rejects_unknown_card_notes_filter_kind():
    stage = _stage_with_context_sources(
        "orchestrator",
        [{"kind": "card_notes", "filter": {"kind": "definitely_not_a_real_note_kind"}}],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e for e in errors
        if e.get("code") == "unknown_card_notes_filter_kind"
    ]
    assert matching, f"expected unknown_card_notes_filter_kind, got {errors!r}"


def test_validate_rejects_duplicate_context_source_alias():
    stage = _stage_with_context_sources(
        "orchestrator",
        [
            {"kind": "card_notes", "filter": {"kind": "user_note"}, "as": "context"},
            {"kind": "pinned_notes", "as": "context"},
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e for e in errors
        if e.get("code") == "duplicate_context_source_alias"
    ]
    assert matching, f"expected duplicate_context_source_alias, got {errors!r}"


def test_validate_rejects_duplicate_default_alias_when_kind_repeated():
    """Two sources of the same kind with no explicit `as` collide on the kind-default."""
    stage = _stage_with_context_sources(
        "orchestrator",
        [
            {"kind": "pinned_notes"},
            {"kind": "pinned_notes"},
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e for e in errors
        if e.get("code") == "duplicate_context_source_alias"
    ]
    assert matching, f"expected duplicate alias on default-kind collision, got {errors!r}"


def test_validate_rejects_reserved_context_alias():
    stage = _stage_with_context_sources(
        "orchestrator",
        [{"kind": "pinned_notes", "as": "card_id"}],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e for e in errors
        if e.get("code") == "reserved_context_source_alias"
    ]
    assert matching, f"expected reserved_context_source_alias, got {errors!r}"


def test_validate_rejects_non_list_context_sources():
    stage = _minimal_stage("orchestrator")
    stage["llm"] = {"enabled": False, "context_sources": {"kind": "pinned_notes"}}
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e for e in errors
        if e.get("code") == "invalid_context_sources"
    ]
    assert matching, f"expected invalid_context_sources, got {errors!r}"


def test_validate_rejects_context_source_missing_kind():
    stage = _stage_with_context_sources(
        "orchestrator",
        [{"filter": {"kind": "user_note"}}],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e for e in errors
        if e.get("code") == "missing_context_source_kind"
    ]
    assert matching, f"expected missing_context_source_kind, got {errors!r}"


def test_validate_accepts_board_definition_with_no_filter():
    """`board_definition` and `pinned_notes` take no filter; absence is fine."""
    stage = _stage_with_context_sources(
        "orchestrator",
        [
            {"kind": "board_definition"},
            {"kind": "pinned_notes"},
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    assert errors == [], f"expected no errors, got {errors!r}"


# ---------------------------------------------------------------------------
# PAR-1: GitDef.base_ref closed enum (default_branch | integration_branch)
# ---------------------------------------------------------------------------


def test_validate_accepts_git_base_ref_default_branch():
    stage = _minimal_stage("orchestrator")
    stage["git"] = {"action": "create_branch", "base_ref": "default_branch"}
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    assert errors == [], f"base_ref=default_branch must validate, got {errors!r}"


def test_validate_accepts_git_base_ref_integration_branch():
    stage = _minimal_stage("orchestrator")
    stage["git"] = {"action": "create_branch", "base_ref": "integration_branch"}
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    assert errors == [], f"base_ref=integration_branch must validate, got {errors!r}"


def test_validate_accepts_missing_git_base_ref():
    stage = _minimal_stage("orchestrator")
    stage["git"] = {"action": "create_branch"}
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    assert errors == [], f"missing base_ref must validate (default behavior), got {errors!r}"


def test_validate_rejects_unknown_git_base_ref():
    stage = _minimal_stage("orchestrator")
    stage["git"] = {"action": "create_branch", "base_ref": "main"}
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e for e in errors
        if e.get("code") == "unknown_git_base_ref"
        and e.get("field") == "stages[0].git.base_ref"
    ]
    assert matching, f"expected unknown_git_base_ref error, got {errors!r}"


# ---------------------------------------------------------------------------
# PAR-2: pipeline.merge_via_queue feature flag (boolean, default false)
# ---------------------------------------------------------------------------


def test_validate_accepts_merge_via_queue_true():
    config = {
        "stages": [_minimal_stage("orchestrator")],
        "merge_via_queue": True,
    }

    errors = validate_pipeline_config(config)

    assert errors == [], f"merge_via_queue=true must validate, got {errors!r}"


def test_validate_accepts_merge_via_queue_false():
    config = {
        "stages": [_minimal_stage("orchestrator")],
        "merge_via_queue": False,
    }

    errors = validate_pipeline_config(config)

    assert errors == [], f"merge_via_queue=false must validate, got {errors!r}"


def test_validate_accepts_missing_merge_via_queue():
    config = {"stages": [_minimal_stage("orchestrator")]}

    errors = validate_pipeline_config(config)

    assert errors == [], f"missing merge_via_queue must validate, got {errors!r}"


def test_validate_rejects_non_boolean_merge_via_queue():
    config = {
        "stages": [_minimal_stage("orchestrator")],
        "merge_via_queue": "yes",
    }

    errors = validate_pipeline_config(config)

    matching = [
        e for e in errors
        if e.get("code") == "invalid_merge_via_queue"
        and e.get("field") == "merge_via_queue"
    ]
    assert matching, f"expected invalid_merge_via_queue error, got {errors!r}"


# ---------------------------------------------------------------------------
# CTX-5: sibling_cards / board_snapshot / review_history filter validation
# ---------------------------------------------------------------------------


def test_validate_accepts_three_new_context_source_kinds():
    stage = _stage_with_context_sources(
        "orchestrator",
        [
            {"kind": "sibling_cards", "as": "siblings"},
            {"kind": "board_snapshot"},
            {"kind": "review_history"},
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    assert errors == [], f"expected no errors, got {errors!r}"


def test_validate_accepts_sibling_cards_filter_full_shape():
    stage = _stage_with_context_sources(
        "orchestrator",
        [
            {
                "kind": "sibling_cards",
                "filter": {
                    "column_type": "review",
                    "column": "in-review",
                    "label": "role:reviewer",
                    "priority": "high",
                    "limit": 25,
                },
            },
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    assert errors == [], f"expected no errors, got {errors!r}"


def test_sibling_cards_filter_rejects_limit_over_50():
    stage = _stage_with_context_sources(
        "orchestrator",
        [{"kind": "sibling_cards", "filter": {"limit": 51}}],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e for e in errors
        if e.get("code") == "invalid_sibling_cards_filter"
        and "limit" in (e.get("field") or "")
    ]
    assert matching, f"expected invalid_sibling_cards_filter limit error, got {errors!r}"


def test_sibling_cards_filter_rejects_limit_below_one():
    stage = _stage_with_context_sources(
        "orchestrator",
        [{"kind": "sibling_cards", "filter": {"limit": 0}}],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e for e in errors
        if e.get("code") == "invalid_sibling_cards_filter"
        and "limit" in (e.get("field") or "")
    ]
    assert matching, f"expected invalid_sibling_cards_filter limit error, got {errors!r}"


def test_sibling_cards_filter_rejects_unknown_column_type():
    stage = _stage_with_context_sources(
        "orchestrator",
        [{"kind": "sibling_cards", "filter": {"column_type": "wishlist"}}],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e for e in errors
        if e.get("code") == "invalid_sibling_cards_filter"
        and "column_type" in (e.get("field") or "")
    ]
    assert matching, f"expected invalid_sibling_cards_filter column_type error, got {errors!r}"


def test_board_snapshot_filter_accepts_defaults_omitted():
    stage = _stage_with_context_sources(
        "orchestrator",
        [{"kind": "board_snapshot"}],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    assert errors == [], f"expected no errors, got {errors!r}"


def test_board_snapshot_filter_rejects_negative_max_cards():
    stage = _stage_with_context_sources(
        "orchestrator",
        [{"kind": "board_snapshot", "filter": {"max_cards_per_column": -1}}],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e for e in errors
        if e.get("code") == "invalid_board_snapshot_filter"
        and "max_cards_per_column" in (e.get("field") or "")
    ]
    assert matching, (
        f"expected invalid_board_snapshot_filter max_cards_per_column error, got {errors!r}"
    )


def test_board_snapshot_filter_rejects_max_cards_over_100():
    stage = _stage_with_context_sources(
        "orchestrator",
        [{"kind": "board_snapshot", "filter": {"max_cards_per_column": 101}}],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e for e in errors
        if e.get("code") == "invalid_board_snapshot_filter"
        and "max_cards_per_column" in (e.get("field") or "")
    ]
    assert matching, (
        f"expected invalid_board_snapshot_filter max_cards_per_column error, got {errors!r}"
    )


def test_board_snapshot_filter_rejects_non_bool_include_done():
    stage = _stage_with_context_sources(
        "orchestrator",
        [{"kind": "board_snapshot", "filter": {"include_done": "yes"}}],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e for e in errors
        if e.get("code") == "invalid_board_snapshot_filter"
        and "include_done" in (e.get("field") or "")
    ]
    assert matching, (
        f"expected invalid_board_snapshot_filter include_done error, got {errors!r}"
    )


def test_review_history_rejects_any_filter():
    stage = _stage_with_context_sources(
        "orchestrator",
        [{"kind": "review_history", "filter": {"limit": 10}}],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e for e in errors
        if e.get("code") == "review_history_filter_not_supported"
    ]
    assert matching, (
        f"expected review_history_filter_not_supported error, got {errors!r}"
    )


def test_review_history_accepts_no_filter():
    stage = _stage_with_context_sources(
        "orchestrator",
        [{"kind": "review_history"}],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    assert errors == [], f"expected no errors, got {errors!r}"


# ---------------------------------------------------------------------------
# LIFECYCLE-1 A.1: generic lifecycle DSL validation
# ---------------------------------------------------------------------------


def _stage_with_lifecycle(role: str, lifecycle: list[dict]) -> dict:
    stage = _minimal_stage(role)
    stage["lifecycle"] = lifecycle
    return stage


def test_validate_accepts_minimal_lifecycle_with_terminal_step():
    stage = _stage_with_lifecycle(
        "orchestrator",
        [
            {
                "name": "do_move",
                "kind": "move_card",
                "params": {"to_column_type": "active"},
            }
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    assert errors == [], f"expected no errors, got {errors!r}"


def test_validate_accepts_chained_lifecycle_with_next():
    stage = _stage_with_lifecycle(
        "orchestrator",
        [
            {
                "name": "find",
                "kind": "discover",
                "params": {"strategy": "unassigned_or_rework"},
                "next": "grab",
            },
            {
                "name": "grab",
                "kind": "claim",
                "params": {
                    "participant_role": "hero",
                    "execution_action": "implement_card",
                    "pipeline_role": "implementer",
                },
                "next": "ship",
            },
            {
                "name": "ship",
                "kind": "move_card",
                "params": {"to_column_type": "active"},
            },
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    assert errors == [], f"expected no errors, got {errors!r}"


def test_validate_rejects_unknown_lifecycle_kind():
    stage = _stage_with_lifecycle(
        "orchestrator",
        [{"name": "weird", "kind": "totally_made_up", "next": "x"}],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [e for e in errors if e.get("code") == "lifecycle_step_unknown_kind"]
    assert matching, f"expected lifecycle_step_unknown_kind, got {errors!r}"


def test_validate_rejects_duplicate_lifecycle_step_names():
    stage = _stage_with_lifecycle(
        "orchestrator",
        [
            {"name": "step", "kind": "apply_label", "params": {"label": "wip"}},
            {"name": "step", "kind": "remove_label", "params": {"label": "wip"}},
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [e for e in errors if e.get("code") == "lifecycle_step_name_collision"]
    assert matching, f"expected lifecycle_step_name_collision, got {errors!r}"


def test_validate_rejects_missing_next_on_non_terminal_kind():
    # `discover` is not terminal and has no branches -> needs `next`.
    stage = _stage_with_lifecycle(
        "orchestrator",
        [{"name": "find", "kind": "discover", "params": {"strategy": "unassigned_or_rework"}}],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [e for e in errors if e.get("code") == "lifecycle_step_missing_next"]
    assert matching, f"expected lifecycle_step_missing_next, got {errors!r}"


def test_validate_rejects_dangling_next_reference():
    stage = _stage_with_lifecycle(
        "orchestrator",
        [
            {
                "name": "find",
                "kind": "discover",
                "params": {"strategy": "unassigned_or_rework"},
                "next": "no_such_step",
            }
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e
        for e in errors
        if e.get("code") == "lifecycle_step_dangling_reference"
    ]
    assert matching, f"expected lifecycle_step_dangling_reference, got {errors!r}"


def test_validate_rejects_dangling_branch_reference():
    stage = _stage_with_lifecycle(
        "orchestrator",
        [
            {
                "name": "decide",
                "kind": "sensor",
                "params": {"name": "ci_status"},
                "branches": {"pass": "done", "fail": "missing"},
            },
            {
                "name": "done",
                "kind": "move_card",
                "params": {"to_column_type": "done"},
            },
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e
        for e in errors
        if e.get("code") == "lifecycle_step_dangling_reference"
        and "missing" in (e.get("message") or "")
    ]
    assert matching, f"expected dangling branch reference on 'missing', got {errors!r}"


def test_validate_rejects_dangling_on_failure_reference():
    stage = _stage_with_lifecycle(
        "orchestrator",
        [
            {
                "name": "implement",
                "kind": "llm",
                "params": {"stage": "implement", "provider": "claude-cli", "model": "sonnet"},
                "next": "ship",
                "on_failure": "ghost_handler",
            },
            {"name": "ship", "kind": "move_card", "params": {"to_column_type": "done"}},
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e
        for e in errors
        if e.get("code") == "lifecycle_step_dangling_reference"
        and "on_failure" in (e.get("field") or "")
    ]
    assert matching, f"expected on_failure dangling reference, got {errors!r}"


def test_validate_accepts_on_failure_pointing_to_real_step():
    stage = _stage_with_lifecycle(
        "orchestrator",
        [
            {
                "name": "implement",
                "kind": "llm",
                "params": {"stage": "implement", "provider": "claude-cli", "model": "sonnet"},
                "next": "ship",
                "on_failure": "cleanup",
            },
            {"name": "ship", "kind": "move_card", "params": {"to_column_type": "done"}},
            {
                "name": "cleanup",
                "kind": "mcp_call",
                "params": {"tool": "remove_card_participant", "args": {"user_id": "$self"}},
                "next": "ship",
            },
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    on_failure_errors = [
        e for e in errors if "on_failure" in (e.get("field") or "")
    ]
    assert on_failure_errors == [], (
        f"on_failure to a real step should validate clean, got {on_failure_errors!r}"
    )


def test_validate_rejects_both_next_and_branches_on_same_step():
    stage = _stage_with_lifecycle(
        "orchestrator",
        [
            {
                "name": "decide",
                "kind": "sensor",
                "params": {"name": "ci_status"},
                "next": "done",
                "branches": {"pass": "done"},
            },
            {"name": "done", "kind": "move_card", "params": {"to_column_type": "done"}},
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [e for e in errors if e.get("code") == "lifecycle_step_missing_next"]
    assert matching, (
        "exactly-one-of(next/branches/terminal) violation should surface as "
        f"lifecycle_step_missing_next, got {errors!r}"
    )


def test_validate_rejects_invalid_params_enum_value():
    stage = _stage_with_lifecycle(
        "orchestrator",
        [
            {
                "name": "ship",
                "kind": "move_card",
                "params": {"to_column_type": "nowhere"},
            }
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [e for e in errors if e.get("code") == "lifecycle_step_invalid_params"]
    assert matching, f"expected lifecycle_step_invalid_params, got {errors!r}"


def test_validate_rejects_invalid_params_type():
    stage = _stage_with_lifecycle(
        "orchestrator",
        [
            {
                "name": "branch_setup",
                "kind": "git_setup",
                "params": {"action": "create_branch", "create_pr": "yes"},
                "next": "ship",
            },
            {"name": "ship", "kind": "move_card", "params": {"to_column_type": "active"}},
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e
        for e in errors
        if e.get("code") == "lifecycle_step_invalid_params"
        and "create_pr" in (e.get("field") or "")
    ]
    assert matching, f"expected lifecycle_step_invalid_params on create_pr, got {errors!r}"


def test_validate_tolerates_unknown_param_keys_for_forward_compat():
    stage = _stage_with_lifecycle(
        "orchestrator",
        [
            {
                "name": "ship",
                "kind": "move_card",
                "params": {"to_column_type": "done", "future_knob": "whatever"},
            }
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    assert errors == [], (
        f"unknown param keys should pass for forward-compat, got {errors!r}"
    )


def test_validate_accepts_lifecycle_alongside_legacy_blocks():
    # Back-compat: a stage may carry both shapes during the migration window.
    stage = _stage_with_lifecycle(
        "orchestrator",
        [{"name": "ship", "kind": "move_card", "params": {"to_column_type": "active"}}],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    assert errors == [], (
        f"lifecycle + legacy blocks must coexist during migration, got {errors!r}"
    )


def test_validate_rejects_non_list_lifecycle():
    stage = _minimal_stage("orchestrator")
    stage["lifecycle"] = {"not": "a list"}
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [e for e in errors if e.get("code") == "lifecycle_step_unknown_kind"
                or e.get("code") == "lifecycle_step_name_collision"
                or e.get("code") == "lifecycle_step_invalid_params"
                or e.get("code") == "lifecycle_step_missing_next"
                or e.get("code") == "lifecycle_step_dangling_reference"]
    # Any lifecycle error is sufficient — the validator must not silently
    # accept a malformed shape.
    assert matching or any(
        "lifecycle" in (e.get("field") or "") for e in errors
    ), f"expected lifecycle shape error, got {errors!r}"


def test_validate_branch_step_with_branches_passes():
    stage = _stage_with_lifecycle(
        "orchestrator",
        [
            {
                "name": "route",
                "kind": "branch",
                "params": {"expression": "card.priority", "cases": {"urgent": "fast"}},
                "branches": {"urgent": "fast", "normal": "slow"},
            },
            {"name": "fast", "kind": "move_card", "params": {"to_column_type": "active"}},
            {"name": "slow", "kind": "move_card", "params": {"to_column_type": "backlog"}},
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    assert errors == [], f"expected no errors, got {errors!r}"


def test_validate_idempotent_on_repeated_call():
    stage = _stage_with_lifecycle(
        "orchestrator",
        [{"name": "ship", "kind": "move_card", "params": {"to_column_type": "active"}}],
    )
    config = {"stages": [stage]}

    first = validate_pipeline_config(config)
    second = validate_pipeline_config(config)
    assert first == second


# ---------------------------------------------------------------------------
# LIFECYCLE-FOLLOWUP-4: PR-lifecycle kinds (create_pr, enable_auto_merge,
# merge_pr, post_pr_review, ship). Empty/missing params are allowed (the
# runner applies defaults); enums are gated by the per-kind params_schema.
# ---------------------------------------------------------------------------


def test_validate_accepts_pr_lifecycle_chain():
    stage = _stage_with_lifecycle(
        "orchestrator",
        [
            {"name": "open_pr", "kind": "create_pr", "params": {}, "next": "arm"},
            {"name": "arm", "kind": "enable_auto_merge", "params": {}, "next": "land"},
            {"name": "land", "kind": "ship", "params": {"to_column_type": "review"}},
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    assert errors == [], f"expected no errors, got {errors!r}"


def test_validate_accepts_merge_pr_with_strategy():
    stage = _stage_with_lifecycle(
        "reviewer",
        [
            {"name": "merge", "kind": "merge_pr", "params": {"strategy": "squash"}, "next": "done"},
            {"name": "done", "kind": "move_card", "params": {"to_column_type": "done"}},
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    assert errors == [], f"expected no errors, got {errors!r}"


def test_validate_rejects_merge_pr_unknown_strategy():
    stage = _stage_with_lifecycle(
        "reviewer",
        [
            {"name": "merge", "kind": "merge_pr", "params": {"strategy": "fast-forward"}, "next": "done"},
            {"name": "done", "kind": "move_card", "params": {"to_column_type": "done"}},
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e
        for e in errors
        if e.get("code") == "lifecycle_step_invalid_params"
        and "strategy" in (e.get("field") or "")
    ]
    assert matching, f"expected strategy enum error, got {errors!r}"


def test_validate_rejects_enable_auto_merge_unknown_strategy():
    stage = _stage_with_lifecycle(
        "orchestrator",
        [
            {
                "name": "arm",
                "kind": "enable_auto_merge",
                "params": {"strategy": "ff-only"},
                "next": "ship",
            },
            {"name": "ship", "kind": "ship", "params": {}},
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e
        for e in errors
        if e.get("code") == "lifecycle_step_invalid_params"
        and "strategy" in (e.get("field") or "")
    ]
    assert matching, f"expected strategy enum error, got {errors!r}"


def test_validate_accepts_post_pr_review_with_decision():
    stage = _stage_with_lifecycle(
        "reviewer",
        [
            {
                "name": "post",
                "kind": "post_pr_review",
                "params": {"decision": "approve", "mode": "github"},
                "next": "done",
            },
            {"name": "done", "kind": "move_card", "params": {"to_column_type": "done"}},
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    assert errors == [], f"expected no errors, got {errors!r}"


def test_validate_rejects_post_pr_review_unknown_decision():
    stage = _stage_with_lifecycle(
        "reviewer",
        [
            {
                "name": "post",
                "kind": "post_pr_review",
                "params": {"decision": "merge_now"},
                "next": "done",
            },
            {"name": "done", "kind": "move_card", "params": {"to_column_type": "done"}},
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e
        for e in errors
        if e.get("code") == "lifecycle_step_invalid_params"
        and "decision" in (e.get("field") or "")
    ]
    assert matching, f"expected decision enum error, got {errors!r}"


def test_validate_rejects_post_pr_review_unknown_mode():
    stage = _stage_with_lifecycle(
        "reviewer",
        [
            {
                "name": "post",
                "kind": "post_pr_review",
                "params": {"mode": "slack"},
                "next": "done",
            },
            {"name": "done", "kind": "move_card", "params": {"to_column_type": "done"}},
        ],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e
        for e in errors
        if e.get("code") == "lifecycle_step_invalid_params"
        and "mode" in (e.get("field") or "")
    ]
    assert matching, f"expected mode enum error, got {errors!r}"


def test_validate_accepts_ship_with_default_target():
    stage = _stage_with_lifecycle(
        "orchestrator",
        [{"name": "land", "kind": "ship", "params": {}}],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    assert errors == [], f"expected no errors, got {errors!r}"


def test_validate_rejects_ship_unknown_target_column():
    stage = _stage_with_lifecycle(
        "orchestrator",
        [{"name": "land", "kind": "ship", "params": {"to_column_type": "atlantis"}}],
    )
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e
        for e in errors
        if e.get("code") == "lifecycle_step_invalid_params"
        and "to_column_type" in (e.get("field") or "")
    ]
    assert matching, f"expected to_column_type enum error, got {errors!r}"


# ---------------------------------------------------------------------------
# Phase 2: new discover-filter primitives + closed-set key check
# ---------------------------------------------------------------------------


def _stage_with_discover_filters(role: str, filters: dict) -> dict:
    stage = _minimal_stage(role)
    stage["discover"] = {
        "strategy": "column_scan",
        "column_type": "active",
        "filters": filters,
    }
    return stage


def test_validate_accepts_skip_if_pipeline_role():
    config = {"stages": [_stage_with_discover_filters(
        "reviewer", {"skip_if_pipeline_role": "reviewer"}
    )]}
    errors = validate_pipeline_config(config)
    assert errors == [], f"expected no errors, got {errors!r}"


def test_validate_accepts_require_note_kind_with_known_kind():
    config = {"stages": [_stage_with_discover_filters(
        "rework_mediator", {"require_note_kind": "review_verdict"}
    )]}
    errors = validate_pipeline_config(config)
    assert errors == [], f"expected no errors, got {errors!r}"


def test_validate_rejects_require_note_kind_with_unknown_kind():
    config = {"stages": [_stage_with_discover_filters(
        "rework_mediator", {"require_note_kind": "totally_made_up"}
    )]}
    errors = validate_pipeline_config(config)
    matching = [
        e for e in errors if e.get("code") == "unknown_note_kind_filter"
    ]
    assert matching, f"expected unknown_note_kind_filter, got {errors!r}"


def test_validate_accepts_require_note_failure_class_and_require_label():
    config = {"stages": [_stage_with_discover_filters(
        "rework_mediator",
        {
            "require_note_kind": "review_verdict",
            "require_note_failure_class": "needs_rework",
            "require_label": "needs-rework",
        },
    )]}
    errors = validate_pipeline_config(config)
    assert errors == [], f"expected no errors, got {errors!r}"


def test_validate_accepts_require_note_kind_newer_than():
    """Cluster II Gap 2: the note-freshness filter validates with known kinds."""
    config = {"stages": [_stage_with_discover_filters(
        "rework_mediator",
        {"require_note_kind_newer_than": {
            "kind": "review_verdict", "than_kind": "rework_brief",
        }},
    )]}
    errors = validate_pipeline_config(config)
    assert errors == [], f"expected no errors, got {errors!r}"


def test_validate_rejects_require_note_kind_newer_than_unknown_kind():
    config = {"stages": [_stage_with_discover_filters(
        "rework_mediator",
        {"require_note_kind_newer_than": {
            "kind": "made_up", "than_kind": "rework_brief",
        }},
    )]}
    errors = validate_pipeline_config(config)
    matching = [
        e for e in errors if e.get("code") == "invalid_note_freshness_filter"
    ]
    assert matching, f"expected invalid_note_freshness_filter, got {errors!r}"


def test_validate_rejects_require_note_kind_newer_than_missing_than_kind():
    config = {"stages": [_stage_with_discover_filters(
        "rework_mediator",
        {"require_note_kind_newer_than": {"kind": "review_verdict"}},
    )]}
    errors = validate_pipeline_config(config)
    matching = [
        e for e in errors if e.get("code") == "invalid_note_freshness_filter"
    ]
    assert matching, f"expected invalid_note_freshness_filter, got {errors!r}"


def test_validate_accepts_list_valued_label_filters():
    """Cluster II Gap 3: exclude/include/require/label accept a list of strings."""
    config = {"stages": [_stage_with_discover_filters(
        "reviewer",
        {
            "exclude_label": ["planned", "needs-ui-validation"],
            "include_label": ["ui"],
            "require_label": ["a", "b"],
            "label": ["x"],
        },
    )]}
    errors = validate_pipeline_config(config)
    assert errors == [], f"expected no errors, got {errors!r}"


def test_validate_rejects_label_filter_list_with_non_string_entry():
    """A list label filter must contain only strings; a stray non-string
    surfaces at save time rather than silently never matching."""
    config = {"stages": [_stage_with_discover_filters(
        "reviewer", {"exclude_label": ["planned", 123]}
    )]}
    errors = validate_pipeline_config(config)
    matching = [
        e for e in errors if e.get("code") == "invalid_label_filter"
    ]
    assert matching, f"expected invalid_label_filter, got {errors!r}"


def test_validate_rejects_label_filter_wrong_type():
    """exclude_label must be a string or a list — not a dict/number."""
    config = {"stages": [_stage_with_discover_filters(
        "reviewer", {"exclude_label": {"nope": 1}}
    )]}
    errors = validate_pipeline_config(config)
    matching = [
        e for e in errors if e.get("code") == "invalid_label_filter"
    ]
    assert matching, f"expected invalid_label_filter, got {errors!r}"


def test_validate_rejects_unknown_discover_filter_key():
    """A typo in a filter name (e.g. skip_if_partcipant_role) used to be
    silently disabled. The closed-set check surfaces it."""
    config = {"stages": [_stage_with_discover_filters(
        "reviewer", {"skip_if_partcipant_role": "reviewer"}
    )]}
    errors = validate_pipeline_config(config)
    matching = [
        e for e in errors if e.get("code") == "unknown_discover_filter_key"
    ]
    assert matching, f"expected unknown_discover_filter_key, got {errors!r}"


def test_validate_accepts_column_id_filter_as_string():
    """Wave gating: a role can be pinned to one column sharing a column_type
    with its siblings (e.g. To Do vs Backlog, both column_type=backlog)."""
    config = {"stages": [_stage_with_discover_filters(
        "implementer", {"column_id": "51917a44-ced4-4757-a178-3cf819424464"}
    )]}
    errors = validate_pipeline_config(config)
    assert errors == [], f"expected no errors, got {errors!r}"


def test_validate_accepts_column_id_filter_as_list():
    """List form unions the columns."""
    config = {"stages": [_stage_with_discover_filters(
        "implementer",
        {"column_id": [
            "51917a44-ced4-4757-a178-3cf819424464",
            "ffd9dc49-86f7-4916-ab09-84b32f465158",
        ]},
    )]}
    errors = validate_pipeline_config(config)
    assert errors == [], f"expected no errors, got {errors!r}"


def test_validate_rejects_column_id_filter_non_uuid_string():
    """A column NAME (the operator's likely first guess) is not a column id."""
    config = {"stages": [_stage_with_discover_filters(
        "implementer", {"column_id": "To Do"}
    )]}
    errors = validate_pipeline_config(config)
    matching = [
        e for e in errors
        if e.get("code") == "invalid_column_id_filter"
        and e.get("field", "").endswith(".filters.column_id")
    ]
    assert matching, f"expected invalid_column_id_filter, got {errors!r}"


def test_validate_rejects_column_id_filter_list_with_non_uuid_entry():
    config = {"stages": [_stage_with_discover_filters(
        "implementer",
        {"column_id": ["51917a44-ced4-4757-a178-3cf819424464", "nope"]},
    )]}
    errors = validate_pipeline_config(config)
    matching = [
        e for e in errors if e.get("code") == "invalid_column_id_filter"
    ]
    assert matching, f"expected invalid_column_id_filter, got {errors!r}"


def test_validate_rejects_column_id_filter_wrong_type():
    config = {"stages": [_stage_with_discover_filters(
        "implementer", {"column_id": {"id": 1}}
    )]}
    errors = validate_pipeline_config(config)
    matching = [
        e for e in errors if e.get("code") == "invalid_column_id_filter"
    ]
    assert matching, f"expected invalid_column_id_filter, got {errors!r}"


def test_validate_accepts_require_pipeline_role():
    """BUG ab0f39e4: validator must accept the symmetric `require_pipeline_role`
    counterpart of `skip_if_pipeline_role`. Pinned so a future cleanup of the
    closed set doesn't quietly drop the scheduler consumer."""
    config = {"stages": [_stage_with_discover_filters(
        "implementer", {"require_pipeline_role": "planner"}
    )]}
    errors = validate_pipeline_config(config)
    assert errors == [], f"expected no errors, got {errors!r}"


def test_validate_accepts_require_participant_role():
    config = {"stages": [_stage_with_discover_filters(
        "implementer", {"require_participant_role": "hero"}
    )]}
    errors = validate_pipeline_config(config)
    assert errors == [], f"expected no errors, got {errors!r}"


# ---------------------------------------------------------------------------
# SCH-1: sequential-scheduling primitives. Validator accepts the two new keys;
# scheduler consumers land in the same card. Spec note 233e4429 §Part B.
# ---------------------------------------------------------------------------


def test_validate_accepts_no_other_card_in_flight_filter():
    config = {"stages": [_stage_with_discover_filters(
        "planner", {"no_other_card_in_flight": True}
    )]}
    errors = validate_pipeline_config(config)
    assert errors == [], f"expected no errors, got {errors!r}"


def test_validate_accepts_all_dependencies_done_filter():
    config = {"stages": [_stage_with_discover_filters(
        "planner", {"all_dependencies_done": True}
    )]}
    errors = validate_pipeline_config(config)
    assert errors == [], f"expected no errors, got {errors!r}"


def test_validate_accepts_both_sequential_filters_together():
    config = {"stages": [_stage_with_discover_filters(
        "planner",
        {"no_other_card_in_flight": True, "all_dependencies_done": True},
    )]}
    errors = validate_pipeline_config(config)
    assert errors == [], f"expected no errors, got {errors!r}"


# ---------------------------------------------------------------------------
# Phase 5: decision-branch terminal-move check (FOLLOWUP-13 guard)
# ---------------------------------------------------------------------------


def test_validate_warns_when_decision_branch_terminates_without_move_or_wake():
    """A request_changes branch that ends in apply_label -> end without a
    wake_role upstream raises the FOLLOWUP-13 warning."""
    stage = _stage_with_lifecycle(
        "reviewer",
        [
            {
                "name": "decide",
                "kind": "sensor",
                "params": {"name": "ci_status"},
                "branches": {"pass": "good_label", "fail": "bad_label"},
            },
            {
                "name": "good_label",
                "kind": "apply_label",
                "params": {"label": "ci-green"},
                "next": "good_end",
            },
            {"name": "good_end", "kind": "end", "params": {}},
            {
                "name": "bad_label",
                "kind": "apply_label",
                "params": {"label": "ci-red"},
                "next": "bad_end",
            },
            {"name": "bad_end", "kind": "end", "params": {}},
        ],
    )
    config = {"stages": [stage]}

    findings = validate_pipeline_config(config)
    warnings = [
        f for f in findings
        if f.get("code") == "lifecycle_decision_branch_missing_terminal_move"
        and f.get("severity") == "warning"
    ]
    assert warnings, f"expected terminal-move warning, got {findings!r}"


def test_validate_passes_when_decision_branch_ends_in_move_card():
    stage = _stage_with_lifecycle(
        "reviewer",
        [
            {
                "name": "decide",
                "kind": "sensor",
                "params": {"name": "ci_status"},
                "branches": {"pass": "move_done", "fail": "move_back"},
            },
            {
                "name": "move_done",
                "kind": "move_card",
                "params": {"to_column_type": "done"},
            },
            {
                "name": "move_back",
                "kind": "move_card",
                "params": {"to_column_type": "active"},
            },
        ],
    )
    config = {"stages": [stage]}

    findings = validate_pipeline_config(config)
    relevant = [
        f for f in findings
        if f.get("code") == "lifecycle_decision_branch_missing_terminal_move"
    ]
    assert not relevant, f"expected no terminal-move findings, got {findings!r}"


def test_validate_passes_when_decision_branch_has_wake_role_then_label():
    """wake_role signals an intentional handoff to another role; the trailing
    apply_label is accepted as a deliberate label-only termination."""
    stage = _stage_with_lifecycle(
        "reviewer",
        [
            {
                "name": "decide",
                "kind": "sensor",
                "params": {"name": "ci_status"},
                "branches": {"pass": "wake", "fail": "label_fail"},
            },
            {
                "name": "wake",
                "kind": "wake_role",
                "params": {"roles": ["documentator"]},
                "next": "label_ok",
            },
            {
                "name": "label_ok",
                "kind": "apply_label",
                "params": {"label": "approved"},
                "next": "end_ok",
            },
            {"name": "end_ok", "kind": "end", "params": {}},
            {
                "name": "label_fail",
                "kind": "move_card",
                "params": {"to_column_type": "active"},
            },
        ],
    )
    config = {"stages": [stage]}

    findings = validate_pipeline_config(config)
    relevant = [
        f for f in findings
        if f.get("code") == "lifecycle_decision_branch_missing_terminal_move"
    ]
    assert not relevant, f"expected no warnings, got {findings!r}"


def test_validate_errors_when_decision_branch_loops_with_no_terminal():
    """An infinite loop with no terminal kind reachable is a hard error."""
    stage = _stage_with_lifecycle(
        "reviewer",
        [
            {
                "name": "decide",
                "kind": "sensor",
                "params": {"name": "ci_status"},
                "branches": {"pass": "loop_a", "fail": "loop_a"},
            },
            {
                "name": "loop_a",
                "kind": "mcp_call",
                "params": {"tool": "noop", "args": {}},
                "next": "loop_b",
            },
            {
                "name": "loop_b",
                "kind": "mcp_call",
                "params": {"tool": "noop", "args": {}},
                "next": "loop_a",
            },
        ],
    )
    config = {"stages": [stage]}

    findings = validate_pipeline_config(config)
    errors = [
        f for f in findings
        if f.get("code") == "lifecycle_decision_branch_no_terminal"
        and f.get("severity") == "error"
    ]
    assert errors, f"expected loop error, got {findings!r}"


def test_validate_default_pipeline_config_no_followup_13_warning():
    """The reviewer's request_changes branch terminates with
    move_card(to_column_type='active'), so the FOLLOWUP-13 guard must NOT fire
    on the non-auditor stages of the shipped default.

    Two stages are deliberate auditor exceptions whose branches intentionally
    leave the card idle (the FOLLOWUP-13 warning is correct but expected):
      - ui_validator (stage 5): audits a card already in `done` (a pass labels
        `ui-validated`, a fail files separate fix cards).
      - board_reconciler (stage 6) `park` branch ONLY: a card it cannot dispose
        autonomously is parked with `blocked` for a human — it MUST sit idle by
        design. Its other branches (supersede→done, no_action/repair→wake
        implementer) move/handoff correctly and must still be guarded.
    """
    from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG
    import copy

    # board_reconciler's `park` branch is an intentional human-park terminal —
    # exempt that branch specifically, not the whole stage.
    _INTENTIONAL_IDLE_FIELDS = {
        "stages[6].lifecycle[2].branches.park",
    }
    findings = validate_pipeline_config(copy.deepcopy(DEFAULT_PIPELINE_CONFIG))
    non_auditor_warnings = [
        f for f in findings
        if f.get("code") == "lifecycle_decision_branch_missing_terminal_move"
        and not (f.get("field") or "").startswith("stages[5]")  # ui_validator
        and (f.get("field") or "") not in _INTENTIONAL_IDLE_FIELDS
    ]
    assert non_auditor_warnings == [], (
        f"non-auditor stages must not trigger FOLLOWUP-13 warning, "
        f"got {non_auditor_warnings!r}"
    )


# ---------------------------------------------------------------------------
# Phase 6: claim step must populate pipeline_role
# ---------------------------------------------------------------------------


def test_validate_warns_on_claim_without_pipeline_role():
    """Legacy claims that only set participant_role get a deprecation warning."""
    stage = _stage_with_lifecycle(
        "implementer",
        [
            {
                "name": "do_claim",
                "kind": "claim",
                "params": {
                    "participant_role": "hero",
                    "execution_action": "implement_card",
                },
                "next": "done",
            },
            {
                "name": "done",
                "kind": "move_card",
                "params": {"to_column_type": "done"},
            },
        ],
    )
    config = {"stages": [stage]}

    findings = validate_pipeline_config(config)
    warnings = [
        f for f in findings
        if f.get("code") == "claim_missing_pipeline_role"
        and f.get("severity") == "warning"
    ]
    assert warnings, f"expected claim_missing_pipeline_role warning, got {findings!r}"


def test_validate_passes_when_claim_sets_pipeline_role():
    stage = _stage_with_lifecycle(
        "implementer",
        [
            {
                "name": "do_claim",
                "kind": "claim",
                "params": {
                    "participant_role": "hero",
                    "execution_action": "implement_card",
                    "pipeline_role": "implementer",
                },
                "next": "done",
            },
            {
                "name": "done",
                "kind": "move_card",
                "params": {"to_column_type": "done"},
            },
        ],
    )
    config = {"stages": [stage]}

    findings = validate_pipeline_config(config)
    relevant = [
        f for f in findings
        if f.get("code") == "claim_missing_pipeline_role"
    ]
    assert not relevant, f"expected no claim warnings, got {findings!r}"


def test_validate_default_pipeline_config_no_claim_missing_pipeline_role_warnings():
    """Post-redesign: every claim step in the shipped default populates
    pipeline_role. Inversion of the pre-redesign assertion — regression net
    against silently regressing F-14 fix.
    """
    from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG
    import copy

    findings = validate_pipeline_config(copy.deepcopy(DEFAULT_PIPELINE_CONFIG))
    warnings = [
        f for f in findings
        if f.get("code") == "claim_missing_pipeline_role"
    ]
    assert warnings == [], (
        f"every DEFAULT claim step must populate pipeline_role; "
        f"got warnings {warnings!r}"
    )


# ---------------------------------------------------------------------------
# produces_decision step with branches but no on_failure fallback
#
# When an llm/sensor/branch step emits no parseable decision at runtime, the
# runner now routes to on_failure. Without one the tick hard-fails and retries.
# Warn (not error) so the live review_diff — which has branches and no
# on_failure today — keeps saving.
# ---------------------------------------------------------------------------


def test_validate_warns_on_decision_step_branches_without_on_failure():
    stage = _stage_with_lifecycle(
        "reviewer",
        [
            {
                "name": "review_diff",
                "kind": "llm",
                "params": {"post_process_kind": "produces_decision"},
                "branches": {"approve": "ship", "request_changes": "reject"},
            },
            {"name": "ship", "kind": "move_card", "params": {"to_column_type": "done"}},
            {"name": "reject", "kind": "apply_label", "params": {"label": "rework"}, "next": "stop"},
            {"name": "stop", "kind": "end"},
        ],
    )
    config = {"stages": [stage]}

    findings = validate_pipeline_config(config)
    warnings = [
        f for f in findings
        if f.get("code") == "produces_decision_no_failure_fallback"
        and f.get("severity") == "warning"
    ]
    assert warnings, (
        f"expected produces_decision_no_failure_fallback warning, got {findings!r}"
    )


def test_validate_no_warning_when_decision_step_declares_on_failure():
    stage = _stage_with_lifecycle(
        "reviewer",
        [
            {
                "name": "review_diff",
                "kind": "llm",
                "params": {"post_process_kind": "produces_decision"},
                "branches": {"approve": "ship", "request_changes": "reject"},
                "on_failure": "stop",
            },
            {"name": "ship", "kind": "move_card", "params": {"to_column_type": "done"}},
            {"name": "reject", "kind": "apply_label", "params": {"label": "rework"}, "next": "stop"},
            {"name": "stop", "kind": "end"},
        ],
    )
    config = {"stages": [stage]}

    findings = validate_pipeline_config(config)
    relevant = [
        f for f in findings
        if f.get("code") == "produces_decision_no_failure_fallback"
    ]
    assert not relevant, f"expected no fallback warning, got {findings!r}"


# ---------------------------------------------------------------------------
# Phase 4: create_note params validation (LLM-lifecycle contract)
#
# Runner owns note-writing; the LLM only emits the body. `kind` is required,
# `body_from` is an enum, `failure_class` is optional, and the legacy
# `from_llm_output` flag is hard-rejected with a migration hint so operators
# can't silently keep deploying the old shape.
# ---------------------------------------------------------------------------


def _stage_with_create_note(role: str, params: dict) -> dict:
    stage = _minimal_stage(role)
    stage["lifecycle"] = [
        {"name": "write", "kind": "create_note", "params": params},
    ]
    return stage


def test_validate_create_note_requires_kind():
    config = {"stages": [_stage_with_create_note("reviewer", {"body_from": "findings"})]}
    errors = validate_pipeline_config(config)
    matching = [
        e for e in errors
        if e.get("code") == "create_note_missing_kind"
        or (
            e.get("code") == "lifecycle_step_invalid_params"
            and "kind" in (e.get("field") or "")
        )
    ]
    assert matching, f"expected required-kind error on create_note, got {errors!r}"


def test_validate_create_note_rejects_from_llm_output_with_migration_hint():
    config = {"stages": [_stage_with_create_note(
        "reviewer",
        {"kind": "review_verdict", "from_llm_output": True},
    )]}
    errors = validate_pipeline_config(config)
    matching = [
        e for e in errors
        if e.get("code") == "create_note_from_llm_output_removed"
    ]
    assert matching, (
        f"expected create_note_from_llm_output_removed error, got {errors!r}"
    )
    # Migration hint must name the replacement key so operators can self-serve.
    msg = matching[0].get("message", "")
    assert "body_from" in msg, (
        f"migration message must point at body_from, got {msg!r}"
    )


def test_validate_create_note_rejects_unknown_body_from():
    config = {"stages": [_stage_with_create_note(
        "reviewer",
        {"kind": "review_verdict", "body_from": "narrative"},
    )]}
    errors = validate_pipeline_config(config)
    matching = [
        e for e in errors
        if e.get("code") == "lifecycle_step_invalid_params"
        and "body_from" in (e.get("field") or "")
    ]
    assert matching, f"expected body_from enum error, got {errors!r}"


def test_validate_create_note_accepts_failure_class():
    config = {"stages": [_stage_with_create_note(
        "reviewer",
        {
            "kind": "review_verdict",
            "body_from": "findings",
            "failure_class": "needs_rework",
        },
    )]}
    errors = validate_pipeline_config(config)
    relevant = [
        e for e in errors
        if e.get("code", "").startswith("create_note_")
        or (
            e.get("code") == "lifecycle_step_invalid_params"
            and "create_note" in (e.get("field") or "")
        )
    ]
    assert relevant == [], (
        f"create_note with failure_class must pass validation, got {errors!r}"
    )


def test_validate_default_pipeline_config_passes():
    """Round-trip the shipped default through the validator — Phase 4 keeps
    the regression net that every change to DEFAULT_PIPELINE_CONFIG must
    leave the config valid (errors only; warnings are informational).
    """
    from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG
    import copy

    findings = validate_pipeline_config(copy.deepcopy(DEFAULT_PIPELINE_CONFIG))
    blocking = [f for f in findings if f.get("severity", "error") == "error"]
    assert blocking == [], (
        f"DEFAULT_PIPELINE_CONFIG must validate without errors, got {blocking!r}"
    )


# ---------------------------------------------------------------------------
# CTX-7: dependency_health / linked_cards / execution_history / card_activity
# ---------------------------------------------------------------------------


def test_validate_accepts_dependency_aware_context_source_kinds():
    stage = _stage_with_context_sources(
        "implementer",
        [
            {"kind": "dependency_health"},
            {"kind": "linked_cards"},
            {"kind": "execution_history"},
            {"kind": "card_activity"},
        ],
    )
    errors = validate_pipeline_config({"stages": [stage]})
    assert errors == [], f"expected no errors, got {errors!r}"


def test_dependency_health_rejects_filter():
    stage = _stage_with_context_sources(
        "implementer",
        [{"kind": "dependency_health", "filter": {"limit": 5}}],
    )
    errors = validate_pipeline_config({"stages": [stage]})
    assert any(
        e.get("code") == "dependency_health_filter_not_supported" for e in errors
    ), f"expected dependency_health_filter_not_supported, got {errors!r}"


def test_linked_cards_accepts_direction_and_limit():
    for direction in ("depends_on", "blocks", "both"):
        stage = _stage_with_context_sources(
            "implementer",
            [{"kind": "linked_cards", "filter": {"direction": direction, "limit": 10}}],
        )
        errors = validate_pipeline_config({"stages": [stage]})
        assert errors == [], f"{direction}: expected no errors, got {errors!r}"


def test_linked_cards_rejects_unknown_direction():
    stage = _stage_with_context_sources(
        "implementer",
        [{"kind": "linked_cards", "filter": {"direction": "sideways"}}],
    )
    errors = validate_pipeline_config({"stages": [stage]})
    assert any(
        e.get("code") == "invalid_linked_cards_filter"
        and "direction" in (e.get("field") or "")
        for e in errors
    ), f"expected invalid_linked_cards_filter direction error, got {errors!r}"


def test_linked_cards_rejects_limit_over_50():
    stage = _stage_with_context_sources(
        "implementer",
        [{"kind": "linked_cards", "filter": {"limit": 51}}],
    )
    errors = validate_pipeline_config({"stages": [stage]})
    assert any(
        e.get("code") == "invalid_linked_cards_filter"
        and "limit" in (e.get("field") or "")
        for e in errors
    ), f"expected invalid_linked_cards_filter limit error, got {errors!r}"


def test_execution_history_accepts_status_filter():
    stage = _stage_with_context_sources(
        "rework_mediator",
        [{"kind": "execution_history", "filter": {"status": "failed", "limit": 5}}],
    )
    errors = validate_pipeline_config({"stages": [stage]})
    assert errors == [], f"expected no errors, got {errors!r}"


def test_execution_history_rejects_unknown_status():
    stage = _stage_with_context_sources(
        "rework_mediator",
        [{"kind": "execution_history", "filter": {"status": "exploded"}}],
    )
    errors = validate_pipeline_config({"stages": [stage]})
    assert any(
        e.get("code") == "invalid_execution_history_filter"
        and "status" in (e.get("field") or "")
        for e in errors
    ), f"expected invalid_execution_history_filter status error, got {errors!r}"


def test_card_activity_accepts_limit_filter():
    stage = _stage_with_context_sources(
        "implementer",
        [{"kind": "card_activity", "filter": {"limit": 25}}],
    )
    errors = validate_pipeline_config({"stages": [stage]})
    assert errors == [], f"expected no errors, got {errors!r}"


def test_card_activity_rejects_limit_below_one():
    stage = _stage_with_context_sources(
        "implementer",
        [{"kind": "card_activity", "filter": {"limit": 0}}],
    )
    errors = validate_pipeline_config({"stages": [stage]})
    assert any(
        e.get("code") == "invalid_card_activity_filter"
        and "limit" in (e.get("field") or "")
        for e in errors
    ), f"expected invalid_card_activity_filter limit error, got {errors!r}"


# pipeline_expectations: renders the role's own stage config (default) or the
# whole-pipeline map (scope=all_roles). Optional `{scope}` filter only.


def test_pipeline_expectations_accepts_no_filter():
    stage = _stage_with_context_sources(
        "reviewer",
        [{"kind": "pipeline_expectations"}],
    )
    errors = validate_pipeline_config({"stages": [stage]})
    assert errors == [], f"expected no errors, got {errors!r}"


def test_pipeline_expectations_accepts_scope_values():
    for scope in ("current_role", "all_roles"):
        stage = _stage_with_context_sources(
            "reviewer",
            [{"kind": "pipeline_expectations", "filter": {"scope": scope}}],
        )
        errors = validate_pipeline_config({"stages": [stage]})
        assert errors == [], f"{scope}: expected no errors, got {errors!r}"


def test_pipeline_expectations_rejects_unknown_scope():
    stage = _stage_with_context_sources(
        "reviewer",
        [{"kind": "pipeline_expectations", "filter": {"scope": "galaxy"}}],
    )
    errors = validate_pipeline_config({"stages": [stage]})
    assert any(
        e.get("code") == "invalid_pipeline_expectations_filter"
        and "scope" in (e.get("field") or "")
        for e in errors
    ), f"expected invalid_pipeline_expectations_filter scope error, got {errors!r}"


def test_pipeline_expectations_rejects_unknown_filter_key():
    stage = _stage_with_context_sources(
        "reviewer",
        [{"kind": "pipeline_expectations", "filter": {"limit": 5}}],
    )
    errors = validate_pipeline_config({"stages": [stage]})
    assert any(
        e.get("code") == "invalid_pipeline_expectations_filter" for e in errors
    ), f"expected invalid_pipeline_expectations_filter, got {errors!r}"


# ---------------------------------------------------------------------------
# tool_policy: per-stage LLM tool deny-list (backend-authoritative). Carried
# opaquely (claude-CLI tool/Bash-pattern strings) and surfaced in the
# /next-assignment payload. The validator only enforces shape: `deny` must be a
# list of strings; absent/empty is valid; unknown stages without it are fine.
# ---------------------------------------------------------------------------


def test_validate_accepts_llm_tool_policy_deny_list():
    stage = _minimal_stage("implementer")
    stage["llm"] = {
        "enabled": True,
        "stage": "implement",
        "tool_policy": {"deny": ["Bash(gh pr merge:*)", "Bash(git reset --hard:*)"]},
    }
    errors = validate_pipeline_config({"stages": [stage]})
    assert errors == [], f"expected no errors, got {errors!r}"


def test_validate_accepts_absent_tool_policy():
    stage = _minimal_stage("implementer")
    stage["llm"] = {"enabled": True, "stage": "implement"}
    errors = validate_pipeline_config({"stages": [stage]})
    assert errors == [], f"expected no errors, got {errors!r}"


def test_validate_accepts_empty_tool_policy_deny():
    stage = _minimal_stage("implementer")
    stage["llm"] = {"enabled": True, "stage": "implement", "tool_policy": {"deny": []}}
    errors = validate_pipeline_config({"stages": [stage]})
    assert errors == [], f"expected no errors, got {errors!r}"


def test_validate_rejects_tool_policy_deny_not_a_list():
    stage = _minimal_stage("implementer")
    stage["llm"] = {
        "enabled": True,
        "stage": "implement",
        "tool_policy": {"deny": "Bash(gh pr merge:*)"},
    }
    errors = validate_pipeline_config({"stages": [stage]})
    matching = [
        e for e in errors
        if e.get("code") == "invalid_tool_policy"
        and e.get("field") == "stages[0].llm.tool_policy.deny"
    ]
    assert matching, f"expected invalid_tool_policy error, got {errors!r}"


def test_validate_rejects_tool_policy_deny_non_string_entries():
    stage = _minimal_stage("implementer")
    stage["llm"] = {
        "enabled": True,
        "stage": "implement",
        "tool_policy": {"deny": ["Bash(gh pr merge:*)", 7]},
    }
    errors = validate_pipeline_config({"stages": [stage]})
    matching = [
        e for e in errors if e.get("code") == "invalid_tool_policy"
    ]
    assert matching, f"expected invalid_tool_policy error, got {errors!r}"


def test_validate_rejects_tool_policy_not_an_object():
    stage = _minimal_stage("implementer")
    stage["llm"] = {
        "enabled": True,
        "stage": "implement",
        "tool_policy": ["Bash(gh pr merge:*)"],
    }
    errors = validate_pipeline_config({"stages": [stage]})
    matching = [
        e for e in errors
        if e.get("code") == "invalid_tool_policy"
        and e.get("field") == "stages[0].llm.tool_policy"
    ]
    assert matching, f"expected invalid_tool_policy error, got {errors!r}"


# ---------------------------------------------------------------------------
# Card e019244b: unknown llm model tier rejected at save time (both the flat
# stage.llm block and the lifecycle llm-step params carry a model field).
# ---------------------------------------------------------------------------


def _stage_with_flat_model(role: str, model: str) -> dict:
    stage = _minimal_stage(role)
    stage["llm"] = {"enabled": True, "stage": "implement", "model": model}
    return stage


def _llm_lifecycle(model: str) -> list[dict]:
    return [
        {
            "name": "run_llm",
            "kind": "llm",
            "params": {"stage": "implement", "model": model},
            "next": "finish",
        },
        {"name": "finish", "kind": "end", "params": {}},
    ]


def test_validate_rejects_unknown_tier_in_flat_llm_model():
    config = {"stages": [_stage_with_flat_model("implementer", "high")]}

    errors = validate_pipeline_config(config)

    matching = [
        e for e in errors
        if e.get("code") == "unknown_llm_model_tier"
        and e.get("field") == "stages[0].llm.model"
        and e.get("severity") == "error"
    ]
    assert matching, f"expected unknown_llm_model_tier error, got {errors!r}"
    assert "high" in matching[0]["message"]
    assert "premium" in matching[0]["message"]


def test_validate_rejects_unknown_tier_in_lifecycle_llm_model():
    stage = _stage_with_lifecycle("implementer", _llm_lifecycle("high"))
    config = {"stages": [stage]}

    errors = validate_pipeline_config(config)

    matching = [
        e for e in errors
        if e.get("code") == "unknown_llm_model_tier"
        and e.get("field") == "stages[0].lifecycle[0].params.model"
    ]
    assert matching, f"expected unknown_llm_model_tier error, got {errors!r}"


def test_validate_accepts_known_tiers_literals_and_concrete_ids():
    for ok in ("premium", "mid", "low", "opus", "sonnet", "haiku", "claude-opus-4", ""):
        stage = _stage_with_flat_model("implementer", ok)
        stage["lifecycle"] = _llm_lifecycle(ok)
        errors = validate_pipeline_config({"stages": [stage]})
        tier_errors = [e for e in errors if e.get("code") == "unknown_llm_model_tier"]
        assert tier_errors == [], f"model {ok!r} must validate, got {tier_errors!r}"


# ---------------------------------------------------------------------------
# Card b8024b15 (write side): canonicalize mirrors the lifecycle llm-step
# params (frontend-authored, dispatch-authoritative) into the flat stage.llm
# block so the two representations can't persist divergent values.
# ---------------------------------------------------------------------------


def test_canonicalize_mirrors_lifecycle_llm_model_and_provider_into_flat():
    stage = _minimal_stage("implementer")
    stage["llm"] = {"enabled": True, "stage": "implement", "provider": "claude-cli", "model": "mid"}
    stage["lifecycle"] = [
        {
            "name": "run_llm",
            "kind": "llm",
            "params": {"stage": "implement", "provider": "other-cli", "model": "premium"},
            "next": "finish",
        },
        {"name": "finish", "kind": "end", "params": {}},
    ]
    config = {"stages": [stage]}

    canonicalize_pipeline_config(config)

    assert stage["llm"]["model"] == "premium"
    assert stage["llm"]["provider"] == "other-cli"


def test_canonicalize_mirror_noop_without_lifecycle_llm_step():
    stage = _minimal_stage("implementer")
    stage["llm"] = {"enabled": True, "stage": "implement", "model": "mid"}
    stage["lifecycle"] = [{"name": "finish", "kind": "end", "params": {}}]
    config = {"stages": [stage]}

    canonicalize_pipeline_config(config)

    assert stage["llm"]["model"] == "mid"


def test_canonicalize_mirror_skips_empty_lifecycle_values():
    """Empty lifecycle params must not clobber a non-empty flat default."""
    stage = _minimal_stage("implementer")
    stage["llm"] = {"enabled": True, "stage": "implement", "provider": "claude-cli", "model": "mid"}
    stage["lifecycle"] = [
        {
            "name": "run_llm",
            "kind": "llm",
            "params": {"stage": "implement", "provider": "", "model": ""},
            "next": "finish",
        },
        {"name": "finish", "kind": "end", "params": {}},
    ]
    config = {"stages": [stage]}

    canonicalize_pipeline_config(config)

    assert stage["llm"]["model"] == "mid"
    assert stage["llm"]["provider"] == "claude-cli"


def test_canonicalize_mirror_is_idempotent():
    stage = _minimal_stage("implementer")
    stage["llm"] = {"enabled": True, "stage": "implement", "model": "mid"}
    stage["lifecycle"] = [
        {
            "name": "run_llm",
            "kind": "llm",
            "params": {"stage": "implement", "model": "premium"},
            "next": "finish",
        },
        {"name": "finish", "kind": "end", "params": {}},
    ]
    config = {"stages": [stage]}

    canonicalize_pipeline_config(config)
    first_pass = copy.deepcopy(config)
    canonicalize_pipeline_config(config)

    assert config == first_pass


def test_validate_accepts_allow_self_participant():
    """`allow_self_participant` opts a review-kind stage out of the runner's
    defaulted self-participation guard (card f11f32dc). It must live in the
    closed key set or the whole config fails to save."""
    config = {"stages": [_stage_with_discover_filters(
        "security_auditor", {"allow_self_participant": True}
    )]}
    errors = validate_pipeline_config(config)
    assert errors == [], f"expected no errors, got {errors!r}"
