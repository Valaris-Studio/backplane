# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Fit check — what this board HAS vs what a template's setup contract NEEDS.

The read-only half of "adjust to the current board" (spec f52328b3 §4). It
answers two questions in one pass, and writes nothing:

  checks    one per setup-contract requirement, each ok | missing | warn, with
            the EVIDENCE that decided it and a `fix_id` when p2-02 can repair
            it. Only three requirements are repairable by owner decision Q9
            (typed columns, a loop_charter definition stub, a seed note) — git
            repos and agents are never created on an operator's behalf.
  autofill  slot values derivable from board facts, so the bind form opens
            pre-filled instead of blank. A slot the board cannot answer is
            OMITTED rather than filled with "", because an empty string is a
            value the renderer would happily substitute.

The report is deterministic — checks come back in contract order — so the UI
and these tests can assert on a stable sequence.
"""

from datetime import datetime

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.definitions.definition import Definition
from app.models.git.git_repo import GitProvider, GitRepo
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column, ColumnType
from app.models.notes.note import Note
from app.models.user import User
from app.models.workspace import Workspace
from app.services.loop_template_fit import LoopTemplateFitService
from app.services.loop_template_render import SlotSpec, TemplateContent

pytestmark = pytest.mark.anyio


# The contract the Coding Loop actually ships (services/loop_templates/
# coding_loop_v2.py), trimmed to what fit reads. Mirroring the REAL key names
# (`required_column_types`, not the `columns_by_type` the card's prose invented)
# is the point: a fixture that agreed with the card would pass while the
# service read nothing.
CONTRACT = {
    "required_column_types": ["active", "done"],
    "optional_column_types": ["backlog", "review"],
    "requires_run_label": True,
    "definition_keys": ["loop_charter", "loop_run_history"],
    "pinned_notes": ["seed"],
    "git_repo_bound": True,
    "agent_bound_with_tools": True,
    "dependencies_server_side": True,
}

# Slot names the autofill sources target. Deliberately a SUBSET of the real
# 58-slot catalog plus one slot no source can fill (UNFILLABLE), so the
# "omit what you cannot answer" rule has something to omit.
SLOTS = [
    SlotSpec(name="RUN_LABEL", kind="scalar", required=True),
    SlotSpec(name="REPO_URL", kind="scalar"),
    SlotSpec(name="DEFAULT_BRANCH", kind="scalar"),
    SlotSpec(name="INTEGRATION_BRANCH", kind="scalar"),
    SlotSpec(name="CARD_BRANCH_PREFIX", kind="scalar"),
    SlotSpec(name="SEED_NOTE_TITLE", kind="scalar"),
    SlotSpec(name="SEED_NOTE_ID", kind="scalar"),
    SlotSpec(name="BASELINES", kind="block"),
    SlotSpec(name="UNFILLABLE", kind="scalar"),
]


def _content(**overrides) -> TemplateContent:
    return TemplateContent(
        system_prompt="Run <<RUN_LABEL>> on <<REPO_URL>>.",
        loop_prompt="Advance <<RUN_LABEL>>.",
        slots=overrides.pop("slots", SLOTS),
        setup_contract=overrides.pop("setup_contract", dict(CONTRACT)),
        **overrides,
    )


async def _column(
    db: AsyncSession, board: Board, name: str, column_type: ColumnType | None
) -> Column:
    column = Column(
        board_id=board.id,
        name=name,
        position=1024.0,
        color="#6b7280",
        column_type=column_type,
    )
    db.add(column)
    await db.flush()
    return column


async def _card(
    db: AsyncSession, board: Board, column: Column, user: User, *, labels: list[str]
) -> Card:
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title="A card",
        position=1024.0,
        created_by=user.id,
        labels=labels,
    )
    db.add(card)
    await db.flush()
    return card


async def _note(db: AsyncSession, ws: Workspace, board: Board, user: User, title: str,
                *, pinned: bool = True) -> Note:
    note = Note(
        workspace_id=ws.id,
        board_id=board.id,
        title=title,
        content="",
        pinned=pinned,
        created_by=user.id,
    )
    db.add(note)
    await db.flush()
    return note


async def _definition(
    db: AsyncSession, ws: Workspace, board: Board, user: User, content: dict
) -> Definition:
    definition = Definition(
        board_id=board.id,
        workspace_id=ws.id,
        scope="scope",
        content=content,
        updated_by=user.id,
    )
    db.add(definition)
    await db.flush()
    return definition


async def _repo(
    db: AsyncSession, ws: Workspace, board: Board, user: User, **overrides
) -> GitRepo:
    repo = GitRepo(
        board_id=board.id,
        workspace_id=ws.id,
        name=overrides.pop("name", "Test Repo"),
        slug=overrides.pop("slug", "test-repo"),
        url=overrides.pop("url", "https://github.com/valaris/test-repo"),
        provider=GitProvider.github,
        default_branch=overrides.pop("default_branch", "main"),
        description="",
        added_by=user.id,
        **overrides,
    )
    db.add(repo)
    await db.flush()
    return repo


async def _fully_equipped(
    db: AsyncSession, ws: Workspace, board: Board, user: User
) -> None:
    """A board that satisfies every repairable requirement in the contract."""
    backlog = await _column(db, board, "To Do", ColumnType.backlog)
    await _column(db, board, "In Progress", ColumnType.active)
    await _column(db, board, "Review", ColumnType.review)
    await _column(db, board, "Done", ColumnType.done)
    await _card(db, board, backlog, user, labels=["loop-8"])
    await _repo(db, ws, board, user)
    await _note(db, ws, board, user, "Loop-8 seed batch — 37 cards")
    await _definition(
        db, ws, board, user, {"loop_charter": "ship it", "loop_run_history": []}
    )
    board.loop_config = {"completion_query": {"label": "loop-8"}}
    await db.flush()


def _by_id(report: dict) -> dict:
    return {check["id"]: check for check in report["checks"]}


async def test_fit_all_ok_fixture(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """AC1: the equipped board reports every required check ok and pre-fills
    the slots the board can answer."""
    await _fully_equipped(db_session, test_workspace, test_board, test_user)

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    checks = _by_id(report)
    assert checks["column:active"]["status"] == "ok"
    assert checks["column:active"]["evidence"] == "In Progress"
    assert checks["column:done"]["status"] == "ok"
    assert checks["column:backlog"]["status"] == "ok"
    assert checks["column:review"]["status"] == "ok"
    assert checks["run_label"]["status"] == "ok"
    assert checks["definition:loop_charter"]["status"] == "ok"
    assert checks["pinned_note:seed"]["status"] == "ok"
    assert checks["git_repo_bound"]["status"] == "ok"
    # Informational, and always satisfied: this platform computes dependency
    # status server-side by construction, so it can never be an operator's
    # to-do. Reporting it as warn would put a permanent yellow on every board.
    assert checks["dependencies_server_side"]["status"] == "ok"
    assert checks["dependencies_server_side"]["fix_id"] is None
    assert all(c["fix_id"] is None for c in report["checks"] if c["status"] == "ok")

    autofill = report["autofill"]
    assert autofill["RUN_LABEL"] == {"value": "loop-8", "source": "completion_query"}
    assert autofill["REPO_URL"]["value"] == "https://github.com/valaris/test-repo"
    assert autofill["REPO_URL"]["source"] == "git_repo:test-repo"
    assert autofill["DEFAULT_BRANCH"]["value"] == "main"
    assert autofill["INTEGRATION_BRANCH"] == {
        "value": "loop-8-integration",
        "source": "suggested",
    }
    assert autofill["CARD_BRANCH_PREFIX"] == {"value": "loop-8/", "source": "suggested"}
    assert autofill["SEED_NOTE_TITLE"]["value"] == "Loop-8 seed batch — 37 cards"
    assert autofill["SEED_NOTE_TITLE"]["source"] == "pinned_note"
    assert report["completion_query_matches_run_label"] is True
    assert report["board_frozen"] is False


async def test_fit_checks_are_ordered_by_contract(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """Determinism is a contract, not a nicety: the UI renders this list in
    order and every other test here asserts against it."""
    await _fully_equipped(db_session, test_workspace, test_board, test_user)

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    assert [c["id"] for c in report["checks"]] == [
        "column:active",
        "column:done",
        "column:backlog",
        "column:review",
        "run_label",
        "definition:loop_charter",
        "definition:loop_run_history",
        "pinned_note:seed",
        "git_repo_bound",
        "agent_bound_with_tools",
        "dependencies_server_side",
    ]


async def test_fit_missing_done_column_has_fix_id(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """AC2: a required column type the board lacks is repairable, and the
    fix_id names the TYPE so p2-02 needs no second lookup."""
    await _column(db_session, test_board, "In Progress", ColumnType.active)

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    done = _by_id(report)["column:done"]
    assert done["status"] == "missing"
    assert done["fix_id"] == "create_column:done"
    # The active column IS present — the missing verdict must be per-type, not
    # a blanket "columns are wrong".
    assert _by_id(report)["column:active"]["status"] == "ok"


async def test_fit_optional_column_missing_warns_without_a_fix(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """An optional column type is advisory: it must never present itself as
    something the operator has to repair before binding."""
    await _column(db_session, test_board, "In Progress", ColumnType.active)
    await _column(db_session, test_board, "Done", ColumnType.done)

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    review = _by_id(report)["column:review"]
    assert review["status"] == "warn"
    assert review["fix_id"] is None


async def test_fit_untyped_column_never_satisfies_a_type(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """A human scratchpad column carries no column_type. Matching on NAME
    ("Done") instead of type would report a board loop-ready that the runner
    cannot actually advance a card on."""
    await _column(db_session, test_board, "In Progress", ColumnType.active)
    await _column(db_session, test_board, "Done", None)

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    assert _by_id(report)["column:done"]["status"] == "missing"


async def test_fit_duplicate_typed_columns_report_the_leftmost(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """Two columns of one type is a normal board ("Done" plus "Archive", both
    typed done). The evidence must name the column an operator would point at
    — and must not vary between two identical requests."""
    await _column(db_session, test_board, "In Progress", ColumnType.active)
    archive = await _column(db_session, test_board, "Archive", ColumnType.done)
    done = await _column(db_session, test_board, "Done", ColumnType.done)
    done.position = 100.0
    archive.position = 900.0
    await db_session.flush()

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    check = _by_id(report)["column:done"]
    assert check["status"] == "ok"
    assert check["evidence"] == "Done"


async def test_fit_missing_loop_charter_stub_fix(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """AC2: loop_charter is the ONE definition key p2-02 can stub (Q9); any
    other missing key is a warn the operator must author themselves."""
    await _definition(
        db_session, test_workspace, test_board, test_user, {"tech_stack": ["Python"]}
    )

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    checks = _by_id(report)
    assert checks["definition:loop_charter"]["status"] == "missing"
    assert checks["definition:loop_charter"]["fix_id"] == "definition_stub:loop_charter"
    assert checks["definition:loop_run_history"]["status"] == "warn"
    assert checks["definition:loop_run_history"]["fix_id"] is None


async def test_fit_absent_definition_row_is_not_a_crash(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """A board with no definition AT ALL is the common pre-setup case; it must
    read as missing keys, not as an unhandled None."""
    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    assert _by_id(report)["definition:loop_charter"]["status"] == "missing"


async def test_fit_git_repo_missing_no_fix(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """AC2: a missing repo is reported but never repaired — binding a repo is
    an operator act with credentials attached (Q9)."""
    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    repo_check = _by_id(report)["git_repo_bound"]
    assert repo_check["status"] == "missing"
    assert repo_check["fix_id"] is None
    # ...and nothing repo-derived gets invented out of thin air.
    assert "REPO_URL" not in report["autofill"]
    assert "DEFAULT_BRANCH" not in report["autofill"]


async def test_fit_agent_check_warns_and_is_never_repairable(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """No agent bound is a warn, not a missing: an unbound board is still a
    legitimate thing to bind a template to (the agent comes later)."""
    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    agent_check = _by_id(report)["agent_bound_with_tools"]
    assert agent_check["status"] == "warn"
    assert agent_check["fix_id"] is None


async def test_autofill_run_label_from_completion_query(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """completion_query.label is the AUTHORITATIVE run label — it is what the
    harness itself queries — so it must beat a more populous board label."""
    column = await _column(db_session, test_board, "To Do", ColumnType.backlog)
    for _ in range(5):
        await _card(db_session, test_board, column, test_user, labels=["popular"])
    test_board.loop_config = {"completion_query": {"label": "authoritative"}}
    await db_session.flush()

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    assert report["autofill"]["RUN_LABEL"] == {
        "value": "authoritative",
        "source": "completion_query",
    }


async def test_autofill_run_label_from_dominant_label(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """AC3: with no completion_query, the label carried by the most non-done
    cards is the board's de-facto run label."""
    backlog = await _column(db_session, test_board, "To Do", ColumnType.backlog)
    for _ in range(3):
        await _card(db_session, test_board, backlog, test_user, labels=["foo"])
    await _card(db_session, test_board, backlog, test_user, labels=["bar"])

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    assert report["autofill"]["RUN_LABEL"] == {
        "value": "foo",
        "source": "board_labels",
    }
    assert report["completion_query_matches_run_label"] is None


async def test_autofill_dominant_label_ignores_done_cards(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """A finished run's label is the WORST guess for the next run: it is the
    one label guaranteed to have no work left under it."""
    backlog = await _column(db_session, test_board, "To Do", ColumnType.backlog)
    done = await _column(db_session, test_board, "Done", ColumnType.done)
    for _ in range(4):
        await _card(db_session, test_board, done, test_user, labels=["finished"])
    await _card(db_session, test_board, backlog, test_user, labels=["current"])

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    assert report["autofill"]["RUN_LABEL"]["value"] == "current"


async def test_run_label_check_warns_when_no_card_carries_it(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """A completion_query label with zero live cards under it means the loop
    would report itself complete on iteration 1."""
    backlog = await _column(db_session, test_board, "To Do", ColumnType.backlog)
    await _card(db_session, test_board, backlog, test_user, labels=["something-else"])
    test_board.loop_config = {"completion_query": {"label": "loop-8"}}
    await db_session.flush()

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    run_label = _by_id(report)["run_label"]
    assert run_label["status"] == "warn"
    assert run_label["fix_id"] is None
    # The autofill still resolves — the value is known, it just has no work yet.
    assert report["autofill"]["RUN_LABEL"]["value"] == "loop-8"


async def test_run_label_check_ignores_cards_already_done(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """A completed run is the check's whole point: every card labelled loop-8
    sits in Done, so binding this template would start a loop that reports
    itself finished on iteration 1. Counting done cards would call that ok."""
    backlog = await _column(db_session, test_board, "To Do", ColumnType.backlog)
    done = await _column(db_session, test_board, "Done", ColumnType.done)
    for _ in range(3):
        await _card(db_session, test_board, done, test_user, labels=["loop-8"])
    await _card(db_session, test_board, backlog, test_user, labels=["unrelated"])
    test_board.loop_config = {"completion_query": {"label": "loop-8"}}
    await db_session.flush()

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    run_label = _by_id(report)["run_label"]
    assert run_label["status"] == "warn"
    assert "0 non-done card(s)" in run_label["evidence"]


async def test_run_label_unresolvable_warns_and_omits_derived_slots(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """With no completion_query and no labelled cards there is no run label,
    so the slots DERIVED from it must not materialize as "-integration"."""
    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    assert _by_id(report)["run_label"]["status"] == "warn"
    assert "RUN_LABEL" not in report["autofill"]
    assert "INTEGRATION_BRANCH" not in report["autofill"]
    assert "CARD_BRANCH_PREFIX" not in report["autofill"]


async def test_autofill_omits_empty_values_rather_than_filling_blanks(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """"Missing -> omitted, never empty string." An empty value is one the
    renderer would happily substitute, producing a prompt that reads "branch: "
    — worse than an unfilled field, because the bind form shows it as answered.
    """
    backlog = await _column(db_session, test_board, "To Do", ColumnType.backlog)
    await _card(db_session, test_board, backlog, test_user, labels=["loop-8"])
    await _repo(db_session, test_workspace, test_board, test_user, default_branch="")

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    assert "DEFAULT_BRANCH" not in report["autofill"]
    # The same repo still answers what it CAN — omission is per-slot.
    assert report["autofill"]["REPO_URL"]["value"] == (
        "https://github.com/valaris/test-repo"
    )


async def test_autofill_omits_unknown_slots(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """AC7: a source with no matching slot in the catalog emits nothing — the
    bind form would otherwise show a field the template cannot render."""
    await _fully_equipped(db_session, test_workspace, test_board, test_user)

    report = await LoopTemplateFitService(db_session).check(
        test_board.id,
        test_workspace.id,
        # Catalog carries ONLY RUN_LABEL; every other source must stay silent.
        _content(slots=[SlotSpec(name="RUN_LABEL", kind="scalar", required=True)]),
    )

    assert set(report["autofill"]) == {"RUN_LABEL"}


async def test_autofill_never_emits_a_slot_outside_the_catalog(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """AC7 stated as the invariant it really is, over the equipped board where
    every source fires."""
    await _fully_equipped(db_session, test_workspace, test_board, test_user)
    content = _content()

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, content
    )

    assert set(report["autofill"]) <= {slot.name for slot in content.slots}
    # UNFILLABLE is in the catalog but no source answers it: present in the
    # catalog is necessary, not sufficient.
    assert "UNFILLABLE" not in report["autofill"]


async def test_autofill_seed_note_by_title(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """The seed note is found by RUN_LABEL appearing in its title — and only a
    PINNED note counts, since the contract asks for a pinned seed."""
    backlog = await _column(db_session, test_board, "To Do", ColumnType.backlog)
    await _card(db_session, test_board, backlog, test_user, labels=["loop-8"])
    await _note(db_session, test_workspace, test_board, test_user,
                "Unpinned loop-8 draft", pinned=False)
    seed = await _note(db_session, test_workspace, test_board, test_user,
                       "Loop-8 seed batch")

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    assert report["autofill"]["SEED_NOTE_TITLE"]["value"] == "Loop-8 seed batch"
    assert report["autofill"]["SEED_NOTE_ID"]["value"] == str(seed.id)
    assert _by_id(report)["pinned_note:seed"]["status"] == "ok"


async def test_autofill_seed_note_matches_title_case_insensitively(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """Matching must fold case on BOTH sides. Labels are free text an operator
    typed, so a board whose label is "Loop-8" must still find the note titled
    "loop-8 seed batch" — and vice versa. The two sides are deliberately
    opposite here; equal casing would make the assertion vacuous."""
    backlog = await _column(db_session, test_board, "To Do", ColumnType.backlog)
    await _card(db_session, test_board, backlog, test_user, labels=["Loop-8"])
    await _note(db_session, test_workspace, test_board, test_user,
                "loop-8 seed batch — 37 cards")

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    assert report["autofill"]["SEED_NOTE_TITLE"]["value"] == (
        "loop-8 seed batch — 37 cards"
    )
    assert _by_id(report)["pinned_note:seed"]["status"] == "ok"


async def test_pinned_note_missing_offers_the_skeleton_fix(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    backlog = await _column(db_session, test_board, "To Do", ColumnType.backlog)
    await _card(db_session, test_board, backlog, test_user, labels=["loop-8"])

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    note_check = _by_id(report)["pinned_note:seed"]
    assert note_check["status"] == "missing"
    assert note_check["fix_id"] == "seed_note_skeleton"


async def test_autofill_prefers_the_repos_own_integration_branch(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """A repo that already declares an integration branch (PAR-1) is stating a
    FACT; the "<label>-integration" convention is only a guess and must not
    overwrite it."""
    backlog = await _column(db_session, test_board, "To Do", ColumnType.backlog)
    await _card(db_session, test_board, backlog, test_user, labels=["loop-8"])
    await _repo(
        db_session,
        test_workspace,
        test_board,
        test_user,
        integration_branch="staging-loop-8",
    )

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    assert report["autofill"]["INTEGRATION_BRANCH"] == {
        "value": "staging-loop-8",
        "source": "git_repo:test-repo",
    }


async def test_autofill_primary_repo_is_the_first_created(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """Q9 fixes the primary repo as the first-created one, matching the
    convention cards use when git_repo_slug is NULL (and the ordering
    assignment_service already applies: created_at asc, id asc).

    The timestamps are set EXPLICITLY because `created_at` defaults to
    `func.now()`, which SQLite resolves to whole-second CURRENT_TIMESTAMP —
    two repos inserted in one test would otherwise tie and the assertion would
    silently be decided by a random uuid instead of by creation order.
    """
    first = await _repo(
        db_session, test_workspace, test_board, test_user,
        slug="first", url="https://github.com/valaris/first", default_branch="trunk",
    )
    second = await _repo(
        db_session, test_workspace, test_board, test_user,
        slug="second", url="https://github.com/valaris/second",
    )
    first.created_at = datetime(2026, 1, 1, 0, 0, 0)
    second.created_at = datetime(2026, 6, 1, 0, 0, 0)
    await db_session.flush()

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    assert report["autofill"]["REPO_URL"]["value"] == "https://github.com/valaris/first"
    assert report["autofill"]["DEFAULT_BRANCH"]["value"] == "trunk"


async def test_autofill_repo_source_falls_back_to_id_when_slug_is_null(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """GitRepo.slug is nullable for rolling deploys; the provenance string must
    still identify WHICH repo answered."""
    repo = await _repo(db_session, test_workspace, test_board, test_user, slug=None)

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    assert report["autofill"]["REPO_URL"]["source"] == f"git_repo:{str(repo.id)[:8]}"


async def test_autofill_definition_keys_lists_the_intersection(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """DEFINITION_KEYS advertises what the board can actually offer the
    prompts — keys the contract wants AND the board has, never the union."""
    await _definition(
        db_session,
        test_workspace,
        test_board,
        test_user,
        {"loop_charter": "x", "unrelated_key": "y"},
    )

    report = await LoopTemplateFitService(db_session).check(
        test_board.id,
        test_workspace.id,
        _content(slots=[*SLOTS, SlotSpec(name="DEFINITION_KEYS", kind="list")]),
    )

    entry = report["autofill"]["DEFINITION_KEYS"]
    assert entry["source"] == "definition"
    assert "loop_charter" in entry["value"]
    assert "unrelated_key" not in entry["value"]
    assert "loop_run_history" not in entry["value"]


async def test_autofill_definition_keys_stays_a_list_through_the_report(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """The seam the bind form depends on: DEFINITION_KEYS is the one shipped
    autofill that IS a list, and the renderer now rejects a non-list value.

    A substring assertion cannot see the difference between `["a", "b"]` and
    `"a,b"`, so the TYPE is asserted here — if this report ever started
    flattening, the bind form would send a string and the template's declared
    join would be silently replaced by whatever separator the flattening chose.
    """
    await _definition(
        db_session,
        test_workspace,
        test_board,
        test_user,
        {"loop_charter": "x", "note_conventions": "y"},
    )

    report = await LoopTemplateFitService(db_session).check(
        test_board.id,
        test_workspace.id,
        _content(slots=[*SLOTS, SlotSpec(name="DEFINITION_KEYS", kind="list")]),
    )

    value = report["autofill"]["DEFINITION_KEYS"]["value"]
    assert isinstance(value, list)
    assert all(isinstance(key, str) for key in value)


async def test_fit_never_writes_to_the_board(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """"Read-only: no writes, no events, no activity." A fit check runs on
    every keystroke of the template chooser; a write here would be an audit
    entry per preview."""
    await _fully_equipped(db_session, test_workspace, test_board, test_user)
    before = dict(test_board.loop_config or {})

    await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    assert dict(test_board.loop_config or {}) == before
    assert not db_session.new
    assert not db_session.dirty


async def test_fit_ignores_another_boards_facts(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """Every board fact is board-scoped. A sibling board in the same workspace
    supplying a column or repo would make fit report a readiness that the
    bound board does not have."""
    other = Board(
        workspace_id=test_workspace.id,
        name="Other",
        slug="other-board",
        created_by=test_user.id,
    )
    db_session.add(other)
    await db_session.flush()
    await _column(db_session, other, "Done", ColumnType.done)
    await _repo(db_session, test_workspace, other, test_user, slug="other-repo",
                url="https://github.com/valaris/other")
    await _note(db_session, test_workspace, other, test_user, "Loop-8 seed batch")
    await _definition(
        db_session, test_workspace, other, test_user,
        {"loop_charter": "the sibling's charter", "loop_run_history": []},
    )
    other_backlog = await _column(db_session, other, "Other To Do", ColumnType.backlog)
    for _ in range(6):
        await _card(db_session, other, other_backlog, test_user,
                    labels=["sibling-label"])
    await _column(db_session, test_board, "In Progress", ColumnType.active)
    backlog = await _column(db_session, test_board, "To Do", ColumnType.backlog)
    await _card(db_session, test_board, backlog, test_user, labels=["loop-8"])

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    assert _by_id(report)["column:done"]["status"] == "missing"
    assert _by_id(report)["git_repo_bound"]["status"] == "missing"
    assert "REPO_URL" not in report["autofill"]
    # The sibling's seed note names this very run label — scoping by workspace
    # instead of board would hand another board's note to this one.
    assert _by_id(report)["pinned_note:seed"]["status"] == "missing"
    assert "SEED_NOTE_TITLE" not in report["autofill"]
    assert "SEED_NOTE_ID" not in report["autofill"]
    # Definitions are one-per-board (uq_definitions_board_id); reading the
    # sibling's would report a charter this board has never authored.
    assert _by_id(report)["definition:loop_charter"]["status"] == "missing"
    # The sibling outnumbers this board 6 cards to 1, so an unscoped card read
    # would autofill ITS label as this board's run label.
    assert report["autofill"]["RUN_LABEL"]["value"] == "loop-8"


async def test_fit_rejects_a_board_from_another_workspace(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """Defence in depth, asserted at the layer where it is reachable.

    Over HTTP `resolve_board_id` already scopes the board to the workspace in
    the URL, so this guard cannot be reached through the router — a fact worth
    stating, because it makes the router-level mutant equivalent and a
    successor should not re-chase it. Direct service callers (p2-02's apply
    path) have no such dependency, so the check is exercised here.
    """
    from app.exceptions import ResourceNotFoundError

    stranger = Workspace(name="Stranger", slug="stranger", created_by=test_user.id)
    db_session.add(stranger)
    await db_session.flush()

    with pytest.raises(ResourceNotFoundError):
        await LoopTemplateFitService(db_session).check(
            test_board.id, stranger.id, _content()
        )


async def test_fit_reports_a_frozen_board(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """AC5: freezing stops WRITES; reading how well a template fits is still
    allowed, and the flag lets the UI disable the fix buttons."""
    test_board.is_frozen = True
    await db_session.flush()

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    assert report["board_frozen"] is True


async def test_completion_query_mismatch_reports_false(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """AC4: the field compares AUTOFILL's run label against completion_query.
    They are the same source here, so the only way to see False is a template
    whose catalog has no RUN_LABEL slot at all — then autofill has none and
    completion_query still does."""
    test_board.loop_config = {"completion_query": {"label": "loop-8"}}
    await db_session.flush()

    report = await LoopTemplateFitService(db_session).check(
        test_board.id,
        test_workspace.id,
        _content(slots=[SlotSpec(name="REPO_URL", kind="scalar")]),
    )

    assert "RUN_LABEL" not in report["autofill"]
    assert report["completion_query_matches_run_label"] is False


async def test_fit_tolerates_a_contract_with_no_requirements(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """A template need not declare a setup contract at all (the field defaults
    to {}), and a bare template must fit any board rather than 500."""
    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content(setup_contract={})
    )

    assert report["checks"] == []
    assert report["autofill"] == {}


async def test_the_seed_note_fix_is_withheld_when_no_run_label_can_name_it(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """B7 AC1. `_fix_seed_note` refuses without a run label, so offering the
    repair here advertises a button that cannot work. The report knows the run
    label at check time — it must decide usability there, not leave the
    operator to discover it by clicking."""
    backlog = await _column(db_session, test_board, "To Do", ColumnType.backlog)
    await _card(db_session, test_board, backlog, test_user, labels=[])

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    note_check = _by_id(report)["pinned_note:seed"]
    assert note_check["status"] == "missing"
    assert note_check["fix_id"] is None
    assert note_check["evidence"] == (
        "no run label to name the note after — set completion_query.label "
        "or label a card"
    )


async def test_labelling_a_live_card_makes_the_seed_note_fix_available_again(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """B7 AC2. The withholding is a function of the run label, not a permanent
    downgrade: the moment the board can name a run, the repair comes back."""
    backlog = await _column(db_session, test_board, "To Do", ColumnType.backlog)
    unlabelled = await _card(db_session, test_board, backlog, test_user, labels=[])

    service = LoopTemplateFitService(db_session)
    before = _by_id(await service.check(test_board.id, test_workspace.id, _content()))[
        "pinned_note:seed"
    ]
    assert before["fix_id"] is None

    unlabelled.labels = ["loop-9"]
    await db_session.flush()

    after = _by_id(
        await LoopTemplateFitService(db_session).check(
            test_board.id, test_workspace.id, _content()
        )
    )["pinned_note:seed"]
    assert after["fix_id"] == "seed_note_skeleton"
    assert after["evidence"] == "no pinned note names the run"


async def test_a_completion_query_label_alone_keeps_the_seed_note_fix_usable(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """`_resolve_run_label` answers from completion_query BEFORE it counts card
    labels, so a board with zero labelled cards is still fixable. Reading only
    the cards would withhold a repair that works."""
    backlog = await _column(db_session, test_board, "To Do", ColumnType.backlog)
    await _card(db_session, test_board, backlog, test_user, labels=[])
    test_board.loop_config = {"completion_query": {"label": "loop-9"}}
    await db_session.flush()

    report = await LoopTemplateFitService(db_session).check(
        test_board.id, test_workspace.id, _content()
    )

    assert _by_id(report)["pinned_note:seed"]["fix_id"] == "seed_note_skeleton"
