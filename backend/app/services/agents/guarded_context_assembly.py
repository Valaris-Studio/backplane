# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Budgeted context assembly (manifest schema 2, B1 phase 1).

Every Note.content read goes through scalar headers and size-guarded body
projections. Required sources reserve capacity first; output keeps configured
order. Records are admitted whole or excluded whole, never truncated. Raw note
transfer and admitted output are bounded; non-note fetchers are not, and
parse/render heap and database scan work are not claimed bounded.
"""

from __future__ import annotations

import uuid
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import ContextBudgetCeilings, settings
from app.exceptions import ConflictError
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.notes.kinds import REVIEW_VERDICT
from app.repositories.definitions.definition import DefinitionRepository
from app.repositories.kanban.card import CardRepository
from app.repositories.notes.context_note import (
    ContextNoteBody,
    ContextNoteHeader,
    ContextNoteRepository,
    ContextNoteScope,
)
from app.repositories.notes.note import NoteRepository
from app.schemas.agents.context import (
    AdmissionOutcome,
    ContextAdmission,
    ContextBudgetPolicyRead,
    ContextBudgetReport,
    ContextDiagnostics,
    ContextExclusion,
    ContextManifest,
    ContextRecord,
    ContextSource,
    ExclusionReason,
)
from app.services.agents.context_assembly import (
    _FETCHERS,
    _MAX_CONTEXT_LIMIT,
    AssembledContext,
    _clamp_limit,
    assemble_context_with_manifest,
    card_note_block,
    context_source_alias,
    pinned_note_block,
    render_board_definition,
    review_note_block,
)
from app.services.agents.context_budget import (
    NOTE_WINDOW_DEFAULT,
    NOTE_WINDOW_MAX,
    ContextBudgetPolicy,
    invalid_context_budget,
    invalid_persisted_budget,
    is_strict_int,
    resolve_invocation_budget,
)
from app.services.agents.context_selection import (
    AdmittedNote,
    GuardedSelection,
    SelectedSource,
)
from app.services.agents.context_structure import structure_excess
from app.services.agents.context_manifest import (
    BUDGETED_MANIFEST_SCHEMA_VERSION,
    RENDERER_VERSION,
    canonical_json,
    context_revision,
    note_revision,
    sha256_text,
    utf8_bytes,
)

NOTE_SOURCE_KINDS = frozenset(
    {"card_notes", "pinned_notes", "board_definition", "review_history"}
)
_SEPARATOR = "\n\n"


@dataclass(frozen=True)
class _SourcePlan:
    source_index: int
    kind: str
    alias: str
    filter: dict[str, Any]
    required: bool
    source_cap: int | None
    window: int | None


@dataclass
class _SourceOutcome:
    parts: list[str] = field(default_factory=list)
    records: list[ContextRecord] = field(default_factory=list)
    exclusions: list[ContextExclusion] = field(default_factory=list)
    candidate_count: int = 0
    has_more_candidates: bool = False
    admitted_count: int = 0
    rendered_bytes: int = 0
    notes: list[AdmittedNote] = field(default_factory=list)
    definition_part: str | None = None

    @property
    def text(self) -> str:
        return _SEPARATOR.join(self.parts)


def _selection_changed() -> ConflictError:
    # Deliberately without detail: the row may now belong to another scope.
    return ConflictError(
        "A selected note changed while context was read; refresh it again",
        error_code="context_selection_changed",
    )


def _note_window(plan_filter: dict[str, Any], index: int) -> int:
    if "limit" not in plan_filter:
        return NOTE_WINDOW_DEFAULT
    limit = plan_filter["limit"]
    if not is_strict_int(limit) or not 1 <= limit <= NOTE_WINDOW_MAX:
        raise invalid_context_budget(
            f"source {index} filter.limit must be an integer from 1 to {NOTE_WINDOW_MAX}"
        )
    return limit


def _plan_sources(
    sources: list[dict], policy: ContextBudgetPolicy
) -> list[_SourcePlan]:
    # Validated whole before any read: an invalid budget never half-assembles.
    plans: list[_SourcePlan] = []
    for index, source in enumerate(sources):
        alias = context_source_alias(source) if isinstance(source, dict) else None
        if alias is None:
            # Legacy skips it; under a budget a vanished (possibly required)
            # source would be silent, so the policy is refused instead.
            raise invalid_context_budget(
                f"source {index} needs a supported kind and a non-empty alias"
            )
        kind = source["kind"]
        filter_ = source.get("filter")
        if filter_ is None:
            filter_ = {}
        elif not isinstance(filter_, dict):
            raise invalid_context_budget(f"source {index} filter must be an object")
        required = source.get("required", False)
        if not isinstance(required, bool):
            raise invalid_context_budget(f"source {index} required must be a boolean")
        source_cap = source.get("max_rendered_bytes")
        if "max_rendered_bytes" in source:
            if not is_strict_int(source_cap) or not (
                1 <= source_cap <= policy.max_managed_context_bytes
            ):
                raise invalid_context_budget(
                    f"source {index} max_rendered_bytes must be an integer from 1 to "
                    f"max_managed_context_bytes"
                )
        if kind == "card_notes":
            # Existing card_notes clamp/default is preserved byte-for-byte.
            window = _clamp_limit(filter_, _MAX_CONTEXT_LIMIT)
        elif kind in NOTE_SOURCE_KINDS:
            window = _note_window(filter_, index)
        else:
            window = None
        plans.append(
            _SourcePlan(index, kind, alias, filter_, required, source_cap, window)
        )
    return plans


class _GuardedAssembly:
    def __init__(
        self,
        db: AsyncSession,
        policy: ContextBudgetPolicy,
        ceilings: ContextBudgetCeilings,
        *,
        workspace_id: uuid.UUID,
        card: Card,
        board: Board,
        stage: dict | None,
        pipeline_stages: list[dict] | None,
    ):
        self.db = db
        self.policy = policy
        self.ceilings = ceilings
        self.workspace_id = workspace_id
        self.card = card
        self.board = board
        self.stage = stage
        self.pipeline_stages = pipeline_stages
        self.notes = ContextNoteRepository(db)
        self.fetched_bytes = 0
        self.managed_bytes = 0
        # One fetched body per note per assembly, whichever alias reads it first.
        self.bodies: dict[uuid.UUID, ContextNoteBody] = {}

    async def admit(self, plan: _SourcePlan) -> _SourceOutcome:
        outcome = _SourceOutcome()
        if plan.kind == "card_notes":
            note_kind = plan.filter.get("kind") or None
            scope = ContextNoteScope(
                self.workspace_id, card_id=self.card.id, kind=note_kind
            )
            await self._admit_notes(
                plan,
                outcome,
                scope,
                render=lambda body: card_note_block(
                    body, kind_marked=note_kind is None
                ),
                traced=True,
            )
        elif plan.kind == "pinned_notes":
            scope = ContextNoteScope(
                self.workspace_id, workspace_level=True, pinned_only=True
            )
            await self._admit_notes(plan, outcome, scope, render=pinned_note_block)
        elif plan.kind == "board_definition":
            definition = await DefinitionRepository(self.db).get_by_board(self.board.id)
            self._admit_block(
                plan,
                outcome,
                render_board_definition(definition, []),
                candidate_index=None,
            )
            scope = ContextNoteScope(
                self.workspace_id,
                board_id=self.board.id,
                pinned_only=True,
                nonempty_only=True,
            )
            await self._admit_notes(plan, outcome, scope, render=pinned_note_block)
        elif plan.kind == "review_history":
            scope = ContextNoteScope(
                self.workspace_id, card_id=self.card.id, kind=REVIEW_VERDICT
            )
            await self._admit_notes(plan, outcome, scope, render=review_note_block)
        else:
            text = await _FETCHERS[plan.kind](
                db=self.db,
                note_repo=NoteRepository(self.db),
                definition_repo=DefinitionRepository(self.db),
                card_repo=CardRepository(self.db),
                workspace_id=self.workspace_id,
                card=self.card,
                board=self.board,
                filter_=plan.filter,
                stage=self.stage,
                pipeline_stages=self.pipeline_stages,
            )
            self._admit_block(plan, outcome, text, candidate_index=0)
        return outcome

    def _admit_block(
        self,
        plan: _SourcePlan,
        outcome: _SourceOutcome,
        text: str,
        *,
        candidate_index: int | None,
    ) -> None:
        # An opaque non-note block is one atomic candidate, kept or dropped whole;
        # board_definition's definition part counts too (candidate_index None),
        # so admission and diagnostics agree.
        if not text:
            return
        outcome.candidate_count += 1
        reason = self._admit_if_fits(plan, outcome, text, optional_record_cap=False)
        if reason is None:
            outcome.admitted_count += 1
            if candidate_index is None:
                outcome.definition_part = text
            return
        outcome.exclusions.append(
            ContextExclusion(
                source_index=plan.source_index,
                candidate_index=candidate_index,
                note_id=None,
                title=None,
                kind=plan.kind,
                raw_body_bytes=None,
                rendered_bytes=utf8_bytes(text),
                revision_sha256=None,
                reason=reason,
            )
        )

    async def _admit_notes(
        self,
        plan: _SourcePlan,
        outcome: _SourceOutcome,
        scope: ContextNoteScope,
        *,
        render: Callable[[ContextNoteBody], str],
        traced: bool = False,
    ) -> None:
        assert plan.window is not None, "note sources always plan a window"
        headers, has_more = await self.notes.list_headers(scope, limit=plan.window)
        outcome.candidate_count += len(headers)
        outcome.has_more_candidates = has_more
        for candidate_index, header in enumerate(headers):
            body, skipped = await self._body(header, scope)
            if skipped is not None:
                outcome.exclusions.append(
                    _exclusion(plan, candidate_index, header, skipped)
                )
                continue
            assert body is not None
            # Structure is admitted before anything decodes, hashes or renders it.
            excess = structure_excess(
                body.content,
                max_depth=self.ceilings.max_json_depth,
                max_nodes=self.ceilings.max_json_nodes,
            )
            if excess is not None:
                outcome.exclusions.append(
                    _exclusion(plan, candidate_index, header, excess)
                )
                continue
            block = render(body)
            reason = self._admit_if_fits(
                plan, outcome, block, optional_record_cap=not plan.required
            )
            if reason is not None:
                outcome.exclusions.append(
                    _exclusion(
                        plan, candidate_index, header, reason, body=body, block=block
                    )
                )
                continue
            outcome.admitted_count += 1
            admitted = AdmittedNote(
                source_index=plan.source_index,
                candidate_index=candidate_index,
                body=body,
                rendered=block,
                rendered_sha256=sha256_text(block),
                rendered_bytes=utf8_bytes(block),
                revision_sha256=note_revision(body),
            )
            outcome.notes.append(admitted)
            if traced:
                outcome.records.append(
                    ContextRecord(
                        record_index=len(outcome.records),
                        note_id=body.id,
                        title=body.title,
                        kind=body.kind,
                        workspace_id=body.workspace_id,
                        board_id=body.board_id,
                        card_id=body.card_id,
                        updated_at=body.updated_at,
                        revision_sha256=admitted.revision_sha256,
                        rendered_sha256=admitted.rendered_sha256,
                        rendered_bytes=admitted.rendered_bytes,
                    )
                )

    async def _body(
        self, header: ContextNoteHeader, scope: ContextNoteScope
    ) -> tuple[ContextNoteBody | None, ExclusionReason | None]:
        if header.raw_bytes > self.policy.max_note_body_bytes:
            return None, "raw_body_limit"
        body = self.bodies.get(header.id)
        if body is None:
            remaining = self.policy.max_note_fetch_bytes - self.fetched_bytes
            if header.raw_bytes > remaining:
                return None, "fetch_budget"
            body = await self.notes.get_guarded_body(
                header.id,
                scope,
                max_bytes=min(self.policy.max_note_body_bytes, remaining),
            )
            if body is None:
                raise _selection_changed()
            # Charged on fetch and never refunded, even if rendering rejects it.
            self.fetched_bytes += body.raw_bytes
            self.bodies[header.id] = body
        if (body.raw_bytes, body.title, body.kind, body.pinned, body.created_at) != (
            header.raw_bytes,
            header.title,
            header.kind,
            header.pinned,
            header.created_at,
        ):
            raise _selection_changed()
        return body, None

    def _admit_if_fits(
        self,
        plan: _SourcePlan,
        outcome: _SourceOutcome,
        block: str,
        *,
        optional_record_cap: bool,
    ) -> ExclusionReason | None:
        rendered = utf8_bytes(block)
        # A separator exists only between admitted parts.
        added = rendered + (utf8_bytes(_SEPARATOR) if outcome.parts else 0)
        if optional_record_cap and rendered > self.policy.max_optional_note_bytes:
            return "record_too_large"
        if (
            plan.source_cap is not None
            and outcome.rendered_bytes + added > plan.source_cap
        ):
            return "source_budget"
        if self.managed_bytes + added > self.policy.max_managed_context_bytes:
            return "total_budget"
        outcome.parts.append(block)
        outcome.rendered_bytes += added
        self.managed_bytes += added
        return None

    def budget_report(self) -> ContextBudgetReport:
        return ContextBudgetReport(
            policy=ContextBudgetPolicyRead(**self.policy.as_dict()),
            policy_sha256=self.policy.sha256,
            raw_note_bytes_fetched=self.fetched_bytes,
            managed_context_bytes=self.managed_bytes,
            raw_note_fetch_coverage="complete",
            non_note_fetch_coverage="not_bounded",
        )


def _exclusion(
    plan: _SourcePlan,
    candidate_index: int,
    header: ContextNoteHeader,
    reason: ExclusionReason,
    *,
    body: ContextNoteBody | None = None,
    block: str | None = None,
) -> ContextExclusion:
    return ContextExclusion(
        source_index=plan.source_index,
        candidate_index=candidate_index,
        note_id=header.id,
        title=header.title,
        kind=header.kind,
        raw_body_bytes=header.raw_bytes,
        rendered_bytes=None if block is None else utf8_bytes(block),
        revision_sha256=None if body is None else note_revision(body),
        reason=reason,
    )


def _admission(
    plan: _SourcePlan, outcome: _SourceOutcome, policy: ContextBudgetPolicy
) -> ContextAdmission:
    excluded = outcome.candidate_count - outcome.admitted_count
    state: AdmissionOutcome
    if outcome.candidate_count == 0:
        state = "empty"
    elif outcome.admitted_count == 0:
        state = "excluded"
    elif excluded:
        state = "partial"
    else:
        state = "complete"
    return ContextAdmission(
        required=plan.required,
        outcome=state,
        candidate_limit=plan.window,
        candidate_count=outcome.candidate_count,
        has_more_candidates=outcome.has_more_candidates,
        admitted_count=outcome.admitted_count,
        excluded_count=excluded,
        max_rendered_bytes=plan.source_cap or policy.max_managed_context_bytes,
    )


def _diagnostics(
    exclusions: list[ContextExclusion], ceilings: ContextBudgetCeilings
) -> ContextDiagnostics:
    ordered = sorted(
        exclusions,
        key=lambda e: (
            e.source_index,
            -1 if e.candidate_index is None else e.candidate_index,
        ),
    )
    reason_counts: dict[str, int] = dict(Counter(e.reason for e in ordered))
    # `false` outspells `true`, so this envelope bounds either final flag.
    size = utf8_bytes(
        canonical_json(
            {
                "entries": [],
                "excluded_count": len(ordered),
                "reason_counts": reason_counts,
                "truncated": False,
            }
        )
    )
    entries: list[ContextExclusion] = []
    for exclusion in ordered:
        if len(entries) == ceilings.max_diagnostic_entries:
            break
        added = utf8_bytes(canonical_json(exclusion.model_dump(mode="json")))
        added += 1 if entries else 0
        if size + added > ceilings.max_diagnostic_bytes:
            break
        entries.append(exclusion)
        size += added
    return ContextDiagnostics(
        entries=entries,
        excluded_count=len(ordered),
        reason_counts=reason_counts,
        truncated=len(entries) < len(ordered),
    )


def _bounded_whole_entries(
    entries: list[dict], ceilings: ContextBudgetCeilings
) -> list[dict]:
    # Operator aliases are unbounded strings: list whole entries, in order,
    # within the diagnostic count and serialized-byte ceilings.
    kept: list[dict] = []
    size = utf8_bytes("[]")
    for entry in entries:
        if len(kept) == ceilings.max_diagnostic_entries:
            break
        added = utf8_bytes(canonical_json(entry)) + (1 if kept else 0)
        if size + added > ceilings.max_diagnostic_bytes:
            break
        kept.append(entry)
        size += added
    return kept


def _is_unmet(plan: _SourcePlan, outcome: _SourceOutcome) -> bool:
    # Required means a nonempty, completely admitted bounded window.
    return plan.required and (not outcome.parts or bool(outcome.exclusions))


async def assemble_guarded_context(
    db: AsyncSession,
    *,
    policy: ContextBudgetPolicy,
    ceilings: ContextBudgetCeilings,
    workspace_id: uuid.UUID,
    card: Card,
    board: Board,
    sources: list[dict],
    stage: dict | None = None,
    pipeline_stages: list[dict] | None = None,
) -> AssembledContext:
    sources = sources or []
    if len(sources) > ceilings.max_sources:
        # Refused whole before any note query; aliases are never truncated.
        raise ConflictError(
            "Too many context sources are configured for this instance",
            error_code="context_source_limit_exceeded",
            context={
                "source_limit": ceilings.max_sources,
                "source_count": len(sources),
            },
        )
    plans = _plan_sources(sources, policy)
    assembly = _GuardedAssembly(
        db,
        policy,
        ceilings,
        workspace_id=workspace_id,
        card=card,
        board=board,
        stage=stage,
        pipeline_stages=pipeline_stages,
    )
    outcomes: dict[int, _SourceOutcome] = {}
    for plan in (p for p in plans if p.required):
        outcomes[plan.source_index] = await assembly.admit(plan)
    unmet = [p for p in plans if p.required and _is_unmet(p, outcomes[p.source_index])]
    if unmet:
        required = [p for p in plans if p.required]
        failed_sources = _bounded_whole_entries(
            [
                {
                    "source_index": p.source_index,
                    "kind": p.kind,
                    "alias": p.alias,
                    "admission": _admission(
                        p, outcomes[p.source_index], policy
                    ).model_dump(mode="json"),
                }
                for p in required
            ],
            ceilings,
        )
        raise ConflictError(
            "Required context does not fit the context budget; reduce the selection, "
            "revise the context or change the budget",
            error_code="context_budget_exceeded",
            context={
                # Distinguishes this from the final invocation cap (invocation_bytes).
                "reason": "required_source",
                "budget": assembly.budget_report().model_dump(mode="json"),
                "diagnostics": _diagnostics(
                    [e for p in required for e in outcomes[p.source_index].exclusions],
                    ceilings,
                ).model_dump(mode="json"),
                "sources": failed_sources,
                "sources_truncated": len(failed_sources) < len(required),
                "required_source_count": len(required),
            },
        )
    for plan in (p for p in plans if not p.required):
        outcomes[plan.source_index] = await assembly.admit(plan)

    rendered: dict[str, str] = {}
    manifest_sources: list[ContextSource] = []
    admissions = {
        p.source_index: _admission(p, outcomes[p.source_index], policy) for p in plans
    }
    for plan in plans:
        outcome = outcomes[plan.source_index]
        text = outcome.text
        rendered[plan.alias] = text
        manifest_sources.append(
            ContextSource(
                source_index=plan.source_index,
                kind=plan.kind,
                alias=plan.alias,
                filter=plan.filter,
                coverage="record_traced"
                if plan.kind == "card_notes"
                else "source_only",
                rendered_sha256=sha256_text(text),
                rendered_bytes=utf8_bytes(text),
                records=outcome.records,
                admission=admissions[plan.source_index],
            )
        )
    budget = assembly.budget_report()
    diagnostics = _diagnostics(
        [e for o in outcomes.values() for e in o.exclusions], ceilings
    )
    manifest = ContextManifest(
        schema_version=BUDGETED_MANIFEST_SCHEMA_VERSION,
        renderer_version=RENDERER_VERSION,
        sources=manifest_sources,
        budget=budget,
        diagnostics=diagnostics,
    )
    selection = GuardedSelection(
        policy=policy,
        sources=tuple(
            SelectedSource(
                source_index=plan.source_index,
                kind=plan.kind,
                alias=plan.alias,
                filter=plan.filter,
                required=plan.required,
                text=outcomes[plan.source_index].text,
                admission=admissions[plan.source_index],
                notes=tuple(outcomes[plan.source_index].notes),
                definition_part=outcomes[plan.source_index].definition_part,
                exclusions=tuple(outcomes[plan.source_index].exclusions),
            )
            for plan in plans
        ),
        budget=budget,
        diagnostics=diagnostics,
    )
    return AssembledContext(
        context=rendered,
        manifest=manifest,
        revision=context_revision(manifest),
        # One per configured source, in order: duplicate aliases overwrite each
        # other in `context`, never here.
        blocks=tuple(outcomes[plan.source_index].text for plan in plans),
        selection=selection,
    )


async def assemble_for_invocation(
    db: AsyncSession,
    *,
    pipeline: dict,
    stage_index: int,
    step_index: int | None,
    sources: list[dict],
    workspace_id: uuid.UUID,
    card: Card,
    board: Board,
    stage: dict | None = None,
) -> AssembledContext:
    """Every reader of an invocation's context (refresh, assignment,
    dispatch) resolves its budget through this one path."""
    ceilings = settings.CONTEXT_BUDGET_CEILINGS
    resolution = resolve_invocation_budget(
        pipeline, stage_index=stage_index, step_index=step_index, ceilings=ceilings
    )
    if resolution.findings:
        raise invalid_persisted_budget(resolution.findings)
    stages = pipeline.get("stages") or []
    if resolution.policy is None:
        return await assemble_context_with_manifest(
            db,
            workspace_id=workspace_id,
            card=card,
            board=board,
            sources=sources,
            stage=stage,
            pipeline_stages=stages,
        )
    return await assemble_guarded_context(
        db,
        policy=resolution.policy,
        ceilings=ceilings,
        workspace_id=workspace_id,
        card=card,
        board=board,
        sources=sources,
        stage=stage,
        pipeline_stages=stages,
    )


async def assemble_stage_context(
    db: AsyncSession,
    *,
    pipeline: dict,
    role: str,
    workspace_id: uuid.UUID,
    card: Card,
    board: Board,
    sources: list[dict],
    stage: dict,
) -> AssembledContext:
    """A role's flat-stage call (assignment bundle, A1 refresh/prepare),
    through the same budget resolution as named-step dispatch."""
    stages = pipeline.get("stages") or []
    stage_index = next(
        (
            i
            for i, s in enumerate(stages)
            if isinstance(s, dict) and s.get("role") == role
        ),
        None,
    )
    if stage_index is None:
        return await assemble_context_with_manifest(
            db,
            workspace_id=workspace_id,
            card=card,
            board=board,
            sources=sources,
            stage=stage,
            pipeline_stages=stages,
        )
    return await assemble_for_invocation(
        db,
        pipeline=pipeline,
        stage_index=stage_index,
        step_index=None,
        sources=sources,
        workspace_id=workspace_id,
        card=card,
        board=board,
        stage=stage,
    )
