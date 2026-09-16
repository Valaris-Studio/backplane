# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Reviewer merge-conflict self-healing edge: DEFAULT_PIPELINE_CONFIG invariants.

A `merge_pr` step that fails (the PR has merge conflicts against the base, or a
transient git/host error) used to have NO `on_failure` edge. The walker then
returned the error, `failWithConfig` bounced the card to backlog with its
`planned` label intact, and — critically — the conflicting PR was left OPEN.
That orphaned open PR board-wide-blocks EVERY implementer pickup via the
`repo_has_no_open_pr` precondition (it rejects any candidate whose own branch
isn't the open PR's head), starving the whole pipeline until a human closes the
PR. Field incident: a freshly-planned card could never be implemented because a
sibling card's failed-merge PR stayed open. See a documented two-blocker
root-cause incident.

The fix routes a merge failure into the EXISTING rework machinery: write a
`review_verdict` note carrying `failure_class: needs_rework`, wake the
rework_mediator, and move the card back to `active`. The rework_mediator's
freshness gate then re-engages the implementer, which re-checks-out the SAME
branch, resolves/rebases, and re-pushes — so the open PR converges to mergeable
instead of being orphaned. Bounded by `max_rework_attempts` → escalates to
blocked rather than looping forever.

The change is pure config: `kind_merge_pr.go` already returns the merge error
and the Go walker already routes a handler error to `on_failure`
(walker.go:111). No runner code change.
"""

from __future__ import annotations

from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG


def _reviewer_lifecycle() -> list[dict]:
    for s in DEFAULT_PIPELINE_CONFIG["stages"]:
        if s["role"] == "reviewer":
            return s["lifecycle"]
    raise AssertionError("DEFAULT_PIPELINE_CONFIG has no reviewer stage")


def _step(name: str) -> dict:
    for step in _reviewer_lifecycle():
        if step["name"] == name:
            return step
    raise AssertionError(f"reviewer lifecycle has no step {name!r}")


def test_merge_pr_step_routes_failure_to_self_heal():
    """merge_the_pr MUST declare an on_failure so a conflict isn't orphaned."""
    merge = _step("merge_the_pr")
    assert merge.get("on_failure"), (
        "merge_the_pr has no on_failure — a failed merge leaves the PR open "
        "and board-wide-blocks the implementer (repo_has_no_open_pr)"
    )
    names = {s["name"] for s in _reviewer_lifecycle()}
    assert merge["on_failure"] in names, (
        f"merge_the_pr.on_failure -> {merge['on_failure']!r} doesn't resolve"
    )


def test_merge_conflict_edge_writes_review_verdict():
    """The self-heal edge writes a review_verdict note so the rework_mediator's
    freshness gate (require_note_kind_newer_than) consumes it. The step must NOT
    hardcode a failure_class: the only routing signal is the note kind, and the
    wire validator rejects anything outside the ReviewFailureClass enum (the old
    hardcoded "needs_rework" 422'd the whole branch — run B, 2026-06-10)."""
    target = _step("merge_the_pr")["on_failure"]
    # Walk the on_failure chain and find the create_note step.
    steps_by_name = {s["name"]: s for s in _reviewer_lifecycle()}
    verdict_step = None
    seen = set()
    cur = target
    while cur and cur not in seen:
        seen.add(cur)
        step = steps_by_name[cur]
        if step["kind"] == "mcp_call" and step["params"].get("tool") == "create_note":
            verdict_step = step
            break
        cur = step.get("next")
    assert verdict_step is not None, (
        "merge-conflict edge writes no create_note verdict"
    )
    args = verdict_step["params"]["args"]
    assert args.get("kind") == "review_verdict", (
        "merge-conflict verdict note must be kind=review_verdict so the "
        "rework_mediator's require_note_kind_newer_than gate engages it"
    )
    assert "failure_class" not in args, (
        "merge-conflict verdict must not hardcode failure_class — the wire "
        f"validator only accepts the ReviewFailureClass enum, got {args!r}"
    )


def test_merge_conflict_edge_wakes_rework_mediator():
    """The edge wakes the rework_mediator so rework is dispatched promptly."""
    steps_by_name = {s["name"]: s for s in _reviewer_lifecycle()}
    cur = _step("merge_the_pr")["on_failure"]
    seen = set()
    woke_mediator = False
    while cur and cur not in seen:
        seen.add(cur)
        step = steps_by_name[cur]
        if step["kind"] == "wake_role" and "rework_mediator" in (
            step["params"].get("roles") or []
        ):
            woke_mediator = True
        cur = step.get("next")
    assert woke_mediator, "merge-conflict edge must wake the rework_mediator"


def test_merge_conflict_edge_moves_card_to_active_not_backlog():
    """The edge's terminal move targets `active`, NOT backlog.

    Moving to backlog would re-trip the original strand: the card keeps its
    `planned` label so the planner skips it (exclude_label), and the implementer
    only scans `active` — the card would be stranded forever. The rework path
    requires the card in `active` (rework_mediator + implementer discover both
    scan active)."""
    steps_by_name = {s["name"]: s for s in _reviewer_lifecycle()}
    cur = _step("merge_the_pr")["on_failure"]
    seen = set()
    last_move_target = None
    while cur and cur not in seen:
        seen.add(cur)
        step = steps_by_name[cur]
        if step["kind"] == "move_card":
            last_move_target = step["params"].get("to_column_type")
        cur = step.get("next")
    assert last_move_target == "active", (
        f"merge-conflict edge must move the card to active, got "
        f"{last_move_target!r} (backlog re-strands the planned card)"
    )


def test_merge_conflict_edge_drops_reviewer_participant():
    """The edge unassigns the reviewer (mirrors request_changes) so the card is
    ownerless for the rework_mediator to claim."""
    steps_by_name = {s["name"]: s for s in _reviewer_lifecycle()}
    cur = _step("merge_the_pr")["on_failure"]
    seen = set()
    dropped_self = False
    while cur and cur not in seen:
        seen.add(cur)
        step = steps_by_name[cur]
        if (
            step["kind"] == "mcp_call"
            and step["params"].get("tool") == "remove_card_participant"
            and step["params"].get("args", {}).get("user_id") == "$self"
        ):
            dropped_self = True
        cur = step.get("next")
    assert dropped_self, (
        "merge-conflict edge must drop the reviewer participant ($self)"
    )
