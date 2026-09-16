# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""WS4 systemic fix: the canonical DEFAULT_PIPELINE_CONFIG must WIRE the
inter-role handoff artifacts via server-rendered context_sources, and the
default prompts must reference them — otherwise a role's critical input (the
plan note, the review verdict) is silently unreachable.

Root cause this guards against (prod audit 2026-06-08): roles' prompts called
`list_notes(card_id=...)` to read their handoff note, but list_notes is not in
their tool allowlist and get_project_context returns content-less note
summaries. The fix is `llm.context_sources` pre-injection (the
context_assembly.py fetchers already support card_notes(filter.kind) and
review_history). These tests pin the wiring on the DEFAULT so every NEW
workspace ships with working handoffs.

Injection-syntax invariants (from context_source_lint.py / the Go runner):
  - a `card_notes` source reaches the prompt ONLY as
    `{{ index .ContextSources "<alias>" }}`.
  - `review_history` reaches the prompt via the legacy bridge field
    `{{.ReviewHistory}}` and MUST be declared with no diverging `as:` alias.
"""

from __future__ import annotations

from app.models.notes.kinds import PLAN, REVIEW_VERDICT
from app.services.agents.context_source_lint import lint_context_source_wiring
from app.services.agents.prompt_defaults import (
    get_prompt_defaults,
    get_prompt_defaults_with_synthesis,
)
from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG


def _stage(config: dict, role: str) -> dict:
    return next(s for s in config["stages"] if s.get("role") == role)


def _sources(stage: dict) -> list[dict]:
    return (stage.get("llm") or {}).get("context_sources") or []


def _source_by_kind(stage: dict, kind: str) -> dict | None:
    return next((s for s in _sources(stage) if s.get("kind") == kind), None)


def test_implementer_default_declares_plan_note_source():
    """The implementer must receive the planner's plan note as pre-rendered
    context — it can't list_notes for it."""
    impl = _stage(DEFAULT_PIPELINE_CONFIG, "implementer")
    src = _source_by_kind(impl, "card_notes")
    assert src is not None, "implementer default must declare a card_notes source for the plan note"
    assert (src.get("filter") or {}).get("kind") == PLAN, "the source must filter for the kind=plan note"


def test_reviewer_default_declares_plan_note_source():
    """The reviewer checks the diff against the plan; it needs the plan note
    pre-rendered (its allowlist has no list_notes)."""
    rev = _stage(DEFAULT_PIPELINE_CONFIG, "reviewer")
    src = _source_by_kind(rev, "card_notes")
    assert src is not None, "reviewer default must declare a card_notes source for the plan note"
    assert (src.get("filter") or {}).get("kind") == PLAN


def test_rework_mediator_default_declares_review_history_source():
    """The mediator must quote the reviewer's verdict verbatim — it needs
    review_history injected (its default prompt already uses {{.ReviewHistory}})."""
    med = _stage(DEFAULT_PIPELINE_CONFIG, "rework_mediator")
    src = _source_by_kind(med, "review_history")
    assert src is not None, "rework_mediator default must declare a review_history source"
    # review_history reaches the prompt via the {{.ReviewHistory}} legacy bridge;
    # an `as:` that diverges from the kind breaks that bridge.
    assert src.get("as") in (None, "review_history"), (
        "review_history must NOT carry a diverging alias or the {{.ReviewHistory}} bridge breaks"
    )


def test_default_prompts_reference_their_declared_sources_no_lint_warnings():
    """End-to-end: every context_source declared on the DEFAULT config must be
    referenced by that stage's default prompt — no silently-dropped context."""
    defaults = get_prompt_defaults_with_synthesis(DEFAULT_PIPELINE_CONFIG)
    prompt_contents = {(d.role, d.stage): d.default_content for d in defaults}

    findings = lint_context_source_wiring(DEFAULT_PIPELINE_CONFIG, prompt_contents)
    declared_but_unreferenced = [
        f for f in findings if f["code"] == "context_source_declared_but_unreferenced"
    ]
    assert not declared_but_unreferenced, (
        "DEFAULT prompts must reference every declared context source; "
        f"unreferenced: {[f.get('value') for f in declared_but_unreferenced]}"
    )
