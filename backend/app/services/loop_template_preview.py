# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Preview a loop template — resolve, render, report. Never write, never block.

Two callers, one answer: the workspace route previews a kernel with the author's
own example values, and the board route rehearses a bind against real board
facts. Both reduce to the same question the runner asks every iteration —
"what exact strings do I execute?" — so the difference is purely which values
get layered in, and that difference lives here rather than in two routers.
"""

import uuid
from typing import Any

from app.services.completion_policy import _UNSET
from app.services.loop_template import LoopTemplateService
from app.services.loop_template_fit import LoopTemplateFitService
from app.services.loop_template_render import TemplateContent, preview

# Rails the board OWNS once configured. A preview that showed the template's
# defaults for these would promise a budget the bind step would not apply: the
# operator tuned them on this board and a re-render keeps them (see
# loop_binding.py's rails precedence).
_BOARD_RAIL_KEYS = (
    "provider",
    "model",
    "max_iterations",
    "iteration_delay_seconds",
    "iteration_timeout_seconds",
    "budget_usd",
    "max_consecutive_failures",
    "max_blocked_on_human",
    "starvation_policy",
    "loop_landing",
    "merge_gate",
    "completion_query",
)


async def preview_template(
    db,
    workspace_id: uuid.UUID,
    ref: str,
    slot_values: dict[str, Any],
    *,
    board_id: uuid.UUID | None = None,
    draft: bool = True,
    version: int | None = None,
    loop_config: dict[str, Any] | None = None,
    policy_override=_UNSET,
) -> dict[str, Any]:
    """The rendered runner view for `ref`, optionally rehearsed on a board.

    `ref` resolves through the same P1 resolver the catalog and fit check use,
    so a system slug and a workspace template uuid are interchangeable. An
    unknown ref raises out of that resolver as a 404 — a preview of nothing is
    not a finding, it is a wrong URL.
    """
    # The DRAFT half, matching `lint` and the two rehearsal endpoints on the
    # board route: a preview exists to show the operator what is on their
    # screen, and previewing the published half would render the version
    # BEFORE the edit that prompted the preview. A system template and an
    # unpublished row have one half, so this changes only the
    # published-with-pending-edits case.
    template = await resolve_template_view(db, workspace_id, ref, draft=draft, version=version)
    content = TemplateContent(**(template.get("content") or {}))

    if board_id is None and policy_override is not _UNSET:
        from app.repositories.completion import CompletionRepository
        from app.services.completion_policy import parse_policy
        from app.services.loop_template_completion import content_for_policy

        workspace_config = await CompletionRepository(db).workspace_config(workspace_id)
        selected = policy_override if policy_override is not None else (workspace_config.completion_policy if workspace_config else None)
        content = content_for_policy(content, parse_policy(selected))

    autofill: dict[str, dict[str, Any]] = {}
    board_rails: dict[str, Any] = {}
    report = None
    if board_id is not None:
        from app.repositories.kanban.board import BoardRepository
        from app.services.completion_policy import CompletionPolicyService
        from app.services.loop_template_completion import content_for_policy

        board = await BoardRepository(db).get_by_id(board_id)
        if board is not None and board.workspace_id == workspace_id:
            content = content_for_policy(content, await CompletionPolicyService(db).effective_policy(board, override=policy_override))
        report = await LoopTemplateFitService(db).check(
            board_id, workspace_id, content, slot_values=slot_values, loop_config=loop_config, policy_override=policy_override
        )
        autofill = report["autofill"]
        board_rails = await _configured_rails(db, board_id)
        if "loop_landing" in content.derived_rails:
            board_rails["loop_landing"] = content.derived_rails["loop_landing"]
        if loop_config is not None:
            board_rails.update({key: value for key, value in loop_config.items() if key in _BOARD_RAIL_KEYS})

    result = preview(content, slot_values, autofill)
    if report is not None:
        result.findings.extend(report["findings"])
    else:
        from app.services.loop_template_completion import rehearsal_findings
        _, findings = rehearsal_findings(content, slot_values, result, None, loop_config, None)
        result.findings.extend(findings)
        board_rails.update(loop_config or {})
    return {
        "template": {"ref": ref, "version": template.get("version")},
        **result.model_dump(),
        "rails": {**result.rails, **board_rails},
    }


async def resolve_template_view(db, workspace_id, ref, *, draft=True, version=None):
    from app.exceptions import ConflictError

    template = await LoopTemplateService(db).get(workspace_id, ref, draft=draft)
    if version is not None and (draft or template.get("version") != version):
        raise ConflictError("Template version changed; refresh the published preview before binding")
    if not draft and template.get("is_draft"):
        raise ConflictError("Publish this template before previewing its binding")
    return template


async def _configured_rails(db, board_id: uuid.UUID) -> dict[str, Any]:
    """The rails this board already runs with, or {} when it has no loop yet.

    Read straight off the board row rather than through LoopConfigRead: that
    schema defaults every absent field, which would turn "this board never set
    budget_usd" into a confident claim that it set the platform default — and
    silently override the template's own default with it.
    """
    from app.models.kanban.board import Board

    board = await db.get(Board, board_id)
    stored = (board.loop_config or {}) if board is not None else {}
    return {key: stored[key] for key in _BOARD_RAIL_KEYS if key in stored}


async def preview_binding(db, board, request, proposed_config, policy):
    from app.services.kanban.loop_binding import LoopBindingService
    from app.services.loop_template_completion import content_for_policy, rehearsal_findings
    from app.services.loop_template_render import RenderError, render, render_runner_tools_manifest

    service = LoopBindingService(db)
    binding = await service.get_binding(board.id)
    service.guard_raw_prompts(proposed_config, is_bound=binding is not None, binds=True)
    resolved = await service._resolve(
        request["source"], request["ref"], board.workspace_id, request["version"],
    )
    values = request.get("slot_values") or {}
    await service._guard_new_required_slots(binding, resolved, values, request["source"], request["ref"])
    content = content_for_policy(TemplateContent(**resolved["content"]), policy)
    result = preview(content, values, {})
    try:
        rendered = render(content, values)
    except RenderError as exc:
        rendered = result
        result.findings.extend(exc.errors)
    else:
        # A binding uses explicit values and defaults, never preview-only examples.
        result.system_prompt = rendered.system_prompt
        result.loop_prompt = rendered.loop_prompt
        result.loop_prompt_with_tools_manifest = rendered.loop_prompt + render_runner_tools_manifest(rendered.tools)
        result.tools = rendered.tools
        result.rails = rendered.rails
    config, findings = rehearsal_findings(
        content, values, rendered, board.loop_config, proposed_config, policy,
        rebind=binding is not None,
    )
    unique = {(item["code"], item["field"], item["message"]): item for item in [*result.findings, *findings]}
    result.findings = list(unique.values())
    return {
        "template": {"ref": request["ref"], "version": resolved["version"]},
        **result.model_dump(),
        "rails": {key: config[key] for key in result.rails.keys() | set(_BOARD_RAIL_KEYS) if key in config},
    }, config
