# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Does this template fit THIS board? (spec f52328b3 §4)

An operator picking a loop template is really asking two questions, and this
module answers both in one read-only pass:

  "what will break?"   -> `checks`, one per setup-contract requirement, each
                          carrying the evidence that decided it
  "what do I type?"    -> `autofill`, slot values derived from board facts

Three rules earn their keep here:

1. A requirement is only ever `missing` when p2-02 can actually repair it.
   Owner decision Q9 limits repair to typed columns, a `loop_charter`
   definition stub, and a seed note — never git repos, never agents. Anything
   unrepairable degrades to `warn`, so the UI's "fix this" affordance and the
   report's severity never disagree.
2. Autofill OMITS what it cannot answer. An empty string is a value the
   renderer would substitute happily, producing a prompt that reads
   "integration branch: " and a run that lands nowhere.
3. Checks come back in contract order. The bind step renders this list
   verbatim, so a set-iteration order would reshuffle the operator's checklist
   between two identical requests.

Column TYPES, not names, decide every column check: `column_type` is what the
runner's pickup and completion logic reads, while "Done" is free text a human
picked. A name-matched check would greenlight a board the loop cannot advance.
"""

import uuid
from collections import Counter
from typing import Any

from sqlalchemy import select

from app.models.definitions.definition import Definition
from app.models.git.git_repo import GitRepo
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column, ColumnType
from app.models.notes.note import Note
from app.repositories.agents.team import TeamRepository
from app.services.completion_policy import _UNSET
from app.services.loop_template_render import TemplateContent

# The only definition key a fix can author, because it is the only one whose
# content the template's own setup contract already describes (Q9).
STUBBABLE_DEFINITION_KEY = "loop_charter"

# Fix-id prefixes. Each id encodes its own argument (`create_column:done`) so
# applying needs no second lookup against the report that produced it.
_CREATE_COLUMN_PREFIX = "create_column:"
_DEFINITION_STUB_PREFIX = "definition_stub:"
_SEED_NOTE_FIX = "seed_note_skeleton"

# English by owner Direction — the UI may rename later. Derived per type so a
# board repaired for two types does not end up with two columns of one name.
_COLUMN_NAME_BY_TYPE = {
    ColumnType.backlog: "Backlog",
    ColumnType.active: "Active",
    ColumnType.review: "Review",
    ColumnType.done: "Done",
    ColumnType.blocked: "Blocked",
}

_SEED_NOTE_SECTIONS = (
    "Cards & priority order",
    "Dependency edges",
    "Baselines",
    "Run constraints",
)

# Slots whose value is a naming CONVENTION derived from the run label rather
# than a fact read off the board — surfaced as `suggested` so the bind form can
# present them as editable guesses instead of established truth.
_SUGGESTED_FROM_RUN_LABEL = {
    "INTEGRATION_BRANCH": lambda label: f"{label}-integration",
    "CARD_BRANCH_PREFIX": lambda label: f"{label}/",
}


def _check(
    check_id: str, requirement: str, status: str, evidence: str, fix_id: str | None = None
) -> dict[str, Any]:
    return {
        "id": check_id,
        "requirement": requirement,
        "status": status,
        "evidence": evidence,
        "fix_id": fix_id,
    }


class LoopTemplateFitService:
    """Read-only board probe. Holds a session but never writes through it."""

    def __init__(self, db):
        self.db = db

    async def check(
        self,
        board_id: uuid.UUID,
        workspace_id: uuid.UUID,
        content: TemplateContent,
        *,
        slot_values: dict[str, Any] | None = None,
        loop_config: dict[str, Any] | None = None,
        policy_override=_UNSET,
    ) -> dict[str, Any]:
        board = await self._board_or_404(board_id, workspace_id)
        from app.services.completion_policy import CompletionPolicyService
        from app.services.loop_template_completion import content_for_policy

        policy = await CompletionPolicyService(self.db).effective_policy(board, override=policy_override)
        content = content_for_policy(content, policy)
        contract = content.setup_contract or {}

        facts = await self._board_facts(board)
        proposed = slot_values or {}
        if "RUN_LABEL" in proposed:
            proposed_label = proposed["RUN_LABEL"]
            run_label = proposed_label if isinstance(proposed_label, str) else None
            run_label_source = "proposed"
        elif loop_config is not None and "completion_query" in loop_config:
            query = loop_config.get("completion_query")
            run_label = query.get("label") if isinstance(query, dict) else None
            run_label_source = "proposed_completion_query"
        else:
            run_label, run_label_source = self._resolve_run_label(board, facts["cards"])
        if "SEED_NOTE_ID" in proposed:
            seed_note = next(
                (note for note in facts["notes"] if note.pinned and str(note.id) == str(proposed["SEED_NOTE_ID"])),
                None,
            )
        else:
            seed_note = self._seed_note(facts["notes"], run_label)

        autofill = self._autofill(
            content,
            run_label=run_label,
            run_label_source=run_label_source,
            repo=facts["repo"],
            seed_note=seed_note,
            definition_keys=self._offered_definition_keys(facts["definition"], contract),
        )

        checks = self._checks(
                contract,
                columns=facts["columns"],
                cards=facts["cards"],
                definition=facts["definition"],
                repo=facts["repo"],
                agent_count=facts["agent_count"],
                run_label=run_label,
                seed_note=seed_note,
            )
        if "SEED_NOTE_ID" in proposed:
            checks.append(_check(
                "seed_note_identity", "the selected pinned board note",
                "ok" if seed_note else "missing",
                seed_note.title if seed_note else "selected seed note is unavailable or not pinned on this board",
            ))
        configured = loop_config if loop_config is not None else (board.loop_config or {})
        query = configured.get("completion_query")
        configured_label = query.get("label") if isinstance(query, dict) else None
        from app.services.kanban.loop_binding import LoopBindingService
        from app.services.loop_template_completion import rehearsal_findings
        from app.services.loop_template_render import preview

        rendered = preview(content, proposed, autofill)
        binding = await LoopBindingService(self.db).get_binding(board_id)
        _, findings = rehearsal_findings(content, proposed, rendered, board.loop_config,
            loop_config, policy, rebind=binding is not None)
        if slot_values is None and loop_config is None and policy is None:
            findings = []
        for check_id, codes in (
            ("branch_constraints", {"branch_constraint_conflict", "invalid_branch_constraint"}),
            ("completion_policy", {"completion_policy_conflict"}),
            ("loop_config", None),
        ):
            matching = [f for f in findings if (f["code"] in codes if codes else
                f["code"] not in {"branch_constraint_conflict", "invalid_branch_constraint", "completion_policy_conflict"})]
            if matching:
                checks.append(_check(check_id, check_id.replace("_", " "), "warn",
                    "; ".join(f["message"] for f in matching)))
        return {
            "checks": checks,
            "findings": findings,
            "autofill": autofill,
            "board_frozen": bool(board.is_frozen),
            "completion_query_matches_run_label": (
                (autofill.get("RUN_LABEL") or {}).get("value") == configured_label if configured_label else None
            ),
        }

    # --- board facts ----------------------------------------------------

    async def _board_or_404(self, board_id: uuid.UUID, workspace_id: uuid.UUID) -> Board:
        board = await self.db.get(Board, board_id)
        if board is None or board.workspace_id != workspace_id:
            from app.exceptions import ResourceNotFoundError

            raise ResourceNotFoundError("Board not found")
        return board

    async def _board_facts(self, board: Board) -> dict[str, Any]:
        """Every board read the report needs, one query each (never per check).

        Cards arrive joined to their column TYPE because both the run-label
        autofill and the run-label check must exclude done-column cards, and a
        second pass to classify them would double the row count.
        """
        columns = list(
            await self.db.scalars(
                select(Column).where(Column.board_id == board.id)
            )
        )
        card_rows = (
            await self.db.execute(
                select(Card.labels, Column.column_type)
                .join(Column, Column.id == Card.column_id)
                .where(Card.board_id == board.id)
            )
        ).all()
        notes = list(
            await self.db.scalars(select(Note).where(Note.board_id == board.id))
        )
        repo = (
            await self.db.scalars(
                select(GitRepo)
                .where(GitRepo.board_id == board.id)
                .order_by(GitRepo.created_at, GitRepo.id)
            )
        ).first()
        definition = (
            await self.db.scalars(
                select(Definition).where(Definition.board_id == board.id)
            )
        ).first()

        # The same resolver get_loop_status uses for bound_agent_count — agents
        # reach a board through TEAMS, so counting anything on the board row
        # itself would always report zero.
        bound_agents = await TeamRepository(self.db).list_bound_agents_by_board(
            board.id
        )

        return {
            "columns": columns,
            "cards": card_rows,
            "notes": notes,
            "repo": repo,
            "definition": definition,
            "agent_count": len(bound_agents),
        }

    # --- run label ------------------------------------------------------

    @staticmethod
    def _resolve_run_label(board: Board, cards) -> tuple[str | None, str | None]:
        """completion_query first, then the busiest live label.

        completion_query.label wins because it is literally what the harness
        queries to decide a run is over; a board label that merely happens to
        be popular is a guess by comparison.
        """
        configured = ((board.loop_config or {}).get("completion_query") or {}).get(
            "label"
        )
        if configured:
            return configured, "completion_query"

        # Counted in Python, not SQL: `labels` is a JSON array and the
        # containment operators that would push this into the database are
        # Postgres-only, so a SQL count would pass on SQLite and fail in prod.
        tally = Counter(
            label
            for labels, column_type in cards
            if column_type != ColumnType.done
            for label in (labels or [])
        )
        if not tally:
            return None, None
        # Ties broken by name so two equally-popular labels do not alternate
        # between requests.
        best = min(tally.items(), key=lambda item: (-item[1], item[0]))
        return best[0], "board_labels"

    @staticmethod
    def _seed_note(notes: list[Note], run_label: str | None) -> Note | None:
        """The pinned note whose title names the run. Unpinned notes are drafts
        and scratch; the contract asks for a pinned seed specifically."""
        if not run_label:
            return None
        needle = run_label.lower()
        return next(
            (n for n in notes if n.pinned and needle in (n.title or "").lower()),
            None,
        )

    @staticmethod
    def _offered_definition_keys(
        definition: Definition | None, contract: dict[str, Any]
    ) -> list[str]:
        """Contract-wanted keys the board actually has — the intersection, so
        the slot advertises what the prompts can really cite."""
        present = set((definition.content if definition else None) or {})
        return [key for key in contract.get("definition_keys", []) if key in present]

    # --- checks ---------------------------------------------------------

    def _checks(
        self,
        contract: dict[str, Any],
        *,
        columns: list[Column],
        cards,
        definition: Definition | None,
        repo: GitRepo | None,
        agent_count: int,
        run_label: str | None,
        seed_note: Note | None,
    ) -> list[dict[str, Any]]:
        checks: list[dict[str, Any]] = []
        # Boards legitimately carry two columns of one type ("Done" and
        # "Archive" both typed `done`). The LEFTMOST wins, so the evidence
        # string names the column an operator would point at, and two identical
        # requests cannot disagree about which one they meant.
        by_type: dict[ColumnType, Column] = {}
        for column in sorted(columns, key=lambda c: (c.position, c.name)):
            if column.column_type is not None:
                by_type.setdefault(column.column_type, column)

        for type_name in contract.get("required_column_types", []):
            column = by_type.get(ColumnType(type_name))
            checks.append(
                _check(
                    f"column:{type_name}",
                    f"a {type_name}-typed column",
                    "ok" if column else "missing",
                    column.name if column else f"no column is typed {type_name}",
                    None if column else f"create_column:{type_name}",
                )
            )

        for type_name in contract.get("optional_column_types", []):
            column = by_type.get(ColumnType(type_name))
            checks.append(
                _check(
                    f"column:{type_name}",
                    f"a {type_name}-typed column (optional)",
                    "ok" if column else "warn",
                    column.name if column else f"no column is typed {type_name}",
                )
            )

        if contract.get("requires_run_label"):
            live = (
                sum(
                    1
                    for labels, column_type in cards
                    if column_type != ColumnType.done and run_label in (labels or [])
                )
                if run_label
                else 0
            )
            checks.append(
                _check(
                    "run_label",
                    "a run label with work under it",
                    "ok" if live else "warn",
                    f"{live} non-done card(s) labelled {run_label}"
                    if run_label
                    else "no run label could be resolved",
                )
            )

        definition_content = (definition.content if definition else None) or {}
        for key in contract.get("definition_keys", []):
            present = key in definition_content
            stubbable = key == STUBBABLE_DEFINITION_KEY
            checks.append(
                _check(
                    f"definition:{key}",
                    f"definition.{key}",
                    "ok" if present else ("missing" if stubbable else "warn"),
                    "present" if present else "absent from the board definition",
                    None if present or not stubbable else f"definition_stub:{key}",
                )
            )

        for seed in contract.get("pinned_notes", []):
            # The skeleton fix titles the note after the run, so `_fix_seed_note`
            # refuses without a run label. That is knowable HERE — advertising a
            # repair the service will reject is a button that does nothing.
            fixable = seed_note is None and run_label is not None
            if seed_note is not None:
                evidence = seed_note.title
            elif run_label is None:
                evidence = (
                    "no run label to name the note after — set "
                    "completion_query.label or label a card"
                )
            else:
                evidence = "no pinned note names the run"
            checks.append(
                _check(
                    f"pinned_note:{seed}",
                    f"a pinned {seed} note naming the run",
                    "ok" if seed_note else "missing",
                    evidence,
                    _SEED_NOTE_FIX if fixable else None,
                )
            )

        if contract.get("git_repo_bound"):
            # No fix_id ever: binding a repo carries credentials and a remote,
            # which is an operator act, not a one-click repair (Q9).
            checks.append(
                _check(
                    "git_repo_bound",
                    "a git repository bound to the board",
                    "ok" if repo else "missing",
                    (repo.slug or repo.url) if repo else "no repository is bound",
                )
            )

        if contract.get("agent_bound_with_tools"):
            # A warn, not a missing: binding the agent later is a normal order
            # of operations, and WHICH tools it grants is out of scope here.
            checks.append(
                _check(
                    "agent_bound_with_tools",
                    "an agent bound to the board",
                    "ok" if agent_count else "warn",
                    f"{agent_count} agent(s) bound",
                )
            )

        if contract.get("dependencies_server_side"):
            checks.append(
                _check(
                    "dependencies_server_side",
                    "card ordering wired as server-side dependencies",
                    "ok",
                    "this platform computes dependency status server-side",
                )
            )

        return checks

    # --- autofill -------------------------------------------------------

    def _autofill(
        self,
        content: TemplateContent,
        *,
        run_label: str | None,
        run_label_source: str | None,
        repo: GitRepo | None,
        seed_note: Note | None,
        definition_keys: list[str],
    ) -> dict[str, dict[str, Any]]:
        """Sources -> {slot: {value, source}}, filtered to the real catalog.

        The catalog filter is the last step on purpose: sources stay ignorant
        of which template they are feeding, and no source can smuggle a field
        into the bind form that the template has no slot to render.
        """
        sources: dict[str, tuple[Any, str]] = {}

        if run_label:
            sources["RUN_LABEL"] = (run_label, run_label_source)
            for name, derive in _SUGGESTED_FROM_RUN_LABEL.items():
                sources[name] = (derive(run_label), "suggested")

        if repo is not None:
            provenance = f"git_repo:{repo.slug or str(repo.id)[:8]}"
            sources["REPO_URL"] = (repo.url, provenance)
            sources["DEFAULT_BRANCH"] = (repo.default_branch, provenance)
            if repo.integration_branch:
                # A declared branch is a fact and outranks the convention guess.
                sources["INTEGRATION_BRANCH"] = (repo.integration_branch, provenance)

        if seed_note is not None:
            sources["SEED_NOTE_TITLE"] = (seed_note.title, "pinned_note")
            sources["SEED_NOTE_ID"] = (str(seed_note.id), "pinned_note")

        if definition_keys:
            sources["DEFINITION_KEYS"] = (definition_keys, "definition")

        catalog = {slot.name for slot in content.slots}
        return {
            name: {"value": value, "source": source}
            for name, (value, source) in sources.items()
            if name in catalog and value not in (None, "")
        }

    # --- apply ----------------------------------------------------------

    async def apply(
        self,
        board_id: uuid.UUID,
        workspace_id: uuid.UUID,
        content: TemplateContent,
        fix_ids: list[str],
        actor_id: uuid.UUID,
    ) -> dict[str, Any]:
        """Run the requested one-click repairs, then re-report (spec §4, Q9).

        Ordering is deliberate and load-bearing:

        1. Validate EVERY id before acting. `get_db` commits the whole request,
           so a bogus id discovered halfway through would leave the earlier
           fixes committed with no way for the caller to know which landed.
        2. Check the freeze ONCE, up front. The per-fix services each raise
           `BoardFrozenError` on their own, which would surface as a partial
           application instead of a refusal.
        3. Each fix RE-CHECKS its own condition immediately before writing, so
           a stale report, a retry, and a double-click are all harmless.

        Fixes run through the ordinary services rather than the repositories,
        so activity rows and WS events are indistinguishable from an operator
        making the same three changes by hand.
        """
        board = await self._board_or_404(board_id, workspace_id)
        self._reject_unknown_fixes(fix_ids)
        if board.is_frozen:
            from app.exceptions import BoardFrozenError

            raise BoardFrozenError()

        applied = []
        for fix_id in fix_ids:
            applied.append(
                {
                    "fix_id": fix_id,
                    **await self._apply_one(
                        fix_id, board, workspace_id, content, actor_id
                    ),
                }
            )

        # Re-read the board's facts from scratch: `check` must observe the
        # writes just made, which is exactly what AC6 asks the caller to see.
        report = await self.check(board_id, workspace_id, content)
        return {**report, "applied": applied}

    @staticmethod
    def _reject_unknown_fixes(fix_ids: list[str]) -> None:
        """A fix id is only ever one this service authored. An unrecognised id
        is a caller bug (or a stale client), never a no-op to swallow."""
        unknown = [
            fix_id
            for fix_id in fix_ids
            if not (
                fix_id == _SEED_NOTE_FIX
                or fix_id.startswith(_CREATE_COLUMN_PREFIX)
                or fix_id.startswith(_DEFINITION_STUB_PREFIX)
            )
        ]
        if unknown:
            from app.exceptions import ValidationError

            raise ValidationError(
                f"Unknown fix id(s): {', '.join(unknown)}",
                error_code="unknown_fix",
            )

    async def _apply_one(
        self,
        fix_id: str,
        board: Board,
        workspace_id: uuid.UUID,
        content: TemplateContent,
        actor_id: uuid.UUID,
    ) -> dict[str, str]:
        if fix_id.startswith(_CREATE_COLUMN_PREFIX):
            return await self._fix_create_column(
                fix_id[len(_CREATE_COLUMN_PREFIX) :], board, workspace_id, actor_id
            )
        if fix_id.startswith(_DEFINITION_STUB_PREFIX):
            return await self._fix_definition_stub(
                fix_id[len(_DEFINITION_STUB_PREFIX) :],
                board,
                workspace_id,
                content,
                actor_id,
            )
        return await self._fix_seed_note(board, workspace_id, content, actor_id)

    async def _fix_create_column(
        self, type_name: str, board: Board, workspace_id: uuid.UUID, actor_id: uuid.UUID
    ) -> dict[str, str]:
        try:
            column_type = ColumnType(type_name)
        except ValueError:
            # "todo" and "in_progress" are column NAMES people use; typing a
            # column with one would leave it invisible to the runner's pickup.
            return {
                "outcome": "rejected",
                "detail": f"unknown column type {type_name!r}",
            }

        existing = (
            await self.db.scalars(
                select(Column).where(
                    Column.board_id == board.id, Column.column_type == column_type
                )
            )
        ).first()
        if existing is not None:
            return {
                "outcome": "skipped_already_satisfied",
                "detail": f"{existing.name} is already typed {type_name}",
            }

        from app.schemas.kanban.column import ColumnCreate
        from app.services.kanban.column import ColumnService

        name = _COLUMN_NAME_BY_TYPE[column_type]
        await ColumnService(self.db).create_column(
            board.id,
            ColumnCreate(name=name, column_type=type_name),
            workspace_id=workspace_id,
            actor_id=actor_id,
        )
        return {"outcome": "applied", "detail": f"created column {name!r}"}

    async def _fix_definition_stub(
        self,
        key: str,
        board: Board,
        workspace_id: uuid.UUID,
        content: TemplateContent,
        actor_id: uuid.UUID,
    ) -> dict[str, str]:
        if key != STUBBABLE_DEFINITION_KEY:
            # Only loop_charter has content the setup contract describes; any
            # other key would be invented rather than derived.
            return {"outcome": "rejected", "detail": f"{key} cannot be stubbed"}

        definition = (
            await self.db.scalars(
                select(Definition).where(Definition.board_id == board.id)
            )
        ).first()
        if key in ((definition.content if definition else None) or {}):
            return {
                "outcome": "skipped_already_satisfied",
                "detail": f"definition.{key} is already set",
            }

        from app.schemas.definitions.definition import DefinitionUpsert
        from app.services.definitions.definition import DefinitionService

        run_label, _ = self._resolve_run_label(
            board, await self._cards_with_column_type(board)
        )
        # Send ONLY this key: the upsert shallow-merges by top-level key, so
        # resending the rest would overwrite whatever the operator has written.
        await DefinitionService(self.db).upsert_definition(
            board.id,
            workspace_id,
            DefinitionUpsert(
                content={key: self._charter_stub(content, run_label, board)}
            ),
            actor_id,
        )
        return {"outcome": "applied", "detail": f"stubbed definition.{key}"}

    async def _fix_seed_note(
        self,
        board: Board,
        workspace_id: uuid.UUID,
        content: TemplateContent,
        actor_id: uuid.UUID,
    ) -> dict[str, str]:
        cards = await self._cards_with_column_type(board)
        run_label, _ = self._resolve_run_label(board, cards)
        if not run_label:
            # A seed note titled after nothing is worse than no note: the fit
            # check looks for the run's NAME in the title.
            return {"outcome": "rejected", "detail": "no run label"}

        notes = list(
            await self.db.scalars(select(Note).where(Note.board_id == board.id))
        )
        existing = self._seed_note(notes, run_label)
        if existing is not None:
            return {
                "outcome": "skipped_already_satisfied",
                "detail": f"{existing.title} already names the run",
            }

        from app.schemas.notes.note import NoteCreate
        from app.services.notes.note import NoteService

        live = sum(
            1
            for labels, column_type in cards
            if column_type != ColumnType.done and run_label in (labels or [])
        )
        title = f"{run_label} seed batch — {live} cards"
        await NoteService(self.db).create_note(
            workspace_id,
            NoteCreate(
                title=title,
                content=self._seed_note_body(run_label),
                pinned=True,
                board_id=board.id,
            ),
            actor_id,
            board_id=board.id,
        )
        return {"outcome": "applied", "detail": f"created pinned note {title!r}"}

    async def _cards_with_column_type(self, board: Board):
        return (
            await self.db.execute(
                select(Card.labels, Column.column_type)
                .join(Column, Column.id == Card.column_id)
                .where(Card.board_id == board.id)
            )
        ).all()

    @staticmethod
    def _charter_stub(
        content: TemplateContent, run_label: str | None, board: Board
    ) -> dict[str, Any]:
        """A charter the operator EDITS, never one they have to invent.

        Every field carries either a fact derived from the board or an explicit
        `<fill>` marker. An empty dict would satisfy the fit check's presence
        test while leaving the loop with no scope and no stop condition.
        """
        contract = content.setup_contract or {}
        label = run_label or "<fill>"
        branch = f"{run_label}-integration" if run_label else "<fill>-integration"
        return {
            # The contract's own `notes` are the template author's words about
            # what the loop needs — the closest thing to a charter that already
            # exists. Absent those, an explicit placeholder, never silence.
            "what": contract.get("notes")
            or "What this loop is for — replace with the run's actual objective.",
            "card_scope": f"Cards labelled {label}.",
            "branch_policy": (
                f"Work lands on {branch}; never commit to the default branch."
            ),
            "test_gates": "<fill>",
            "hard_floors": [],
            "memory_protocol": (
                "The board is the only durable memory: write a run log note per "
                "iteration and keep card status current."
            ),
            "stop_contract": (
                f"The run is complete when no {label} card remains outside a "
                "done-typed column."
            ),
        }

    @staticmethod
    def _seed_note_body(run_label: str) -> str:
        """Markdown in, ProseMirror out — NoteCreate normalizes on write."""
        sections = "\n\n".join(
            f"## {section}\n\n<fill>" for section in _SEED_NOTE_SECTIONS
        )
        return f"Seed batch for **{run_label}**.\n\n{sections}\n"

    @staticmethod
    def _completion_query_match(board: Board, autofill: dict) -> bool | None:
        """Whether autofill's run label agrees with the board's completion
        query. `None` means the board has no completion_query to compare —
        distinct from False, which means they genuinely differ."""
        configured = ((board.loop_config or {}).get("completion_query") or {}).get(
            "label"
        )
        if not configured:
            return None
        return (autofill.get("RUN_LABEL") or {}).get("value") == configured
