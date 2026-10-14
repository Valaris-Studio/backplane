# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Current start authority after a proven PostgreSQL reservation-lock wait."""

import asyncio
import json
import uuid

import pytest
from sqlalchemy import func, select, text

from app.models.agents.context_receipt import ExecutionContextBinding, ExecutionContextReceipt
from app.models.agents.reservation import AgentReservation
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.agents.context import ContextReceiptCreate, ContextReceiptRead
from app.schemas.agents.execution import ExecutionCreate
from app.services.agents.execution import ExecutionService
from app.services.agents.execution_context import ExecutionContextService
from tests.routers.agents.context_receipts_support import (
    _receipt_case_fixture,  # noqa: F401
)
from tests.routers.agents.test_context_receipts_postgres import (
    db_engine,  # noqa: F401
    execution_count,
    history,
    pg_http as _pg_http_fixture,
)
from tests.routers.agents.test_context_receipts_review_postgres import (
    blocked_http_post,
    commit_revocation,
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(40)]
pg_http = _pg_http_fixture


@pytest.mark.parametrize("promotion", ["fresh_promotion", "concurrent_winner_replay"])
@pytest.mark.parametrize("revocation", ["none", "membership", "agent_scope", "agent_inactive"])
async def test_start_rechecks_current_authority_after_reservation_lock_wait(
    pg_http, promotion, revocation, record_property,
):
    case = pg_http.case
    assignment = await case.assignment()
    payload = case.start_payload(assignment)
    path = f"/api/agents/{case.agent_id}/executions"
    retained = None

    async with case.factory() as blocker:
        blocker_pid = await blocker.scalar(text("SELECT pg_backend_pid()"))
        if promotion == "fresh_promotion":
            hold = await blocker.scalar(select(AgentReservation).where(
                AgentReservation.id == uuid.UUID(assignment["reservation"]["id"])
            ).with_for_update())
            assert hold is not None
        else:
            # This winner is authorized and prepared before revocation, but
            # its execution/binding stay invisible until the outer commit.
            execution, created = await ExecutionService(blocker).start_bound_execution(
                uuid.UUID(case.agent_id), ExecutionCreate(**payload),
                user_id=uuid.UUID(case.recipient_id),
            )
            assert created
            workspace = await blocker.get(Workspace, uuid.UUID(case.workspace["id"]))
            owner = await blocker.get(User, uuid.UUID(case.recipient_id))
            receipt, prepared = await ExecutionContextService(blocker).prepare(
                workspace, execution.id, owner,
                ContextReceiptCreate(**case.receipt_payload(assignment)),
            )
            assert prepared
            retained = ContextReceiptRead.model_validate(receipt).model_dump(mode="json")
        assert await execution_count(case) == 0

        # Plain owner-key authentication stays valid when its agent is
        # deactivated, so the service must recheck the bound agent itself.
        async with blocked_http_post(
            pg_http, path, payload, blocker_pid, record_property, actor="recipient",
        ) as request:
            await commit_revocation(case, revocation)
            await blocker.commit()
            response = await asyncio.wait_for(request, 10)

    executions = await execution_count(case)
    async with case.factory() as db:
        bindings = await db.scalar(select(func.count()).select_from(ExecutionContextBinding))
        receipts = await db.scalar(select(func.count()).select_from(ExecutionContextReceipt))

    if retained is not None:
        visible = await case.receipt(
            {"id": retained["execution_id"]}, retained["id"], actor="curator",
        )
        assert visible.status_code == 200 and visible.json() == retained
        await history(case, {"id": retained["execution_id"]}, 1)

    observed = {"promotion": promotion, "revocation": revocation,
                "status": response.status_code, "execution_count": executions,
                "binding_count": bindings, "receipt_count": receipts,
                "historical_snapshot_unchanged": retained is not None}
    record_property("result", json.dumps(observed))
    if revocation != "none":
        assert response.status_code == 403, observed
        winner_count = 1 if promotion == "concurrent_winner_replay" else 0
        assert executions == bindings == receipts == winner_count, observed
    else:
        assert response.status_code == (201 if promotion == "fresh_promotion" else 200), observed
        assert executions == bindings == 1, observed
        assert receipts == (1 if retained else 0), observed
        if retained is not None:
            assert response.json()["id"] == retained["execution_id"]
