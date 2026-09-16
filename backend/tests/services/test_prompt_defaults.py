# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Unit tests for prompt-default synthesis.

Synthesized defaults exist so operators creating a custom stage get an
actionable starter template instead of an empty form. The template's
post_process_kind handling is the platform's way of closing the gap
Sonnet leaves — see feedback_directive_compliance.md and B11 in
audits/runner-launch-walkthrough-2026-04-18.md.
"""

from app.services.agents.prompt_defaults import (
    MINIMAL_AGENTIC_PROMPT_TEMPLATE,
    PROMPT_STAGE_REGISTRY,
    synthesize_missing_defaults,
)


def _review_default():
    return next(
        d for d in PROMPT_STAGE_REGISTRY if d.role == "reviewer" and d.slug == "review"
    )


def _pipeline_with_stage(role: str, stage: str, post_process_kind: str = "") -> dict:
    return {
        "stages": [
            {
                "role": role,
                "llm": {
                    "enabled": True,
                    "stage": stage,
                    "post_process_kind": post_process_kind,
                },
            }
        ],
    }


def test_synthesis_without_post_process_kind_uses_plain_template():
    synthesized = synthesize_missing_defaults(
        _pipeline_with_stage("secretario", "secretary")
    )
    assert len(synthesized) == 1
    assert synthesized[0].role == "secretario"
    # Plain minimal template — no post-process imperative injected.
    assert "create_note" not in synthesized[0].default_content
    assert "create_card" not in synthesized[0].default_content


def test_synthesis_produces_note_forbids_llm_create_note_call():
    """Post-LLM→lifecycle-contract redesign: the lifecycle now persists
    findings as the note (kind chosen by pipeline config). The LLM must
    NOT call mcp__valaris__create_note itself — doing so creates duplicate
    notes. The synthesized imperative tells the LLM where its output goes
    (the `findings` field) and explicitly forbids the manual MCP call."""
    synthesized = synthesize_missing_defaults(
        _pipeline_with_stage("secretario", "secretary", "produces_note")
    )
    assert len(synthesized) == 1
    content = synthesized[0].default_content
    # Output channel is the JSON `findings` field, not an MCP call.
    assert "findings" in content
    # Explicit prohibition — DO NOT call the MCP tool.
    assert "DO NOT call" in content
    assert "mcp__valaris__create_note" in content


def test_synthesis_mutates_backlog_forbids_llm_create_card_call():
    """Sibling-card creation belongs to a separate decomposer role, not
    inline within the LLM stage. The synthesized imperative explicitly
    blocks create_card calls so a custom mutates_backlog stage doesn't
    spawn garbage cards on every run."""
    synthesized = synthesize_missing_defaults(
        _pipeline_with_stage("planner_custom", "decompose", "mutates_backlog")
    )
    content = synthesized[0].default_content
    # Prohibition mentions both write tools the LLM might reach for.
    assert "do not call" in content.lower()
    assert "mcp__valaris__create_card" in content
    assert "mcp__valaris__create_note" in content


def test_synthesis_produces_decision_injects_structured_output_imperative():
    synthesized = synthesize_missing_defaults(
        _pipeline_with_stage("reviewer_custom", "verdict", "produces_decision")
    )
    content = synthesized[0].default_content
    # Decision kinds ride the StructuredOutput tool — operator must know
    # to call it, else the engine has no verdict to route on.
    assert "StructuredOutput" in content or "structured_output" in content


def test_synthesis_writes_code_requires_no_special_imperative():
    """writes_code is the implementation path — the minimal template
    already describes writing code; we don't over-prescribe tool use."""
    synthesized = synthesize_missing_defaults(
        _pipeline_with_stage("custom_implementer", "build", "writes_code")
    )
    content = synthesized[0].default_content
    # Minimal template still applies; no create_note / create_card noise.
    assert "create_note" not in content
    assert "create_card" not in content


def test_review_prompt_includes_project_directives_template_block():
    """REV-1: reviewer must enforce platform-injected project directives the
    same way the orchestrator/implement prompt does. The Go runner already
    populates {{.ProjectDirectives}} when llm.inject_directives is true; the
    seed template just needs the matching template block."""
    review = _review_default()
    assert "{{if .ProjectDirectives}}" in review.default_content
    assert "{{.ProjectDirectives}}" in review.default_content
    assert "PROJECT DIRECTIVES" in review.default_content
    assert "ProjectDirectives" in review.template_variables


def test_review_prompt_lists_always_blocking_categories():
    """REV-1: smoke 2026-05-14 surfaced reviewer leniency — a "new POST
    /api/orders bypassing Risk Engine" landed as a non-blocking concern.
    Sharpen the rubric so authz bypass + scope expansion are explicitly
    always-blocking categories, and tighten the SHOULD_FIX-vs-BLOCKING
    tie-breaker toward BLOCKING for security/authz."""
    content = _review_default().default_content
    assert "Always-blocking" in content
    assert "authz" in content
    assert "scope expansion" in content
    # Tie-breaker: when in doubt, choose BLOCKING.
    assert "When in doubt" in content


# ---------------------------------------------------------------------------
# Phase 4: LLM-lifecycle contract — planner + rework_mediator prompts
#
# The lifecycle now owns note-writing, so the prompts must stop instructing
# the LLM to call create_note via MCP. Planner also drops the create_card
# imperative (sibling-card creation is out of scope per locked decision #6).
# The mediate_rework prompt must explicitly tell the LLM the lifecycle is
# the persistence path — otherwise it might omit the body entirely.
# ---------------------------------------------------------------------------


def _plan_default():
    return next(
        d for d in PROMPT_STAGE_REGISTRY
        if d.role == "planner" and d.slug == "plan"
    )


def _mediate_rework_default():
    return next(
        d for d in PROMPT_STAGE_REGISTRY if d.slug == "mediate_rework"
    )


def test_plan_prompt_explicitly_forbids_create_card():
    """Round-7 smoke evidence (2026-05-18): under dangerously-skip-permissions,
    the LLM ignores the tools allowlist and still calls create_card if the
    prompt frames the task as 'decompose into cards'. The prompt must
    explicitly forbid create_card by name and explain WHY (sibling-card
    creation belongs to a separate decomposer role)."""
    content = _plan_default().default_content
    # The phrase must appear inside an explicit prohibition block, not as a
    # positive instruction.
    assert "YOU MUST NOT" in content, (
        "planner prompt needs an explicit DO-NOT block, not just an absent "
        "instruction — round-7 smoke proved silent absence is not enough"
    )
    assert "mcp__valaris__create_card" in content, (
        "planner prompt must name create_card inside the prohibition so the "
        "LLM can't claim it didn't know"
    )
    # The framing must NOT tell the LLM to decompose into cards.
    assert "Decompose this card into smaller, implementable cards" not in content


def test_plan_prompt_explicitly_forbids_create_note():
    """The lifecycle writes the plan note (kind=plan) via mcp_call. The LLM
    calling create_note manually under skip-permissions creates a duplicate
    note. Forbid it by name in the prompt's DO-NOT block."""
    content = _plan_default().default_content
    assert "mcp__valaris__create_note" in content, (
        "planner prompt must name create_note inside the prohibition"
    )
    # Make sure the mention is in a forbidding context, not an imperative.
    do_not_section = content.split("YOU MUST NOT")[1] if "YOU MUST NOT" in content else ""
    assert "mcp__valaris__create_note" in do_not_section, (
        "create_note must appear inside the YOU MUST NOT block, not elsewhere"
    )


def test_plan_prompt_retains_json_envelope():
    """Status + findings envelope stays — the runner's body_from=findings
    reads from that JSON, so the closing block remains structured."""
    content = _plan_default().default_content
    assert "status" in content
    assert "findings" in content


def test_mediate_rework_prompt_explicitly_forbids_write_tools():
    """Same defense as the planner: under skip-permissions the mediator may
    reach for create_card/create_note to 'help' the implementer along.
    Forbid it explicitly so the lifecycle stays the single writer."""
    content = _mediate_rework_default().default_content
    assert "YOU MUST NOT" in content
    assert "mcp__valaris__create_card" in content
    assert "mcp__valaris__create_note" in content


def test_mediate_rework_prompt_explains_lifecycle_writes_note():
    """The LLM must know its output becomes a `rework_brief` note — otherwise
    it might skip the body or duplicate the verdict text."""
    content = _mediate_rework_default().default_content
    assert "rework_brief" in content, (
        "mediate_rework prompt must mention `rework_brief` so the LLM knows "
        "the lifecycle persists its output under that note kind"
    )
    # Some phrasing of "the lifecycle writes" must be present so the model
    # understands ownership, not just that the kind exists.
    lower = content.lower()
    assert "lifecycle" in lower and "note" in lower, (
        f"prompt must explain the lifecycle persists the note, got:\n{content}"
    )


def test_minimal_template_still_exported():
    """Sanity: the base template is the fallback when no post-process
    kind is set. Keep it exported so other callers (sync tests) keep
    compiling."""
    assert "You are an autonomous agent" in MINIMAL_AGENTIC_PROMPT_TEMPLATE


# ---------------------------------------------------------------------------
# Post-run-B prompt hardening (docs/pipeline-improvements-2026-06-10.md,
# P1-P7): integration honesty, reachability, interim-seam contract,
# ui_validator activation, plan reachability/Done-condition, stack-neutrality.
# ---------------------------------------------------------------------------


def _implement_default():
    return next(
        d for d in PROMPT_STAGE_REGISTRY
        if d.role == "implementer" and d.slug == "implement"
    )


def test_review_prompt_carries_integration_honesty_check():
    """P1: every run-B blocker was a fake/stub wired into a production seam,
    visible verbatim in the approved diff. The reviewer needs an explicit
    checklist item + an always-blocking category for untracked deferrals,
    with the tracked-card escape hatch downgrading to SHOULD_FIX."""
    content = _review_default().default_content
    assert "Integration honesty" in content
    assert "search_cards" in content
    # Untracked fake in a prod path is always-blocking…
    assert "interim/fake/stub wired into a production path" in content
    # …but a tracked deferral (existing card ID) is SHOULD_FIX, not BLOCKING.
    assert "tracked deferral" in content.lower()


def test_review_prompt_carries_reachability_grep_check():
    """P2: new exported production symbols with zero non-test call sites are
    dead code presented as progress — deterministic and grep-able in the
    checked-out PR working tree."""
    content = _review_default().default_content
    assert "Reachability" in content
    assert "non-test" in content
    assert "dead code" in content


def test_review_prompt_applies_ui_validation_label_on_approve():
    """P5: mechanism A generalized — the reviewer applies needs-ui-validation
    at approve-time (body marker OR UI-surface diff signal), never on
    request_changes and never pre-seeded (a production incident)."""
    content = _review_default().default_content
    assert "Validation: requires-ui-validation" in content
    assert "needs-ui-validation" in content
    assert "ONLY on approve" in content


def test_implement_prompt_carries_interim_seams_contract():
    """P3: never leave a fake in a prod path with only a code comment as the
    tracker — the implementer MUST file the follow-up wiring card, reference
    its ID at the seam, and return blocked if create_card fails."""
    content = _implement_default().default_content
    assert "INTERIM SEAMS (MANDATORY)" in content
    assert "create_card" in content
    assert "add_card_dependency" in content
    # Failure to file the card is not a soft path.
    assert "status blocked" in content.lower() or '"blocked"' in content
    assert "contract violation" in content


def test_plan_prompt_done_condition_requires_reachability():
    """P6(1): a Done condition is not unit-level only — the new behavior must
    be reachable from the running application entrypoint, or an EXISTING board
    card ID must own that wiring; an unnamed future card is needs_research."""
    content = _plan_default().default_content
    assert "Done condition" in content
    assert "reachable from the running application entrypoint" in content
    assert "needs_research" in content


def test_plan_prompt_wiring_sites_cover_composition_root_swaps():
    """P6(2): swapping a fake/stub binding at the composition root IS a wiring
    site — of this card or of a named existing card."""
    content = _plan_default().default_content
    assert "Wiring sites" in content
    assert "composition root" in content
    assert "IS a wiring site" in content


def test_plan_prompt_is_stack_neutral():
    """P7: the default plan prompt must carry zero project/stack residue —
    examples are stack-neutral placeholders and concrete commands come from
    PROJECT DIRECTIVES / the board definition."""
    content = _plan_default().default_content
    assert "never assume a language" in content
    for residue in ("pytest", "smartbucket", "ruff", "uv run", ".smoke-history"):
        assert residue not in content.lower(), (
            f"plan prompt must not embed stack/project residue {residue!r}"
        )
    # Directives are the source of concrete commands — the template must
    # actually render them.
    assert "{{.ProjectDirectives}}" in content
    assert "ProjectDirectives" in _plan_default().template_variables


def test_plan_prompt_park_signal_uses_blocked_label():
    """Bonus: the needs_research branch must speak the platform's real park
    vocabulary — the `blocked` label (human unblocks by removing it) — not
    invented labels nothing consumes (blocked-human, awaiting-dev-id)."""
    content = _plan_default().default_content
    assert "`blocked` label" in content
    assert "removing" in content
    for invented in ("blocked-human", "awaiting-dev-id"):
        assert invented not in content


def test_plan_prompt_thin_plan_for_recipe_cards():
    """P4: ACCEPT-/SMOKE- recipe cards carry their own runbook in the card
    body — the planner produces a thin plan pointing at it instead of
    re-deriving an approach."""
    content = _plan_default().default_content
    assert "ACCEPT-" in content
    assert "SMOKE-" in content


def test_plan_prompt_allows_progress_telemetry_without_board_writes():
    content = _plan_default().default_content
    assert "Progress telemetry via log_execution_update is allowed" in content
    assert "Your only output channel" not in content
    assert "Call any update_card, update_note, add_card_participant, move_card" in content
