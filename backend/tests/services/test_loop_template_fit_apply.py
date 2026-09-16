# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Fit APPLY — the one-click repairs the fit report advertises (spec §4, Q9).

The write half of "adjust to the current board". `check` says what is wrong and
hands back a `fix_id`; `apply` takes those ids and makes them true.

Three properties are load-bearing and each has tests below:

  idempotent   every fix RE-CHECKS before acting, so a double-click, a retry
               after a dropped response, and an operator applying a stale
               report all land on `skipped_already_satisfied` rather than a
               second column.
  all-or-nothing  unknown ids are rejected BEFORE any fix runs. A request that
               names one good and one bogus id must not half-apply — the
               operator would have no way to tell which half.
  pre-filled   the definition stub is BUILT FROM the template's setup contract,
               never an empty key. An empty `loop_charter` satisfies the
               check's "is the key present" test while telling the loop nothing,
               which is worse than the honest gap it replaced.

Only three fixes exist by owner decision Q9 (typed columns, the `loop_charter`
stub, a seed note). Git repos and agents carry credentials and are never
created on an operator's behalf, so they have no fix_id and cannot reach here.
"""

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import BoardFrozenError, ValidationError
from app.models.activity import Activity
from app.models.definitions.definition import Definition
from app.models.kanban.board import Board
from app.models.kanban.column import Column, ColumnType
from app.models.notes.note import Note
from app.models.user import User
from app.models.workspace import Workspace
from app.services.loop_template_fit import LoopTemplateFitService
from app.services.loop_template_render import SlotSpec, TemplateContent

pytestmark = pytest.mark.anyio


# Mirrors the shipped contract's REAL key names (coding_loop_v2.py:1119) —
# `required_column_types`, not the `columns_by_type` the card's prose invented.
CONTRACT = {
    "required_column_types": ["active", "done"],
    "optional_column_types": ["backlog"],
    "requires_run_label": True,
    "definition_keys": ["loop_charter", "loop_run_history"],
    "pinned_notes": ["seed"],
    "git_repo_bound": True,
}

SLOTS = [
    SlotSpec(name="RUN_LABEL", kind="scalar", required=True),
    SlotSpec(name="INTEGRATION_BRANCH", kind="scalar"),
]


def _content(**overrides) -> TemplateContent:
    return TemplateContent(
        system_prompt="Run <<RUN_LABEL>>.",
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


async def _labelled_card(
    db: AsyncSession, board: Board, column: Column, user: User, label: str
):
    from app.models.kanban.card import Card

    card = Card(
        board_id=board.id,
        column_id=column.id,
        title="A card",
        position=1024.0,
        created_by=user.id,
        labels=[label],
    )
    db.add(card)
    await db.flush()
    return card


async def _columns_of(db: AsyncSession, board: Board, column_type: ColumnType):
    return list(
        await db.scalars(
            select(Column).where(
                Column.board_id == board.id, Column.column_type == column_type
            )
        )
    )


def _apply(db):
    return LoopTemplateFitService(db).apply


def _outcomes(result: dict) -> dict[str, str]:
    return {entry["fix_id"]: entry["outcome"] for entry in result["applied"]}


# --- create_column:<type> --------------------------------------------------


async def test_apply_create_column_idempotent(
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """AC1: the first apply creates exactly one done-typed column; the second
    finds it and skips. Idempotence is what makes a double-click harmless."""
    result = await _apply(db_session)(
        test_board.id,
        test_workspace.id,
        _content(),
        ["create_column:done"],
        test_user.id,
    )

    assert _outcomes(result) == {"create_column:done": "applied"}
    created = await _columns_of(db_session, test_board, ColumnType.done)
    assert len(created) == 1
    assert created[0].name == "Done"

    again = await _apply(db_session)(
        test_board.id,
        test_workspace.id,
        _content(),
        ["create_column:done"],
        test_user.id,
    )

    assert _outcomes(again) == {"create_column:done": "skipped_already_satisfied"}
    assert len(await _columns_of(db_session, test_board, ColumnType.done)) == 1


async def test_apply_create_column_uses_the_type_default_name(
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """Each type gets its OWN English name. A single hardcoded name would make
    a board fixed for two types read "Done / Done"."""
    await _apply(db_session)(
        test_board.id,
        test_workspace.id,
        _content(),
        ["create_column:active", "create_column:done"],
        test_user.id,
    )

    names = {
        column.column_type: column.name
        for column in await db_session.scalars(
            select(Column).where(Column.board_id == test_board.id)
        )
    }
    assert names[ColumnType.active] == "Active"
    assert names[ColumnType.done] == "Done"


async def test_apply_create_column_appends_after_existing_columns(
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """A new column lands at the END of the board, never in front of the
    operator's existing flow."""
    existing = await _column(db_session, test_board, "In Progress", ColumnType.active)

    await _apply(db_session)(
        test_board.id,
        test_workspace.id,
        _content(),
        ["create_column:done"],
        test_user.id,
    )

    created = (await _columns_of(db_session, test_board, ColumnType.done))[0]
    assert created.position > existing.position


async def test_apply_unknown_column_type_rejected(
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """`create_column:todo` names a column NAME people use, not a type in the
    enum. It is rejected rather than silently creating an untyped column the
    runner's pickup would never look at."""
    result = await _apply(db_session)(
        test_board.id,
        test_workspace.id,
        _content(),
        ["create_column:todo"],
        test_user.id,
    )

    entry = result["applied"][0]
    assert entry["outcome"] == "rejected"
    assert "unknown column type" in entry["detail"]
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(Column)
            .where(Column.board_id == test_board.id)
        )
        == 0
    )


# --- definition_stub:loop_charter -----------------------------------------


async def test_apply_definition_stub_prefilled_and_merge_safe(
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """AC2: on a board with no definition the stub arrives POPULATED.

    An empty `{}` would satisfy the fit check's presence test while telling the
    loop nothing — the operator would see a green checkmark over a charter that
    says nothing about what the run is for or when it stops.
    """
    result = await _apply(db_session)(
        test_board.id,
        test_workspace.id,
        _content(),
        ["definition_stub:loop_charter"],
        test_user.id,
    )

    assert _outcomes(result) == {"definition_stub:loop_charter": "applied"}
    definition = await db_session.scalar(
        select(Definition).where(Definition.board_id == test_board.id)
    )
    charter = definition.content["loop_charter"]
    assert charter["what"]
    assert charter["stop_contract"]
    assert charter["hard_floors"] == []
    assert charter["test_gates"] == "<fill>"


async def test_apply_definition_stub_preserves_sibling_keys(
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """Shallow-merge is by TOP-LEVEL key: sending only {loop_charter: ...}
    must leave every other key of a rich definition untouched."""
    db_session.add(
        Definition(
            board_id=test_board.id,
            workspace_id=test_workspace.id,
            scope="the existing scope",
            content={"north_star": "ship it", "guiding_principles": ["a", "b"]},
            updated_by=test_user.id,
        )
    )
    await db_session.flush()

    await _apply(db_session)(
        test_board.id,
        test_workspace.id,
        _content(),
        ["definition_stub:loop_charter"],
        test_user.id,
    )

    definition = await db_session.scalar(
        select(Definition).where(Definition.board_id == test_board.id)
    )
    assert definition.content["north_star"] == "ship it"
    assert definition.content["guiding_principles"] == ["a", "b"]
    assert definition.content["loop_charter"]["what"]
    assert definition.scope == "the existing scope"


async def test_apply_definition_stub_never_clobbers_an_existing_charter(
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """AC2 second half: a board that already has a charter is SKIPPED. The
    operator's own words are never overwritten by a generated stub."""
    db_session.add(
        Definition(
            board_id=test_board.id,
            workspace_id=test_workspace.id,
            scope="s",
            content={"loop_charter": {"what": "the operator's own words"}},
            updated_by=test_user.id,
        )
    )
    await db_session.flush()

    result = await _apply(db_session)(
        test_board.id,
        test_workspace.id,
        _content(),
        ["definition_stub:loop_charter"],
        test_user.id,
    )

    assert _outcomes(result) == {
        "definition_stub:loop_charter": "skipped_already_satisfied"
    }
    definition = await db_session.scalar(
        select(Definition).where(Definition.board_id == test_board.id)
    )
    assert definition.content["loop_charter"] == {"what": "the operator's own words"}


async def test_apply_definition_stub_carries_the_run_label_and_branch(
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """The stub is built from the SAME autofill the bind form shows, so the
    charter the operator lands on already names their run and branch."""
    test_board.loop_config = {"completion_query": {"label": "loop-9"}}
    await db_session.flush()

    await _apply(db_session)(
        test_board.id,
        test_workspace.id,
        _content(),
        ["definition_stub:loop_charter"],
        test_user.id,
    )

    definition = await db_session.scalar(
        select(Definition).where(Definition.board_id == test_board.id)
    )
    charter = definition.content["loop_charter"]
    assert "loop-9" in charter["card_scope"]
    assert "loop-9-integration" in charter["branch_policy"]


async def test_apply_definition_stub_without_a_run_label_still_populates(
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """A board with nothing to derive a label from still gets a usable stub —
    the charter degrades to a fill-me placeholder rather than to `{}`."""
    await _apply(db_session)(
        test_board.id,
        test_workspace.id,
        _content(),
        ["definition_stub:loop_charter"],
        test_user.id,
    )

    definition = await db_session.scalar(
        select(Definition).where(Definition.board_id == test_board.id)
    )
    charter = definition.content["loop_charter"]
    assert charter["what"]
    assert charter["card_scope"]
    assert charter["stop_contract"]


async def test_apply_rejects_a_definition_key_the_contract_cannot_stub(
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """`loop_run_history` is in the contract but is NOT stubbable: only
    `loop_charter` has content the setup contract describes (Q9). A fix id
    naming any other key is rejected, never guessed at."""
    result = await _apply(db_session)(
        test_board.id,
        test_workspace.id,
        _content(),
        ["definition_stub:loop_run_history"],
        test_user.id,
    )

    entry = result["applied"][0]
    assert entry["outcome"] == "rejected"
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(Definition)
            .where(Definition.board_id == test_board.id)
        )
        == 0
    )


# --- seed_note_skeleton ----------------------------------------------------


async def test_apply_seed_note_skeleton_idempotent(
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """AC3: a pinned note whose title NAMES the run, created once."""
    test_board.loop_config = {"completion_query": {"label": "loop-9"}}
    await db_session.flush()

    result = await _apply(db_session)(
        test_board.id,
        test_workspace.id,
        _content(),
        ["seed_note_skeleton"],
        test_user.id,
    )

    assert _outcomes(result) == {"seed_note_skeleton": "applied"}
    notes = list(
        await db_session.scalars(select(Note).where(Note.board_id == test_board.id))
    )
    assert len(notes) == 1
    assert "loop-9" in notes[0].title
    assert notes[0].pinned is True

    again = await _apply(db_session)(
        test_board.id,
        test_workspace.id,
        _content(),
        ["seed_note_skeleton"],
        test_user.id,
    )

    assert _outcomes(again) == {"seed_note_skeleton": "skipped_already_satisfied"}
    assert (
        await db_session.scalar(
            select(func.count()).select_from(Note).where(Note.board_id == test_board.id)
        )
        == 1
    )


async def test_apply_seed_note_counts_only_live_labelled_cards(
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """The title's card count is the work REMAINING. Counting done cards would
    open a fresh run's seed note claiming a backlog that is already spent."""
    test_board.loop_config = {"completion_query": {"label": "loop-9"}}
    active = await _column(db_session, test_board, "Active", ColumnType.active)
    done = await _column(db_session, test_board, "Done", ColumnType.done)
    await _labelled_card(db_session, test_board, active, test_user, "loop-9")
    await _labelled_card(db_session, test_board, active, test_user, "loop-9")
    await _labelled_card(db_session, test_board, done, test_user, "loop-9")
    await _labelled_card(db_session, test_board, active, test_user, "other-run")

    await _apply(db_session)(
        test_board.id,
        test_workspace.id,
        _content(),
        ["seed_note_skeleton"],
        test_user.id,
    )

    note = await db_session.scalar(select(Note).where(Note.board_id == test_board.id))
    assert "2 cards" in note.title


async def test_apply_seed_note_body_carries_the_skeleton_sections(
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """A pinned note with an empty body would satisfy the check while giving
    the next iteration nothing to fill in."""
    test_board.loop_config = {"completion_query": {"label": "loop-9"}}
    await db_session.flush()

    await _apply(db_session)(
        test_board.id,
        test_workspace.id,
        _content(),
        ["seed_note_skeleton"],
        test_user.id,
    )

    note = await db_session.scalar(select(Note).where(Note.board_id == test_board.id))
    # Notes normalize markdown -> ProseMirror JSON on write, so assert on the
    # stored tree's text rather than on the markdown that went in.
    body = str(note.content)
    for section in (
        "Cards & priority order",
        "Dependency edges",
        "Baselines",
        "Run constraints",
    ):
        assert section in body, section


async def test_apply_seed_note_without_label_rejected(
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """AC3: no resolvable RUN_LABEL means the note would be titled after
    nothing. Rejected with a reason, never created blank."""
    result = await _apply(db_session)(
        test_board.id,
        test_workspace.id,
        _content(),
        ["seed_note_skeleton"],
        test_user.id,
    )

    entry = result["applied"][0]
    assert entry["outcome"] == "rejected"
    assert entry["detail"] == "no run label"
    assert (
        await db_session.scalar(
            select(func.count()).select_from(Note).where(Note.board_id == test_board.id)
        )
        == 0
    )


async def test_apply_seed_note_ignores_an_unpinned_namesake(
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """Unpinned notes are drafts and scratch. Treating one as the seed would
    leave the board without the pinned note the contract asks for."""
    test_board.loop_config = {"completion_query": {"label": "loop-9"}}
    db_session.add(
        Note(
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            title="loop-9 scratch thoughts",
            content="",
            pinned=False,
            created_by=test_user.id,
        )
    )
    await db_session.flush()

    result = await _apply(db_session)(
        test_board.id,
        test_workspace.id,
        _content(),
        ["seed_note_skeleton"],
        test_user.id,
    )

    assert _outcomes(result) == {"seed_note_skeleton": "applied"}
    pinned = list(
        await db_session.scalars(
            select(Note).where(Note.board_id == test_board.id, Note.pinned.is_(True))
        )
    )
    assert len(pinned) == 1


# --- validation, atomicity, freeze ----------------------------------------


async def test_apply_unknown_fix_422_no_writes(
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """AC5: ids are validated BEFORE anything runs, so a request naming one
    good and one bogus id applies NEITHER. A half-applied batch leaves the
    operator unable to tell which half landed."""
    with pytest.raises(ValidationError) as excinfo:
        await _apply(db_session)(
            test_board.id,
            test_workspace.id,
            _content(),
            ["create_column:done", "burn_it_all_down"],
            test_user.id,
        )

    assert excinfo.value.error_code == "unknown_fix"
    assert await _columns_of(db_session, test_board, ColumnType.done) == []


async def test_apply_frozen_board_rejected_before_any_write(
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """The freeze is checked ONCE up front. Letting the per-fix services raise
    it would apply fix 1 and then blow up on fix 2 — a partial application of
    a request the board should have refused outright."""
    test_board.is_frozen = True
    await db_session.flush()

    with pytest.raises(BoardFrozenError):
        await _apply(db_session)(
            test_board.id,
            test_workspace.id,
            _content(),
            ["create_column:done", "definition_stub:loop_charter"],
            test_user.id,
        )

    assert await _columns_of(db_session, test_board, ColumnType.done) == []
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(Definition)
            .where(Definition.board_id == test_board.id)
        )
        == 0
    )


async def test_apply_frozen_board_refuses_even_a_batch_that_would_write_nothing(
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """The freeze is THIS service's own gate, not a side effect of the fixes.

    Every per-fix service raises `BoardFrozenError` on its own, so a batch that
    would write makes the up-front guard look redundant — it is not. A batch
    whose fixes are all already satisfied (or empty) reaches no writing service
    at all, and without the guard a frozen board would answer 200 and report
    itself repairable. Mutating the guard away is invisible to any test that
    only exercises a batch that writes.
    """
    await _column(db_session, test_board, "Done", ColumnType.done)
    test_board.is_frozen = True
    await db_session.flush()

    with pytest.raises(BoardFrozenError):
        await _apply(db_session)(
            test_board.id,
            test_workspace.id,
            _content(),
            ["create_column:done"],  # already satisfied — no service would write
            test_user.id,
        )

    with pytest.raises(BoardFrozenError):
        await _apply(db_session)(
            test_board.id, test_workspace.id, _content(), [], test_user.id
        )


async def test_apply_board_from_another_workspace_is_not_found(
    db_session: AsyncSession,
    test_board: Board,
    second_user: User,
):
    """The workspace scope is enforced at the SERVICE layer too, so a direct
    caller cannot repair a board it only knows the id of."""
    from app.exceptions import ResourceNotFoundError

    foreign = Workspace(name="Foreign", slug="foreign-apply", created_by=second_user.id)
    db_session.add(foreign)
    await db_session.flush()

    with pytest.raises(ResourceNotFoundError):
        await _apply(db_session)(
            test_board.id,
            foreign.id,
            _content(),
            ["create_column:done"],
            second_user.id,
        )


async def test_apply_returns_the_post_apply_report(
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """AC6: `checks` reflects the state AFTER the fixes. A pre-apply report
    would still show the gap the operator just closed."""
    result = await _apply(db_session)(
        test_board.id,
        test_workspace.id,
        _content(),
        ["create_column:done"],
        test_user.id,
    )

    by_id = {check["id"]: check for check in result["checks"]}
    assert by_id["column:done"]["status"] == "ok"
    assert by_id["column:done"]["fix_id"] is None
    assert by_id["column:done"]["evidence"] == "Done"
    # The gap that was NOT in fix_ids is still reported as open.
    assert by_id["column:active"]["status"] == "missing"


async def test_apply_empty_fix_ids_is_a_plain_report(
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """An empty list writes nothing and still answers — the UI can refresh the
    checklist through the same endpoint it applies with."""
    result = await _apply(db_session)(
        test_board.id, test_workspace.id, _content(), [], test_user.id
    )

    assert result["applied"] == []
    assert result["checks"]
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(Column)
            .where(Column.board_id == test_board.id)
        )
        == 0
    )


async def test_apply_records_activity_through_the_real_services(
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """Fixes go through ColumnService/DefinitionService/NoteService so the
    board's audit trail and WS events look identical to a human doing it by
    hand. Writing the rows directly would make these three changes invisible."""
    before = await db_session.scalar(select(func.count()).select_from(Activity))
    test_board.loop_config = {"completion_query": {"label": "loop-9"}}
    await db_session.flush()

    await _apply(db_session)(
        test_board.id,
        test_workspace.id,
        _content(),
        ["create_column:done", "definition_stub:loop_charter", "seed_note_skeleton"],
        test_user.id,
    )

    after = await db_session.scalar(select(func.count()).select_from(Activity))
    assert after > before


async def test_apply_runs_every_requested_fix(
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """A batch is not a sample: all three fixes in one request all land, and
    the report names each one."""
    test_board.loop_config = {"completion_query": {"label": "loop-9"}}
    await db_session.flush()

    result = await _apply(db_session)(
        test_board.id,
        test_workspace.id,
        _content(),
        ["create_column:done", "definition_stub:loop_charter", "seed_note_skeleton"],
        test_user.id,
    )

    assert _outcomes(result) == {
        "create_column:done": "applied",
        "definition_stub:loop_charter": "applied",
        "seed_note_skeleton": "applied",
    }
    assert len(await _columns_of(db_session, test_board, ColumnType.done)) == 1
    assert await db_session.scalar(
        select(Definition).where(Definition.board_id == test_board.id)
    )
    assert await db_session.scalar(select(Note).where(Note.board_id == test_board.id))
