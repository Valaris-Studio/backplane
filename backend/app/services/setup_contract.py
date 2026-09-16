# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""WS3: the board-provisioning setup contract.

A `SetupContract` is the machine-readable answer to "what does a board need to
run this pipeline?" — the COLUMNS (+types), the LABEL vocabulary (who applies /
removes / gates each one), and a prose role-orchestration overview. It is
DERIVED from a live `pipeline_config` by `build_setup_contract`, so it can never
drift from the actual discover/lifecycle predicates the runner keys on. An MCP
setup agent (or a human) consumes the serialized form to provision a board.

The contract is an OPTIONAL nested field on `pipeline_config` (`setup_contract`).
When present, `validate_pipeline_config` runs a drift check: every label/column
the config actually uses must appear in the hand-authored contract. The contract
travels with the config and inside the portable bundle (WS2).

This module reuses the label/column/decision extraction already proven in
`context_assembly._render_role_overview_row` rather than re-deriving it.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Label-valued discover filter keys, in sync with pipeline_config_validation.
# `include_label`/`label`/`require_label` mean "card must carry it"; an
# `exclude_label` means "skip if present". All count as the role *gating on* the
# label.
_LABEL_FILTER_KEYS = ("require_label", "include_label", "label", "exclude_label")

# Canonical left-to-right board layout order. A setup agent creates columns in
# this order regardless of scheduler priority — a board reads backlog→done even
# though the scheduler walks reviewer-first. Unknown types append after.
_COLUMN_LAYOUT_ORDER = ("backlog", "active", "review", "done", "blocked")

# P4 (post-run-B 2026-06-10): the standing board-composition rule every setup
# agent must honor. White-label — keyed on board structure (a dependency-sink
# card) and artifact signals (built deliverable, entrypoint greps), no project
# names. Travels with the contract into WS2 portable bundles.
_BOARD_COMPOSITION_RULE = (
    "Board composition rule: every board MUST contain a final acceptance card "
    "(title prefix ACCEPT-, plus per-milestone SMOKE- cards for long boards) "
    "made dependent on all sibling cards via bulk_set_card_dependencies so it "
    "runs last (all_dependencies_done gates it). Its Done condition is "
    "artifact-level, with grep-able assertions in the card body: (a) build the "
    "real deliverable (the packaged app/binary/server, not the test suite); "
    "(b) launch it and drive the north-star user journey end-to-end; (c) "
    "assert the composition root references zero known interim symbols — the "
    "assertion list lives in the card body and every interim-seam follow-up "
    "card appends its symbol to it; (d) on failure, file fix cards and "
    "re-block itself on them — never patch inline."
)


@dataclass
class ColumnSpec:
    """A board column the pipeline discovers cards in."""

    column_type: str
    position: int
    name: str  # display name; defaults to a title-cased column_type


@dataclass
class LabelGate:
    """A label in the pipeline's vocabulary and how roles interact with it.

    `applies_in_role` / `removes_in_role` come from lifecycle apply_label /
    remove_label steps; `gated_by_roles` is every role whose discover filters
    reference the label (require/include/exclude). A label may be purely
    pre-seeded (applies_in_role=None) — e.g. `needs-ui-validation` is applied at
    review time, not by any default lifecycle step.
    """

    name: str
    applies_in_role: str | None
    removes_in_role: str | None
    gated_by_roles: list[str]
    description: str


@dataclass
class RoleOrchestration:
    """A single role's place in the pipeline: how it picks cards and what its
    decisions do to the card."""

    role: str
    pick_strategy: list[str]
    emits: list[str]
    terminal_actions: list[str]


@dataclass
class SetupContract:
    """Machine + human-readable board-provisioning contract.

    Consumed by setup agents to (1) create columns with the right types in
    order, (2) understand the label vocabulary and which role owns each label,
    (3) read the role handoff sequence.
    """

    version: int = 1
    columns: list[ColumnSpec] = field(default_factory=list)
    labels: list[LabelGate] = field(default_factory=list)
    role_orchestration: list[RoleOrchestration] = field(default_factory=list)
    prose_overview: str = ""

    def to_dict(self) -> dict:
        return {
            "version": self.version,
            "columns": [
                {"column_type": c.column_type, "position": c.position, "name": c.name}
                for c in self.columns
            ],
            "labels": [
                {
                    "name": label.name,
                    "applies_in_role": label.applies_in_role,
                    "removes_in_role": label.removes_in_role,
                    "gated_by_roles": list(label.gated_by_roles),
                    "description": label.description,
                }
                for label in self.labels
            ],
            "role_orchestration": [
                {
                    "role": r.role,
                    "pick_strategy": list(r.pick_strategy),
                    "emits": list(r.emits),
                    "terminal_actions": list(r.terminal_actions),
                }
                for r in self.role_orchestration
            ],
            "prose_overview": self.prose_overview,
        }


def _stages(config: dict) -> list[dict]:
    stages = config.get("stages")
    return [s for s in stages if isinstance(s, dict)] if isinstance(stages, list) else []


def _filter_labels(filters: dict, key: str) -> list[str]:
    """Return the label(s) a discover filter key names (string or list)."""
    value = filters.get(key)
    if isinstance(value, str) and value:
        return [value]
    if isinstance(value, list):
        return [v for v in value if isinstance(v, str) and v]
    return []


def _ordered_stages(config: dict) -> list[dict]:
    """Stages ordered by scheduling.priority_order, then any stage not listed
    in declaration order (matches the scheduler's walk)."""
    stages = _stages(config)
    by_role = {s.get("role"): s for s in stages if isinstance(s.get("role"), str)}
    scheduling = config.get("scheduling")
    priority = (
        scheduling.get("priority_order") if isinstance(scheduling, dict) else None
    )
    ordered: list[dict] = []
    seen: set[str] = set()
    if isinstance(priority, list):
        for role in priority:
            if isinstance(role, str) and role in by_role and role not in seen:
                ordered.append(by_role[role])
                seen.add(role)
    for s in stages:
        role = s.get("role")
        if role not in seen:
            ordered.append(s)
            if isinstance(role, str):
                seen.add(role)
    return ordered


def _lifecycle_label_steps(stage: dict) -> list[tuple[str, str]]:
    """(kind, label) for every apply_label/remove_label lifecycle step."""
    out: list[tuple[str, str]] = []
    for step in stage.get("lifecycle") or []:
        if not isinstance(step, dict):
            continue
        kind = step.get("kind")
        if kind in ("apply_label", "remove_label"):
            params = step.get("params") if isinstance(step.get("params"), dict) else {}
            label = params.get("label")
            if isinstance(label, str) and label:
                out.append((kind, label))
    return out


def _label_description(
    name: str, applies: str | None, removes: str | None, gated_by: list[str]
) -> str:
    """Human prose for a label, assembled from its role interactions."""
    parts: list[str] = []
    if applies:
        parts.append(f"applied by {applies}")
    if removes:
        parts.append(f"removed by {removes}")
    if gated_by:
        parts.append(f"gates {', '.join(gated_by)}")
    if not parts:
        return f"{name}: pre-seeded; no default role applies or gates it."
    return f"{name}: " + "; ".join(parts) + "."


def build_setup_contract(config: dict) -> SetupContract:
    """Derive a SetupContract from a live pipeline_config.

    Walks every stage to catalog the columns it discovers in, the label
    vocabulary (filters + lifecycle apply/remove), and the role orchestration
    (pick strategy + decision effects), in scheduler priority order.
    """
    # Reuse the proven label/column extraction in context_assembly so the
    # contract and the rendered "PIPELINE OVERVIEW" prompt can never disagree.
    from app.services.agents.context_assembly import _render_role_overview_row

    ordered = _ordered_stages(config)

    # --- Columns: distinct discover.column_type, laid out in canonical board
    # order (backlog→done), NOT scheduler priority — the position is consumed by
    # a setup agent's create_column call and a board reads left-to-right.
    discovered_cols: set[str] = set()
    for stage in ordered:
        discover = stage.get("discover") if isinstance(stage.get("discover"), dict) else {}
        col_type = discover.get("column_type")
        if isinstance(col_type, str) and col_type:
            discovered_cols.add(col_type)

    ordered_cols = [c for c in _COLUMN_LAYOUT_ORDER if c in discovered_cols]
    ordered_cols += sorted(discovered_cols - set(_COLUMN_LAYOUT_ORDER))
    columns = [
        ColumnSpec(
            column_type=col_type,
            position=pos,
            name=col_type.replace("_", " ").title(),
        )
        for pos, col_type in enumerate(ordered_cols)
    ]

    # --- Labels: union of every filter-referenced + lifecycle apply/remove label.
    applies_by_label: dict[str, str] = {}
    removes_by_label: dict[str, str] = {}
    gated_by_label: dict[str, list[str]] = {}
    label_order: list[str] = []

    def _note_label(label: str) -> None:
        if label not in gated_by_label:
            gated_by_label[label] = []
            label_order.append(label)

    for stage in ordered:
        role = stage.get("role")
        discover = stage.get("discover") if isinstance(stage.get("discover"), dict) else {}
        filters = discover.get("filters") if isinstance(discover.get("filters"), dict) else {}
        for key in _LABEL_FILTER_KEYS:
            for label in _filter_labels(filters, key):
                _note_label(label)
                if isinstance(role, str) and role not in gated_by_label[label]:
                    gated_by_label[label].append(role)
        for kind, label in _lifecycle_label_steps(stage):
            _note_label(label)
            if isinstance(role, str):
                if kind == "apply_label":
                    applies_by_label.setdefault(label, role)
                else:
                    removes_by_label.setdefault(label, role)

    labels: list[LabelGate] = []
    for name in sorted(label_order):
        applies = applies_by_label.get(name)
        removes = removes_by_label.get(name)
        gated = gated_by_label.get(name, [])
        labels.append(
            LabelGate(
                name=name,
                applies_in_role=applies,
                removes_in_role=removes,
                gated_by_roles=gated,
                description=_label_description(name, applies, removes, gated),
            )
        )

    # --- Role orchestration: pick strategy + decision effects, scheduler order.
    role_orchestration = [
        _build_role_orchestration(stage)
        for stage in ordered
        if isinstance(stage.get("role"), str)
    ]

    # --- Prose overview: reuse the rendered pipeline overview (single source).
    prose_labels: set[str] = set()
    rows = [
        _render_role_overview_row(s, prose_labels)
        for s in ordered
        if isinstance(s.get("role"), str)
    ]
    prose_overview = "PIPELINE OVERVIEW (all roles)\n\n" + "\n".join(rows)
    if prose_labels:
        prose_overview += "\n\nLabels in play: " + ", ".join(sorted(prose_labels))
    prose_overview += "\n\n" + _BOARD_COMPOSITION_RULE

    return SetupContract(
        version=1,
        columns=columns,
        labels=labels,
        role_orchestration=role_orchestration,
        prose_overview=prose_overview,
    )


def _build_role_orchestration(stage: dict) -> RoleOrchestration:
    from app.services.agents.context_assembly import _branch_effect, _llm_step

    role = stage.get("role") or "?"
    discover = stage.get("discover") if isinstance(stage.get("discover"), dict) else {}
    filters = discover.get("filters") if isinstance(discover.get("filters"), dict) else {}

    pick: list[str] = []
    col_type = discover.get("column_type")
    if col_type:
        pick.append(f"{col_type} column")
    for label in _filter_labels(filters, "require_label") + _filter_labels(
        filters, "include_label"
    ) + _filter_labels(filters, "label"):
        pick.append(f"requires label '{label}'")
    excluded = _filter_labels(filters, "exclude_label")
    if excluded:
        pick.append("excludes label" + ("s " if len(excluded) > 1 else " ")
                    + ", ".join(f"'{x}'" for x in excluded))
    if filters.get("require_git_repo"):
        pick.append("requires git repo")
    if filters.get("require_pr_url"):
        pick.append("requires PR url")
    if filters.get("all_dependencies_done"):
        pick.append("all dependencies done")
    if filters.get("no_other_card_in_flight"):
        pick.append("no other card in flight")

    emits: list[str] = []
    llm_step = _llm_step(stage)
    if llm_step:
        branches = llm_step.get("branches")
        if isinstance(branches, dict):
            for decision, target in branches.items():
                effect = _branch_effect(stage, target) if isinstance(target, str) else ""
                emits.append(f"{decision} → {effect}" if effect else str(decision))

    # Terminal actions: the card-moving / labeling effects reachable from the
    # stage's lifecycle terminals (reuse _branch_effect on terminal chains).
    terminal_actions = _terminal_actions(stage)

    return RoleOrchestration(
        role=role,
        pick_strategy=pick,
        emits=emits,
        terminal_actions=terminal_actions,
    )


def _terminal_actions(stage: dict) -> list[str]:
    """The card-visible effects (moves, labels) a stage's lifecycle performs.

    Collected from apply_label/remove_label/move_card lifecycle steps so a
    setup agent can see what each role does to a card on completion.
    """
    actions: list[str] = []
    for step in stage.get("lifecycle") or []:
        if not isinstance(step, dict):
            continue
        kind = step.get("kind")
        params = step.get("params") if isinstance(step.get("params"), dict) else {}
        if kind == "move_card":
            dest = params.get("to_column_type") or params.get("to_column")
            if dest:
                actions.append(f"moves card to {dest}")
        elif kind == "apply_label":
            label = params.get("label")
            if label:
                actions.append(f"applies label '{label}'")
        elif kind == "remove_label":
            label = params.get("label")
            if label:
                actions.append(f"removes label '{label}'")
    # De-dup while preserving order (labels can appear on multiple branches).
    seen: set[str] = set()
    out: list[str] = []
    for a in actions:
        if a not in seen:
            seen.add(a)
            out.append(a)
    return out
