# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored B1 phase-2 contracts beyond the frozen set: bounded
findings for attacker-shaped policy keys, and per-source blocks that survive
duplicate aliases."""

import copy
import json
import uuid

import pytest

from app.config import settings
from app.repositories.kanban.board import BoardRepository
from app.repositories.kanban.card import CardRepository
from app.services.agents.context_budget import resolve_context_budget
from app.services.agents.guarded_context_assembly import assemble_guarded_context
from tests.routers.agents.context_budget_policy_support import findings, install_policy
from tests.routers.agents.context_budgets_support import (
    DEFAULT_POLICY,
    _budget_case_fixture,  # noqa: F401
    source,
)
from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]

LONG_KEY = "private_policy_key_" + "é🧪" * 8192
MANY_KEYS = [f"k{index:04d}" for index in range(300)]


@pytest.mark.parametrize("place", ["workspace", "stage", "second_step"])
async def test_write_findings_name_only_short_keys_and_count_the_rest(dispatch_case, place):
    d = dispatch_case
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    path = install_policy(pipeline, place, {"typo_limit": 1, LONG_KEY: 1, **dict.fromkeys(MANY_KEYS, 1)})
    response = await d.write(pipeline)
    assert response.status_code == 422, response.text[:300]
    assert LONG_KEY not in response.text
    assert len(response.content) <= 8192
    entries = findings(response)
    fields = {entry["field"] for entry in entries}
    assert path + ".typo_limit" in fields
    counted = [entry for entry in entries if entry["field"] == path]
    named = [entry for entry in entries if entry["field"].startswith(path + ".")]
    assert len(named) + counted[0]["params"]["unknown_field_count"] == 1 + 1 + len(MANY_KEYS)


async def test_persisted_stage_policy_with_attacker_keys_is_a_bounded_opaque_conflict(dispatch_case):
    d = dispatch_case
    _, execution, _ = await d.bound()
    await d.store(lambda p: p["stages"][0]["llm"].update(
        context_budget={LONG_KEY: 1, **dict.fromkeys(MANY_KEYS, 1)}))
    response = await d.snapshot(execution)
    assert response.status_code == 409, response.text[:300]
    assert response.json()["error_code"] == "context_budget_invalid"
    assert len(response.content) <= 4096
    decoded = json.dumps(response.json(), ensure_ascii=False)
    assert LONG_KEY not in decoded and not any(f'"{key}"' in decoded for key in MANY_KEYS)
    entry, = findings(response)
    assert entry["field"] == "stages[0].llm.context_budget"
    assert entry["params"]["unknown_field_count"] == 1 + len(MANY_KEYS)


async def test_guarded_blocks_keep_every_source_when_aliases_repeat(budget_case):
    case = budget_case
    first, second = await case.seed([
        {"content": "first-alias-occurrence", "kind": "kind_a"},
        {"content": "second-alias-occurrence", "kind": "kind_b"},
    ])
    sources = [source(alias="Same", filter={"kind": "kind_a"}),
               source(alias="Same", filter={"kind": "kind_b"}, required=True)]
    async with case.receipt.factory() as session:
        card = await CardRepository(session).get_by_id(uuid.UUID(case.receipt.card_id))
        board = await BoardRepository(session).get_by_id(uuid.UUID(case.receipt.board_id))
        assembled = await assemble_guarded_context(
            session, policy=resolve_context_budget(DEFAULT_POLICY, settings.CONTEXT_BUDGET_CEILINGS),
            ceilings=settings.CONTEXT_BUDGET_CEILINGS,
            workspace_id=uuid.UUID(case.receipt.workspace["id"]), card=card, board=board,
            sources=sources,
        )
    assert len(assembled.blocks) == len(assembled.manifest.sources) == 2
    assert first["content"] in assembled.blocks[0] and second["content"] in assembled.blocks[1]
    # The alias map keeps the last writer; the per-source blocks keep both.
    assert assembled.context == {"Same": assembled.blocks[1]}


async def test_assignment_and_start_refuse_a_persisted_policy_that_no_longer_resolves(dispatch_case):
    d = dispatch_case
    hold = await d.case.assignment()
    await d.store(lambda p: p.update(context_budget={"max_invocation_bytes": True, LONG_KEY: 1}))
    started = await d.case.http.post(
        f"/api/agents/{d.case.agent_id}/executions",
        json=d.case.start_payload(hold, context_dispatch_version=1,
                                  context_dispatch_policy_revision="0" * 64),
        headers=d.headers(),
    )
    for response in [await d.assignment(), started]:
        assert response.status_code == 409, response.text[:300]
        assert response.json()["error_code"] == "context_budget_invalid"
        assert len(response.content) <= 4096 and LONG_KEY not in response.text
        assert "context_budget.max_invocation_bytes" in {f["field"] for f in findings(response)}


async def test_only_pipeline_writes_must_repair_an_invalid_persisted_budget(dispatch_case):
    d = dispatch_case
    await d.store(lambda p: p.update(context_budget={"max_invocation_bytes": True}))
    before = await d.config()
    unrelated = await d.case.http.patch(d.config_path, headers=d.headers("recipient"), json={
        "card_cooldown_hours": (before.get("card_cooldown_hours") or 0) + 1,
        "expected_version": before["version"],
    })
    assert unrelated.status_code == 200, unrelated.text
    resubmitted = await d.write(copy.deepcopy(before["pipeline_config"]))
    assert resubmitted.status_code == 422, resubmitted.text
    assert "context_budget.max_invocation_bytes" in {f["field"] for f in findings(resubmitted)}
