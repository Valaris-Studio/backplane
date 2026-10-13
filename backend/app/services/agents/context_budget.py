# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The one context-budget resolution engine: config writes, reads,
assignment/start negotiation and dispatch all resolve policy here.

Layers are workspace -> stage `llm` -> the actual named lifecycle step. The
workspace block is both the inherited defaults and the ceiling for its
children (built-in defaults when absent); each child may only tighten its
parent, omitted fields and versions inherit, and every ancestor must itself
be valid before a child is judged. Typed instance ceilings bound every
effective workspace value, inherited ones included: raising a ceiling never
raises a default, lowering one invalidates an inherited default until the
workspace tightens explicitly. Values outside the contract are refused,
never clamped.
"""

import re
from dataclasses import asdict, dataclass, field
from typing import Any, TypeGuard

from app.config import ContextBudgetCeilings
from app.exceptions import ConflictError
from app.services.agents.context_dispatch_policy import budget_opt_ins
from app.services.agents.context_manifest import canonical_json, sha256_text, utf8_bytes
from app.services.pipeline_config_validation import ValidationError as Finding

CONTEXT_BUDGET_VERSION = 1
_POLICY_DIGEST_DOMAIN = "backplane.context-budget.v1\0"

BUILT_IN_CONTEXT_BUDGET = {
    "max_note_body_bytes": 1_048_576,
    "max_note_fetch_bytes": 2_097_152,
    "max_optional_note_bytes": 65_536,
    "max_managed_context_bytes": 131_072,
    "max_invocation_bytes": 262_144,
}
NOTE_WINDOW_DEFAULT = 50
NOTE_WINDOW_MAX = 50


@dataclass(frozen=True)
class ContextBudgetPolicy:
    version: int
    max_note_body_bytes: int
    max_note_fetch_bytes: int
    max_optional_note_bytes: int
    max_managed_context_bytes: int
    max_invocation_bytes: int

    def as_dict(self) -> dict[str, int]:
        return asdict(self)

    @property
    def sha256(self) -> str:
        return sha256_text(_POLICY_DIGEST_DOMAIN + canonical_json(self.as_dict()))


def invalid_context_budget(reason: str) -> ConflictError:
    return ConflictError(
        f"The configured context budget is not supported: {reason}",
        error_code="context_budget_invalid",
    )


def is_strict_int(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool)


def resolve_context_budget(
    stored: object, ceilings: ContextBudgetCeilings
) -> ContextBudgetPolicy:
    """A single workspace-level block (phase-1 entry point)."""
    policy, findings = _resolve_chain(
        [(WORKSPACE_PATH, stored)], ceilings, echo_keys=False
    )
    if findings or policy is None:
        raise invalid_persisted_budget(findings)
    return policy


WORKSPACE_PATH = "context_budget"
_ABSENT = object()
_KNOWN_KEYS = frozenset({"version", *BUILT_IN_CONTEXT_BUDGET})
# Only short identifier-like unknown keys are named in a write finding; any
# other stored key is counted, never echoed (keys are operator-controlled).
_NAMEABLE_KEY = re.compile(r"[A-Za-z0-9_]{1,64}")
_MAX_NAMED_UNKNOWN_KEYS = 8
_RELATIONS = (
    ("max_note_body_bytes", "max_note_fetch_bytes"),
    ("max_optional_note_bytes", "max_managed_context_bytes"),
    ("max_managed_context_bytes", "max_invocation_bytes"),
)
_MAX_ERROR_FINDINGS = 16
_MAX_ERROR_FINDING_BYTES = 2048
_MAX_WRITE_FINDINGS = 32
_MAX_WRITE_FINDING_BYTES = 3072


@dataclass(frozen=True)
class BudgetResolution:
    """`policy` is None when the invocation is not opted in (legacy)."""

    policy: ContextBudgetPolicy | None
    findings: list[Finding] = field(default_factory=list)


def _invalid(path: str, message: str, **params: Any) -> Finding:
    return Finding(
        code="context_budget_invalid",
        field=path,
        message=message,
        params=params or None,
    )


def _layer_overrides(
    value: object, path: str, *, echo_keys: bool
) -> tuple[dict[str, int] | None, list[Finding]]:
    if not isinstance(value, dict):
        return None, [_invalid(path, "A context budget must be an object")]
    findings: list[Finding] = []
    unknown = [key for key in value if key not in _KNOWN_KEYS]
    named = [
        key
        for key in unknown
        if echo_keys and isinstance(key, str) and _NAMEABLE_KEY.fullmatch(key)
    ][:_MAX_NAMED_UNKNOWN_KEYS]
    findings += [
        _invalid(f"{path}.{key}", "Unrecognized context budget field") for key in named
    ]
    if len(unknown) > len(named):
        findings.append(
            _invalid(
                path,
                "The context budget has unrecognized fields",
                unknown_field_count=len(unknown) - len(named),
            )
        )
    if "version" in value and not (
        is_strict_int(value["version"]) and value["version"] == CONTEXT_BUDGET_VERSION
    ):
        findings.append(_invalid(f"{path}.version", "version must be the integer 1"))
    overrides: dict[str, int] = {}
    for name in BUILT_IN_CONTEXT_BUDGET:
        if name not in value:
            continue
        limit = value[name]
        if is_strict_int(limit) and limit >= 1:
            overrides[name] = limit
        else:
            findings.append(
                _invalid(f"{path}.{name}", f"{name} must be a positive integer")
            )
    return (None if findings else overrides), findings


def _ceiling_exceeded(path: str, name: str, limit: int, value: int) -> Finding:
    return Finding(
        code="context_budget_ceiling_exceeded",
        field=f"{path}.{name}",
        message=f"{name} exceeds the limit its parent allows",
        params={"field": name, "limit": limit, "effective_value": value},
    )


def _relation_findings(
    effective: dict[str, int], path: str, overrides: dict[str, int]
) -> list[Finding]:
    findings = []
    for low, high in _RELATIONS:
        if effective[low] > effective[high]:
            located = high if high in overrides else low
            findings.append(
                Finding(
                    code="context_budget_inconsistent",
                    field=f"{path}.{located}",
                    message=f"{low} must not exceed {high}",
                    params={"field": low, "other_field": high},
                )
            )
    return findings


def _resolve_chain(
    layers: list[tuple[str, object]],
    ceilings: ContextBudgetCeilings,
    *,
    echo_keys: bool,
) -> tuple[ContextBudgetPolicy | None, list[Finding]]:
    """layers[0] is the workspace (its value may be _ABSENT); later layers
    only tighten. A child is judged only against a valid parent."""
    workspace_path, workspace_value = layers[0]
    overrides: dict[str, int] | None = {}
    findings: list[Finding] = []
    if workspace_value is not _ABSENT:
        overrides, findings = _layer_overrides(
            workspace_value, workspace_path, echo_keys=echo_keys
        )
    effective: dict[str, int] | None = None
    if overrides is not None:
        effective = {**BUILT_IN_CONTEXT_BUDGET, **overrides}
        exceeded = [
            _ceiling_exceeded(workspace_path, name, getattr(ceilings, name), value)
            for name, value in effective.items()
            if value > getattr(ceilings, name)
        ]
        exceeded += _relation_findings(effective, workspace_path, overrides)
        if exceeded:
            findings += exceeded
            effective = None
    for path, value in layers[1:]:
        if value is _ABSENT:
            continue
        overrides, layer_findings = _layer_overrides(value, path, echo_keys=echo_keys)
        findings += layer_findings
        if effective is None or overrides is None:
            effective = None
            continue
        tightened = {**effective, **overrides}
        layer_findings = [
            _ceiling_exceeded(path, name, effective[name], value)
            for name, value in overrides.items()
            if value > effective[name]
        ] + _relation_findings(tightened, path, overrides)
        findings += layer_findings
        effective = None if layer_findings else tightened
    if effective is None or findings:
        return None, findings
    return ContextBudgetPolicy(version=CONTEXT_BUDGET_VERSION, **effective), findings


def _sources_shape_findings(container: dict, path: str) -> list[Finding]:
    # Present but not a list (null, "", 0 and {} included) is invalid under a
    # budget, exactly as on write; absent still means inherit.
    if "context_sources" in container and not isinstance(
        container["context_sources"], list
    ):
        return [_invalid(f"{path}.context_sources", "context_sources must be a list")]
    return []


def _source_cap_findings(
    sources: object, path: str, policy: ContextBudgetPolicy | None
) -> list[Finding]:
    findings = []
    for index, source in enumerate(sources if isinstance(sources, list) else []):
        if not isinstance(source, dict):
            # Under a budget a malformed entry fails closed: dropping it would
            # silently re-index every later source.
            findings.append(
                _invalid(
                    f"{path}.context_sources[{index}]",
                    "A context source must be an object",
                )
            )
            continue
        if "max_rendered_bytes" not in source:
            continue
        cap = source["max_rendered_bytes"]
        location = f"{path}.context_sources[{index}].max_rendered_bytes"
        if not is_strict_int(cap) or cap < 1:
            findings.append(
                _invalid(location, "max_rendered_bytes must be a positive integer")
            )
        elif policy is not None and cap > policy.max_managed_context_bytes:
            findings.append(
                _ceiling_exceeded(
                    location.rsplit(".", 1)[0],
                    "max_rendered_bytes",
                    policy.max_managed_context_bytes,
                    cap,
                )
            )
    return findings


def _llm_layers(pipeline: dict):
    """(stage index, stage llm block or None, [(step index, step params)])."""
    stages = pipeline.get("stages")
    for index, stage in enumerate(stages if isinstance(stages, list) else []):
        if not isinstance(stage, dict):
            continue
        llm = stage.get("llm") if isinstance(stage.get("llm"), dict) else None
        lifecycle = stage.get("lifecycle")
        # Absent params mean {} (as the named-step resolver reads them); a
        # non-object is passed through so the caller can refuse it.
        steps = [
            (step_index, step.get("params", {}))
            for step_index, step in enumerate(
                lifecycle if isinstance(lifecycle, list) else []
            )
            if isinstance(step, dict) and step.get("kind") == "llm"
        ]
        yield index, llm, steps


def _invocation_opted_in(layers: list[tuple[str, object]], sources: object) -> bool:
    """Any present layer (whatever its value) or a source cap opts in."""
    return any(value is not _ABSENT for _, value in layers) or any(
        isinstance(source, dict) and "max_rendered_bytes" in source
        for source in (sources if isinstance(sources, list) else [])
    )


def validate_pipeline_budgets(
    pipeline: dict | None, ceilings: ContextBudgetCeilings, *, echo_keys: bool = True
) -> list[Finding]:
    """Every policy an invocation of this pipeline could resolve, judged as
    a write. Empty when nothing opts in (legacy pipelines are untouched)."""
    pipeline = pipeline if isinstance(pipeline, dict) else {}
    if not budget_opt_ins(pipeline):
        return []
    workspace = (WORKSPACE_PATH, pipeline.get("context_budget", _ABSENT))
    workspace_policy, findings = _resolve_chain(
        [workspace], ceilings, echo_keys=echo_keys
    )
    workspace_failed = bool(findings)
    for index, llm, steps in _llm_layers(pipeline):
        stage_layer = (
            f"stages[{index}].llm.context_budget",
            llm.get("context_budget", _ABSENT) if llm is not None else _ABSENT,
        )
        stage_policy, stage_findings = _resolve_chain(
            [workspace, stage_layer], ceilings, echo_keys=echo_keys
        )
        findings += [
            f
            for f in stage_findings
            if not (workspace_failed and f["field"].startswith(WORKSPACE_PATH))
        ]
        if llm is not None:
            findings += _sources_shape_findings(llm, f"stages[{index}].llm")
            findings += _source_cap_findings(
                llm.get("context_sources"), f"stages[{index}].llm", stage_policy
            )
        for step_index, params in steps:
            if not isinstance(params, dict):
                # Read as {} by the named-step resolver: refused only when that
                # invocation is itself opted in, never because another step is.
                inherited = llm.get("context_sources") if llm is not None else None
                if _invocation_opted_in([workspace, stage_layer], inherited):
                    findings.append(
                        _invalid(
                            f"stages[{index}].lifecycle[{step_index}].params",
                            "A lifecycle step's params must be an object",
                        )
                    )
                continue
            owns_sources = "context_sources" in params
            if "context_budget" not in params and not owns_sources:
                continue
            step_layer = (
                f"stages[{index}].lifecycle[{step_index}].params.context_budget",
                params.get("context_budget", _ABSENT),
            )
            step_policy, step_findings = _resolve_chain(
                [workspace, stage_layer, step_layer], ceilings, echo_keys=echo_keys
            )
            findings += [
                f for f in step_findings if f["field"].startswith(step_layer[0])
            ]
            if owns_sources:
                findings += _sources_shape_findings(
                    params, f"stages[{index}].lifecycle[{step_index}].params"
                )
                findings += _source_cap_findings(
                    params["context_sources"],
                    f"stages[{index}].lifecycle[{step_index}].params",
                    step_policy,
                )
            elif llm is not None:
                # An inheriting step bounds the stage's sources by its own
                # (tighter) managed limit; shape errors were reported above.
                findings += [
                    f
                    for f in _source_cap_findings(
                        llm.get("context_sources"), f"stages[{index}].llm", step_policy
                    )
                    if f["code"] == "context_budget_ceiling_exceeded"
                    and f not in findings
                ]
    return findings


def resolve_invocation_budget(
    pipeline: dict | None,
    *,
    stage_index: int,
    step_index: int | None,
    ceilings: ContextBudgetCeilings,
) -> BudgetResolution:
    """The effective policy of one invocation (the actual named step). An
    invocation opts in through any of its own layers or a source cap. Sources
    are read raw from the configuration (the step's list when present, else
    the stage's) so every finding keeps its stored index."""
    pipeline = pipeline if isinstance(pipeline, dict) else {}
    stage = pipeline["stages"][stage_index]
    llm = stage.get("llm") if isinstance(stage.get("llm"), dict) else {}
    layers: list[tuple[str, object]] = [
        (WORKSPACE_PATH, pipeline.get("context_budget", _ABSENT)),
        (
            f"stages[{stage_index}].llm.context_budget",
            llm.get("context_budget", _ABSENT),
        ),
    ]
    sources_path = f"stages[{stage_index}].llm"
    sources_owner: dict = llm
    malformed: list[Finding] = []
    if step_index is not None:
        params = stage["lifecycle"][step_index].get("params", {})
        if not isinstance(params, dict):
            params_path = f"stages[{stage_index}].lifecycle[{step_index}].params"
            malformed.append(
                _invalid(params_path, "A lifecycle step's params must be an object")
            )
            params = {}
        if "context_sources" in params:
            sources_path = f"stages[{stage_index}].lifecycle[{step_index}].params"
            sources_owner = params
        layers.append(
            (
                f"stages[{stage_index}].lifecycle[{step_index}].params.context_budget",
                params.get("context_budget", _ABSENT),
            )
        )
    malformed += _sources_shape_findings(sources_owner, sources_path)
    sources = sources_owner.get("context_sources")
    sources = sources if isinstance(sources, list) else []
    if not _invocation_opted_in(layers, sources):
        return BudgetResolution(policy=None)
    # Persisted values may be attacker-shaped: never echo unknown keys here.
    policy, findings = _resolve_chain(layers, ceilings, echo_keys=False)
    findings = (
        malformed + findings + _source_cap_findings(sources, sources_path, policy)
    )
    return BudgetResolution(policy=None if findings else policy, findings=findings)


def _whole_findings_within(
    findings: list[Finding], *, count: int, size: int
) -> list[Finding]:
    kept: list[Finding] = []
    used = 0
    for finding in findings:
        added = utf8_bytes(canonical_json(dict(finding)))
        if len(kept) == count or used + added > size:
            break
        kept.append(finding)
        used += added
    return kept


def bounded_write_findings(findings: list[Finding]) -> list[Finding]:
    """A write's budget findings, whole and bounded in total; the rest are
    counted in one closing finding, never silently dropped."""
    kept = _whole_findings_within(
        findings, count=_MAX_WRITE_FINDINGS, size=_MAX_WRITE_FINDING_BYTES
    )
    if len(kept) < len(findings):
        kept.append(
            _invalid(
                "",
                "More context budget findings were omitted; fix the ones listed and save again",
                omitted_finding_count=len(findings) - len(kept),
            )
        )
    return kept


def invalid_persisted_budget(findings: list[Finding]) -> ConflictError:
    """409 for an already-stored policy that no longer resolves; never a
    silent legacy/unbounded fallback. Findings are whole and bounded."""
    kept = [
        dict(finding)
        for finding in _whole_findings_within(
            findings, count=_MAX_ERROR_FINDINGS, size=_MAX_ERROR_FINDING_BYTES
        )
    ]
    return ConflictError(
        "The configured context budget is not valid; correct the policy",
        error_code="context_budget_invalid",
        context={
            "findings": kept,
            "finding_count": len(findings),
            "findings_truncated": len(kept) < len(findings),
        },
    )
