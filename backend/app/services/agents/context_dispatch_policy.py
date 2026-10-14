# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Pure reading of the context-dispatch policy stored in a pipeline config.

Floors are deliberately coarse: ANY required source or budget opt-in anywhere
in the pipeline (a non-first lifecycle step included) requires v1 from every
agent in the workspace, so no role-specific negotiation can miss a call site.
Enrollment (`context_dispatch.required_agent_ids`) adds per-agent floors.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

from app.services.agents.context_manifest import canonical_json, sha256_text

LEGACY = "legacy"
REQUIRED = "required"
_POLICY_REVISION_DOMAIN = "backplane.context-dispatch-policy.v1\0"
_ENROLLMENT_KEYS = frozenset({"version", "required_agent_ids"})
AUXILIARY_SLOTS = frozenset({"mediate_rework", "implement_after_approval", "rework_implement"})


def _llm_blocks(pipeline: dict) -> Iterator[tuple[str, dict, dict | None]]:
    """(location, llm-like dict, stage) for every flat stage.llm and every
    lifecycle llm step's params — the places sources and budgets live."""
    stages = pipeline.get("stages") if isinstance(pipeline, dict) else None
    for index, stage in enumerate(stages if isinstance(stages, list) else []):
        if not isinstance(stage, dict):
            continue
        if isinstance(stage.get("llm"), dict):
            yield f"stages[{index}].llm", stage["llm"], stage
        lifecycle = stage.get("lifecycle")
        for step_index, step in enumerate(lifecycle if isinstance(lifecycle, list) else []):
            if isinstance(step, dict) and step.get("kind") == "llm" and isinstance(step.get("params"), dict):
                yield f"stages[{index}].lifecycle[{step_index}].params", step["params"], stage


def _sources(block: dict) -> list[tuple[int, dict]]:
    sources = block.get("context_sources")
    return [(i, s) for i, s in enumerate(sources if isinstance(sources, list) else []) if isinstance(s, dict)]


def sources_by_location(pipeline: dict) -> dict[str, dict]:
    return {
        f"{location}.context_sources[{i}]": source
        for location, block, _ in _llm_blocks(pipeline)
        for i, source in _sources(block)
    }


def required_source_locations(pipeline: dict) -> list[str]:
    return [loc for loc, source in sources_by_location(pipeline).items() if source.get("required") is True]


def budget_opt_ins(pipeline: dict) -> dict[str, Any]:
    """location -> stored value of every budget opt-in, including a key
    present with an invalid value: unenforceable is never unbounded."""
    found: dict[str, Any] = {}
    if isinstance(pipeline, dict) and "context_budget" in pipeline:
        found["context_budget"] = pipeline["context_budget"]
    for location, block, _ in _llm_blocks(pipeline):
        if "context_budget" in block:
            found[f"{location}.context_budget"] = block["context_budget"]
        for i, source in _sources(block):
            if "max_rendered_bytes" in source:
                found[f"{location}.context_sources[{i}].max_rendered_bytes"] = source["max_rendered_bytes"]
    return found


def canonical_agent_id(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        return str(uuid.UUID(value))
    except ValueError:
        return None


def enrolled_agent_ids(pipeline: dict) -> frozenset[str]:
    block = pipeline.get("context_dispatch") if isinstance(pipeline, dict) else None
    ids = block.get("required_agent_ids") if isinstance(block, dict) else None
    return frozenset(
        c for c in (canonical_agent_id(v) for v in (ids if isinstance(ids, list) else [])) if c
    )


@dataclass(frozen=True)
class PolicyScan:
    enrolled: frozenset[str]
    required_sources: tuple[str, ...]
    budgets: dict[str, Any]
    # Filled by the policy service from the budget engine (this module stays pure).
    budget_findings: tuple = ()

    @property
    def workspace_floor(self) -> bool:
        return bool(self.required_sources or self.budgets)

    @property
    def any_floor(self) -> bool:
        return self.workspace_floor or bool(self.enrolled)

    def mode_for(self, agent_id: uuid.UUID | str) -> str:
        return REQUIRED if self.workspace_floor or str(agent_id) in self.enrolled else LEGACY

    def policy_revision(self, *, workspace_id: uuid.UUID, agent_id: uuid.UUID) -> str:
        mode = self.mode_for(agent_id)
        return sha256_text(_POLICY_REVISION_DOMAIN + canonical_json({
            "protocol_version": 1,
            "workspace_id": str(workspace_id),
            "agent_id": str(agent_id),
            "mode": mode,
            "minimum_version": 1 if mode == REQUIRED else 0,
            "required_agent_ids": sorted(self.enrolled),
            "workspace_floor": self.workspace_floor,
            "budget_opt_in": bool(self.budgets),
        }))


def scan_policy(pipeline: dict | None) -> PolicyScan:
    pipeline = pipeline if isinstance(pipeline, dict) else {}
    return PolicyScan(
        enrolled=enrolled_agent_ids(pipeline),
        required_sources=tuple(required_source_locations(pipeline)),
        budgets=budget_opt_ins(pipeline),
    )


@dataclass(frozen=True)
class _Invocation:
    role: object
    # None for the flat stage block. A lifecycle step is always is_step,
    # whatever its stored name or params (null included): a real step must
    # never share the flat block's identity.
    step_name: object
    is_step: bool
    flat: dict
    params: object
    sources: object

    @property
    def identity(self) -> str:
        return canonical_json(["step", self.role, self.step_name] if self.is_step else ["flat", self.role])


def _invocations(pipeline: dict | None) -> Iterator[_Invocation]:
    """Every invocation with its RAW params (the flat block has none) and
    effective context_sources, by the named-step resolver's rule: a step's
    `context_sources` key replaces the flat list (an explicit [] selects
    none); absence inherits. Absent params read as {}; malformed params
    (null, non-dict) are kept as stored and inherit like the resolver does."""
    pipeline = pipeline if isinstance(pipeline, dict) else {}
    stages = pipeline.get("stages")
    for stage in stages if isinstance(stages, list) else []:
        if not isinstance(stage, dict):
            continue
        flat = stage.get("llm") if isinstance(stage.get("llm"), dict) else {}
        flat_sources = flat.get("context_sources")
        yield _Invocation(stage.get("role"), None, False, flat, None, flat_sources)
        lifecycle = stage.get("lifecycle")
        for step in lifecycle if isinstance(lifecycle, list) else []:
            if isinstance(step, dict) and step.get("kind") == "llm":
                params = step.get("params", {})
                own = isinstance(params, dict) and "context_sources" in params
                yield _Invocation(
                    stage.get("role"), step.get("name"), True, flat, params,
                    params["context_sources"] if own else flat_sources,
                )


_ABSENT_LAYER = "<absent>"


def _budget_layer(container: dict | None, key: str):
    """A conservative normalized RAW budget layer, never a resolved policy.
    Absence stays distinct from any present object (an opt-in). An omitted
    version defaults to 1, the only supported one, including on {}: {} and
    {version: 1} opt in to the same inherited defaults. Anything else (null,
    a string, an unsupported version) is kept verbatim so it stays
    protected."""
    if not isinstance(container, dict) or key not in container:
        return _ABSENT_LAYER
    value = container[key]
    if isinstance(value, dict):
        return value if "version" in value else {"version": 1, **value}
    return {"stored_value": value}


def _capped_multiset(sources: object) -> list[dict]:
    return sorted(
        (s for s in (sources if isinstance(sources, list) else [])
         if isinstance(s, dict) and "max_rendered_bytes" in s),
        key=canonical_json,
    )


def budget_identity_policy(pipeline: dict | None) -> dict:
    """Budget policy keyed by what it applies to, never by array index:
    the human-selected workspace declaration on its own; per stage role the
    raw stage layer and the sorted MULTISET of its flat capped source
    definitions; and per (role, step name) only where a step DIVERGES from
    what it inherits: its own raw budget layer, malformed params (kept
    verbatim), or effective caps that differ from the flat ones.

    So swapping names, retargeting or re-assigning a cap, or an override
    dropping inherited caps all change it; reordering capped sources with
    their caps, or renaming a step that only inherits, does not."""
    pipeline = pipeline if isinstance(pipeline, dict) else {}
    invocations = {}
    flat_caps: dict[str, list[dict]] = {}
    for invocation in _invocations(pipeline):
        caps = _capped_multiset(invocation.sources)
        role_key = canonical_json(invocation.role)
        if not invocation.is_step:
            flat_caps[role_key] = caps
            stage_layer = _budget_layer(invocation.flat, "context_budget")
            if stage_layer != _ABSENT_LAYER or caps:
                invocations[invocation.identity] = {"stage": stage_layer, "capped_sources": caps}
            continue
        step_layer = (
            _budget_layer(invocation.params, "context_budget") if isinstance(invocation.params, dict)
            else {"stored_params": invocation.params}
        )
        if step_layer != _ABSENT_LAYER or caps != flat_caps.get(role_key, []):
            invocations[invocation.identity] = {"step": step_layer, "capped_sources": caps}
    return {"workspace": _budget_layer(pipeline, "context_budget"), "invocations": invocations}


def new_budget_opt_ins(old_pipeline: dict | None, new_pipeline: dict | None) -> list[str]:
    """Identities whose budget policy a write adds or changes; a pure
    removal is not an opt-in. Conservative while budgets are unavailable:
    a partial change of an invocation's budget counts as an opt-in."""
    old, new = budget_identity_policy(old_pipeline), budget_identity_policy(new_pipeline)
    changed = []
    if new["workspace"] not in (_ABSENT_LAYER, old["workspace"]):
        changed.append("context_budget")
    for key, entry in new["invocations"].items():
        if old["invocations"].get(key) != entry:
            changed.append(f"invocation {key}")
    return changed


def effective_required_policy(pipeline: dict | None) -> list[tuple[str, list[dict]]]:
    """(invocation identity, the full definitions of the sources that
    invocation requires).

    Keyed by the invocation's identity, never by numeric path: shadowing an
    inherited source, swapping step names or renaming the role all change
    what some invocation requires, while restating inherited sources
    explicitly changes nothing."""
    policy = []
    for invocation in _invocations(pipeline):
        sources = invocation.sources
        required = [
            s for s in (sources if isinstance(sources, list) else [])
            if isinstance(s, dict) and s.get("required") is True
        ]
        if required:
            policy.append((invocation.identity, required))
    return sorted(policy, key=lambda entry: canonical_json(entry))


def has_protected_policy(pipeline: dict | None) -> bool:
    return protected_projection(pipeline, include_prompt_slots=scan_policy(pipeline).any_floor) != (
        protected_projection(None, include_prompt_slots=False)
    )


def protected_projection(pipeline: dict | None, *, include_prompt_slots: bool) -> str:
    """Canonical text of every policy an agent key may never change: the
    enrollment block, the effective required sources of every invocation
    (full definitions, so retargeting one while keeping `required: true`
    counts), and budget opt-ins. Auxiliary prompt_slots only steer
    required-mode calls, so they are protected while either side of a write
    has a floor; on a legacy pipeline they are inert and seeding defaults
    stays an ordinary edit."""
    pipeline = pipeline if isinstance(pipeline, dict) else {}
    stages = pipeline.get("stages") if include_prompt_slots else []
    return canonical_json({
        "context_dispatch": pipeline.get("context_dispatch", "<absent>"),
        "required_sources": effective_required_policy(pipeline),
        "budgets": budget_identity_policy(pipeline),
        "prompt_slots": [
            (stage.get("role"), (stage.get("llm") or {}).get("prompt_slots"))
            for stage in (stages if isinstance(stages, list) else [])
            if isinstance(stage, dict) and isinstance(stage.get("llm"), dict)
            and "prompt_slots" in stage["llm"]
        ],
    })


def auxiliary_slots_needed(stage: dict) -> list[str]:
    """Auxiliary call slots this stage's configured behavior will invoke —
    derived from behavior flags, never from the role's name."""
    llm = stage.get("llm") if isinstance(stage.get("llm"), dict) else {}
    lifecycle = stage.get("lifecycle")
    steps = [
        s.get("params") for s in (lifecycle if isinstance(lifecycle, list) else [])
        if isinstance(s, dict) and s.get("kind") == "llm" and isinstance(s.get("params"), dict)
    ]
    needed = []
    if llm.get("approval_enabled") is True or any(p.get("approval_enabled") is True for p in steps):
        needed.append("implement_after_approval")
    if (stage.get("discover") or {}).get("strategy") == "unassigned_or_rework":
        needed += ["mediate_rework", "rework_implement"]
    return needed


def enrollment_shape_errors(block: Any) -> list[tuple[str, str]]:
    """(field suffix, message) for a malformed context_dispatch block."""
    if not isinstance(block, dict):
        return [("", "context_dispatch must be an object {version: 1, required_agent_ids: [...]}")]
    errors = []
    unknown = sorted(set(block) - _ENROLLMENT_KEYS)
    if unknown:
        errors.append(("", f"unknown context_dispatch keys {unknown}"))
    version = block.get("version")
    # Exact int: True and 1.0 both compare equal to 1.
    if type(version) is not int or version != 1:
        errors.append((".version", "context_dispatch.version must be the integer 1"))
    ids = block.get("required_agent_ids")
    if not isinstance(ids, list):
        errors.append((".required_agent_ids", "required_agent_ids must be a list of agent UUIDs"))
        return errors
    seen: set[str] = set()
    for i, value in enumerate(ids):
        canonical = canonical_agent_id(value)
        if canonical is None:
            errors.append((f".required_agent_ids[{i}]", "required_agent_ids entries must be UUID strings"))
        elif canonical in seen:
            errors.append((f".required_agent_ids[{i}]", "duplicate agent id in required_agent_ids"))
        else:
            seen.add(canonical)
    return errors


def prompt_slot_shape_errors(slots: Any) -> list[tuple[str, str]]:
    if not isinstance(slots, dict):
        return [("", "prompt_slots must be an object of call slot -> {role, stage}")]
    errors = []
    for slot, target in slots.items():
        if slot not in AUXILIARY_SLOTS:
            errors.append((f".{slot}", f"unknown prompt slot {slot!r} (expected one of {sorted(AUXILIARY_SLOTS)})"))
        elif not (
            isinstance(target, dict) and set(target) == {"role", "stage"}
            and all(isinstance(target[k], str) and target[k] for k in ("role", "stage"))
        ):
            errors.append((f".{slot}", "a prompt slot maps to exactly {role: string, stage: string}"))
    return errors
