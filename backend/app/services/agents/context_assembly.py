# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Server-rendered context_sources for /next-assignment (CTX-1, CTX-5).

The pipeline-config validator accepts a closed set of `kind`s; each kind
has a fetcher here that returns one rendered string. The runner is a
dumb consumer — it never queries notes/definitions itself.

Empty results return an empty string (not a missing key) so the prompt
template never has to branch on presence.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.activity import ActivityEntityType
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column, ColumnType
from app.models.notes.kinds import REVIEW_VERDICT
from app.repositories.activity import ActivityRepository
from app.repositories.agents.execution import ExecutionRepository
from app.repositories.definitions.definition import DefinitionRepository
from app.repositories.kanban.card import CardRepository
from app.repositories.notes.note import NoteRepository
from app.schemas.definitions.definition import DefinitionContent
from app.services.kanban.dependencies import DependencyService
from app.services.kanban.dependency_graph import DependencyGraphService
from app.services.notes.content_serializer import prosemirror_to_markdown


def context_source_alias(source: dict) -> str | None:
    kind = source.get("kind")
    alias = source.get("as") or kind
    if not isinstance(alias, str) or not alias or kind not in _FETCHERS:
        return None
    return alias


async def assemble_context(
    db: AsyncSession,
    *,
    workspace_id: uuid.UUID,
    card: Card,
    board: Board,
    sources: list[dict],
    stage: dict | None = None,
    pipeline_stages: list[dict] | None = None,
) -> dict[str, str]:
    if not sources:
        return {}

    note_repo = NoteRepository(db)
    definition_repo = DefinitionRepository(db)
    card_repo = CardRepository(db)
    rendered: dict[str, str] = {}
    for source in sources:
        kind = source.get("kind")
        alias = context_source_alias(source)
        if alias is None:
            continue
        rendered[alias] = await _FETCHERS[kind](
            db=db,
            note_repo=note_repo,
            definition_repo=definition_repo,
            card_repo=card_repo,
            workspace_id=workspace_id,
            card=card,
            board=board,
            filter_=source.get("filter") or {},
            # The pipeline_expectations source renders from config, not DB
            # rows: the role's own current stage and (for the all_roles
            # scope) every configured stage. Threaded from /next-assignment,
            # which already has both in scope.
            stage=stage,
            pipeline_stages=pipeline_stages,
        )
    return rendered


async def _fetch_card_notes(
    *,
    note_repo: NoteRepository,
    workspace_id: uuid.UUID,
    card: Card,
    filter_: dict[str, Any],
    **_: Any,
) -> str:
    note_kind = filter_.get("kind")
    if note_kind:
        notes = await note_repo.list_card_notes_by_kind(
            card_id=card.id, workspace_id=workspace_id, kind=note_kind
        )
    else:
        notes = await note_repo.list_by_card(card_id=card.id, workspace_id=workspace_id)
    # Both repo queries order newest first, so slicing keeps the most recent.
    notes = notes[: _clamp_limit(filter_, _MAX_CONTEXT_LIMIT)]
    if not notes:
        return ""
    # A kind-less source mixes plans, research and verdicts: mark each note's
    # kind so the agent can tell a prior plan from a human hint.
    kind_marker = "" if note_kind else "[{kind}] "
    return "\n\n".join(
        f"- **{kind_marker.format(kind=n.kind)}{n.title}**: {prosemirror_to_markdown(n.content)}"
        for n in notes
    )


async def _fetch_board_definition(
    *,
    definition_repo: DefinitionRepository,
    note_repo: NoteRepository,
    workspace_id: uuid.UUID,
    board: Board,
    **_: Any,
) -> str:
    # Mirrors runner/internal/valaris/types.go ProjectDirectives.Format and the
    # routes it pulls from (GET /boards/{id}/context + GET /boards/{id}/notes),
    # so the legacy {{.ProjectDirectives}} runner alias keeps producing a
    # directive block. Renders all 10 structured definition fields in two tiers:
    # MANDATORY (rules the runner must obey) and PROJECT CONTEXT (reference).
    # Pinned notes here are board-scoped — workspace-level pinned notes are
    # exposed via the separate `pinned_notes` kind.
    definition = await definition_repo.get_by_board(board.id)
    board_notes = await note_repo.list_by_board(board.id)
    return render_board_definition(definition, board_notes)


def render_board_definition(definition, board_notes):
    parts: list[str] = []
    if definition is not None:
        scope = (definition.scope or "").strip()
        if scope:
            parts.append(f"PROJECT SCOPE:\n{scope}")

        content = definition.content if isinstance(definition.content, dict) else {}
        spec = DefinitionContent.model_validate(content)

        mandatory = _render_mandatory_tier(spec, content)
        if mandatory:
            parts.append(mandatory)

        context = _render_project_context_tier(spec)
        if context:
            parts.append(context)

    pinned = [n for n in board_notes if n.pinned and n.content]
    for note in pinned:
        parts.append(f"NOTE — {note.title}:\n{note.content}")

    return "\n\n".join(parts)


def _render_mandatory_tier(spec: DefinitionContent, content: dict[str, Any]) -> str:
    sections: list[str] = []

    if spec.objectives:
        lines = [
            f"- {o.text}" + (f" [{o.priority}]" if o.priority else "")
            for o in spec.objectives
        ]
        sections.append("OBJECTIVES:\n" + "\n".join(lines))

    if spec.constraints:
        sections.append("CONSTRAINTS:\n" + "\n".join(f"- {c}" for c in spec.constraints))

    if spec.exclusions:
        sections.append("EXCLUSIONS:\n" + "\n".join(f"- {e}" for e in spec.exclusions))

    standards = content.get("coding_standards")
    if isinstance(standards, str) and standards.strip():
        sections.append(f"CODING STANDARDS:\n{standards.strip()}")

    if not sections:
        return ""
    return "## MANDATORY\n\n" + "\n\n".join(sections)


def _render_project_context_tier(spec: DefinitionContent) -> str:
    sections: list[str] = []

    if spec.tech_stack:
        sections.append("TECH STACK:\n" + "\n".join(f"- {t}" for t in spec.tech_stack))

    if spec.decisions:
        lines = [
            f"- {d.decision}" + (f" — {d.rationale}" if d.rationale else "")
            for d in spec.decisions
        ]
        sections.append("KEY DECISIONS:\n" + "\n".join(lines))

    if spec.milestones:
        lines = [
            f"- {m.title} ({m.date})" + (f" [{m.type}]" if m.type else "")
            for m in spec.milestones
        ]
        sections.append("MILESTONES:\n" + "\n".join(lines))

    if spec.stakeholders:
        lines = [
            f"- {s.name}" + (f" — {s.role}" if s.role else "") for s in spec.stakeholders
        ]
        sections.append("STAKEHOLDERS:\n" + "\n".join(lines))

    if spec.references:
        lines = [
            f"- {r.label}: {r.url}" if r.label else f"- {r.url}" for r in spec.references
        ]
        sections.append("REFERENCES:\n" + "\n".join(lines))

    if spec.custom_fields:
        lines = [f"- {f.key}: {f.value}" for f in spec.custom_fields]
        sections.append("\n".join(lines))

    if not sections:
        return ""
    return "## PROJECT CONTEXT\n\n" + "\n\n".join(sections)


async def _fetch_pinned_notes(
    *,
    note_repo: NoteRepository,
    workspace_id: uuid.UUID,
    **_: Any,
) -> str:
    notes = await note_repo.list_by_workspace(workspace_id=workspace_id)
    pinned = [n for n in notes if n.pinned]
    if not pinned:
        return ""
    return "\n\n".join(f"NOTE — {n.title}:\n{n.content}" for n in pinned)


# CTX-5: short prefix for human-scannable card identifiers in rendered lists.
# Mirrors the convention used elsewhere in MCP/UI ("CARD-XXXXXXXX"); 8 hex
# chars from the UUID is enough to disambiguate within a board.
_CARD_PREFIX_LEN = 8

_DEFAULT_SIBLING_LIMIT = 10
_MAX_SIBLING_LIMIT = 50

_DEFAULT_SNAPSHOT_MAX = 20


def _card_handle(card_id: uuid.UUID) -> str:
    return f"CARD-{str(card_id)[:_CARD_PREFIX_LEN]}"


async def _fetch_sibling_cards(
    *,
    card_repo: CardRepository,
    card: Card,
    board: Board,
    filter_: dict[str, Any],
    **_: Any,
) -> str:
    limit = filter_.get("limit") or _DEFAULT_SIBLING_LIMIT
    if not isinstance(limit, int) or limit < 1:
        limit = _DEFAULT_SIBLING_LIMIT
    limit = min(limit, _MAX_SIBLING_LIMIT)

    # Pull `limit + 1` so we can drop the current card without ending up short.
    siblings = await card_repo.search(
        board_id=board.id,
        column_type=filter_.get("column_type") or None,
        label=filter_.get("label") or None,
        priority=filter_.get("priority") or None,
        limit=limit + 1,
    )

    column_slug = filter_.get("column")  # named "column" per the brief; treated as a name slug.

    # Resolve real column names so each rendered row reflects the sibling's
    # actual column — not an echo of `column_type` / `column` filter values.
    # CardRepository.search doesn't selectinload Column, so one batched lookup.
    column_name_by_id: dict[uuid.UUID, str] = {}
    if siblings:
        ids = {s.column_id for s in siblings}
        res = await card_repo.db.execute(
            select(Column.id, Column.name).where(Column.id.in_(ids))
        )
        column_name_by_id = {row[0]: row[1] for row in res.all()}

    rows: list[str] = []
    for sibling in siblings:
        if sibling.id == card.id:
            continue
        # `column` filter isn't a built-in CardRepository.search parameter; do
        # a cheap post-filter on the column display-name instead. Operators
        # are most likely to use `column_type` (typed scope) anyway.
        if column_slug and column_name_by_id.get(sibling.column_id) != column_slug:
            continue
        column_label = column_name_by_id.get(sibling.column_id) or "no column"
        status = sibling.status or "no status"
        rows.append(
            f"- [{_card_handle(sibling.id)}] {sibling.title} ({column_label}, {status})"
        )
        if len(rows) >= limit:
            break
    return "\n".join(rows)


async def _fetch_board_snapshot(
    *,
    db: AsyncSession,
    board: Board,
    filter_: dict[str, Any],
    **_: Any,
) -> str:
    include_done = bool(filter_.get("include_done"))
    max_per_column = filter_.get("max_cards_per_column") or _DEFAULT_SNAPSHOT_MAX
    if not isinstance(max_per_column, int) or max_per_column < 1:
        max_per_column = _DEFAULT_SNAPSHOT_MAX

    result = await db.execute(
        select(Column)
        .where(Column.board_id == board.id)
        .options(selectinload(Column.cards))
        .order_by(Column.position)
    )
    columns = list(result.scalars().all())
    if not columns:
        return ""

    sections: list[str] = []
    for column in columns:
        if not include_done and column.column_type == ColumnType.done:
            continue
        cards = list(column.cards)
        header = f"## {column.name} ({len(cards)})"
        body_lines = [
            f"- [{_card_handle(c.id)}] {c.title} (status: {c.status or '—'})"
            for c in cards[:max_per_column]
        ]
        if len(cards) > max_per_column:
            body_lines.append(f"- _...{len(cards) - max_per_column} more_")
        sections.append("\n".join([header, *body_lines]) if body_lines else header)

    return "\n\n".join(sections) if sections else ""


async def _fetch_review_history(
    *,
    note_repo: NoteRepository,
    workspace_id: uuid.UUID,
    card: Card,
    **_: Any,
) -> str:
    # Format parity with runner/internal/workloop/loop.go:1477
    # (Loop.fetchReviewHistory): each note rendered as
    #   --- {Title} (created {CreatedAt}) ---\n{Content}
    # joined by "\n\n". Empty list -> empty string. The Go side reads
    # `created_at` straight from the JSON envelope (ISO 8601), so emitting
    # `note.created_at.isoformat()` keeps the consumer-side strings identical.
    notes = await note_repo.list_card_notes_by_kind(
        card_id=card.id, workspace_id=workspace_id, kind=REVIEW_VERDICT
    )
    if not notes:
        return ""
    return "\n\n".join(
        f"--- {n.title} (created {n.created_at.isoformat()}) ---\n{n.content}"
        for n in notes
    )


async def _fetch_dependency_health(
    *,
    db: AsyncSession,
    board: Board,
    **_: Any,
) -> str:
    # Surfaces the board's dependency-graph faults (cycles / done-conflicts /
    # dangling edges) so an agent sees blockers before acting. A healthy graph
    # injects nothing — matches the other fetchers' empty-string convention.
    validation = await DependencyGraphService(db).validate(board_id=board.id)
    if validation.ok:
        return ""

    lines = [f"- {issue.summary}" for issue in validation.cycles]
    lines += [f"- {issue.summary}" for issue in validation.conflicts]
    lines += [f"- {issue.summary}" for issue in validation.orphans]
    return "DEPENDENCY HEALTH:\n" + "\n".join(lines)


_DEFAULT_LINKED_LIMIT = 20
_DEFAULT_EXECUTION_LIMIT = 10
_DEFAULT_ACTIVITY_LIMIT = 15
_MAX_CONTEXT_LIMIT = 50


def _clamp_limit(filter_: dict[str, Any], default: int) -> int:
    limit = filter_.get("limit")
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
        return default
    return min(limit, _MAX_CONTEXT_LIMIT)


def _edge_satisfied(column_type: str | None) -> bool:
    return column_type == ColumnType.done.value


async def _fetch_linked_cards(
    *,
    db: AsyncSession,
    workspace_id: uuid.UUID,
    card: Card,
    filter_: dict[str, Any],
    **_: Any,
) -> str:
    # The current card's *own* dependency edges, annotated with each linked
    # card's done-state. Unlike `sibling_cards` (a generic board scan), this
    # tells the agent exactly what gates it (DEPENDS ON) and what it gates
    # (BLOCKS) — the dependency-aware context the pipeline now reasons over.
    direction = filter_.get("direction") or "both"
    limit = _clamp_limit(filter_, _DEFAULT_LINKED_LIMIT)

    view = await DependencyService(db).list_for_card(
        workspace_id=workspace_id, card_id=card.id
    )

    sections: list[str] = []
    if direction in ("both", "depends_on") and view.depends_on:
        lines = []
        for edge in view.depends_on[:limit]:
            satisfied = _edge_satisfied(edge.depends_on_column_type)
            state = "done" if satisfied else "not done"
            lines.append(
                f"- [{_card_handle(edge.depends_on_card_id)}] "
                f"{edge.depends_on_title or 'untitled'} "
                f"({edge.depends_on_status or 'no status'}, {state})"
            )
        sections.append("DEPENDS ON (prerequisites):\n" + "\n".join(lines))

    if direction in ("both", "blocks") and view.blocks:
        lines = []
        for edge in view.blocks[:limit]:
            # In the `blocks` direction the projection describes the *dependent*
            # card (the one this card gates), stored under depends_on_* fields.
            lines.append(
                f"- [{_card_handle(edge.card_id)}] "
                f"{edge.depends_on_title or 'untitled'} "
                f"({edge.depends_on_status or 'no status'})"
            )
        sections.append("BLOCKS (downstream):\n" + "\n".join(lines))

    return "\n\n".join(sections)


async def _fetch_execution_history(
    *,
    db: AsyncSession,
    workspace_id: uuid.UUID,
    card: Card,
    filter_: dict[str, Any],
    **_: Any,
) -> str:
    # Prior agent runs that touched this card (via cards_affected). Gives
    # rework/implementer agents memory of past attempts — what was tried, what
    # failed, and why. `cards_affected` is plain JSON, so we filter in Python
    # to stay dialect-agnostic (mirrors CardRepository's approval lookup).
    limit = _clamp_limit(filter_, _DEFAULT_EXECUTION_LIMIT)
    status = filter_.get("status") or None

    repo = ExecutionRepository(db)
    # Over-fetch: workspace executions are ordered newest-first; we keep the
    # first `limit` whose cards_affected includes this card.
    executions = await repo.list_by_workspace(
        workspace_id=workspace_id, status=status, limit=_MAX_CONTEXT_LIMIT * 4
    )

    card_id_str = str(card.id)
    rows: list[str] = []
    for ex in executions:
        affected = ex.cards_affected if isinstance(ex.cards_affected, list) else []
        if card_id_str not in {str(c) for c in affected}:
            continue
        role = f" [{ex.role}]" if ex.role else ""
        model = f" via {ex.model}" if ex.model else ""
        status_value = ex.status.value if hasattr(ex.status, "value") else ex.status
        header = f"- {ex.action}{role}{model} — {status_value}"
        detail = ex.error_message or ex.output_summary
        rows.append(f"{header}\n  {detail}" if detail else header)
        if len(rows) >= limit:
            break

    return "\n".join(rows)


async def _fetch_card_activity(
    *,
    db: AsyncSession,
    workspace_id: uuid.UUID,
    card: Card,
    filter_: dict[str, Any],
    **_: Any,
) -> str:
    # The card's own activity timeline (moves, participant + dependency edits,
    # note creation). A lightweight, chronological "what happened to this card"
    # that complements execution_history's "what agents did".
    limit = _clamp_limit(filter_, _DEFAULT_ACTIVITY_LIMIT)

    activities = await ActivityRepository(db).list_by_workspace(
        workspace_id=workspace_id,
        entity_type=ActivityEntityType.card,
        limit=_MAX_CONTEXT_LIMIT * 4,
    )

    rows: list[str] = []
    for act in activities:
        if act.entity_id != card.id:
            continue
        action = act.action.value if hasattr(act.action, "value") else act.action
        rows.append(f"- {act.created_at.isoformat()} · {action}: {act.summary}")
        if len(rows) >= limit:
            break

    return "\n".join(rows)


def _short_tool(tool: str) -> str:
    # Strip the mcp__valaris__ / mcp__<server>__ prefix so the rendered tool
    # list reads cleanly. Claude builtins (Read, Edit, …) pass through.
    return tool.rsplit("__", 1)[-1] if "__" in tool else tool


def _llm_step(stage: dict) -> dict | None:
    # The decision vocabulary + branches live on the lifecycle's `llm` step.
    # Fall back to the flat stage.llm block (no branches there, but it still
    # carries post_process_kind/tools) for stages with no lifecycle array.
    lifecycle = stage.get("lifecycle")
    if isinstance(lifecycle, list):
        for step in lifecycle:
            if isinstance(step, dict) and step.get("kind") == "llm":
                return step
    return None


def _step_by_name(stage: dict) -> dict[str, dict]:
    lifecycle = stage.get("lifecycle")
    if not isinstance(lifecycle, list):
        return {}
    return {
        s["name"]: s
        for s in lifecycle
        if isinstance(s, dict) and isinstance(s.get("name"), str)
    }


def _branch_effect(stage: dict, target_step_name: str) -> str:
    # Walk the chain of `next` steps from a branch target and summarise the
    # card-visible effects (label changes, column moves) the agent's decision
    # will trigger. Keeps drift impossible: the prompt describes what the
    # config actually does, not what prose claims it does.
    steps = _step_by_name(stage)
    effects: list[str] = []
    seen: set[str] = set()
    name: str | None = target_step_name
    while name and name in steps and name not in seen:
        seen.add(name)
        step = steps[name]
        kind = step.get("kind")
        params = step.get("params") if isinstance(step.get("params"), dict) else {}
        if kind == "move_card":
            dest = params.get("to_column_type") or params.get("to_column") or "?"
            effects.append(f"moves card to {dest}")
        elif kind == "apply_label":
            effects.append(f"applies label '{params.get('label', '?')}'")
        elif kind == "remove_label":
            effects.append(f"removes label '{params.get('label', '?')}'")
        elif kind == "wake_role":
            roles = params.get("roles") or []
            if roles:
                effects.append(f"wakes {', '.join(str(r) for r in roles)}")
        elif kind == "merge_pr":
            effects.append("merges the PR")
        name = step.get("next")
    return "; ".join(effects)


def _render_decision_vocab(llm_step: dict, stage: dict) -> str:
    branches = llm_step.get("branches")
    if not isinstance(branches, dict) or not branches:
        return ""
    lines = ["Decisions (emit exactly one):"]
    for decision, target in branches.items():
        effect = _branch_effect(stage, target) if isinstance(target, str) else ""
        lines.append(f"- {decision}" + (f" → {effect}" if effect else ""))
    return "\n".join(lines)


def _render_stage_expectations(stage: dict) -> str:
    role = stage.get("role") or "?"
    llm_step = _llm_step(stage)
    llm_params = (llm_step or {}).get("params") if llm_step else None
    if not isinstance(llm_params, dict):
        llm_params = stage.get("llm") if isinstance(stage.get("llm"), dict) else {}

    stage_name = llm_params.get("stage") or ""
    ppk = llm_params.get("post_process_kind") or ""
    tools = llm_params.get("tools")
    if not isinstance(tools, list):
        tools = (stage.get("llm") or {}).get("tools") if isinstance(stage.get("llm"), dict) else []

    header = f"THIS STAGE — role: {role}"
    if stage_name:
        header += f" (stage: {stage_name})"

    parts = [header]
    if ppk:
        parts.append(f"Output: {ppk}")

    if llm_step:
        vocab = _render_decision_vocab(llm_step, stage)
        if vocab:
            parts.append(vocab)

    if tools:
        short = ", ".join(_short_tool(t) for t in tools if isinstance(t, str))
        if short:
            parts.append(f"Allowed tools: {short}")

    return "\n".join(parts)


def _render_role_overview_row(stage: dict, labels: set[str]) -> str:
    role = stage.get("role") or "?"
    discover = stage.get("discover") if isinstance(stage.get("discover"), dict) else {}
    filters = discover.get("filters") if isinstance(discover.get("filters"), dict) else {}

    picks: list[str] = []
    col_type = discover.get("column_type")
    if col_type:
        picks.append(f"{col_type} column")
    if filters.get("require_label"):
        picks.append(f"requires label '{filters['require_label']}'")
    if filters.get("exclude_label"):
        picks.append(f"excludes label '{filters['exclude_label']}'")
    if filters.get("require_pipeline_role"):
        picks.append(f"after role '{filters['require_pipeline_role']}'")
    if filters.get("require_git_repo"):
        picks.append("needs git repo")

    # Collect every label this role moves cards by, for the labels-in-play tail.
    for key in ("require_label", "exclude_label"):
        if isinstance(filters.get(key), str):
            labels.add(filters[key])
    for step in stage.get("lifecycle") or []:
        if not isinstance(step, dict):
            continue
        if step.get("kind") in ("apply_label", "remove_label"):
            params = step.get("params") if isinstance(step.get("params"), dict) else {}
            if isinstance(params.get("label"), str):
                labels.add(params["label"])

    line = f"{role} — picks: " + ("; ".join(picks) if picks else "(no discover filters)")

    llm_step = _llm_step(stage)
    if llm_step:
        vocab_lines = []
        branches = llm_step.get("branches")
        if isinstance(branches, dict):
            for decision, target in branches.items():
                effect = _branch_effect(stage, target) if isinstance(target, str) else ""
                vocab_lines.append(f"{decision}" + (f" → {effect}" if effect else ""))
        if vocab_lines:
            line += "\n  emits: " + "; ".join(vocab_lines)
    return line


async def _fetch_pipeline_expectations(
    *,
    stage: dict | None,
    pipeline_stages: list[dict] | None,
    filter_: dict[str, Any],
    **_: Any,
) -> str:
    # Renders the pipeline config the agent operates under — NOT board data.
    # `current_role` (default): the agent's own stage — its output shape, the
    # exact decision vocabulary its branches accept, and the card-visible
    # effect of each decision. Lets prompts say "emit one of {decisions}"
    # generically so prompt prose can never drift from the lifecycle branches.
    # `all_roles`: a per-role map of the whole pipeline (discover predicates,
    # decision edges, labels in play) so a "pipeline plumber" role can reason
    # about where a card is wedged. Static config only — no board scan.
    scope = filter_.get("scope") or "current_role"

    if scope == "all_roles":
        stages = pipeline_stages if isinstance(pipeline_stages, list) else None
        if not stages:
            # Defensive degrade: a plumber misconfig (all_roles with no stages
            # threaded) renders the current stage rather than a blank prompt.
            return _render_stage_expectations(stage) if stage else ""
        labels: set[str] = set()
        rows = [
            _render_role_overview_row(s, labels)
            for s in stages
            if isinstance(s, dict) and s.get("role")
        ]
        out = "PIPELINE OVERVIEW (all roles)\n\n" + "\n".join(rows)
        if labels:
            out += "\n\nLabels in play: " + ", ".join(sorted(labels))
        return out

    if not stage:
        return ""
    return _render_stage_expectations(stage)


_FETCHERS = {
    "card_notes": _fetch_card_notes,
    "board_definition": _fetch_board_definition,
    "pinned_notes": _fetch_pinned_notes,
    "sibling_cards": _fetch_sibling_cards,
    "board_snapshot": _fetch_board_snapshot,
    "review_history": _fetch_review_history,
    "dependency_health": _fetch_dependency_health,
    "linked_cards": _fetch_linked_cards,
    "execution_history": _fetch_execution_history,
    "card_activity": _fetch_card_activity,
    "pipeline_expectations": _fetch_pipeline_expectations,
}
