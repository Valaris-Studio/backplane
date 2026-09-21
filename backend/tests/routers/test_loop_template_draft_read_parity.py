# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Every rehearsal endpoint judges the DRAFT — one contract, four call sites.

A rehearsal endpoint is one that answers "what would this template do?" without
committing anything to a running loop: lint, preview (workspace and board), fit,
fit/apply. They all exist so an operator editing a template can see the
consequences of what is ON THEIR SCREEN, which is the draft half. `lint` has
always read it (see LoopTemplateService.lint's docstring); the others read the
published half and silently answered about the version before the edit.

The divergence only appears for a PUBLISHED template with pending edits:
`LoopTemplateService.get` resolves `show_draft = draft or not published`, so an
unpublished row serves its draft either way and a system template has one half
only. That is why the fixture here is published-at-v3-then-edited and nothing
else reproduces the bug.

This file is the parity pin (card B4 AC6): each rehearsal path is exercised
through its REAL router against one shared fixture, and each assertion reads a
draft-only fact out of the live response rather than a copy of the expected
content. A fifth rehearsal endpoint added later has to join this table
deliberately.
"""

import uuid

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.config_template import ConfigTemplate
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace
from app.services.loop_template_render import SlotSpec, TemplateContent

pytestmark = pytest.mark.anyio

WS_URL = "/api/workspaces/default/loop-templates"
BOARD_URL = "/api/workspaces/default/boards"

# v3 — what the operator PUBLISHED. No REVIEW column required, one slot.
PUBLISHED_CONTENT = TemplateContent(
    system_prompt="Published kernel for <<RUN_LABEL>>.",
    loop_prompt="Advance <<RUN_LABEL>>.",
    slots=[SlotSpec(name="RUN_LABEL", kind="scalar", required=True, example="v3")],
    setup_contract={"required_column_types": ["active"]},
)

# The pending edit: a second required slot, a new required column type, and a
# prompt body no v3 render could ever produce. Each is a draft-only fact one of
# the four endpoints reports, so no assertion below can pass by accident.
DRAFT_CONTENT = TemplateContent(
    system_prompt="DRAFT kernel for <<RUN_LABEL>> in <<DRAFT_ONLY_SLOT>>.",
    loop_prompt="Advance <<RUN_LABEL>> against <<DRAFT_ONLY_SLOT>>.",
    slots=[
        SlotSpec(name="RUN_LABEL", kind="scalar", required=True, example="draft"),
        SlotSpec(
            name="DRAFT_ONLY_SLOT", kind="scalar", required=True, example="draft-only"
        ),
    ],
    setup_contract={"required_column_types": ["active", "review"]},
)


@pytest_asyncio.fixture
async def edited_template(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
) -> ConfigTemplate:
    """Published at v3, then edited — the only state where the halves differ."""
    template = ConfigTemplate(
        workspace_id=test_workspace.id,
        kind="loop",
        slug="parity-loop",
        name="Parity Loop",
        version=3,
        profile={"tagline": "published"},
        content=PUBLISHED_CONTENT.model_dump(),
        draft_profile={"tagline": "draft"},
        draft_content=DRAFT_CONTENT.model_dump(),
        created_by_id=test_user.id,
    )
    db_session.add(template)
    await db_session.flush()
    return template


async def _lint(client: AsyncClient, ref: str, board: Board) -> dict:
    response = await client.post(f"{WS_URL}/{ref}/lint", json={})
    assert response.status_code == 200, response.text
    return response.json()


async def _workspace_preview(client: AsyncClient, ref: str, board: Board) -> dict:
    response = await client.post(f"{WS_URL}/{ref}/preview", json={})
    assert response.status_code == 200, response.text
    return response.json()


async def _board_preview(client: AsyncClient, ref: str, board: Board) -> dict:
    response = await client.post(
        f"{BOARD_URL}/{board.id}/loop-templates/{ref}/preview", json={}
    )
    assert response.status_code == 200, response.text
    return response.json()


async def _fit(client: AsyncClient, ref: str, board: Board) -> dict:
    response = await client.get(f"{BOARD_URL}/{board.id}/loop-templates/{ref}/fit")
    assert response.status_code == 200, response.text
    return response.json()


async def _proposed_fit(client: AsyncClient, ref: str, board: Board) -> dict:
    response = await client.post(
        f"{BOARD_URL}/{board.id}/loop-templates/{ref}/fit", json={"slot_values": {}}
    )
    assert response.status_code == 200, response.text
    return response.json()


async def _fit_apply(client: AsyncClient, ref: str, board: Board) -> dict:
    response = await client.post(
        f"{BOARD_URL}/{board.id}/loop-templates/{ref}/fit/apply", json={"fix_ids": []}
    )
    assert response.status_code == 200, response.text
    return response.json()


def _slot_names(payload: dict) -> set[str]:
    """Slot names the response reports — the shape differs per endpoint."""
    if "used_values" in payload:
        return set(payload["used_values"]) | set(payload.get("missing_required", []))
    return set()


def _draft_only_evidence(payload: dict) -> bool:
    """Does this response describe the DRAFT half?

    Read out of the live payload, never compared against a copy of
    DRAFT_CONTENT: each endpoint reports the draft through whatever field it
    owns, and the draft-only slot / draft-only column are facts v3 cannot
    produce.
    """
    if "used_values" in payload:
        return "DRAFT_ONLY_SLOT" in _slot_names(payload)
    if "checks" in payload:
        return any(check["id"] == "column:review" for check in payload["checks"])
    return False


# Keyed by the ROUTE each driver exercises, so the coverage test below can
# compare this table against the app's real route table rather than against a
# second hand-written list.
REHEARSAL_DRIVERS = {
    ("POST", "/api/workspaces/{slug}/loop-templates/{ref}/preview"): _workspace_preview,
    (
        "POST",
        "/api/workspaces/{slug}/boards/{board_id}/loop-templates/{ref}/preview",
    ): _board_preview,
    ("GET", "/api/workspaces/{slug}/boards/{board_id}/loop-templates/{ref}/fit"): _fit,
    ("POST", "/api/workspaces/{slug}/boards/{board_id}/loop-templates/{ref}/fit"): _proposed_fit,
    (
        "POST",
        "/api/workspaces/{slug}/boards/{board_id}/loop-templates/{ref}/fit/apply",
    ): _fit_apply,
    ("POST", "/api/workspaces/{slug}/loop-templates/{ref}/lint"): _lint,
}

# Everything the SHIPPED app exposes that rehearses a template: a route under
# loop-templates whose tail is one of the rehearsal verbs. Read off
# `create_app()` rather than listed by hand, so a sixth rehearsal endpoint
# added later fails the coverage test until it is driven here.
_REHEARSAL_SUFFIXES = ("/fit", "/fit/apply", "/preview", "/lint")


def _shipped_rehearsal_routes() -> set[tuple[str, str]]:
    from app.main import create_app

    routes = set()
    for route in create_app().routes:
        path = getattr(route, "path", "")
        if "loop-templates" not in path or not path.endswith(_REHEARSAL_SUFFIXES):
            continue
        for method in getattr(route, "methods", set()) - {"HEAD", "OPTIONS"}:
            routes.add((method, path))
    return routes


def test_every_shipped_rehearsal_route_is_driven_here():
    """AC6's real teeth — the enumeration is the app's, not a copy of it.

    Deleting a row from REHEARSAL_DRIVERS, or shipping a new rehearsal
    endpoint without driving it, fails HERE. Without this the parametrize
    table below would merely run fewer cases and stay green.
    """
    assert _shipped_rehearsal_routes() == set(REHEARSAL_DRIVERS)


# One table, two uses: the coverage test above proves it matches the app, and
# the parametrize below drives every entry. `lint` is excluded from the draft
# assertion only because its response carries findings rather than the slot or
# column names the other four report — it has its own pin further down.
def _case_id(path: str) -> str:
    """`board-fit/apply`, `workspace-preview` — a failing id names the route."""
    scope = "board" if "{board_id}" in path else "workspace"
    return f"{scope}-{path.rsplit('/loop-templates/{ref}/', 1)[-1]}"


REHEARSAL_PATHS = [
    pytest.param(driver, id=_case_id(path))
    for (_method, path), driver in REHEARSAL_DRIVERS.items()
    if driver is not _lint
]


@pytest.mark.parametrize("call", REHEARSAL_PATHS)
async def test_every_rehearsal_path_judges_the_draft(
    call,
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    edited_template: ConfigTemplate,
):
    """AC6 — drop `draft=True` from any one call site and exactly one id here
    turns red, naming the endpoint that regressed."""
    payload = await call(client, str(edited_template.id), test_board)

    assert _draft_only_evidence(payload), payload


async def test_lint_is_the_reference_implementation(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """Lint already read the draft before this card; it anchors the row the
    other three were brought up to.

    Pinned through a repo-fact the DRAFT body carries and the published one
    does not, so the finding can only come from the draft half.
    """
    published = PUBLISHED_CONTENT.model_dump()
    draft = DRAFT_CONTENT.model_dump()
    draft["system_prompt"] = "Clone https://github.com/example/project."
    template = ConfigTemplate(
        workspace_id=test_workspace.id,
        kind="loop",
        slug="parity-lint",
        name="Parity Lint",
        version=3,
        profile={},
        content=published,
        draft_profile={},
        draft_content=draft,
        created_by_id=test_user.id,
    )
    db_session.add(template)
    await db_session.flush()

    response = await client.post(f"{WS_URL}/{template.id}/lint", json={})

    assert response.status_code == 200, response.text
    matches = [finding.get("match") or "" for finding in response.json()["findings"]]
    assert any("example/project" in match for match in matches), matches


async def test_unpublished_template_is_unchanged(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """AC4 — version 0 already served its draft (`show_draft = draft or not
    published`), so this card cannot have moved it."""
    template = ConfigTemplate(
        workspace_id=test_workspace.id,
        kind="loop",
        slug="parity-unpublished",
        name="Parity Unpublished",
        version=0,
        profile={},
        content={},
        draft_profile={"tagline": "draft"},
        draft_content=DRAFT_CONTENT.model_dump(),
        created_by_id=test_user.id,
    )
    db_session.add(template)
    await db_session.flush()

    for call in (_workspace_preview, _board_preview, _fit, _fit_apply):
        payload = await call(client, str(template.id), test_board)
        assert _draft_only_evidence(payload), (call.__name__, payload)


async def test_system_template_is_unchanged(
    client: AsyncClient, test_board: Board, test_workspace: Workspace
):
    """AC5 — a system template has one half (`get` returns the same dict with
    or without `draft`), so every rehearsal path must still answer for it.

    Uses a REAL catalog slug so the assertion cannot drift from the shipped
    resolver, and asserts the RENDERED body rather than just a 200: a draft
    lookup that silently fell through to an empty half would still be a 200.
    """
    from app.services.loop_templates import listed_templates

    template = listed_templates()[0]

    fit = await _fit(client, template.slug, test_board)
    preview = await _workspace_preview(client, template.slug, test_board)

    assert fit["template"] == {"ref": template.slug, "version": template.version}
    assert preview["template"] == {"ref": template.slug, "version": template.version}

    # Content, not just a 200: a draft lookup that fell through to an empty
    # half would still answer 200, with a blank kernel and an empty checklist.
    expected_columns = {
        f"column:{name}"
        for name in (template.content.setup_contract or {}).get(
            "required_column_types", []
        )
    }
    assert {check["id"] for check in fit["checks"]} >= expected_columns
    assert preview["tools"] == list(template.content.tools)
    assert set(preview["used_values"]) <= {slot.name for slot in template.content.slots}


async def test_unknown_ref_still_404s(
    client: AsyncClient, test_board: Board, test_workspace: Workspace
):
    """Reading the draft half must not turn a wrong URL into a 200."""
    missing = str(uuid.uuid4())

    response = await client.get(
        f"{BOARD_URL}/{test_board.id}/loop-templates/{missing}/fit"
    )

    assert response.status_code == 404, response.text
