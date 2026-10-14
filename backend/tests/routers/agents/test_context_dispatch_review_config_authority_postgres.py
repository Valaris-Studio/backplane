# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored regression: every actor-initiated workspace-config
write re-checks CURRENT write authority after its blocking waits, not only
protected context policy.

A plain, previously unprotected pipeline edit (a model change) waits on the
policy lock; a distinct committed transaction demotes or removes the
writer's (or the agent key owner's) membership before release. The write
must be refused and nothing persisted. Undisturbed human and agent-key
writes still succeed."""

import asyncio
import json
import uuid

import pytest
from sqlalchemy import delete, select, text, update

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

pytestmark = [pytest.mark.slow, pytest.mark.timeout(40)]
floor_http = _floor_http_fixture
NEW_MODEL = "operator-model-after-wait"


async def _change_membership(d, change):
    async with d.case.factory() as db:
        member = (WorkspaceMember.workspace_id == uuid.UUID(d.case.workspace["id"])) & (
            WorkspaceMember.user_id == uuid.UUID(d.case.recipient_id))
        if change == "demote":
            await db.execute(update(WorkspaceMember).where(member).values(role=WorkspaceRole.member))
        elif change == "remove":
            await db.execute(delete(WorkspaceMember).where(member))
        await db.commit()


@pytest.mark.parametrize("change", ["none", "demote", "remove"])
@pytest.mark.parametrize("actor", ["recipient", "agent"])
async def test_unprotected_config_write_rechecks_authority_after_policy_wait(
    floor_http, actor, change, record_property,
):
    f, d = floor_http, floor_http.dispatch
    config = await d.config()
    pipeline = config["pipeline_config"]
    pipeline["stages"][0]["llm"]["model"] = NEW_MODEL
    request = None
    async with d.case.factory() as blocker:
        try:
            await blocker.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"),
                                  {"k": f"context-dispatch-policy:{d.case.workspace['id']}"})
            blocker_pid = await blocker.scalar(text("SELECT pg_backend_pid()"))
            request = asyncio.create_task(d.case.http.patch(
                d.config_path, json={"pipeline_config": pipeline, "expected_version": config["version"]},
                headers={**d.headers(actor, version=None), **f.gate.arm(1)}))
            await _wait_blocked_by(f, blocker_pid, request, record_property)
            await _change_membership(d, change)
            await blocker.rollback()
            response = await asyncio.wait_for(request, 10)
        finally:
            await blocker.rollback()
            if request and not request.done():
                request.cancel()
            if request:
                await asyncio.gather(request, return_exceptions=True)
    async with d.case.factory() as db:
        stored = await db.scalar(select(WorkspaceConfig.pipeline_config).where(
            WorkspaceConfig.workspace_id == uuid.UUID(d.case.workspace["id"])))
    observed = {"actor": actor, "change": change, "status": response.status_code,
                "stored_model": stored["stages"][0]["llm"]["model"]}
    record_property("observation", json.dumps(observed))
    if change == "none":
        assert response.status_code == 200, observed
        assert observed["stored_model"] == NEW_MODEL
    else:
        assert response.status_code == 403, observed
        assert observed["stored_model"] != NEW_MODEL
