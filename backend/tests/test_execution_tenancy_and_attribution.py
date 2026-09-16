# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Card 44231c47 — `start_execution` takes `workspace_slug` and `board_id` from
the SAME caller and never checks they belong together.

Two independent defects, one call site:

1. **Tenancy.** The workspace is resolved from the slug alone, so a caller may
   pair workspace A's slug with workspace B's board id. The row lands under A
   while the loop-template binding it reads — and the track record it credits —
   belong to B. The check must run BEFORE the binding lookup and before the
   row is created, so a cross-tenant call never reads a foreign binding and
   never writes a row.

2. **Attribution.** `prompt_slug` was caller-wins, so a runner could credit (or
   mis-credit) any template's track record — the one number an operator reads
   to decide whether a loop works. For `loop_iteration` the server-derived
   stamp now wins; every other action keeps the caller's value (pipeline stages
   name their own prompt); and the reserved `loop-template:` namespace is
   never accepted from a caller at all.

The tenancy tests assert BOTH the 404 AND the absence of a row: a 404 raised
after the write would pass a status-only test.
"""

import uuid

import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.execution import AgentExecution
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.repositories.config_template import BoardLoopTemplateBindingRepository
from app.services.loop_template_stamp import STAMP_PREFIX

AGENTS_URL = "/api/agents"


async def _create_agent(client: AsyncClient) -> dict:
    resp = await client.post(
        AGENTS_URL,
        json={
            "name": "tenancy-runner",
            "agent_type": "coding",
            "description": "tenancy + attribution test agent",
            "allowed_workspaces": ["default", "other"],
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


@pytest_asyncio.fixture
async def other_workspace(db_session: AsyncSession, test_user: User) -> Workspace:
    """A second workspace owned by the SAME user, so membership is never the
    reason a request is denied — only the board's tenancy can be."""
    workspace = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(workspace)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=workspace.id, user_id=test_user.id, role=WorkspaceRole.owner
        )
    )
    await db_session.flush()
    return workspace


@pytest_asyncio.fixture
async def foreign_board(
    db_session: AsyncSession, other_workspace: Workspace, test_user: User
) -> Board:
    board = Board(
        workspace_id=other_workspace.id,
        name="Foreign Board",
        slug="foreign-board",
        description="Lives in a workspace the caller does not name",
        created_by=test_user.id,
    )
    db_session.add(board)
    await db_session.flush()
    return board


async def _execution_count(db_session: AsyncSession) -> int:
    result = await db_session.execute(select(func.count()).select_from(AgentExecution))
    return result.scalar_one()


async def _bind_board(
    db_session: AsyncSession,
    board: Board,
    *,
    source: str = "system",
    slug: str = "coding-loop",
    version: int = 2,
) -> None:
    await BoardLoopTemplateBindingRepository(db_session).upsert(
        board_id=board.id,
        template_ref={"source": source, "slug": slug},
        version=version,
        slot_values={},
        rendered_by_id=None,
        rendered_hash=None,
    )
    await db_session.commit()


async def _start(client: AsyncClient, agent_id: str, **body) -> AsyncClient:
    return await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "loop_iteration",
            "input_summary": "loop iteration 1",
            **body,
        },
    )


# --- 1. tenancy ----------------------------------------------------------


async def test_cross_tenant_board_is_404_and_writes_no_row(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    foreign_board: Board,
):
    """AC1 — workspace A's slug + workspace B's board ⇒ 404, nothing written."""
    agent = await _create_agent(client)
    before = await _execution_count(db_session)

    resp = await _start(client, agent["id"], board_id=str(foreign_board.id))

    assert resp.status_code == 404, (
        "a board from another workspace was accepted: "
        f"{resp.status_code} {resp.text}"
    )
    assert (
        await _execution_count(db_session) == before
    ), "the execution row was written before the tenancy check rejected the call"


async def test_cross_tenant_board_never_reads_the_foreign_binding(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    foreign_board: Board,
    monkeypatch,
):
    """The check must run BEFORE `_loop_template_stamp` — a 404 raised after the
    lookup still leaks whether (and which) template another tenant's board is
    bound to. Only the call count distinguishes the two orderings."""
    agent = await _create_agent(client)
    await _bind_board(db_session, foreign_board)

    monkeypatch.setattr(
        BoardLoopTemplateBindingRepository,
        "get_by_board",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("binding of a foreign board was read before the 404")
        ),
    )

    resp = await _start(client, agent["id"], board_id=str(foreign_board.id))

    assert resp.status_code == 404, resp.text


async def test_same_workspace_board_still_starts(
    client: AsyncClient,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
):
    """AC2 — negative control: an own-workspace board is unchanged."""
    agent = await _create_agent(client)

    resp = await _start(client, agent["id"], board_id=str(test_board.id))

    assert resp.status_code == 201, resp.text
    assert resp.json()["board_id"] == str(test_board.id)


async def test_board_less_call_skips_the_tenancy_check(
    client: AsyncClient,
    test_user: User,
    test_workspace: Workspace,
):
    """AC2 — `board_id=None` callers must not pay for, or be rejected by, a
    board load that has nothing to load."""
    agent = await _create_agent(client)

    resp = await _start(client, agent["id"])

    assert resp.status_code == 201, resp.text
    assert resp.json()["board_id"] is None


async def test_unknown_board_id_is_404(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    """A board id that resolves to nothing is the same authorization failure as
    one owned by another tenant — never a silent pass-through."""
    agent = await _create_agent(client)
    before = await _execution_count(db_session)

    resp = await _start(client, agent["id"], board_id=str(uuid.uuid4()))

    assert resp.status_code == 404, resp.text
    assert await _execution_count(db_session) == before


async def test_unknown_workspace_slug_still_404s_on_its_own(
    client: AsyncClient,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
):
    """The two failure modes are separate: the new board check must not mask
    (or be masked by) the pre-existing unknown-slug 404."""
    agent = await _create_agent(client)

    resp = await _start(
        client,
        agent["id"],
        workspace_slug="no-such-workspace",
        board_id=str(test_board.id),
    )

    assert resp.status_code == 404, resp.text
    assert "no-such-workspace" in resp.json()["detail"]


# --- 2. attribution ------------------------------------------------------


async def test_loop_iteration_stamp_overrides_a_caller_supplied_slug(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
):
    """AC3 — the binding stamp WINS for loop iterations. Attribution is the one
    number an operator trusts, so a runner must not be able to redirect it."""
    agent = await _create_agent(client)
    await _bind_board(db_session, test_board)

    resp = await _start(
        client,
        agent["id"],
        board_id=str(test_board.id),
        prompt_slug="something-else",
    )

    assert resp.status_code == 201, resp.text
    assert resp.json()["prompt_slug"] == "loop-template:system/coding-loop@2"


async def test_non_loop_action_keeps_the_caller_prompt_slug(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
):
    """AC4 — a pipeline stage names its own prompt; the override is scoped to
    `loop_iteration` alone. The board here IS bound, so only the action guard
    keeps the caller's value."""
    agent = await _create_agent(client)
    await _bind_board(db_session, test_board)

    resp = await _start(
        client,
        agent["id"],
        board_id=str(test_board.id),
        action="pipeline_stage",
        prompt_slug="stage-review-prompt",
    )

    assert resp.status_code == 201, resp.text
    assert resp.json()["prompt_slug"] == "stage-review-prompt"


async def test_loop_iteration_on_unbound_board_drops_the_caller_slug(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
):
    """AC6 — an UNBOUND board stamps None, not the caller's value. A fallback
    (`stamp or data.prompt_slug`) would let an unbound board be credited to
    whatever the runner typed."""
    agent = await _create_agent(client)
    before = await _execution_count(db_session)

    resp = await _start(
        client,
        agent["id"],
        board_id=str(test_board.id),
        prompt_slug="runner-chosen-prompt",
    )

    assert resp.status_code == 201, resp.text
    assert resp.json()["prompt_slug"] is None
    assert await _execution_count(db_session) == before + 1


async def test_reserved_namespace_from_a_caller_is_422(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
):
    """AC5 — only the server mints `loop-template:` keys. A caller-written one
    would put the writer and the reader of the stamp on different key formats,
    which is exactly what loop_template_stamp's module docstring forbids."""
    agent = await _create_agent(client)
    before = await _execution_count(db_session)

    resp = await _start(
        client,
        agent["id"],
        board_id=str(test_board.id),
        prompt_slug="loop-template:coding-loop-v2",
    )

    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert body["error_code"] == "reserved_prompt_slug"
    assert body["error_params"]["prompt_slug"] == "loop-template:coding-loop-v2"
    assert await _execution_count(db_session) == before


async def test_reserved_namespace_is_rejected_for_every_action(
    client: AsyncClient,
    test_user: User,
    test_workspace: Workspace,
):
    """AC5 — the rejection is namespace-based, not action-based: a pipeline
    stage may not mint one either, and a board-less call is no escape hatch."""
    agent = await _create_agent(client)

    resp = await _start(
        client,
        agent["id"],
        action="pipeline_stage",
        prompt_slug=f"{STAMP_PREFIX}workspace/mine@1",
    )

    assert resp.status_code == 422, resp.text
    assert resp.json()["error_code"] == "reserved_prompt_slug"


async def test_reserved_namespace_is_rejected_before_any_work_is_done(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
    monkeypatch,
):
    """A malformed request must be refused on its own terms, not incidentally.

    Asserted on the QUERY, not just the status: a rejection placed after the
    stamp resolve still returns 422 and still writes no row, so only the
    absence of the binding lookup distinguishes the two orderings. The same
    late placement would also let a cross-tenant board's 404 MASK the 422,
    telling the caller "no such board" when the real fault is the slug.
    """
    agent = await _create_agent(client)
    await _bind_board(db_session, test_board)

    monkeypatch.setattr(
        BoardLoopTemplateBindingRepository,
        "get_by_board",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("binding read on a request already known to be invalid")
        ),
    )

    resp = await _start(
        client,
        agent["id"],
        board_id=str(test_board.id),
        prompt_slug=f"{STAMP_PREFIX}system/coding-loop@2",
    )

    assert resp.status_code == 422, resp.text
    assert resp.json()["error_code"] == "reserved_prompt_slug"


async def test_reserved_namespace_is_not_masked_by_a_cross_tenant_404(
    client: AsyncClient,
    test_user: User,
    test_workspace: Workspace,
    foreign_board: Board,
):
    """Two faults, one request: the caller is told about the one it can fix.

    The reserved-namespace check runs before the workspace and board are even
    resolved, so a bad slug reports 422 rather than being swallowed by the
    tenancy 404 that the same request would also earn.
    """
    agent = await _create_agent(client)

    resp = await _start(
        client,
        agent["id"],
        board_id=str(foreign_board.id),
        prompt_slug=f"{STAMP_PREFIX}system/coding-loop@2",
    )

    assert resp.status_code == 422, resp.text
    assert resp.json()["error_code"] == "reserved_prompt_slug"


async def test_a_slug_merely_containing_the_prefix_is_accepted(
    client: AsyncClient,
    test_user: User,
    test_workspace: Workspace,
):
    """The guard is a PREFIX check, not a substring one — a legitimate pipeline
    prompt that happens to mention the word must still start."""
    agent = await _create_agent(client)

    resp = await _start(
        client,
        agent["id"],
        action="pipeline_stage",
        prompt_slug="review-loop-template:notes",
    )

    assert resp.status_code == 201, resp.text
    assert resp.json()["prompt_slug"] == "review-loop-template:notes"
