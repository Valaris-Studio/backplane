# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Only run against an explicitly supplied disposable migrated PostgreSQL DB."""

import asyncio
import os
import uuid

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.exceptions import ConflictError, ResourceNotFoundError
from app.models.mcp_invocation import MCPInvocation
from app.models.user import User
from app.schemas.mcp_invocation import MCPInvocationCreate
from app.services.mcp_invocation import MCPInvocationService


@pytest.mark.slow
async def test_postgres_concurrent_receipts_and_caller_rollback():
    url = os.environ.get("MCP_INVOCATION_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Requires explicit disposable migrated PostgreSQL database")
    engine = create_async_engine(url, hide_parameters=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    owner, other = uuid.uuid4(), uuid.uuid4()
    data = MCPInvocationCreate(
        id=uuid.uuid4(),
        tool_name="get_server_info",
        status="completed",
        started_at="2026-09-24T02:00:00Z",
        completed_at="2026-09-24T02:00:01Z",
        duration_seconds=1,
    )
    try:
        async with factory.begin() as db:
            db.add_all(
                [
                    User(
                        id=uid,
                        email=uid.hex + "@example.test",
                        name="Synthetic invocation",
                    )
                    for uid in [owner, other]
                ]
            )

        async def record():
            async with factory.begin() as db:
                return (await MCPInvocationService(db).record(owner, data)).id

        assert (
            await asyncio.wait_for(asyncio.gather(*(record() for _ in range(8))), 10)
            == [data.id] * 8
        )
        async with factory.begin() as db:
            assert (
                await db.scalar(
                    select(func.count())
                    .select_from(MCPInvocation)
                    .where(MCPInvocation.owner_id == owner)
                )
                == 1
            )
            with pytest.raises(ConflictError):
                await MCPInvocationService(db).record(
                    owner, data.model_copy(update={"status": "failed"})
                )
            with pytest.raises(ResourceNotFoundError):
                await MCPInvocationService(db).record(other, data)
        rolled_back = data.model_copy(update={"id": uuid.uuid4()})
        async with factory() as db:
            await MCPInvocationService(db).record(owner, rolled_back)
            await db.rollback()
        async with factory() as db:
            assert await db.get(MCPInvocation, rolled_back.id) is None
    finally:
        async with factory.begin() as db:
            await db.execute(delete(User).where(User.id.in_([owner, other])))
        await engine.dispose()


@pytest.mark.slow
@pytest.mark.parametrize(
    "field",
    [
        "tool_name",
        "workspace_slug",
        "arguments_summary",
        "result_summary",
        "error_message",
    ],
)
@pytest.mark.parametrize("invalid", ["\x00", "\ud800"])
async def test_postgres_unsupported_text_is_validation_error_without_aborting_transaction(
    field, invalid
):
    from app.exceptions import ValidationError

    url = os.environ.get("MCP_INVOCATION_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Requires explicit disposable migrated PostgreSQL database")
    engine = create_async_engine(url, hide_parameters=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    owner = uuid.uuid4()
    data = MCPInvocationCreate(
        id=uuid.uuid4(),
        tool_name="synthetic",
        status="completed",
        started_at="2026-09-24T02:00:00Z",
        completed_at="2026-09-24T02:00:01Z",
        duration_seconds=1,
    ).model_copy(update={field: "SC04_PRIVATE_PG_SENTINEL" + invalid})
    try:
        async with factory.begin() as db:
            db.add(
                User(
                    id=owner,
                    email=owner.hex + "@example.test",
                    name="Synthetic text validation",
                )
            )
        async with factory.begin() as db:
            with pytest.raises(ValidationError) as raised:
                await MCPInvocationService(db).record(owner, data)
            assert "SC04_PRIVATE_PG_SENTINEL" not in str(raised.value)
            assert (
                await db.scalar(
                    select(func.count())
                    .select_from(MCPInvocation)
                    .where(MCPInvocation.owner_id == owner)
                )
                == 0
            )
    finally:
        async with factory.begin() as db:
            await db.execute(delete(User).where(User.id == owner))
        await engine.dispose()
