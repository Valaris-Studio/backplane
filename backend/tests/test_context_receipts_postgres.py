# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored PostgreSQL qualification for context bindings and
receipts: real row locks, ON CONFLICT and unique constraints under concurrent
HTTP requests, which SQLite cannot show.

CONTEXT_RECEIPTS_TEST_DATABASE_URL names a database already migrated to head
on a DISPOSABLE server. Each test seeds and deletes its own synthetic rows;
the migration test creates its own uniquely named database on that server.
"""

import asyncio
import os
import subprocess
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import get_db
from app.main import create_app
from app.models.agents.agent import Agent, AgentType
from app.models.agents.context_receipt import (
    ExecutionContextBinding,
    ExecutionContextReceipt,
)
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.agents.reservation import AgentReservation
from app.models.api_key import ApiKey
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.models.workspace_config import WorkspaceConfig
from app.schemas.agents.execution import ExecutionCreate
from app.services.agents.execution import ExecutionService
from tests.conftest import _raw_api_key
from tests.routers.agents.test_assignments import (
    _add_team_role,
    _make_card,
    _make_repo,
    _make_typed_columns,
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(120)]

ROLE = "pg_context_role"
CONCURRENCY = 8


def database_url() -> str:
    url = os.environ.get("CONTEXT_RECEIPTS_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Requires an explicit disposable migrated PostgreSQL database")
    return url


class Seeded:
    def __init__(self, http, slug, board_id, cards, agents, headers, owner_id, workspace_id):
        self.owner_id = owner_id
        self.workspace_id = workspace_id
        self.http = http
        self.slug = slug
        self.board_id = board_id
        self.cards = cards
        self.agents = agents
        self.headers = headers

    async def assignment(self, label):
        response = await self.http.post(
            f"/api/workspaces/{self.slug}/agents/{self.agents[label]}/next-assignment",
            json={"board_id": self.board_id}, headers=self.headers[label],
        )
        assert response.status_code == 200, response.text
        return response.json()

    def start_payload(self, assignment, **changes):
        return {
            "workspace_slug": self.slug, "board_id": self.board_id,
            "card_id": assignment["card"]["id"], "role": ROLE,
            "action": "pg_qualification", "input_summary": "PostgreSQL race",
            "reservation_id": assignment["reservation"]["id"], **changes,
        }

    async def start(self, label, payload):
        return await self.http.post(
            f"/api/agents/{self.agents[label]}/executions",
            json=payload, headers=self.headers[label],
        )

    async def prepare(self, label, execution_id, revision, key, prompt="PG prompt"):
        return await self.http.post(
            f"/api/workspaces/{self.slug}/executions/{execution_id}/context-receipts",
            json={"client_request_id": key, "context_revision": revision,
                  "input_prompt": prompt, "system_prompt": "",
                  "provider": "operator-provider", "model": "operator-model"},
            headers=self.headers[label],
        )


@pytest.fixture
async def pg():
    engine = create_async_engine(database_url(), hide_parameters=True,
                                 pool_size=CONCURRENCY + 4, max_overflow=4)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    owner_id, workspace_id = uuid.uuid4(), uuid.uuid4()
    slug = "ctx-receipts-" + workspace_id.hex[:12]
    agent_ids, key_ids = [], []
    async with factory.begin() as db:
        assert await db.scalar(text("select version_num from alembic_version")) == _script_head()
        owner = User(id=owner_id, email=slug + "@example.test", name="Synthetic owner")
        db.add(owner)
        workspace = Workspace(id=workspace_id, name=slug, slug=slug, created_by=owner_id)
        db.add(workspace)
        await db.flush()
        db.add(WorkspaceMember(workspace_id=workspace_id, user_id=owner_id,
                               role=WorkspaceRole.owner))
        board = Board(workspace_id=workspace_id, name="PG", slug="pg", created_by=owner_id)
        db.add(board)
        await db.flush()
        columns = await _make_typed_columns(db, board)
        await _make_repo(db, board, owner)
        cards = [await _make_card(db, board, columns["backlog"], owner, title=f"card {n}",
                                  position=1024.0 * (n + 1)) for n in range(2)]
        headers, agents = {}, {}
        for label in ("first", "second"):
            key, raw = _raw_api_key(owner, f"{slug}-{label}")
            db.add(key)
            await db.flush()
            agent = Agent(name=f"{slug}-{label}", agent_type=AgentType.coding,
                          created_by_id=owner_id, api_key_id=key.id,
                          allowed_workspaces=[slug])
            db.add(agent)
            await db.flush()
            await _add_team_role(db, workspace, agent, owner, ROLE)
            headers[label] = {"Authorization": "Bearer " + raw}
            agents[label] = str(agent.id)
            agent_ids.append(agent.id)
            key_ids.append(key.id)
        stage = {
            "role": ROLE, "unique": True,
            "discover": {"strategy": "column_scan", "column_type": "backlog"},
            "claim": {"participant_role": "hero", "execution_action": "pg_qualification"},
            "git": {"action": "none"},
            "llm": {"enabled": True, "stage": "pg_qualification", "provider": "claude-cli",
                    "model": "premium", "post_process_kind": "produces_note",
                    "context_sources": [{"kind": "card_notes", "as": "Notes", "filter": {"limit": 3}}]},
        }
        db.add(WorkspaceConfig(workspace_id=workspace_id,
                               pipeline_config={"version": 1, "stages": [stage]}))
        board_id = str(board.id)
        card_ids = [str(c.id) for c in cards]

    app = create_app()

    async def transaction():
        async with factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = transaction
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
            yield Seeded(http, slug, board_id, card_ids, agents, headers,
                         owner_id, workspace_id), factory
    finally:
        async with factory.begin() as db:
            await db.execute(delete(Workspace).where(Workspace.id == workspace_id))
            await db.execute(delete(Agent).where(Agent.id.in_(agent_ids)))
            await db.execute(delete(ApiKey).where(ApiKey.id.in_(key_ids)))
            await db.execute(delete(User).where(User.id == owner_id))
        await engine.dispose()


async def _count(factory, model, *where):
    async with factory() as db:
        return await db.scalar(select(func.count()).select_from(model).where(*where))


async def test_concurrent_identical_starts_promote_one_hold_once(pg):
    case, factory = pg
    assignment = await case.assignment("first")
    payload = case.start_payload(assignment)
    responses = await asyncio.gather(*[case.start("first", payload) for _ in range(CONCURRENCY)])
    statuses = sorted(r.status_code for r in responses)
    assert statuses == [200] * (CONCURRENCY - 1) + [201], [r.text for r in responses]
    assert len({r.json()["id"] for r in responses}) == 1
    agent_id = uuid.UUID(case.agents["first"])
    assert await _count(factory, AgentExecution, AgentExecution.agent_id == agent_id) == 1
    assert await _count(factory, ExecutionContextBinding,
                        ExecutionContextBinding.agent_id == agent_id) == 1


async def test_concurrent_conflicting_starts_leave_one_execution(pg):
    case, factory = pg
    assignment = await case.assignment("first")
    same = case.start_payload(assignment)
    other = case.start_payload(assignment, input_summary="A different request")
    payloads = [same, other] * (CONCURRENCY // 2)
    responses = await asyncio.gather(*[case.start("first", p) for p in payloads])
    created = [(p, r) for p, r in zip(payloads, responses) if r.status_code == 201]
    assert len(created) == 1, [r.text for r in responses]
    winner_payload, winner = created[0]
    for payload, response in zip(payloads, responses):
        if response is winner:
            continue
        if payload is winner_payload:
            assert response.status_code == 200 and response.json()["id"] == winner.json()["id"]
        else:
            assert response.status_code == 409, response.text
            assert response.json()["error_code"] == "execution_start_conflict"
    agent_id = uuid.UUID(case.agents["first"])
    assert await _count(factory, AgentExecution, AgentExecution.agent_id == agent_id) == 1


async def test_concurrent_starts_of_different_holds_bind_each_once(pg):
    case, factory = pg
    first = await case.assignment("first")
    second = await case.assignment("second")
    assert first["card"]["id"] != second["card"]["id"]
    responses = await asyncio.gather(
        *[case.start("first", case.start_payload(first)) for _ in range(CONCURRENCY // 2)],
        *[case.start("second", case.start_payload(second)) for _ in range(CONCURRENCY // 2)],
    )
    assert sorted(r.status_code for r in responses).count(201) == 2, [r.text for r in responses]
    executions = {r.json()["id"] for r in responses}
    assert len(executions) == 2
    bindings = {r.json()["context_binding"]["reservation_id"] for r in responses}
    assert bindings == {first["reservation"]["id"], second["reservation"]["id"]}
    for label in ("first", "second"):
        agent_id = uuid.UUID(case.agents[label])
        assert await _count(factory, AgentExecution, AgentExecution.agent_id == agent_id) == 1


async def _bound_execution(case):
    assignment = await case.assignment("first")
    started = await case.start("first", case.start_payload(assignment))
    assert started.status_code == 201, started.text
    return started.json()["id"], assignment["context_revision"]


async def test_concurrent_same_key_preparation_retains_one_receipt(pg):
    case, factory = pg
    execution_id, revision = await _bound_execution(case)
    key = str(uuid.uuid4())
    responses = await asyncio.gather(*[case.prepare("first", execution_id, revision, key)
                                       for _ in range(CONCURRENCY)])
    statuses = sorted(r.status_code for r in responses)
    assert statuses == [200] * (CONCURRENCY - 1) + [201], [r.text for r in responses]
    assert len({r.json()["id"] for r in responses}) == 1
    assert {r.json()["ordinal"] for r in responses} == {1}
    assert await _count(factory, ExecutionContextReceipt,
                        ExecutionContextReceipt.execution_id == uuid.UUID(execution_id)) == 1


async def test_concurrent_different_key_preparations_get_dense_ordinals(pg):
    case, factory = pg
    execution_id, revision = await _bound_execution(case)
    responses = await asyncio.gather(*[
        case.prepare("first", execution_id, revision, str(uuid.uuid4()), prompt=f"call {n}")
        for n in range(CONCURRENCY)
    ])
    assert [r.status_code for r in responses] == [201] * CONCURRENCY, [r.text for r in responses]
    assert sorted(r.json()["ordinal"] for r in responses) == list(range(1, CONCURRENCY + 1))
    listed = await case.http.get(
        f"/api/workspaces/{case.slug}/executions/{execution_id}/context-receipts?limit=200",
        headers=case.headers["first"],
    )
    assert listed.headers["X-Total-Count"] == str(CONCURRENCY)
    assert [row["ordinal"] for row in listed.json()] == list(range(CONCURRENCY, 0, -1))


async def test_preparation_waiting_on_the_execution_row_sees_a_committed_terminal_status(pg):
    # Deterministic ordering: the preparation is provably queued on the
    # execution row while the holder completes the execution and commits. The
    # status the request read before its wait must not decide the outcome.
    case, factory = pg
    execution_id, revision = await _bound_execution(case)
    execution_uuid = uuid.UUID(execution_id)
    async with factory() as holder:
        locked = await holder.scalar(select(AgentExecution).where(
            AgentExecution.id == execution_uuid).with_for_update())
        holder_pid = await holder.scalar(text("SELECT pg_backend_pid()"))
        waiting = asyncio.create_task(
            case.prepare("first", execution_id, revision, str(uuid.uuid4())))
        await _wait_until_blocked_by(factory, holder_pid, 1)
        locked.status = ExecutionStatus.completed
        locked.completed_at = datetime.now(UTC).replace(tzinfo=None)
        await holder.commit()
    response = await waiting
    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "execution_not_active"
    assert await _count(factory, ExecutionContextReceipt,
                        ExecutionContextReceipt.execution_id == execution_uuid) == 0


async def _wait_until_blocked_by(factory, holder_pid, waiters):
    """Until `waiters` backends are lock-blocked, directly or through a queue
    (a later waiter on the same row reports the earlier waiter as blocker)."""
    query = text(
        "WITH RECURSIVE chain(pid) AS ("
        " SELECT pid FROM pg_stat_activity WHERE :holder = ANY(pg_blocking_pids(pid))"
        " UNION SELECT a.pid FROM pg_stat_activity a JOIN chain c"
        " ON c.pid = ANY(pg_blocking_pids(a.pid))) SELECT count(*) FROM chain"
    )
    async with factory() as db:
        for _ in range(500):
            if await db.scalar(query, {"holder": holder_pid}) >= waiters:
                return
            await asyncio.sleep(0.01)
    raise AssertionError(f"{waiters} request(s) never blocked behind backend {holder_pid}")


async def _revoke(factory, case, revocation):
    agent_id = uuid.UUID(case.agents["first"])
    async with factory.begin() as db:
        if revocation == "membership":
            await db.execute(delete(WorkspaceMember).where(
                WorkspaceMember.workspace_id == case.workspace_id,
                WorkspaceMember.user_id == case.owner_id,
            ))
        elif revocation == "agent_scope":
            await db.execute(update(Agent).where(Agent.id == agent_id)
                             .values(allowed_workspaces=["elsewhere"]))
        else:
            await db.execute(update(Agent).where(Agent.id == agent_id).values(is_active=False))


@pytest.mark.parametrize("revocation", ["membership", "agent_scope", "agent_inactive"])
async def test_preparation_reauthorizes_after_waiting_for_the_execution_lock(pg, revocation):
    # Revocation commits while both requests are already past authentication
    # and queued on the execution row: neither the exact replay nor a fresh
    # key may answer from authority read before the wait.
    case, factory = pg
    execution_id, revision = await _bound_execution(case)
    key = str(uuid.uuid4())
    first = await case.prepare("first", execution_id, revision, key)
    assert first.status_code == 201, first.text
    async with factory() as holder:
        await holder.execute(select(AgentExecution.id).where(
            AgentExecution.id == uuid.UUID(execution_id)).with_for_update())
        holder_pid = await holder.scalar(text("SELECT pg_backend_pid()"))
        replay = asyncio.create_task(case.prepare("first", execution_id, revision, key))
        fresh = asyncio.create_task(
            case.prepare("first", execution_id, revision, str(uuid.uuid4())))
        await _wait_until_blocked_by(factory, holder_pid, 2)
        await _revoke(factory, case, revocation)
        await holder.commit()
    responses = await asyncio.gather(replay, fresh)
    assert [r.status_code for r in responses] == [403, 403], [r.text for r in responses]
    assert await _count(factory, ExecutionContextReceipt,
                        ExecutionContextReceipt.execution_id == uuid.UUID(execution_id)) == 1


@pytest.mark.parametrize("hold_change", ["expired", "deleted"])
async def test_waiting_identical_start_replays_a_binding_committed_after_its_hold_changed(
    pg, hold_change,
):
    # The winner promotes the hold, then its hold expires or is swept before
    # it commits. An identical start queued on the hold lock must replay the
    # committed binding, not judge the hold it no longer needs.
    case, factory = pg
    assignment = await case.assignment("first")
    payload = case.start_payload(assignment)
    async with factory() as winner_db:
        execution, created = await ExecutionService(winner_db).start_bound_execution(
            uuid.UUID(case.agents["first"]), ExecutionCreate(**payload), user_id=case.owner_id,
        )
        assert created
        winner_pid = await winner_db.scalar(text("SELECT pg_backend_pid()"))
        waiter = asyncio.create_task(case.start("first", payload))
        await _wait_until_blocked_by(factory, winner_pid, 1)
        hold = AgentReservation.id == uuid.UUID(payload["reservation_id"])
        if hold_change == "expired":
            await winner_db.execute(update(AgentReservation).where(hold)
                                    .values(expires_at=AgentReservation.created_at))
        else:
            await winner_db.execute(delete(AgentReservation).where(hold))
        await winner_db.commit()
    response = await waiter
    assert response.status_code == 200, response.text
    assert response.json()["id"] == str(execution.id)
    agent_id = uuid.UUID(case.agents["first"])
    assert await _count(factory, AgentExecution, AgentExecution.agent_id == agent_id) == 1


def _script_head() -> str:
    # The fixture needs a fully migrated database, whichever revision is head.
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    return ScriptDirectory.from_config(config).get_current_head()


def _alembic(database: str, *args: str) -> None:
    backend = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=backend, env={**os.environ, "DATABASE_URL": database},
        capture_output=True, text=True, timeout=300,
    )
    assert result.returncode == 0, result.stderr[-4000:]


async def test_migration_121_round_trips_on_postgresql():
    server = make_url(database_url())
    name = "ctx_receipts_migration_" + uuid.uuid4().hex[:12]
    admin = create_async_engine(server, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'CREATE DATABASE "{name}"'))
    await admin.dispose()
    scratch = server.set(database=name).render_as_string(hide_password=False)
    tables = text("SELECT count(*) FROM information_schema.tables WHERE table_name IN "
                  "('execution_context_bindings', 'execution_context_receipts')")
    engine = create_async_engine(scratch)
    try:
        _alembic(scratch, "upgrade", "121")
        async with engine.connect() as connection:
            assert await connection.scalar(tables) == 2
        _alembic(scratch, "downgrade", "120")
        async with engine.connect() as connection:
            assert await connection.scalar(tables) == 0
            assert await connection.scalar(text("SELECT version_num FROM alembic_version")) == "120"
        _alembic(scratch, "upgrade", "121")
        async with engine.connect() as connection:
            assert await connection.scalar(tables) == 2
            assert await connection.scalar(text("SELECT version_num FROM alembic_version")) == "121"
    finally:
        await engine.dispose()
