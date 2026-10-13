# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Fresh dispatch belongs to the bound role and exact invocation step."""

import uuid

import pytest
from sqlalchemy import delete, update

from app.models.agents.prompt_config import AgentPromptConfig
from app.models.kanban.card import Card
from app.services.agents.prompt_defaults import PROMPT_STAGE_REGISTRY
from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG
from tests.routers.agents.context_dispatch_support import (
    INVOCATION,
    MODEL,
    PROVIDER,
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    finding_codes,
    two_steps,
)
from tests.routers.agents.context_receipts_support import ALIAS, ROLE

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]


async def test_snapshot_is_current_and_retains_arbitrary_role_provider_and_template(dispatch_case):
    d = dispatch_case
    _, execution, _ = await d.bound()
    current = await d.current(execution)
    assert current["protocol_version"] == 1 and current["mode"] == "required"
    assert current["execution_id"] == execution["id"]
    assert current["context_binding"]["role"] == ROLE
    assert current["invocation"] == INVOCATION
    assert current["dispatch"]["provider"] == PROVIDER and current["dispatch"]["model"] == MODEL
    assert current["dispatch"]["prompt_slug"] == "operator-template-47"
    assert current["dispatch"]["input_template"].startswith("Current template 🧪\n")
    # The real prompt API adds this imperative; raw row content is not effective content.
    assert "You MUST emit your full output in the `findings` field" in current["dispatch"]["input_template"]
    assert current["dispatch"]["system_template"] == ""
    assert current["card"]["id"] == d.case.card_id
    assert len(current["dispatch_revision"]) == len(current["context_revision"]) == 64
    assert (await d.current(execution))["dispatch_revision"] == current["dispatch_revision"]


@pytest.mark.parametrize("change", ["template", "tool_policy", "model", "card"])
async def test_config_and_render_input_changes_invalidate_prepare_without_note_drift(dispatch_case, change):
    d = dispatch_case
    _, execution, _ = await d.bound()
    before = await d.current(execution)
    payload = d.payload(before)
    if change in {"template", "card"}:
        async with d.case.factory() as db:
            statement = (update(AgentPromptConfig).where(AgentPromptConfig.id == d.template_id)
                         .values(content="New complete authored template 🧪")) if change == "template" else (
                update(Card).where(Card.id == uuid.UUID(d.case.card_id)).values(title="Changed current card title"))
            await db.execute(statement)
            await db.commit()
    elif change == "tool_policy":
        await d.store(lambda p: p["stages"][0]["llm"].update(tool_policy={"deny": ["Bash(revised-policy:*)"]}))
    else:
        await d.store(lambda p: p["stages"][0]["llm"].update(model="operator-model-48"))
    after = await d.current(execution)
    assert after["context_revision"] == before["context_revision"]
    assert after["dispatch_revision"] != before["dispatch_revision"]
    response = await d.prepare(execution, payload)
    assert response.status_code == 409, response.text
    assert "execution_dispatch_changed" in finding_codes(response)
    history = await d.case.http.get(d.case.execution_path(execution["id"]) + "/context-receipts",
                                    headers=d.headers("recipient"))
    assert history.status_code == 200 and history.json() == []


async def test_named_second_llm_step_overrides_sources_and_tools_without_contaminating_first(dispatch_case):
    d = dispatch_case
    await d.store(two_steps)
    _, execution, _ = await d.bound()
    invocation = {"kind": "lifecycle", "step_name": "second_call", "prompt_slot": "main"}
    second = await d.current(execution, invocation)
    assert second["invocation"] == invocation
    assert set(second["context"]) == {"SecondContext47"}
    assert second["dispatch"]["required_source_indices"] == [0]
    assert second["dispatch"]["tool_policy"] == {"deny": ["Bash(never-second:*)"]}
    first = await d.current(execution, {**invocation, "step_name": "first_call"})
    assert ALIAS in first["context"] and "SecondContext47" not in first["context"]
    assert first["dispatch"]["required_source_indices"] == []
    assert first["dispatch_revision"] != second["dispatch_revision"]
    # A present empty list is replacement, not a falsey fallback to flat sources.
    await d.store(lambda p: p["stages"][0]["lifecycle"][1]["params"].update(context_sources=[]))
    empty = await d.current(execution, invocation)
    assert empty["context"] == {} and empty["context_manifest"]["sources"] == []
    assert empty["dispatch"]["required_source_indices"] == []


@pytest.mark.parametrize("missing", ["role", "step", "template"])
async def test_removed_bound_role_step_or_template_has_no_legacy_fallback(dispatch_case, missing):
    d = dispatch_case
    await d.store(two_steps)
    _, execution, _ = await d.bound()
    invocation = {"kind": "lifecycle", "step_name": "second_call", "prompt_slot": "main"}
    await d.current(execution, invocation)
    if missing == "template":
        async with d.case.factory() as db:
            await db.execute(delete(AgentPromptConfig).where(AgentPromptConfig.id == d.template_id))
            await db.commit()
    elif missing == "role":
        await d.store(lambda p: p.update(stages=[]))
    else:
        await d.store(lambda p: p["stages"][0].update(lifecycle=[]))
    response = await d.snapshot(execution, invocation)
    assert response.status_code == 409, response.text
    assert "execution_dispatch_unavailable" in finding_codes(response)


async def test_caller_cannot_choose_an_unrelated_step_or_prompt_slot(dispatch_case):
    d = dispatch_case
    _, execution, _ = await d.bound()
    for invocation in [
        {"kind": "lifecycle", "step_name": "not_in_bound_role", "prompt_slot": "main"},
        {"kind": "stage", "step_name": None, "prompt_slot": "private-unrelated-slug"},
    ]:
        response = await d.snapshot(execution, invocation)
        assert response.status_code in {409, 422}, response.text
        assert "input_template" not in response.text


def test_default_auxiliary_slots_resolve_existing_seeded_prompt_targets():
    implementer = next(s for s in DEFAULT_PIPELINE_CONFIG["stages"] if s["role"] == "implementer")
    slots = implementer["llm"].get("prompt_slots")
    assert slots == {
        "mediate_rework": {"role": "rework_mediator", "stage": "mediate_rework"},
        "implement_after_approval": {"role": "implementer", "stage": "implement_after_approval"},
        "rework_implement": {"role": "implementer", "stage": "rework_implement"},
    }, "Default required-mode rework must not depend on a compiled runner fallback"
    for target in slots.values():
        assert any(p.role == target["role"] and p.stage == target["stage"] for p in PROMPT_STAGE_REGISTRY)


@pytest.mark.parametrize(("kind", "slot"), [
    ("mediation", "mediate_rework"), ("post_approval", "implement_after_approval"),
    ("stage", "rework_implement"),
])
async def test_auxiliary_slot_targets_come_from_policy_and_refresh_current_scoped_content(dispatch_case, kind, slot):
    d = dispatch_case
    target_role = "configured_aux_role_52"
    target_stage = "configured_aux_stage_52"
    target_id = uuid.uuid4()
    await d.store(lambda p: p["stages"][0]["llm"].update(prompt_slots={
        slot: {"role": target_role, "stage": target_stage},
    }))
    async with d.case.factory() as db:
        for scope, content, ident in [
            (None, "System auxiliary 🧪", uuid.uuid4()),
            (uuid.UUID(d.case.workspace["id"]), "Workspace auxiliary 🧪", target_id),
            (uuid.UUID(d.case.foreign_workspace["id"]), "FOREIGN_PRIVATE_AUX", uuid.uuid4()),
        ]:
            db.add(AgentPromptConfig(id=ident, name="Auxiliary fixture", slug="operator-aux-slot-52",
                team_role=target_role, stage=target_stage, content=content, workspace_id=scope,
                created_by_id=uuid.UUID(d.case.recipient_id)))
        await db.commit()
    _, execution, _ = await d.bound()
    invocation = {"kind": kind, "step_name": None, "prompt_slot": slot}
    current = await d.current(execution, invocation)
    assert current["dispatch"]["input_template"] == "Workspace auxiliary 🧪"
    assert current["dispatch"]["prompt_target"] == {"role": target_role, "stage": target_stage}
    assert current["context_binding"]["role"] == ROLE
    assert "FOREIGN_PRIVATE_AUX" not in json_text(current)
    async with d.case.factory() as db:
        await db.execute(delete(AgentPromptConfig).where(AgentPromptConfig.id == target_id))
        await db.commit()
    system = await d.current(execution, invocation)
    assert system["dispatch"]["input_template"] == "System auxiliary 🧪"
    assert system["dispatch_revision"] != current["dispatch_revision"]
    await d.store(lambda p: p["stages"][0]["llm"].update(prompt_slots={}))
    unavailable = await d.snapshot(execution, invocation)
    assert unavailable.status_code == 409, unavailable.text
    assert "execution_dispatch_unavailable" in finding_codes(unavailable)


def json_text(value):
    import json
    return json.dumps(value, ensure_ascii=False)
