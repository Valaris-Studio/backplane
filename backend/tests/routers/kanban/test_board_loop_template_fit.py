# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""GET /boards/{id}/loop-templates/{ref}/fit — the bind step's first question.

Member-gated because it is a READ: seeing how well a template fits a board is
the same class of fact as seeing the board's columns, and the operator who has
to decide whether to bind needs it before they have admin intent. Applying the
fixes it advertises is admin, and lives in p2-02.

`{ref}` resolves through the same P1 resolver the catalog uses, so a system
slug and a workspace template uuid are interchangeable here.
"""

from unittest.mock import patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column, ColumnType
from app.models.user import User
from app.models.workspace import Workspace
from app.services.loop_template_render import SlotSpec, TemplateContent
from app.services.loop_templates._types import SystemTemplate

pytestmark = pytest.mark.anyio

BASE_URL = "/api/workspaces/default/boards"

FIT_CONTENT = TemplateContent(
    system_prompt="Run <<RUN_LABEL>> on <<REPO_URL>>.",
    loop_prompt="Advance <<RUN_LABEL>>.",
    slots=[
        SlotSpec(name="RUN_LABEL", kind="scalar", required=True),
        SlotSpec(name="REPO_URL", kind="scalar"),
    ],
    setup_contract={
        "required_column_types": ["active", "done"],
        "requires_run_label": True,
        "git_repo_bound": True,
    },
)

FIT_DOUBLE = SystemTemplate(
    slug="test-fit-loop",
    version=1,
    name="Test Fit Loop",
    content=FIT_CONTENT,
    profile={"tagline": "A tiny template for fit tests"},
)


# B7 AC1 needs a contract that ASKS for a pinned note; FIT_DOUBLE deliberately
# does not, so the null `fix_id` gets its own double rather than widening the
# contract every other test in this module asserts against.
SEED_DOUBLE = SystemTemplate(
    slug="test-fit-seed-loop",
    version=1,
    name="Test Fit Seed Loop",
    content=TemplateContent(
        system_prompt="Run <<RUN_LABEL>>.",
        loop_prompt="Advance <<RUN_LABEL>>.",
        slots=[SlotSpec(name="RUN_LABEL", kind="scalar", required=True)],
        setup_contract={"pinned_notes": ["seed"]},
    ),
    profile={"tagline": "A tiny template that wants a seed note"},
)


def _fit_url(board: Board, ref: str = FIT_DOUBLE.slug) -> str:
    return f"{BASE_URL}/{board.id}/loop-templates/{ref}/fit"


@pytest.fixture
def system_fit_double():
    """Resolve the stand-in alongside the real catalog, patching the LOOKUP so
    a real system slug still takes the identical code path."""
    from app.services import loop_templates as registry

    real = registry.get_system_template

    doubles = {FIT_DOUBLE.slug: FIT_DOUBLE, SEED_DOUBLE.slug: SEED_DOUBLE}

    def _lookup(slug: str):
        return doubles.get(slug) or real(slug)

    with patch(
        "app.services.loop_template.get_system_template", side_effect=_lookup
    ):
        yield FIT_DOUBLE


async def _column(
    db: AsyncSession, board: Board, name: str, column_type: ColumnType
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


async def test_fit_member_200(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    system_fit_double,
):
    """The happy path serves the full report shape the bind step consumes."""
    await _column(db_session, test_board, "In Progress", ColumnType.active)
    test_board.loop_config = {"completion_query": {"label": "loop-8"}}
    await db_session.flush()

    response = await client.get(_fit_url(test_board))

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["template"] == {"ref": FIT_DOUBLE.slug, "version": 1}
    assert data["board_frozen"] is False
    assert data["autofill"]["RUN_LABEL"]["value"] == "loop-8"

    by_id = {check["id"]: check for check in data["checks"]}
    assert by_id["column:active"]["status"] == "ok"
    assert by_id["column:done"]["status"] == "missing"
    assert by_id["column:done"]["fix_id"] == "create_column:done"


async def test_fit_non_member_403(
    client: AsyncClient,
    db_session: AsyncSession,
    second_user: User,
    system_fit_double,
):
    """A user outside the workspace cannot probe another org's board setup.

    Same shape as test_loop_templates.py's membership test: a foreign
    workspace with a board the caller has no membership for.
    """
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

    response = await client.get(
        f"/api/workspaces/foreign/boards/{foreign_board.id}"
        f"/loop-templates/{FIT_DOUBLE.slug}/fit"
    )

    assert response.status_code == 403, response.text


@pytest_asyncio.fixture
async def role_client(db_session: AsyncSession) -> AsyncClient:
    """No get_current_user override, so the real dev-tier X-User-Email path
    runs and the ROLE gate is what decides. The default `client` fixture
    authenticates as an owner and can therefore never show a member/admin
    distinction. (Same shape as test_loop_templates.py's gating matrix.)"""
    from app.main import create_app

    app = create_app()

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


async def test_fit_plain_member_200(
    role_client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    system_fit_double,
):
    """Member-gated, NOT admin-gated: the operator deciding whether to bind
    needs this answer before they have any admin intent, and reading which
    requirements a board meets is the same class of fact as reading its
    columns. Admin belongs on APPLYING the fixes (p2-02)."""
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

    response = await role_client.get(
        _fit_url(test_board), headers={"X-User-Email": member.email}
    )

    assert response.status_code == 200, response.text


async def test_fit_board_from_another_workspace_404(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    second_user: User,
    system_fit_double,
):
    """A board id from a workspace the caller DOES belong to elsewhere must
    not be readable through this workspace's URL — the board must be scoped to
    the workspace in the path, not merely exist."""
    from app.models.workspace import WorkspaceMember, WorkspaceRole

    other_ws = Workspace(name="Other WS", slug="other-ws", created_by=second_user.id)
    db_session.add(other_ws)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=other_ws.id,
            user_id=second_user.id,
            role=WorkspaceRole.owner,
        )
    )
    foreign_board = Board(
        workspace_id=other_ws.id,
        name="Foreign",
        slug="foreign-b",
        created_by=second_user.id,
    )
    db_session.add(foreign_board)
    await db_session.flush()

    # `default` is test_workspace's slug; the board belongs to other_ws.
    response = await client.get(
        f"{BASE_URL}/{foreign_board.id}/loop-templates/{FIT_DOUBLE.slug}/fit"
    )

    assert response.status_code == 404, response.text


async def test_fit_unknown_ref_404(client: AsyncClient, test_board: Board):
    """A ref naming no template is not found — never an empty report, which
    would read as "this template needs nothing"."""
    response = await client.get(_fit_url(test_board, "no-such-template"))

    assert response.status_code == 404


async def test_fit_unknown_board_404(client: AsyncClient, system_fit_double):
    import uuid

    response = await client.get(
        f"{BASE_URL}/{uuid.uuid4()}/loop-templates/{FIT_DOUBLE.slug}/fit"
    )

    assert response.status_code == 404


async def test_fit_frozen_board_reports_flag(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    system_fit_double,
):
    """AC5: freezing blocks writes, not reads. The endpoint answers 200 and
    the flag tells the UI to disable the one-click fixes."""
    test_board.is_frozen = True
    await db_session.flush()

    response = await client.get(_fit_url(test_board))

    assert response.status_code == 200, response.text
    assert response.json()["board_frozen"] is True


async def test_fit_resolves_a_workspace_template_by_id(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    test_user: User,
):
    """`{ref}` is the P1 resolver's ref: a workspace template's uuid must work
    exactly where a system slug does, or half the catalog cannot be fitted."""
    from app.models.config_template import ConfigTemplate

    content = FIT_CONTENT.model_dump()
    template = ConfigTemplate(
        workspace_id=test_workspace.id,
        kind="loop",
        slug="workspace-fit-loop",
        name="Workspace Fit Loop",
        version=1,
        profile={},
        content=content,
        draft_profile={},
        draft_content=content,
        created_by_id=test_user.id,
    )
    db_session.add(template)
    await db_session.flush()

    response = await client.get(_fit_url(test_board, str(template.id)))

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["template"] == {"ref": str(template.id), "version": 1}
    assert {c["id"] for c in data["checks"]} >= {"column:active", "column:done"}


async def test_fit_writes_nothing(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    system_fit_double,
):
    """A GET that mutated would log an activity row per keystroke of the
    template chooser."""
    from sqlalchemy import func, select

    from app.models.activity import Activity

    before = await db_session.scalar(select(func.count()).select_from(Activity))

    assert (await client.get(_fit_url(test_board))).status_code == 200

    assert await db_session.scalar(select(func.count()).select_from(Activity)) == before
    assert test_board.loop_config is None


# --- POST .../fit/apply (p2-02) -------------------------------------------
#
# Applying is ADMIN, where reading the same report is member-gated: creating
# columns, authoring a definition key and pinning a note are board changes, and
# the fit report exists precisely so a non-admin can see what an admin needs to
# do.


def _apply_url(board: Board, ref: str = FIT_DOUBLE.slug) -> str:
    return f"{BASE_URL}/{board.id}/loop-templates/{ref}/fit/apply"


async def _mint_agent_key(db: AsyncSession, owner: User) -> str:
    """A real vlr_ key bound to an active agent owned by the workspace OWNER.

    Binding it to the owner is the point: the caller's ROLE is beyond reproach,
    so a 403 can only come from `forbid_agent_callers` — which is what
    distinguishes "agents are banned" from "that user lacked admin".
    """
    import hashlib
    import secrets

    from app.models.agents.agent import Agent, AgentType
    from app.models.api_key import ApiKey

    raw = "vlr_" + secrets.token_urlsafe(32)
    api_key = ApiKey(
        user_id=owner.id,
        name="fit-apply-key",
        key_hash=hashlib.sha256(raw.encode()).hexdigest(),
        key_prefix=raw[:8],
    )
    db.add(api_key)
    await db.flush()
    db.add(
        Agent(
            name="fit-apply-agent",
            agent_type=AgentType.coding,
            description="gating pin",
            created_by_id=owner.id,
            is_active=True,
            api_key_id=api_key.id,
        )
    )
    await db.flush()
    return raw


async def test_apply_creates_the_column_and_returns_the_fresh_report(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    system_fit_double,
):
    """The happy path: one request repairs the board and answers with the
    post-apply checklist, so the UI never has to re-GET to redraw it."""
    response = await client.post(
        _apply_url(test_board), json={"fix_ids": ["create_column:done"]}
    )

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["applied"] == [
        {
            "fix_id": "create_column:done",
            "outcome": "applied",
            "detail": "created column 'Done'",
        }
    ]
    by_id = {check["id"]: check for check in data["checks"]}
    assert by_id["column:done"]["status"] == "ok"
    assert by_id["column:done"]["fix_id"] is None


async def test_apply_admin_only(
    role_client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_workspace: Workspace,
    system_fit_double,
):
    """A plain member reads the report but cannot act on it. Same user, same
    board, two verbs — only the write is refused."""
    from app.models.workspace import WorkspaceMember, WorkspaceRole

    member = User(email="apply-member@valaris.dev", name="apply-member")
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
    headers = {"X-User-Email": member.email}

    readable = await role_client.get(_fit_url(test_board), headers=headers)
    assert readable.status_code == 200, readable.text

    response = await role_client.post(
        _apply_url(test_board),
        json={"fix_ids": ["create_column:done"]},
        headers=headers,
    )

    assert response.status_code == 403, response.text
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(Column)
            .where(Column.board_id == test_board.id)
        )
        == 0
    )


async def test_apply_agent_caller_403(
    role_client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_user: User,
    system_fit_double,
):
    """A runner renders a bound loop; it does not restructure the board it is
    working. The key here belongs to the OWNER, so only the agent ban can 403."""
    raw = await _mint_agent_key(db_session, test_user)
    headers = {"Authorization": f"Bearer {raw}"}

    readable = await role_client.get(_fit_url(test_board), headers=headers)
    assert readable.status_code == 200, readable.text

    response = await role_client.post(
        _apply_url(test_board),
        json={"fix_ids": ["create_column:done"]},
        headers=headers,
    )

    assert response.status_code == 403, response.text


async def test_apply_frozen_409(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    system_fit_double,
):
    """A frozen board refuses the whole request. 409, not the 403 the card's
    prose guessed: BoardFrozenError subclasses ConflictError, and every other
    board write on this platform answers the same way."""
    test_board.is_frozen = True
    await db_session.flush()

    response = await client.post(
        _apply_url(test_board), json={"fix_ids": ["create_column:done"]}
    )

    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "board_frozen"
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(Column)
            .where(Column.board_id == test_board.id)
        )
        == 0
    )


async def test_apply_unknown_fix_422_writes_nothing(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    system_fit_double,
):
    """One bogus id voids the batch. The good id alongside it must NOT land,
    or the operator cannot tell what state the board is in."""
    response = await client.post(
        _apply_url(test_board),
        json={"fix_ids": ["create_column:done", "rm -rf"]},
    )

    assert response.status_code == 422, response.text
    assert response.json()["error_code"] == "unknown_fix"
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(Column)
            .where(Column.board_id == test_board.id)
        )
        == 0
    )


async def test_apply_unknown_ref_404(client: AsyncClient, test_board: Board):
    """A ref naming no template cannot be fitted, so it cannot be applied —
    never an empty batch that reports success having done nothing."""
    response = await client.post(
        _apply_url(test_board, "no-such-template"), json={"fix_ids": []}
    )

    assert response.status_code == 404


async def test_apply_is_idempotent_over_the_wire(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    system_fit_double,
):
    """A double-clicked button and a retried request are the same request."""
    first = await client.post(
        _apply_url(test_board), json={"fix_ids": ["create_column:done"]}
    )
    second = await client.post(
        _apply_url(test_board), json={"fix_ids": ["create_column:done"]}
    )

    assert first.json()["applied"][0]["outcome"] == "applied"
    assert second.json()["applied"][0]["outcome"] == "skipped_already_satisfied"
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(Column)
            .where(
                Column.board_id == test_board.id,
                Column.column_type == ColumnType.done,
            )
        )
        == 1
    )


async def test_fit_withholds_the_seed_note_fix_id_when_no_run_label_exists(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_user: User,
    system_fit_double,
):
    """B7 AC1 over the wire: the null `fix_id` is part of the RESPONSE BODY
    contract, not merely a service-internal decision. The bind step keys the
    Auto-fix button off exactly this field."""
    backlog = await _column(db_session, test_board, "To Do", ColumnType.backlog)
    db_session.add(
        Card(
            board_id=test_board.id,
            column_id=backlog.id,
            title="Unlabelled",
            position=1024.0,
            created_by=test_user.id,
            labels=[],
        )
    )
    await db_session.flush()

    response = await client.get(_fit_url(test_board, SEED_DOUBLE.slug))

    assert response.status_code == 200, response.text
    by_id = {check["id"]: check for check in response.json()["checks"]}
    note_check = by_id["pinned_note:seed"]
    assert note_check["status"] == "missing"
    assert note_check["fix_id"] is None
    assert "no run label to name the note after" in note_check["evidence"]


async def test_fit_offers_the_seed_note_fix_id_once_a_card_is_labelled(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_user: User,
    system_fit_double,
):
    """B7 AC2 over the wire — the negative above must not be the only shape the
    endpoint can produce, or an always-null field would satisfy it."""
    backlog = await _column(db_session, test_board, "To Do", ColumnType.backlog)
    db_session.add(
        Card(
            board_id=test_board.id,
            column_id=backlog.id,
            title="Labelled",
            position=1024.0,
            created_by=test_user.id,
            labels=["loop-9"],
        )
    )
    await db_session.flush()

    response = await client.get(_fit_url(test_board, SEED_DOUBLE.slug))

    assert response.status_code == 200, response.text
    by_id = {check["id"]: check for check in response.json()["checks"]}
    assert by_id["pinned_note:seed"]["fix_id"] == "seed_note_skeleton"
