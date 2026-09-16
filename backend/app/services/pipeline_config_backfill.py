# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Legacy-llm -> lifecycle backfill converter (Phase 4.5).

The frontend's pipeline builder is moving off the legacy single-`llm`-per-role
shape onto the lifecycle DSL. Workspaces whose `pipeline_config` predates the
2026-05-16 redesign still hold a legacy `stages[].llm` block without a
companion `lifecycle[]` array — those render as empty role cards on the new
page even though the legacy data is still live in the DB.

This module's pure-function converter walks a config and, for every stage
that has a legacy `llm.enabled: true` block but no operator-authored
`lifecycle[]`, synthesizes a minimal valid lifecycle that captures the
legacy `llm` parameters.

Contract:
  - Idempotent: re-running on the converter's own output is a no-op.
  - Conservative: stages with BOTH a legacy llm block AND a non-empty
    `lifecycle[]` are left alone — the operator's explicit lifecycle wins.
  - Non-mutating: the input dict is not modified; the converter returns a
    deep copy. The DB-writing script diffs before/after, and a mutating
    converter would erase the diff.
  - Valid: the synthesized lifecycle must pass
    `pipeline_config_validation.py:validate_pipeline_config` — the LLM step
    is non-terminal, so a terminal marker step is appended to satisfy the
    "every leaf is terminal" invariant.

The companion script that runs this against the DB lives at
`backend/scripts/backfill_pipeline_config_lifecycle.py`.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field

# Marker label applied by the synthesized terminal step. Distinctive enough
# that an admin browsing the lifecycle UI immediately sees which stages came
# from backfill (vs operator-authored). Idempotency check below keys on the
# presence of `lifecycle[]` — not the label — so renaming this string later
# does not break re-runs.
_BACKFILL_MARKER_LABEL = "lifecycle-backfilled"

# llm params that the lifecycle `llm` kind accepts verbatim. `enabled` is the
# legacy gate (lifecycle steps don't have an enabled flag — the step's
# presence IS the gate) and is intentionally dropped.
_LLM_LIFECYCLE_PARAM_KEYS = (
    "stage",
    "provider",
    "model",
    "tools",
    "post_process_kind",
    "inject_directives",
    "approval_enabled",
    "use_minimal_prompt_when_unauthored",
)


@dataclass
class BackfillSummary:
    """Aggregate counters reported by the script after each workspace pass.

    `notes` collects human-readable lines (one per skipped-conservative
    stage, one per dropped non-portable legacy key). The script prints them
    verbatim under the per-workspace summary.
    """

    stages_migrated: int = 0
    stages_skipped_conservative: int = 0
    stages_already_lifecycle: int = 0
    notes: list[str] = field(default_factory=list)


def backfill_lifecycle(config: dict) -> tuple[dict, BackfillSummary]:
    """Return `(new_config, summary)`.

    `new_config` is a deep copy of `config` with every eligible stage's
    `lifecycle[]` synthesized from its legacy `llm` block. The original
    `config` is never mutated.
    """
    summary = BackfillSummary()
    if not isinstance(config, dict):
        return config, summary

    new_config = copy.deepcopy(config)
    stages = new_config.get("stages")
    if not isinstance(stages, list):
        return new_config, summary

    for stage in stages:
        if not isinstance(stage, dict):
            continue
        _maybe_backfill_stage(stage, summary)

    return new_config, summary


def _maybe_backfill_stage(stage: dict, summary: BackfillSummary) -> None:
    """Inspect one stage and synthesize its lifecycle when eligible.

    Eligibility matrix:

        legacy_llm.enabled  lifecycle[]      action
        ------------------  -----------     -------
        true                missing/empty   synthesize (`stages_migrated`)
        true                non-empty       skip conservatively
        false               missing/empty   leave alone (no work to represent)
        false               non-empty       already_lifecycle
        absent              non-empty       already_lifecycle
    """
    role = stage.get("role", "<unknown>")
    legacy_llm = stage.get("llm") if isinstance(stage.get("llm"), dict) else None
    lifecycle = stage.get("lifecycle")

    # "Non-empty" means a list with at least one element. `None` and `[]` are
    # both treated as "no operator intent" so the converter can populate them.
    has_operator_lifecycle = isinstance(lifecycle, list) and len(lifecycle) > 0
    llm_enabled = bool(legacy_llm and legacy_llm.get("enabled"))

    if has_operator_lifecycle and llm_enabled:
        summary.stages_skipped_conservative += 1
        summary.notes.append(
            f"stage {role!r}: both legacy llm.enabled=true AND non-empty "
            f"lifecycle[] present — leaving operator lifecycle untouched"
        )
        return

    if has_operator_lifecycle:
        summary.stages_already_lifecycle += 1
        return

    if not llm_enabled:
        # No LLM work and no lifecycle — pure scaffold stage. Nothing to do.
        return

    stage["lifecycle"] = _synthesize_lifecycle(legacy_llm or {}, summary, role)
    summary.stages_migrated += 1


def _synthesize_lifecycle(
    legacy_llm: dict, summary: BackfillSummary, role: str
) -> list[dict]:
    """Build a minimal valid lifecycle from a legacy `llm` block.

    Shape: `[llm_step, marker_label, end]`. `llm` and `apply_label` are both
    non-terminal kinds — `end` is the explicit walk terminator. The marker
    label is innocuous and gives admins a clear hook to spot backfilled
    lifecycles in the new UI.
    """
    llm_params: dict = {}
    for key in _LLM_LIFECYCLE_PARAM_KEYS:
        if key in legacy_llm:
            llm_params[key] = legacy_llm[key]

    # Surface any legacy keys we dropped so the operator can audit them.
    dropped = sorted(
        k for k in legacy_llm.keys()
        if k not in _LLM_LIFECYCLE_PARAM_KEYS and k != "enabled"
    )
    if dropped:
        summary.notes.append(
            f"stage {role!r}: dropped non-lifecycle llm keys {dropped} "
            f"(not part of lifecycle llm.params schema)"
        )

    return [
        {
            "name": "backfilled_llm",
            "kind": "llm",
            "params": llm_params,
            "next": "backfilled_marker",
        },
        {
            "name": "backfilled_marker",
            "kind": "apply_label",
            "params": {"label": _BACKFILL_MARKER_LABEL},
            "next": "backfilled_end",
        },
        {
            "name": "backfilled_end",
            "kind": "end",
            "params": {},
        },
    ]
