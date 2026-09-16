# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Unit tests for the demo-double-llm converter (Phase 5).

The converter is a pure function — these tests exercise it with the platform
DEFAULT_PIPELINE_CONFIG (the same shape the `demo-workspace` slug inherits today) and never
touch the DB. The DB-writing script
`backend/scripts/apply_demo_double_llm.py` is a thin OCC-versioned
shim around this converter.

Demonstration goal: split the planner role's single `kind: llm` step into TWO
consecutive `kind: llm` steps (`scope_llm` -> `plan_llm`) so the new
lifecycle-builder UI's per-step prompt rows have something non-trivial to
render. Every other role is left byte-identical.
"""

from __future__ import annotations

import copy

from app.services.pipeline_config_demo import (
    DEMO_PLAN_STEP_NAME,
    DEMO_SCOPE_STEP_NAME,
    apply_demo_double_llm,
)
from app.services.pipeline_config_validation import validate_pipeline_config
from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG


def _planner_stage(config: dict) -> dict:
    return next(s for s in config["stages"] if s["role"] == "planner")


def _llm_steps(stage: dict) -> list[dict]:
    return [step for step in stage["lifecycle"] if step.get("kind") == "llm"]


def test_apply_split_planner_into_two_llm_steps_on_default_shape():
    """Input is the v8 DEFAULT (matches the `demo-workspace` slug today). Output has the
    planner role's lifecycle carrying exactly 2 `kind: llm` steps.
    """
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)

    new_cfg, summary = apply_demo_double_llm(cfg)

    assert summary.applied is True
    assert summary.reason == "split_planner_llm"

    planner = _planner_stage(new_cfg)
    llm_steps = _llm_steps(planner)
    assert len(llm_steps) == 2, f"expected 2 llm steps, got {len(llm_steps)}"

    step_names = {s["name"] for s in llm_steps}
    assert step_names == {DEMO_SCOPE_STEP_NAME, DEMO_PLAN_STEP_NAME}


def test_apply_emits_distinct_stage_tokens_per_llm_step():
    """The two `kind: llm` steps must carry distinct `params.stage` strings —
    the new per-step prompt rows key on this. Identical stage tokens would
    collapse two visual rows into one in the UI and break the demo."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)

    new_cfg, _ = apply_demo_double_llm(cfg)

    planner = _planner_stage(new_cfg)
    llm_steps = _llm_steps(planner)
    stages = [s["params"]["stage"] for s in llm_steps]
    assert stages == ["scope", "plan"], stages
    assert len(set(stages)) == 2


def test_apply_synthesized_config_passes_full_validator():
    """The new shape MUST pass `validate_pipeline_config` cleanly — the demo
    is worthless if it breaks the workspace's /next-assignment path. Filter
    on blocking errors the same way WorkspaceConfigService.update_config
    does (warnings about decision-branch hints / claim pipeline_role are
    fine)."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)

    new_cfg, _ = apply_demo_double_llm(cfg)

    findings = validate_pipeline_config(new_cfg)
    blocking = [e for e in findings if e.get("severity", "error") == "error"]
    assert blocking == [], f"synthesized config failed validation: {blocking}"


def test_apply_is_idempotent_on_already_split_config():
    """Re-running the converter on its own output is a byte-equal no-op and
    flags `applied=False` with reason `already_applied`. This is the
    operator's safety net: re-running the script after a successful apply
    must NOT bump the version or rewrite the config."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    once, summary_once = apply_demo_double_llm(cfg)
    twice, summary_twice = apply_demo_double_llm(copy.deepcopy(once))

    assert summary_once.applied is True
    assert summary_twice.applied is False
    assert summary_twice.reason == "already_applied"
    assert once == twice


def test_apply_leaves_sibling_roles_byte_identical():
    """Implementer / reviewer / rework_mediator / documentator lifecycles
    are NOT touched by the converter — only the planner is split. Snapshot
    every sibling stage pre/post and assert byte-equality."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    sibling_roles = ("implementer", "reviewer", "rework_mediator", "documentator")
    before = {
        role: copy.deepcopy(next(s for s in cfg["stages"] if s["role"] == role))
        for role in sibling_roles
    }

    new_cfg, _ = apply_demo_double_llm(cfg)

    for role in sibling_roles:
        after = next(s for s in new_cfg["stages"] if s["role"] == role)
        assert after == before[role], f"sibling role {role!r} mutated"


def test_apply_preserves_trailing_lifecycle_after_llm_split():
    """The planner's lifecycle today is:
        discover -> claim -> produce_plan(llm) -> write_plan_note(mcp_call) ->
        planner_unassign_self(mcp_call) -> planner_apply_planned_label(label)
    The split inserts a SECOND llm step before the existing write_plan_note;
    everything from write_plan_note onward must be preserved (same names,
    kinds, params, and order).
    """
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    planner_before = _planner_stage(cfg)
    trailing_names_before = [
        s["name"]
        for s in planner_before["lifecycle"]
        if s["name"]
        in (
            "write_plan_note",
            "planner_unassign_self",
            "planner_apply_planned_label",
            "planner_fail_unassign",
            "planner_fail_label",
        )
    ]

    new_cfg, _ = apply_demo_double_llm(cfg)
    planner_after = _planner_stage(new_cfg)

    name_to_step_after = {s["name"]: s for s in planner_after["lifecycle"]}
    for name in trailing_names_before:
        assert name in name_to_step_after, f"trailing step {name!r} dropped"
        # Pre/post: the trailing step's kind + params are byte-identical.
        before_step = next(s for s in planner_before["lifecycle"] if s["name"] == name)
        assert name_to_step_after[name]["kind"] == before_step["kind"]
        assert name_to_step_after[name].get("params") == before_step.get(
            "params"
        )


def test_apply_chains_scope_into_plan_into_write_plan_note():
    """Walk the planner lifecycle by `next` from the claim step and verify
    the new chain: claim -> scope_llm -> plan_llm -> write_plan_note. Any
    break in the chain breaks the lifecycle walker at runtime."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)

    new_cfg, _ = apply_demo_double_llm(cfg)

    planner = _planner_stage(new_cfg)
    by_name = {s["name"]: s for s in planner["lifecycle"]}

    claim_step = by_name["claim_for_planning"]
    assert claim_step["next"] == DEMO_SCOPE_STEP_NAME

    scope_step = by_name[DEMO_SCOPE_STEP_NAME]
    assert scope_step["kind"] == "llm"
    assert scope_step["next"] == DEMO_PLAN_STEP_NAME

    plan_step = by_name[DEMO_PLAN_STEP_NAME]
    assert plan_step["kind"] == "llm"
    assert plan_step["next"] == "write_plan_note"


def test_apply_scope_step_failure_routes_to_existing_failure_subtree():
    """Both new llm steps must wire `on_failure` into the planner's existing
    failure subtree (`planner_fail_unassign`) so a failure mid-scope doesn't
    wedge the card without releasing the participant slot."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)

    new_cfg, _ = apply_demo_double_llm(cfg)

    planner = _planner_stage(new_cfg)
    by_name = {s["name"]: s for s in planner["lifecycle"]}

    assert by_name[DEMO_SCOPE_STEP_NAME].get("on_failure") == "planner_fail_unassign"
    assert by_name[DEMO_PLAN_STEP_NAME].get("on_failure") == "planner_fail_unassign"


def test_apply_does_not_mutate_input_config():
    """The DB-script diff logic needs a non-mutating converter — a mutating
    converter would erase the before/after snapshot."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    snapshot = copy.deepcopy(cfg)

    apply_demo_double_llm(cfg)

    assert cfg == snapshot, "apply_demo_double_llm must not mutate its input"


def test_validator_does_not_yet_catch_duplicate_stage_tokens_across_llm_steps():
    """Validator probe (does NOT exercise the converter):

    If an operator authors a lifecycle with two `kind: llm` steps that share
    the SAME `params.stage` token (e.g. both `"plan"`), the new UI's per-step
    prompt rows would collapse / collide because prompt-config keys on the
    stage token. Today the platform validator (`validate_pipeline_config`)
    does NOT catch this — `_validate_lifecycle_params` typechecks each step
    in isolation. This test pins the current behaviour so a future validator
    enhancement gets a deliberate test update + a follow-up card.

    Open follow-up: add a `duplicate_llm_stage_token_within_role` check in
    `pipeline_config_validation._validate_lifecycle`. Out of scope for Phase
    5 — the converter emits distinct tokens so the demo is safe.
    """
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    planner = _planner_stage(cfg)
    # Hand-author the pathological shape directly: split the legacy step into
    # two llm steps that both carry stage="plan".
    legacy_idx = next(
        i
        for i, s in enumerate(planner["lifecycle"])
        if s["name"] == "produce_plan"
    )
    legacy = planner["lifecycle"][legacy_idx]
    collide_a = copy.deepcopy(legacy)
    collide_a["name"] = "plan_step_a"
    collide_a["next"] = "plan_step_b"
    collide_b = copy.deepcopy(legacy)
    collide_b["name"] = "plan_step_b"
    collide_b["next"] = "write_plan_note"
    planner["lifecycle"][legacy_idx : legacy_idx + 1] = [collide_a, collide_b]
    for step in planner["lifecycle"]:
        if step.get("next") == "produce_plan":
            step["next"] = "plan_step_a"

    findings = validate_pipeline_config(cfg)
    blocking = [f for f in findings if f.get("severity", "error") == "error"]
    # Today: no error for duplicate stage tokens. If this fails because the
    # validator gained the check, that is progress — update the assertion to
    # `assert any("duplicate" in f.get("code", "") ...)` and close the follow-up.
    assert not any(
        "duplicate" in f.get("code", "") and "stage" in f.get("code", "")
        for f in findings
    ), "validator already catches duplicate stage tokens — update this probe"
    assert blocking == [], (
        f"unrelated blocking errors surfaced in the probe: {blocking}"
    )


def test_apply_preserves_planner_llm_tool_allowlist():
    """The planner's tool allowlist (the input list to `tools`) is the
    boundary of what the LLM is permitted to invoke through the MCP server-
    side allowlist enforcement (Option D, 2026-05-18). Both scope_llm and
    plan_llm must inherit the SAME allowlist as the legacy single-step
    planner — operator intent in the stage-level llm.tools is unchanged."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    planner_before = _planner_stage(cfg)
    legacy_tools = next(
        s["params"]["tools"]
        for s in planner_before["lifecycle"]
        if s.get("kind") == "llm"
    )

    new_cfg, _ = apply_demo_double_llm(cfg)
    planner_after = _planner_stage(new_cfg)
    for step in _llm_steps(planner_after):
        assert step["params"]["tools"] == legacy_tools
