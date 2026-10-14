# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Final declared channels are bounded without claiming provider consumption."""

import asyncio
import uuid

import pytest
from sqlalchemy import update

from app.core.event_bus import event_bus
from app.models.agents.agent import Agent
from app.models.agents.execution import AgentExecution
from app.models.agents.prompt_config import AgentPromptConfig
from tests.routers.agents.context_budget_policy_support import (
    SMALL_POLICY,
    assert_policy,
    bound_budget,
    history,
)
from tests.routers.agents.context_budgets_support import policy_digest, utf8
from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    finding_codes,
)
from tests.routers.agents.context_receipts_support import ALIAS, sha256

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]


@pytest.mark.parametrize("shape", ["required_twice", "system_addition", "resume_addition"])
async def test_final_utf8_cap_is_exact_and_rejection_consumes_no_receipt_key_or_event(dispatch_case, shape):
    d = dispatch_case
    execution, snapshot = await bound_budget(d, required=shape == "required_twice")
    assert_policy(snapshot, SMALL_POLICY)
    block = snapshot["context"][ALIAS]
    limit = SMALL_POLICY["max_invocation_bytes"]
    prompt = "PRIVATE_BUDGET_INPUT é🧪e\u0301\r\n" + block
    system = "PRIVATE_BUDGET_SYSTEM 🧭\r\n"
    if shape == "required_twice":
        prompt += "\r\nAuthored second occurrence:\r\n" + block
    elif shape == "resume_addition":
        prompt += "\r\nResume with operator approval: continue 🧪\r\n"
    remaining = limit - utf8(prompt) - utf8(system)
    assert remaining > 0
    if shape == "system_addition":
        system += "s" * remaining
    else:
        prompt += "p" * remaining
    payload = d.payload(snapshot, input_prompt=prompt, system_prompt=system,
                        channel_contract={"version": 1, "input": "verbatim", "system": "verbatim",
                                          "resume": shape == "resume_addition"},
                        resume_session_id="operator-session-47" if shape == "resume_addition" else None)
    assert utf8(prompt) + utf8(system) == limit
    assert len(prompt) + len(system) < limit  # A character-count oracle would accept the excess.
    published = []

    async def receive(event):
        published.append(event)

    unsubscribe = event_bus.subscribe(receive, workspace_id=uuid.UUID(d.case.workspace["id"]),
                                      event_pattern="execution.context_receipt_created")
    try:
        excess = {**payload, "system_prompt": system + "!"}
        response = await d.prepare(execution, excess)
        assert response.status_code == 409, response.text
        assert "context_budget_exceeded" in finding_codes(response)
        assert response.json()["context"] == {
            "reason": "invocation_bytes", "limit": limit, "prompt_bytes": utf8(prompt),
            "system_prompt_bytes": utf8(system) + 1, "total_bytes": limit + 1,
            "policy_sha256": policy_digest(SMALL_POLICY),
        }
        assert "PRIVATE_BUDGET_INPUT" not in response.text and "PRIVATE_BUDGET_SYSTEM" not in response.text
        assert "receipt_id" not in response.json() and "acknowledged" not in response.json()
        assert await history(d, execution) == []
        await asyncio.sleep(0.01)
        assert published == []

        accepted = await d.prepare(execution, payload)
        assert accepted.status_code == 201, accepted.text
        ack = accepted.json()
        assert ack["ordinal"] == 1 and ack["acknowledged"] == "prepared"
        assert ack["use_verification"] == "not_verified"
        for field, value in [("prompt", prompt), ("system_prompt", system)]:
            assert ack[field + "_bytes"] == utf8(value)
            assert ack[field + "_sha256"] == sha256(value)
        saved = await d.case.receipt(execution, ack["receipt_id"])
        assert saved.status_code == 200, saved.text
        detail = saved.json()
        assert detail["input_prompt"] == prompt and detail["system_prompt"] == system
        assert detail["context_manifest"] == snapshot["context_manifest"]
        assert detail["status"] == "prepared" and detail["use_verification"] == "not_verified"
        if shape == "required_twice":
            assert detail["dispatch"]["source_inclusions"][0]["contribution_bytes"] == 2 * utf8(block)
        replay = await d.prepare(execution, payload)
        assert replay.status_code == 200 and replay.json()["receipt_id"] == ack["receipt_id"]
        assert len(await history(d, execution)) == 1
        await asyncio.sleep(0.01)
        assert len(published) == 1
        assert published[0].payload["receipt_id"] == ack["receipt_id"]
    finally:
        unsubscribe()


@pytest.mark.parametrize("drift", ["policy", "template"])
async def test_current_revisions_precede_exact_retry_and_final_size_acceptance(dispatch_case, drift):
    d = dispatch_case
    execution, before = await bound_budget(d)
    payload = d.payload(before)
    created = await d.prepare(execution, payload)
    assert created.status_code == 201, created.text
    receipt_id = created.json()["receipt_id"]
    if drift == "policy":
        await d.store(lambda p: p["context_budget"].update(max_invocation_bytes=SMALL_POLICY["max_invocation_bytes"] - 1))
    else:
        async with d.case.factory() as db:
            await db.execute(update(AgentPromptConfig).where(AgentPromptConfig.id == d.template_id)
                             .values(content="Changed authored template 🧪\r\n"))
            await db.commit()
    after = await d.current(execution)
    assert after["context"] == before["context"]
    assert after["dispatch_revision"] != before["dispatch_revision"]
    if drift == "policy":
        assert after["context_revision"] != before["context_revision"]
    else:
        assert after["context_revision"] == before["context_revision"]
    for request in [payload, {**payload, "client_request_id": str(uuid.uuid4()),
                              "input_prompt": "PRIVATE_STALE_INPUT" + "x" * (SMALL_POLICY["max_invocation_bytes"] + 1)}]:
        response = await d.prepare(execution, request)
        assert response.status_code == 409, response.text
        expected = "execution_context_changed" if drift == "policy" else "execution_dispatch_changed"
        assert expected in finding_codes(response)
        assert "context_budget_exceeded" not in finding_codes(response)
        assert "receipt_id" not in response.json() and "PRIVATE_STALE_INPUT" not in response.text
    assert [r["id"] for r in await history(d, execution)] == [receipt_id]
    old = (await d.case.receipt(execution, receipt_id)).json()
    assert old["context_manifest"] == before["context_manifest"]
    refreshed = await d.prepare(execution, d.payload(after))
    assert refreshed.status_code == 201 and refreshed.json()["ordinal"] == 2, refreshed.text


@pytest.mark.parametrize("revocation", ["inactive", "terminal"])
async def test_current_authority_and_binding_precede_retry_and_budget_diagnostics(dispatch_case, revocation):
    d = dispatch_case
    execution, snapshot = await bound_budget(d)
    payload = d.payload(snapshot)
    created = await d.prepare(execution, payload)
    assert created.status_code == 201, created.text
    async with d.case.factory() as db:
        stmt = (update(Agent).where(Agent.id == uuid.UUID(d.case.agent_id)).values(is_active=False)
                if revocation == "inactive" else
                update(AgentExecution).where(AgentExecution.id == uuid.UUID(execution["id"])).values(status="completed"))
        await db.execute(stmt)
        await db.commit()
    for request in [payload, {**payload, "input_prompt": "PRIVATE_REVOKED_INPUT" + "x" * (SMALL_POLICY["max_invocation_bytes"] + 1)}]:
        response = await d.prepare(execution, request, actor="recipient")
        assert response.status_code == (403 if revocation == "inactive" else 409), response.text
        assert "context_budget_exceeded" not in finding_codes(response)
        assert "receipt_id" not in response.json() and "PRIVATE_REVOKED_INPUT" not in response.text
    assert len(await history(d, execution)) == 1
