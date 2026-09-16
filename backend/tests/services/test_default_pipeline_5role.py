# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""6-role DEFAULT_PIPELINE_CONFIG invariants (production-run promotion 2026-06-08).

Asserts the promoted default composes the planner/implementer/reviewer/
rework_mediator/documentator/ui_validator stages and that the validator
accepts it (zero errors; the only allowed warnings are the two ui_validator
post-merge-auditor branches that intentionally do not move the card they
audit — see test_default_passes_validator_with_zero_warnings_zero_errors).

Companion tests live in test_default_pipeline_config_lifecycle.py (control-
flow integrity, terminal reachability). This file asserts the **shape** of
the default — role set, tier strings, FOLLOWUP-13 / FOLLOWUP-14 fixes.
"""

from __future__ import annotations

from app.services.pipeline_config_validation import (
    canonicalize_pipeline_config,
    validate_pipeline_config,
)
from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG

_EXPECTED_ROLES = frozenset(
    {
        "planner",
        "implementer",
        "reviewer",
        "rework_mediator",
        "documentator",
        "ui_validator",
        # A1b no-op-loop cure: discovers `needs-reconcile` cards and disposes of
        # them so the scheduler stops re-offering a card the implementer
        # couldn't close cleanly.
        "board_reconciler",
    }
)
_TIER_NAMES = frozenset({"premium", "mid", "low"})

# The ui_validator's drive_ui decision branches intentionally do NOT move the
# card: it audits a card already in `done` — a pass only applies the
# `ui-validated` label, a fail files SEPARATE fix cards and leaves the source
# in `done`. The FOLLOWUP-13 guard (built for cards stuck mid-pipeline) flags
# these as warnings, but they are correct for a post-merge auditor.
# board_reconciler's `park` branch is the same intentional pattern: a card it
# cannot dispose autonomously is parked with `blocked` for a human and MUST
# sit idle. Its other branches move/handoff correctly and are still guarded.
_EXPECTED_FOLLOWUP13_WARNING_FIELDS = frozenset(
    {
        "stages[5].lifecycle[4].branches.approve",
        "stages[5].lifecycle[4].branches.request_changes",
        "stages[6].lifecycle[2].branches.park",
    }
)


def _stage(role: str) -> dict:
    for s in DEFAULT_PIPELINE_CONFIG["stages"]:
        if s.get("role") == role:
            return s
    raise AssertionError(
        f"DEFAULT_PIPELINE_CONFIG has no {role!r} stage "
        f"(roles present: {[s.get('role') for s in DEFAULT_PIPELINE_CONFIG['stages']]})"
    )


def test_default_has_exactly_seven_stages():
    assert len(DEFAULT_PIPELINE_CONFIG["stages"]) == 7


def test_default_role_set_matches_redesign():
    roles = {s["role"] for s in DEFAULT_PIPELINE_CONFIG["stages"]}
    assert roles == _EXPECTED_ROLES, (
        f"role set drift: missing={_EXPECTED_ROLES - roles}, "
        f"extra={roles - _EXPECTED_ROLES}"
    )


def test_every_claim_step_populates_pipeline_role():
    """F-14 fix: every claim step's params carry pipeline_role = stage role.
    Disabled stages (e.g. the default's documentator) run an end-only lifecycle
    with no claim step and are skipped."""
    for stage in DEFAULT_PIPELINE_CONFIG["stages"]:
        role = stage["role"]
        if (stage.get("llm") or {}).get("enabled") is False:
            continue
        claim_steps = [
            step for step in stage.get("lifecycle", []) if step["kind"] == "claim"
        ]
        assert claim_steps, f"{role}: stage has no claim step"
        for step in claim_steps:
            params = step.get("params") or {}
            assert params.get("pipeline_role") == role, (
                f"{role}.{step['name']}: claim.pipeline_role must equal "
                f"stage role {role!r} (got {params.get('pipeline_role')!r})"
            )


def test_every_llm_step_uses_tier_string_not_literal_model():
    """Model-tier abstraction: DEFAULT must emit tier names, not "sonnet"/"opus"."""
    for stage in DEFAULT_PIPELINE_CONFIG["stages"]:
        role = stage["role"]
        for step in stage.get("lifecycle", []):
            if step["kind"] != "llm":
                continue
            model = (step.get("params") or {}).get("model")
            assert model in _TIER_NAMES, (
                f"{role}.{step['name']}: llm.model {model!r} must be a tier "
                f"string ({sorted(_TIER_NAMES)}); literal model names are "
                f"deprecated in DEFAULT_PIPELINE_CONFIG."
            )


def test_reviewer_request_changes_terminates_with_move_to_active():
    """FOLLOWUP-13 regression: request_changes branch must end with move_card(active).

    Pre-redesign the chain stopped at create_note (terminal), leaving the
    card stuck in `review` with no participant — the canonical FOLLOWUP-13
    wedge.
    """
    reviewer = _stage("reviewer")
    by_name = {s["name"]: s for s in reviewer["lifecycle"]}

    review_diff = next(
        s for s in reviewer["lifecycle"] if s["kind"] == "llm"
    )
    branches = review_diff.get("branches") or {}
    assert "request_changes" in branches, "reviewer LLM step missing request_changes branch"

    cursor = branches["request_changes"]
    seen: set[str] = set()
    while cursor and cursor not in seen:
        seen.add(cursor)
        step = by_name.get(cursor)
        assert step is not None, f"dangling reference {cursor!r}"
        kind = step["kind"]
        if kind == "move_card":
            assert (step.get("params") or {}).get("to_column_type") == "active", (
                f"request_changes terminal move_card must target 'active' "
                f"(got {step.get('params')!r})"
            )
            return
        cursor = step.get("next")
    raise AssertionError(
        f"request_changes branch never reaches move_card; visited {sorted(seen)}"
    )


def test_reviewer_filters_use_canonical_skip_if_pipeline_role():
    """F-14 canonical: filters key on pipeline_role, not deprecated participant_role."""
    reviewer = _stage("reviewer")
    discover = next(s for s in reviewer["lifecycle"] if s["kind"] == "discover")
    filters = (discover.get("params") or {}).get("filters") or {}
    assert filters.get("skip_if_pipeline_role") == "reviewer", (
        f"reviewer discover must use skip_if_pipeline_role='reviewer' "
        f"(got {filters!r})"
    )
    assert "skip_if_participant_role" not in filters, (
        "reviewer discover must not use the deprecated "
        "skip_if_participant_role alias"
    )


def test_rework_mediator_discover_gates_on_verdict_freshness_not_existence():
    """The rework_mediator must pick up a card ONLY when a fresh review_verdict
    landed AFTER its last rework_brief — not merely when a verdict EXISTS.

    The existence gate (`require_note_kind: review_verdict` alone) re-spins
    forever: the mediator writes a brief and self-unassigns, the verdict note
    still exists, so it re-reserves the same card next poll → infinite
    mediate_rework loop (the production-incident blocker). The freshness gate
    `require_note_kind_newer_than {review_verdict, rework_brief}` breaks it —
    once a brief exists newer than the verdict, the card is no longer eligible.
    Checked on BOTH the flat discover.filters and the lifecycle mirror (they
    must stay in sync — split-brain hazard).
    """
    mediator = _stage("rework_mediator")

    flat = (mediator.get("discover") or {}).get("filters") or {}
    lifecycle_discover = next(
        s for s in mediator["lifecycle"] if s["kind"] == "discover"
    )
    lifecycle_filters = (lifecycle_discover.get("params") or {}).get("filters") or {}

    for label, filters in (("flat", flat), ("lifecycle", lifecycle_filters)):
        newer = filters.get("require_note_kind_newer_than")
        assert isinstance(newer, dict), (
            f"rework_mediator {label} discover must gate on "
            f"require_note_kind_newer_than (got {filters!r})"
        )
        assert newer.get("kind") == "review_verdict", (
            f"{label}: freshness gate kind must be review_verdict (got {newer!r})"
        )
        assert newer.get("than_kind") == "rework_brief", (
            f"{label}: freshness gate than_kind must be rework_brief (got {newer!r})"
        )


def test_rework_mediator_clears_implementer_hero_before_waking_it():
    """The mediator must drop the prior implementer's hero/pipeline_role before
    waking the implementer for rework.

    In a multi-agent deployment the implementer's hero is a DIFFERENT user than
    the mediator, so `$self`-unassign can't reach it; the implementer's
    `unassigned_or_rework` discover skips ALL heroed cards, so without this the
    reworked card can never be re-picked. The step removes by pipeline_role
    (not user_id) via remove_card_participant(pipeline_role=...), and must run before
    wake_implementer.
    """
    mediator = _stage("rework_mediator")
    steps = mediator["lifecycle"]
    by_name = {s["name"]: i for i, s in enumerate(steps)}

    clear_steps = [
        s for s in steps
        if s["kind"] == "mcp_call"
        and (s.get("params") or {}).get("tool") == "remove_card_participant"
        and ((s.get("params") or {}).get("args") or {}).get("pipeline_role")
        and ((s.get("params") or {}).get("args") or {}).get("pipeline_role") == "implementer"
    ]
    assert len(clear_steps) == 1, (
        "rework_mediator must have exactly one step clearing the implementer "
        f"hero via remove_card_participant(pipeline_role=...) (got {len(clear_steps)})"
    )

    wake_idx = next(
        i for i, s in enumerate(steps)
        if s["kind"] == "wake_role"
        and "implementer" in ((s.get("params") or {}).get("roles") or [])
    )
    clear_idx = by_name[clear_steps[0]["name"]]
    assert clear_idx < wake_idx, (
        "the implementer-hero clear must run BEFORE wake_implementer so the "
        "card is re-discoverable when the implementer next polls"
    )


def test_rework_mediator_skips_dead_brief_ready_label():
    """The `rework-brief-ready` label was a vestige of an abandoned label-gate
    that nothing reads — the freshness gate replaced it. The DEFAULT mediator
    must not emit a dead apply_label step for it."""
    mediator = _stage("rework_mediator")
    dead = [
        s for s in mediator["lifecycle"]
        if s["kind"] == "apply_label"
        and (s.get("params") or {}).get("label") == "rework-brief-ready"
    ]
    assert not dead, (
        "rework_mediator must not apply the dead `rework-brief-ready` label "
        "(no discover predicate reads it; freshness gate is the real signal)"
    )


def test_no_stage_emits_legacy_on_success_or_on_failure_blocks():
    """Legacy DEPRECATED blocks are dead under the walker. New DEFAULT omits them.

    The schema still ACCEPTS them on persisted older configs, but emitting
    them in the canonical default is a regression.
    """
    for stage in DEFAULT_PIPELINE_CONFIG["stages"]:
        role = stage["role"]
        assert "on_success" not in stage, (
            f"{role}: legacy on_success block must not appear in DEFAULT "
            f"(lifecycle DSL is single source of truth)"
        )
        assert "on_failure" not in stage, (
            f"{role}: legacy on_failure block must not appear in DEFAULT"
        )


def test_documentator_ships_disabled():
    """The promoted default ships documentator DISABLED (llm.enabled=false,
    end-only lifecycle). An operator opts in by enabling it."""
    doc = _stage("documentator")
    assert (doc.get("llm") or {}).get("enabled") is False, (
        "documentator must ship disabled in the default"
    )
    kinds = [s.get("kind") for s in doc.get("lifecycle", [])]
    assert kinds == ["end"], (
        f"disabled documentator lifecycle must be a single end step, got {kinds}"
    )


def test_default_passes_validator_with_zero_errors_only_auditor_warnings():
    """Zero errors. The only allowed warnings are the two ui_validator
    post-merge-auditor branches that intentionally don't move the audited
    card (it stays in `done`; a pass labels it, a fail files fix cards)."""
    config = {
        **DEFAULT_PIPELINE_CONFIG,
        "stages": [dict(s) for s in DEFAULT_PIPELINE_CONFIG["stages"]],
    }
    canonicalize_pipeline_config(config)
    findings = validate_pipeline_config(config)
    errors = [f for f in findings if f.get("severity", "error") == "error"]
    warnings = [f for f in findings if f.get("severity") == "warning"]
    assert errors == [], f"DEFAULT_PIPELINE_CONFIG validator errors: {errors}"
    unexpected = [
        w
        for w in warnings
        if w.get("field") not in _EXPECTED_FOLLOWUP13_WARNING_FIELDS
    ]
    assert unexpected == [], f"unexpected validator warnings: {unexpected}"
    # And the two known ui_validator auditor warnings ARE the ones we expect.
    assert {w.get("field") for w in warnings} == _EXPECTED_FOLLOWUP13_WARNING_FIELDS


def test_planner_discovers_backlog_with_planner_skip_filter():
    """Planner picks cards from backlog and avoids re-planning its own."""
    planner = _stage("planner")
    discover = next(s for s in planner["lifecycle"] if s["kind"] == "discover")
    params = discover.get("params") or {}
    assert params.get("column_type") == "backlog", (
        f"planner discover.column_type must be 'backlog' (got {params!r})"
    )
    filters = params.get("filters") or {}
    assert filters.get("skip_if_pipeline_role") == "planner"


def test_implementer_replaces_orchestrator():
    """The redesign renames orchestrator -> implementer for clarity."""
    assert "orchestrator" not in {
        s["role"] for s in DEFAULT_PIPELINE_CONFIG["stages"]
    }, "DEFAULT must not carry the legacy 'orchestrator' role after redesign"
    implementer = _stage("implementer")
    discover = next(s for s in implementer["lifecycle"] if s["kind"] == "discover")
    params = discover.get("params") or {}
    assert params.get("column_type") == "active"


def test_scheduling_priority_order_matches_redesign():
    """Priority: reviewer first (unblocks downstream), then mediator, implementer,
    planner (greenfield), documentator + ui_validator (post-merge), and finally
    board_reconciler (LOWEST — only disposes of parked cards when no build work
    is pending, so it never starves the pipeline)."""
    priority = DEFAULT_PIPELINE_CONFIG["scheduling"]["priority_order"]
    assert priority == [
        "reviewer",
        "rework_mediator",
        "implementer",
        "planner",
        "documentator",
        "ui_validator",
        "board_reconciler",
    ], f"priority_order drift: {priority}"


def test_default_flat_llm_model_agrees_with_lifecycle_llm_step():
    """Guard against the b8024b15 split-brain re-entering the shipped default:
    every stage that carries a lifecycle llm step must declare the same
    provider/model in its flat llm block (the flat block is the legacy
    fallback; divergence silently shadows the authoritative value)."""
    for idx, stage in enumerate(DEFAULT_PIPELINE_CONFIG["stages"]):
        llm_step_params = next(
            (
                step.get("params") or {}
                for step in stage.get("lifecycle") or []
                if step.get("kind") == "llm"
            ),
            None,
        )
        if llm_step_params is None:
            continue
        flat = stage.get("llm") or {}
        for key in ("provider", "model"):
            lifecycle_value = llm_step_params.get(key)
            if lifecycle_value:
                assert flat.get(key) == lifecycle_value, (
                    f"stages[{idx}] ({stage.get('role')!r}): flat llm.{key}="
                    f"{flat.get(key)!r} diverges from lifecycle llm params."
                    f"{key}={lifecycle_value!r}"
                )
