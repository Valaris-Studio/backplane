# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from dataclasses import dataclass

from app.exceptions import ConflictError
from app.repositories.completion_roles import CompletionRoleRepository
from app.services.llm_tiers import is_tier
from app.services.scheduling.dispatch_resolver import (
    DispatchResolver,
    _lifecycle_llm_params,
)


def effective_completion_llm(stage):
    flat = stage.get("llm") or {}
    lifecycle = _lifecycle_llm_params(stage)
    effective = {**flat, **lifecycle}
    for key in ("provider", "model", "stage", "prompt_slug"):
        effective[key] = lifecycle.get(key) or flat.get(key) or ""
    deny = (lifecycle.get("tool_policy") or {}).get("deny")
    if deny is None:
        deny = (flat.get("tool_policy") or {}).get("deny") or []
    effective["tool_policy"] = {"deny": deny}
    return effective


def completion_role_issue(stage, role, *, direct_checks=False):
    if direct_checks:
        if not stage or stage.get("enabled") is False:
            return {
                "code": "completion_role_unconfigured",
                "message": f"Configure an enabled '{role}' role for direct completion checks; no model provider is required.",
                "role": role,
            }
        return None
    llm = effective_completion_llm(stage)
    if (
        not stage
        or stage.get("enabled") is False
        or llm.get("enabled") is False
        or not llm["provider"]
        or not llm["model"]
    ):
        return {
            "code": "completion_role_unconfigured",
            "message": f"Configure an enabled '{role}' role with provider and model before selecting this policy or claiming completion work.",
            "role": role,
        }
    if is_tier(llm["model"]):
        return {
            "code": "completion_role_model_required",
            "message": f"Configure a concrete model for '{role}' with provider '{llm['provider']}'; completion work cannot remap a model tier to another provider.",
            "role": role,
        }
    deny = llm["tool_policy"]["deny"]
    if not isinstance(deny, list) or any(
        not isinstance(item, str) or not item.strip() for item in deny
    ):
        return {
            "code": "completion_role_tool_policy_invalid",
            "message": f"Configure '{role}' tool_policy.deny as a list of nonempty tool rules.",
            "role": role,
        }
    return None


@dataclass
class CompletionRole:
    provider: str
    model: str
    tool_policy: dict
    stage: dict
    pipeline_stages: list
    prompt: object | None
    prompt_slug: str


async def resolve_completion_role(
    db, workspace_id, role, pipeline, *, direct_checks=False
):
    stage = next(
        (value for value in pipeline.get("stages", []) if value.get("role") == role), {}
    )
    issue = completion_role_issue(stage, role, direct_checks=direct_checks)
    if issue:
        raise ConflictError(issue["message"], error_code=issue["code"])
    if direct_checks:
        return CompletionRole(
            provider="",
            model="",
            tool_policy={"deny": []},
            stage=stage,
            pipeline_stages=pipeline.get("stages", []),
            prompt=None,
            prompt_slug="",
        )
    llm = effective_completion_llm(stage)
    stage_name = llm["stage"]
    slug = llm["prompt_slug"] or await DispatchResolver(db)._resolve_prompt_slug(
        workspace_id=workspace_id,
        role=role,
        stage_name=stage_name,
    )
    prompt = None
    if slug:
        prompt = await CompletionRoleRepository(db).prompt(
            workspace_id, role, stage_name, slug
        )
        if prompt is None or not prompt.content.strip():
            raise ConflictError(
                f"Configure prompt '{slug}' for role '{role}' and stage '{stage_name}' in this workspace before claiming completion work.",
                error_code="completion_role_prompt_required",
            )
    if prompt is not None:
        from app.services.completion_context import validate_completion_prompt

        validate_completion_prompt(prompt.content, stage.get("context_sources") or [])
    return CompletionRole(
        provider=llm["provider"],
        model=llm["model"],
        tool_policy=llm["tool_policy"],
        stage=stage,
        pipeline_stages=pipeline.get("stages", []),
        prompt=prompt,
        prompt_slug=slug,
    )
