# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""POST .../loop-templates/{ref}/preview — see the render before saving it.

Two routes, one answer shape. The workspace-scoped one lets a template AUTHOR
check the kernel with example values and no board in sight; the board-scoped
one answers the bind step's question — what would THIS board actually run?

Member-gated reads that write nothing: previewing is the step before an
operator has any admin intent, exactly like the fit report next door.
"""

from unittest.mock import patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace
from app.services.loop_template_render import SlotSpec, TemplateContent
from app.services.loop_templates._types import SystemTemplate

pytestmark = pytest.mark.anyio

WS_URL = "/api/workspaces/default/loop-templates"
BOARD_URL = "/api/workspaces/default/boards"

PREVIEW_CONTENT = TemplateContent(
    system_prompt="You run <<RUN_LABEL>> on <<REPO_URL>>.",
    loop_prompt="Advance <<RUN_LABEL>>. Notes: <<NOTES>>",
    slots=[
        SlotSpec(name="RUN_LABEL", kind="scalar", required=True, example="loop-8"),
        SlotSpec(
            name="REPO_URL", kind="scalar", default="https://example.test/fallback"
        ),
        SlotSpec(name="NOTES", kind="block", required=True),
    ],
    tools=["mcp__valaris__get_card", "mcp__valaris__set_board_loop"],
    rails_defaults={"budget_usd": 30.0, "max_iterations": 50},
    setup_contract={"requires_run_label": True},
)

PREVIEW_DOUBLE = SystemTemplate(
    slug="test-preview-loop",
    version=3,
    name="Test Preview Loop",
    content=PREVIEW_CONTENT,
    profile={"tagline": "A tiny template for preview tests"},
)

GO_MANIFEST = (
    "\n\n## Tools available\n\n"
    "mcp__valaris__get_card\n"
    "mcp__valaris__set_board_loop\n"
    '\nIf keyword search misses a tool listed here, load it with ToolSearch("select:<name>").\n'
)


@pytest.fixture
def system_preview_double():
    """Patch the LOOKUP, not the catalog, so a real slug still takes the same
    code path this stand-in does."""
    from app.services import loop_templates as registry

    real = registry.get_system_template

    def _lookup(slug: str):
        return PREVIEW_DOUBLE if slug == PREVIEW_DOUBLE.slug else real(slug)

    with patch("app.services.loop_template.get_system_template", side_effect=_lookup):
        yield PREVIEW_DOUBLE


def _ws_url(ref: str = PREVIEW_DOUBLE.slug) -> str:
    return f"{WS_URL}/{ref}/preview"


def _board_url(board: Board, ref: str = PREVIEW_DOUBLE.slug) -> str:
    return f"{BOARD_URL}/{board.id}/loop-templates/{ref}/preview"


async def test_preview_boardless_uses_examples_and_defaults(
    client: AsyncClient, test_workspace: Workspace, system_preview_double
):
    """No board, no body: the template author still sees a rendered kernel,
    because that is what `example`/`default` are FOR."""
    response = await client.post(_ws_url(), json={})

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["template"] == {"ref": PREVIEW_DOUBLE.slug, "version": 3}
    assert data["system_prompt"] == ("You run loop-8 on https://example.test/fallback.")
    assert data["used_values"]["RUN_LABEL"] == {"value": "loop-8", "source": "example"}
    assert data["used_values"]["REPO_URL"]["source"] == "default"


async def test_preview_lists_missing_required_not_422(
    client: AsyncClient, test_workspace: Workspace, system_preview_double
):
    """NOTES is required with neither default nor example. PUT /loop would 422;
    preview must answer 200 and SAY so, or the operator cannot see the hole."""
    response = await client.post(_ws_url(), json={})

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["missing_required"] == ["NOTES"]
    assert "required_slot_missing" in [f["code"] for f in data["findings"]]
    assert data["loop_prompt"].endswith("Notes: <<NOTES>>")


async def test_preview_supplied_values_win(
    client: AsyncClient, test_workspace: Workspace, system_preview_double
):
    response = await client.post(
        _ws_url(), json={"slot_values": {"RUN_LABEL": "typed", "NOTES": "hello"}}
    )

    data = response.json()
    assert data["loop_prompt"] == "Advance typed. Notes: hello"
    assert data["used_values"]["RUN_LABEL"]["source"] == "supplied"
    assert data["missing_required"] == []


async def test_preview_tools_manifest_matches_runner_string(
    client: AsyncClient, test_workspace: Workspace, system_preview_double
):
    """Golden string from runner/internal/workloop/loopmode.go's toolManifest.

    If this fails after a runner change, update render_runner_tools_manifest
    and this constant together — the manifest is the agent's tool vocabulary,
    and a preview that shows a different one teaches the operator a lie.
    """
    response = await client.post(_ws_url(), json={})

    data = response.json()
    assert data["loop_prompt_with_tools_manifest"] == data["loop_prompt"] + GO_MANIFEST
    assert data["tools"] == [
        "mcp__valaris__get_card",
        "mcp__valaris__set_board_loop",
    ]


async def test_preview_escapes_go_braces(
    client: AsyncClient, test_workspace: Workspace, system_preview_double
):
    """`{{` in a value would be parsed as a text/template action by the runner.
    The preview shows the escaped form because that IS the stored string."""
    response = await client.post(
        _ws_url(), json={"slot_values": {"RUN_LABEL": "a{{b", "NOTES": "n"}}
    )

    data = response.json()
    assert data["loop_prompt"] == 'Advance a{{"{{"}}b. Notes: n'


async def test_preview_unknown_slot_finding(
    client: AsyncClient, test_workspace: Workspace, system_preview_double
):
    response = await client.post(
        _ws_url(), json={"slot_values": {"NOT_A_SLOT": "x", "NOTES": "n"}}
    )

    assert response.status_code == 200, response.text
    findings = response.json()["findings"]
    assert [f["code"] for f in findings if f["code"] == "unknown_slot"] == [
        "unknown_slot"
    ]


async def test_preview_unknown_ref_404(
    client: AsyncClient, test_workspace: Workspace, system_preview_double
):
    response = await client.post(_ws_url("no-such-template"), json={})

    assert response.status_code == 404, response.text


async def test_preview_writes_nothing(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    system_preview_double,
):
    """The card's hardest constraint: preview persists NOTHING. A board whose
    loop_config changed after a look would make preview a save button."""
    test_board.loop_config = {"budget_usd": 7.5}
    await db_session.flush()

    await client.post(_board_url(test_board), json={"slot_values": {"NOTES": "n"}})
    await db_session.refresh(test_board)

    assert test_board.loop_config == {"budget_usd": 7.5}

    from app.models.config_template import BoardLoopTemplateBinding
    from sqlalchemy import func, select

    bindings = await db_session.scalar(
        select(func.count()).select_from(BoardLoopTemplateBinding)
    )
    assert bindings == 0


async def test_preview_board_autofill_and_override(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    system_preview_double,
):
    """The board-scoped route is the bind step's rehearsal: RUN_LABEL comes off
    the board's own completion_query, and a supplied value still outranks it."""
    test_board.loop_config = {"completion_query": {"label": "loop-8"}}
    await db_session.flush()

    autofilled = await client.post(_board_url(test_board), json={})
    assert autofilled.status_code == 200, autofilled.text
    assert autofilled.json()["used_values"]["RUN_LABEL"] == {
        "value": "loop-8",
        "source": "autofill",
    }

    overridden = await client.post(
        _board_url(test_board), json={"slot_values": {"RUN_LABEL": "mine"}}
    )
    assert overridden.json()["used_values"]["RUN_LABEL"] == {
        "value": "mine",
        "source": "supplied",
    }


async def test_preview_rails_overlay_from_board(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    system_preview_double,
):
    """A board already configured has rails an operator tuned by hand. Preview
    must show THOSE, not the template's defaults, or it promises a budget the
    bind would not actually apply."""
    test_board.loop_config = {"budget_usd": 12.5}
    await db_session.flush()

    response = await client.post(_board_url(test_board), json={})

    rails = response.json()["rails"]
    assert rails["budget_usd"] == 12.5
    # A rail the board never set still falls back to the template's default.
    assert rails["max_iterations"] == 50


async def test_preview_overlays_only_rails_from_the_board_config(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    system_preview_double,
):
    """`loop_config` holds the rendered PROMPTS and the runner's bookkeeping
    alongside the rails. Overlaying it wholesale would put `system_prompt` and
    `version` into `rails` — config the bind step would then try to save back."""
    test_board.loop_config = {
        "budget_usd": 12.5,
        "system_prompt": "a prompt that is not a rail",
        "loop_prompt": "nor is this",
        "tools": ["mcp__valaris__get_card"],
        "version": 9,
        "budget_epoch": "2026-08-17T00:00:00Z",
    }
    await db_session.flush()

    rails = (await client.post(_board_url(test_board), json={})).json()["rails"]

    assert rails["budget_usd"] == 12.5
    for leaked in ("system_prompt", "loop_prompt", "tools", "version", "budget_epoch"):
        assert leaked not in rails


async def test_preview_boardless_ignores_any_board_rails(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    system_preview_double,
):
    """The workspace route has no board, so it can only ever show the template's
    own rails — pinned so the two routes cannot quietly converge."""
    test_board.loop_config = {"budget_usd": 12.5}
    await db_session.flush()

    response = await client.post(_ws_url(), json={})

    assert response.json()["rails"]["budget_usd"] == 30.0


async def test_preview_board_unknown_ref_404(
    client: AsyncClient, test_board: Board, system_preview_double
):
    response = await client.post(_board_url(test_board, "no-such-template"), json={})

    assert response.status_code == 404, response.text


async def test_preview_board_non_member_403(
    client: AsyncClient,
    db_session: AsyncSession,
    second_user: User,
    system_preview_double,
):
    from app.models.workspace import WorkspaceMember, WorkspaceRole

    foreign = Workspace(name="Foreign", slug="foreign", created_by=second_user.id)
    db_session.add(foreign)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=foreign.id, user_id=second_user.id, role=WorkspaceRole.owner
        )
    )
    foreign_board = Board(
        workspace_id=foreign.id,
        name="Foreign Board",
        slug="foreign-board",
        created_by=second_user.id,
    )
    db_session.add(foreign_board)
    await db_session.flush()

    response = await client.post(
        f"/api/workspaces/foreign/boards/{foreign_board.id}"
        f"/loop-templates/{PREVIEW_DOUBLE.slug}/preview",
        json={},
    )

    assert response.status_code == 403, response.text


@pytest_asyncio.fixture
async def role_client(db_session: AsyncSession) -> AsyncClient:
    """No get_current_user override, so the real X-User-Email path runs and the
    ROLE gate decides. The default `client` authenticates as an owner and could
    never show a member/admin distinction."""
    from app.main import create_app

    app = create_app()

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


async def test_preview_plain_member_200(
    role_client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    system_preview_double,
):
    """Member, not admin: looking at what a template would render is the same
    class of act as reading the board's columns. Admin belongs on the save."""
    from app.models.workspace import WorkspaceMember, WorkspaceRole

    member = User(email="member@valaris.dev", name="member")
    db_session.add(member)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=member.id,
            role=WorkspaceRole.member,
        )
    )
    await db_session.flush()

    for url in (_ws_url(), _board_url(test_board)):
        response = await role_client.post(
            url, json={}, headers={"X-User-Email": member.email}
        )
        assert response.status_code == 200, f"{url}: {response.text}"
