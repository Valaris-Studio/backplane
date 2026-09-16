# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Service-level tests for AgentService.pause_agent / resume_agent.

Card 49f8bb82. Verifies the unit-level contract independently of HTTP:
- State transition flips the flag and persists.
- Idempotent calls do not re-flush or re-emit events.
- Owner check raises ResourceNotFoundError for foreign agents (404 shape).
"""
from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.exceptions import ResourceNotFoundError
from app.models.agents.agent import Agent, AgentType
from app.models.user import User
from app.models.workspace import Workspace
from app.services.agents.agent import AgentService


async def _make_agent(
    db: AsyncSession, owner: User, workspace_slug: str, *, paused: bool = False
) -> Agent:
    agent = Agent(
        name=f"svc-{workspace_slug}-{int(paused)}",
        agent_type=AgentType.coding,
        description="",
        created_by_id=owner.id,
        allowed_workspaces=[workspace_slug],
        is_active=True,
        is_paused=paused,
    )
    db.add(agent)
    await db.flush()
    return agent


@pytest.mark.asyncio
async def test_pause_agent_flips_flag_and_emits_event(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    agent = await _make_agent(db_session, test_user, test_workspace.slug)
    received = []

    async def cap(event):
        received.append(event)

    unsub = event_bus.subscribe(
        cap, workspace_id=test_workspace.id, event_pattern="agent.paused"
    )
    try:
        updated = await AgentService(db_session).pause_agent(agent.id, test_user.id)
    finally:
        unsub()

    assert updated.is_paused is True
    assert len(received) == 1


@pytest.mark.asyncio
async def test_pause_idempotent_no_extra_event(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    agent = await _make_agent(db_session, test_user, test_workspace.slug, paused=True)
    received = []

    async def cap(event):
        received.append(event)

    unsub = event_bus.subscribe(
        cap, workspace_id=test_workspace.id, event_pattern="agent.paused"
    )
    try:
        updated = await AgentService(db_session).pause_agent(agent.id, test_user.id)
    finally:
        unsub()

    assert updated.is_paused is True
    assert received == []


@pytest.mark.asyncio
async def test_resume_agent_flips_flag_and_emits_event(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    agent = await _make_agent(db_session, test_user, test_workspace.slug, paused=True)
    received = []

    async def cap(event):
        received.append(event)

    unsub = event_bus.subscribe(
        cap, workspace_id=test_workspace.id, event_pattern="agent.resumed"
    )
    try:
        updated = await AgentService(db_session).resume_agent(agent.id, test_user.id)
    finally:
        unsub()

    assert updated.is_paused is False
    assert len(received) == 1


@pytest.mark.asyncio
async def test_resume_idempotent_no_extra_event(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    agent = await _make_agent(db_session, test_user, test_workspace.slug, paused=False)
    received = []

    async def cap(event):
        received.append(event)

    unsub = event_bus.subscribe(
        cap, workspace_id=test_workspace.id, event_pattern="agent.resumed"
    )
    try:
        updated = await AgentService(db_session).resume_agent(agent.id, test_user.id)
    finally:
        unsub()

    assert updated.is_paused is False
    assert received == []


@pytest.mark.asyncio
async def test_pause_foreign_agent_raises_not_found(
    db_session: AsyncSession,
    test_user: User,
    second_user: User,
    test_workspace: Workspace,
):
    foreign = await _make_agent(db_session, second_user, test_workspace.slug)
    with pytest.raises(ResourceNotFoundError):
        await AgentService(db_session).pause_agent(foreign.id, test_user.id)


@pytest.mark.asyncio
async def test_resume_foreign_agent_raises_not_found(
    db_session: AsyncSession,
    test_user: User,
    second_user: User,
    test_workspace: Workspace,
):
    foreign = await _make_agent(
        db_session, second_user, test_workspace.slug, paused=True
    )
    with pytest.raises(ResourceNotFoundError):
        await AgentService(db_session).resume_agent(foreign.id, test_user.id)
