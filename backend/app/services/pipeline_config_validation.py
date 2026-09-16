# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Pipeline config validation (Phase I.1.b).

Validates referential integrity of a workspace pipeline_config before persisting
it. Errors are actionable: each carries a `code`, the `field` path where the
problem lives, and a human-readable `message` naming the offending value.

The rules mirror the runtime expectations of the Go agent's strategy engine
(`runner/internal/workloop/strategy_generic.go`). Sensor-name validation is
intentionally deferred to I.1.c, which will supply the sensor catalog.
"""

from __future__ import annotations

import uuid
from typing import Any

from app.services.agents.lifecycle_kinds import LIFECYCLE_KINDS
from app.services.llm_tiers import model_value_error

# Allowed enum values for pipeline config fields. Changes here must stay in
# sync with runner/internal/workloop/config_validate.go and the harness docs.
_DISCOVER_STRATEGIES = frozenset({"unassigned_or_rework", "column_scan"})
_CLAIM_ROLES = frozenset({"hero", "helper"})
_SCHEDULING_MODES = frozenset({"priority", "round_robin"})
_GIT_ACTIONS = frozenset(
    {"create_branch", "checkout_pr_branch", "checkout_integration_head", "none", ""}
)
# PAR-1: closed enum mirrored in runner/internal/valaris/types.go (GitBaseRefs).
# "default_branch" preserves pre-PAR-1 behavior; "integration_branch" forks new
# branches off the repo's configured staging ground so concurrent runners see
# each other's in-flight work.
_GIT_BASE_REFS = frozenset({"default_branch", "integration_branch"})

# Closed set of allowed keys under `discover.filters`. Tightens what used to be
# an open map; unknown keys silently disabled the filter (e.g. typos like
# `skip_if_partcipant_role`). Each new primitive lands here.
_DISCOVER_FILTER_KEYS = frozenset({
    "require_git_repo",
    "require_pr_url",
    "exclude_label",
    "require_label",
    "include_label",   # legacy alias of `label` / `require_label`
    "label",           # legacy alias kept for back-compat
    "skip_if_pipeline_role",
    "require_pipeline_role",
    "skip_if_participant_role",   # DEPRECATED alias of skip_if_pipeline_role
    "require_participant_role",   # DEPRECATED alias of require_pipeline_role
    # Opts a review-kind stage out of the runner's defaulted self-participation
    # guard (see selfParticipationGuardRole in strategy_generic.go). Only
    # meaningful when no skip_if_* key is set — an explicit skip key always wins.
    "allow_self_participant",
    "require_note_kind",
    "require_note_failure_class",
    # Cluster II Gap 2: mediator note-freshness gate. Dict {kind, than_kind}:
    # eligible only when the card's newest `kind` note is newer than its
    # newest `than_kind` note. Replaces the exclude_label re-spin workaround.
    "require_note_kind_newer_than",
    # SCH-1: sequential-scheduling primitives. See spec note 233e4429 §Part B.
    # `no_other_card_in_flight`: candidate's board has zero ACTIVELY-WORKED
    #   cards (participant or live reservation) in active/review. A card
    #   parked there with neither is dead state, not in-flight.
    # `all_dependencies_done`: every `card_dependencies` row for the candidate
    #   resolves to a `done` column. Soft-passes when the table is missing.
    "no_other_card_in_flight",
    "all_dependencies_done",
    # Wave gating: pins a role to specific column(s) by identity. `column_type`
    # cannot separate sibling columns that share a type (Backlog vs To Do, both
    # column_type=backlog), so splitting a board into waves had no effect on
    # discovery. UUID string or list of UUID strings (list = union).
    "column_id",
})

# Cluster II Gap 3: label-valued discover filters that accept string-or-list.
# Kept in sync with the consumers in assignment_service._candidate_cards and
# the Go runner's strategy_generic.go column_scan filter parsing.
_LABEL_FILTER_KEYS = ("exclude_label", "include_label", "label", "require_label")
_LLM_STAGES = frozenset({"implement", "review", "document"})
# Phase I.1.g: when `llm.post_process_kind` is set, the `llm.stage` name is
# free-form and the kind decides how the engine routes the LLM output. The
# empty string means "fall back to the legacy closed-enum check on stage".
_POST_PROCESS_KINDS = frozenset(
    {"", "writes_code", "produces_decision", "produces_note", "mutates_backlog"}
)
_COLUMN_TYPES = frozenset({"backlog", "active", "review", "done", "blocked", ""})

# CTX-1/CTX-5: closed enum of supported llm.context_sources[].kind. The runner
# is a dumb consumer — every kind here has a server-side fetcher in
# app.services.agents.context_assembly. New kinds ship in their own card.
_CONTEXT_SOURCE_KINDS = frozenset({
    "card_notes",
    "board_definition",
    "pinned_notes",
    "sibling_cards",
    "board_snapshot",
    "review_history",
    "dependency_health",
    "linked_cards",
    "execution_history",
    "card_activity",
    "pipeline_expectations",
})

# Mirrors app.models.kanban.column.ColumnType. Validator-side copy keeps the
# pipeline-config validation free of model imports at module load.
_SIBLING_CARDS_COLUMN_TYPES = frozenset(
    {"backlog", "active", "review", "done", "blocked"}
)

# Aliases that conflict with current or planned runner-injected identifiers;
# operators would silently shadow them by aliasing a context source the same
# way. Authoritative list of injected fields lives in
# runner/internal/workloop/prompt_template.go (PromptContext struct).
#
# CTX-5: `review_history` was on this list while the runner owned its
# rendering. The new `kind: review_history` source ships the same string from
# the backend (byte-for-byte parity with Loop.fetchReviewHistory), so the
# alias becomes a legitimate operator-facing key — defaulting to `kind` when
# `as` is omitted.
_RESERVED_CONTEXT_ALIASES = frozenset(
    {
        "card_id", "pr_url", "branch", "workspace", "card", "board", "role",
        "agent_id", "board_id", "execution_id", "user_id",
        "action_plan", "project_directives",
    }
)

# Legacy stage names route through specialized engine paths (l.implement /
# l.reviewCode / l.generateDocs). When operators explicitly set post_process_kind
# on these stages, the value MUST match the implicit mapping below — otherwise
# the specialized path runs and its output is silently discarded by the post-LLM
# gate. Mirrors runner/internal/valaris/types.go:LegacyPostProcessKind.
_LEGACY_STAGE_TO_KIND = {
    "implement": "writes_code",
    "review": "produces_decision",
    "document": "writes_code",
}

# `on_success` is intentionally NOT required: the lifecycle DSL is the new
# source of truth and the 5-role default emits no on_success/on_failure block.
# Legacy persisted configs that still carry on_success keep validating (the
# field is recognised as optional below by _validate_action).
_REQUIRED_STAGE_KEYS = ("role", "discover", "claim", "git", "llm")

# Backward-compat for workspaces whose persisted pipeline_config predates the
# `unique` field. Retains the pre-T1.1 UNIQUE_ROLES semantics for the
# platform-shipped roles; any user-defined role defaults to unique=False
# unless the operator sets it explicitly. The 2026-05-16 role redesign adds
# planner/implementer/rework_mediator; orchestrator stays in the set so
# legacy persisted configs that still carry it keep their uniqueness.
_LEGACY_UNIQUE_ROLES = frozenset({
    "orchestrator",
    "planner",
    "implementer",
    "reviewer",
    "rework_mediator",
    "documentator",
})


def canonicalize_pipeline_config(config: dict) -> dict:
    """Return `config` with defaulted fields that operators shouldn't have to author.

    Mutates and returns the same dict for call-site convenience. Today this
    auto-extends `scheduling.priority_order` with stage roles the operator
    hasn't listed — the pipeline editor adds stages but doesn't expose the
    scheduler's priority list (see audits/runner-launch-walkthrough-2026-04-18.md
    B2). Existing entries keep their order; missing stage roles append in
    stage-definition order.
    """
    if not isinstance(config, dict):
        return config

    stages = config.get("stages")
    if not isinstance(stages, list):
        return config

    stage_roles: list[str] = []
    seen: set[str] = set()
    for stage in stages:
        if not isinstance(stage, dict):
            continue
        if "unique" not in stage:
            role = stage.get("role")
            stage["unique"] = isinstance(role, str) and role in _LEGACY_UNIQUE_ROLES
        _mirror_lifecycle_llm_into_flat(stage)
        role = stage.get("role")
        if isinstance(role, str) and role and role not in seen:
            stage_roles.append(role)
            seen.add(role)

    scheduling = config.get("scheduling")
    if not isinstance(scheduling, dict):
        scheduling = {}
        config["scheduling"] = scheduling

    priority = scheduling.get("priority_order")
    if not isinstance(priority, list):
        priority = []
        scheduling["priority_order"] = priority

    listed = {r for r in priority if isinstance(r, str)}
    for role in stage_roles:
        if role not in listed:
            priority.append(role)
            listed.add(role)

    if "mode" not in scheduling:
        scheduling["mode"] = "priority"

    return config


def _mirror_lifecycle_llm_into_flat(stage: dict) -> None:
    """Copy the lifecycle llm-step's provider/model into the flat stage.llm.

    Card b8024b15 (write side): the pipeline builder writes the operator's
    provider/model into `lifecycle[<llm step>].params` while the flat
    `stage.llm` block keeps its stale default — a split-brain the dispatch
    read path papers over (lifecycle-first) but that any flat-only reader
    still trips on. Reconciling at canonicalize time (every save path runs
    it) makes the lifecycle step the single authoritative source and the
    flat block a derived mirror. Empty lifecycle values never clobber a
    non-empty flat default.
    """
    lifecycle = stage.get("lifecycle")
    if not isinstance(lifecycle, list):
        return
    params = next(
        (
            step.get("params")
            for step in lifecycle
            if isinstance(step, dict)
            and step.get("kind") == "llm"
            and isinstance(step.get("params"), dict)
        ),
        None,
    )
    if params is None:
        return
    flat_llm = stage.get("llm")
    if not isinstance(flat_llm, dict):
        return
    for key in ("provider", "model"):
        value = params.get(key)
        if isinstance(value, str) and value:
            flat_llm[key] = value


class ValidationError(dict):
    """Serializable validation finding carrying code, params, and raw message.

    `severity` defaults to "error" (caller raises 422). Warnings keep the same
    shape but the caller filters them out before deciding to block; they're
    still returned for the UI to surface.
    """

    def __init__(
        self,
        *,
        code: str,
        field: str,
        message: str,
        value: Any = None,
        severity: str = "error",
        params: dict[str, Any] | None = None,
    ):
        localizable_params = {"field": field}
        if value is not None:
            localizable_params["value"] = value
        if params:
            localizable_params.update(params)
        super().__init__(
            code=code,
            field=field,
            message=message,
            severity=severity,
            params=localizable_params,
        )
        if value is not None:
            self["value"] = value


def validate_pipeline_config(
    config: dict,
    known_sensors: set[str] | None = None,
) -> list[ValidationError]:
    """Return a list of validation errors for `config`. Empty list means valid.

    The function is non-throwing; the caller raises an HTTPException(422) with
    the error list as `detail` when the list is non-empty.

    `known_sensors` is the set of sensor names the platform has learned about
    from agent heartbeats. Passing `None` (the default) disables sensor-name
    validation — callers without catalog data should not pretend to know what
    sensors exist.
    """
    errors: list[ValidationError] = []

    if not isinstance(config, dict):
        errors.append(
            ValidationError(
                code="invalid_config_shape",
                field="",
                message="pipeline_config must be a JSON object",
            )
        )
        return errors

    stages = config.get("stages")
    if not isinstance(stages, list):
        errors.append(
            ValidationError(
                code="missing_stage_key",
                field="stages",
                message="pipeline_config.stages must be a list",
            )
        )
        return errors

    known_roles: set[str] = set()
    seen_roles: set[str] = set()

    for idx, stage in enumerate(stages):
        stage_path = f"stages[{idx}]"
        if not isinstance(stage, dict):
            errors.append(
                ValidationError(
                    code="missing_stage_key",
                    field=stage_path,
                    message=f"{stage_path} must be a JSON object",
                )
            )
            continue

        role = stage.get("role")
        for key in _REQUIRED_STAGE_KEYS:
            value = stage.get(key)
            if key == "role":
                if not isinstance(value, str) or not value:
                    errors.append(
                        ValidationError(
                            code="missing_stage_key",
                            field=f"{stage_path}.role",
                            message=f"{stage_path}.role must be a non-empty string",
                        )
                    )
            elif value is None:
                errors.append(
                    ValidationError(
                        code="missing_stage_key",
                        field=f"{stage_path}.{key}",
                        message=f"{stage_path}.{key} is required",
                    )
                )

        if isinstance(role, str) and role:
            if role in seen_roles:
                errors.append(
                    ValidationError(
                        code="duplicate_stage_role",
                        field=f"{stage_path}.role",
                        message=f"duplicate stage role {role!r}",
                        value=role,
                    )
                )
            else:
                seen_roles.add(role)
                known_roles.add(role)

    for idx, stage in enumerate(stages):
        if not isinstance(stage, dict):
            continue
        stage_path = f"stages[{idx}]"
        _validate_discover(stage.get("discover"), f"{stage_path}.discover", errors)
        _validate_claim(stage.get("claim"), f"{stage_path}.claim", errors)
        _validate_git(stage.get("git"), f"{stage_path}.git", errors)
        _validate_llm(stage.get("llm"), f"{stage_path}.llm", errors)
        _validate_action(
            stage.get("on_success"),
            f"{stage_path}.on_success",
            known_roles,
            errors,
        )
        on_failure = stage.get("on_failure")
        if on_failure is not None:
            _validate_action(
                on_failure,
                f"{stage_path}.on_failure",
                known_roles,
                errors,
            )

        if known_sensors is not None:
            _validate_sensors(
                stage.get("sensors"),
                f"{stage_path}.sensors",
                known_sensors,
                errors,
            )

        if "lifecycle" in stage:
            _validate_lifecycle(stage.get("lifecycle"), f"{stage_path}.lifecycle", errors)

    # PAR-2: pipeline.merge_via_queue is a workspace-level boolean feature
    # flag that flips the runner from runner-side merge to backend merge
    # queue (see app/services/merge_queue.py). Default false preserves
    # pre-PAR-2 behavior; the value lives at the top of pipeline_config
    # because it gates a cross-stage decision (every reviewer's approve
    # path consults it).
    merge_via_queue = config.get("merge_via_queue")
    if merge_via_queue is not None and not isinstance(merge_via_queue, bool):
        errors.append(
            ValidationError(
                code="invalid_merge_via_queue",
                field="merge_via_queue",
                message=(
                    f"merge_via_queue must be a boolean "
                    f"(got {type(merge_via_queue).__name__})"
                ),
                value=merge_via_queue,
            )
        )

    scheduling = config.get("scheduling")
    if isinstance(scheduling, dict):
        priority = scheduling.get("priority_order")
        if isinstance(priority, list):
            for role in priority:
                if isinstance(role, str) and role and role not in known_roles:
                    errors.append(
                        ValidationError(
                            code="priority_order_unknown_role",
                            field="scheduling.priority_order",
                            message=(
                                f"scheduling.priority_order references unknown role {role!r} "
                                f"(known roles: {sorted(known_roles)})"
                            ),
                            value=role,
                        )
                    )

        mode = scheduling.get("mode")
        if mode is not None and mode not in _SCHEDULING_MODES:
            errors.append(
                ValidationError(
                    code="unknown_scheduling_mode",
                    field="scheduling.mode",
                    message=(
                        f"unknown scheduling.mode {mode!r} "
                        f"(expected one of {sorted(_SCHEDULING_MODES)})"
                    ),
                    value=mode,
                )
            )

    # WS3: optional setup_contract drift check — a hand-authored contract must
    # name every label/column the config actually uses (absent contract passes).
    _validate_setup_contract(config, errors)

    return errors


def _config_labels_and_columns(config: dict) -> tuple[set[str], set[str]]:
    """Collect every label and column_type the config's stages discover/label by.

    Labels come from discover filter keys (require/include/label/exclude) and
    lifecycle apply_label/remove_label steps; columns from discover.column_type.
    """
    labels: set[str] = set()
    columns: set[str] = set()
    for stage in config.get("stages") or []:
        if not isinstance(stage, dict):
            continue
        discover = stage.get("discover") if isinstance(stage.get("discover"), dict) else {}
        col_type = discover.get("column_type")
        if isinstance(col_type, str) and col_type:
            columns.add(col_type)
        filters = discover.get("filters") if isinstance(discover.get("filters"), dict) else {}
        for key in _LABEL_FILTER_KEYS:
            value = filters.get(key)
            if isinstance(value, str) and value:
                labels.add(value)
            elif isinstance(value, list):
                labels.update(v for v in value if isinstance(v, str) and v)
        for step in stage.get("lifecycle") or []:
            if not isinstance(step, dict):
                continue
            if step.get("kind") in ("apply_label", "remove_label"):
                params = step.get("params") if isinstance(step.get("params"), dict) else {}
                label = params.get("label")
                if isinstance(label, str) and label:
                    labels.add(label)
    return labels, columns


def _validate_setup_contract(config: dict, errors: list[ValidationError]) -> None:
    """Catch drift between a hand-authored setup_contract and the live config.

    The contract is optional: absence passes. When present, every label the
    config references in a discover filter or lifecycle step MUST appear in
    `setup_contract.labels[*].name`, and every discover `column_type` in
    `setup_contract.columns[*].column_type`. This is the WS3 safety net so an
    operator who renames a label can't ship a stale onboarding contract.
    """
    contract = config.get("setup_contract")
    if contract is None:
        return
    if not isinstance(contract, dict):
        errors.append(
            ValidationError(
                code="invalid_setup_contract",
                field="setup_contract",
                message="setup_contract must be a JSON object when present",
                value=contract,
            )
        )
        return

    config_labels, config_columns = _config_labels_and_columns(config)

    contract_labels = {
        label["name"]
        for label in (contract.get("labels") or [])
        if isinstance(label, dict) and isinstance(label.get("name"), str)
    }
    missing_labels = config_labels - contract_labels
    if missing_labels:
        errors.append(
            ValidationError(
                code="setup_contract_label_drift",
                field="setup_contract.labels",
                message=(
                    f"setup_contract.labels omits {len(missing_labels)} label(s) "
                    f"used in discover filters or lifecycle steps: "
                    f"{sorted(missing_labels)}"
                ),
                value=sorted(missing_labels),
            )
        )

    contract_columns = {
        col["column_type"]
        for col in (contract.get("columns") or [])
        if isinstance(col, dict) and isinstance(col.get("column_type"), str)
    }
    missing_columns = config_columns - contract_columns
    if missing_columns:
        errors.append(
            ValidationError(
                code="setup_contract_column_drift",
                field="setup_contract.columns",
                message=(
                    f"setup_contract.columns omits {len(missing_columns)} "
                    f"column_type(s) a stage discovers in: {sorted(missing_columns)}"
                ),
                value=sorted(missing_columns),
            )
        )


def _validate_discover(discover: Any, path: str, errors: list[ValidationError]) -> None:
    if not isinstance(discover, dict):
        return

    filters = discover.get("filters")
    if isinstance(filters, dict):
        for key in filters.keys():
            if key not in _DISCOVER_FILTER_KEYS:
                errors.append(
                    ValidationError(
                        code="unknown_discover_filter_key",
                        field=f"{path}.filters.{key}",
                        message=(
                            f"unknown discover filter {key!r} "
                            f"(expected one of {sorted(_DISCOVER_FILTER_KEYS)})"
                        ),
                        value=key,
                    )
                )

        # Cluster II Gap 3: label filters accept a string OR a list of
        # strings (AND-composed per token). Reject any other shape, and any
        # list carrying a non-string entry, so a misformed filter surfaces
        # at save time instead of silently never matching.
        for label_key in _LABEL_FILTER_KEYS:
            value = filters.get(label_key)
            if value is None:
                continue
            if isinstance(value, str):
                continue
            if isinstance(value, list):
                if all(isinstance(v, str) for v in value):
                    continue
                errors.append(
                    ValidationError(
                        code="invalid_label_filter",
                        field=f"{path}.filters.{label_key}",
                        message=(
                            f"{label_key} list entries must all be strings "
                            f"(got {value!r})"
                        ),
                        value=value,
                    )
                )
                continue
            errors.append(
                ValidationError(
                    code="invalid_label_filter",
                    field=f"{path}.filters.{label_key}",
                    message=(
                        f"{label_key} must be a string or a list of strings "
                        f"(got {type(value).__name__})"
                    ),
                    value=value,
                )
            )

        # Wave gating: column identity, string or list of strings, each a UUID.
        # Validating the UUID shape here catches the likely operator mistake —
        # writing the column NAME — at save time instead of silently matching
        # nothing and starving the role.
        column_id_value = filters.get("column_id")
        if column_id_value is not None:
            field = f"{path}.filters.column_id"
            if isinstance(column_id_value, (str, list)):
                raw_ids = (
                    [column_id_value]
                    if isinstance(column_id_value, str)
                    else column_id_value
                )
                for raw in raw_ids:
                    if not isinstance(raw, str):
                        errors.append(
                            ValidationError(
                                code="invalid_column_id_filter",
                                field=field,
                                message=(
                                    "column_id list entries must all be UUID "
                                    f"strings (got {raw!r})"
                                ),
                                value=column_id_value,
                            )
                        )
                        continue
                    try:
                        uuid.UUID(raw)
                    except ValueError:
                        errors.append(
                            ValidationError(
                                code="invalid_column_id_filter",
                                field=field,
                                message=(
                                    f"column_id {raw!r} is not a UUID — use the "
                                    "column's id, not its name"
                                ),
                                value=column_id_value,
                            )
                        )
            else:
                errors.append(
                    ValidationError(
                        code="invalid_column_id_filter",
                        field=field,
                        message=(
                            "column_id must be a UUID string or a list of UUID "
                            f"strings (got {type(column_id_value).__name__})"
                        ),
                        value=column_id_value,
                    )
                )

        # Note-attribute filter: validate the kind against the closed set
        # registered in app.models.notes.kinds so typos surface at save time.
        note_kind = filters.get("require_note_kind")
        if isinstance(note_kind, str) and note_kind:
            from app.models.notes import kinds as note_kinds_module

            known = {
                v for k, v in vars(note_kinds_module).items()
                if not k.startswith("_") and isinstance(v, str)
            }
            if note_kind not in known:
                errors.append(
                    ValidationError(
                        code="unknown_note_kind_filter",
                        field=f"{path}.filters.require_note_kind",
                        message=(
                            f"unknown note kind {note_kind!r} for require_note_kind "
                            f"(known: {sorted(known)})"
                        ),
                        value=note_kind,
                    )
                )

        # Cluster II Gap 2: note-freshness filter. Must be a dict carrying two
        # known note kinds, `kind` and `than_kind`.
        newer_than = filters.get("require_note_kind_newer_than")
        if newer_than is not None:
            field = f"{path}.filters.require_note_kind_newer_than"
            if not isinstance(newer_than, dict):
                errors.append(
                    ValidationError(
                        code="invalid_note_freshness_filter",
                        field=field,
                        message=(
                            "require_note_kind_newer_than must be an object with "
                            "`kind` and `than_kind` note-kind strings"
                        ),
                        value=newer_than,
                    )
                )
            else:
                from app.models.notes import kinds as note_kinds_module

                known = {
                    v for k, v in vars(note_kinds_module).items()
                    if not k.startswith("_") and isinstance(v, str)
                }
                for sub in ("kind", "than_kind"):
                    val = newer_than.get(sub)
                    if not isinstance(val, str) or not val:
                        errors.append(
                            ValidationError(
                                code="invalid_note_freshness_filter",
                                field=f"{field}.{sub}",
                                message=f"{sub} must be a non-empty note-kind string",
                                value=val,
                            )
                        )
                    elif val not in known:
                        errors.append(
                            ValidationError(
                                code="invalid_note_freshness_filter",
                                field=f"{field}.{sub}",
                                message=(
                                    f"unknown note kind {val!r} for {sub} "
                                    f"(known: {sorted(known)})"
                                ),
                                value=val,
                            )
                        )

    strategy = discover.get("strategy")
    if strategy is not None and strategy not in _DISCOVER_STRATEGIES:
        errors.append(
            ValidationError(
                code="unknown_discover_strategy",
                field=f"{path}.strategy",
                message=(
                    f"unknown discover.strategy {strategy!r} "
                    f"(expected one of {sorted(_DISCOVER_STRATEGIES)})"
                ),
                value=strategy,
            )
        )

    # Role-scoped scheduling preconditions; the scheduler refuses an
    # assignment unless every named precondition passes. Mirrors
    # backend/app/services/scheduling/preconditions.py:KNOWN_PRECONDITIONS;
    # update both sides together.
    preconditions = discover.get("preconditions")
    if preconditions is not None:
        from app.services.scheduling.preconditions import KNOWN_PRECONDITIONS

        if not isinstance(preconditions, list):
            errors.append(
                ValidationError(
                    code="invalid_preconditions",
                    field=f"{path}.preconditions",
                    message=(
                        f"discover.preconditions must be a list "
                        f"(got {type(preconditions).__name__})"
                    ),
                )
            )
        else:
            for idx, name in enumerate(preconditions):
                if not isinstance(name, str) or not name:
                    errors.append(
                        ValidationError(
                            code="invalid_preconditions",
                            field=f"{path}.preconditions[{idx}]",
                            message="precondition entries must be non-empty strings",
                        )
                    )
                elif name not in KNOWN_PRECONDITIONS:
                    errors.append(
                        ValidationError(
                            code="unknown_precondition",
                            field=f"{path}.preconditions[{idx}]",
                            message=(
                                f"unknown precondition {name!r} "
                                f"(expected one of {sorted(KNOWN_PRECONDITIONS)})"
                            ),
                            value=name,
                        )
                    )


def _validate_claim(claim: Any, path: str, errors: list[ValidationError]) -> None:
    if not isinstance(claim, dict):
        return
    participant_role = claim.get("participant_role")
    if participant_role is not None and participant_role not in _CLAIM_ROLES:
        errors.append(
            ValidationError(
                code="unknown_claim_role",
                field=f"{path}.participant_role",
                message=(
                    f"unknown claim.participant_role {participant_role!r} "
                    f"(expected one of {sorted(_CLAIM_ROLES)})"
                ),
                value=participant_role,
            )
        )


def _validate_git(git: Any, path: str, errors: list[ValidationError]) -> None:
    if not isinstance(git, dict):
        return
    action = git.get("action")
    if action is not None and action not in _GIT_ACTIONS:
        errors.append(
            ValidationError(
                code="unknown_git_action",
                field=f"{path}.action",
                message=(
                    f"unknown git.action {action!r} "
                    f"(expected one of {sorted(a for a in _GIT_ACTIONS if a)} or empty)"
                ),
                value=action,
            )
        )

    base_ref = git.get("base_ref")
    if base_ref is not None and base_ref not in _GIT_BASE_REFS:
        errors.append(
            ValidationError(
                code="unknown_git_base_ref",
                field=f"{path}.base_ref",
                message=(
                    f"unknown git.base_ref {base_ref!r} "
                    f"(expected one of {sorted(_GIT_BASE_REFS)})"
                ),
                value=base_ref,
            )
        )

    # T0.1 parity: when git is skipped there is no branch or repo to open a PR
    # against. The Go engine short-circuits before the branch step, so create_pr
    # silently becomes a no-op. Reject the config so operators catch the error.
    if action in ("none", "") and bool(git.get("create_pr", False)):
        errors.append(
            ValidationError(
                code="create_pr_requires_branch",
                field=f"{path}.create_pr",
                message=(
                    "git.create_pr=true requires git.action to create or check out a "
                    "branch (got 'none'/empty). The agent would skip the PR step."
                ),
                value=True,
            )
        )


def _validate_llm(llm: Any, path: str, errors: list[ValidationError]) -> None:
    if not isinstance(llm, dict):
        return
    enabled = llm.get("enabled", False)
    stage = llm.get("stage", "")
    kind = llm.get("post_process_kind", "") or ""

    if "context_sources" in llm:
        _validate_context_sources(
            llm.get("context_sources"), f"{path}.context_sources", errors
        )

    if "tool_policy" in llm:
        _validate_tool_policy(llm.get("tool_policy"), f"{path}.tool_policy", errors)

    _validate_llm_model_value(llm.get("model"), f"{path}.model", errors)

    if kind not in _POST_PROCESS_KINDS:
        errors.append(
            ValidationError(
                code="unknown_post_process_kind",
                field=f"{path}.post_process_kind",
                message=(
                    f"llm.post_process_kind {kind!r} is not a known kind "
                    f"(expected one of {sorted(k for k in _POST_PROCESS_KINDS if k)} or empty)"
                ),
                value=kind,
            )
        )

    has_kind = kind != ""
    if enabled:
        if has_kind:
            # Kind present: stage name is free-form. Only require non-empty string.
            if not isinstance(stage, str) or stage == "":
                errors.append(
                    ValidationError(
                        code="unknown_llm_stage",
                        field=f"{path}.stage",
                        message="llm.stage must be a non-empty string when llm.enabled=true",
                        value=stage,
                    )
                )
        elif not isinstance(stage, str) or stage not in _LLM_STAGES:
            errors.append(
                ValidationError(
                    code="unknown_llm_stage",
                    field=f"{path}.stage",
                    message=(
                        f"llm.stage {stage!r} is invalid when llm.enabled=true "
                        f"(expected one of {sorted(_LLM_STAGES)}, or set "
                        f"llm.post_process_kind for a custom stage)"
                    ),
                    value=stage,
                )
            )
    else:
        # When LLM disabled, stage is ignored; only reject non-string type.
        if not has_kind and stage not in (None, "") and stage not in _LLM_STAGES:
            errors.append(
                ValidationError(
                    code="unknown_llm_stage",
                    field=f"{path}.stage",
                    message=(
                        f"llm.stage {stage!r} is not a known stage "
                        f"(expected one of {sorted(_LLM_STAGES)} or empty)"
                    ),
                    value=stage,
                )
            )

    # Fix 2 — approval_enabled is only plumbed into the legacy "implement" path.
    # Reject it on every other stage (review, document, custom) — the engine
    # would otherwise silently ignore approval and ship as if approved.
    approval_enabled = bool(llm.get("approval_enabled", False))
    if approval_enabled and stage != "implement":
        errors.append(
            ValidationError(
                code="approval_not_supported_for_custom_stage",
                field=f"{path}.approval_enabled",
                message=(
                    f"llm.approval_enabled=true is only wired for stage 'implement' "
                    f"(got {stage!r}). Approval flow is not plumbed into custom stages; "
                    f"remove approval_enabled or set stage to 'implement'."
                ),
                value=stage,
            )
        )

    # Fix 3 — legacy stage names route through specialized engine paths with an
    # implied kind. If the explicit kind disagrees, the specialized path writes
    # files/findings that the post-LLM gate then silently discards.
    if stage in _LEGACY_STAGE_TO_KIND and has_kind:
        expected = _LEGACY_STAGE_TO_KIND[stage]
        if kind != expected:
            errors.append(
                ValidationError(
                    code="mismatched_post_process_kind",
                    field=f"{path}.post_process_kind",
                    message=(
                        f"llm.post_process_kind {kind!r} disagrees with legacy stage "
                        f"{stage!r} (expected {expected!r}). The specialized {stage!r} "
                        f"path would run and its output silently discarded — rename the "
                        f"stage or align the kind."
                    ),
                    value=kind,
                )
            )


def _validate_llm_model_value(
    model: Any, field: str, errors: list[ValidationError]
) -> None:
    """Reject model values the dispatch tier resolver can't handle.

    Card e019244b: the UI once offered tier "high"; the resolver only knows
    premium/mid/low (+ deprecated literals + concrete model ids). Catch the
    typo class at save time instead of failing at dispatch. Applies to both
    the flat `stage.llm.model` and the lifecycle llm-step `params.model`.
    """
    if not isinstance(model, str):
        return
    message = model_value_error(model)
    if message:
        errors.append(
            ValidationError(
                code="unknown_llm_model_tier",
                field=field,
                message=message,
                value=model,
            )
        )


def _validate_tool_policy(
    tool_policy: Any, path: str, errors: list[ValidationError]
) -> None:
    """Shape-only check for the per-stage LLM tool deny-list.

    The deny entries are claude-CLI tool/Bash-pattern strings (e.g.
    `Bash(gh pr merge:*)`) — opaque to the backend, which only carries them
    into the /next-assignment payload. We enforce: `tool_policy` is an object,
    `deny` (when present) is a list of strings. Absent/empty is valid.
    """
    if not isinstance(tool_policy, dict):
        errors.append(
            ValidationError(
                code="invalid_tool_policy",
                field=path,
                message=(
                    "llm.tool_policy must be an object with an optional "
                    "`deny` list of CLI tool-pattern strings"
                ),
                value=tool_policy,
            )
        )
        return

    deny = tool_policy.get("deny")
    if deny is None:
        return
    if not isinstance(deny, list):
        errors.append(
            ValidationError(
                code="invalid_tool_policy",
                field=f"{path}.deny",
                message="llm.tool_policy.deny must be a list of strings",
                value=deny,
            )
        )
        return
    for i, entry in enumerate(deny):
        if not isinstance(entry, str):
            errors.append(
                ValidationError(
                    code="invalid_tool_policy",
                    field=f"{path}.deny[{i}]",
                    message="llm.tool_policy.deny entries must be strings",
                    value=entry,
                )
            )


def _validate_action(
    action: Any,
    path: str,
    known_roles: set[str],
    errors: list[ValidationError],
) -> None:
    if not isinstance(action, dict):
        return

    move_to = action.get("move_to_column_type")
    if move_to is not None and move_to not in _COLUMN_TYPES:
        errors.append(
            ValidationError(
                code="invalid_move_to_column_type",
                field=f"{path}.move_to_column_type",
                message=(
                    f"unknown move_to_column_type {move_to!r} "
                    f"(expected one of {sorted(c for c in _COLUMN_TYPES if c)} or empty)"
                ),
                value=move_to,
            )
        )

    wake_roles = action.get("wake_roles")
    if isinstance(wake_roles, list):
        for role in wake_roles:
            if isinstance(role, str) and role and role not in known_roles:
                errors.append(
                    ValidationError(
                        code="invalid_wake_role",
                        field=f"{path}.wake_roles",
                        message=(
                            f"wake_roles references unknown role {role!r} "
                            f"(known roles: {sorted(known_roles)})"
                        ),
                        value=role,
                    )
                )

    branches = action.get("branches")
    if isinstance(branches, dict):
        for branch_name, branch_action in branches.items():
            _validate_action(
                branch_action,
                f"{path}.branches.{branch_name}",
                known_roles,
                errors,
            )


def _validate_sensors(
    sensors: Any,
    path: str,
    known_sensors: set[str],
    errors: list[ValidationError],
) -> None:
    if not isinstance(sensors, list):
        return
    for idx, sensor in enumerate(sensors):
        if not isinstance(sensor, dict):
            continue
        name = sensor.get("name")
        if not isinstance(name, str) or not name:
            continue
        if name not in known_sensors:
            errors.append(
                ValidationError(
                    code="unknown_sensor_name",
                    field=f"{path}[{idx}].name",
                    message=(
                        f"sensor {name!r} is not in the registered catalog "
                        f"(known: {sorted(known_sensors)})"
                    ),
                    value=name,
                )
            )


def _validate_context_sources(
    sources: Any, path: str, errors: list[ValidationError]
) -> None:
    if not isinstance(sources, list):
        errors.append(
            ValidationError(
                code="invalid_context_sources",
                field=path,
                message=(
                    f"llm.context_sources must be a list "
                    f"(got {type(sources).__name__})"
                ),
            )
        )
        return

    seen_aliases: set[str] = set()
    for idx, source in enumerate(sources):
        item_path = f"{path}[{idx}]"
        if not isinstance(source, dict):
            errors.append(
                ValidationError(
                    code="invalid_context_source",
                    field=item_path,
                    message=f"{item_path} must be a JSON object",
                )
            )
            continue

        source_kind = source.get("kind")
        if not isinstance(source_kind, str) or not source_kind:
            errors.append(
                ValidationError(
                    code="missing_context_source_kind",
                    field=f"{item_path}.kind",
                    message=f"{item_path}.kind is required",
                )
            )
            continue

        if source_kind not in _CONTEXT_SOURCE_KINDS:
            errors.append(
                ValidationError(
                    code="unknown_context_source_kind",
                    field=f"{item_path}.kind",
                    message=(
                        f"unknown context_sources.kind {source_kind!r} "
                        f"(expected one of {sorted(_CONTEXT_SOURCE_KINDS)})"
                    ),
                    value=source_kind,
                )
            )
            continue

        _validate_context_source_filter(source_kind, source.get("filter"), item_path, errors)

        alias = source.get("as", source_kind)
        if not isinstance(alias, str) or not alias:
            errors.append(
                ValidationError(
                    code="invalid_context_source_alias",
                    field=f"{item_path}.as",
                    message=f"{item_path}.as must be a non-empty string when present",
                )
            )
            continue

        if alias in _RESERVED_CONTEXT_ALIASES:
            errors.append(
                ValidationError(
                    code="reserved_context_source_alias",
                    field=f"{item_path}.as",
                    message=(
                        f"context_sources alias {alias!r} is reserved "
                        f"(reserved: {sorted(_RESERVED_CONTEXT_ALIASES)})"
                    ),
                    value=alias,
                )
            )
            continue

        if alias in seen_aliases:
            errors.append(
                ValidationError(
                    code="duplicate_context_source_alias",
                    field=f"{item_path}.as",
                    message=(
                        f"duplicate context_sources alias {alias!r} within stage "
                        f"(omit `as` defaults to `kind`, so two sources of the same "
                        f"kind also collide)"
                    ),
                    value=alias,
                )
            )
            continue

        seen_aliases.add(alias)


def _validate_context_source_filter(
    source_kind: str, filt: Any, item_path: str, errors: list[ValidationError]
) -> None:
    if source_kind == "card_notes":
        if filt is None:
            return
        if not isinstance(filt, dict):
            errors.append(
                ValidationError(
                    code="invalid_context_source_filter",
                    field=f"{item_path}.filter",
                    message=f"{item_path}.filter must be a JSON object",
                )
            )
            return
        note_kind = filt.get("kind")
        if note_kind is None:
            return
        from app.models.notes import kinds as note_kinds_module

        known = {
            v for k, v in vars(note_kinds_module).items()
            if not k.startswith("_") and isinstance(v, str)
        }
        if note_kind not in known:
            errors.append(
                ValidationError(
                    code="unknown_card_notes_filter_kind",
                    field=f"{item_path}.filter.kind",
                    message=(
                        f"unknown note kind {note_kind!r} for card_notes filter "
                        f"(known: {sorted(known)})"
                    ),
                    value=note_kind,
                )
            )
        return

    if source_kind == "sibling_cards":
        _validate_sibling_cards_filter(filt, item_path, errors)
        return

    if source_kind == "board_snapshot":
        _validate_board_snapshot_filter(filt, item_path, errors)
        return

    if source_kind == "review_history":
        # review_history is always card-scoped; no filter is meaningful.
        # Accept omitted/empty/none as a no-op; reject any other shape.
        if filt is None:
            return
        if not isinstance(filt, dict) or filt:
            errors.append(
                ValidationError(
                    code="review_history_filter_not_supported",
                    field=f"{item_path}.filter",
                    message=(
                        "review_history takes no filter — it is always scoped to "
                        "the current card. Remove the `filter` key."
                    ),
                )
            )
        return

    if source_kind == "dependency_health":
        # Board-scoped graph validation; no filter is meaningful.
        if filt is None:
            return
        if not isinstance(filt, dict) or filt:
            errors.append(
                ValidationError(
                    code="dependency_health_filter_not_supported",
                    field=f"{item_path}.filter",
                    message=(
                        "dependency_health takes no filter — it always validates the "
                        "whole board graph. Remove the `filter` key."
                    ),
                )
            )
        return

    if source_kind == "linked_cards":
        _validate_linked_cards_filter(filt, item_path, errors)
        return

    if source_kind == "execution_history":
        _validate_execution_history_filter(filt, item_path, errors)
        return

    if source_kind == "card_activity":
        _validate_card_activity_filter(filt, item_path, errors)
        return

    if source_kind == "pipeline_expectations":
        _validate_pipeline_expectations_filter(filt, item_path, errors)
        return

    if filt is not None and not isinstance(filt, dict):
        errors.append(
            ValidationError(
                code="invalid_context_source_filter",
                field=f"{item_path}.filter",
                message=f"{item_path}.filter must be a JSON object when present",
            )
        )


def _validate_sibling_cards_filter(
    filt: Any, item_path: str, errors: list[ValidationError]
) -> None:
    if filt is None:
        return
    if not isinstance(filt, dict):
        errors.append(
            ValidationError(
                code="invalid_sibling_cards_filter",
                field=f"{item_path}.filter",
                message=f"{item_path}.filter must be a JSON object",
            )
        )
        return

    for str_key in ("column_type", "column", "label", "priority"):
        value = filt.get(str_key)
        if value is None:
            continue
        if not isinstance(value, str) or not value:
            errors.append(
                ValidationError(
                    code="invalid_sibling_cards_filter",
                    field=f"{item_path}.filter.{str_key}",
                    message=f"{str_key} must be a non-empty string when present",
                    value=value,
                )
            )

    column_type = filt.get("column_type")
    if (
        isinstance(column_type, str)
        and column_type
        and column_type not in _SIBLING_CARDS_COLUMN_TYPES
    ):
        errors.append(
            ValidationError(
                code="invalid_sibling_cards_filter",
                field=f"{item_path}.filter.column_type",
                message=(
                    f"unknown column_type {column_type!r} "
                    f"(expected one of {sorted(_SIBLING_CARDS_COLUMN_TYPES)})"
                ),
                value=column_type,
            )
        )

    limit = filt.get("limit")
    if limit is not None:
        # bool is an int subclass in Python — reject explicitly so True/False
        # don't slip through as 1/0 limits.
        if isinstance(limit, bool) or not isinstance(limit, int) or not (1 <= limit <= 50):
            errors.append(
                ValidationError(
                    code="invalid_sibling_cards_filter",
                    field=f"{item_path}.filter.limit",
                    message=(
                        f"limit must be an integer between 1 and 50 (got {limit!r})"
                    ),
                    value=limit,
                )
            )


def _validate_board_snapshot_filter(
    filt: Any, item_path: str, errors: list[ValidationError]
) -> None:
    if filt is None:
        return
    if not isinstance(filt, dict):
        errors.append(
            ValidationError(
                code="invalid_board_snapshot_filter",
                field=f"{item_path}.filter",
                message=f"{item_path}.filter must be a JSON object",
            )
        )
        return

    include_done = filt.get("include_done")
    if include_done is not None and not isinstance(include_done, bool):
        errors.append(
            ValidationError(
                code="invalid_board_snapshot_filter",
                field=f"{item_path}.filter.include_done",
                message=(
                    f"include_done must be a boolean (got {type(include_done).__name__})"
                ),
                value=include_done,
            )
        )

    max_cards = filt.get("max_cards_per_column")
    if max_cards is not None:
        if (
            isinstance(max_cards, bool)
            or not isinstance(max_cards, int)
            or not (1 <= max_cards <= 100)
        ):
            errors.append(
                ValidationError(
                    code="invalid_board_snapshot_filter",
                    field=f"{item_path}.filter.max_cards_per_column",
                    message=(
                        f"max_cards_per_column must be an integer between 1 and 100 "
                        f"(got {max_cards!r})"
                    ),
                    value=max_cards,
                )
            )


# CTX-7: closed enum of dependency directions for the linked_cards source.
_LINKED_CARDS_DIRECTIONS = frozenset({"depends_on", "blocks", "both"})

# CTX-7: ExecutionStatus values an operator may filter execution_history by.
# Mirrors app.models.agents.execution.ExecutionStatus — validator-side copy
# keeps this module free of model imports at load time.
_EXECUTION_STATUSES = frozenset(
    {"started", "running", "completed", "failed", "aborted", "skipped"}
)

# Scopes for the pipeline_expectations source. `current_role` renders the
# agent's own stage; `all_roles` renders the whole-pipeline map (the
# "pipeline plumber" view). Mirrors the fetcher in context_assembly.py.
_PIPELINE_EXPECTATIONS_SCOPES = frozenset({"current_role", "all_roles"})


def _validate_bounded_limit(
    filt: dict, item_path: str, code: str, *, lo: int, hi: int,
    errors: list[ValidationError],
) -> None:
    limit = filt.get("limit")
    if limit is None:
        return
    # bool is an int subclass — reject explicitly so True/False don't slip in.
    if isinstance(limit, bool) or not isinstance(limit, int) or not (lo <= limit <= hi):
        errors.append(
            ValidationError(
                code=code,
                field=f"{item_path}.filter.limit",
                message=f"limit must be an integer between {lo} and {hi} (got {limit!r})",
                value=limit,
            )
        )


def _validate_linked_cards_filter(
    filt: Any, item_path: str, errors: list[ValidationError]
) -> None:
    if filt is None:
        return
    if not isinstance(filt, dict):
        errors.append(
            ValidationError(
                code="invalid_linked_cards_filter",
                field=f"{item_path}.filter",
                message=f"{item_path}.filter must be a JSON object",
            )
        )
        return

    direction = filt.get("direction")
    if direction is not None and direction not in _LINKED_CARDS_DIRECTIONS:
        errors.append(
            ValidationError(
                code="invalid_linked_cards_filter",
                field=f"{item_path}.filter.direction",
                message=(
                    f"direction must be one of {sorted(_LINKED_CARDS_DIRECTIONS)} "
                    f"(got {direction!r})"
                ),
                value=direction,
            )
        )

    _validate_bounded_limit(
        filt, item_path, "invalid_linked_cards_filter", lo=1, hi=50, errors=errors
    )


def _validate_execution_history_filter(
    filt: Any, item_path: str, errors: list[ValidationError]
) -> None:
    if filt is None:
        return
    if not isinstance(filt, dict):
        errors.append(
            ValidationError(
                code="invalid_execution_history_filter",
                field=f"{item_path}.filter",
                message=f"{item_path}.filter must be a JSON object",
            )
        )
        return

    status = filt.get("status")
    if status is not None and status not in _EXECUTION_STATUSES:
        errors.append(
            ValidationError(
                code="invalid_execution_history_filter",
                field=f"{item_path}.filter.status",
                message=(
                    f"status must be one of {sorted(_EXECUTION_STATUSES)} "
                    f"(got {status!r})"
                ),
                value=status,
            )
        )

    _validate_bounded_limit(
        filt, item_path, "invalid_execution_history_filter", lo=1, hi=50, errors=errors
    )


def _validate_card_activity_filter(
    filt: Any, item_path: str, errors: list[ValidationError]
) -> None:
    if filt is None:
        return
    if not isinstance(filt, dict):
        errors.append(
            ValidationError(
                code="invalid_card_activity_filter",
                field=f"{item_path}.filter",
                message=f"{item_path}.filter must be a JSON object",
            )
        )
        return

    _validate_bounded_limit(
        filt, item_path, "invalid_card_activity_filter", lo=1, hi=50, errors=errors
    )


def _validate_pipeline_expectations_filter(
    filt: Any, item_path: str, errors: list[ValidationError]
) -> None:
    if filt is None:
        return
    if not isinstance(filt, dict):
        errors.append(
            ValidationError(
                code="invalid_pipeline_expectations_filter",
                field=f"{item_path}.filter",
                message=f"{item_path}.filter must be a JSON object",
            )
        )
        return

    # `scope` is the only recognised key; reject anything else so a typo
    # (e.g. a stray `limit`) surfaces instead of silently doing nothing.
    unknown = set(filt) - {"scope"}
    if unknown:
        errors.append(
            ValidationError(
                code="invalid_pipeline_expectations_filter",
                field=f"{item_path}.filter",
                message=(
                    f"pipeline_expectations only accepts a `scope` key "
                    f"(got unexpected {sorted(unknown)})"
                ),
            )
        )

    scope = filt.get("scope")
    if scope is not None and scope not in _PIPELINE_EXPECTATIONS_SCOPES:
        errors.append(
            ValidationError(
                code="invalid_pipeline_expectations_filter",
                field=f"{item_path}.filter.scope",
                message=(
                    f"scope must be one of {sorted(_PIPELINE_EXPECTATIONS_SCOPES)} "
                    f"(got {scope!r})"
                ),
                value=scope,
            )
        )


# ---------------------------------------------------------------------------
# LIFECYCLE-1 A.1: generic lifecycle DSL validation.
#
# A stage may optionally carry a `lifecycle: [step, ...]` array. Each step has:
#     name:     unique-within-stage identifier
#     kind:     member of LIFECYCLE_KINDS
#     params:   kind-specific payload
#     next:     name of the next step (when no branches and not terminal)
#     branches: {decision_value: step_name} for decision-producing kinds
#
# When `lifecycle` is present the legacy discover/claim/llm/on_success blocks
# are still validated by the rules above — both shapes coexist during the
# migration window. The runner walker (lane A.2) is the consumer; this
# function only guards referential integrity + closed-set membership.
# ---------------------------------------------------------------------------


def _validate_lifecycle(
    lifecycle: Any, path: str, errors: list[ValidationError]
) -> None:
    if not isinstance(lifecycle, list):
        errors.append(
            ValidationError(
                code="lifecycle_step_invalid_params",
                field=path,
                message=f"{path} must be a list of step objects",
            )
        )
        return

    # First pass: collect declared names + validate per-step shape so the
    # second pass can resolve `next`/`branches` references.
    seen_names: set[str] = set()
    valid_step_indices: list[int] = []

    for idx, step in enumerate(lifecycle):
        step_path = f"{path}[{idx}]"
        if not isinstance(step, dict):
            errors.append(
                ValidationError(
                    code="lifecycle_step_invalid_params",
                    field=step_path,
                    message=f"{step_path} must be a JSON object",
                )
            )
            continue

        name = step.get("name")
        if not isinstance(name, str) or not name:
            errors.append(
                ValidationError(
                    code="lifecycle_step_invalid_params",
                    field=f"{step_path}.name",
                    message=f"{step_path}.name must be a non-empty string",
                )
            )
            continue

        if name in seen_names:
            errors.append(
                ValidationError(
                    code="lifecycle_step_name_collision",
                    field=f"{step_path}.name",
                    message=(
                        f"duplicate lifecycle step name {name!r} within stage"
                    ),
                    value=name,
                    params={"step": name},
                )
            )
            continue
        seen_names.add(name)

        kind = step.get("kind")
        if not isinstance(kind, str) or not kind:
            errors.append(
                ValidationError(
                    code="lifecycle_step_unknown_kind",
                    field=f"{step_path}.kind",
                    message=f"{step_path}.kind must be a non-empty string",
                )
            )
            continue

        if kind not in LIFECYCLE_KINDS:
            errors.append(
                ValidationError(
                    code="lifecycle_step_unknown_kind",
                    field=f"{step_path}.kind",
                    message=(
                        f"unknown lifecycle kind {kind!r} "
                        f"(expected one of {sorted(LIFECYCLE_KINDS)})"
                    ),
                    value=kind,
                )
            )
            continue

        params = step.get("params", {})
        _validate_lifecycle_params(
            kind, params, f"{step_path}.params", errors
        )

        valid_step_indices.append(idx)

    # Second pass: control-flow integrity. Skip steps that already failed
    # shape validation — their reference errors would be noise on top of
    # the structural error.
    for idx in valid_step_indices:
        step = lifecycle[idx]
        step_path = f"{path}[{idx}]"
        name = step["name"]
        kind = step["kind"]
        has_next = "next" in step and step["next"] is not None
        has_branches = "branches" in step and step["branches"] is not None
        is_terminal = LIFECYCLE_KINDS[kind]["terminal"]

        # Exactly one of (next, branches, terminal). branches+next is a
        # nonsense configuration the walker can't resolve; terminal+next
        # would dangle past the end-of-stage signal.
        edges = (1 if has_next else 0) + (1 if has_branches else 0)
        if edges == 0 and not is_terminal:
            errors.append(
                ValidationError(
                    code="lifecycle_step_missing_next",
                    field=step_path,
                    message=(
                        f"lifecycle step {name!r} (kind={kind!r}) must declare "
                        f"`next` or `branches` — the kind is not terminal"
                    ),
                    value=name,
                    params={"step": name, "kind": kind},
                )
            )
            continue
        if edges == 2:
            errors.append(
                ValidationError(
                    code="lifecycle_step_missing_next",
                    field=step_path,
                    message=(
                        f"lifecycle step {name!r} declares both `next` and "
                        f"`branches` — exactly one is allowed"
                    ),
                    value=name,
                    params={"step": name, "kind": kind},
                )
            )
            continue
        if edges == 1 and is_terminal:
            errors.append(
                ValidationError(
                    code="lifecycle_step_missing_next",
                    field=step_path,
                    message=(
                        f"lifecycle step {name!r} is a terminal kind ({kind!r}) "
                        f"and must not declare `next` or `branches`"
                    ),
                    value=name,
                    params={"step": name, "kind": kind},
                )
            )
            continue

        if has_next:
            target = step["next"]
            if not isinstance(target, str) or target not in seen_names:
                errors.append(
                    ValidationError(
                        code="lifecycle_step_dangling_reference",
                        field=f"{step_path}.next",
                        message=(
                            f"lifecycle step {name!r}.next references unknown "
                            f"step {target!r} (known: {sorted(seen_names)})"
                        ),
                        value=target,
                        params={
                            "step": name,
                            "target": target,
                            "reference": "next",
                        },
                    )
                )

        if has_branches:
            branches = step["branches"]
            if not isinstance(branches, dict):
                errors.append(
                    ValidationError(
                        code="lifecycle_step_invalid_params",
                        field=f"{step_path}.branches",
                        message=(
                            f"lifecycle step {name!r}.branches must be an "
                            f"object mapping decision values to step names"
                        ),
                        params={"step": name},
                    )
                )
                continue
            for decision, target in branches.items():
                if not isinstance(target, str) or target not in seen_names:
                    errors.append(
                        ValidationError(
                            code="lifecycle_step_dangling_reference",
                            field=f"{step_path}.branches.{decision}",
                            message=(
                                f"lifecycle step {name!r}.branches[{decision!r}] "
                                f"references unknown step {target!r} "
                                f"(known: {sorted(seen_names)})"
                            ),
                            value=target,
                            params={
                                "step": name,
                                "branch": str(decision),
                                "target": target,
                                "reference": "branch",
                            },
                        )
                    )

        on_failure = step.get("on_failure")
        if on_failure is not None and on_failure != "":
            if not isinstance(on_failure, str) or on_failure not in seen_names:
                errors.append(
                    ValidationError(
                        code="lifecycle_step_dangling_reference",
                        field=f"{step_path}.on_failure",
                        message=(
                            f"lifecycle step {name!r}.on_failure references "
                            f"unknown step {on_failure!r} "
                            f"(known: {sorted(seen_names)})"
                        ),
                        value=on_failure,
                        params={
                            "step": name,
                            "target": on_failure,
                            "reference": "on_failure",
                        },
                    )
                )

        # A produces_decision step that routes via branches but declares no
        # on_failure has no fallback for the empty-decision case: if the verdict
        # source emits nothing parseable, the runner routes to on_failure, and
        # without one the tick hard-fails and retries. Warning (not error) — the
        # live review_diff has this shape today and must keep saving. `branch` is
        # exempt: it routes via an expression-evaluated next-step override
        # (params.cases), never via an empty decision return, so it can't dead-end.
        if (
            LIFECYCLE_KINDS[kind]["produces_decision"]
            and kind != "branch"
            and has_branches
            and (on_failure is None or on_failure == "")
        ):
            errors.append(
                ValidationError(
                    code="produces_decision_no_failure_fallback",
                    field=step_path,
                    message=(
                        f"produces_decision step {name!r} has branches but no "
                        f"on_failure; if the LLM emits no parseable decision the "
                        f"runner routes to on_failure — without one the tick "
                        f"hard-fails and retries"
                    ),
                    value=name,
                    severity="warning",
                )
            )

        # Phase 4 (LLM-lifecycle contract): the runner owns note-writing.
        # `create_note.params.kind` is required, `from_llm_output` is hard-
        # rejected with a migration hint, and `body_from` must be a member
        # of the closed enum (already enforced by _validate_lifecycle_params,
        # but the kind check is custom because params_schema doesn't model
        # "required" as a separate gate).
        if kind == "create_note":
            params = step.get("params") or {}
            if isinstance(params, dict):
                note_kind = params.get("kind")
                if not isinstance(note_kind, str) or not note_kind:
                    errors.append(
                        ValidationError(
                            code="create_note_missing_kind",
                            field=f"{step_path}.params.kind",
                            message=(
                                f"create_note step {name!r} must declare "
                                f"params.kind (the note registry key)"
                            ),
                        )
                    )
                if "from_llm_output" in params:
                    errors.append(
                        ValidationError(
                            code="create_note_from_llm_output_removed",
                            field=f"{step_path}.params.from_llm_output",
                            message=(
                                "from_llm_output is removed; use "
                                "body_from: findings instead (or 'raw' / "
                                "'summary' / 'decision' for other LLM channels)"
                            ),
                            value=params.get("from_llm_output"),
                        )
                    )

        # Phase 6: claim steps must carry a non-empty pipeline_role to
        # populate CardParticipant.pipeline_role for role-aware filters.
        # Legacy configs that only set participant_role get a deprecation
        # warning (becomes an error after the Phase 3 backfill enforcement).
        if kind == "claim":
            params = step.get("params") or {}
            pipeline_role = params.get("pipeline_role") if isinstance(params, dict) else None
            if not isinstance(pipeline_role, str) or not pipeline_role:
                errors.append(
                    ValidationError(
                        code="claim_missing_pipeline_role",
                        field=f"{step_path}.params.pipeline_role",
                        message=(
                            f"claim step {name!r} omits pipeline_role; "
                            f"role-aware discover filters key on this. "
                            f"Add params.pipeline_role = <stage role name>."
                        ),
                        severity="warning",
                    )
                )

    # Phase 5: decision-branch terminal-move check (FOLLOWUP-13 guard).
    _check_decision_branches_reach_card_moving_terminal(
        lifecycle, valid_step_indices, path, errors
    )


# Card-moving terminal kinds — terminate the walk AND move the card forward.
_CARD_MOVING_TERMINAL_KINDS = frozenset({"move_card", "ship"})


def _check_decision_branches_reach_card_moving_terminal(
    lifecycle: list,
    valid_indices: list[int],
    path: str,
    errors: list[ValidationError],
) -> None:
    """For each decision-producing step, walk every branch to its terminal.

    Three cases:
      - branch reaches move_card / ship  -> OK (silent).
      - branch terminates at apply_label / create_note / similar without a
        wake_role anywhere upstream -> WARNING (FOLLOWUP-13: card sits idle).
      - branch loops forever with no terminal reachable -> ERROR.
    """
    by_name: dict[str, dict] = {}
    for idx in valid_indices:
        step = lifecycle[idx]
        by_name[step["name"]] = step

    for idx in valid_indices:
        step = lifecycle[idx]
        branches = step.get("branches")
        if not isinstance(branches, dict):
            continue
        step_path = f"{path}[{idx}]"

        for decision, target in branches.items():
            if not isinstance(target, str) or target not in by_name:
                continue
            outcome = _walk_branch_to_terminal(target, by_name)
            if outcome is None:
                errors.append(
                    ValidationError(
                        code="lifecycle_decision_branch_no_terminal",
                        field=f"{step_path}.branches.{decision}",
                        message=(
                            f"decision branch {decision!r} on step "
                            f"{step['name']!r} never reaches a terminal step "
                            f"(infinite loop)"
                        ),
                        value=decision,
                    )
                )
                continue
            terminal_kind, saw_wake_role = outcome
            if terminal_kind in _CARD_MOVING_TERMINAL_KINDS:
                continue
            if saw_wake_role:
                continue
            errors.append(
                ValidationError(
                    code="lifecycle_decision_branch_missing_terminal_move",
                    field=f"{step_path}.branches.{decision}",
                    message=(
                        f"decision branch {decision!r} on step "
                        f"{step['name']!r} terminates at {terminal_kind!r} "
                        f"without a card-moving step (move_card/ship) or "
                        f"a wake_role handoff — card may sit idle "
                        f"(FOLLOWUP-13 pattern)."
                    ),
                    value=decision,
                    severity="warning",
                )
            )


def _walk_branch_to_terminal(
    start_name: str, by_name: dict[str, dict]
) -> tuple[str, bool] | None:
    """Walk `next` from `start_name` until a terminal kind, returning
    (terminal_kind, saw_wake_role) or None on infinite loop.

    Branches are not re-walked here (the caller traverses each branch
    explicitly); only the linear `next` chain is followed.
    """
    seen: set[str] = set()
    cursor: str | None = start_name
    saw_wake_role = False
    while cursor is not None:
        if cursor in seen:
            return None
        seen.add(cursor)
        step = by_name.get(cursor)
        if step is None:
            return None
        kind = step.get("kind")
        if kind == "wake_role":
            saw_wake_role = True
        schema = LIFECYCLE_KINDS.get(kind) if isinstance(kind, str) else None
        if schema and schema["terminal"]:
            return (kind, saw_wake_role)
        next_target = step.get("next")
        if isinstance(next_target, str):
            cursor = next_target
            continue
        # Decision-producing step inside a branch — treat as a non-terminal
        # stop for this branch's check (each of its own branches gets walked
        # by the outer caller).
        if isinstance(step.get("branches"), dict):
            return (kind or "branch", saw_wake_role)
        cursor = None
    return None


def _validate_lifecycle_params(
    kind: str, params: Any, path: str, errors: list[ValidationError]
) -> None:
    """Typecheck known params against the kind's schema. Unknown keys pass."""
    if params is None:
        return
    if not isinstance(params, dict):
        errors.append(
            ValidationError(
                code="lifecycle_step_invalid_params",
                field=path,
                message=f"{path} must be a JSON object",
            )
        )
        return

    schema = LIFECYCLE_KINDS[kind]["params_schema"]
    for key, value in params.items():
        spec = schema.get(key)
        if spec is None:
            # Forward-compat: unknown keys are tolerated so older backends
            # don't reject configs authored against newer kinds.
            continue
        expected_type = spec.get("type")
        if not _matches_json_type(value, expected_type):
            errors.append(
                ValidationError(
                    code="lifecycle_step_invalid_params",
                    field=f"{path}.{key}",
                    message=(
                        f"lifecycle param {key!r} must be of type "
                        f"{expected_type!r} (got {type(value).__name__})"
                    ),
                    value=value,
                )
            )
            continue
        enum = spec.get("enum")
        if enum and value not in enum:
            errors.append(
                ValidationError(
                    code="lifecycle_step_invalid_params",
                    field=f"{path}.{key}",
                    message=(
                        f"lifecycle param {key!r}={value!r} is not one of "
                        f"{sorted(enum)}"
                    ),
                    value=value,
                )
            )

    if kind == "llm":
        _validate_llm_model_value(params.get("model"), f"{path}.model", errors)

    if kind == "wake_role":
        roles = params.get("roles")
        if not isinstance(roles, list) or not roles:
            errors.append(
                ValidationError(
                    code="lifecycle_step_invalid_params",
                    field=f"{path}.roles",
                    message="wake_role requires 'roles' to be a non-empty list of strings",
                    value=roles,
                )
            )
        else:
            for i, role in enumerate(roles):
                if not isinstance(role, str) or not role:
                    errors.append(
                        ValidationError(
                            code="lifecycle_step_invalid_params",
                            field=f"{path}.roles[{i}]",
                            message="wake_role 'roles' entries must be non-empty strings",
                            value=role,
                        )
                    )


def _matches_json_type(value: Any, expected: str | None) -> bool:
    if expected is None:
        return True
    # bool is a subclass of int — reject explicitly so True/False don't slip
    # through where a number was expected. We don't currently use "number"
    # in lifecycle params; this guard is still cheaper than future-debt.
    if expected == "string":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "array":
        return isinstance(value, list)
    if expected == "object":
        return isinstance(value, dict)
    return True
