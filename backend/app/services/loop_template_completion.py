# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from app.services.loop_config_validation import (
    canonicalize_loop_config,
    validate_loop_config,
)
from app.services.loop_template_render import RenderError, effective_slot_values
from app.services.pipeline_config_validation import ValidationError


def branch_constraint_findings(content, slot_values):
    try:
        values = effective_slot_values(content, slot_values)
    except RenderError as exc:
        return list(exc.errors)
    findings = []
    for constraint in content.setup_contract.get("branch_constraints", []):
        slots = constraint.get("slots", []) if isinstance(constraint, dict) else []
        if (
            not isinstance(constraint, dict)
            or constraint.get("kind") != "distinct"
            or not isinstance(slots, list)
            or len(slots) < 2
            or any(
                not isinstance(slot, str) or slot not in {s.name for s in content.slots}
                for slot in slots
            )
        ):
            findings.append(
                ValidationError(
                    code="invalid_branch_constraint",
                    field="setup_contract.branch_constraints",
                    message="Branch constraints require kind=distinct and at least two declared slots",
                )
            )
        elif len(set(str(values.get(slot, "")) for slot in slots)) != len(slots):
            findings.append(
                ValidationError(
                    code="branch_constraint_conflict",
                    field="slot_values",
                    message=f"Branch slots must resolve to distinct values: {', '.join(slots)}",
                )
            )
    return findings


def completion_policy_findings(policy, config):
    if policy is None:
        return []
    landing = config.get("loop_landing")
    if landing == "self_merge":
        return [
            ValidationError(
                code="completion_policy_conflict",
                field="loop_landing",
                message=f"Explicit completion policy ({policy.landing_actor} landing) cannot authorize self_merge; use policy-mediated landing",
            )
        ]
    return []


def candidate_config(rendered, stored, proposed=None, *, rebind=False, derived_keys=()):
    rails = {
        key: value
        for key, value in rendered.rails.items()
        if not rebind or key in derived_keys
    }
    return canonicalize_loop_config(
        {
            **rails,
            **{
                key: value
                for key, value in (proposed or {}).items()
                if value is not None
            },
            "system_prompt": rendered.system_prompt,
            "loop_prompt": rendered.loop_prompt,
            "tools": rendered.tools,
        },
        stored=stored or None,
    )


def rehearsal_findings(
    content, slot_values, rendered, stored, proposed, policy, *, rebind=False
):
    config = candidate_config(
        rendered, stored, proposed, rebind=rebind, derived_keys=content.derived_rails
    )
    return config, (
        validate_loop_config(config)
        + branch_constraint_findings(content, slot_values)
        + completion_policy_findings(policy, config)
    )


COMPLETION_TOOLS = tuple(
    "mcp__valaris__" + name
    for name in (
        "get_completion_policy",
        "get_completion_status",
        "submit_completion_candidate",
        "request_landing",
        "retry_completion",
    )
)


def content_for_policy(content, policy):
    contract = content.setup_contract.get("completion_policy_kernel")
    if policy is None or contract is None:
        return content
    landing = "human" if policy.landing_actor == "human" else "merge_queue"
    updated = content.model_copy(deep=True)
    updated.system_prompt = contract["system_prompt"]
    updated.loop_prompt = contract["loop_prompt"]
    updated.rails_defaults["loop_landing"] = landing
    updated.derived_rails["loop_landing"] = landing
    for slot in updated.slots:
        if (
            slot.name.startswith("LANDING_")
            or slot.name == "DEFAULT_BRANCH_CONSEQUENCE"
        ):
            slot.deprecated = True
            slot.required = False
        for variant in slot.variants:
            variant.rails.pop("loop_landing", None)
    updated.tools = list(dict.fromkeys([*updated.tools, *COMPLETION_TOOLS]))
    return updated


async def template_policy_incompatibilities(db, board, policy, *, loop_config=None, proposed_template=None):
    if policy is None:
        return []
    from app.services.kanban.loop_binding import LoopBindingService
    from app.services.loop_template_render import render

    service = LoopBindingService(db)
    if proposed_template is not None:
        from app.services.loop_template_render import TemplateContent
        resolved = await service._resolve(proposed_template["source"], proposed_template["ref"],
            board.workspace_id, proposed_template["version"])
        content = TemplateContent(**resolved["content"])
        slot_values = proposed_template.get("slot_values") or {}
    else:
        binding = await service.get_binding(board.id)
        if binding is None:
            return []
        content = await service.content_for(binding, None)
        slot_values = binding.slot_values or {}
    if content is None or not content.setup_contract.get("completion_policy_kernel"):
        return []
    try:
        expected = render(
            content_for_policy(content, policy), slot_values
        )
    except RenderError:
        expected = None
    config = board.loop_config if loop_config is None else loop_config
    if expected is not None and all(
        (config or {}).get(field) == getattr(expected, field)
        for field in ("system_prompt", "loop_prompt")
    ):
        return []
    return [
        {
            "code": "completion_template_rebind_required",
            "message": "Rebind this template with the selected completion policy before enabling; its saved prompts still use a different completion contract.",
        }
    ]
