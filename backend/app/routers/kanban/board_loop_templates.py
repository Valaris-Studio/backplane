# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Board-scoped loop-template routes — "how well does THIS template fit?".

Separate from `boards.py` on purpose: that file already carries seven loop
routes, and the fit/preview/apply family (p2-01..p2-03) grows on its own axis.
Same prefix and the same `resolve_board_id` dependency, so the split is
invisible on the wire.

Reads here are MEMBER-gated. Seeing which requirements a board does or does not
meet is the same class of fact as seeing its columns, and the operator deciding
whether to bind needs it before they have any admin intent. Applying the fixes
this report advertises is admin, and lives in p2-02.
"""

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import forbid_agent_callers
from app.core.workspace import (
    WorkspaceContext,
    get_workspace,
    get_workspace_admin,
    resolve_board_id,
)
from app.database import get_db
from app.schemas.kanban.loop import (
    LoopTemplateFitApplyRead,
    LoopTemplateFitApplyRequest,
    LoopTemplateFitRead,
)
from app.schemas.loop_template import (
    LoopTemplatePreviewRead,
    LoopTemplatePreviewRequest,
)
from app.services.loop_template import LoopTemplateService
from app.services.loop_template_fit import LoopTemplateFitService
from app.services.loop_template_preview import preview_template, resolve_template_view
from app.services.loop_template_render import TemplateContent

router = APIRouter(prefix="/api/workspaces/{slug}/boards", tags=["boards"])


@router.get(
    "/{board_id}/loop-templates/{ref}/fit", response_model=LoopTemplateFitRead
)
async def get_board_loop_template_fit(
    ref: str,
    board_uuid: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Setup-contract checks plus slot autofill for `ref` against this board.

    Resolved through `LoopTemplateService.get`, which accepts a system slug or
    a workspace template uuid alike — a caller browsing the catalog should not
    have to know which kind of ref it is holding. The DRAFT content is what a
    fit check should judge: an operator fitting a template they are still
    editing wants the answer for what they see, and nothing here can reach a
    running loop.
    """
    template = await LoopTemplateService(db).get(ctx.workspace.id, ref, draft=True)
    report = await LoopTemplateFitService(db).check(
        board_uuid,
        ctx.workspace.id,
        TemplateContent(**(template.get("content") or {})),
    )
    return {"template": {"ref": ref, "version": template.get("version")}, **report}


@router.post(
    "/{board_id}/loop-templates/{ref}/fit", response_model=LoopTemplateFitRead
)
async def fit_proposed_board_loop_template(
    ref: str,
    body: LoopTemplatePreviewRequest,
    board_uuid: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    template = await resolve_template_view(
        db, ctx.workspace.id, ref, draft=body.draft, version=body.version
    )
    report = await LoopTemplateFitService(db).check(
        board_uuid, ctx.workspace.id, TemplateContent(**(template.get("content") or {})),
        slot_values=body.slot_values, loop_config=body.loop_config,
        **({"policy_override": body.completion_policy} if "completion_policy" in body.model_fields_set else {}),
    )
    return {"template": {"ref": ref, "version": template.get("version"), "draft": body.draft}, **report}


@router.post(
    "/{board_id}/loop-templates/{ref}/preview",
    response_model=LoopTemplatePreviewRead,
)
async def preview_board_loop_template(
    ref: str,
    body: LoopTemplatePreviewRequest,
    board_uuid: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> dict:
    """The bind step's rehearsal: what would THIS board actually run?

    Two things make it differ from the workspace-scoped twin, and both exist so
    the preview cannot promise something the bind would not deliver:
    slot values fall back through the board's own autofill (the same facts the
    fit report offers), and rails the operator already tuned on this board win
    over the template's defaults, exactly as a re-render would keep them.

    A READ despite the verb — it writes nothing, which is why it is member-
    gated where `fit/apply` next door is admin.
    """
    return await preview_template(
        db, ctx.workspace.id, ref, body.slot_values, board_id=board_uuid,
        draft=body.draft, version=body.version, loop_config=body.loop_config,
        **({"policy_override": body.completion_policy} if "completion_policy" in body.model_fields_set else {}),
    )


@router.post(
    "/{board_id}/loop-templates/{ref}/fit/apply",
    response_model=LoopTemplateFitApplyRead,
    dependencies=[Depends(forbid_agent_callers)],
)
async def apply_board_loop_template_fixes(
    ref: str,
    body: LoopTemplateFitApplyRequest,
    board_uuid: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Run the fixes the fit report advertised, then answer with a fresh one.

    ADMIN where the report itself is member-gated: these fixes create columns,
    author a definition key and pin a note. Agent keys are barred outright — a
    runner renders the loop it is bound to; restructuring the board it works on
    is an operator act.

    Unknown ids 422 and a frozen board 409s, both BEFORE any fix runs, so the
    request is all-or-nothing. Individual fixes never raise: a fix that cannot
    apply reports `rejected` with a reason, because one impossible fix in a
    batch should not discard the ones that worked.

    Judges the DRAFT, like the report it acts on — an operator can therefore
    create a column for a contract they have not published yet. That is the
    point: the fixes exist to prepare a board for a template still being
    tuned, and a column is inert until something binds to it.
    """
    template = await LoopTemplateService(db).get(ctx.workspace.id, ref, draft=True)
    report = await LoopTemplateFitService(db).apply(
        board_uuid,
        ctx.workspace.id,
        TemplateContent(**(template.get("content") or {})),
        body.fix_ids,
        ctx.user.id,
    )
    return {"template": {"ref": ref, "version": template.get("version")}, **report}
