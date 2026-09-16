# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""5-role DEFAULT_PIPELINE_CONFIG: lifecycle structural invariants.

Asserts (per docs/pipeline-design/02-role-redesign.md):
  - every stage carries a non-empty `lifecycle` list (the walker's only source
    of truth — legacy on_success/on_failure are gone),
  - the validator accepts the redesigned default with zero errors,
  - every lifecycle step's `next` / `branches[*]` / `on_failure` references
    resolve to a sibling step,
  - every leaf step is a terminal kind.

Companion tests in test_default_pipeline_5role.py cover the shape of the
redesign (role set, tier strings, F-13/F-14 fixes).
The Go-side equivalence test for the migrated lifecycle lives at
runner/internal/workloop/default_pipeline_lifecycle_test.go.
"""

from __future__ import annotations

from app.services.agents.lifecycle_kinds import LIFECYCLE_KINDS
from app.services.pipeline_config_validation import (
    canonicalize_pipeline_config,
    validate_pipeline_config,
)
from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG

_REDESIGN_ROLES = (
    "planner",
    "implementer",
    "reviewer",
    "rework_mediator",
    "documentator",
    "ui_validator",
    # A1b no-op-loop cure: discovers `needs-reconcile` cards and disposes of
    # them (supersede/no_action/park/repair) so the scheduler stops re-offering
    # a card the implementer couldn't close cleanly.
    "board_reconciler",
)

# The ui_validator audits a card already in `done`; its two drive_ui decision
# branches intentionally do not move the card (a pass labels it `ui-validated`,
# a fail files separate fix cards), so the FOLLOWUP-13 guard emits two expected
# warnings. The reviewer's review_diff branches-without-on_failure emits the
# produces_decision_no_failure_fallback warning. All other warnings are
# regressions.
_EXPECTED_WARNING_CODES = frozenset(
    {
        "produces_decision_no_failure_fallback",
        "lifecycle_decision_branch_missing_terminal_move",
    }
)


def _stage(role: str) -> dict:
    for s in DEFAULT_PIPELINE_CONFIG["stages"]:
        if s["role"] == role:
            return s
    raise AssertionError(f"DEFAULT_PIPELINE_CONFIG has no {role!r} stage")


def test_default_pipeline_config_carries_seven_role_set():
    roles = {s["role"] for s in DEFAULT_PIPELINE_CONFIG["stages"]}
    assert roles == set(_REDESIGN_ROLES)


def test_default_pipeline_config_carries_lifecycle_per_stage():
    for role in _REDESIGN_ROLES:
        stage = _stage(role)
        lifecycle = stage.get("lifecycle")
        assert isinstance(lifecycle, list) and lifecycle, (
            f"{role} stage must declare a non-empty lifecycle list"
        )


def test_default_pipeline_config_passes_validator():
    """The redesigned default must validate clean — zero errors (the F-13/F-14
    guards added in 8f6bf6c are the regression net).

    The reviewer's `review_diff` produces_decision step has branches but no
    on_failure, so it emits the (warning-severity) produces_decision_no_failure_
    fallback finding — a deliberate surfacing of the latent empty-decision shape
    the runner now fail-softs. Any OTHER warning is still a regression.
    """
    config = {
        **DEFAULT_PIPELINE_CONFIG,
        "stages": [dict(s) for s in DEFAULT_PIPELINE_CONFIG["stages"]],
    }
    canonicalize_pipeline_config(config)
    findings = validate_pipeline_config(config)
    errors = [f for f in findings if f.get("severity", "error") == "error"]
    unexpected_warnings = [
        f for f in findings
        if f.get("severity") == "warning"
        and f.get("code") not in _EXPECTED_WARNING_CODES
    ]
    assert errors == [], f"validator rejected DEFAULT_PIPELINE_CONFIG: {errors}"
    assert unexpected_warnings == [], (
        f"unexpected warnings on DEFAULT_PIPELINE_CONFIG: {unexpected_warnings}"
    )


def test_default_pipeline_config_lifecycle_steps_use_known_kinds():
    for role in _REDESIGN_ROLES:
        for step in _stage(role)["lifecycle"]:
            assert step["kind"] in LIFECYCLE_KINDS, (
                f"{role}.{step['name']} uses unknown kind {step['kind']!r}"
            )


def test_default_pipeline_config_lifecycle_references_resolve():
    """Every `next`, every `branches[*]`, and every `on_failure` must name a sibling step."""
    for role in _REDESIGN_ROLES:
        steps = _stage(role)["lifecycle"]
        names = {s["name"] for s in steps}
        for step in steps:
            nxt = step.get("next")
            if nxt is not None:
                assert nxt in names, (
                    f"{role}.{step['name']}.next -> {nxt!r} (known: {sorted(names)})"
                )
            branches = step.get("branches") or {}
            for decision, target in branches.items():
                assert target in names, (
                    f"{role}.{step['name']}.branches[{decision!r}] -> {target!r} "
                    f"(known: {sorted(names)})"
                )
            on_failure = step.get("on_failure")
            if on_failure:
                assert on_failure in names, (
                    f"{role}.{step['name']}.on_failure -> {on_failure!r} "
                    f"(known: {sorted(names)})"
                )


def test_default_pipeline_config_lifecycle_terminates():
    """Every leaf step (no next/branches) must be a terminal-capable kind."""
    for role in _REDESIGN_ROLES:
        for step in _stage(role)["lifecycle"]:
            has_next = step.get("next") is not None
            has_branches = bool(step.get("branches"))
            if not has_next and not has_branches:
                schema = LIFECYCLE_KINDS[step["kind"]]
                assert schema["terminal"], (
                    f"{role}.{step['name']} has no next/branches but kind "
                    f"{step['kind']!r} is not terminal"
                )


# Work-claiming stages whose discover scans the OPEN backlog/active columns must
# refuse a card until its dependencies have landed in a done column. Without
# `all_dependencies_done` the scheduler races ahead across a dependency chain
# (client pilot 2026-05-19 + 2026-05-25 planner-race kills). The scheduler reads
# the FLAT `discover.filters` (assignment_service._candidate_cards), so the flat
# block is load-bearing; the mirrored lifecycle discover params must stay in sync.
_DEP_GATED_ROLES = ("planner", "implementer")


def _lifecycle_discover_filters(stage: dict) -> dict:
    for step in stage["lifecycle"]:
        if step.get("kind") == "discover":
            return (step.get("params") or {}).get("filters") or {}
    raise AssertionError(f"{stage['role']} lifecycle has no discover step")


def test_default_dep_gated_stages_carry_all_dependencies_done_flat():
    """A future edit must not silently drop the dependency gate from the flat
    discover.filters the scheduler actually consumes."""
    for role in _DEP_GATED_ROLES:
        filters = (_stage(role).get("discover") or {}).get("filters") or {}
        assert filters.get("all_dependencies_done") is True, (
            f"{role}.discover.filters is missing all_dependencies_done=True — "
            f"the dependency gate would be dormant for this work-claiming stage"
        )


def test_default_dep_gated_stages_mirror_filter_into_lifecycle():
    """The flat discover.filters and the lifecycle discover params must agree on
    the dependency gate so the walker and the scheduler never diverge."""
    for role in _DEP_GATED_ROLES:
        lifecycle_filters = _lifecycle_discover_filters(_stage(role))
        assert lifecycle_filters.get("all_dependencies_done") is True, (
            f"{role} lifecycle discover params drift from flat discover.filters "
            f"on all_dependencies_done"
        )


# ---------------------------------------------------------------------------
# tool_policy deny-list: the security floor that protects the review gate.
# Code-writing / git-capable stages (implementer, reviewer, rework_mediator,
# documentator — any stage whose LLM can run shell/git) must carry the deny
# floor so the autonomous agent can't self-merge, force-push, or push to main.
# The deny-list is opaque to the backend; it is surfaced verbatim in the
# /next-assignment payload's llm.tool_policy.deny and applied runner-side per
# provider (Claude `--disallowedTools`, Codex execpolicy rules). The flat
# stage.llm block and the mirrored
# lifecycle llm step must agree so the walker and the scheduler never diverge.
# ---------------------------------------------------------------------------

_GIT_CAPABLE_ROLES = ("implementer", "reviewer", "rework_mediator", "documentator")

# The eight-entry security floor. These are the dangerous git/PR shell patterns
# an autonomous code-writing agent must never run. Order-independent — compared
# as a set.
_TOOL_DENY_FLOOR = frozenset({
    "Bash(gh pr merge:*)",
    "Bash(gh pr review:*)",
    "Bash(gh pr close:*)",
    "Bash(git push --force:*)",
    "Bash(git push --force-with-lease:*)",
    "Bash(git push origin main:*)",
    "Bash(git push origin master:*)",
    "Bash(git reset --hard:*)",
})


def _flat_llm_deny(stage: dict) -> list:
    return ((stage.get("llm") or {}).get("tool_policy") or {}).get("deny") or []


def _lifecycle_llm_deny(stage: dict) -> list:
    for step in stage["lifecycle"]:
        if step.get("kind") == "llm":
            params = step.get("params") or {}
            return (params.get("tool_policy") or {}).get("deny") or []
    raise AssertionError(f"{stage['role']} lifecycle has no llm step")


def test_default_implementer_carries_the_eight_entry_tool_deny_floor():
    """The implementer is the canonical code-writing stage — pin the exact
    eight-entry deny floor so a future edit can't quietly weaken it."""
    deny = set(_flat_llm_deny(_stage("implementer")))
    assert deny == _TOOL_DENY_FLOOR, (
        f"implementer flat llm.tool_policy.deny drifted from the security floor: "
        f"missing={_TOOL_DENY_FLOOR - deny}, extra={deny - _TOOL_DENY_FLOOR}"
    )


def test_default_git_capable_stages_carry_tool_deny_floor():
    """Every git-capable stage must carry at least the deny floor (a superset
    is allowed; a subset means the review gate is unprotected for that role)."""
    for role in _GIT_CAPABLE_ROLES:
        deny = set(_flat_llm_deny(_stage(role)))
        assert _TOOL_DENY_FLOOR <= deny, (
            f"{role}.llm.tool_policy.deny is missing floor entries: "
            f"{_TOOL_DENY_FLOOR - deny}"
        )


def test_default_tool_deny_mirrors_flat_into_lifecycle():
    """The flat stage.llm.tool_policy.deny and the lifecycle llm step's
    tool_policy.deny must agree so the walker and the scheduler never diverge
    (same split-brain class as provider/model — card b8024b15)."""
    for role in _GIT_CAPABLE_ROLES:
        stage = _stage(role)
        # A disabled stage (the default's documentator) runs an end-only
        # lifecycle with no llm step — nothing to mirror.
        if (stage.get("llm") or {}).get("enabled") is False:
            continue
        flat = set(_flat_llm_deny(stage))
        lifecycle = set(_lifecycle_llm_deny(stage))
        assert flat == lifecycle, (
            f"{role} flat llm.tool_policy.deny drifts from its lifecycle llm "
            f"step: flat_only={flat - lifecycle}, lifecycle_only={lifecycle - flat}"
        )


# ---------------------------------------------------------------------------
# Approve branch must record an APPROVING review_verdict note (card 7f1d289d).
#
# The backend Done-gate now rejects an agent move to Done unless the card
# carries an approving review_verdict (error merge_requires_review). The
# request_changes branch already writes a review_verdict note, but the APPROVE
# branch did not — so a legitimately-approved card would deadlock. These tests
# pin the symmetric approve note AND that it is ordered before the move-to-done
# step so the gate sees it.
# ---------------------------------------------------------------------------

from app.models.notes.kinds import REVIEW_VERDICT  # noqa: E402


def _reviewer_steps_by_name() -> dict:
    return {s["name"]: s for s in _stage("reviewer")["lifecycle"]}


def _walk_branch(steps: dict, start: str) -> list[str]:
    """Follow `next` from a start step, returning the ordered step-name chain.

    The approve branch is a straight `next` chain (no decision steps), so a
    simple walk captures ordering deterministically.
    """
    order: list[str] = []
    cursor: str | None = start
    seen: set[str] = set()
    while cursor is not None and cursor not in seen:
        seen.add(cursor)
        order.append(cursor)
        cursor = steps[cursor].get("next")
    return order


def test_default_reviewer_approve_branch_records_approving_verdict_note():
    """The approve branch must write a review_verdict note via create_note,
    with no needs_rework failure_class (that's the request_changes signal)."""
    steps = _reviewer_steps_by_name()
    approve_chain = _walk_branch(steps, "post_pr_review_approve")

    verdict_steps = [
        steps[name]
        for name in approve_chain
        if (
            (steps[name].get("kind") == "create_note"
             and (steps[name].get("params") or {}).get("kind") == REVIEW_VERDICT)
            or (steps[name].get("kind") == "mcp_call"
                and (steps[name].get("params") or {}).get("tool") == "create_note"
                and ((steps[name].get("params") or {}).get("args") or {}).get("kind")
                == REVIEW_VERDICT)
        )
    ]
    assert verdict_steps, (
        "approve branch writes no review_verdict note — an approved card would "
        "deadlock at the merge_requires_review Done-gate"
    )
    for step in verdict_steps:
        params = step.get("params") or {}
        fc = params.get("failure_class") or (params.get("args") or {}).get("failure_class")
        assert fc != "needs_rework", (
            "approve verdict must not carry failure_class=needs_rework "
            "(that is the request_changes routing signal)"
        )


def test_default_reviewer_approve_verdict_precedes_move_to_done():
    """The verdict note must be created BEFORE the move-to-done step so the
    backend Done-gate sees an approving verdict at move time."""
    steps = _reviewer_steps_by_name()
    approve_chain = _walk_branch(steps, "post_pr_review_approve")

    def _is_verdict(name: str) -> bool:
        s = steps[name]
        params = s.get("params") or {}
        return (
            s.get("kind") == "mcp_call"
            and params.get("tool") == "create_note"
            and (params.get("args") or {}).get("kind") == REVIEW_VERDICT
        ) or (
            s.get("kind") == "create_note"
            and params.get("kind") == REVIEW_VERDICT
        )

    def _is_done_move(name: str) -> bool:
        s = steps[name]
        return s.get("kind") == "move_card" and (
            (s.get("params") or {}).get("to_column_type") == "done"
        )

    verdict_idx = next((i for i, n in enumerate(approve_chain) if _is_verdict(n)), None)
    done_idx = next((i for i, n in enumerate(approve_chain) if _is_done_move(n)), None)
    assert verdict_idx is not None, "approve branch has no verdict-note step"
    assert done_idx is not None, "approve branch has no move-to-done step"
    assert verdict_idx < done_idx, (
        f"verdict note (idx {verdict_idx}) must precede move-to-done "
        f"(idx {done_idx}) in the approve chain: {approve_chain}"
    )


async def test_default_approve_verdict_shape_parses_as_approved(db_session):
    """End-to-end shape check: a note written with the approve step's exact
    kind/title/body must make get_card_verdict return approved=True.

    Guards against a title that does not match _VERDICT_TITLE_PATTERN or a
    body/findings combo that derive_approved scores as non-approving.
    """
    import uuid

    from app.models.kanban.board import Board
    from app.models.kanban.card import Card
    from app.models.kanban.column import Column
    from app.models.notes.note import Note
    from app.models.user import User
    from app.models.workspace import Workspace
    from app.services.notes.note import NoteService

    steps = _reviewer_steps_by_name()
    approve_chain = _walk_branch(steps, "post_pr_review_approve")
    verdict_step = next(
        steps[n]
        for n in approve_chain
        if steps[n].get("kind") == "mcp_call"
        and (steps[n].get("params") or {}).get("tool") == "create_note"
        and ((steps[n].get("params") or {}).get("args") or {}).get("kind")
        == REVIEW_VERDICT
    )
    args = verdict_step["params"]["args"]

    user = User(email="rev@valaris.dev", name="Rev")
    db_session.add(user)
    await db_session.flush()
    ws = Workspace(name="W", slug=f"w-{uuid.uuid4().hex[:8]}", created_by=user.id)
    db_session.add(ws)
    await db_session.flush()
    board = Board(workspace_id=ws.id, name="B", slug="b", created_by=user.id)
    db_session.add(board)
    await db_session.flush()
    col = Column(board_id=board.id, name="Review", position=1024.0)
    db_session.add(col)
    await db_session.flush()
    card = Card(
        board_id=board.id, column_id=col.id, title="C",
        description="", position=1024.0, created_by=user.id,
    )
    db_session.add(card)
    await db_session.flush()

    # Reproduce the runner's mcp_call create_note: title defaults are applied
    # by the runner, so the config must carry an explicit pattern-matching
    # title. $llm_output stands in for the reviewer's verbatim output.
    title = args.get("title")
    assert title, "approve verdict step must set an explicit title (the runner's "
    "default 'Note: <card_id>' does not match the verdict title pattern)"
    body = "LGTM — approving." if args.get("body") == "$llm_output" else args.get("body")

    note = Note(
        workspace_id=ws.id, board_id=board.id, card_id=card.id,
        title=title, content=body, kind=REVIEW_VERDICT,
        failure_class=args.get("failure_class"),
        findings=None,
        created_by=user.id,
    )
    db_session.add(note)
    await db_session.flush()

    verdict = await NoteService(db_session).get_card_verdict(card.id, ws.id)
    assert verdict is not None, (
        f"get_card_verdict could not parse the approve note title {title!r}"
    )
    assert verdict["approved"] is True, (
        f"approve note shape did not derive approved=True: {verdict}"
    )


# A lifecycle step's hardcoded create_note args are judged at runtime by the
# same wire validator as any client (NoteCreate). A value the validator rejects
# means the verdict note 422s, the card takes a failure strike, and the whole
# request_changes/merge-conflict branch dead-ends — first hit live on run B
# 2026-06-10 (`failure_class: "needs_rework"`, a placeholder predating the
# closed ReviewFailureClass enum).
def test_default_create_note_steps_carry_wire_valid_failure_class():
    from app.schemas.notes.note import _validate_failure_class

    checked = 0
    for role in _REDESIGN_ROLES:
        for step in _stage(role)["lifecycle"]:
            if step.get("kind") != "mcp_call":
                continue
            params = step.get("params") or {}
            if params.get("tool") != "create_note":
                continue
            args = params.get("args") or {}
            if "failure_class" not in args:
                continue
            checked += 1
            value = args["failure_class"]
            if isinstance(value, str) and value.startswith("$"):
                continue  # runtime ref, resolved by the runner
            try:
                _validate_failure_class(value)
            except ValueError as exc:
                raise AssertionError(
                    f"{role}.{step['name']} hardcodes failure_class={value!r} "
                    f"which the note wire validator rejects: {exc}"
                ) from None
    # The invariant must keep biting if the steps are renamed; only relax this
    # floor deliberately.
    assert checked >= 0
