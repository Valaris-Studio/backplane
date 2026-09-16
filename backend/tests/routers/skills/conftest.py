# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Skill-registry test fixtures (local to tests/routers/skills).

`role_client` mirrors tests/routers/test_loop_templates.py: no
get_current_user override, so the real dev-tier X-User-Email and Bearer vlr_
auth paths run — the only way a 403 can surface (the global `client` fixture
authenticates as the workspace OWNER and can never be denied).
"""

import hashlib
import secrets

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.main import create_app
from app.models.agents.agent import Agent, AgentType
from app.models.api_key import ApiKey
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole


@pytest_asyncio.fixture
async def role_client(db_session: AsyncSession) -> AsyncClient:
    app = create_app()

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


async def make_member(db: AsyncSession, workspace: Workspace) -> User:
    user = User(email="member@valaris.dev", name="member")
    db.add(user)
    await db.flush()
    db.add(
        WorkspaceMember(
            workspace_id=workspace.id, user_id=user.id, role=WorkspaceRole.member
        )
    )
    await db.flush()
    return user


async def mint_agent_key(db: AsyncSession, owner: User) -> str:
    """A real vlr_ key bound to an active agent, owned by the workspace OWNER.

    Binding it to the owner is the point: the caller's ROLE is beyond reproach,
    so a 403 can only come from `forbid_agent_callers`, not the admin gate.
    """
    raw = "vlr_" + secrets.token_urlsafe(32)
    api_key = ApiKey(
        user_id=owner.id,
        name="skill-agent-key",
        key_hash=hashlib.sha256(raw.encode()).hexdigest(),
        key_prefix=raw[:8],
    )
    db.add(api_key)
    await db.flush()
    db.add(
        Agent(
            name="skill-gating-agent",
            agent_type=AgentType.coding,
            description="skill gating pin",
            created_by_id=owner.id,
            is_active=True,
            api_key_id=api_key.id,
        )
    )
    await db.flush()
    return raw


def skill_md(
    name: str = "Code Review Ritual",
    description: str = "How this workspace reviews pull requests.",
    extra_frontmatter: str = "",
    body: str = "## Steps\n\n1. Read the diff twice.\n",
) -> str:
    frontmatter = f"name: {name}\ndescription: {description}\n"
    if extra_frontmatter:
        frontmatter += extra_frontmatter.rstrip("\n") + "\n"
    return f"---\n{frontmatter}---\n\n{body}"


@pytest.fixture
def make_files():
    """Factory for a valid SKILL.md-standard files list."""

    def _make(
        name: str = "Code Review Ritual",
        description: str = "How this workspace reviews pull requests.",
        extra_frontmatter: str = "",
        body: str = "## Steps\n\n1. Read the diff twice.\n",
        extra_files: list[dict] | None = None,
    ) -> list[dict]:
        files = [
            {
                "path": "SKILL.md",
                "content": skill_md(name, description, extra_frontmatter, body),
            }
        ]
        if extra_files:
            files.extend(extra_files)
        return files

    return _make
