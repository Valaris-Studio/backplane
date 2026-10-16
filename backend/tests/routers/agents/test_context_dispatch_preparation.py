# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""A2 preparation verifies byte inclusion and persists honest immutable evidence."""

import asyncio
import json
import uuid

import pytest
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy import delete, update

from app.core.event_bus import event_bus
from app.database import get_db
from app.main import create_app
from app.models.agents.agent import Agent
from app.models.agents.execution import AgentExecution
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.notes.note import Note
from app.models.workspace import WorkspaceMember
from tests.routers.agents.context_dispatch_support import (
    HEADER,
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    finding_codes,
)
from tests.routers.agents.context_receipts_support import ALIAS, document, note_revision, sha256

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]


async def setup_call(d, *, required=False):
    if required:
        await d.store(lambda p: p["stages"][0]["llm"]["context_sources"][0].update(required=True))
    _, execution, _ = await d.bound()
    snapshot = await d.current(execution)
    return execution, snapshot, d.payload(snapshot)


async def history(d, execution):
    response = await d.case.http.get(d.case.execution_path(execution["id"]) + "/context-receipts",
                                    headers=d.headers("recipient"))
    assert response.status_code == 200, response.text
    return response.json()


def byte_spans(text, block, channel):
    content, needle = text.encode(), block.encode()
    start, result = 0, []
    while needle and (index := content.find(needle, start)) != -1:
        result.append({"channel": channel, "start": index, "end": index + len(needle)})
        start = index + 1
    return result


async def test_ack_and_history_match_exact_utf8_channels_and_union_distinct_alias_spans(dispatch_case):
    d = dispatch_case
    execution, snapshot, payload = await setup_call(d, required=True)
    primary = snapshot["context"][ALIAS]
    repeated = snapshot["context"]["KindOnly"]
    assert repeated == snapshot["context"]["RepeatedAlias47"]
    payload.update(input_prompt="é🧪\n" + primary + "\n" + repeated + "\n" + repeated,
                   system_prompt="System 🧪\n" + repeated,
                   channel_contract={"version": 1, "input": "verbatim", "system": "verbatim", "resume": False})
    response = await d.prepare(execution, payload)
    assert response.status_code == 201, response.text
    assert response.headers.get(HEADER) == "1"
    ack = response.json()
    assert ack["acknowledged"] == "prepared" and ack["protocol_version"] == 1
    for field in ["client_request_id", "context_revision", "dispatch_revision"]:
        assert ack[field] == payload[field]
    assert ack["execution_id"] == execution["id"] and ack["ordinal"] == 1
    for prefix, value in [("prompt", payload["input_prompt"]), ("system_prompt", payload["system_prompt"])]:
        assert ack[prefix + "_sha256"] == sha256(value)
        assert ack[prefix + "_bytes"] == len(value.encode("utf-8"))
    assert ack["inclusion_verification"] == "required_blocks_exact"
    assert ack["use_verification"] == "not_verified"
    response = await d.case.receipt(execution, ack["receipt_id"])
    assert response.status_code == 200, response.text
    receipt = response.json()
    assert receipt["status"] == "prepared" and receipt["use_verification"] == "not_verified"
    assert receipt["context_manifest"] == snapshot["context_manifest"]
    assert receipt["input_prompt"] == payload["input_prompt"] and receipt["system_prompt"] == payload["system_prompt"]
    metadata = receipt["dispatch"]
    assert metadata["protocol_version"] == 1 and metadata["dispatch_revision"] == snapshot["dispatch_revision"]
    assert metadata["invocation"] == payload["invocation"]
    for field in ["adapter", "resolution_kind", "resume_session_id", "channel_contract"]:
        assert metadata[field] == payload[field]
    assert metadata["required_source_indices"] == [0]
    sources = metadata["source_inclusions"]
    assert len(sources) == 3
    for index, alias in enumerate([ALIAS, "KindOnly", "RepeatedAlias47"]):
        block = snapshot["context"][alias]
        expected = byte_spans(payload["input_prompt"], block, "input") + byte_spans(payload["system_prompt"], block, "system")
        assert sources[index] == {
            "source_index": index, "alias": alias, "required": index == 0, "outcome": "exact",
            "spans": expected, "contribution_bytes": sum(s["end"] - s["start"] for s in expected),
        }
    counts = {"input": len(primary.encode()) + 2 * len(repeated.encode()), "system": len(repeated.encode())}
    assert metadata["injected_bytes"] == {**counts, "total": sum(counts.values())}
    rows = await history(d, execution)
    assert len(rows) == 1 and "input_prompt" not in rows[0] and "dispatch" not in rows[0]
    assert rows[0]["dispatch_summary"] == {
        "protocol_version": 1, "dispatch_revision": snapshot["dispatch_revision"],
        "invocation": payload["invocation"], "inclusion_verification": "required_blocks_exact",
        "injected_bytes": metadata["injected_bytes"],
    }


@pytest.mark.parametrize("shape", ["absent", "escaped", "partial"])
async def test_required_source_not_present_whole_refuses_receipt(dispatch_case, shape):
    d = dispatch_case
    execution, snapshot, payload = await setup_call(d, required=True)
    block = snapshot["context"][ALIAS]
    payload["input_prompt"] = {"absent": "Only unrelated instructions",
                               "escaped": json.dumps(block, ensure_ascii=False), "partial": block[:-1]}[shape]
    response = await d.prepare(execution, payload)
    assert response.status_code == 422, response.text
    assert "required_context_not_verbatim" in finding_codes(response)
    assert block not in response.text and await history(d, execution) == []


async def test_required_block_can_arrive_in_explicit_system_channel(dispatch_case):
    d = dispatch_case
    execution, snapshot, payload = await setup_call(d, required=True)
    payload.update(input_prompt="Continue using the explicit system context.", system_prompt=snapshot["context"][ALIAS],
                   channel_contract={"version": 1, "input": "verbatim", "system": "verbatim", "resume": False})
    response = await d.prepare(execution, payload)
    assert response.status_code == 201, response.text
    receipt = (await d.case.receipt(execution, response.json()["receipt_id"])).json()
    assert receipt["dispatch"]["source_inclusions"][0]["spans"] == [
        {"channel": "system", "start": 0, "end": len(payload["system_prompt"].encode())},
    ]


async def test_optional_missing_block_is_unknown_not_zero_and_empty_is_distinct(dispatch_case):
    d = dispatch_case
    await d.store(lambda p: p["stages"][0]["llm"]["context_sources"].append(
        {"kind": "card_notes", "as": "EmptyOptional47", "filter": {"kind": "review_verdict", "limit": 3}}))
    execution, _, payload = await setup_call(d)
    payload["input_prompt"] = "No exact selected blocks here."
    response = await d.prepare(execution, payload)
    assert response.status_code == 201, response.text
    metadata = (await d.case.receipt(execution, response.json()["receipt_id"])).json()["dispatch"]
    assert metadata["inclusion_verification"] == "no_required_sources"
    for source in metadata["source_inclusions"][:3]:
        assert source["outcome"] == "exact_block_not_observed" and source["contribution_bytes"] is None
        assert source["spans"] == []
    assert metadata["source_inclusions"][3]["outcome"] == "empty"
    assert metadata["source_inclusions"][3]["contribution_bytes"] == 0
    assert metadata["injected_bytes"] == {"input": 0, "system": 0, "total": 0}


async def test_empty_required_source_is_not_a_successful_zero_length_match(dispatch_case):
    d = dispatch_case
    _, execution, _ = await d.bound()
    await d.store(lambda p: p["stages"][0]["llm"].update(context_sources=[{
        "kind": "card_notes", "as": ALIAS, "required": True, "filter": {"kind": "review_verdict", "limit": 3},
    }]))
    response = await d.snapshot(execution)
    assert response.status_code == 422, response.text
    assert "required_context_missing" in finding_codes(response)


async def test_legacy_a1_receipt_remains_prepared_and_has_no_invented_dispatch_evidence(dispatch_case):
    d = dispatch_case
    assignment = await d.case.assignment()
    execution = await d.case.start(assignment)
    response = await d.case.prepare(execution, assignment)
    assert response.status_code == 201, response.text
    receipt = response.json()
    assert receipt["status"] == "prepared" and receipt["use_verification"] == "not_verified"
    assert receipt.get("dispatch") is None
    rows = await history(d, execution)
    assert rows[0].get("dispatch_summary") is None


async def test_exact_execution_scope_is_not_replaced_by_caller_or_typo_fallback(dispatch_case):
    d = dispatch_case
    execution, _, payload = await setup_call(d)
    unknown = await d.prepare({"id": str(uuid.uuid4())}, payload)
    assert unknown.status_code == 404, unknown.text
    # Exact per tier: a stranger answered 403 here would enumerate agent ids.
    for actor, status in [("other_agent", 403), ("curator", 404), ("outsider", 403)]:
        response = await d.prepare(execution, payload, actor=actor)
        assert response.status_code == status, (actor, response.text)
        assert "receipt_id" not in response.json()
        if actor == "other_agent":
            assert "agent_identity_mismatch" in finding_codes(response)
        if actor == "curator":
            assert response.json() == unknown.json()
    path = (f"/api/workspaces/{d.case.foreign_workspace['slug']}/executions/{execution['id']}"
            "/dispatch-preparations")
    foreign = await d.case.http.post(path, json=payload, headers=d.headers("recipient"))
    assert foreign.status_code == 404, foreign.text
    assert await history(d, execution) == []


SECRET_CARD_TITLE = "Confidential handoff card 47"


async def snapshot_as(d, execution_path, actor):
    return await d.case.http.get(execution_path + "/dispatch-context", headers=d.headers(actor),
                                 params={"invocation_kind": "stage", "prompt_slot": "main"})


async def visible_snapshot(d):
    async with d.case.factory() as db:
        await db.execute(update(Card).where(Card.id == uuid.UUID(d.case.card_id)).values(title=SECRET_CARD_TITLE))
        await db.commit()
    execution, snapshot, _ = await setup_call(d)
    secrets = [snapshot["context"][ALIAS], snapshot["dispatch"]["input_template"], snapshot["card"]["title"]]
    assert snapshot["card"]["title"] == SECRET_CARD_TITLE
    assert snapshot["dispatch"]["input_template"].startswith("Current template")
    return execution, secrets


def returned_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from returned_strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from returned_strings(item)


def assert_returns_no_secret(response, secrets):
    # Decoded, not response.text: JSON escapes newlines and may escape
    # non-ASCII, so a raw substring check misses a leaked multiline block.
    for text in returned_strings(response.json()):
        for secret in secrets:
            assert secret not in text, f"{secret!r} returned inside {text!r}"


def test_secret_check_reads_decoded_strings_not_escaped_wire_text():
    secret = "Selected block 🧪\nsecond line"
    leaked = Response(403, json={"detail": {"message": "denied: " + secret + " (end)"}})
    assert secret not in leaked.text  # the prior raw-text check passed this leak
    with pytest.raises(AssertionError):
        assert_returns_no_secret(leaked, [secret])
    clean = Response(403, json={"detail": {"message": "denied"}})
    assert_returns_no_secret(clean, [secret])


@pytest.mark.parametrize("tier, status, code", [
    ("curator", 404, None),
    ("other_agent", 403, "agent_identity_mismatch"),
    ("outsider", 403, None),
    ("owner_after_deactivation", 403, "agent_inactive"),
    ("owner_after_scope_removal", 403, None),
])
async def test_dispatch_context_is_refused_to_every_caller_but_the_bound_agent_or_its_owner(
        dispatch_case, tier, status, code):
    d = dispatch_case
    execution, secrets = await visible_snapshot(d)
    path = d.case.execution_path(execution["id"])
    owner_view = await snapshot_as(d, path, "recipient")
    assert owner_view.status_code == 200, owner_view.text
    actor = tier
    if tier.startswith("owner_after_"):
        actor = "recipient"
        changes = {"is_active": False} if tier == "owner_after_deactivation" else {"allowed_workspaces": ["elsewhere"]}
        async with d.case.factory() as db:
            await db.execute(update(Agent).where(Agent.id == uuid.UUID(d.case.agent_id)).values(**changes))
            await db.commit()
    denied = await snapshot_as(d, path, actor)
    assert denied.status_code == status, denied.text
    if code is not None:
        assert code in finding_codes(denied)
    if tier == "curator":
        unknown = await snapshot_as(d, d.case.execution_path(str(uuid.uuid4())), "recipient")
        assert unknown.status_code == 404 and denied.json() == unknown.json()
    assert_returns_no_secret(denied, secrets)


async def test_dispatch_context_through_foreign_workspace_is_indistinguishable_from_unknown(dispatch_case):
    d = dispatch_case
    execution, secrets = await visible_snapshot(d)
    own = d.case.execution_path(execution["id"])
    # Recipient belongs to both workspaces, so the 404 is tenancy, not membership.
    foreign = await snapshot_as(d, own.replace(f"/{d.case.workspace['slug']}/", "/foreign/"), "recipient")
    unknown_in_foreign = await snapshot_as(d, f"/api/workspaces/foreign/executions/{uuid.uuid4()}", "recipient")
    unknown_in_own = await snapshot_as(d, d.case.execution_path(str(uuid.uuid4())), "recipient")
    for response in [foreign, unknown_in_foreign, unknown_in_own]:
        assert response.status_code == 404, response.text
        assert response.json() == foreign.json()
    assert_returns_no_secret(foreign, secrets)


async def test_note_edit_refuses_old_key_then_fresh_snapshot_prepares_under_new_revision(dispatch_case):
    d = dispatch_case
    execution, snapshot, payload = await setup_call(d)
    first = await d.prepare(execution, payload)
    assert first.status_code == 201, first.text
    first_receipt = (await d.case.receipt(execution, first.json()["receipt_id"])).json()
    edited = json.dumps(document("Edited handoff 🧪 after the first preparation"))
    async with d.case.factory() as db:
        await db.execute(update(Note).where(Note.id == uuid.UUID(d.case.notes[0]["id"])).values(content=edited))
        await db.commit()
    # The lost-ack retry under the old key meets the edit before any replay.
    stale = await d.prepare(execution, payload)
    assert stale.status_code == 409, stale.text
    assert "execution_context_changed" in finding_codes(stale) and "receipt_id" not in stale.json()
    fresh = await d.current(execution)
    assert fresh["context_revision"] != snapshot["context_revision"]
    assert "Edited handoff" in fresh["context"][ALIAS]
    record = next(r for r in fresh["context_manifest"]["sources"][0]["records"]
                  if r["note_id"] == d.case.notes[0]["id"])
    old_record = next(r for r in snapshot["context_manifest"]["sources"][0]["records"]
                      if r["note_id"] == d.case.notes[0]["id"])
    assert record["revision_sha256"] == note_revision({**d.case.notes[0], "kind": record["kind"], "content": edited})
    assert record["revision_sha256"] != old_record["revision_sha256"]
    retry = d.payload(fresh)
    assert retry["client_request_id"] != payload["client_request_id"]
    second = await d.prepare(execution, retry)
    assert second.status_code == 201, second.text
    ack = second.json()
    assert ack["ordinal"] == 2 and ack["receipt_id"] != first.json()["receipt_id"]
    assert ack["context_revision"] == fresh["context_revision"]
    second_receipt = (await d.case.receipt(execution, ack["receipt_id"])).json()
    assert second_receipt["context_manifest"] == fresh["context_manifest"]
    assert second_receipt["input_prompt"] == retry["input_prompt"]
    assert (await d.case.receipt(execution, first.json()["receipt_id"])).json() == first_receipt
    assert first_receipt["context_manifest"] == snapshot["context_manifest"]
    rows = await history(d, execution)
    assert sorted(row["id"] for row in rows) == sorted([first_receipt["id"], second_receipt["id"]])


@pytest.mark.parametrize("field", ["input_prompt", "system_prompt", "adapter", "resume", "unknown", "forged_manifest"])
async def test_strict_payload_and_semantic_idempotency_preserve_one_receipt(dispatch_case, field):
    d = dispatch_case
    execution, snapshot, payload = await setup_call(d)
    response = await d.prepare(execution, payload)
    assert response.status_code == 201, response.text
    receipt_id = response.json()["receipt_id"]
    replay = await d.prepare(execution, dict(payload))
    assert replay.status_code == 200 and replay.json()["receipt_id"] == receipt_id
    changed = dict(payload)
    if field == "resume":
        changed.update(resume_session_id="existing-provider-session-47", channel_contract={
            **payload["channel_contract"], "resume": True,
        })
    elif field == "unknown":
        changed["ignore_required_context"] = True
    elif field == "forged_manifest":
        changed["context_manifest"] = {"sources": []}
    else:
        changed[field] += " changed"
        if field == "system_prompt":
            changed["channel_contract"] = {**payload["channel_contract"], "system": "verbatim"}
    denied = await d.prepare(execution, changed)
    assert denied.status_code == (422 if field in {"unknown", "forged_manifest"} else 409), denied.text
    assert len(await history(d, execution)) == 1
    # An intentional identical call with a different key is another invocation.
    new = await d.prepare(execution, {**payload, "client_request_id": str(uuid.uuid4())})
    assert new.status_code == 201 and new.json()["ordinal"] == 2
    assert new.json()["receipt_id"] != receipt_id
    saved = (await d.case.receipt(execution, receipt_id)).json()
    assert saved["input_prompt"] == payload["input_prompt"] and saved["context_manifest"] == snapshot["context_manifest"]


@pytest.mark.parametrize("revocation", ["inactive", "scope", "membership", "terminal", "note", "template"])
async def test_exact_retry_rechecks_authority_and_freshness_before_returning_saved_ack(dispatch_case, revocation):
    d = dispatch_case
    execution, _, payload = await setup_call(d)
    response = await d.prepare(execution, payload)
    assert response.status_code == 201, response.text
    async with d.case.factory() as db:
        if revocation == "inactive":
            stmt = update(Agent).where(Agent.id == uuid.UUID(d.case.agent_id)).values(is_active=False)
        elif revocation == "scope":
            stmt = update(Agent).where(Agent.id == uuid.UUID(d.case.agent_id)).values(allowed_workspaces=["elsewhere"])
        elif revocation == "membership":
            stmt = delete(WorkspaceMember).where(WorkspaceMember.workspace_id == uuid.UUID(d.case.workspace["id"]),
                                               WorkspaceMember.user_id == uuid.UUID(d.case.recipient_id))
        elif revocation == "terminal":
            stmt = update(AgentExecution).where(AgentExecution.id == uuid.UUID(execution["id"])).values(status="completed")
        elif revocation == "note":
            stmt = update(Note).where(Note.id == uuid.UUID(d.case.notes[0]["id"])).values(content=json.dumps(document("new 🧪")))
        else:
            from app.models.agents.prompt_config import AgentPromptConfig
            stmt = update(AgentPromptConfig).where(AgentPromptConfig.id == d.template_id).values(content="new template")
        await db.execute(stmt)
        await db.commit()
    denied = await d.prepare(execution, payload, actor="recipient")
    assert denied.status_code == (403 if revocation in {"inactive", "scope", "membership"} else 409), denied.text
    assert "receipt_id" not in denied.json()


@pytest.mark.parametrize("control", ["pause", "freeze"])
async def test_pause_and_freeze_do_not_cancel_bound_preparation(dispatch_case, control):
    d = dispatch_case
    execution, _, payload = await setup_call(d)
    async with d.case.factory() as db:
        stmt = (update(Agent).where(Agent.id == uuid.UUID(d.case.agent_id)).values(is_paused=True)) if control == "pause" else (
            update(Board).where(Board.id == uuid.UUID(d.case.board_id)).values(is_frozen=True))
        await db.execute(stmt)
        await db.commit()
    response = await d.prepare(execution, payload)
    assert response.status_code == 201, response.text


async def test_failed_outer_commit_never_returns_prepared_ack_or_publishes_event(dispatch_case):
    d = dispatch_case
    execution, _, payload = await setup_call(d)
    published = []

    async def receive(event):
        published.append(event)

    unsubscribe = event_bus.subscribe(receive, workspace_id=uuid.UUID(d.case.workspace["id"]),
                                      event_pattern="execution.context_receipt_created")
    app = create_app()

    async def failed_commit():
        async with d.case.factory() as db:
            try:
                yield db
                # Function-scope dependency teardown represents a failed outer
                # commit. The service must not pre-commit behind this owner.
                assert db.in_transaction()
                raise RuntimeError("injected outer commit failure")
            finally:
                await db.rollback()

    app.dependency_overrides[get_db] = failed_commit
    try:
        async with AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test") as http:
            response = await http.post(d.case.execution_path(execution["id"]) + "/dispatch-preparations",
                                       json=payload, headers=d.headers())
        assert response.status_code == 500, response.text
        assert '"acknowledged"' not in response.text
        await asyncio.sleep(0.01)
        assert published == [] and await history(d, execution) == []
        retry = await d.prepare(execution, payload)
        assert retry.status_code == 201, retry.text
        await asyncio.sleep(0.01)
        assert len(published) == 1
        assert published[0].payload == {
            "execution_id": execution["id"], "workspace_id": d.case.workspace["id"],
            "receipt_id": retry.json()["receipt_id"], "ordinal": 1,
        }
        replay = await d.prepare(execution, payload)
        assert replay.status_code == 200
        await asyncio.sleep(0.01)
        assert len(published) == 1
    finally:
        unsubscribe()


@pytest.mark.parametrize("mutation", ["protocol", "input", "system", "resume", "provider", "model"])
async def test_preparation_rejects_inconsistent_channel_or_pinned_dispatch_declaration(dispatch_case, mutation):
    d = dispatch_case
    execution, _, payload = await setup_call(d)
    if mutation == "protocol":
        payload["protocol_version"] = 2
    elif mutation == "input":
        payload["channel_contract"] = {**payload["channel_contract"], "input": "best_effort"}
    elif mutation == "system":
        payload["system_prompt"] = "Nonempty text must not claim an empty channel."
    elif mutation == "resume":
        payload["resume_session_id"] = "existing-session-but-channel-declares-fresh"
    else:
        payload[mutation] = "different-configured-intent"
    response = await d.prepare(execution, payload)
    assert response.status_code == 422, response.text
    assert await history(d, execution) == []
