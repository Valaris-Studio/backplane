# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later
"""A policy writer cannot retain a pre-wait human admin role."""

import asyncio
import json
import uuid
import pytest
from sqlalchemy import select, text, update
from app.models.workspace import WorkspaceMember, WorkspaceRole
from app.models.workspace_config import WorkspaceConfig
from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
)
from tests.routers.agents.test_context_dispatch_floor_postgres import (
    floor_http as _floor_http_fixture,
)
from tests.routers.agents.test_context_dispatch_review_paused_poll_postgres import (
    _wait_blocked_by,
)
from tests.routers.agents.test_context_receipts_postgres import db_engine  # noqa: F401

floor_http = _floor_http_fixture
pytestmark = [pytest.mark.slow, pytest.mark.timeout(40)]


@pytest.mark.parametrize("demote", [False, True])
async def test_policy_writer_requires_current_role_after_policy_wait(
    floor_http, demote, record_property
):
    f, d = floor_http, floor_http.dispatch
    config = await d.config()
    pipeline = config["pipeline_config"]
    pipeline["context_dispatch"] = {
        "version": 1,
        "required_agent_ids": [d.case.agent_id],
    }
    request = None
    async with d.case.factory() as blocker:
        try:
            await blocker.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:k,0))"),
                {"k": f'context-dispatch-policy:{d.case.workspace["id"]}'},
            )
            blocker_pid = await blocker.scalar(text("SELECT pg_backend_pid()"))
            request = asyncio.create_task(
                d.case.http.patch(
                    d.config_path,
                    json={
                        "pipeline_config": pipeline,
                        "expected_version": config["version"],
                    },
                    headers={**d.headers("recipient"), **f.gate.arm(1)},
                )
            )
            await _wait_blocked_by(f, blocker_pid, request, record_property)
            async with d.case.factory() as mutation:
                if demote:
                    await mutation.execute(
                        update(WorkspaceMember)
                        .where(
                            WorkspaceMember.workspace_id
                            == uuid.UUID(d.case.workspace["id"]),
                            WorkspaceMember.user_id == uuid.UUID(d.case.recipient_id),
                        )
                        .values(role=WorkspaceRole.viewer)
                    )
                await mutation.commit()
            await blocker.rollback()
            response = await asyncio.wait_for(request, 10)
        finally:
            await blocker.rollback()
            if request and not request.done():
                request.cancel()
            if request:
                await asyncio.gather(request, return_exceptions=True)
    async with d.case.factory() as db:
        role = await db.scalar(
            select(WorkspaceMember.role).where(
                WorkspaceMember.workspace_id == uuid.UUID(d.case.workspace["id"]),
                WorkspaceMember.user_id == uuid.UUID(d.case.recipient_id),
            )
        )
        stored = await db.scalar(
            select(WorkspaceConfig.pipeline_config).where(
                WorkspaceConfig.workspace_id == uuid.UUID(d.case.workspace["id"])
            )
        )
    observed = {
        "demote": demote,
        "current_role": role.value,
        "status": response.status_code,
        "stored_enrollment": stored.get("context_dispatch"),
    }
    record_property("observation", json.dumps(observed))
    assert response.status_code == (403 if demote else 200), observed
    assert ("context_dispatch" in stored) is (not demote), observed
