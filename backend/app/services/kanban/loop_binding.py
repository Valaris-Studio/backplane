# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Binding a board's loop to a template: render at SAVE, store the strings.

The runner is a fixed consumer of `system_prompt` / `loop_prompt` / `tools`.
Binding does not change that contract — it changes WHO writes those strings.
A bound board's prompts are the deterministic render of (template version,
slot values), computed here at save time and stored verbatim in
`boards.loop_config`, so every later read (runner, UI, MCP) sees one truth
with no render step of its own.

Three shapes, mirroring `completion_query`'s three-state convention:

  {...}  bind or re-render
  {}     detach — drop the binding, keep the rendered prompts as raw text
  null   unchanged

Rails precedence is the one genuinely ambiguous part, so it is spelled out:

  FIRST BIND    rails_defaults < variant rails < derived_rails, and a rail the
                SAME request set explicitly beats all three — the operator
                typed it on purpose in this very body.
  RE-RENDER     the board's current rails are kept (an operator who tuned
                budget_usd after binding must not silently lose it), except
                derived_rails, which is a function of the slot values being
                re-rendered and would otherwise go stale against the prompts.
"""

import uuid
from typing import Any

from app.exceptions import ConflictError, ResourceNotFoundError, ValidationError
from app.repositories.config_template import BoardLoopTemplateBindingRepository
from app.services.loop_template import LoopTemplateService
from app.services.loop_template_drift import (
    DRIFT_BINDING_CORRUPT,
    DRIFT_NONE,
    DRIFT_SYSTEM_BUMPED,
    DRIFT_RAW_EDITED,
    DRIFT_SLOTS_CHANGED,
    DRIFT_TEMPLATE_NEWER,
    compute_drift,
    diff_binding,
)
from app.services.loop_template_render import (
    PROMPT_FIELDS,
    RenderError,
    TemplateContent,
    effective_slot_values,
    prompts_hash,
    render,
)
from app.services.loop_templates import get_system_template

# The three loop_config fields a template OWNS once a board is bound. Sending
# any of them by hand alongside (or on top of) a template is the conflict this
# module refuses; every other field stays the operator's.
TEMPLATE_OWNED_FIELDS = ("system_prompt", "loop_prompt", "tools")


class TemplateAndRawPromptsError(ValidationError):
    error_code = "template_and_raw_prompts"
    detail = (
        "a body cannot both bind a template and set system_prompt/loop_prompt/"
        "tools — the render would overwrite the text you just sent"
    )


class BoardBoundToTemplateError(ConflictError):
    error_code = "board_bound_to_template"
    detail = (
        "this board's prompts are rendered from a loop template and would be "
        "overwritten by the next re-render — detach first: send template: {}"
    )


class BindingNotFoundError(ResourceNotFoundError):
    error_code = "not_bound"
    detail = "this board's loop is not bound to a template"


def _raw_prompt_fields_in(body: dict) -> list[str]:
    """The template-owned fields the caller actually SENT.

    `None` is the omission marker across LoopConfigPut, so a client that
    serializes every field with nulls is not "sending prompts" — treating it
    as such would make a rails-only save impossible from such a client.
    """
    return [f for f in TEMPLATE_OWNED_FIELDS if body.get(f) is not None]


# The kinds that describe a template that MOVED, and so have two different
# snapshots to diff. `raw_edited` and `binding_corrupt` describe the BINDING,
# where both snapshots are the same version and the panel would be empty.
DIFFABLE_DRIFT_KINDS = frozenset(
    {DRIFT_TEMPLATE_NEWER, DRIFT_SYSTEM_BUMPED, DRIFT_SLOTS_CHANGED}
)


def ref_is_corrupt(template_ref: dict) -> bool:
    """A workspace binding is only resolvable through {id, workspace_id}.

    A row missing either is unresolvable, and `current_version_for` reports the
    same `None` an ARCHIVED template does — so without this the two states are
    indistinguishable and the corrupt one reads as clean. System refs resolve
    by slug alone and so can never be corrupt in this sense.
    """
    if template_ref.get("source") == "system":
        return False
    return template_ref.get("id") is None or template_ref.get("workspace_id") is None


def config_prompts_hash(loop_config: dict | None) -> str | None:
    """The hash of the prompts a board serves RIGHT NOW, or None if unknowable.

    Only the prompt pair is hashed — `loop_config` also holds rails the operator
    is invited to tune after binding (the bind seeds them and a re-render
    preserves them), so hashing the whole object would make the intended
    workflow read as drift.
    """
    if loop_config is None:
        return None
    return prompts_hash(
        *(loop_config.get(field) or "" for field in PROMPT_FIELDS)
    )


def raw_edited_for(binding, loop_config: dict | None) -> bool:
    """Did somebody edit the prompts behind this binding's back?

    Only meaningful against a binding that stored a hash; a legacy row without
    one is UNKNOWN, and reporting unknown as edited would banner every board
    written before the column was populated.
    """
    if binding.rendered_hash is None:
        return False
    config_hash = config_prompts_hash(loop_config)
    return config_hash is not None and config_hash != binding.rendered_hash


def drift_for(
    bound_version: int,
    current_version: int | None,
    source: str = "workspace",
    *,
    ref_corrupt: bool = False,
    raw_edited: bool = False,
) -> dict:
    """The THIN drift signal that rides GET /loop on every runner poll.

    Deliberately just {kind, current_version?}: the slot lists and kernel diff
    belong to GET /loop/binding, which a human opens once, not to the config
    read a loop hits every iteration. `source` decides only whether a bump
    reads as `system_bumped` or `template_newer` — the banner copy differs
    because a deploy is not a teammate's publish.
    """
    if ref_corrupt:
        return {"kind": DRIFT_BINDING_CORRUPT}
    if current_version is not None and current_version > bound_version:
        return {
            "kind": DRIFT_SYSTEM_BUMPED if source == "system" else DRIFT_TEMPLATE_NEWER,
            "current_version": current_version,
        }
    if raw_edited:
        return {"kind": DRIFT_RAW_EDITED}
    return {"kind": DRIFT_NONE}


def slim_ref(
    binding, current_version: int | None, *, raw_edited: bool = False
) -> dict:
    """The canonical `template` shape carried on LoopConfigRead program-wide."""
    # Workspace consumers resolve UUIDs; system templates resolve slugs.
    # Keep a corrupt legacy row readable so its drift diagnostic can explain
    # the missing identity instead of failing the entire loop read.
    ref = binding.template_ref["slug"]
    if binding.template_ref["source"] == "workspace":
        ref = binding.template_ref.get("id") or ref
    return {
        "source": binding.template_ref["source"],
        "ref": ref,
        "version": binding.version,
        "drift": drift_for(
            binding.version,
            current_version,
            binding.template_ref["source"],
            ref_corrupt=ref_is_corrupt(binding.template_ref),
            raw_edited=raw_edited,
        ),
    }


class LoopBindingService:
    """The bind/detach half of PUT /loop, kept out of put_loop_config so the
    existing lock → canonicalize → validate → version flow stays readable."""

    def __init__(self, db):
        self.db = db
        self.binding_repo = BoardLoopTemplateBindingRepository(db)
        self.template_service = LoopTemplateService(db)

    async def get_binding(self, board_id: uuid.UUID):
        return await self.binding_repo.get_by_board(board_id)

    async def current_version_for(self, binding) -> int | None:
        """The newest version of the template this binding points at.

        Workspace templates are resolved through the service rather than the
        repo so an archived or deleted one yields None (no drift claim) instead
        of raising into an unrelated read.
        """
        if binding.template_ref["source"] == "system":
            template = get_system_template(binding.template_ref["slug"])
            return template.version if template is not None else None

        template_id = binding.template_ref.get("id")
        workspace_id = binding.template_ref.get("workspace_id")
        if template_id is None or workspace_id is None:
            return None
        row = await self.template_service.repo.get_by_id(uuid.UUID(template_id))
        if row is None or row.workspace_id != uuid.UUID(workspace_id):
            return None
        return row.version or None

    async def resolve_slim_ref(
        self, board_id: uuid.UUID, loop_config: dict | None = None
    ) -> dict | None:
        """`LoopConfigRead.template` for this board, or None when raw.

        `loop_config` is optional because the runner's poll path already holds
        the config it just read: passing it in is what lets the thin drift
        signal name a raw edit without a second board fetch.
        """
        binding = await self.get_binding(board_id)
        if binding is None:
            return None
        return slim_ref(
            binding,
            await self.current_version_for(binding),
            raw_edited=raw_edited_for(binding, loop_config),
        )

    async def content_for(self, binding, version: int | None) -> TemplateContent | None:
        """The template content at `version` — None meaning "whatever is
        current". Returns None when that snapshot cannot be reconstructed.

        Unrecoverable is NOT the same as empty. A code-defined template keeps
        only its CURRENT version in the binary, so the content a board rendered
        against an older deploy is simply gone; treating that as an empty
        template would report every slot the current version requires as newly
        added, and the drift banner would demand values the operator already
        supplied.
        """
        if binding.template_ref["source"] == "system":
            template = get_system_template(binding.template_ref["slug"])
            if template is None:
                return None
            if version is not None and version != template.version:
                return None
            return template.content

        template_id = binding.template_ref.get("id")
        if template_id is None:
            return None
        row = await self.template_service.repo.get_by_id(uuid.UUID(template_id))
        if row is None:
            return None
        if version is None or version == row.version:
            return TemplateContent(**(row.content or {}))
        snapshot = await self.template_service.repo.get_version(row.id, version)
        if snapshot is None:
            return None
        return TemplateContent(**(snapshot.content or {}))

    async def full_drift_for(self, binding, loop_config: dict | None = None) -> dict:
        """The rich verdict GET /loop/binding serves: kind plus what moved.

        `loop_config` enables the raw-edit check. It is optional so the callers
        that only care about the catalog comparison need not fetch the board.
        """
        if ref_is_corrupt(binding.template_ref):
            # Short-circuit BEFORE content_for: an unresolvable ref makes every
            # lookup below meaningless, and the point of the kind is to say so
            # rather than to render a comparison against nothing.
            return compute_drift(
                source=binding.template_ref["source"],
                bound_version=binding.version,
                current_version=None,
                bound_content=None,
                current_content=None,
                ref_corrupt=True,
            )
        current_version = await self.current_version_for(binding)
        return compute_drift(
            source=binding.template_ref["source"],
            bound_version=binding.version,
            current_version=current_version,
            bound_content=await self.content_for(binding, binding.version),
            current_content=await self.content_for(binding, None),
            rendered_hash=binding.rendered_hash,
            config_hash=config_prompts_hash(loop_config),
        )

    async def diff_for(self, binding) -> dict:
        """Kernel diffs + slot delta between the bound version and current."""
        return diff_binding(
            bound_content=await self.content_for(binding, binding.version),
            current_content=await self.content_for(binding, None),
        )

    def guard_raw_prompts(self, body: dict, *, is_bound: bool, binds: bool) -> None:
        """The two contradictions a PUT body can express, refused before any
        render work: binding AND hand-writing in one body (422), and
        hand-writing on a board whose prompts a re-render owns (409)."""
        raw = _raw_prompt_fields_in(body)
        if not raw:
            return
        if binds:
            raise TemplateAndRawPromptsError(
                detail=[
                    {
                        "code": "template_and_raw_prompts",
                        "field": field,
                        "message": (
                            f"{field} cannot be set in the same body that binds "
                            "a template"
                        ),
                    }
                    for field in raw
                ]
            )
        if is_bound:
            raise BoardBoundToTemplateError()

    async def bind(
        self,
        *,
        board_id: uuid.UUID,
        workspace_id: uuid.UUID,
        request: dict,
        actor_id: uuid.UUID,
        existing_binding,
        explicit_fields: set[str],
        stored_config: dict | None,
        proposed_config: dict | None = None,
    ) -> dict:
        """Render the template and return the loop_config fragment to merge.

        Returns {"config": {...}, "template": <slim ref>, "slug": str,
        "rebind": bool} — the caller owns the version bump and persistence, so
        a render failure here leaves no partial state behind.
        """
        source = request.get("source", "system")
        ref = request.get("ref")
        if not ref:
            raise ValidationError(
                detail=[
                    {
                        "code": "template_ref_required",
                        "field": "template.ref",
                        "message": "template.ref is required to bind",
                    }
                ]
            )

        resolved = await self._resolve(
            source, ref, workspace_id, request.get("version")
        )
        slot_values = request.get("slot_values") or {}

        await self._guard_new_required_slots(
            existing_binding, resolved, slot_values, source, ref
        )

        from app.services.completion_policy import CompletionPolicyService
        from app.services.loop_template_completion import content_for_policy, rehearsal_findings
        from app.repositories.kanban.board import BoardRepository

        board = await BoardRepository(self.db).get_by_id(board_id)
        if board is None or board.workspace_id != workspace_id:
            raise ResourceNotFoundError("Board not found")
        policy = await CompletionPolicyService(self.db).effective_policy(board)
        content = content_for_policy(TemplateContent(**resolved["content"]), policy)
        try:
            rendered = render(content, slot_values)
        except RenderError as exc:
            raise ValidationError(detail=[dict(f) for f in exc.errors]) from exc

        rebind = existing_binding is not None
        config = {
            "system_prompt": rendered.system_prompt,
            "loop_prompt": rendered.loop_prompt,
            "tools": rendered.tools,
        }
        # First bind seeds the rails an operator inherits by not thinking about
        # them; a re-render keeps whatever the board has now. derived_rails is
        # applied in both cases because it is computed from the slot values
        # this very render used.
        seeded = {} if rebind else dict(rendered.rails)
        derived_keys = set(content.derived_rails)
        for key, value in rendered.rails.items():
            if key in derived_keys:
                seeded[key] = value
        for key, value in seeded.items():
            if key not in explicit_fields:
                config[key] = value

        template_ref = {"source": source, "slug": resolved["slug"]}
        if source != "system":
            template_ref["id"] = resolved["id"]
            template_ref["workspace_id"] = str(workspace_id)

        _, findings = rehearsal_findings(
            content, slot_values, rendered, stored_config,
            proposed_config, policy, rebind=rebind,
        )
        if findings:
            raise ValidationError(detail=[dict(f) for f in findings])

        binding = await self.binding_repo.upsert(
            board_id=board_id,
            template_ref=template_ref,
            version=resolved["version"],
            slot_values=slot_values,
            rendered_by_id=actor_id,
            rendered_hash=rendered.hash,
        )
        return {
            "config": config,
            "template": slim_ref(binding, await self.current_version_for(binding)),
            "slug": resolved["slug"],
            "version": resolved["version"],
            "rebind": rebind,
        }

    async def _guard_new_required_slots(
        self,
        existing_binding,
        resolved: dict,
        slot_values: dict,
        source: str,
        ref: str,
    ) -> None:
        """Refuse a RE-RENDER onto a version that added required slots.

        The renderer would already refuse the missing value, but with its
        generic per-slot error — indistinguishable from an operator clearing a
        field they always had. This names the slots the NEW version introduced,
        which is what the drift banner turns into the fields it asks for.

        Scoped to re-renders of the same template: a first bind (or a switch to
        a different template) has no previous version to have "added" anything
        relative to, so it keeps the renderer's own errors.
        """
        if existing_binding is None:
            return
        if existing_binding.template_ref["source"] != source:
            return
        if existing_binding.template_ref["slug"] != resolved["slug"]:
            return
        if resolved["version"] == existing_binding.version:
            return

        bound_content = await self.content_for(
            existing_binding, existing_binding.version
        )
        if bound_content is None:
            # The snapshot the board rendered against is gone (a deploy moved a
            # code-defined template, or a version row was pruned). Nothing can
            # be called "newly added" relative to content nobody has, and this
            # re-render is the operator's ONLY way back onto a live version —
            # the renderer's own per-slot errors remain the contract.
            return

        target = TemplateContent(**resolved["content"])
        # Variant fills and slot defaults are resolved inside render(); asking
        # about raw slot_values would refuse values the render will receive.
        effective = effective_slot_values(target, slot_values)
        was_required = {slot.name for slot in bound_content.slots if slot.required}
        unfilled = [
            slot.name
            for slot in target.slots
            if slot.required
            and slot.name not in was_required
            # Presence, not truthiness: `False` and `0` are answers, and
            # effective_slot_values has already dropped the empty ones.
            and slot.name not in effective
        ]
        if not unfilled:
            return

        raise ValidationError(
            detail=[
                {
                    "code": "new_required_slots_unfilled",
                    "field": "template.slot_values",
                    "message": (
                        f"{ref}@v{resolved['version']} adds required slots that "
                        "this board has no value for: " + ", ".join(unfilled)
                    ),
                    "value": unfilled,
                }
            ]
        )

    async def detach(self, board_id: uuid.UUID, existing_binding) -> str | None:
        """Drop the binding; the rendered prompts stay as ordinary raw text.

        Returns the detached slug for the activity summary, or None when the
        board was already raw (detaching twice is a retry, not an error).
        """
        await self.binding_repo.delete_for_board(board_id)
        return (
            None if existing_binding is None else existing_binding.template_ref["slug"]
        )

    async def _resolve(
        self, source: str, ref: str, workspace_id: uuid.UUID, version: int | None
    ) -> dict[str, Any]:
        if source == "system":
            template = get_system_template(ref)
            if template is None:
                raise ResourceNotFoundError(f"Loop template {ref} not found")
            if version is not None and version != template.version:
                raise ConflictError("Requested system template version is unavailable; refresh before binding")
            return {
                "slug": template.slug,
                "id": template.slug,
                "version": template.version,
                "content": template.content.model_dump(),
            }

        return await self.template_service.resolve_for_binding(
            workspace_id, ref, version
        )
