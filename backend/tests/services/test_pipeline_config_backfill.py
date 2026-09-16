# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Unit tests for the legacy-llm -> lifecycle backfill converter.

The converter is a pure function — these tests exercise it with hand-rolled
config fixtures, never the DB. The companion script
`backend/scripts/backfill_pipeline_config_lifecycle.py` wires the converter
into a DB pass with dry-run + --apply guards; that path is intentionally not
tested here (the OCC version write is covered by the WorkspaceConfigService
suite already).
"""

from __future__ import annotations

import copy

from app.services.pipeline_config_backfill import (
    BackfillSummary,
    backfill_lifecycle,
)
from app.services.pipeline_config_validation import validate_pipeline_config
from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG


def _mk_legacy_stage(
    role: str,
    *,
    llm: dict | None = None,
    lifecycle: list | None = None,
    discover: dict | None = None,
    claim: dict | None = None,
    git: dict | None = None,
) -> dict:
    """Construct a stage with the four required legacy blocks.

    Mirrors `_REQUIRED_STAGE_KEYS` in pipeline_config_validation.py so the
    resulting config can be fed straight into `validate_pipeline_config`.
    """
    stage: dict = {
        "role": role,
        "discover": discover if discover is not None else {"strategy": "column_scan"},
        "claim": claim if claim is not None else {"participant_role": "helper"},
        "git": git if git is not None else {"action": "none"},
        "llm": llm if llm is not None else {"enabled": False},
    }
    if lifecycle is not None:
        stage["lifecycle"] = lifecycle
    return stage


def _wrap(stages: list[dict]) -> dict:
    return {
        "version": 1,
        "stages": stages,
        "scheduling": {
            "mode": "priority",
            "priority_order": [s["role"] for s in stages],
        },
    }


def test_legacy_only_stage_gets_synthesized_lifecycle():
    """Stage with `llm` block but no `lifecycle[]` -> synthesize a single
    `kind: llm` step capturing the legacy params. Post-conversion config
    must validate cleanly.
    """
    legacy_llm = {
        "enabled": True,
        "stage": "implement",
        "provider": "claude-cli",
        "model": "mid",
        "post_process_kind": "writes_code",
        "tools": ["mcp__valaris__get_card"],
        "inject_directives": True,
        "approval_enabled": True,
    }
    cfg = _wrap([_mk_legacy_stage("implementer", llm=legacy_llm)])

    new_cfg, summary = backfill_lifecycle(cfg)

    assert summary.stages_migrated == 1
    assert summary.stages_skipped_conservative == 0
    assert summary.stages_already_lifecycle == 0

    stage = new_cfg["stages"][0]
    lifecycle = stage["lifecycle"]
    assert isinstance(lifecycle, list)
    # llm step + a terminal marker so the lifecycle validates (llm is
    # non-terminal — see pipeline_config_validation.py:1129).
    assert any(step["kind"] == "llm" for step in lifecycle)

    llm_step = next(step for step in lifecycle if step["kind"] == "llm")
    # Every llm-block field with a slot in the lifecycle params schema gets
    # copied verbatim. `enabled` is intentionally dropped — it's a legacy gate
    # without a lifecycle equivalent (the step is the gate now).
    assert llm_step["params"]["stage"] == "implement"
    assert llm_step["params"]["provider"] == "claude-cli"
    assert llm_step["params"]["model"] == "mid"
    assert llm_step["params"]["post_process_kind"] == "writes_code"
    assert llm_step["params"]["tools"] == ["mcp__valaris__get_card"]
    assert llm_step["params"]["inject_directives"] is True
    assert llm_step["params"]["approval_enabled"] is True
    assert "enabled" not in llm_step["params"]

    errors = validate_pipeline_config(new_cfg)
    assert errors == [], f"synthesized config failed validation: {errors}"


def test_already_lifecycle_stage_is_left_alone():
    """Stage with a populated `lifecycle[]` and no legacy `llm` -> no change."""
    existing_lifecycle = [
        {
            "name": "marker",
            "kind": "apply_label",
            "params": {"label": "operator-authored"},
        },
    ]
    cfg = _wrap([
        _mk_legacy_stage(
            "planner",
            llm={"enabled": False},
            lifecycle=copy.deepcopy(existing_lifecycle),
        )
    ])

    before = copy.deepcopy(cfg)
    new_cfg, summary = backfill_lifecycle(cfg)

    assert summary.stages_migrated == 0
    assert summary.stages_skipped_conservative == 0
    assert summary.stages_already_lifecycle == 1
    assert new_cfg == before


def test_conflict_stage_is_left_alone_conservatively():
    """Stage with BOTH a legacy `llm` block AND a non-empty `lifecycle[]` -> no
    change; the operator's explicit lifecycle wins, and a note is logged."""
    cfg = _wrap([
        _mk_legacy_stage(
            "implementer",
            llm={
                "enabled": True,
                "stage": "implement",
                "post_process_kind": "writes_code",
            },
            lifecycle=[
                {
                    "name": "operator_terminal",
                    "kind": "apply_label",
                    "params": {"label": "from-operator"},
                }
            ],
        )
    ])

    before = copy.deepcopy(cfg)
    new_cfg, summary = backfill_lifecycle(cfg)

    assert summary.stages_migrated == 0
    assert summary.stages_skipped_conservative == 1
    assert summary.stages_already_lifecycle == 0
    assert new_cfg == before
    assert any("implementer" in n for n in summary.notes)


def test_empty_lifecycle_array_is_treated_as_default():
    """`lifecycle: []` is a default, not operator intent. Synthesize from the
    legacy llm block as if the key were absent."""
    legacy_llm = {
        "enabled": True,
        "stage": "review",
        "post_process_kind": "produces_decision",
    }
    cfg = _wrap([_mk_legacy_stage("reviewer", llm=legacy_llm, lifecycle=[])])

    new_cfg, summary = backfill_lifecycle(cfg)

    assert summary.stages_migrated == 1
    assert summary.stages_skipped_conservative == 0
    stage = new_cfg["stages"][0]
    assert len(stage["lifecycle"]) >= 1
    assert any(step["kind"] == "llm" for step in stage["lifecycle"])

    errors = validate_pipeline_config(new_cfg)
    assert errors == [], f"synthesized config failed validation: {errors}"


def test_backfill_is_idempotent():
    """Running the converter on its own output is a no-op on the config dict.

    The first pass synthesizes; the second pass sees `legacy llm.enabled=true`
    AND a populated `lifecycle[]` and conservatively skips. The on-disk shape
    is byte-equal — that is the operational invariant for safe re-runs.

    Note: the second-pass tally classifies the stage as
    `stages_skipped_conservative` rather than `stages_already_lifecycle` —
    the converter has no marker-aware fast path because the conservative
    rule already produces the right behaviour (no mutation, warn logged).
    """
    legacy_llm = {
        "enabled": True,
        "stage": "implement",
        "model": "mid",
        "post_process_kind": "writes_code",
    }
    cfg = _wrap([_mk_legacy_stage("implementer", llm=legacy_llm)])

    once, summary_once = backfill_lifecycle(cfg)
    twice, summary_twice = backfill_lifecycle(copy.deepcopy(once))

    assert summary_once.stages_migrated == 1
    assert summary_twice.stages_migrated == 0
    assert summary_twice.stages_skipped_conservative == 1
    assert once == twice


def test_mixed_config_tallies_correctly():
    """Workspace with four stages — one legacy-only, one already-lifecycle, one
    conflict, one scaffold (no llm + no lifecycle). Only the legacy-only stage
    is touched; the scaffold stage is left untouched and not counted as
    migrated."""
    operator_lifecycle = [
        {
            "name": "op_terminal",
            "kind": "apply_label",
            "params": {"label": "operator"},
        }
    ]

    stages = [
        # Legacy-only: should be migrated.
        _mk_legacy_stage(
            "planner",
            llm={
                "enabled": True,
                "stage": "plan",
                "post_process_kind": "produces_note",
            },
        ),
        # Already-lifecycle: should be a no-op.
        _mk_legacy_stage(
            "implementer",
            llm={"enabled": False},
            lifecycle=copy.deepcopy(operator_lifecycle),
        ),
        # Conflict: legacy llm + non-empty lifecycle -> conservative skip.
        _mk_legacy_stage(
            "reviewer",
            llm={
                "enabled": True,
                "stage": "review",
                "post_process_kind": "produces_decision",
            },
            lifecycle=copy.deepcopy(operator_lifecycle),
        ),
        # Scaffold stage: no llm.enabled AND no lifecycle -> leave alone.
        _mk_legacy_stage("documentator", llm={"enabled": False}),
    ]
    cfg = _wrap(stages)

    new_cfg, summary = backfill_lifecycle(cfg)

    assert summary.stages_migrated == 1
    assert summary.stages_already_lifecycle == 1
    assert summary.stages_skipped_conservative == 1

    # planner got a lifecycle; documentator did not.
    planner = next(s for s in new_cfg["stages"] if s["role"] == "planner")
    assert "lifecycle" in planner and planner["lifecycle"]

    documentator = next(s for s in new_cfg["stages"] if s["role"] == "documentator")
    assert "lifecycle" not in documentator or documentator.get("lifecycle") in (None, [])


def test_disabled_llm_block_is_not_synthesized():
    """Legacy `llm.enabled: False` carries no semantic LLM step — skip it the
    same way the legacy walker would. Avoids emitting an unfired LLM step that
    confuses the new lifecycle UI."""
    cfg = _wrap([
        _mk_legacy_stage(
            "documentator",
            llm={"enabled": False, "stage": "document"},
        )
    ])

    new_cfg, summary = backfill_lifecycle(cfg)

    assert summary.stages_migrated == 0
    # The stage stays without a lifecycle (it never had llm-driven work to
    # represent in DSL form).
    stage = new_cfg["stages"][0]
    assert "lifecycle" not in stage or stage.get("lifecycle") in (None, [])


def test_backfill_returns_isolated_copy():
    """The converter must not mutate its input — the script's dry-run logic
    diffs before vs after, and a mutating converter would erase the diff."""
    legacy_llm = {
        "enabled": True,
        "stage": "implement",
        "post_process_kind": "writes_code",
    }
    cfg = _wrap([_mk_legacy_stage("implementer", llm=legacy_llm)])
    snapshot = copy.deepcopy(cfg)

    backfill_lifecycle(cfg)

    assert cfg == snapshot, "backfill_lifecycle must not mutate its input"


def test_default_pipeline_config_is_already_lifecycle_no_op():
    """Regression canary: running the backfill against DEFAULT_PIPELINE_CONFIG
    leaves the config byte-equal. If someone reverts the 2026-05-16 redesign
    and re-emits a DEFAULT without lifecycle[], this test fires and the
    script's behaviour changes silently — which we want to catch.

    DEFAULT carries BOTH legacy llm.enabled=true blocks AND populated
    lifecycle[]s on every stage; the converter classifies these as
    conservative skips (operator/platform is authoritative). The
    operational invariant is "no mutation of the stored config", which the
    snapshot equality guards.
    """
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    snapshot = copy.deepcopy(cfg)

    new_cfg, summary = backfill_lifecycle(cfg)

    # The operational invariant is "no mutation of the stored config". Every
    # stage is either a conservative skip (enabled legacy llm + lifecycle) or
    # already-lifecycle (the disabled documentator: end-only, llm.enabled=false)
    # — none migrate. Their sum is the full stage set.
    assert summary.stages_migrated == 0
    assert (
        summary.stages_skipped_conservative + summary.stages_already_lifecycle
        == len(DEFAULT_PIPELINE_CONFIG["stages"])
    )
    assert new_cfg == snapshot


def test_summary_dataclass_default_values():
    """`BackfillSummary` is the script's reporting contract — defaults must be
    zero so a fresh tally can accumulate by += across workspaces."""
    summary = BackfillSummary()
    assert summary.stages_migrated == 0
    assert summary.stages_skipped_conservative == 0
    assert summary.stages_already_lifecycle == 0
    assert summary.notes == []
