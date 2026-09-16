# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Loop template catalog and manager.

Reads are member-gated: any member may browse the catalog and read a template,
and an agent key may too, because a runner binding a board needs to resolve the
template it was pointed at.

Mutations are admin + `forbid_agent_callers`. Templates are AUTHORED artifacts
that decide what a loop tells an agent to do — letting an agent edit the prompt
that governs it is the one privilege escalation this surface must not permit.
The PIPELINE bundle-import route elsewhere is admin-only without the agent ban;
template import deliberately does NOT mirror it, because a bundle is just
another way to author a kernel — the file's origin does not make its content
safer than a PATCH would be.

Surface: everything here inherits `internal` from the `/loop-templates` prefix
rule already registered in `app.core.api_surfaces`; promotion to `public` rides
with the MCP twins (p4-03).
"""

from typing import Any

from fastapi import APIRouter, Body, Depends, Query, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import forbid_agent_callers
from app.database import get_db
from app.core.workspace import WorkspaceContext, get_workspace, get_workspace_admin
from app.schemas.kanban.loop import LoopTemplateCatalogMeta
from app.schemas.loop_template import (
    LoopTemplateCreate,
    LoopTemplateDetailRead,
    LoopTemplateDuplicate,
    LoopTemplateLintRead,
    LoopTemplatePreviewRead,
    LoopTemplatePreviewRequest,
    LoopTemplateProfileRead,
    LoopTemplatePublish,
    LoopTemplatePublishRead,
    LoopTemplateSummary,
    LoopTemplateUpdate,
    LoopTemplateVersionRead,
)
from app.services.export.loop_template_bundle import LoopTemplateBundleService
from app.services.loop_config_validation import LOOP_RUNNER_VARS
from app.services.loop_template import LoopTemplateService
from app.services.loop_template_preview import preview_template

router = APIRouter(
    prefix="/api/workspaces/{slug}/loop-templates", tags=["loop-templates"]
)


@router.get("")
async def list_loop_templates(
    q: str | None = Query(default=None),
    sort: str = Query(default="name", pattern="^(name|updated_at|boards_using)$"),
    include_archived: bool = Query(default=False),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The loop template catalog: system templates then workspace templates.

    Entries are SUMMARIES — prompts, slots and tool grants live behind
    `GET /{ref}`, because the Library page renders none of them and a catalog
    that inlined five full prompt pairs would ship tens of kilobytes per view.

    `meta` carries the runner var vocabulary so the prompt-var palette never has
    to hardcode it.
    """
    service = LoopTemplateService(db)
    summaries = await service.list(
        ctx.workspace.id, q=q, sort=sort, include_archived=include_archived
    )
    return {
        "templates": [LoopTemplateSummary(**s).model_dump() for s in summaries],
        "meta": LoopTemplateCatalogMeta(
            runner_vars=list(LOOP_RUNNER_VARS)
        ).model_dump(),
    }


@router.post(
    "/import",
    dependencies=[Depends(forbid_agent_callers)],
)
async def import_loop_template(
    bundle: dict[str, Any] = Body(...),
    dry_run: bool = True,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Import a `loop_template` envelope as a DRAFT in this workspace.

    Declared BEFORE `/{ref}`: FastAPI matches in declaration order, so the
    literal path has to win or "import" would be read as a template ref.

    `dry_run=true` (the default) previews the action and mutates nothing — the
    destructive half of a share is opt-in over HTTP, matching the pipeline
    bundle route. A commit always lands unpublished, so importing a file can
    never change what a running board executes; publishing stays a separate
    act. Wrong envelope → 400; a template that cannot render → 422.
    """
    service = LoopTemplateBundleService(db)
    return await service.import_bundle(
        ctx.workspace.id, ctx.user.id, bundle, dry_run=dry_run
    )


@router.get("/{ref}", response_model=LoopTemplateDetailRead)
async def get_loop_template(
    ref: str,
    draft: bool = Query(default=False),
    include_archived: bool = Query(default=False),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
) -> LoopTemplateDetailRead:
    """One template in full. `ref` is a system slug or a workspace row UUID.

    `?draft=true` serves the unpublished half, which is what the manager edits;
    an unpublished template serves its draft either way, since it has no
    published half to show.
    """
    service = LoopTemplateService(db)
    return LoopTemplateDetailRead(
        **await service.get(
            ctx.workspace.id, ref, draft=draft, include_archived=include_archived
        )
    )


@router.get("/{ref}/versions", response_model=list[LoopTemplateVersionRead])
async def list_loop_template_versions(
    ref: str,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
) -> list[LoopTemplateVersionRead]:
    """Published history, newest first."""
    service = LoopTemplateService(db)
    versions = await service.list_versions(ctx.workspace.id, ref)
    return [LoopTemplateVersionRead(**v) for v in versions]


@router.get("/{ref}/profile", response_model=LoopTemplateProfileRead)
async def get_loop_template_profile(
    ref: str,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
) -> LoopTemplateProfileRead:
    """The template's profile page — stored identity plus derived track record.

    Archived templates are included: a board bound before the archive still
    links here, and its history is the reason the page exists.
    """
    service = LoopTemplateService(db)
    return LoopTemplateProfileRead(**await service.profile(ctx.workspace.id, ref))


@router.post("/{ref}/preview", response_model=LoopTemplatePreviewRead)
async def preview_loop_template(
    ref: str,
    body: LoopTemplatePreviewRequest,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Render `ref` with no board in sight — the template author's own check.

    POST rather than GET because the slot values are a document, not a query
    string: a block slot legitimately carries a multi-kilobyte prompt fragment.
    It stays a READ — nothing here writes, and it is member-gated for the same
    reason the fit report is.

    Values fall back through `default` then `example`, so an author who has
    filled neither sees the slot left literal and named in `missing_required`,
    rather than a prompt that quietly pretends to be complete.
    """
    return await preview_template(db, ctx.workspace.id, ref, body.slot_values,
        draft=body.draft, version=body.version, loop_config=body.loop_config,
        **({"policy_override": body.completion_policy} if "completion_policy" in body.model_fields_set else {}))


@router.post(
    "",
    response_model=LoopTemplateDetailRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(forbid_agent_callers)],
)
async def create_loop_template(
    data: LoopTemplateCreate,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db),
) -> LoopTemplateDetailRead:
    """Create a draft template (version 0, nothing published yet).

    Deliberately NOT idempotent: a repeated slug returns 409 rather than the
    existing row. The idempotency rule exists for calls agents retry, and
    templates are authored by humans — silently returning someone else's
    template under the slug this author chose would discard their content
    without either author seeing a conflict.
    """
    service = LoopTemplateService(db)
    row = await service.create_draft(
        ctx.workspace.id, actor_id=ctx.user.id, data=data.model_dump()
    )
    return LoopTemplateDetailRead(
        **await service.get(ctx.workspace.id, str(row.id), include_archived=True)
    )


@router.patch(
    "/{ref}",
    response_model=LoopTemplateDetailRead,
    dependencies=[Depends(forbid_agent_callers)],
)
async def update_loop_template(
    ref: str,
    data: LoopTemplateUpdate,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db),
) -> LoopTemplateDetailRead:
    """Autosave the draft half under an optional `expected_updated_at` lock."""
    service = LoopTemplateService(db)
    payload = data.model_dump(exclude_unset=True)
    expected_updated_at = payload.pop("expected_updated_at", None)
    row = await service.update_draft(
        ctx.workspace.id,
        ref,
        data=payload,
        expected_updated_at=expected_updated_at,
    )
    return LoopTemplateDetailRead(
        **await service.get(
            ctx.workspace.id, str(row.id), draft=True, include_archived=True
        )
    )


@router.post(
    "/{ref}/publish",
    response_model=LoopTemplatePublishRead,
    dependencies=[Depends(forbid_agent_callers)],
)
async def publish_loop_template(
    ref: str,
    data: LoopTemplatePublish,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db),
) -> LoopTemplatePublishRead:
    """Validate the draft, snapshot it, and bump the published version.

    A draft that fails validation 422s with the findings attached so the
    manager can deep-link the offending tab.
    """
    service = LoopTemplateService(db)
    row = await service.publish(
        ctx.workspace.id,
        ref,
        expected_version=data.expected_version,
        note=data.note,
        actor_id=ctx.user.id,
    )
    detail = await service.get(ctx.workspace.id, str(row.id), include_archived=True)
    # Publish is the moment a kernel becomes something boards RUN and exports
    # can carry, so it is where a repo-fact leak is worth saying out loud. It
    # stays a warning: the publish above already succeeded.
    return LoopTemplatePublishRead(
        **detail, warnings=await service.lint(ctx.workspace.id, str(row.id))
    )


@router.get("/{ref}/export")
async def export_loop_template(
    ref: str,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    """Download a template as a portable `loop_template` envelope.

    Member-gated like the other reads: an export copies out the artifact the
    member can already read in the manager. Exporting a SYSTEM template is
    allowed and marked `is_system_origin` — it is the natural way to fork a
    shipped loop.
    """
    service = LoopTemplateBundleService(db)
    bundle = await service.build_bundle(ctx.workspace.id, ctx.workspace.slug, ref)
    return JSONResponse(
        content=bundle,
        headers={
            "Content-Disposition": (
                f'attachment; filename="{bundle["data"]["slug"]}.loop-template.json"'
            )
        },
    )


@router.post("/{ref}/lint", response_model=LoopTemplateLintRead)
async def lint_loop_template(
    ref: str,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Scan a template's kernel for facts that belong in slots (spec F12).

    Member-gated and NOT agent-banned, matching `preview` next door: nothing
    here writes, and a runner checking the template it was bound to is a
    legitimate reader. Always 200 — the findings are hints for a human, and an
    endpoint that 422'd on them would be a control nobody asked for.
    """
    service = LoopTemplateService(db)
    return {"findings": await service.lint(ctx.workspace.id, ref)}


@router.post(
    "/{ref}/duplicate",
    response_model=LoopTemplateDetailRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(forbid_agent_callers)],
)
async def duplicate_loop_template(
    ref: str,
    data: LoopTemplateDuplicate,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db),
) -> LoopTemplateDetailRead:
    """Fork any template — system or workspace — into a new workspace draft."""
    service = LoopTemplateService(db)
    row = await service.duplicate(
        ctx.workspace.id,
        ref,
        actor_id=ctx.user.id,
        new_slug=data.new_slug,
        new_name=data.new_name,
    )
    return LoopTemplateDetailRead(
        **await service.get(ctx.workspace.id, str(row.id), include_archived=True)
    )


@router.post(
    "/{ref}/archive",
    response_model=LoopTemplateDetailRead,
    dependencies=[Depends(forbid_agent_callers)],
)
async def archive_loop_template(
    ref: str,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db),
) -> LoopTemplateDetailRead:
    """Soft-archive: the row leaves the listing but keeps serving bound boards.

    There is no hard delete — a board bound to a deleted template would render
    nothing at its next iteration.
    """
    service = LoopTemplateService(db)
    row = await service.archive(ctx.workspace.id, ref, actor_id=ctx.user.id)
    return LoopTemplateDetailRead(
        **await service.get(ctx.workspace.id, str(row.id), include_archived=True)
    )


@router.post(
    "/{ref}/unarchive",
    response_model=LoopTemplateDetailRead,
    dependencies=[Depends(forbid_agent_callers)],
)
async def unarchive_loop_template(
    ref: str,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db),
) -> LoopTemplateDetailRead:
    service = LoopTemplateService(db)
    row = await service.unarchive(ctx.workspace.id, ref, actor_id=ctx.user.id)
    return LoopTemplateDetailRead(
        **await service.get(ctx.workspace.id, str(row.id), include_archived=True)
    )


@router.post(
    "/{ref}/versions/{version}/restore",
    response_model=LoopTemplateDetailRead,
    dependencies=[Depends(forbid_agent_callers)],
)
async def restore_loop_template_version(
    ref: str,
    version: int,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db),
) -> LoopTemplateDetailRead:
    """Stage a published snapshot as the draft. It does NOT republish."""
    service = LoopTemplateService(db)
    row = await service.restore_version(
        ctx.workspace.id, ref, version, actor_id=ctx.user.id
    )
    return LoopTemplateDetailRead(
        **await service.get(
            ctx.workspace.id, str(row.id), draft=True, include_archived=True
        )
    )
