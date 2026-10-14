# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Resolve one invocation of a bound role to its effective configuration.

Shared by context dispatch (A2) and bounded context assembly (B1): both must
read the ACTUAL named lifecycle step, never "the first llm step", and both
apply the same inheritance — a step's `context_sources` key replaces the
stage list when present (an explicit [] selects nothing), and is inherited
when absent. Pure: no I/O, and the caller's config is never mutated.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any

INVOCATION_KINDS = frozenset({"stage", "lifecycle", "mediation", "post_approval"})
MAIN_SLOT = "main"
# Each auxiliary call slot may only be used by its own invocation kind.
AUXILIARY_SLOT_KINDS = {
    "mediate_rework": "mediation",
    "implement_after_approval": "post_approval",
    "rework_implement": "stage",
}
# Step params that are inputs of their own (sources, budgets), not llm
# settings layered over the flat block.
_NON_LLM_STEP_PARAMS = frozenset({"context_sources", "context_budget"})


class InvocationInvalid(Exception):
    """The caller named an impossible kind / step / slot combination."""


class InvocationUnavailable(Exception):
    """Current configuration cannot produce this invocation. There is no
    fallback to another step, a default template or runner configuration."""


@dataclass(frozen=True)
class Invocation:
    kind: str
    step_name: str | None
    prompt_slot: str

    def as_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "step_name": self.step_name, "prompt_slot": self.prompt_slot}


@dataclass(frozen=True)
class NamedStep:
    invocation: Invocation
    role: str
    stage: dict
    step: dict | None
    llm: dict
    context_sources: list[dict]
    # Raw (workspace, stage, step) context_budget dicts; merging and
    # tightening belong to the budget enforcer, not to this resolver.
    budget_layers: tuple[dict | None, dict | None, dict | None]
    prompt_target: tuple[str, str]


def parse_invocation(kind: str, step_name: str | None, prompt_slot: str) -> Invocation:
    if kind not in INVOCATION_KINDS:
        raise InvocationInvalid(f"unknown invocation kind {kind!r}")
    if prompt_slot == MAIN_SLOT:
        if kind == "stage" and step_name is not None:
            raise InvocationInvalid("a stage invocation names no lifecycle step")
        if kind == "lifecycle" and not step_name:
            raise InvocationInvalid("a lifecycle invocation must name its step")
        if kind not in {"stage", "lifecycle"}:
            raise InvocationInvalid(f"{kind!r} invocations use their auxiliary slot")
    elif AUXILIARY_SLOT_KINDS.get(prompt_slot) != kind:
        raise InvocationInvalid(f"slot {prompt_slot!r} is not usable by a {kind!r} invocation")
    if step_name is not None and (not isinstance(step_name, str) or not step_name):
        raise InvocationInvalid("step_name must be a non-empty string")
    return Invocation(kind=kind, step_name=step_name, prompt_slot=prompt_slot)


def _bound_stage(pipeline_config: dict, role: str) -> dict:
    stages = (pipeline_config or {}).get("stages")
    matches = [
        s for s in (stages if isinstance(stages, list) else [])
        if isinstance(s, dict) and s.get("role") == role
    ]
    if len(matches) != 1:
        raise InvocationUnavailable(f"no single configured stage for role {role!r}")
    return matches[0]


def _named_llm_step(stage: dict, step_name: str) -> dict:
    lifecycle = stage.get("lifecycle")
    for step in lifecycle if isinstance(lifecycle, list) else []:
        if isinstance(step, dict) and step.get("name") == step_name:
            if step.get("kind") != "llm":
                break
            return step
    raise InvocationUnavailable(f"no llm step {step_name!r} in this role's lifecycle")


def _dict_or_none(value: Any) -> dict | None:
    return value if isinstance(value, dict) else None


def resolve_named_step(pipeline_config: dict, *, role: str, invocation: Invocation) -> NamedStep:
    stage = copy.deepcopy(_bound_stage(pipeline_config, role))
    flat_llm = stage.get("llm") if isinstance(stage.get("llm"), dict) else {}

    step = None
    llm = dict(flat_llm)
    sources = flat_llm.get("context_sources")
    step_budget = None
    if invocation.step_name is None:
        if flat_llm.get("enabled") is not True:
            raise InvocationUnavailable("this role's stage has no enabled llm call")
    else:
        step = _named_llm_step(stage, invocation.step_name)
        params = step.get("params") if isinstance(step.get("params"), dict) else {}
        llm.update({k: v for k, v in params.items() if k not in _NON_LLM_STEP_PARAMS})
        if "context_sources" in params:
            sources = params["context_sources"]
        step_budget = _dict_or_none(params.get("context_budget"))

    if invocation.prompt_slot == MAIN_SLOT:
        target_stage = llm.get("stage")
        if not isinstance(target_stage, str) or not target_stage:
            raise InvocationUnavailable("the invocation has no llm stage to render")
        prompt_target = (role, target_stage)
    else:
        slots = flat_llm.get("prompt_slots")
        mapping = slots.get(invocation.prompt_slot) if isinstance(slots, dict) else None
        if not (
            isinstance(mapping, dict)
            and isinstance(mapping.get("role"), str) and mapping["role"]
            and isinstance(mapping.get("stage"), str) and mapping["stage"]
        ):
            raise InvocationUnavailable(f"no prompt mapping for slot {invocation.prompt_slot!r}")
        prompt_target = (mapping["role"], mapping["stage"])

    return NamedStep(
        invocation=invocation,
        role=role,
        stage=stage,
        step=step,
        llm=llm,
        context_sources=[s for s in sources if isinstance(s, dict)] if isinstance(sources, list) else [],
        budget_layers=(
            copy.deepcopy(_dict_or_none((pipeline_config or {}).get("context_budget"))),
            _dict_or_none(flat_llm.get("context_budget")),
            step_budget,
        ),
        prompt_target=prompt_target,
    )
