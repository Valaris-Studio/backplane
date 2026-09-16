# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Workspace role matrix for content endpoints (TDD red phase).

Approved matrix (owner-decided):
  - viewer  -> read-only: every content mutation returns 403.
  - member  -> all content mutations EXCEPT container deletes and loop PUT.
  - admin+  -> additionally board/column/channel/git-repo delete and board
               loop config PUT (full replace).
  - reads   -> viewer keeps GET access (board detail, card search, notes,
               board loop config).
  - board delete additionally refuses agent callers (forbid_agent_callers).
  - board loop: GET /loop open to every member incl. viewer; PUT /loop is
    admin+; PATCH /loop/state is member+ (agents must be able to turn the
    loop off autonomously — NO forbid_agent_callers on any loop route; an
    agent key minted by a member can flip the state, one minted by a viewer
    cannot).

Agent-caller mechanism (verified in app/core/auth.py + app/core/workspace.py):
an agent authenticates as `Bearer vlr_...`, which resolves to the agent's
CREATING USER; `WorkspaceDep` then checks that user's WorkspaceMember row —
including `min_role` when set. Agents get no exemption from role checks, so
raising an endpoint to min_role=member keeps agents working exactly when their
creating user holds member or better. The pins below authenticate over the
real API-key path (no `get_current_user` override) so they fail if that
mechanism changes — including the seam pin for an agent created by a plain
member, which is the case a too-strict min_role would break.

Mutations here are expected to FAIL (viewer succeeds today); the member/admin
"allowed" cases and all agent pins are GREEN today and must stay green.
"""

import hashlib
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.main import create_app
from app.models.agents.agent import Agent, AgentType
from app.models.api_key import ApiKey
from app.models.channels.channel import Channel, ChannelType
from app.models.git.git_repo import GitProvider, GitRepo
from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardDependency, CardParticipant
from app.models.kanban.column import Column
from app.models.notes.note import Note
from app.models.resources.resource import Resource, ResourceType
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole


# --- clients & role users ---------------------------------------------------


@pytest_asyncio.fixture
async def role_client(db_session: AsyncSession) -> AsyncClient:
    """Client with NO get_current_user override: dev-tier X-User-Email and the
    real Bearer vlr_ agent path both run through app.core.auth as in prod."""
    app = create_app()

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


async def _make_role_user(
    db: AsyncSession, workspace: Workspace, email: str, role: WorkspaceRole
) -> User:
    user = User(email=email, name=email.split("@")[0])
    db.add(user)
    await db.flush()
    db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role=role))
    await db.flush()
    return user


@dataclass
class MatrixContext:
    db: AsyncSession
    workspace: Workspace
    board: Board
    column: Column
    card: Card
    owner: User
    admin: User
    member: User
    viewer: User


@pytest_asyncio.fixture
async def mctx(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
) -> MatrixContext:
    admin = await _make_role_user(
        db_session, test_workspace, "admin@valaris.dev", WorkspaceRole.admin
    )
    member = await _make_role_user(
        db_session, test_workspace, "member@valaris.dev", WorkspaceRole.member
    )
    viewer = await _make_role_user(
        db_session, test_workspace, "viewer@valaris.dev", WorkspaceRole.viewer
    )
    return MatrixContext(
        db=db_session,
        workspace=test_workspace,
        board=test_board,
        column=test_column,
        card=test_card,
        owner=test_user,
        admin=admin,
        member=member,
        viewer=viewer,
    )


def _as(user: User) -> dict[str, str]:
    return {"X-User-Email": user.email}


def _ws(ctx: MatrixContext, suffix: str = "") -> str:
    return f"/api/workspaces/{ctx.workspace.slug}{suffix}"


def _board(ctx: MatrixContext, suffix: str = "") -> str:
    return _ws(ctx, f"/boards/{ctx.board.id}{suffix}")


# --- per-case entity factories (direct rows, so the request under test is the
# --- ONLY api call a role user makes) ---------------------------------------


async def _make_card(ctx: MatrixContext, title: str = "extra card") -> Card:
    card = Card(
        board_id=ctx.board.id,
        column_id=ctx.column.id,
        title=title,
        description="",
        position=2048.0,
        created_by=ctx.owner.id,
    )
    ctx.db.add(card)
    await ctx.db.flush()
    return card


async def _make_empty_board(ctx: MatrixContext, slug: str) -> Board:
    board = Board(
        workspace_id=ctx.workspace.id,
        name=slug,
        slug=slug,
        created_by=ctx.owner.id,
    )
    ctx.db.add(board)
    await ctx.db.flush()
    return board


async def _make_empty_column(ctx: MatrixContext, name: str = "deletable") -> Column:
    column = Column(
        board_id=ctx.board.id, name=name, position=9999.0, color="#6b7280"
    )
    ctx.db.add(column)
    await ctx.db.flush()
    return column


async def _make_note(ctx: MatrixContext, board_scoped: bool) -> Note:
    note = Note(
        workspace_id=ctx.workspace.id,
        board_id=ctx.board.id if board_scoped else None,
        title="matrix note",
        content="content",
        created_by=ctx.owner.id,
    )
    ctx.db.add(note)
    await ctx.db.flush()
    return note


async def _make_resource(ctx: MatrixContext) -> Resource:
    resource = Resource(
        workspace_id=ctx.workspace.id,
        name="matrix.txt",
        resource_type=ResourceType.file,
        mime_type="text/plain",
        size_bytes=10,
        uploaded_by=ctx.owner.id,
        meta={},
    )
    ctx.db.add(resource)
    await ctx.db.flush()
    return resource


async def _make_channel(ctx: MatrixContext) -> Channel:
    channel = Channel(
        workspace_id=ctx.workspace.id,
        name="matrix channel",
        channel_type=ChannelType.email,
        contact_value="matrix@valaris.dev",
        created_by=ctx.owner.id,
    )
    ctx.db.add(channel)
    await ctx.db.flush()
    return channel


async def _make_git_repo(ctx: MatrixContext, slug: str = "matrix-repo") -> GitRepo:
    repo = GitRepo(
        board_id=ctx.board.id,
        workspace_id=ctx.workspace.id,
        name=slug,
        slug=slug,
        url=f"https://github.com/valaris/{slug}",
        provider=GitProvider.github,
        default_branch="main",
        added_by=ctx.owner.id,
    )
    ctx.db.add(repo)
    await ctx.db.flush()
    return repo


async def _make_agent(ctx: MatrixContext, name: str = "matrix-agent") -> Agent:
    agent = Agent(
        name=name,
        agent_type=AgentType.coding,
        description="role-matrix agent",
        created_by_id=ctx.owner.id,
        is_active=True,
    )
    ctx.db.add(agent)
    await ctx.db.flush()
    return agent


# --- the matrix -------------------------------------------------------------

RequestSpec = tuple[str, str, dict | None]  # (method, url, json)


@dataclass(frozen=True)
class EndpointCase:
    id: str
    min_role: str  # "member" | "admin" — the lowest role allowed to call it
    ok: tuple[int, ...]  # success statuses pinned for allowed roles
    build: Callable[[MatrixContext], Awaitable[RequestSpec]] = field(repr=False)


async def _card_create(ctx) -> RequestSpec:
    return "POST", _board(ctx, "/cards"), {
        "title": "role matrix card",
        "column_id": str(ctx.column.id),
    }


async def _card_bulk_create(ctx) -> RequestSpec:
    return "POST", _board(ctx, "/cards/bulk"), {
        "cards": [{"title": "bulk card", "column_id": str(ctx.column.id)}]
    }


async def _card_update(ctx) -> RequestSpec:
    return "PATCH", _board(ctx, f"/cards/{ctx.card.id}"), {"title": "renamed"}


async def _card_move(ctx) -> RequestSpec:
    return "PATCH", _board(ctx, f"/cards/{ctx.card.id}/move"), {
        "column_id": str(ctx.column.id),
        "position": 512.0,
    }


async def _card_delete(ctx) -> RequestSpec:
    card = await _make_card(ctx, "delete me")
    return "DELETE", _board(ctx, f"/cards/{card.id}"), None


async def _card_claim(ctx) -> RequestSpec:
    agent = await _make_agent(ctx, "claim-agent")
    return "POST", _board(ctx, f"/cards/{ctx.card.id}/claim"), {
        "agent_id": str(agent.id)
    }


async def _participant_add(ctx) -> RequestSpec:
    return "POST", _board(ctx, f"/cards/{ctx.card.id}/participants"), {
        "user_id": str(ctx.member.id),
        "role": "hero",
    }


async def _participant_remove(ctx) -> RequestSpec:
    ctx.db.add(
        CardParticipant(card_id=ctx.card.id, user_id=ctx.owner.id, role="hero")
    )
    await ctx.db.flush()
    return "DELETE", _board(
        ctx, f"/cards/{ctx.card.id}/participants/{ctx.owner.id}"
    ), None


async def _participant_remove_by_role(ctx) -> RequestSpec:
    ctx.db.add(
        CardParticipant(
            card_id=ctx.card.id,
            user_id=ctx.owner.id,
            role="hero",
            pipeline_role="coder",
        )
    )
    await ctx.db.flush()
    return "DELETE", _board(
        ctx, f"/cards/{ctx.card.id}/participants/by-pipeline-role/coder"
    ), None


async def _dependency_add(ctx) -> RequestSpec:
    other = await _make_card(ctx, "prerequisite")
    return "POST", _board(ctx, f"/cards/{ctx.card.id}/dependencies"), {
        "depends_on_card_id": str(other.id)
    }


async def _dependency_remove(ctx) -> RequestSpec:
    other = await _make_card(ctx, "prerequisite")
    ctx.db.add(
        CardDependency(
            card_id=ctx.card.id, depends_on_card_id=other.id, created_by=ctx.owner.id
        )
    )
    await ctx.db.flush()
    return "DELETE", _board(
        ctx, f"/cards/{ctx.card.id}/dependencies/{other.id}"
    ), None


async def _dependency_bulk_set(ctx) -> RequestSpec:
    other = await _make_card(ctx, "prerequisite")
    return "PUT", _board(ctx, f"/cards/{ctx.card.id}/dependencies"), {
        "depends_on_card_ids": [str(other.id)]
    }


async def _column_create(ctx) -> RequestSpec:
    return "POST", _board(ctx, "/columns"), {"name": "New Column"}


async def _column_update(ctx) -> RequestSpec:
    return "PATCH", _board(ctx, f"/columns/{ctx.column.id}"), {"name": "Renamed"}


async def _column_reorder(ctx) -> RequestSpec:
    return "PATCH", _board(ctx, "/columns/reorder"), {
        "column_ids": [str(ctx.column.id)]
    }


async def _board_create(ctx) -> RequestSpec:
    return "POST", _ws(ctx, "/boards"), {"name": "Role Matrix Board"}


async def _board_update(ctx) -> RequestSpec:
    return "PATCH", _board(ctx), {"name": "Renamed Board"}


async def _definition_upsert(ctx) -> RequestSpec:
    return "PUT", _board(ctx, "/definitions"), {
        "scope": "Role matrix scope",
        "content": {"tech_stack": ["Python"]},
    }


async def _ws_note_create(ctx) -> RequestSpec:
    return "POST", _ws(ctx, "/notes"), {"title": "ws note", "content": "body"}


async def _ws_note_update(ctx) -> RequestSpec:
    note = await _make_note(ctx, board_scoped=False)
    return "PUT", _ws(ctx, f"/notes/{note.id}"), {"title": "renamed note"}


async def _ws_note_delete(ctx) -> RequestSpec:
    note = await _make_note(ctx, board_scoped=False)
    return "DELETE", _ws(ctx, f"/notes/{note.id}"), None


async def _board_note_create(ctx) -> RequestSpec:
    return "POST", _board(ctx, "/notes"), {"title": "board note", "content": "body"}


async def _board_note_update(ctx) -> RequestSpec:
    note = await _make_note(ctx, board_scoped=True)
    return "PUT", _board(ctx, f"/notes/{note.id}"), {"title": "renamed note"}


async def _board_note_delete(ctx) -> RequestSpec:
    note = await _make_note(ctx, board_scoped=True)
    return "DELETE", _board(ctx, f"/notes/{note.id}"), None


async def _ws_resource_create(ctx) -> RequestSpec:
    return "POST", _ws(ctx, "/resources"), {
        "name": "spec.pdf",
        "resource_type": "file",
    }


async def _ws_resource_update(ctx) -> RequestSpec:
    resource = await _make_resource(ctx)
    return "PUT", _ws(ctx, f"/resources/{resource.id}"), {"name": "renamed.txt"}


async def _ws_resource_delete(ctx) -> RequestSpec:
    resource = await _make_resource(ctx)
    return "DELETE", _ws(ctx, f"/resources/{resource.id}"), None


async def _board_resource_create(ctx) -> RequestSpec:
    return "POST", _board(ctx, "/resources"), {
        "name": "board-spec.pdf",
        "resource_type": "file",
    }


async def _channel_create(ctx) -> RequestSpec:
    return "POST", _ws(ctx, "/channels"), {
        "name": "Support Email",
        "channel_type": "email",
        "contact_value": "support@valaris.dev",
    }


async def _channel_update(ctx) -> RequestSpec:
    channel = await _make_channel(ctx)
    return "PUT", _ws(ctx, f"/channels/{channel.id}"), {
        "name": "Updated Channel",
        "channel_type": "email",
        "contact_value": "support@valaris.dev",
    }


async def _git_repo_create(ctx) -> RequestSpec:
    return "POST", _board(ctx, "/git-repos"), {
        "name": "valaris-api",
        "url": "https://github.com/valaris/api",
        "provider": "github",
        "default_branch": "main",
    }


async def _git_repo_update(ctx) -> RequestSpec:
    repo = await _make_git_repo(ctx, "update-repo")
    return "PUT", _board(ctx, f"/git-repos/{repo.id}"), {
        "name": "Updated Repo",
        "url": "https://github.com/valaris/updated",
    }


async def _merge_queue_enqueue(ctx) -> RequestSpec:
    repo = await _make_git_repo(ctx, "mq-repo")
    card = await _make_card(ctx, "mq card")
    return "POST", _ws(ctx, "/merge-queue/enqueue"), {
        "card_id": str(card.id),
        "repo_id": str(repo.id),
        "integration_branch": "develop",
        "pr_url": "https://github.com/valaris/mq-repo/pull/1",
        "pr_branch": "feat/mq",
    }


def _loop_config_row(enabled: bool = True) -> dict:
    """Complete canonical loop_config for direct model seeding, so the request
    under test is the only API call a role user makes."""
    return {
        "enabled": enabled,
        "provider": "",
        "model": "mid",
        "system_prompt": "",
        "loop_prompt": "role matrix loop prompt",
        "tools": [],
        "max_iterations": 25,
        "iteration_delay_seconds": 30,
        "iteration_timeout_seconds": 3600,
        "budget_usd": 20.0,
        "max_consecutive_failures": 3,
        "disabled_reason": None,
        "version": 1,
        "updated_at": "2026-07-31T00:00:00",
    }


async def _seed_loop_config(ctx: MatrixContext, enabled: bool = True) -> None:
    ctx.board.loop_config = _loop_config_row(enabled)
    await ctx.db.flush()


async def _loop_put(ctx) -> RequestSpec:
    return "PUT", _board(ctx, "/loop"), {"loop_prompt": "admin edits the loop"}


async def _loop_state_patch(ctx) -> RequestSpec:
    await _seed_loop_config(ctx, enabled=True)
    return "PATCH", _board(ctx, "/loop/state"), {
        "enabled": False,
        "reason": "role matrix off-switch",
    }


async def _board_delete(ctx) -> RequestSpec:
    board = await _make_empty_board(ctx, "deletable-board")
    return "DELETE", _ws(ctx, f"/boards/{board.id}"), None


async def _column_delete(ctx) -> RequestSpec:
    column = await _make_empty_column(ctx)
    return "DELETE", _board(ctx, f"/columns/{column.id}"), None


async def _channel_delete(ctx) -> RequestSpec:
    channel = await _make_channel(ctx)
    return "DELETE", _ws(ctx, f"/channels/{channel.id}"), None


async def _git_repo_delete(ctx) -> RequestSpec:
    repo = await _make_git_repo(ctx, "delete-repo")
    return "DELETE", _board(ctx, f"/git-repos/{repo.id}"), None


async def _member_role_patch(ctx) -> RequestSpec:
    """Fresh target member so the PATCH never touches the matrix role users
    (whose roles later cases depend on). member→admin keeps the request clear
    of the owner-only guard — this case pins the ROUTER gate only."""
    target = await _make_role_user(
        ctx.db, ctx.workspace, "role-patch-target@valaris.dev", WorkspaceRole.member
    )
    return "PATCH", _ws(ctx, f"/members/{target.id}"), {"role": "admin"}


MATRIX: list[EndpointCase] = [
    EndpointCase("card_create", "member", (201,), _card_create),
    EndpointCase("card_bulk_create", "member", (201,), _card_bulk_create),
    EndpointCase("card_update", "member", (200,), _card_update),
    EndpointCase("card_move", "member", (200,), _card_move),
    EndpointCase("card_delete", "member", (204,), _card_delete),
    EndpointCase("card_claim", "member", (200,), _card_claim),
    EndpointCase("participant_add", "member", (201,), _participant_add),
    EndpointCase("participant_remove", "member", (200, 204), _participant_remove),
    EndpointCase(
        "participant_remove_by_role", "member", (200, 204), _participant_remove_by_role
    ),
    EndpointCase("dependency_add", "member", (200, 201), _dependency_add),
    EndpointCase("dependency_remove", "member", (204,), _dependency_remove),
    EndpointCase("dependency_bulk_set", "member", (200,), _dependency_bulk_set),
    EndpointCase("column_create", "member", (201,), _column_create),
    EndpointCase("column_update", "member", (200,), _column_update),
    EndpointCase("column_reorder", "member", (200,), _column_reorder),
    EndpointCase("board_create", "member", (201,), _board_create),
    EndpointCase("board_update", "member", (200,), _board_update),
    EndpointCase("definition_upsert", "member", (200,), _definition_upsert),
    EndpointCase("ws_note_create", "member", (201,), _ws_note_create),
    EndpointCase("ws_note_update", "member", (200,), _ws_note_update),
    EndpointCase("ws_note_delete", "member", (204,), _ws_note_delete),
    EndpointCase("board_note_create", "member", (201,), _board_note_create),
    EndpointCase("board_note_update", "member", (200,), _board_note_update),
    EndpointCase("board_note_delete", "member", (204,), _board_note_delete),
    EndpointCase("ws_resource_create", "member", (201,), _ws_resource_create),
    EndpointCase("ws_resource_update", "member", (200,), _ws_resource_update),
    EndpointCase("ws_resource_delete", "member", (204,), _ws_resource_delete),
    EndpointCase("board_resource_create", "member", (201,), _board_resource_create),
    EndpointCase("channel_create", "member", (201,), _channel_create),
    EndpointCase("channel_update", "member", (200,), _channel_update),
    EndpointCase("git_repo_create", "member", (200, 201), _git_repo_create),
    EndpointCase("git_repo_update", "member", (200,), _git_repo_update),
    EndpointCase("merge_queue_enqueue", "member", (200,), _merge_queue_enqueue),
    EndpointCase("loop_state_patch", "member", (200,), _loop_state_patch),
    # Container deletes: admin/owner only.
    EndpointCase("loop_config_put", "admin", (200, 201), _loop_put),
    EndpointCase("board_delete", "admin", (204,), _board_delete),
    EndpointCase("column_delete", "admin", (204,), _column_delete),
    EndpointCase("channel_delete", "admin", (204,), _channel_delete),
    EndpointCase("git_repo_delete", "admin", (204,), _git_repo_delete),
    # Member role management: admin+ at the router; owner-involving changes
    # carry further in-service gates pinned in test_workspace_members.py.
    EndpointCase("member_role_patch", "admin", (200,), _member_role_patch),
]

MEMBER_CASES = [c for c in MATRIX if c.min_role == "member"]
ADMIN_CASES = [c for c in MATRIX if c.min_role == "admin"]


async def _call(
    client: AsyncClient, spec: RequestSpec, headers: dict[str, str]
):
    method, url, payload = spec
    return await client.request(method, url, json=payload, headers=headers)


# --- viewer: read-only ------------------------------------------------------


@pytest.mark.parametrize("case", MATRIX, ids=[c.id for c in MATRIX])
async def test_viewer_mutation_forbidden(
    case: EndpointCase, role_client: AsyncClient, mctx: MatrixContext
):
    spec = await case.build(mctx)
    resp = await _call(role_client, spec, _as(mctx.viewer))
    assert resp.status_code == 403, (
        f"viewer must be read-only but {case.id} returned "
        f"{resp.status_code}: {resp.text[:200]}"
    )


# --- member: everything except container deletes ----------------------------


@pytest.mark.parametrize("case", MEMBER_CASES, ids=[c.id for c in MEMBER_CASES])
async def test_member_mutation_allowed(
    case: EndpointCase, role_client: AsyncClient, mctx: MatrixContext
):
    spec = await case.build(mctx)
    resp = await _call(role_client, spec, _as(mctx.member))
    assert resp.status_code in case.ok, (
        f"member must keep {case.id}, got {resp.status_code}: {resp.text[:200]}"
    )


@pytest.mark.parametrize("case", ADMIN_CASES, ids=[c.id for c in ADMIN_CASES])
async def test_member_container_delete_forbidden(
    case: EndpointCase, role_client: AsyncClient, mctx: MatrixContext
):
    spec = await case.build(mctx)
    resp = await _call(role_client, spec, _as(mctx.member))
    assert resp.status_code == 403, (
        f"container delete {case.id} must require admin, member got "
        f"{resp.status_code}: {resp.text[:200]}"
    )


@pytest.mark.parametrize("case", ADMIN_CASES, ids=[c.id for c in ADMIN_CASES])
async def test_admin_container_delete_allowed(
    case: EndpointCase, role_client: AsyncClient, mctx: MatrixContext
):
    spec = await case.build(mctx)
    resp = await _call(role_client, spec, _as(mctx.admin))
    assert resp.status_code in case.ok, (
        f"admin must keep {case.id}, got {resp.status_code}: {resp.text[:200]}"
    )


# --- viewer reads stay open -------------------------------------------------


async def test_viewer_read_board_detail_allowed(
    role_client: AsyncClient, mctx: MatrixContext
):
    resp = await role_client.get(_board(mctx), headers=_as(mctx.viewer))
    assert resp.status_code == 200, resp.text


async def test_viewer_read_card_search_allowed(
    role_client: AsyncClient, mctx: MatrixContext
):
    resp = await role_client.get(
        _board(mctx, "/cards/search"), params={"q": "Test"}, headers=_as(mctx.viewer)
    )
    assert resp.status_code == 200, resp.text


async def test_viewer_read_workspace_notes_allowed(
    role_client: AsyncClient, mctx: MatrixContext
):
    resp = await role_client.get(_ws(mctx, "/notes"), headers=_as(mctx.viewer))
    assert resp.status_code == 200, resp.text


async def test_viewer_read_board_notes_allowed(
    role_client: AsyncClient, mctx: MatrixContext
):
    resp = await role_client.get(_board(mctx, "/notes"), headers=_as(mctx.viewer))
    assert resp.status_code == 200, resp.text


# --- agent pins: runner flows must survive the role rollout -----------------
#
# Real Bearer vlr_ path (no auth override): the key resolves to its creating
# user and WorkspaceDep enforces THAT user's role. These pins are green today
# and must stay green after min_role=member lands on content mutations.


async def _mint_agent_key(
    db: AsyncSession, creating_user: User, name: str
) -> tuple[str, Agent]:
    """Real ApiKey (sha256 hash matches ApiKeyService.verify_key) + linked
    active Agent; returns the raw vlr_ token and the agent row."""
    raw = "vlr_" + secrets.token_urlsafe(32)
    api_key = ApiKey(
        user_id=creating_user.id,
        name=f"{name}-key",
        key_hash=hashlib.sha256(raw.encode()).hexdigest(),
        key_prefix=raw[:8],
    )
    db.add(api_key)
    await db.flush()
    agent = Agent(
        name=name,
        agent_type=AgentType.coding,
        description="role-matrix pinned agent",
        created_by_id=creating_user.id,
        is_active=True,
        api_key_id=api_key.id,
    )
    db.add(agent)
    await db.flush()
    return raw, agent


def _bearer(raw_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {raw_key}"}


async def test_agent_can_still_move_card(
    role_client: AsyncClient, mctx: MatrixContext
):
    raw, _ = await _mint_agent_key(mctx.db, mctx.owner, "pin-move-agent")
    resp = await role_client.patch(
        _board(mctx, f"/cards/{mctx.card.id}/move"),
        json={"column_id": str(mctx.column.id), "position": 512.0},
        headers=_bearer(raw),
    )
    assert resp.status_code == 200, (
        f"agent runner flow broken: move_card got {resp.status_code}: {resp.text}"
    )


async def test_agent_can_still_manage_participants(
    role_client: AsyncClient, mctx: MatrixContext
):
    raw, _ = await _mint_agent_key(mctx.db, mctx.owner, "pin-participant-agent")
    add = await role_client.post(
        _board(mctx, f"/cards/{mctx.card.id}/participants"),
        json={"user_id": str(mctx.owner.id), "role": "hero"},
        headers=_bearer(raw),
    )
    assert add.status_code == 201, (
        f"agent runner flow broken: add_participant got {add.status_code}: {add.text}"
    )
    remove = await role_client.delete(
        _board(mctx, f"/cards/{mctx.card.id}/participants/{mctx.owner.id}"),
        headers=_bearer(raw),
    )
    assert remove.status_code in (200, 204), (
        "agent runner flow broken: remove_participant got "
        f"{remove.status_code}: {remove.text}"
    )


async def test_agent_can_still_create_note(
    role_client: AsyncClient, mctx: MatrixContext
):
    raw, _ = await _mint_agent_key(mctx.db, mctx.owner, "pin-note-agent")
    resp = await role_client.post(
        _ws(mctx, "/notes"),
        json={"title": "agent note", "content": "from runner"},
        headers=_bearer(raw),
    )
    assert resp.status_code == 201, (
        f"agent runner flow broken: create_note got {resp.status_code}: {resp.text}"
    )


async def test_agent_can_still_poll_next_assignment(
    role_client: AsyncClient, mctx: MatrixContext
):
    raw, agent = await _mint_agent_key(mctx.db, mctx.owner, "pin-pickup-agent")
    resp = await role_client.post(
        _ws(mctx, f"/agents/{agent.id}/next-assignment"),
        json={},
        headers=_bearer(raw),
    )
    # 200 = reserved a card, 204 = nothing eligible. Either keeps the runner
    # alive; 403 would strand every pipeline.
    assert resp.status_code in (200, 204), (
        "agent runner flow broken: next-assignment got "
        f"{resp.status_code}: {resp.text}"
    )


async def test_agent_created_by_plain_member_can_still_move_card(
    role_client: AsyncClient, mctx: MatrixContext
):
    """THE seam pin: an agent inherits its creating user's role, so an agent
    minted by a plain member is exactly what min_role=member must not break.
    If this pin turns red, the rollout raised a content mutation above member
    (or added agent handling stricter than the creating user's role)."""
    raw, _ = await _mint_agent_key(mctx.db, mctx.member, "member-owned-agent")
    resp = await role_client.patch(
        _board(mctx, f"/cards/{mctx.card.id}/move"),
        json={"column_id": str(mctx.column.id), "position": 768.0},
        headers=_bearer(raw),
    )
    assert resp.status_code == 200, (
        "member-created agent lost card mutation access: "
        f"{resp.status_code}: {resp.text}"
    )


async def test_agent_cannot_delete_board(
    role_client: AsyncClient, mctx: MatrixContext
):
    """Board delete gets forbid_agent_callers: even an agent whose creating
    user is the workspace OWNER must be refused."""
    raw, _ = await _mint_agent_key(mctx.db, mctx.owner, "pin-no-delete-agent")
    board = await _make_empty_board(mctx, "agent-delete-target")
    resp = await role_client.delete(
        _ws(mctx, f"/boards/{board.id}"), headers=_bearer(raw)
    )
    assert resp.status_code == 403, (
        f"agent deleted a board (got {resp.status_code}): board delete must "
        "carry forbid_agent_callers regardless of the creating user's role"
    )


# --- board loop mode: viewer read + agent-key state flips --------------------
#
# The loop off-switch is the safety valve of loop mode: a loop agent MUST be
# able to disable its own loop through its vlr_ key (no forbid_agent_callers),
# but only with member-or-better inherited role.


async def test_viewer_can_read_board_loop(
    role_client: AsyncClient, mctx: MatrixContext
):
    await _seed_loop_config(mctx, enabled=True)
    resp = await role_client.get(_board(mctx, "/loop"), headers=_as(mctx.viewer))
    assert resp.status_code == 200, (
        f"viewer must keep loop config read access, got {resp.status_code}: "
        f"{resp.text[:200]}"
    )
    assert resp.json()["enabled"] is True


async def test_agent_key_of_member_can_patch_loop_state(
    role_client: AsyncClient, mctx: MatrixContext
):
    """THE loop seam pin: a runner's agent key (creating user = plain member)
    must be able to turn the loop off — this is how loop agents and safety
    rails stop the loop autonomously."""
    await _seed_loop_config(mctx, enabled=True)
    raw, _ = await _mint_agent_key(mctx.db, mctx.member, "loop-off-switch-agent")
    resp = await role_client.patch(
        _board(mctx, "/loop/state"),
        json={"enabled": False, "reason": "objective complete"},
        headers=_bearer(raw),
    )
    assert resp.status_code == 200, (
        "loop off-switch broken for member-owned agent key: "
        f"{resp.status_code}: {resp.text[:200]}"
    )
    assert resp.json()["enabled"] is False


async def test_agent_key_of_viewer_cannot_patch_loop_state(
    role_client: AsyncClient, mctx: MatrixContext
):
    """Agents inherit their creating user's role with no exemption: a key
    minted by a viewer stays read-only, including on the loop state."""
    await _seed_loop_config(mctx, enabled=True)
    raw, _ = await _mint_agent_key(mctx.db, mctx.viewer, "viewer-owned-agent")
    resp = await role_client.patch(
        _board(mctx, "/loop/state"),
        json={"enabled": False, "reason": "should be refused"},
        headers=_bearer(raw),
    )
    assert resp.status_code == 403, (
        "viewer-owned agent key flipped the loop state (got "
        f"{resp.status_code}): agents must inherit the creating user's role"
    )
