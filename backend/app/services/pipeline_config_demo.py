# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Demo-workspace converter: split the planner lifecycle into two `kind: llm` steps.

PIPELINE-UI-CLARITY Phase 5. The new lifecycle-builder UI (Phases 2 + 3) renders
one prompt row per `kind: llm` step on the role card. Every default role in
the platform's DEFAULT_PIPELINE_CONFIG ships with exactly one such step today,
so the new per-step rendering looks identical to the legacy single-prompt-per-
role view.

This converter exists solely to demonstrate the new UI on a demo workspace: it splits
the planner role's single `produce_plan` LLM step into two consecutive steps —
a `scope_llm` step (params.stage="scope") and a `plan_llm` step
(params.stage="plan"). Both inherit the legacy step's provider / model / tools /
inject_directives, so the persisted MCP allowlist enforcement (Option D) and
prompt-injection semantics are unchanged. The trailing chain
(`write_plan_note` -> `planner_unassign_self` -> `planner_apply_planned_label`)
is preserved byte-for-byte.

Why split planner (Option 1) over adding a 6th demo-only role (Option 2)?
  - Honest demo: it shows the platform handles real role partitioning, not just
    a synthetic side-channel.
  - No new role label / wake_role plumbing: the planner's discover filter and
    `planned` label are unchanged, so the runner's role-aware filters keep
    working unmodified.
  - Idempotent: re-running on a config that already carries the split is a
    byte-equal no-op flagged by `applied=False, reason="already_applied"` —
    matching the operator's safe-rerun expectation.

Why this is demo-workspace-only:
  - DEFAULT_PIPELINE_CONFIG is shared by every workspace that hasn't persisted
    its own row. Splitting the platform default would change the demo intent
    for every workspace and is out of scope. The converter is invoked by a
    workspace-specific script (`scripts/apply_demo_double_llm.py`)
    hardcoded to slug `demo-workspace`.

The companion DB-writing script is `backend/scripts/apply_demo_double_llm.py`.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass

# Step names. Distinct from the legacy `produce_plan` so the absence of the old
# name in the post-conversion lifecycle is a positive signal the split applied.
DEMO_SCOPE_STEP_NAME = "scope_llm"
DEMO_PLAN_STEP_NAME = "plan_llm"

# The legacy single-step name in the platform DEFAULT_PIPELINE_CONFIG. The
# converter replaces this step with the two-step pair; if a future DEFAULT
# renames the step the converter will gracefully no-op (legacy step not found
# => already_applied returned, no error raised). The script's caller logs the
# diff so the operator sees this case.
_LEGACY_PLANNER_LLM_STEP_NAME = "produce_plan"

# Subsequent step the legacy `produce_plan` chained into. Preserved as the
# `next` target of the split's terminal `plan_llm` step so the lifecycle
# walker keeps walking into note-writing + unassign + label.
_LEGACY_PLANNER_NEXT_AFTER_LLM = "write_plan_note"

# Failure target the legacy `produce_plan` routed to. Both new llm steps
# inherit this so a failure mid-scope releases the participant slot via the
# existing planner_fail_unassign subtree (no new failure code path).
_LEGACY_PLANNER_LLM_FAILURE_TARGET = "planner_fail_unassign"


@dataclass
class ApplySummary:
    """Reporting record returned by `apply_demo_double_llm`.

    `applied=True` means the converter modified the config and the caller
    should persist + bump version. `applied=False` with `reason="already_applied"`
    means a prior apply is in place and the script should no-op the DB write.
    Other `reason` values (e.g. `planner_role_absent`, `legacy_step_not_found`)
    surface unexpected shapes; the script logs them at WARNING and exits 2.
    """

    applied: bool
    reason: str


def apply_demo_double_llm(config: dict) -> tuple[dict, ApplySummary]:
    """Return `(new_config, summary)`.

    `new_config` is a deep copy of `config` with the planner role's single
    `produce_plan` LLM step replaced by a two-step `scope_llm` -> `plan_llm`
    chain. The original `config` is never mutated.

    Idempotency: if the planner role's lifecycle already carries the two
    named steps, the converter returns a deep copy unchanged and reports
    `applied=False, reason="already_applied"`.
    """
    if not isinstance(config, dict):
        return config, ApplySummary(applied=False, reason="invalid_config_shape")

    new_config = copy.deepcopy(config)
    stages = new_config.get("stages")
    if not isinstance(stages, list):
        return new_config, ApplySummary(
            applied=False, reason="stages_missing_or_invalid"
        )

    planner = next(
        (s for s in stages if isinstance(s, dict) and s.get("role") == "planner"),
        None,
    )
    if planner is None:
        return new_config, ApplySummary(
            applied=False, reason="planner_role_absent"
        )

    lifecycle = planner.get("lifecycle")
    if not isinstance(lifecycle, list) or not lifecycle:
        return new_config, ApplySummary(
            applied=False, reason="planner_lifecycle_absent"
        )

    step_names = {s.get("name") for s in lifecycle if isinstance(s, dict)}
    if DEMO_SCOPE_STEP_NAME in step_names and DEMO_PLAN_STEP_NAME in step_names:
        return new_config, ApplySummary(applied=False, reason="already_applied")

    legacy_idx = next(
        (
            i
            for i, step in enumerate(lifecycle)
            if isinstance(step, dict)
            and step.get("name") == _LEGACY_PLANNER_LLM_STEP_NAME
        ),
        None,
    )
    if legacy_idx is None:
        return new_config, ApplySummary(
            applied=False, reason="legacy_step_not_found"
        )

    legacy_step = lifecycle[legacy_idx]
    legacy_params = legacy_step.get("params") or {}
    legacy_on_failure = legacy_step.get("on_failure", _LEGACY_PLANNER_LLM_FAILURE_TARGET)

    # Rewire every predecessor that referenced the legacy step by name. The
    # planner's discover -> claim chain points `next: produce_plan` today;
    # after the split that target must be `scope_llm` (the new chain head).
    # Branches and on_failure get the same treatment so a future planner
    # config carrying decision branches into the legacy step keeps validating.
    for step in lifecycle:
        if not isinstance(step, dict):
            continue
        if step.get("next") == _LEGACY_PLANNER_LLM_STEP_NAME:
            step["next"] = DEMO_SCOPE_STEP_NAME
        if step.get("on_failure") == _LEGACY_PLANNER_LLM_STEP_NAME:
            step["on_failure"] = DEMO_SCOPE_STEP_NAME
        branches = step.get("branches")
        if isinstance(branches, dict):
            for decision, target in list(branches.items()):
                if target == _LEGACY_PLANNER_LLM_STEP_NAME:
                    branches[decision] = DEMO_SCOPE_STEP_NAME

    scope_step = _build_llm_step(
        name=DEMO_SCOPE_STEP_NAME,
        stage_token="scope",
        legacy_params=legacy_params,
        next_step=DEMO_PLAN_STEP_NAME,
        on_failure=legacy_on_failure,
    )
    plan_step = _build_llm_step(
        name=DEMO_PLAN_STEP_NAME,
        stage_token="plan",
        legacy_params=legacy_params,
        # The terminal LLM hands off into the existing write_plan_note step
        # so $llm_output (the most recent LLM output, i.e. plan_llm's) is
        # persisted as the plan note. write_plan_note is preserved verbatim.
        next_step=legacy_step.get("next", _LEGACY_PLANNER_NEXT_AFTER_LLM),
        on_failure=legacy_on_failure,
    )

    lifecycle[legacy_idx : legacy_idx + 1] = [scope_step, plan_step]

    return new_config, ApplySummary(applied=True, reason="split_planner_llm")


def _build_llm_step(
    *,
    name: str,
    stage_token: str,
    legacy_params: dict,
    next_step: str,
    on_failure: str,
) -> dict:
    """Construct one `kind: llm` step inheriting non-stage params from the
    legacy step. The two steps end up with identical provider / model / tools /
    inject_directives / approval_enabled / post_process_kind so the operator's
    Option-D allowlist + prompt-injection intent carries through both.

    Only `params.stage` differs across the pair (`scope` vs `plan`); that is
    the demo's load-bearing distinction — the new UI renders one prompt row
    per llm step, keyed on the step's name + stage.
    """
    new_params = copy.deepcopy(legacy_params)
    new_params["stage"] = stage_token
    return {
        "name": name,
        "kind": "llm",
        "params": new_params,
        "next": next_step,
        "on_failure": on_failure,
    }
