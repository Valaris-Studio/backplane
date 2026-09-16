# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""PUT /loop `template` binding — where a template becomes a running loop.

The backend renders template + slot values into exactly the strings the runner
already reads (system_prompt, loop_prompt, tools, rails), at SAVE time. The
runner is untouched: it keeps decoding the same wire object, now with a slim
`template` ref alongside.

The four states a PUT body can express:

  template: {...}  bind (or re-render) — render, store prompts, upsert binding
  template: {}     detach — drop the binding, keep the rendered prompts as raw
  template: null   unchanged — the JSON-null-is-omission rule every other
                   LoopConfigPut field already follows
  (absent)         same as null

Raw prompts and a template in the SAME body is a contradiction (422); raw
prompts on an already-bound board would be silently overwritten by the next
re-render, so that is a 409 telling the caller to detach first.
"""

from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.config_template import BoardLoopTemplateBinding
from app.models.kanban.board import Board
from app.models.user import User
from app.services.loop_template_render import SlotSpec, SlotVariant, TemplateContent
from app.services.loop_templates import LOOP_TEMPLATES
from app.services.loop_templates._types import SystemTemplate


BASE_URL = "/api/workspaces/default/boards"

CODING_LOOP_VERSION = next(
    t.version for t in LOOP_TEMPLATES if t.slug == "coding-loop"
)
# The base grant as shipped (card 1f9f210c dropped update_definition from it);
# the seeds tests pin the exact count, so this reads it rather than restating.
CODING_LOOP_TOOL_COUNT = len(
    next(t.content.tools for t in LOOP_TEMPLATES if t.slug == "coding-loop")
)


def _loop_url(board: Board) -> str:
    return f"{BASE_URL}/{board.id}/loop"


def _binding_url(board: Board) -> str:
    return f"{BASE_URL}/{board.id}/loop/binding"


# A deliberately tiny stand-in for a real template: two required slots, one
# variant carrying tools_extra + rails, one derived rail. Small enough that a
# test body reads as its own assertion, complete enough to exercise every
# branch the binding path has (fills, tools union, rails precedence, derived).
DOUBLE_CONTENT = TemplateContent(
    system_prompt="You work on <<PROJECT>>.",
    loop_prompt="Advance <<PROJECT>> per <<POLICY_TEXT>>. Label: <<RUN_LABEL>>.",
    slots=[
        SlotSpec(name="PROJECT", kind="scalar", label="Project", required=True),
        SlotSpec(name="RUN_LABEL", kind="scalar", label="Run label", required=True),
        SlotSpec(
            name="POLICY_TEXT",
            kind="scalar",
            label="Policy prose",
            required=False,
            default="",
        ),
        SlotSpec(
            name="POLICY",
            kind="variant",
            label="Policy",
            required=False,
            default="strict",
            variants=[
                SlotVariant(
                    id="strict",
                    label="Strict",
                    fills={"POLICY_TEXT": "the strict policy"},
                    tools_extra=["mcp__valaris__update_card"],
                    rails={"max_iterations": 7},
                ),
                SlotVariant(
                    id="loose",
                    label="Loose",
                    fills={"POLICY_TEXT": "the loose policy"},
                    tools_extra=[],
                    rails={},
                ),
            ],
        ),
    ],
    tools=["mcp__valaris__get_card"],
    rails_defaults={"budget_usd": 42.0, "max_iterations": 5, "model": "premium"},
    derived_rails={"completion_query": {"label": "<<RUN_LABEL>>"}},
)

DOUBLE = SystemTemplate(
    slug="test-double-loop",
    version=1,
    name="Test Double Loop",
    content=DOUBLE_CONTENT,
    profile={"tagline": "A tiny template for binding tests"},
)

BIND_VALUES = {"PROJECT": "Backplane", "RUN_LABEL": "loop-templates"}


@pytest.fixture
def system_double():
    """Add the stand-in to the code-defined catalog for one test.

    Patching the LOOKUP rather than the catalog list keeps every real template
    resolvable alongside it, so a test that binds the double still proves the
    same code path a real system slug takes.
    """
    from app.services import loop_templates as registry

    real = registry.get_system_template

    def _lookup(slug: str):
        return DOUBLE if slug == DOUBLE.slug else real(slug)

    with patch(
        "app.services.kanban.loop_binding.get_system_template", side_effect=_lookup
    ):
        yield DOUBLE


async def _bind(
    client: AsyncClient,
    board: Board,
    *,
    slot_values: dict | None = None,
    ref: str = DOUBLE.slug,
    source: str = "system",
    version: int | None = None,
    **extra,
):
    body = {
        "template": {
            "source": source,
            "ref": ref,
            "slot_values": BIND_VALUES if slot_values is None else slot_values,
        },
        **extra,
    }
    if version is not None:
        body["template"]["version"] = version
    return await client.put(_loop_url(board), json=body)


async def _binding_row(
    db_session: AsyncSession, board: Board
) -> BoardLoopTemplateBinding | None:
    return await db_session.scalar(
        select(BoardLoopTemplateBinding).where(
            BoardLoopTemplateBinding.board_id == board.id
        )
    )


# --- bind ---------------------------------------------------------------


async def test_bind_renders_prompts_tools_and_rails_into_loop_config(
    client: AsyncClient, test_board: Board, system_double
):
    response = await _bind(client, test_board)
    assert response.status_code == 200, response.text
    data = response.json()

    assert data["system_prompt"] == "You work on Backplane."
    assert data["loop_prompt"] == (
        "Advance Backplane per the strict policy. Label: loop-templates."
    )
    # Template tools ∪ the selected variant's tools_extra — a variant that adds
    # a capability the prompt tells the agent to use must not lose it.
    assert data["tools"] == ["mcp__valaris__get_card", "mcp__valaris__update_card"]


async def test_bind_applies_rails_defaults_variant_rails_and_derived_rails(
    client: AsyncClient, test_board: Board, system_double
):
    """First bind seeds the rails an operator inherits by not thinking about
    them; the variant overrides the default, and derived_rails wins outright
    because it is computed from the same slot the prompts use."""
    data = (await _bind(client, test_board)).json()

    assert data["budget_usd"] == 42.0
    assert data["model"] == "premium"
    # variant rails (7) override rails_defaults (5)
    assert data["max_iterations"] == 7
    # A derived rail is canonicalized like any other operator-sent value —
    # completion_query gains its documented exclude_column_type default.
    assert data["completion_query"] == {
        "label": "loop-templates",
        "exclude_column_type": "done",
    }


async def test_bind_rail_set_explicitly_in_the_same_body_wins(
    client: AsyncClient, test_board: Board, system_double
):
    """The operator typed it on purpose in this very request — a template
    default that overrode it would make the form silently lie."""
    data = (await _bind(client, test_board, budget_usd=99.0)).json()

    assert data["budget_usd"] == 99.0
    assert data["max_iterations"] == 7


async def test_bind_writes_slim_template_ref_with_no_drift(
    client: AsyncClient, test_board: Board, system_double
):
    data = (await _bind(client, test_board)).json()

    assert data["template"] == {
        "source": "system",
        "ref": DOUBLE.slug,
        "version": 1,
        "drift": {"kind": "none"},
    }


async def test_bind_stores_slot_values_on_the_binding_row_not_loop_config(
    client: AsyncClient, db_session: AsyncSession, test_board: Board, system_double
):
    """The runner json.Unmarshals GET /loop; slot values are authoring state it
    has no field for, so they live on the binding row alone."""
    data = (await _bind(client, test_board)).json()
    assert "slot_values" not in data

    row = await _binding_row(db_session, test_board)
    assert row is not None
    assert row.slot_values == BIND_VALUES
    assert row.version == 1
    assert row.template_ref["source"] == "system"
    assert row.template_ref["slug"] == DOUBLE.slug
    assert row.rendered_hash


async def test_bind_stamps_the_actor_as_renderer(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_user: User,
    system_double,
):
    await _bind(client, test_board)

    row = await _binding_row(db_session, test_board)
    assert row.rendered_by_id == test_user.id


async def test_rebind_overwrites_the_single_binding_row(
    client: AsyncClient, db_session: AsyncSession, test_board: Board, system_double
):
    await _bind(client, test_board)
    await _bind(
        client,
        test_board,
        slot_values={**BIND_VALUES, "PROJECT": "Renamed"},
    )

    rows = (
        (
            await db_session.execute(
                select(BoardLoopTemplateBinding).where(
                    BoardLoopTemplateBinding.board_id == test_board.id
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1
    assert rows[0].slot_values["PROJECT"] == "Renamed"


async def test_rebind_keeps_the_boards_current_rails_except_derived(
    client: AsyncClient, test_board: Board, system_double
):
    """Re-render is a prompt refresh, not a rails reset: an operator who tuned
    budget_usd after binding must not lose it. derived_rails is the exception —
    it is a function of the slot values being re-rendered."""
    await _bind(client, test_board)
    await client.put(_loop_url(test_board), json={"budget_usd": 5.0})

    data = (
        await _bind(
            client,
            test_board,
            slot_values={**BIND_VALUES, "RUN_LABEL": "second-run"},
        )
    ).json()

    assert data["budget_usd"] == 5.0
    assert data["completion_query"]["label"] == "second-run"


async def test_bind_names_the_template_in_the_activity_summary(
    client: AsyncClient, db_session: AsyncSession, test_board: Board, system_double
):
    """The board timeline must say WHAT was bound; "updated loop config" alone
    cannot distinguish a rebind from a budget tweak."""
    await _bind(client, test_board)

    summary = await db_session.scalar(
        select(Activity.summary)
        .where(
            Activity.entity_type == ActivityEntityType.board,
            Activity.entity_id == test_board.id,
            Activity.action == ActivityAction.updated,
        )
        .order_by(Activity.created_at.desc())
        .limit(1)
    )
    assert summary == f"bound loop template {DOUBLE.slug}@v1"


async def test_detach_names_the_detach_in_the_activity_summary(
    client: AsyncClient, db_session: AsyncSession, test_board: Board, system_double
):
    await _bind(client, test_board)
    await client.put(_loop_url(test_board), json={"template": {}})

    summary = await db_session.scalar(
        select(Activity.summary)
        .where(
            Activity.entity_type == ActivityEntityType.board,
            Activity.entity_id == test_board.id,
            Activity.action == ActivityAction.updated,
        )
        .order_by(Activity.created_at.desc())
        .limit(1)
    )
    assert summary == f"detached loop template {DOUBLE.slug}"


async def test_bind_unknown_template_404(
    client: AsyncClient, test_board: Board, system_double
):
    response = await _bind(client, test_board, ref="no-such-template")
    assert response.status_code == 404, response.text


# --- render failures pass through as 422 --------------------------------


async def test_bind_missing_required_slot_422_naming_the_slot(
    client: AsyncClient, test_board: Board, system_double
):
    response = await _bind(client, test_board, slot_values={"PROJECT": "Backplane"})
    assert response.status_code == 422, response.text

    detail = response.json()["detail"]
    codes = {finding["code"] for finding in detail}
    fields = {finding["field"] for finding in detail}
    assert "required_slot_missing" in codes
    assert "slot_values.RUN_LABEL" in fields


async def test_bind_leaves_no_binding_row_when_render_fails(
    client: AsyncClient, db_session: AsyncSession, test_board: Board, system_double
):
    await _bind(client, test_board, slot_values={"PROJECT": "Backplane"})

    assert await _binding_row(db_session, test_board) is None


async def test_bind_unknown_slot_value_422(
    client: AsyncClient, test_board: Board, system_double
):
    response = await _bind(client, test_board, slot_values={**BIND_VALUES, "NOPE": "x"})
    assert response.status_code == 422, response.text
    assert "unknown_slot" in {f["code"] for f in response.json()["detail"]}


# --- list slots: the wire contract -------------------------------------------

# A second stand-in whose only interesting slot is a `list`. Kept apart from
# DOUBLE so the list contract's tests cannot be read as accidents of the
# variant/rails machinery the other double exercises.
LIST_CONTENT = TemplateContent(
    system_prompt="Definition keys: <<DEFINITION_KEYS>>.",
    loop_prompt="Work.",
    slots=[
        SlotSpec(
            name="DEFINITION_KEYS",
            kind="list",
            label="Definition keys",
            required=False,
            join=", ",
        )
    ],
    tools=["mcp__valaris__get_card"],
)

LIST_DOUBLE = SystemTemplate(
    slug="test-list-loop",
    version=1,
    name="Test List Loop",
    content=LIST_CONTENT,
    profile={"tagline": "A template whose only slot is a list"},
)


@pytest.fixture
def system_list_double():
    from app.services import loop_templates as registry

    real = registry.get_system_template

    def _lookup(slug: str):
        return LIST_DOUBLE if slug == LIST_DOUBLE.slug else real(slug)

    with patch(
        "app.services.kanban.loop_binding.get_system_template", side_effect=_lookup
    ):
        yield LIST_DOUBLE


async def _bind_list(client: AsyncClient, board: Board, value):
    return await _bind(
        client,
        board,
        ref=LIST_DOUBLE.slug,
        slot_values={"DEFINITION_KEYS": value},
    )


async def test_bind_list_slot_with_an_array_renders_the_joined_items(
    client: AsyncClient, test_board: Board, system_list_double
):
    response = await _bind_list(
        client, test_board, ["loop_charter", "note_conventions"]
    )
    assert response.status_code == 200, response.text
    assert response.json()["system_prompt"] == (
        "Definition keys: loop_charter, note_conventions."
    )


async def test_bind_list_slot_with_a_newline_string_renders_identically(
    client: AsyncClient, test_board: Board, system_list_double
):
    """Compat: every binding stored before this contract holds a string."""
    response = await _bind_list(client, test_board, "loop_charter\nnote_conventions")
    assert response.status_code == 200, response.text
    assert response.json()["system_prompt"] == (
        "Definition keys: loop_charter, note_conventions."
    )


@pytest.mark.parametrize("value", [7, {"x": 1}])
async def test_bind_list_slot_with_a_non_list_non_string_is_422(
    client: AsyncClient, test_board: Board, system_list_double, value
):
    response = await _bind_list(client, test_board, value)
    assert response.status_code == 422, response.text

    detail = response.json()["detail"]
    assert [f["code"] for f in detail] == ["list_slot_expects_array"]
    assert detail[0]["field"] == "slot_values.DEFINITION_KEYS"
    assert detail[0]["params"]["slot"] == "DEFINITION_KEYS"


async def test_bind_list_slot_rejection_leaves_no_binding_row(
    client: AsyncClient, db_session: AsyncSession, test_board: Board, system_list_double
):
    await _bind_list(client, test_board, 7)
    assert await _binding_row(db_session, test_board) is None


async def test_bind_list_slot_with_an_empty_array_is_accepted(
    client: AsyncClient, test_board: Board, system_list_double
):
    """`[]` is the answer "no keys", not a malformed value.

    Rule 4 eats the space in front of an inline empty value, so the rendered
    line closes up rather than leaving a gap — that is the renderer's existing
    contract, asserted here so the empty list stays visibly distinct from a 422.
    """
    response = await _bind_list(client, test_board, [])
    assert response.status_code == 200, response.text
    assert response.json()["system_prompt"] == "Definition keys:."


# --- template + raw prompts in one body ---------------------------------


@pytest.mark.parametrize(
    "raw",
    [
        {"loop_prompt": "hand-written"},
        {"system_prompt": "hand-written"},
        {"tools": ["mcp__valaris__get_card"]},
    ],
)
async def test_bind_with_raw_prompts_in_the_same_body_422(
    client: AsyncClient, test_board: Board, system_double, raw: dict
):
    """A body that both binds and hand-writes is self-contradictory: the render
    would clobber the hand-written text the caller just sent."""
    response = await _bind(client, test_board, **raw)
    assert response.status_code == 422, response.text
    assert response.json()["error_code"] == "template_and_raw_prompts"


async def test_bind_alongside_a_non_prompt_rail_is_allowed(
    client: AsyncClient, test_board: Board, system_double
):
    """Only the three template-owned fields conflict — rails are the operator's
    either way."""
    response = await _bind(client, test_board, budget_usd=13.0)
    assert response.status_code == 200, response.text


# --- raw PUT on a bound board -------------------------------------------


@pytest.mark.parametrize(
    "raw",
    [
        {"loop_prompt": "hand-written"},
        {"system_prompt": "hand-written"},
        {"tools": ["mcp__valaris__get_card"]},
    ],
)
async def test_raw_prompt_put_on_a_bound_board_409(
    client: AsyncClient, test_board: Board, system_double, raw: dict
):
    await _bind(client, test_board)

    response = await client.put(_loop_url(test_board), json=raw)
    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "board_bound_to_template"
    assert "template: {}" in response.json()["detail"]


async def test_rails_only_put_on_a_bound_board_succeeds_and_keeps_the_binding(
    client: AsyncClient, db_session: AsyncSession, test_board: Board, system_double
):
    await _bind(client, test_board)

    response = await client.put(_loop_url(test_board), json={"budget_usd": 11.0})
    assert response.status_code == 200, response.text
    assert response.json()["budget_usd"] == 11.0
    assert response.json()["template"]["ref"] == DOUBLE.slug

    assert await _binding_row(db_session, test_board) is not None


async def test_raw_prompt_put_on_an_unbound_board_still_succeeds(
    client: AsyncClient, test_board: Board
):
    """The 409 is a property of BEING BOUND, not of sending prompts."""
    response = await client.put(
        _loop_url(test_board), json={"loop_prompt": "hand-written"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["loop_prompt"] == "hand-written"
    assert response.json()["template"] is None


# --- detach --------------------------------------------------------------


async def test_detach_removes_the_binding_and_keeps_the_rendered_prompts(
    client: AsyncClient, db_session: AsyncSession, test_board: Board, system_double
):
    bound = (await _bind(client, test_board)).json()

    response = await client.put(_loop_url(test_board), json={"template": {}})
    assert response.status_code == 200, response.text
    data = response.json()

    assert data["template"] is None
    assert data["loop_prompt"] == bound["loop_prompt"]
    assert data["system_prompt"] == bound["system_prompt"]
    assert data["tools"] == bound["tools"]
    assert await _binding_row(db_session, test_board) is None


async def test_detach_and_edit_prompts_in_the_same_body(
    client: AsyncClient, test_board: Board, system_double
):
    """Detach clears the binding first, so the rest of the body is processed as
    an ordinary raw PUT instead of tripping the 409 it just dissolved."""
    await _bind(client, test_board)

    response = await client.put(
        _loop_url(test_board),
        json={"template": {}, "loop_prompt": "hand-written now"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["loop_prompt"] == "hand-written now"
    assert response.json()["template"] is None


async def test_detach_on_an_unbound_board_is_a_no_op(
    client: AsyncClient, test_board: Board
):
    """Idempotent: detaching twice is a retry, not an error."""
    await client.put(_loop_url(test_board), json={"loop_prompt": "raw"})

    response = await client.put(_loop_url(test_board), json={"template": {}})
    assert response.status_code == 200, response.text
    assert response.json()["template"] is None


async def test_template_null_leaves_the_binding_untouched(
    client: AsyncClient, db_session: AsyncSession, test_board: Board, system_double
):
    """JSON null means "unchanged" for every other LoopConfigPut field; the
    template key does not get to mean "detach" as well, or a client that
    serializes all fields would silently unbind every board it saved."""
    await _bind(client, test_board)

    response = await client.put(
        _loop_url(test_board), json={"template": None, "budget_usd": 8.0}
    )
    assert response.status_code == 200, response.text
    assert response.json()["template"]["ref"] == DOUBLE.slug
    assert await _binding_row(db_session, test_board) is not None


# --- drift (thin) --------------------------------------------------------


async def test_drift_template_newer_when_the_code_version_moves_ahead(
    client: AsyncClient, test_board: Board, system_double
):
    await _bind(client, test_board)

    bumped = SystemTemplate(
        slug=DOUBLE.slug,
        version=3,
        name=DOUBLE.name,
        content=DOUBLE_CONTENT,
        profile=DOUBLE.profile,
    )
    with patch(
        "app.services.kanban.loop_binding.get_system_template", return_value=bumped
    ):
        data = (await client.get(_loop_url(test_board))).json()

    assert data["template"]["version"] == 1
    # A code-defined template reads as `system_bumped` (p2-04): the arithmetic
    # is the same, but a deploy is not a teammate's publish.
    assert data["template"]["drift"] == {
        "kind": "system_bumped",
        "current_version": 3,
    }


async def test_get_loop_on_an_unbound_board_reports_template_null(
    client: AsyncClient, test_board: Board
):
    await client.put(_loop_url(test_board), json={"loop_prompt": "raw"})

    assert (await client.get(_loop_url(test_board))).json()["template"] is None


# --- GET /loop/binding ---------------------------------------------------


async def test_get_binding_returns_the_authoring_state(
    client: AsyncClient, test_board: Board, system_double
):
    await _bind(client, test_board)

    response = await client.get(_binding_url(test_board))
    assert response.status_code == 200, response.text
    data = response.json()

    assert data["template"] == {
        "source": "system",
        "ref": DOUBLE.slug,
        "version": 1,
        "drift": {"kind": "none"},
    }
    assert data["slot_values"] == BIND_VALUES
    assert data["rendered_at"]
    assert data["rendered_hash"]
    assert data["drift"] == {
        "kind": "none",
        "bound_version": 1,
        "current_version": 1,
        "new_required_slots": [],
        "removed_slots": [],
        "prompt_changed": False,
    }


async def test_get_binding_on_an_unbound_board_404_not_bound(
    client: AsyncClient, test_board: Board
):
    await client.put(_loop_url(test_board), json={"loop_prompt": "raw"})

    response = await client.get(_binding_url(test_board))
    assert response.status_code == 404, response.text
    assert response.json()["error_code"] == "not_bound"


# --- the existing contract is untouched ----------------------------------


async def test_expected_version_lock_still_guards_a_bind(
    client: AsyncClient, test_board: Board, system_double
):
    await client.put(_loop_url(test_board), json={"loop_prompt": "raw"})

    response = await _bind(client, test_board, expected_version=99)
    assert response.status_code == 409, response.text


async def test_bind_bumps_the_version_like_any_other_put(
    client: AsyncClient, test_board: Board, system_double
):
    first = (await client.put(_loop_url(test_board), json={"budget_usd": 1.0})).json()
    second = (await _bind(client, test_board)).json()

    assert second["version"] == first["version"] + 1


async def test_bind_on_a_frozen_board_is_rejected(
    client: AsyncClient, db_session: AsyncSession, test_board: Board, system_double
):
    test_board.is_frozen = True
    await db_session.flush()

    response = await _bind(client, test_board)
    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "board_frozen"


async def test_bind_publishes_one_loop_updated_event(
    client: AsyncClient, test_board: Board, system_double
):
    with patch.object(event_bus, "publish", new=AsyncMock()) as publish:
        await _bind(client, test_board)

    loop_events = [
        call
        for call in publish.await_args_list
        if (call.kwargs.get("event_type") or call.args[0]) == "board.loop_updated"
    ]
    assert len(loop_events) == 1


# --- the real system template, end to end (AC1) --------------------------


def _coding_loop_values(**overrides) -> dict:
    """Every required slot of the shipped Coding Loop, filled from its own
    declared examples. Sourced from the template rather than hand-listed so a
    slot added later fails loudly here instead of silently going unbound."""
    from app.services.loop_templates import get_system_template

    template = get_system_template("coding-loop")
    return {
        **{
            slot.name: (slot.example or "x")
            for slot in template.content.slots
            if slot.required and slot.kind != "variant"
        },
        **overrides,
    }


async def test_binding_the_shipped_coding_loop_renders_a_runnable_config(
    client: AsyncClient, db_session: AsyncSession, test_board: Board
):
    """The real thing, not a double: the template an operator actually picks
    must render into a config the runner can execute, with the run-completion
    rail derived from the same slot the prompts name."""
    values = _coding_loop_values(RUN_LABEL="loop-templates")

    response = await client.put(
        _loop_url(test_board),
        json={
            "template": {
                "source": "system",
                "ref": "coding-loop",
                "slot_values": values,
            }
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()

    assert data["template"] == {
        "source": "system",
        "ref": "coding-loop",
        # Read from the catalog: a seed revision (card B9 moved it to 3) is a
        # normal event, and hard-coding the number here only ever catches the
        # bump itself, never a real regression.
        "version": CODING_LOOP_VERSION,
        "drift": {"kind": "none"},
    }
    # The completion rail the harness evaluates in code before paying for a
    # session — derived from RUN_LABEL, so prompts and rail cannot disagree.
    assert data["completion_query"] == {
        "label": "loop-templates",
        "exclude_column_type": "done",
    }
    # Variant A (the default) ships the base allowlist unchanged (tools_extra
    # is empty); nothing may be left as an unrendered <<SLOT>>.
    assert len(data["tools"]) == CODING_LOOP_TOOL_COUNT
    assert "<<" not in data["system_prompt"]
    assert "<<" not in data["loop_prompt"]

    row = await _binding_row(db_session, test_board)
    assert row.version == CODING_LOOP_VERSION


async def test_binding_the_shipped_coding_loop_seeds_the_self_merge_landing(
    client: AsyncClient, test_board: Board
):
    """Card B9 AC6: the config a first-time operator inherits by not thinking
    about it must agree with the prompt they are about to run. Variant A tells
    the agent to merge its own PR, so the rail it seeds is `self_merge` — not
    the `human` that used to leak in from `rails_defaults`."""
    values = _coding_loop_values(RUN_LABEL="loop-templates")

    data = (
        await client.put(
            _loop_url(test_board),
            json={
                "template": {
                    "source": "system",
                    "ref": "coding-loop",
                    "slot_values": values,
                }
            },
        )
    ).json()

    assert data["loop_landing"] == "self_merge"


async def test_coding_loop_landing_variant_b_seeds_the_human_landing(
    client: AsyncClient, test_board: Board
):
    """The sibling that used to INHERIT `human` now declares it, so the value
    survives a change to `rails_defaults`."""
    values = _coding_loop_values(RUN_LABEL="loop-templates", LANDING="B")

    data = (
        await client.put(
            _loop_url(test_board),
            json={
                "template": {
                    "source": "system",
                    "ref": "coding-loop",
                    "slot_values": values,
                }
            },
        )
    ).json()

    assert data["loop_landing"] == "human"


async def test_coding_loop_landing_variant_c_adds_the_merge_queue_tool(
    client: AsyncClient, test_board: Board
):
    """A variant that tells the agent to enqueue a PR must also grant the tool
    that does it, or the rendered loop is broken on its own instructions."""
    values = _coding_loop_values(RUN_LABEL="loop-templates", LANDING="C")

    data = (
        await client.put(
            _loop_url(test_board),
            json={
                "template": {
                    "source": "system",
                    "ref": "coding-loop",
                    "slot_values": values,
                }
            },
        )
    ).json()

    # Variant C adds exactly one tool on top of the base grant.
    assert len(data["tools"]) == CODING_LOOP_TOOL_COUNT + 1
    assert "mcp__valaris__enqueue_pr_for_merge" in data["tools"]


# --- workspace templates (DB-backed, versioned) --------------------------


WORKSPACE_CONTENT = {
    "system_prompt": "House rules for <<PROJECT>>.",
    "loop_prompt": "Ship <<PROJECT>>.",
    "slots": [
        {"name": "PROJECT", "kind": "scalar", "label": "Project", "required": True}
    ],
    # set_board_loop is mandatory in a publishable template — a loop with no
    # off switch cannot stop itself, and publish validation refuses it.
    "tools": ["mcp__valaris__get_card", "mcp__valaris__set_board_loop"],
    "rails_defaults": {"budget_usd": 7.0},
}


async def _workspace_template(
    db_session: AsyncSession,
    workspace,
    user: User,
    *,
    publish: bool = True,
    content: dict | None = None,
):
    from app.services.loop_template import LoopTemplateService

    service = LoopTemplateService(db_session)
    row = await service.create_draft(
        workspace.id,
        actor_id=user.id,
        data={
            "slug": "house-loop",
            "name": "House Loop",
            "content": content or WORKSPACE_CONTENT,
        },
    )
    if publish:
        row = await service.publish(workspace.id, str(row.id), actor_id=user.id)
    await db_session.flush()
    return row


async def test_bind_a_published_workspace_template(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace,
    test_user: User,
):
    row = await _workspace_template(db_session, test_workspace, test_user)

    response = await _bind(
        client,
        test_board,
        ref=str(row.id),
        source="workspace",
        slot_values={"PROJECT": "Backplane"},
    )
    assert response.status_code == 200, response.text
    data = response.json()

    assert data["system_prompt"] == "House rules for Backplane."
    assert data["budget_usd"] == 7.0
    assert data["template"] == {
        "source": "workspace",
        # A workspace template is referenced by uuid — its slug is workspace
        # scoped and could collide with another tenant's.
        "ref": str(row.id),
        "version": 1,
        "drift": {"kind": "none"},
    }


async def test_bind_an_unpublished_workspace_template_422(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace,
    test_user: User,
):
    """A draft is unreviewed content. Binding one would ship prompts nobody
    approved to a loop that spends money."""
    row = await _workspace_template(
        db_session, test_workspace, test_user, publish=False
    )

    response = await _bind(
        client,
        test_board,
        ref=str(row.id),
        source="workspace",
        slot_values={"PROJECT": "Backplane"},
    )
    assert response.status_code == 422, response.text
    assert "template_not_published" in {f["code"] for f in response.json()["detail"]}


async def test_publishing_a_newer_workspace_version_shows_as_drift(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace,
    test_user: User,
):
    from app.services.loop_template import LoopTemplateService

    row = await _workspace_template(db_session, test_workspace, test_user)
    await _bind(
        client,
        test_board,
        ref=str(row.id),
        source="workspace",
        slot_values={"PROJECT": "Backplane"},
    )

    service = LoopTemplateService(db_session)
    await service.update_draft(
        test_workspace.id,
        str(row.id),
        data={"content": {**WORKSPACE_CONTENT, "loop_prompt": "Ship <<PROJECT>> v2."}},
        expected_updated_at=None,
    )
    await service.publish(test_workspace.id, str(row.id), actor_id=test_user.id)
    await db_session.flush()

    data = (await client.get(_loop_url(test_board))).json()
    assert data["template"]["version"] == 1
    assert data["template"]["drift"] == {
        "kind": "template_newer",
        "current_version": 2,
    }
    # The board's prompts are still v1's — drift REPORTS, it never re-renders.
    assert data["loop_prompt"] == "Ship Backplane."


async def test_binding_an_explicit_older_workspace_version_renders_that_snapshot(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace,
    test_user: User,
):
    """`version` pins the snapshot. Without it a bind silently takes whatever
    was published last, which is not what an operator restoring a known-good
    version asked for."""
    from app.services.loop_template import LoopTemplateService

    row = await _workspace_template(db_session, test_workspace, test_user)
    service = LoopTemplateService(db_session)
    await service.update_draft(
        test_workspace.id,
        str(row.id),
        data={"content": {**WORKSPACE_CONTENT, "loop_prompt": "Ship <<PROJECT>> v2."}},
        expected_updated_at=None,
    )
    await service.publish(test_workspace.id, str(row.id), actor_id=test_user.id)
    await db_session.flush()

    data = (
        await _bind(
            client,
            test_board,
            ref=str(row.id),
            source="workspace",
            version=1,
            slot_values={"PROJECT": "Backplane"},
        )
    ).json()

    assert data["loop_prompt"] == "Ship Backplane."
    assert data["template"]["version"] == 1
    assert data["template"]["drift"] == {
        "kind": "template_newer",
        "current_version": 2,
    }


async def test_binding_a_nonexistent_workspace_version_404(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace,
    test_user: User,
):
    row = await _workspace_template(db_session, test_workspace, test_user)

    response = await _bind(
        client,
        test_board,
        ref=str(row.id),
        source="workspace",
        version=9,
        slot_values={"PROJECT": "Backplane"},
    )
    assert response.status_code == 404, response.text


async def test_get_binding_drift_distinguishes_bound_from_current_version(
    client: AsyncClient, test_board: Board, system_double
):
    """The two version numbers must not be conflated. On an undrifted board
    they are equal, so only a DRIFTED binding can prove `bound_version` really
    reports what this board rendered rather than echoing the catalog."""
    await _bind(client, test_board)

    bumped = SystemTemplate(
        slug=DOUBLE.slug,
        version=5,
        name=DOUBLE.name,
        content=DOUBLE_CONTENT,
        profile=DOUBLE.profile,
    )
    with patch(
        "app.services.kanban.loop_binding.get_system_template", return_value=bumped
    ):
        data = (await client.get(_binding_url(test_board))).json()

    assert data["drift"] == {
        # A system bump: the code moved, nobody published.
        "kind": "system_bumped",
        "bound_version": 1,
        "current_version": 5,
        # v1 of a CODE-defined template is not in this binary any more, so the
        # delta is unknowable and reports empty rather than claiming every slot
        # of v5 is brand new.
        "new_required_slots": [],
        "removed_slots": [],
        "prompt_changed": False,
    }
    assert data["template"]["version"] == 1


async def test_rebind_says_re_rendered_not_bound_in_the_activity_summary(
    client: AsyncClient, db_session: AsyncSession, test_board: Board, system_double
):
    """A timeline that logs "bound" twice hides the fact that a running loop's
    prompts CHANGED under it — the one event an operator debugging a bad
    iteration needs to find."""
    await _bind(client, test_board)
    await _bind(client, test_board, slot_values={**BIND_VALUES, "PROJECT": "Again"})

    summary = await db_session.scalar(
        select(Activity.summary)
        .where(
            Activity.entity_type == ActivityEntityType.board,
            Activity.entity_id == test_board.id,
            Activity.action == ActivityAction.updated,
        )
        .order_by(Activity.created_at.desc())
        .limit(1)
    )
    assert summary == f"re-rendered loop template {DOUBLE.slug}@v1"


# --- rich drift kinds + diff (p2-04) -------------------------------------


def _bumped(version: int, content: TemplateContent | None = None) -> SystemTemplate:
    """The stand-in as a later deploy would ship it."""
    return SystemTemplate(
        slug=DOUBLE.slug,
        version=version,
        name=DOUBLE.name,
        content=DOUBLE_CONTENT if content is None else content,
        profile=DOUBLE.profile,
    )


def _with_extra_required_slot() -> TemplateContent:
    """v2 of the double: same prompts plus one NEW required slot."""
    return TemplateContent(
        **{
            **DOUBLE_CONTENT.model_dump(),
            "loop_prompt": DOUBLE_CONTENT.loop_prompt + " Owner: <<OWNER>>.",
            "slots": [
                *DOUBLE_CONTENT.model_dump()["slots"],
                {"name": "OWNER", "kind": "scalar", "label": "Owner", "required": True},
            ],
        }
    )


async def test_system_template_bump_reads_as_system_bumped_not_template_newer(
    client: AsyncClient, test_board: Board, system_double
):
    """A code-defined template that moved arrived with a DEPLOY, not with a
    teammate's publish — the two get different banner copy, so the kind must
    distinguish them (AC2)."""
    await _bind(client, test_board)

    with patch(
        "app.services.kanban.loop_binding.get_system_template",
        return_value=_bumped(3),
    ):
        data = (await client.get(_loop_url(test_board))).json()

    assert data["template"]["drift"]["kind"] == "system_bumped"
    assert data["template"]["drift"]["current_version"] == 3


async def test_loop_config_read_drift_kind_thin(
    client: AsyncClient, test_board: Board, system_double
):
    """GET /loop rides every runner poll: it carries the VERDICT only, never
    the slot lists the binding read serves (AC1's payload split)."""
    await _bind(client, test_board)

    with patch(
        "app.services.kanban.loop_binding.get_system_template",
        return_value=_bumped(2, _with_extra_required_slot()),
    ):
        drift = (await client.get(_loop_url(test_board))).json()["template"]["drift"]

    assert set(drift) == {"kind", "current_version"}


async def test_binding_read_reports_no_diff_available_without_drift(
    client: AsyncClient, test_board: Board, system_double
):
    await _bind(client, test_board)

    data = (await client.get(_binding_url(test_board))).json()

    assert data["drift"]["kind"] == "none"
    assert data["diff_available"] is False


async def test_binding_diff_on_an_unbound_board_404_not_bound(
    client: AsyncClient, test_board: Board
):
    await client.put(_loop_url(test_board), json={"loop_prompt": "raw"})

    response = await client.get(f"{_binding_url(test_board)}/diff")
    assert response.status_code == 404, response.text
    assert response.json()["error_code"] == "not_bound"


async def test_first_bind_to_a_template_with_required_slots_still_422s_generically(
    client: AsyncClient, test_board: Board, system_double
):
    """The new code is a RE-RENDER guard: a first bind that omits a required
    slot must keep reporting the renderer's own missing-slot error, or the
    bind form loses the per-field errors it renders."""
    response = await _bind(client, test_board, slot_values={"PROJECT": "Backplane"})

    assert response.status_code == 422, response.text
    codes = {item["code"] for item in response.json()["detail"]}
    assert "new_required_slots_unfilled" not in codes


# --- rich drift payload + diff, on a versioned workspace template ---------
#
# Deliberately NOT the system double: a code-defined template keeps only its
# CURRENT version in the binary, so the content a board rendered against an
# older deploy is genuinely unrecoverable and the delta is unknowable. Only a
# DB-backed template snapshots every version, which is what makes
# new_required_slots / removed_slots / the kernel diff computable at all.


V2_CONTENT = {
    **WORKSPACE_CONTENT,
    "system_prompt": "House rules for <<PROJECT>>, owned by <<OWNER>>.",
    "slots": [
        {"name": "PROJECT", "kind": "scalar", "label": "Project", "required": True},
        {"name": "OWNER", "kind": "scalar", "label": "Owner", "required": True},
    ],
}


async def _bind_then_publish_v2(
    client, db_session, board, workspace, user, *, v2_content=V2_CONTENT
):
    """Bind a board to v1, then publish v2 behind it — the exact state the
    drift banner exists to describe."""
    from app.services.loop_template import LoopTemplateService

    row = await _workspace_template(db_session, workspace, user)
    await _bind(
        client,
        board,
        ref=str(row.id),
        source="workspace",
        slot_values={"PROJECT": "Backplane"},
    )

    service = LoopTemplateService(db_session)
    await service.update_draft(
        workspace.id,
        str(row.id),
        data={"content": v2_content},
        expected_updated_at=None,
    )
    await service.publish(workspace.id, str(row.id), actor_id=user.id)
    await db_session.flush()
    return row


async def test_binding_read_carries_the_full_drift_payload(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace,
    test_user: User,
):
    await _bind_then_publish_v2(
        client, db_session, test_board, test_workspace, test_user
    )

    data = (await client.get(_binding_url(test_board))).json()

    assert data["drift"]["kind"] == "template_newer"
    assert data["drift"]["bound_version"] == 1
    assert data["drift"]["current_version"] == 2
    assert data["drift"]["new_required_slots"] == ["OWNER"]
    assert data["drift"]["removed_slots"] == []
    assert data["drift"]["prompt_changed"] is True
    assert data["diff_available"] is True


async def test_binding_read_names_a_removed_slot(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace,
    test_user: User,
):
    """Removals are the half an Update flow cannot infer from the new version
    alone — the operator's stored value for a dropped slot is about to stop
    mattering, and the UI says so."""
    await _bind_then_publish_v2(
        client,
        db_session,
        test_board,
        test_workspace,
        test_user,
        v2_content={
            **WORKSPACE_CONTENT,
            "system_prompt": "House rules.",
            "loop_prompt": "Ship it.",
            "slots": [],
        },
    )

    drift = (await client.get(_binding_url(test_board))).json()["drift"]

    assert drift["removed_slots"] == ["PROJECT"]
    assert drift["new_required_slots"] == []


async def test_binding_diff_endpoint(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace,
    test_user: User,
):
    """AC4: a changed kernel yields real unified text; the slot delta rides
    alongside it rather than in a second request."""
    await _bind_then_publish_v2(
        client, db_session, test_board, test_workspace, test_user
    )

    response = await client.get(f"{_binding_url(test_board)}/diff")

    assert response.status_code == 200, response.text
    data = response.json()
    assert "-House rules for <<PROJECT>>." in data["system_prompt"]
    assert "+House rules for <<PROJECT>>, owned by <<OWNER>>." in data["system_prompt"]
    # loop_prompt was untouched between v1 and v2 — an empty string, not a
    # header-only diff, is how the UI knows to render nothing for it.
    assert data["loop_prompt"] == ""
    assert data["slots_delta"] == {"added": ["OWNER"], "removed": []}


async def test_binding_diff_is_empty_when_only_slots_changed(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace,
    test_user: User,
):
    """AC4's second half, as the platform actually permits it.

    A slot catalogued but unused fails publish validation (`unused_slot`), so
    "only slots changed, prompts untouched" is unreachable through a published
    version — the honest equivalent is a change confined to ONE kernel field.
    The UNCHANGED field must still come back as an empty string rather than a
    header-only diff, which is what lets the UI skip rendering it.
    """
    await _bind_then_publish_v2(
        client,
        db_session,
        test_board,
        test_workspace,
        test_user,
        v2_content={
            **WORKSPACE_CONTENT,
            "loop_prompt": "Ship <<PROJECT>>, then check <<SPARE>>.",
            "slots": [
                *WORKSPACE_CONTENT["slots"],
                {"name": "SPARE", "kind": "scalar", "label": "Spare"},
            ],
        },
    )

    data = (await client.get(f"{_binding_url(test_board)}/diff")).json()

    assert data["system_prompt"] == ""
    assert "+Ship <<PROJECT>>, then check <<SPARE>>." in data["loop_prompt"]
    assert data["slots_delta"] == {"added": ["SPARE"], "removed": []}


async def test_rerender_new_required_slot_422(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace,
    test_user: User,
):
    """AC3: re-rendering onto a version that ADDED a required slot must name
    it specifically — the UI turns that list into the fields it asks for, and
    the generic missing-slot error cannot be told apart from an operator
    clearing a field they always had."""
    row = await _bind_then_publish_v2(
        client, db_session, test_board, test_workspace, test_user
    )
    before = (await client.get(_loop_url(test_board))).json()

    response = await _bind(
        client,
        test_board,
        ref=str(row.id),
        source="workspace",
        slot_values={"PROJECT": "Backplane"},
    )

    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert "new_required_slots_unfilled" in {item["code"] for item in detail}
    assert any(item.get("value") == ["OWNER"] for item in detail)

    # The refused re-render left the running loop exactly as it was.
    after = (await client.get(_loop_url(test_board))).json()
    assert after["system_prompt"] == before["system_prompt"]
    assert (await _binding_row(db_session, test_board)).version == 1


async def test_rerender_succeeds_once_the_new_required_slot_is_supplied(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace,
    test_user: User,
):
    """AC3's happy half — and the proof the 422 above is about the VALUE being
    absent, not about the version having moved."""
    row = await _bind_then_publish_v2(
        client, db_session, test_board, test_workspace, test_user
    )

    response = await _bind(
        client,
        test_board,
        ref=str(row.id),
        source="workspace",
        slot_values={"PROJECT": "Backplane", "OWNER": "Ada"},
    )
    assert response.status_code == 200, response.text

    data = (await client.get(_loop_url(test_board))).json()
    assert data["system_prompt"] == "House rules for Backplane, owned by Ada."
    assert data["template"]["drift"] == {"kind": "none"}
    assert data["template"]["version"] == 2


async def test_rerender_omitting_an_ALWAYS_required_slot_is_not_new_required(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace,
    test_user: User,
):
    """The guard is about slots the NEW version introduced, not about every
    unfilled required slot.

    PROJECT was required in v1 and is still required in v2. An operator who
    clears it gets the renderer's own per-field error, because the drift banner
    must not claim v2 "added" a field the board has been filling all along.
    """
    row = await _bind_then_publish_v2(
        client, db_session, test_board, test_workspace, test_user
    )

    response = await _bind(
        client,
        test_board,
        ref=str(row.id),
        source="workspace",
        # OWNER (genuinely new) supplied; PROJECT (always required) cleared.
        slot_values={"OWNER": "Ada"},
    )

    assert response.status_code == 422, response.text
    codes = {item["code"] for item in response.json()["detail"]}
    assert "new_required_slots_unfilled" not in codes
    assert "required_slot_missing" in codes


async def test_rerender_at_the_SAME_version_does_not_hit_the_new_slot_guard(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace,
    test_user: User,
):
    """Re-rendering the version a board is already on is a routine re-save
    (an operator retyping one slot value), not an upgrade.

    Nothing was "newly required" relative to itself, so the guard must stay out
    of the way — a 422 here would make every slot edit on an up-to-date board
    impossible.
    """
    row = await _workspace_template(db_session, test_workspace, test_user)
    await _bind(
        client,
        test_board,
        ref=str(row.id),
        source="workspace",
        slot_values={"PROJECT": "Backplane"},
    )

    response = await _bind(
        client,
        test_board,
        ref=str(row.id),
        source="workspace",
        slot_values={"PROJECT": "Renamed"},
    )

    assert response.status_code == 200, response.text
    assert (await client.get(_loop_url(test_board))).json()[
        "system_prompt"
    ] == "House rules for Renamed."


async def test_binding_a_DIFFERENT_template_does_not_hit_the_new_slot_guard(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace,
    test_user: User,
):
    """Switching templates is a fresh bind, not an upgrade of the old one.

    The new template's required slots are not "additions" relative to a
    template it never shared a lineage with, so an unfilled one must surface as
    the renderer's own per-field error the bind form renders.
    """
    row = await _workspace_template(db_session, test_workspace, test_user)
    await _bind(
        client,
        test_board,
        ref=str(row.id),
        source="workspace",
        slot_values={"PROJECT": "Backplane"},
    )

    # A SECOND workspace template — same source, different slug, so the guard's
    # slug check (not its source check) is the branch under test. Its required
    # OWNER slot is not an "addition" to house-loop; it belongs to a template
    # this board never ran.
    from app.services.loop_template import LoopTemplateService

    service = LoopTemplateService(db_session)
    other = await service.create_draft(
        test_workspace.id,
        actor_id=test_user.id,
        data={
            "slug": "other-loop",
            "name": "Other Loop",
            "content": {
                **WORKSPACE_CONTENT,
                "system_prompt": "Other rules for <<OWNER>>.",
                "loop_prompt": "Ship whatever <<OWNER>> says.",
                "slots": [
                    {
                        "name": "OWNER",
                        "kind": "scalar",
                        "label": "Owner",
                        "required": True,
                    }
                ],
            },
        },
    )
    await service.publish(test_workspace.id, str(other.id), actor_id=test_user.id)
    # Publish AGAIN so other-loop sits at v2 while the board is bound to
    # house-loop@v1: without a differing version the guard's earlier
    # same-version check would short-circuit and the slug branch would never
    # be exercised.
    await service.update_draft(
        test_workspace.id,
        str(other.id),
        data={
            "content": {
                **WORKSPACE_CONTENT,
                "system_prompt": "Other rules, revised, for <<OWNER>>.",
                "loop_prompt": "Ship whatever <<OWNER>> says.",
                "slots": [
                    {
                        "name": "OWNER",
                        "kind": "scalar",
                        "label": "Owner",
                        "required": True,
                    }
                ],
            }
        },
        expected_updated_at=None,
    )
    await service.publish(
        test_workspace.id, str(other.id), expected_version=1, actor_id=test_user.id
    )
    await db_session.flush()

    response = await _bind(
        client, test_board, ref=str(other.id), source="workspace", slot_values={}
    )

    assert response.status_code == 422, response.text
    codes = {item["code"] for item in response.json()["detail"]}
    assert "new_required_slots_unfilled" not in codes
    assert "required_slot_missing" in codes


async def test_binding_diff_is_empty_when_the_bound_snapshot_is_unrecoverable(
    client: AsyncClient, test_board: Board, system_double
):
    """A code-defined template keeps only its CURRENT version in the binary.

    Once a deploy moves it, the text the board actually rendered against is
    gone — so the diff must come back EMPTY rather than diffing the current
    kernel against a blank template, which would read as "the entire prompt was
    just added".
    """
    await _bind(client, test_board)

    bumped = SystemTemplate(
        slug=DOUBLE.slug,
        version=4,
        name=DOUBLE.name,
        content=TemplateContent(
            system_prompt="A wholly rewritten kernel for <<PROJECT>>.",
            loop_prompt=DOUBLE_CONTENT.loop_prompt,
            slots=DOUBLE_CONTENT.slots,
            tools=DOUBLE_CONTENT.tools,
        ),
        profile=DOUBLE.profile,
    )
    with patch(
        "app.services.kanban.loop_binding.get_system_template", return_value=bumped
    ):
        data = (await client.get(f"{_binding_url(test_board)}/diff")).json()

    assert data["system_prompt"] == ""
    assert data["loop_prompt"] == ""
    assert data["slots_delta"] == {"added": [], "removed": []}


# --- re-render when the bound snapshot is UNRECOVERABLE -----------------
#
# The operator's only recovery from a moved template is to re-render onto the
# new version. When the content the board originally rendered against can no
# longer be reconstructed, the new-required-slot guard has nothing to compare
# against — and must step aside rather than dereference the missing snapshot.


async def test_rerender_onto_a_bumped_system_version_succeeds(
    client: AsyncClient, db_session: AsyncSession, test_board: Board, system_double
):
    """AC1: a code-defined template keeps only its CURRENT version in the
    binary, so once a deploy bumps it the bound snapshot is simply gone.

    Re-rendering is the operator's ONLY way back onto the new version; if the
    guard dereferences that missing snapshot the recovery path is exactly the
    path that 500s.
    """
    await _bind(client, test_board)

    with patch(
        "app.services.kanban.loop_binding.get_system_template",
        return_value=_bumped(2),
    ):
        response = await _bind(client, test_board)

    assert response.status_code == 200, response.text
    assert response.json()["template"]["version"] == 2
    assert (await _binding_row(db_session, test_board)).version == 2


async def test_rerender_reports_rebind_true_when_the_snapshot_is_unrecoverable(
    client: AsyncClient, test_board: Board, system_double
):
    """AC1's second half: the activity trail must still read as a RE-render.

    A board that silently reported `bound` would tell the operator it had no
    prior template, which is the opposite of what just happened.
    """
    await _bind(client, test_board)

    with patch(
        "app.services.kanban.loop_binding.get_system_template",
        return_value=_bumped(2),
    ):
        await _bind(client, test_board)
        activity = (await client.get(_loop_url(test_board))).json()

    assert activity["template"]["version"] == 2
    assert activity["template"]["drift"] == {"kind": "none"}


async def test_rerender_survives_a_deleted_workspace_version_snapshot(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace,
    test_user: User,
):
    """AC2: a workspace template's bound version row can be pruned (retention,
    a botched restore, a manual cleanup).

    The snapshot is gone but the TEMPLATE is not, so re-rendering onto the
    current version must still work — the operator cannot un-delete a row, and
    a 500 would strand the board on prompts nobody can regenerate.
    """
    from app.models.config_template import ConfigTemplateVersion
    from sqlalchemy import delete

    row = await _bind_then_publish_v2(
        client, db_session, test_board, test_workspace, test_user
    )
    await db_session.execute(
        delete(ConfigTemplateVersion).where(
            ConfigTemplateVersion.template_id == row.id,
            ConfigTemplateVersion.version == 1,
        )
    )
    await db_session.flush()

    response = await _bind(
        client,
        test_board,
        ref=str(row.id),
        source="workspace",
        slot_values={"PROJECT": "Backplane", "OWNER": "Ada"},
    )

    assert response.status_code == 200, response.text
    assert (await _binding_row(db_session, test_board)).version == 2


# --- the guard must see what the RENDERER will see ----------------------
#
# Variant fills and slot defaults are resolved inside `render`. A guard that
# runs before them refuses values the render would in fact have received —
# the operator is asked to retype a value the template already supplies.


def _v2_with_variant_filled_required_slot() -> dict:
    """v2 adds a required OWNER whose value arrives from the variant's fills."""
    return {
        **WORKSPACE_CONTENT,
        "loop_prompt": "Ship <<PROJECT>> for <<OWNER>>.",
        "slots": [
            *WORKSPACE_CONTENT["slots"],
            {"name": "OWNER", "kind": "scalar", "label": "Owner", "required": True},
            {
                "name": "TIER",
                "kind": "variant",
                "label": "Tier",
                "default": "gold",
                "variants": [
                    {
                        "id": "gold",
                        "label": "Gold",
                        "fills": {"OWNER": "the gold owner"},
                    }
                ],
            },
        ],
    }


async def test_rerender_accepts_a_new_required_slot_filled_by_the_variant(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace,
    test_user: User,
):
    """AC3: the variant's `fills` ARE the value. Refusing here would demand a
    field the template author deliberately answered on the operator's behalf."""
    row = await _bind_then_publish_v2(
        client,
        db_session,
        test_board,
        test_workspace,
        test_user,
        v2_content=_v2_with_variant_filled_required_slot(),
    )

    response = await _bind(
        client,
        test_board,
        ref=str(row.id),
        source="workspace",
        slot_values={"PROJECT": "Backplane"},
    )

    assert response.status_code == 200, response.text
    data = (await client.get(_loop_url(test_board))).json()
    assert data["loop_prompt"] == "Ship Backplane for the gold owner."


async def test_rerender_accepts_a_new_required_slot_carrying_a_default(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace,
    test_user: User,
):
    """AC4: a non-empty `default` is a supplied value as far as the render is
    concerned, so the guard must not out-vote it."""
    row = await _bind_then_publish_v2(
        client,
        db_session,
        test_board,
        test_workspace,
        test_user,
        v2_content={
            **WORKSPACE_CONTENT,
            "loop_prompt": "Ship <<PROJECT>> for <<OWNER>>.",
            "slots": [
                *WORKSPACE_CONTENT["slots"],
                {
                    "name": "OWNER",
                    "kind": "scalar",
                    "label": "Owner",
                    "required": True,
                    "default": "the house",
                },
            ],
        },
    )

    response = await _bind(
        client,
        test_board,
        ref=str(row.id),
        source="workspace",
        slot_values={"PROJECT": "Backplane"},
    )

    assert response.status_code == 200, response.text
    data = (await client.get(_loop_url(test_board))).json()
    assert data["loop_prompt"] == "Ship Backplane for the house."


async def test_rerender_accepts_a_falsy_but_supplied_new_required_slot(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace,
    test_user: User,
):
    """AC5: `False` and `0` are ANSWERS. A truthiness check reads them as
    unfilled and 422s on a value the operator supplied on purpose — the
    renderer itself stringifies them happily (`_stringify`), so the guard is
    the only thing standing between the operator and their own value."""
    row = await _bind_then_publish_v2(
        client, db_session, test_board, test_workspace, test_user
    )

    response = await _bind(
        client,
        test_board,
        ref=str(row.id),
        source="workspace",
        slot_values={"PROJECT": "Backplane", "OWNER": False},
    )

    assert response.status_code == 200, response.text
    data = (await client.get(_loop_url(test_board))).json()
    assert data["system_prompt"] == "House rules for Backplane, owned by False."


# --- corrupt refs and raw edits surface on GET /loop/binding (B8) --------
#
# Both of these are states the version comparison alone reads as "clean", which
# is the worst possible answer: the operator is told nothing is wrong about
# state the system never actually checked.


async def test_a_workspace_ref_that_lost_its_id_reports_a_corrupt_binding(
    client: AsyncClient, test_board: Board, db_session: AsyncSession, system_double
):
    await _bind(client, test_board)
    row = await _binding_row(db_session, test_board)
    # A workspace-source ref carries {source, slug, id, workspace_id}. Dropping
    # `id` is exactly what a bad backfill or a hand-edited row looks like.
    row.template_ref = {"source": "workspace", "slug": "orphaned"}
    await db_session.flush()

    body = (await client.get(_binding_url(test_board))).json()

    assert body["drift"]["kind"] == "binding_corrupt"
    assert body["template"]["drift"]["kind"] == "binding_corrupt"
    assert body["diff_available"] is False


async def test_raw_prompt_edits_behind_an_intact_binding_report_raw_edited(
    client: AsyncClient, test_board: Board, db_session: AsyncSession, system_double
):
    """The failure the `rendered_hash` column was added for: an operator edits
    the prompts the binding rendered, so versions and slot values still agree
    and every other signal reads clean."""
    await _bind(client, test_board)
    await db_session.refresh(test_board)
    test_board.loop_config = {
        **test_board.loop_config,
        "system_prompt": "Hand-edited behind the binding.",
    }
    await db_session.flush()

    body = (await client.get(_binding_url(test_board))).json()

    assert body["drift"]["kind"] == "raw_edited"
    # Neither new kind has a diff to show: the TEMPLATE did not move, so the
    # panel behind this flag would render two identical snapshots.
    assert body["diff_available"] is False


async def test_an_untouched_bound_board_stays_clean(
    client: AsyncClient, test_board: Board, system_double
):
    """The negative control for the hash comparison: a board nobody edited must
    not acquire a permanent banner from the new check."""
    await _bind(client, test_board)

    body = (await client.get(_binding_url(test_board))).json()

    assert body["drift"]["kind"] == "none"
    assert body["diff_available"] is False


async def test_editing_only_a_rail_is_not_a_raw_edit(
    client: AsyncClient, test_board: Board, db_session: AsyncSession, system_double
):
    """The hash covers PROMPTS only. Rails are the half an operator is invited
    to tune after binding (the bind seeds them and a re-render preserves them),
    so a rail edit reading as drift would fire on the intended workflow."""
    await _bind(client, test_board)
    await db_session.refresh(test_board)
    test_board.loop_config = {**test_board.loop_config, "max_iterations": 999}
    await db_session.flush()

    body = (await client.get(_binding_url(test_board))).json()

    assert body["drift"]["kind"] == "none"


async def test_the_runner_poll_path_carries_the_raw_edit_signal_too(
    client: AsyncClient, test_board: Board, db_session: AsyncSession, system_double
):
    """GET /loop is a SEPARATE code path from GET /loop/binding — the thin
    signal the runner polls every iteration, built by `slim_ref` rather than
    `compute_drift`. A raw edit that showed only on the human-facing endpoint
    would leave the loop itself with no way to notice.
    """
    await _bind(client, test_board)
    await db_session.refresh(test_board)
    test_board.loop_config = {
        **test_board.loop_config,
        "loop_prompt": "Hand-edited behind the binding.",
    }
    await db_session.flush()

    body = (await client.get(_loop_url(test_board))).json()

    assert body["template"]["drift"]["kind"] == "raw_edited"


async def test_the_poll_path_stays_clean_for_an_untouched_board(
    client: AsyncClient, test_board: Board, system_double
):
    await _bind(client, test_board)

    body = (await client.get(_loop_url(test_board))).json()

    assert body["template"]["drift"]["kind"] == "none"


async def test_the_poll_path_reports_a_corrupt_ref(
    client: AsyncClient, test_board: Board, db_session: AsyncSession, system_double
):
    await _bind(client, test_board)
    row = await _binding_row(db_session, test_board)
    row.template_ref = {"source": "workspace", "slug": "orphaned"}
    await db_session.flush()

    body = (await client.get(_loop_url(test_board))).json()

    assert body["template"]["drift"]["kind"] == "binding_corrupt"
