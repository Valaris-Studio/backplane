# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import os
import uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.core.auth import current_agent_id, get_current_user
from app.database import get_db
from app.main import create_app
from app.models.agents.agent import Agent, AgentType  # noqa: F401
from app.models.agents.execution import AgentExecution  # noqa: F401
from app.models.agents.prompt_config import AgentPromptConfig  # noqa: F401
from app.models.agents.merge_queue import MergeQueueEntry  # noqa: F401
from app.models.agents.reservation import AgentReservation  # noqa: F401
from app.models.agents.tool_invocation import ToolInvocation  # noqa: F401
from app.models.agents.team import AgentTeam, AgentTeamMember  # noqa: F401
from app.models.approvals.approval import ApprovalRequest  # noqa: F401
from app.models.webhooks.webhook import Webhook  # noqa: F401
from app.models.alerts.alert_threshold import AlertThreshold  # noqa: F401
from app.models.base import Base
from app.models.channels.channel import Channel, ChannelType
from app.models.git.git_repo import GitProvider, GitRepo
from app.models.definitions.definition import Definition
from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardParticipant
from app.models.kanban.column import Column
from app.models.notes.note import Note
from app.models.notifications.notification import Notification  # noqa: F401
from app.models.notifications.preference import NotificationPreference  # noqa: F401
from app.models.resources.resource import Resource, ResourceType
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.models.workspace_config import WorkspaceConfig  # noqa: F401

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"


@pytest.fixture(scope="session", autouse=True)
def _integrations_token_key():
    # Generate a fresh Fernet key per test session so FernetTokenVault can
    # encrypt/decrypt without us hardcoding a key (security smell). Autouse +
    # session scope guarantees this runs before any test body reads settings.
    from cryptography.fernet import Fernet

    os.environ["INTEGRATIONS_TOKEN_KEY"] = Fernet.generate_key().decode()
    # OAuth state cookie signing — tests need a stable key so itsdangerous
    # can round-trip the cookie. GitHub OAuth client credentials are also
    # set so the start endpoint doesn't 503 in test runs that exercise it.
    os.environ.setdefault(
        "OAUTH_STATE_SIGNING_KEY", "test-oauth-state-key-deadbeef-xyz"
    )
    os.environ.setdefault("GITHUB_OAUTH_CLIENT_ID", "test-client-id")
    os.environ.setdefault("GITHUB_OAUTH_CLIENT_SECRET", "test-client-secret")
    # Re-read settings so the new env vars are picked up by anything that
    # imported settings before they were set. Mutate the EXISTING singleton
    # in place instead of rebinding `config_module.settings`: test/app modules
    # are imported at collection time (before this fixture runs) and many hold
    # a `from app.config import settings` reference — rebinding would leave two
    # divergent Settings objects alive (split-brain), an order-dependent hazard
    # under pytest-xdist.
    from app.config import Settings
    import app.config as config_module

    config_module.settings.__dict__.update(Settings().__dict__)
    yield


@pytest.fixture(scope="session")
def anyio_backend():
    return "asyncio"


@pytest_asyncio.fixture
async def db_engine():
    # One PRIVATE engine (= one private :memory: DB) per test, disposed at
    # teardown. The previous design shared a single module-level StaticPool
    # engine across every test in the worker process: the lone aiosqlite
    # connection (and its writer thread) outlived each test's event loop, so a
    # straggling/cancelled operation from test N could land after test N+1's
    # create_all — leaking rows into "empty DB" assertions and flaking the
    # `-n auto` deploy gate (order-dependent, never reproducible serially).
    # A per-test engine makes cross-test bleed structurally impossible and
    # drop_all unnecessary (dispose() closes the only connection; the
    # in-memory DB vanishes with it).
    #
    # An aiosqlite `:memory:` DB is PRIVATE to each physical connection, so
    # StaticPool is still required WITHIN the test: it forces every checkout
    # (create_all + all sessions) onto the same connection / same DB;
    # check_same_thread=False lets that connection cross asyncio task
    # boundaries.
    engine = create_async_engine(
        TEST_DB_URL,
        echo=False,
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )

    # SQLite ships with FK enforcement OFF — without this pragma, deletes that
    # would violate NOT NULL FKs on Postgres (prod) silently pass in tests.
    @event.listens_for(engine.sync_engine, "connect")
    def _enable_sqlite_fk(dbapi_connection, _connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture
async def db_session(db_engine):
    session_factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield session


@pytest_asyncio.fixture(autouse=True)
async def _api_key_touch_uses_test_engine(db_engine, monkeypatch):
    """Keep ApiKeyService's usage stamp off the real database.

    The touch runs on EVERY API-key-authenticated request and deliberately opens
    its own session (it must survive get_db's rollback), so unpatched it resolves
    `app.database.async_session` — the real engine, pointed at whatever
    DATABASE_URL says. With a dev Postgres up on localhost that means live
    connections opened mid-suite: they bind to the per-test event loop, outlive
    it, and produce order-dependent failures plus a hang at interpreter exit.
    The touch swallows its own exceptions, so this leaks SILENTLY from any test
    that authenticates with a vlr_ key, not just the ones that test stamping.

    Autouse and unconditional: the hazard belongs to the auth path, not to the
    handful of suites that assert on it.
    """
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    import app.services.api_key as api_key_module

    monkeypatch.setattr(api_key_module, "async_session", factory)
    return factory


@pytest_asyncio.fixture
async def test_user(db_session: AsyncSession) -> User:
    user = User(email="dev@valaris.dev", name="Dev User")
    db_session.add(user)
    await db_session.flush()
    return user


@pytest_asyncio.fixture
async def second_user(db_session: AsyncSession) -> User:
    user = User(email="other@valaris.dev", name="Other User")
    db_session.add(user)
    await db_session.flush()
    return user


@pytest_asyncio.fixture
async def test_workspace(db_session: AsyncSession, test_user: User) -> Workspace:
    workspace = Workspace(name="Default", slug="default", created_by=test_user.id)
    db_session.add(workspace)
    await db_session.flush()
    member = WorkspaceMember(
        workspace_id=workspace.id, user_id=test_user.id, role=WorkspaceRole.owner
    )
    db_session.add(member)
    await db_session.flush()
    return workspace


@pytest_asyncio.fixture
async def test_board(db_session: AsyncSession, test_workspace: Workspace, test_user: User) -> Board:
    board = Board(
        workspace_id=test_workspace.id,
        name="Test Board",
        slug="test-board",
        description="A test board",
        created_by=test_user.id,
    )
    db_session.add(board)
    await db_session.flush()
    return board


@pytest_asyncio.fixture
async def test_column(db_session: AsyncSession, test_board: Board) -> Column:
    column = Column(board_id=test_board.id, name="To Do", position=1024.0, color="#6b7280")
    db_session.add(column)
    await db_session.flush()
    return column


@pytest_asyncio.fixture
async def test_card(
    db_session: AsyncSession, test_board: Board, test_column: Column, test_user: User
) -> Card:
    card = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title="Test Card",
        description="A test card",
        position=1024.0,
        created_by=test_user.id,
    )
    db_session.add(card)
    await db_session.flush()
    return card


@pytest_asyncio.fixture
async def client(db_session: AsyncSession, test_user: User) -> AsyncClient:
    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        return test_user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest_asyncio.fixture
async def test_note(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
) -> Note:
    note = Note(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        title="Test Note",
        content="Test content",
        created_by=test_user.id,
    )
    db_session.add(note)
    await db_session.flush()
    return note


@pytest_asyncio.fixture
async def test_definition(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
) -> Definition:
    definition = Definition(
        board_id=test_board.id,
        workspace_id=test_workspace.id,
        scope="Build the MVP",
        content={"tech_stack": ["Python"]},
        updated_by=test_user.id,
    )
    db_session.add(definition)
    await db_session.flush()
    return definition


@pytest_asyncio.fixture
async def test_channel(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
) -> Channel:
    channel = Channel(
        workspace_id=test_workspace.id,
        name="Test Channel",
        channel_type=ChannelType.email,
        contact_value="test@valaris.dev",
        description="A test channel",
        created_by=test_user.id,
    )
    db_session.add(channel)
    await db_session.flush()
    return channel


@pytest_asyncio.fixture
async def test_git_repo(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
) -> GitRepo:
    git_repo = GitRepo(
        board_id=test_board.id,
        workspace_id=test_workspace.id,
        name="Test Repo",
        slug="test-repo",
        url="https://github.com/valaris/test-repo",
        provider=GitProvider.github,
        default_branch="main",
        description="A test repository",
        added_by=test_user.id,
    )
    db_session.add(git_repo)
    await db_session.flush()
    return git_repo


@pytest_asyncio.fixture
async def test_resource(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
) -> Resource:
    resource = Resource(
        workspace_id=test_workspace.id,
        name="test-file.txt",
        resource_type=ResourceType.file,
        mime_type="text/plain",
        size_bytes=1024,
        uploaded_by=test_user.id,
        meta={},
    )
    db_session.add(resource)
    await db_session.flush()
    return resource


@pytest_asyncio.fixture
async def test_agent(db_session: AsyncSession, test_user: User) -> Agent:
    agent = Agent(
        name="test-agent",
        agent_type=AgentType.coding,
        description="A test agent",
        created_by_id=test_user.id,
        is_active=True,
    )
    db_session.add(agent)
    await db_session.flush()
    return agent


@pytest_asyncio.fixture
async def agent_client(db_session: AsyncSession, test_user: User, test_agent: Agent) -> AsyncClient:
    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        current_agent_id.set(test_agent.id)
        return test_user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
