# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.workspace import Workspace
from app.models.workspace_config import WorkspaceConfig
from app.services.workspace_config import (
    DEFAULT_PIPELINE_CONFIG,
    WorkspaceConfigService,
)


_EXPECTED_DEFAULT_ROLES = {
    "planner",
    "implementer",
    "reviewer",
    "rework_mediator",
    "documentator",
    "ui_validator",
    "board_reconciler",
}


async def test_get_config_no_db_record_returns_default_pipeline_config(
    client: AsyncClient, test_workspace: Workspace
):
    """No config row in DB -> returns PLATFORM_DEFAULTS with pipeline_config populated."""
    response = await client.get(f"/api/workspaces/{test_workspace.slug}/config")
    assert response.status_code == 200
    data = response.json()

    assert data["pipeline_config"] is not None
    assert data["pipeline_config"]["version"] == 1
    assert len(data["pipeline_config"]["stages"]) == len(_EXPECTED_DEFAULT_ROLES)

    roles = {s["role"] for s in data["pipeline_config"]["stages"]}
    assert roles == _EXPECTED_DEFAULT_ROLES

    # Reviewer-first priority is part of the redesign (unblocks downstream).
    assert data["pipeline_config"]["scheduling"]["priority_order"][0] == "reviewer"
    assert set(data["pipeline_config"]["scheduling"]["priority_order"]) == _EXPECTED_DEFAULT_ROLES


async def test_get_config_null_pipeline_config_seeds_default(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    """DB record with pipeline_config=None -> lazy-seeds the default."""
    config = WorkspaceConfig(
        workspace_id=test_workspace.id,
        max_rework_attempts=5,
        pipeline_config=None,
    )
    db_session.add(config)
    await db_session.flush()

    response = await client.get(f"/api/workspaces/{test_workspace.slug}/config")
    assert response.status_code == 200
    data = response.json()

    assert data["max_rework_attempts"] == 5
    assert data["pipeline_config"] is not None
    assert data["pipeline_config"]["version"] == 1
    assert len(data["pipeline_config"]["stages"]) == len(_EXPECTED_DEFAULT_ROLES)

    roles = {s["role"] for s in data["pipeline_config"]["stages"]}
    assert roles == _EXPECTED_DEFAULT_ROLES

    # Version bumped because of the lazy-seed update
    assert data["version"] == 2


async def test_get_config_custom_pipeline_config_unchanged(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    """DB record with custom pipeline_config -> returns as-is, no seeding."""
    custom_pipeline = {
        "version": 99,
        "stages": [{"role": "custom_role"}],
        "scheduling": {"priority_order": ["custom_role"]},
    }
    config = WorkspaceConfig(
        workspace_id=test_workspace.id,
        pipeline_config=custom_pipeline,
    )
    db_session.add(config)
    await db_session.flush()

    response = await client.get(f"/api/workspaces/{test_workspace.slug}/config")
    assert response.status_code == 200
    data = response.json()

    assert data["pipeline_config"] == custom_pipeline
    assert data["pipeline_config"]["version"] == 99
    assert len(data["pipeline_config"]["stages"]) == 1
    assert data["pipeline_config"]["stages"][0]["role"] == "custom_role"


async def test_default_pipeline_config_structure():
    """DEFAULT_PIPELINE_CONFIG composes the 5-role redesign (2026-05-16).

    Per-role lifecycle invariants live in
    tests/services/test_default_pipeline_5role.py and
    tests/services/test_default_pipeline_config_lifecycle.py — this test
    pins the top-level shape so a future schema-wide regression surfaces
    here too.
    """
    assert DEFAULT_PIPELINE_CONFIG["version"] == 1
    assert len(DEFAULT_PIPELINE_CONFIG["stages"]) == 7

    roles = {s["role"] for s in DEFAULT_PIPELINE_CONFIG["stages"]}
    assert roles == _EXPECTED_DEFAULT_ROLES

    implementer = next(
        s for s in DEFAULT_PIPELINE_CONFIG["stages"] if s["role"] == "implementer"
    )
    assert implementer["discover"]["strategy"] == "unassigned_or_rework"
    assert implementer["claim"]["execution_action"] == "implement_card"
    assert implementer["git"]["create_pr"] is True
    assert implementer["llm"]["stage"] == "implement"
    assert implementer["llm"]["inject_directives"] is True

    reviewer = next(
        s for s in DEFAULT_PIPELINE_CONFIG["stages"] if s["role"] == "reviewer"
    )
    assert reviewer["discover"]["strategy"] == "column_scan"
    assert reviewer["discover"]["filters"]["require_pr_url"] is True
    # F-14 canonical: skip_if_pipeline_role, not skip_if_participant_role.
    assert reviewer["discover"]["filters"]["skip_if_pipeline_role"] == "reviewer"

    documentator = next(
        s for s in DEFAULT_PIPELINE_CONFIG["stages"] if s["role"] == "documentator"
    )
    # documentator excludes both already-documented cards and ui-validation
    # cards (the latter route to the ui_validator, not docs).
    assert documentator["discover"]["filters"]["exclude_label"] == [
        "documented",
        "needs-ui-validation",
        "blocked",
        "awaiting-approval",
    ]
    # documentator ships disabled in the default; an operator enables it.
    assert documentator["llm"]["enabled"] is False

    scheduling = DEFAULT_PIPELINE_CONFIG["scheduling"]
    assert scheduling["mode"] == "priority"
    assert scheduling["priority_order"][0] == "reviewer"
    assert set(scheduling["priority_order"]) == _EXPECTED_DEFAULT_ROLES


async def test_default_pipeline_config_marks_all_roles_unique():
    """Each platform-shipped role enforces one-per-team uniqueness."""
    for stage in DEFAULT_PIPELINE_CONFIG["stages"]:
        assert (
            stage["unique"] is True
        ), f"default stage {stage['role']!r} must have unique=True"


async def test_default_pipeline_planner_carries_in_flight_gate():
    """SCH-2 (spec note 233e4429 §Part B): the planner stage opts into the
    no_other_card_in_flight gate so client-pilot-style planner races stop on
    the first deploy after this lands.

    Pin both surfaces: the legacy `discover.filters` block and the
    `discover_backlog` lifecycle step's params. They must stay in sync —
    the validator's F-13/14 surface treats them as the same filter set.
    """
    planner = next(
        s for s in DEFAULT_PIPELINE_CONFIG["stages"] if s["role"] == "planner"
    )
    legacy_filters = planner["discover"]["filters"]
    assert legacy_filters.get("no_other_card_in_flight") is True, (
        f"planner.discover.filters missing the in-flight gate; "
        f"got {legacy_filters!r}"
    )

    lifecycle = planner["lifecycle"]
    discover_step = next(s for s in lifecycle if s["name"] == "discover_backlog")
    lifecycle_filters = discover_step["params"]["filters"]
    assert lifecycle_filters.get("no_other_card_in_flight") is True, (
        f"planner lifecycle discover_backlog filters missing the in-flight gate; "
        f"got {lifecycle_filters!r}"
    )


async def test_default_pipeline_build_roles_exclude_blocked_label():
    """run-B FIX #5 (config half): a `blocked` label must make a card
    invisible to every build role regardless of column. The runner's no-change
    backstop applies `blocked` intrinsically; these excludes guarantee the card
    is un-reservable even on a board with NO `blocked` column.

    Pin BOTH surfaces — the role-level discover filters AND the lifecycle
    discover-step mirrors. A past incident (scheduler eligibility split-brain)
    came from a predicate living in only one of the two places.
    """
    build_roles = {
        "planner",
        "implementer",
        "reviewer",
        "rework_mediator",
        "documentator",
    }

    def excluded(filters: dict) -> list[str]:
        value = filters.get("exclude_label")
        return [value] if isinstance(value, str) else list(value or [])

    for stage in DEFAULT_PIPELINE_CONFIG["stages"]:
        role = stage["role"]
        if role not in build_roles:
            continue
        assert "blocked" in excluded(stage["discover"]["filters"]), (
            f"{role}.discover.filters.exclude_label missing 'blocked'"
        )
        for step in stage["lifecycle"]:
            if step["kind"] != "discover":
                continue
            assert "blocked" in excluded(step["params"]["filters"]), (
                f"{role} lifecycle step {step['name']!r} filters missing "
                f"'blocked' in exclude_label"
            )


async def test_default_pipeline_build_roles_exclude_awaiting_approval_label():
    """Sibling of the `blocked` exclusion: the runner's approval park-and-continue
    applies `awaiting-approval` to a card whose stage raised a human approval.
    The card must be invisible to every build role until the approval is decided
    — same intrinsic-park contract as `blocked`, both surfaces pinned.
    """
    build_roles = {
        "planner",
        "implementer",
        "reviewer",
        "rework_mediator",
        "documentator",
    }

    def excluded(filters: dict) -> list[str]:
        value = filters.get("exclude_label")
        return [value] if isinstance(value, str) else list(value or [])

    for stage in DEFAULT_PIPELINE_CONFIG["stages"]:
        role = stage["role"]
        if role not in build_roles:
            continue
        assert "awaiting-approval" in excluded(stage["discover"]["filters"]), (
            f"{role}.discover.filters.exclude_label missing 'awaiting-approval'"
        )
        for step in stage["lifecycle"]:
            if step["kind"] != "discover":
                continue
            assert "awaiting-approval" in excluded(step["params"]["filters"]), (
                f"{role} lifecycle step {step['name']!r} filters missing "
                f"'awaiting-approval' in exclude_label"
            )


async def test_default_pipeline_stages_have_provider_and_model():
    """Every stage's `llm` block carries a `provider` + `model` string so the
    backend is authoritative about which LLM serves each pipeline stage. The
    runner's yaml fallback (`cfg.LLM.Model`) is a one-deploy safety net; the
    desired steady state is backend-declared per-stage."""
    for stage in DEFAULT_PIPELINE_CONFIG["stages"]:
        llm = stage["llm"]
        assert isinstance(llm.get("provider"), str) and llm["provider"], (
            f"stage {stage['role']!r}.llm.provider must be a non-empty string "
            f"(got {llm.get('provider')!r})"
        )
        assert isinstance(llm.get("model"), str) and llm["model"], (
            f"stage {stage['role']!r}.llm.model must be a non-empty string "
            f"(got {llm.get('model')!r})"
        )


async def test_default_pipeline_reviewer_inject_directives_is_true():
    """REV-1: project_reviewer_inject_directives_asymmetry.md — the reviewer
    historically had inject_directives=False as a hedge against Sonnet
    over-fixating on directives during review. Both orchestrator and reviewer
    are now Opus-capable, and the smoke 2026-05-14 surfaced reviewer leniency
    on directive-violation scope expansions. Flip the default ON so platform
    directives reach the reviewer the same way they reach the implementer."""
    reviewer = next(
        s for s in DEFAULT_PIPELINE_CONFIG["stages"] if s["role"] == "reviewer"
    )
    assert reviewer["llm"]["inject_directives"] is True


# ---------------------------------------------------------------------------
# Phase 4: LLM-lifecycle contract — runner owns note-writing.
#
# Planner + rework_mediator now emit their plan / rework_brief notes via a
# lifecycle `mcp_call` step (Shape B), not via an LLM tool call. The reviewer's
# request_changes branch carries `failure_class: needs_rework` on its verdict
# note so the rework_mediator's role-aware discover filter can find it.
# ---------------------------------------------------------------------------


def _stage_by_role(role: str) -> dict:
    return next(s for s in DEFAULT_PIPELINE_CONFIG["stages"] if s["role"] == role)


def _lifecycle_steps(stage: dict) -> list[dict]:
    return stage.get("lifecycle") or []


def test_default_pipeline_planner_emits_create_note_mcp_call_step():
    """Planner lifecycle must include an mcp_call create_note step that writes
    the plan note from `$llm_output`. apply_label(planned) chains into
    move_card(active) so the implementer's column-scan picks the card up next.
    """
    planner = _stage_by_role("planner")
    matching = [
        s for s in _lifecycle_steps(planner)
        if s.get("kind") == "mcp_call"
        and (s.get("params") or {}).get("tool") == "create_note"
        and ((s.get("params") or {}).get("args") or {}).get("kind") == "plan"
    ]
    assert matching, (
        f"planner lifecycle must carry an mcp_call create_note step writing the "
        f"plan note, got steps {[s.get('name') for s in _lifecycle_steps(planner)]!r}"
    )
    args = matching[0]["params"]["args"]
    assert args.get("body") == "$llm_output", (
        f"plan-note step must copy $llm_output into body, got {args!r}"
    )


def test_default_pipeline_planner_drops_create_card_from_tools():
    """Locked decision #6: planner's tools allowlist must NOT include
    create_card — sibling-card creation is out of scope for the planner."""
    planner = _stage_by_role("planner")
    llm_tools = planner["llm"].get("tools") or []
    assert "mcp__valaris__create_card" not in llm_tools, (
        f"planner llm.tools must drop create_card, got {llm_tools!r}"
    )
    # And the same applies to the per-step tools list inside lifecycle.produce_plan.
    produce_plan = next(
        s for s in _lifecycle_steps(planner) if s.get("name") == "produce_plan"
    )
    step_tools = (produce_plan.get("params") or {}).get("tools") or []
    assert "mcp__valaris__create_card" not in step_tools, (
        f"planner lifecycle produce_plan.params.tools must drop create_card, "
        f"got {step_tools!r}"
    )


def test_default_pipeline_planner_happy_path_ends_in_move_to_active():
    """Closes the planner -> implementer handoff: after labeling planned,
    the planner moves the card to the `active` column so the implementer
    role's column_scan picks it up. Without this the backlog piles up
    planned cards while planner walks the whole queue (client pilot 2026-05-19).
    """
    planner = _stage_by_role("planner")
    steps = {s["name"]: s for s in _lifecycle_steps(planner)}

    label = steps.get("planner_apply_planned_label")
    assert label is not None, "planner must keep the planner_apply_planned_label step"
    assert label.get("next") == "planner_ship_to_active", (
        f"planner_apply_planned_label must chain into the move step, got next="
        f"{label.get('next')!r}"
    )

    ship = steps.get("planner_ship_to_active")
    assert ship is not None, "planner must add a planner_ship_to_active step"
    assert ship.get("kind") == "move_card"
    assert (ship.get("params") or {}).get("to_column_type") == "active"


def test_default_pipeline_planner_drops_create_note_from_tools():
    """Locked decision #6: the lifecycle writes the plan note now, so the
    planner LLM no longer needs the create_note tool — drop it from the
    allowlist to prevent duplicate/conflicting notes."""
    planner = _stage_by_role("planner")
    llm_tools = planner["llm"].get("tools") or []
    assert "mcp__valaris__create_note" not in llm_tools, (
        f"planner llm.tools must drop create_note, got {llm_tools!r}"
    )
    produce_plan = next(
        s for s in _lifecycle_steps(planner) if s.get("name") == "produce_plan"
    )
    step_tools = (produce_plan.get("params") or {}).get("tools") or []
    assert "mcp__valaris__create_note" not in step_tools, (
        f"planner lifecycle produce_plan.params.tools must drop create_note, "
        f"got {step_tools!r}"
    )


def test_default_pipeline_implementer_fail_path_returns_card_to_active():
    """Closes a deadlock surfaced on the client pilot (2026-05-26): when implement
    fails (or produces no changes), the card must return to the `active` column
    where the implementer's own `unassigned_or_rework` discover re-claims it —
    NOT to `backlog`. A planned card sent to backlog is stranded forever: the
    planner skips it (exclude_label=planned) and the implementer never scans
    backlog. The fail-path removes the participant first, so re-claim is clean.
    """
    implementer = _stage_by_role("implementer")
    steps = {s["name"]: s for s in _lifecycle_steps(implementer)}

    move_back = steps.get("implementer_fail_move_back")
    assert move_back is not None, (
        "implementer must keep the implementer_fail_move_back step"
    )
    assert move_back.get("kind") == "move_card"
    assert (move_back.get("params") or {}).get("to_column_type") == "active", (
        f"implementer fail-path must return the card to `active` (where the "
        f"implementer rescans), not backlog, got "
        f"{(move_back.get('params') or {}).get('to_column_type')!r}"
    )


def test_default_pipeline_rework_mediator_emits_create_note_step():
    """Rework_mediator lifecycle must include an mcp_call create_note step
    writing the rework_brief note before wake_implementer."""
    mediator = _stage_by_role("rework_mediator")
    steps = _lifecycle_steps(mediator)
    matching = [
        s for s in steps
        if s.get("kind") == "mcp_call"
        and (s.get("params") or {}).get("tool") == "create_note"
        and ((s.get("params") or {}).get("args") or {}).get("kind") == "rework_brief"
    ]
    assert matching, (
        f"rework_mediator lifecycle must carry an mcp_call create_note step "
        f"writing the rework_brief note, got steps {[s.get('name') for s in steps]!r}"
    )
    args = matching[0]["params"]["args"]
    assert args.get("body") == "$llm_output", (
        f"rework_brief step must copy $llm_output into body, got {args!r}"
    )


def test_default_pipeline_reviewer_request_changes_omits_hardcoded_failure_class():
    """The reviewer's request_changes verdict-note step must NOT hardcode a
    failure_class. The rework_mediator routes on the note KIND
    (require_note_kind_newer_than), not failure_class, and the wire validator
    rejects values outside the ReviewFailureClass enum — the old hardcoded
    "needs_rework" 422'd every request_changes verdict (run B, 2026-06-10).
    A future $llm_failure_class runtime ref may pass the reviewer's declared
    class through; until then the field stays absent (null on the wire)."""
    reviewer = _stage_by_role("reviewer")
    steps = _lifecycle_steps(reviewer)
    # The reviewer writes a verdict note on BOTH branches; select the
    # request_changes one by name rather than position.
    request_changes_verdict = next(
        (
            s for s in steps
            if s.get("name") == "request_changes_write_verdict"
            and (s.get("params") or {}).get("tool") == "create_note"
        ),
        None,
    )
    assert request_changes_verdict is not None, (
        f"reviewer lifecycle must keep the request_changes_write_verdict "
        f"create_note step, got steps {[s.get('name') for s in steps]!r}"
    )
    args = request_changes_verdict["params"]["args"]
    assert "failure_class" not in args, (
        f"request_changes verdict-note step must not hardcode failure_class, got {args!r}"
    )


def test_default_pipeline_validator_accepts_new_default():
    """End-to-end: shipping default must validate without blocking errors
    after the Phase 4 rewrite."""
    import copy

    from app.services.pipeline_config_validation import validate_pipeline_config

    findings = validate_pipeline_config(copy.deepcopy(DEFAULT_PIPELINE_CONFIG))
    blocking = [f for f in findings if f.get("severity", "error") == "error"]
    assert blocking == [], (
        f"DEFAULT_PIPELINE_CONFIG must validate cleanly post-Phase-4, "
        f"got blocking errors {blocking!r}"
    )


async def test_default_pipeline_config_create_branch_stages_target_integration_branch():
    """Every create_branch stage must fork from `integration_branch`, not main.

    PAR-1 shipped runner-side `--base` plumbing AND a `GitRepo.integration_branch`
    schema column, but the workspace pipeline_config defaults never carried
    `git.base_ref="integration_branch"`. Result: every new workspace silently
    routed PRs to `main` even when integration_branch was set on the GitRepo.
    The affected workspace was patched live; this guards every other workspace.

    `checkout_pr_branch` stages (reviewer, rework_mediator) intentionally have
    no base_ref — they operate on the existing PR branch.
    Planner uses `action: none` (no branch); irrelevant.
    """
    create_branch_stages = [
        s for s in DEFAULT_PIPELINE_CONFIG["stages"]
        if s["git"]["action"] == "create_branch"
    ]
    assert {s["role"] for s in create_branch_stages} == {"implementer", "documentator"}, (
        "expected implementer + documentator to be the create_branch stages"
    )
    for stage in create_branch_stages:
        assert stage["git"].get("base_ref") == "integration_branch", (
            f"stage {stage['role']!r} must fork from integration_branch, "
            f"got base_ref={stage['git'].get('base_ref')!r}"
        )


def test_default_pipeline_reviewer_tools_include_search_cards():
    """P1 (post-run-B 2026-06-10): the reviewer's integration-honesty check
    must verify that a deferred fake/stub has an EXISTING board card owning its
    replacement — that lookup needs search_cards in the tools allowlist, both
    on the flat llm block and the load-bearing lifecycle review_diff step."""
    reviewer = _stage_by_role("reviewer")
    llm_tools = reviewer["llm"].get("tools") or []
    assert "mcp__valaris__search_cards" in llm_tools, (
        f"reviewer llm.tools must include search_cards, got {llm_tools!r}"
    )
    review_diff = next(
        s for s in _lifecycle_steps(reviewer) if s.get("name") == "review_diff"
    )
    step_tools = (review_diff.get("params") or {}).get("tools") or []
    assert "mcp__valaris__search_cards" in step_tools, (
        f"reviewer lifecycle review_diff.params.tools must include search_cards, "
        f"got {step_tools!r}"
    )


def test_default_pipeline_implementer_tools_include_add_card_dependency():
    """P3/P4 (post-run-B 2026-06-10): when the implementer files an
    interim-seam follow-up card it must be able to chain that card under the
    board's acceptance card via add_card_dependency — both on the flat llm
    block and the lifecycle implement_code step."""
    implementer = _stage_by_role("implementer")
    llm_tools = implementer["llm"].get("tools") or []
    assert "mcp__valaris__add_card_dependency" in llm_tools, (
        f"implementer llm.tools must include add_card_dependency, got {llm_tools!r}"
    )
    implement_code = next(
        s for s in _lifecycle_steps(implementer) if s.get("name") == "implement_code"
    )
    step_tools = (implement_code.get("params") or {}).get("tools") or []
    assert "mcp__valaris__add_card_dependency" in step_tools, (
        f"implementer lifecycle implement_code.params.tools must include "
        f"add_card_dependency, got {step_tools!r}"
    )


def test_default_pipeline_implementer_tools_include_skill_proposal_surface():
    """Skills self-improvement: the implementer is the stage that discovers
    reusable methodology while coding, so it carries the propose surface —
    propose_skill to submit (risk-60 human approval decides; the serve-side
    skills_proposal_enabled strip removes it where a board opts out) plus
    list_skills/get_skill to read the catalog before proposing a duplicate.
    Pinned on both the flat llm block and the lifecycle implement_code step,
    which must agree (card b8024b15 split-brain guard)."""
    implementer = _stage_by_role("implementer")
    implement_code = next(
        s for s in _lifecycle_steps(implementer) if s.get("name") == "implement_code"
    )
    skill_tools = {
        "mcp__valaris__list_skills",
        "mcp__valaris__get_skill",
        "mcp__valaris__propose_skill",
    }
    for label, tools in (
        ("llm.tools", implementer["llm"].get("tools") or []),
        (
            "lifecycle implement_code.params.tools",
            (implement_code.get("params") or {}).get("tools") or [],
        ),
    ):
        missing = skill_tools - set(tools)
        assert not missing, (
            f"implementer {label} must carry the skills proposal surface, "
            f"missing {sorted(missing)} in {tools!r}"
        )


# ===========================================================================
# Config-backfill: an existing workspace whose STORED pipeline_config predates a
# new default role (e.g. a client's frozen v5, created before board_reconciler)
# does not inherit it — so role-keyed cures (A1b/FCH-1 via board_reconciler) are
# inert there. get_config does a READ-TIME additive merge: it appends an
# allow-listed missing default role (+ its priority_order entry) WITHOUT mutating
# the stored row or any existing stage. Gated so a hand-rolled custom pipeline
# (no `implementer` marker) and an opted-out config (`lock_roles`) are untouched.
# ===========================================================================
def _six_role_config_without_reconciler() -> dict:
    """A realistic pre-board_reconciler stored config: the 6 default roles that
    existed before 2026-06-26, carrying the `implementer` marker that identifies
    it as a real default-derived pipeline (vs a bespoke custom one)."""
    roles = [
        "planner", "implementer", "reviewer",
        "rework_mediator", "documentator", "ui_validator",
    ]
    return {
        "version": 5,
        "stages": [{"role": r, "discover": {"filters": {}}} for r in roles],
        "scheduling": {"mode": "priority", "priority_order": list(roles)},
    }


async def test_get_config_backfills_board_reconciler_into_default_derived_config(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    """A stored 6-role config (default-derived, has `implementer`, no
    board_reconciler) gains board_reconciler at read time — so A1b/FCH-1 arm on
    boards frozen before the role existed (a client production run). The added stage equals the
    DEFAULT board_reconciler stage; priority_order gains the role too."""
    config = WorkspaceConfig(
        workspace_id=test_workspace.id,
        pipeline_config=_six_role_config_without_reconciler(),
    )
    db_session.add(config)
    await db_session.flush()

    response = await client.get(f"/api/workspaces/{test_workspace.slug}/config")
    assert response.status_code == 200
    pc = response.json()["pipeline_config"]

    roles = [s["role"] for s in pc["stages"]]
    assert "board_reconciler" in roles, (
        f"board_reconciler must be backfilled into a default-derived config; "
        f"got {roles}"
    )
    assert "board_reconciler" in pc["scheduling"]["priority_order"]
    # The backfilled stage is the DEFAULT one (the cure depends on its lifecycle).
    default_recon = next(
        s for s in DEFAULT_PIPELINE_CONFIG["stages"] if s["role"] == "board_reconciler"
    )
    merged_recon = next(s for s in pc["stages"] if s["role"] == "board_reconciler")
    assert merged_recon == default_recon
    # The original 6 stages are untouched (additive only).
    assert roles[:6] == [
        "planner", "implementer", "reviewer",
        "rework_mediator", "documentator", "ui_validator",
    ]


async def test_get_config_backfill_respects_lock_roles_optout(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    """A config that sets `lock_roles: true` freezes its role set — no backfill,
    even though it's default-derived and missing board_reconciler."""
    locked = _six_role_config_without_reconciler()
    locked["lock_roles"] = True
    config = WorkspaceConfig(
        workspace_id=test_workspace.id, pipeline_config=locked
    )
    db_session.add(config)
    await db_session.flush()

    response = await client.get(f"/api/workspaces/{test_workspace.slug}/config")
    assert response.status_code == 200
    roles = {s["role"] for s in response.json()["pipeline_config"]["stages"]}
    assert "board_reconciler" not in roles, "lock_roles must suppress the backfill"


async def test_get_config_backfill_skips_non_default_custom_config(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    """A hand-rolled custom pipeline (no `implementer` marker) is NOT a
    default-derived config — it must be returned untouched, never gaining a
    backfilled role. Guards the existing custom-config contract."""
    custom = {
        "version": 3,
        "stages": [{"role": "custom_role"}, {"role": "another_custom"}],
        "scheduling": {"priority_order": ["custom_role", "another_custom"]},
    }
    config = WorkspaceConfig(
        workspace_id=test_workspace.id, pipeline_config=custom
    )
    db_session.add(config)
    await db_session.flush()

    response = await client.get(f"/api/workspaces/{test_workspace.slug}/config")
    assert response.status_code == 200
    pc = response.json()["pipeline_config"]
    assert pc == custom, "a non-default-derived custom config must be untouched"


async def test_get_config_backfill_no_double_add_when_reconciler_present(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    """A config that ALREADY has board_reconciler (even a customized one) is not
    double-added and its custom stage wins — the merge is idempotent + additive."""
    cfg = _six_role_config_without_reconciler()
    custom_recon = {"role": "board_reconciler", "discover": {"filters": {"custom": 1}}}
    cfg["stages"].append(custom_recon)
    cfg["scheduling"]["priority_order"].append("board_reconciler")
    config = WorkspaceConfig(workspace_id=test_workspace.id, pipeline_config=cfg)
    db_session.add(config)
    await db_session.flush()

    response = await client.get(f"/api/workspaces/{test_workspace.slug}/config")
    assert response.status_code == 200
    pc = response.json()["pipeline_config"]
    recon_stages = [s for s in pc["stages"] if s["role"] == "board_reconciler"]
    assert len(recon_stages) == 1, "must not double-add board_reconciler"
    assert recon_stages[0] == custom_recon, "the operator's custom stage wins"


# ===========================================================================
# include_warnings: the runner's next_assignment hot path calls get_config per
# poll and never reads context_source_warnings, yet the lint loads + parses ALL
# authored prompt contents on every call. include_warnings=False lets the
# scheduler skip that work while keeping the API/UI byte-identical (default
# True) and — critically — keeping the config-backfill levers running.
# ===========================================================================
async def test_get_config_scheduler_mode_skips_prompt_content_loads(
    db_session: AsyncSession, test_workspace: Workspace, monkeypatch
):
    """include_warnings=False must not load authored prompt contents — that is
    the whole cost the hot path is paying for warnings it never reads."""
    config = WorkspaceConfig(
        workspace_id=test_workspace.id,
        pipeline_config=_six_role_config_without_reconciler(),
    )
    db_session.add(config)
    await db_session.flush()

    calls: list = []

    async def _spy_load(self, workspace_id):
        calls.append(workspace_id)
        return {}

    monkeypatch.setattr(
        "app.services.agents.prompt_config.PromptConfigService.load_prompt_contents",
        _spy_load,
    )

    result = await WorkspaceConfigService(db_session).get_config(
        test_workspace.id, include_warnings=False
    )

    assert calls == [], "scheduler mode must not load prompt contents"
    # The warnings key is present but empty so callers stay shape-stable.
    assert result["context_source_warnings"] == []


async def test_get_config_default_mode_still_loads_and_lints(
    db_session: AsyncSession, test_workspace: Workspace, monkeypatch
):
    """The default (include_warnings=True) path is unchanged: it still loads
    prompt contents to compute warnings for the API/UI."""
    config = WorkspaceConfig(
        workspace_id=test_workspace.id,
        pipeline_config=_six_role_config_without_reconciler(),
    )
    db_session.add(config)
    await db_session.flush()

    calls: list = []

    async def _spy_load(self, workspace_id):
        calls.append(workspace_id)
        return {}

    monkeypatch.setattr(
        "app.services.agents.prompt_config.PromptConfigService.load_prompt_contents",
        _spy_load,
    )

    await WorkspaceConfigService(db_session).get_config(test_workspace.id)

    assert calls == [test_workspace.id], "default mode must still lint"


async def test_get_config_scheduler_mode_backfills_default_roles(
    db_session: AsyncSession, test_workspace: Workspace
):
    """The read-time additive role-merge is a config lever, not a lint — it MUST
    run in scheduler mode so A1b/FCH-1 arm on the hot path too."""
    config = WorkspaceConfig(
        workspace_id=test_workspace.id,
        pipeline_config=_six_role_config_without_reconciler(),
    )
    db_session.add(config)
    await db_session.flush()

    result = await WorkspaceConfigService(db_session).get_config(
        test_workspace.id, include_warnings=False
    )

    roles = {s["role"] for s in result["pipeline_config"]["stages"]}
    assert "board_reconciler" in roles, (
        "the additive default-role backfill must run even in scheduler mode"
    )


async def test_get_config_scheduler_mode_seeds_null_pipeline(
    db_session: AsyncSession, test_workspace: Workspace
):
    """The write-on-read null-pipeline seed is a config-backfill lever too — it
    must fire in scheduler mode, persisting the default and bumping version."""
    config = WorkspaceConfig(
        workspace_id=test_workspace.id,
        max_rework_attempts=5,
        pipeline_config=None,
    )
    db_session.add(config)
    await db_session.flush()

    result = await WorkspaceConfigService(db_session).get_config(
        test_workspace.id, include_warnings=False
    )

    assert result["pipeline_config"] is not None
    assert result["version"] == 2, "the seed write-on-read must bump version"


async def test_get_config_backfill_requires_core_trio_not_just_implementer(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    """A bespoke pipeline that merely reuses the role name `implementer` (but
    lacks the planner+reviewer core trio) is NOT default-derived → no backfill.
    Hardens the discriminator past a single-role marker (adversarial review #4)."""
    bespoke = {
        "version": 2,
        "stages": [{"role": "implementer"}, {"role": "my_orchestrator"}],
        "scheduling": {"priority_order": ["implementer", "my_orchestrator"]},
    }
    config = WorkspaceConfig(
        workspace_id=test_workspace.id, pipeline_config=bespoke
    )
    db_session.add(config)
    await db_session.flush()

    response = await client.get(f"/api/workspaces/{test_workspace.slug}/config")
    assert response.status_code == 200
    pc = response.json()["pipeline_config"]
    assert pc == bespoke, (
        "a bespoke config with `implementer` but no planner/reviewer trio must "
        "not be backfilled"
    )
