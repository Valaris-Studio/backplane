# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""A1 contract: authorized selected context and retained invocation snapshots.

These tests do not attest provider dispatch or exact source injection; those
remain A2. All requests use real authentication, routers and fresh DB sessions.
"""

import json
import re
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import delete, func, select, update

from app.models.agents.agent import Agent
from app.models.agents.execution import AgentExecution
from app.models.agents.reservation import AgentReservation
from app.models.kanban.board import Board
from app.models.notes.note import Note
from app.models.workspace import WorkspaceMember
from app.models.workspace_config import WorkspaceConfig
from tests.routers.agents.context_receipts_support import (
    ALIAS,
    KIND,
    ROLE,
    STAMP,
    document,
    note_revision,
    _receipt_case_fixture,  # noqa: F401
    sha256,
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]


def expected_record(note, *, show_kind):
    kind = f"[{note['kind']}] " if show_kind else ""
    return f"- **{kind}{note['title']}**:\n\n  {note['text']}"


async def mutate_note(case, field):
    values = {
        "title": {"title": "Revised handoff"},
        "content": {"content": json.dumps(document("Different accepted behavior 🧪"))},
        "kind": {"kind": "new_operator_kind"},
        "pinned": {"pinned": True},
        "timestamp_only": {"updated_at": STAMP + timedelta(days=1)},
    }
    async with case.factory() as db:
        if field == "deleted":
            await db.execute(delete(Note).where(Note.id == uuid.UUID(case.notes[0]["id"])))
        else:
            changes = values[field]
            if field != "timestamp_only":
                changes = {**changes, "updated_at": STAMP}
            await db.execute(update(Note).where(Note.id == uuid.UUID(case.notes[0]["id"])).values(**changes))
        await db.commit()


async def mutate_source_config(case, field):
    async with case.factory() as db:
        config = await db.scalar(select(WorkspaceConfig).where(
            WorkspaceConfig.workspace_id == uuid.UUID(case.workspace["id"]),
        ))
        pipeline = json.loads(json.dumps(config.pipeline_config))
        sources = pipeline["stages"][0]["llm"]["context_sources"]
        if field == "alias":
            sources[0]["as"] = "RenamedHandoff47"
        elif field == "filter":
            sources[0]["filter"]["limit"] = 4
        else:
            sources.reverse()
        config.pipeline_config = pipeline
        await db.commit()


async def prepared(case):
    assignment = await case.assignment()
    execution = await case.start(assignment)
    payload = case.receipt_payload(assignment)
    response = await case.http.post(
        case.execution_path(execution["id"]) + "/context-receipts",
        json=payload, headers=case.headers["agent"],
    )
    assert response.status_code == 201, response.text
    return assignment, execution, payload, response.json()


async def test_assignment_preserves_ordered_alias_occurrences_and_exact_record_metadata(receipt_case):
    case = receipt_case
    assignment = await case.assignment()
    expected_sources = [
        (ALIAS, [case.notes[1], case.notes[2], case.notes[0]], {"limit": 3}),
        ("KindOnly", case.notes[:2], {"kind": KIND, "limit": 3}),
        ("RepeatedAlias47", case.notes[:2], {"kind": KIND, "limit": 3}),
    ]
    for alias, notes, _ in expected_sources:
        assert assignment["context"][alias] == "\n\n".join(
            expected_record(note, show_kind=alias == ALIAS) for note in notes
        )
    manifest = assignment.get("context_manifest")
    assert manifest is not None, "Assignment must identify the exact selected note snapshot"
    assert manifest["schema_version"] == 1
    assert manifest["renderer_version"] == "context-v1"
    assert re.fullmatch(r"[0-9a-f]{64}", assignment["context_revision"])
    assert len(manifest["sources"]) == len(expected_sources)
    for ordinal, (actual, expected) in enumerate(zip(manifest["sources"], expected_sources)):
        alias, notes, filter_ = expected
        blocks = [expected_record(note, show_kind=alias == ALIAS) for note in notes]
        rendered = "\n\n".join(blocks)
        assert actual["source_index"] == ordinal
        assert actual["kind"] == "card_notes" and actual["alias"] == alias
        assert actual["coverage"] == "record_traced"
        assert actual["filter"] == filter_
        assert assignment["context"][alias] == rendered
        assert actual["rendered_sha256"] == sha256(rendered)
        assert actual["rendered_bytes"] == len(rendered.encode("utf-8"))
        assert len(actual["records"]) == len(notes)
        for index, (record, note, block) in enumerate(zip(actual["records"], notes, blocks)):
            assert record["record_index"] == index and record["note_id"] == note["id"]
            assert record["title"] == note["title"] and record["kind"] == note["kind"]
            assert record["workspace_id"] == case.workspace["id"]
            assert record["board_id"] == case.board_id and record["card_id"] == case.card_id
            assert record["revision_sha256"] == note_revision(note)
            assert record["rendered_sha256"] == sha256(block)
            assert record["rendered_bytes"] == len(block.encode("utf-8"))
            assert record["updated_at"] == note["updated_at"]
    assert "PRIVATE_OTHER_CARD" not in json.dumps(assignment)
    repeated = await case.assignment()
    assert repeated["context_manifest"] == manifest
    assert repeated["context_revision"] == assignment["context_revision"]


@pytest.mark.parametrize("field", ["title", "content", "kind", "pinned"])
async def test_note_revision_covers_rendering_and_selection_even_at_same_timestamp(receipt_case, field):
    case = receipt_case
    before = await case.assignment()
    assert "context_manifest" in before, "Need a content revision independent of updated_at"
    await mutate_note(case, field)
    after = await case.assignment()

    def record(value):
        return next(r for r in value["context_manifest"]["sources"][0]["records"]
                    if r["note_id"] == case.notes[0]["id"])

    assert record(before)["updated_at"] == record(after)["updated_at"]
    assert record(before)["revision_sha256"] != record(after)["revision_sha256"]
    assert before["context_revision"] != after["context_revision"]


async def test_timestamp_alone_is_not_a_content_revision(receipt_case):
    case = receipt_case
    before = await case.assignment()
    assert "context_manifest" in before
    await mutate_note(case, "timestamp_only")
    after = await case.assignment()
    old = {r["note_id"]: r for r in before["context_manifest"]["sources"][0]["records"]}
    new = {r["note_id"]: r for r in after["context_manifest"]["sources"][0]["records"]}
    note_id = case.notes[0]["id"]
    assert old[note_id]["updated_at"] != new[note_id]["updated_at"]
    assert old[note_id]["revision_sha256"] == new[note_id]["revision_sha256"]
    assert before["context_revision"] == after["context_revision"]
    execution = await case.start(before)
    response = await case.prepare(execution, before)
    assert response.status_code == 201, response.text


async def test_existing_non_note_source_reports_source_only_coverage(receipt_case):
    case = receipt_case
    async with case.factory() as db:
        config = await db.scalar(select(WorkspaceConfig).where(
            WorkspaceConfig.workspace_id == uuid.UUID(case.workspace["id"]),
        ))
        pipeline = json.loads(json.dumps(config.pipeline_config))
        pipeline["stages"][0]["llm"]["context_sources"].append({
            "kind": "pipeline_expectations", "as": "OperatorStage47",
            "filter": {"scope": "current_role"},
        })
        config.pipeline_config = pipeline
        await db.commit()
    assignment = await case.assignment()
    rendered = "THIS STAGE — role: continuity_keeper_47 (stage: continue_project)\nOutput: produces_note"
    assert assignment["context"]["OperatorStage47"] == rendered
    manifest = assignment.get("context_manifest")
    assert manifest is not None, "Existing non-note context must not disappear from provenance"
    assert len(manifest["sources"]) == 4
    source = manifest["sources"][3]
    assert source["source_index"] == 3
    assert source["kind"] == "pipeline_expectations" and source["alias"] == "OperatorStage47"
    assert source["filter"] == {"scope": "current_role"}
    assert source["coverage"] == "source_only" and source["records"] == []
    assert source["rendered_sha256"] == sha256(rendered)
    assert source["rendered_bytes"] == len(rendered.encode("utf-8"))


@pytest.mark.parametrize(("stored", "rendered"), [
    ("  Legacy booking rule 🧪  ", "Legacy booking rule 🧪"),
    ("<p>Legacy <strong>booking</strong> rule 🧪</p>", "Legacy booking rule 🧪"),
    ('{"type":"doc",broken', '{"type":"doc",broken'),
    ('{"unrelated":"legacy value"}', '{"unrelated":"legacy value"}'),
])
async def test_legacy_content_keeps_existing_rendering_and_exact_stored_revision(receipt_case, stored, rendered):
    case = receipt_case
    async with case.factory() as db:
        await db.execute(update(Note).where(Note.id == uuid.UUID(case.notes[0]["id"])).values(content=stored))
        await db.commit()
    before = await case.assignment()
    changed_note = {**case.notes[0], "content": stored, "text": rendered}
    block = expected_record(changed_note, show_kind=True)
    assert before["context"][ALIAS].endswith(block)
    assert "context_manifest" in before, "Legacy stored bodies need deterministic provenance too"
    record = next(r for r in before["context_manifest"]["sources"][0]["records"]
                  if r["note_id"] == changed_note["id"])
    assert record["revision_sha256"] == note_revision(changed_note)
    async with case.factory() as db:
        await db.execute(update(Note).where(Note.id == uuid.UUID(changed_note["id"])).values(content=stored + " "))
        await db.commit()
    after = await case.assignment()
    assert after["context"][ALIAS] == before["context"][ALIAS]
    assert after["context_revision"] != before["context_revision"]
    changed_record = next(r for r in after["context_manifest"]["sources"][0]["records"]
                          if r["note_id"] == changed_note["id"])
    assert changed_record["revision_sha256"] == note_revision({**changed_note, "content": stored + " "})
    assert changed_record["revision_sha256"] != record["revision_sha256"]


async def test_valid_document_json_layout_is_not_a_content_revision(receipt_case):
    case = receipt_case
    before = await case.assignment()
    assert "context_manifest" in before
    async with case.factory() as db:
        equivalent = json.dumps(json.loads(case.notes[0]["content"]), indent=2, sort_keys=True, ensure_ascii=True)
        await db.execute(update(Note).where(Note.id == uuid.UUID(case.notes[0]["id"])).values(
            content=equivalent, updated_at=STAMP,
        ))
        await db.commit()
    after = await case.assignment()
    assert before["context"] == after["context"]
    assert before["context_revision"] == after["context_revision"]
    assert before["context_manifest"] == after["context_manifest"]


async def test_start_promotes_exact_hold_once_with_idempotent_authorized_replay(receipt_case):
    case = receipt_case
    assignment = await case.assignment()
    execution = await case.start(assignment)
    binding = execution.get("context_binding")
    assert binding is not None, "Execution start must retain its authorized assignment identity"
    for key, value in {
        "reservation_id": assignment["reservation"]["id"], "agent_id": case.agent_id,
        "workspace_id": case.workspace["id"], "board_id": case.board_id,
        "card_id": case.card_id, "role": ROLE,
    }.items():
        assert binding[key] == value
    replay = await case.http.post(f"/api/agents/{case.agent_id}/executions",
                                  json=case.start_payload(assignment), headers=case.headers["agent"])
    assert replay.status_code == 200, replay.text
    assert replay.json()["id"] == execution["id"]
    assert replay.json()["context_binding"] == binding
    async with case.factory() as db:
        assert await db.scalar(select(func.count()).select_from(AgentExecution)) == 1


@pytest.mark.parametrize("invalid", ["expired", "unknown", "wrong_card", "wrong_role", "wrong_agent"])
async def test_start_cannot_promote_an_invalid_hold_and_leaves_no_execution(receipt_case, invalid):
    case = receipt_case
    assignment = await case.assignment()
    changes = {}
    if invalid == "expired":
        async with case.factory() as db:
            await db.execute(update(AgentReservation).values(expires_at=STAMP))
            await db.commit()
    elif invalid == "unknown":
        changes["reservation_id"] = str(uuid.uuid4())
    elif invalid == "wrong_card":
        changes["card_id"] = case.other_card_id
    elif invalid == "wrong_role":
        changes["role"] = "another_arbitrary_role"
    else:
        async with case.factory() as db:
            await db.execute(update(AgentReservation).values(agent_id=uuid.UUID(case.other_agent_id)))
            await db.commit()
    response = await case.http.post(f"/api/agents/{case.agent_id}/executions",
                                    json=case.start_payload(assignment, **changes),
                                    headers=case.headers["agent"])
    assert response.status_code == (409 if invalid == "expired" else 404), response.text
    async with case.factory() as db:
        assert await db.scalar(select(func.count()).select_from(AgentExecution)) == 0


async def test_conflicting_start_reuse_cannot_create_another_bound_execution(receipt_case):
    case = receipt_case
    assignment = await case.assignment()
    await case.start(assignment)
    response = await case.http.post(f"/api/agents/{case.agent_id}/executions",
                                    json=case.start_payload(assignment, input_summary="Changed request"),
                                    headers=case.headers["agent"])
    assert response.status_code == 409, response.text
    async with case.factory() as db:
        assert await db.scalar(select(func.count()).select_from(AgentExecution)) == 1


@pytest.mark.parametrize("hold_state", ["expired", "deleted"])
async def test_active_binding_survives_hold_expiry_and_claim_changed_discover_state(receipt_case, hold_state):
    case = receipt_case
    assignment = await case.assignment()
    claimed = await case.http.post(
        f"/api/workspaces/{case.workspace['slug']}/boards/{case.board_id}/cards/{case.card_id}/claim",
        json={"agent_id": case.agent_id}, headers=case.headers["agent"],
    )
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["column_id"] != assignment["card"]["column_id"]
    execution = await case.start(assignment)
    async with case.factory() as db:
        if hold_state == "expired":
            await db.execute(update(AgentReservation).values(expires_at=STAMP))
        else:
            await db.execute(delete(AgentReservation))
        await db.commit()
    replay = await case.http.post(f"/api/agents/{case.agent_id}/executions",
                                  json=case.start_payload(assignment), headers=case.headers["agent"])
    assert replay.status_code == 200 and replay.json()["id"] == execution["id"], replay.text
    response = await case.prepare(execution, assignment)
    assert response.status_code == 201, response.text
    refresh = await case.http.get(case.execution_path(execution["id"]) + "/context",
                                 headers=case.headers["agent"])
    assert refresh.status_code == 200, refresh.text
    assert refresh.json()["context"] == assignment["context"]


async def test_receipt_retains_exact_bytes_and_server_manifest_without_claiming_execution(receipt_case):
    case = receipt_case
    assignment, execution, payload, receipt = await prepared(case)
    loaded = await case.receipt(execution, receipt["id"])
    assert loaded.status_code == 200, loaded.text
    snapshot = loaded.json()
    assert snapshot["execution_id"] == execution["id"]
    assert snapshot["status"] == "prepared"
    assert snapshot["use_verification"] == "not_verified"
    assert snapshot["ordinal"] == 1
    for field in ("input_prompt", "system_prompt", "provider", "model", "context_revision"):
        assert snapshot[field] == payload[field]
    assert snapshot["prompt_sha256"] == sha256(payload["input_prompt"])
    assert snapshot["prompt_bytes"] == len(payload["input_prompt"].encode("utf-8"))
    assert snapshot["system_prompt_sha256"] == sha256(payload["system_prompt"])
    assert snapshot["system_prompt_bytes"] == len(payload["system_prompt"].encode("utf-8"))
    assert snapshot["context_manifest"] == assignment["context_manifest"]


@pytest.mark.parametrize("change", ["rename_and_kind", "deleted"])
async def test_receipt_keeps_historical_note_title_and_kind_after_source_changes(receipt_case, change):
    case = receipt_case
    _, execution, _, receipt = await prepared(case)
    original = (await case.receipt(execution, receipt["id"])).json()
    record = next(r for r in original["context_manifest"]["sources"][0]["records"]
                  if r["note_id"] == case.notes[0]["id"])
    assert record["title"] == case.notes[0]["title"] and record["kind"] == KIND
    if change == "rename_and_kind":
        await mutate_note(case, "title")
        await mutate_note(case, "kind")
    else:
        await mutate_note(case, "deleted")
    history = await case.receipt(execution, receipt["id"])
    assert history.status_code == 200 and history.json() == original


async def test_receipt_timestamp_is_server_utc_and_identical_in_summary_detail_and_replay(receipt_case):
    case = receipt_case
    assignment = await case.assignment()
    execution = await case.start(assignment)
    path = case.execution_path(execution["id"]) + "/context-receipts"
    payload = case.receipt_payload(assignment)
    payload["created_at"] = "1999-01-01T00:00:00+00:00"
    # SQLite CURRENT_TIMESTAMP has second precision; measure the real request
    # interval at that precision instead of requiring invented microseconds.
    earliest = datetime.now(timezone.utc).replace(microsecond=0)
    created = await case.http.post(path, json=payload, headers=case.headers["agent"])
    latest = datetime.now(timezone.utc) + timedelta(seconds=1)
    assert created.status_code == 201, created.text
    receipt = created.json()
    recorded = datetime.fromisoformat(receipt["created_at"].replace("Z", "+00:00"))
    assert recorded.utcoffset() == timedelta(0)
    assert earliest <= recorded <= latest
    assert receipt["created_at"] != payload["created_at"]
    replay = await case.http.post(path, json=payload, headers=case.headers["agent"])
    assert replay.status_code == 200 and replay.json()["id"] == receipt["id"]
    assert replay.json()["created_at"] == receipt["created_at"]
    listed = await case.http.get(path, headers=case.headers["recipient"])
    assert listed.status_code == 200 and len(listed.json()) == 1
    assert listed.json()[0]["created_at"] == receipt["created_at"]
    assert listed.json()[0]["ordinal"] == receipt["ordinal"]
    await mutate_note(case, "content")
    historical = await case.receipt(execution, receipt["id"])
    assert historical.status_code == 200 and historical.json()["created_at"] == receipt["created_at"]


@pytest.mark.parametrize("field", ["title", "content", "kind", "pinned", "deleted"])
async def test_stale_selected_notes_refuse_preparation_before_persisting_receipt(receipt_case, field):
    case = receipt_case
    assignment = await case.assignment()
    execution = await case.start(assignment)
    await mutate_note(case, field)
    response = await case.prepare(execution, assignment)
    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "execution_context_changed"
    listed = await case.http.get(case.execution_path(execution["id"]) + "/context-receipts",
                                headers=case.headers["recipient"])
    assert listed.status_code == 200 and listed.json() == []


@pytest.mark.parametrize("field", ["input_prompt", "system_prompt", "provider", "model"])
async def test_exact_receipt_retry_and_conflicting_retry_have_one_immutable_snapshot(receipt_case, field):
    case = receipt_case
    _, execution, payload, receipt = await prepared(case)
    path = case.execution_path(execution["id"]) + "/context-receipts"
    replay = await case.http.post(path, json=payload, headers=case.headers["agent"])
    assert replay.status_code == 200 and replay.json()["id"] == receipt["id"], replay.text
    changed = {**payload, field: payload[field] + " altered"}
    conflict = await case.http.post(path, json=changed, headers=case.headers["agent"])
    assert conflict.status_code == 409, conflict.text
    stored = await case.receipt(execution, receipt["id"])
    assert stored.json()["input_prompt"] == payload["input_prompt"]
    listed = await case.http.get(path, headers=case.headers["recipient"])
    assert listed.headers["X-Total-Count"] == "1" and len(listed.json()) == 1


@pytest.mark.parametrize("drift", ["content", "deleted"])
async def test_exact_receipt_retry_rechecks_note_freshness_but_history_remains_immutable(receipt_case, drift):
    case = receipt_case
    _, execution, payload, receipt = await prepared(case)
    original = (await case.receipt(execution, receipt["id"])).json()
    await mutate_note(case, drift)
    response = await case.http.post(case.execution_path(execution["id"]) + "/context-receipts",
                                    json=payload, headers=case.headers["agent"])
    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "execution_context_changed"
    assert (await case.receipt(execution, receipt["id"])).json() == original
    listed = await case.http.get(case.execution_path(execution["id"]) + "/context-receipts",
                                headers=case.headers["recipient"])
    assert listed.headers["X-Total-Count"] == "1"


@pytest.mark.parametrize("field", ["alias", "filter", "order"])
async def test_config_only_change_invalidates_exact_retry_even_when_note_bodies_match(receipt_case, field):
    case = receipt_case
    assignment, execution, payload, receipt = await prepared(case)
    original = (await case.receipt(execution, receipt["id"])).json()
    await mutate_source_config(case, field)
    response = await case.http.post(case.execution_path(execution["id"]) + "/context-receipts",
                                    json=payload, headers=case.headers["agent"])
    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "execution_context_changed"
    refresh = await case.http.get(case.execution_path(execution["id"]) + "/context",
                                 headers=case.headers["agent"])
    assert refresh.status_code == 200, refresh.text
    context = refresh.json()
    assert sorted(context["context"].values()) == sorted(assignment["context"].values())
    assert context["context_revision"] != assignment["context_revision"]
    new_payload = case.receipt_payload(context, prompt="Explicitly retained A1 prompt")
    second = await case.http.post(case.execution_path(execution["id"]) + "/context-receipts",
                                  json=new_payload, headers=case.headers["agent"])
    assert second.status_code == 201, second.text
    assert second.json()["ordinal"] == 2
    assert (await case.receipt(execution, receipt["id"])).json() == original


async def test_newly_selected_note_invalidates_prior_revision_at_selection_boundary(receipt_case):
    case = receipt_case
    assignment, execution, payload, receipt = await prepared(case)
    new_id = uuid.uuid4()
    async with case.factory() as db:
        original = await db.get(Note, uuid.UUID(case.notes[0]["id"]))
        db.add(Note(id=new_id, workspace_id=original.workspace_id, board_id=original.board_id,
                    card_id=original.card_id, created_by=original.created_by, title="New selected rule",
                    content=json.dumps(document("New approved requirement")), kind=KIND, pinned=True,
                    created_at=STAMP + timedelta(days=1), updated_at=STAMP + timedelta(days=1)))
        await db.commit()
    denied = await case.http.post(case.execution_path(execution["id"]) + "/context-receipts",
                                  json=payload, headers=case.headers["agent"])
    assert denied.status_code == 409 and denied.json()["error_code"] == "execution_context_changed"
    refreshed = await case.http.get(case.execution_path(execution["id"]) + "/context",
                                   headers=case.headers["agent"])
    assert refreshed.status_code == 200, refreshed.text
    current = refreshed.json()
    assert current["context_revision"] != assignment["context_revision"]
    ids = [r["note_id"] for r in current["context_manifest"]["sources"][0]["records"]]
    assert ids == [str(new_id), case.notes[1]["id"], case.notes[2]["id"]]
    assert (await case.receipt(execution, receipt["id"])).json()["context_manifest"] == assignment["context_manifest"]


async def test_two_invocations_keep_history_after_note_edit_and_legacy_prompt_update(receipt_case):
    case = receipt_case
    _, execution, payload, first = await prepared(case)
    original = (await case.receipt(execution, first["id"])).json()
    await mutate_note(case, "content")
    refresh = await case.http.get(case.execution_path(execution["id"]) + "/context",
                                 headers=case.headers["agent"])
    assert refresh.status_code == 200, refresh.text
    second = await case.prepare(execution, refresh.json())
    assert second.status_code == 201, second.text
    second_body = (await case.receipt(execution, second.json()["id"])).json()
    assert second_body["ordinal"] == 2
    assert second_body["context_revision"] != original["context_revision"]
    assert second_body["input_prompt"] != payload["input_prompt"]
    legacy = await case.http.patch(f"/api/agents/{case.agent_id}/executions/{execution['id']}",
                                   json={"input_prompt": "Later legacy telemetry"},
                                   headers=case.headers["agent"])
    assert legacy.status_code == 200, legacy.text
    assert (await case.receipt(execution, first["id"])).json() == original


async def test_receipt_pages_and_execution_detail_never_embed_all_snapshots(receipt_case):
    case = receipt_case
    assignment, execution, _, first = await prepared(case)
    second = await case.prepare(execution, assignment, prompt="Second prompt")
    third = await case.prepare(execution, assignment, prompt="Third prompt")
    assert second.status_code == third.status_code == 201
    path = case.execution_path(execution["id"])
    page = await case.http.get(path + "/context-receipts?limit=1&offset=1",
                              headers=case.headers["recipient"])
    assert page.status_code == 200 and page.headers["X-Total-Count"] == "3"
    assert len(page.json()) == 1 and page.json()[0]["id"] == second.json()["id"]
    for row in page.json():
        assert not {"input_prompt", "system_prompt", "context_manifest"}.intersection(row)
    detail = await case.http.get(path, headers=case.headers["recipient"])
    assert detail.status_code == 200 and detail.json()["context_receipt_count"] == 3
    assert not {"context_receipts", "context_manifest", "system_prompt"}.intersection(detail.json())
    listed = await case.http.get(f"/api/workspaces/{case.workspace['slug']}/executions?summary=true",
                                headers=case.headers["recipient"])
    assert listed.status_code == 200
    for row in listed.json():
        assert not {"input_prompt", "context_receipts", "context_manifest", "system_prompt"}.intersection(row)
    assert (await case.receipt(execution, first["id"])).status_code == 200


@pytest.mark.parametrize("revocation", ["membership", "agent_scope", "agent_inactive"])
async def test_preparation_and_start_replay_recheck_current_authorization(receipt_case, revocation):
    case = receipt_case
    assignment, execution, payload, receipt = await prepared(case)
    async with case.factory() as db:
        if revocation == "membership":
            await db.execute(delete(WorkspaceMember).where(
                WorkspaceMember.workspace_id == uuid.UUID(case.workspace["id"]),
                WorkspaceMember.user_id == uuid.UUID(case.recipient_id),
            ))
        else:
            values = {"allowed_workspaces": ["foreign"]} if revocation == "agent_scope" else {"is_active": False}
            await db.execute(update(Agent).where(Agent.id == uuid.UUID(case.agent_id)).values(**values))
        await db.commit()
    replay = await case.http.post(case.execution_path(execution["id"]) + "/context-receipts",
                                  json=payload, headers=case.headers["agent"])
    assert replay.status_code == 403, replay.text
    refreshed = await case.http.get(case.execution_path(execution["id"]) + "/context",
                                   headers=case.headers["agent"])
    assert refreshed.status_code == 403 and ALIAS not in refreshed.text
    start = await case.http.post(f"/api/agents/{case.agent_id}/executions",
                                 json=case.start_payload(assignment), headers=case.headers["agent"])
    assert start.status_code == 403, start.text
    assert ALIAS not in replay.text and ALIAS not in start.text
    if revocation == "membership":
        history = await case.receipt(execution, receipt["id"])
        assert history.status_code == 403 and ALIAS not in history.text


async def test_wrong_agent_unknown_execution_and_cross_workspace_are_not_redirected(receipt_case):
    case = receipt_case
    _, execution, payload, receipt = await prepared(case)
    own = case.execution_path(execution["id"])
    wrong_agent = await case.http.post(own + "/context-receipts", json=payload,
                                       headers=case.headers["other_agent"])
    assert wrong_agent.status_code == 403, wrong_agent.text
    wrong_refresh = await case.http.get(own + "/context", headers=case.headers["other_agent"])
    assert wrong_refresh.status_code == 403 and ALIAS not in wrong_refresh.text
    unknown = await case.http.post(case.execution_path(str(uuid.uuid4())) + "/context-receipts",
                                   json=payload, headers=case.headers["agent"])
    assert unknown.status_code == 404, unknown.text
    unknown_refresh = await case.http.get(case.execution_path(str(uuid.uuid4())) + "/context",
                                         headers=case.headers["agent"])
    assert unknown_refresh.status_code == 404 and ALIAS not in unknown_refresh.text
    # Recipient belongs to both workspaces: this refusal establishes tenancy,
    # not merely absent membership or the linked agent's scope restriction.
    foreign = own.replace(f"/{case.workspace['slug']}/", "/foreign/")
    denied = await case.http.get(foreign + f"/context-receipts/{receipt['id']}",
                                headers=case.headers["recipient"])
    missing = await case.http.get(foreign + f"/context-receipts/{uuid.uuid4()}",
                                 headers=case.headers["recipient"])
    assert denied.status_code == missing.status_code == 404
    assert denied.json() == missing.json()
    assert ALIAS not in denied.text
    foreign_refresh = await case.http.get(foreign + "/context", headers=case.headers["recipient"])
    assert foreign_refresh.status_code == 404 and ALIAS not in foreign_refresh.text
    remaining = await case.http.get(own + "/context-receipts", headers=case.headers["recipient"])
    assert remaining.headers["X-Total-Count"] == "1"


async def test_other_workspace_member_can_read_history_but_cannot_prepare_for_someone_else(receipt_case):
    case = receipt_case
    _, execution, payload, receipt = await prepared(case)
    assert (await case.receipt(execution, receipt["id"], actor="curator")).status_code == 200
    denied = await case.http.post(case.execution_path(execution["id"]) + "/context-receipts",
                                json=payload, headers=case.headers["curator"])
    assert denied.status_code == 404, denied.text
    assert ALIAS not in denied.text
    refresh = await case.http.get(case.execution_path(execution["id"]) + "/context",
                                 headers=case.headers["curator"])
    assert refresh.status_code == 404 and ALIAS not in refresh.text


async def test_plain_owner_key_cannot_prepare_or_refresh_after_bound_agent_deactivation(receipt_case):
    case = receipt_case
    assignment = await case.assignment()
    execution = await case.start(assignment)
    path = case.execution_path(execution["id"])
    payload = case.receipt_payload(assignment)
    refresh = await case.http.get(path + "/context", headers=case.headers["recipient"])
    assert refresh.status_code == 200, refresh.text
    prepared_by_owner = await case.http.post(path + "/context-receipts", json=payload,
                                             headers=case.headers["recipient"])
    assert prepared_by_owner.status_code == 201, prepared_by_owner.text
    receipt_id = prepared_by_owner.json()["id"]
    original = (await case.receipt(execution, receipt_id)).json()
    async with case.factory() as db:
        await db.execute(update(Agent).where(Agent.id == uuid.UUID(case.agent_id)).values(is_active=False))
        await db.commit()
    # This key has no linked agent. The receipt service must check the bound
    # agent instead of depending on authentication middleware to deny it.
    denied = await case.http.post(path + "/context-receipts", json=payload,
                                 headers=case.headers["recipient"])
    assert denied.status_code == 403 and ALIAS not in denied.text
    denied_refresh = await case.http.get(path + "/context", headers=case.headers["recipient"])
    assert denied_refresh.status_code == 403 and ALIAS not in denied_refresh.text
    start = await case.http.post(f"/api/agents/{case.agent_id}/executions",
                                 json=case.start_payload(assignment), headers=case.headers["recipient"])
    assert start.status_code == 403, start.text
    assert (await case.receipt(execution, receipt_id)).json() == original


async def test_receipt_cannot_be_read_through_another_execution_in_same_workspace(receipt_case):
    case = receipt_case
    assignment, execution, _, receipt = await prepared(case)
    payload = case.start_payload(assignment)
    payload.pop("reservation_id")
    other = await case.http.post(f"/api/agents/{case.agent_id}/executions", json=payload,
                                headers=case.headers["agent"])
    assert other.status_code == 201, other.text
    assert other.json()["id"] != execution["id"]
    path = case.execution_path(other.json()["id"]) + "/context-receipts/"
    mismatch = await case.http.get(path + receipt["id"], headers=case.headers["recipient"])
    unknown = await case.http.get(path + str(uuid.uuid4()), headers=case.headers["recipient"])
    assert mismatch.status_code == unknown.status_code == 404
    assert mismatch.json() == unknown.json() and ALIAS not in mismatch.text
    assert (await case.receipt(execution, receipt["id"])).status_code == 200


async def test_changed_claimed_revision_is_checked_before_exact_key_replay(receipt_case):
    case = receipt_case
    _, execution, payload, receipt = await prepared(case)
    changed = {**payload, "context_revision": "f" * 64}
    assert changed["context_revision"] != payload["context_revision"]
    denied = await case.http.post(case.execution_path(execution["id"]) + "/context-receipts",
                                  json=changed, headers=case.headers["agent"])
    assert denied.status_code == 409, denied.text
    assert denied.json()["error_code"] == "execution_context_changed"
    assert (await case.receipt(execution, receipt["id"])).json()["context_revision"] == payload["context_revision"]


@pytest.mark.parametrize("status", ["completed", "failed", "aborted", "skipped"])
async def test_terminal_execution_cannot_prepare_another_invocation(receipt_case, status):
    case = receipt_case
    assignment = await case.assignment()
    execution = await case.start(assignment)
    closed = await case.http.patch(f"/api/agents/{case.agent_id}/executions/{execution['id']}",
                                  json={"status": status}, headers=case.headers["agent"])
    assert closed.status_code == 200, closed.text
    denied = await case.prepare(execution, assignment)
    assert denied.status_code == 409, denied.text
    assert denied.json()["error_code"] == "execution_not_active"


@pytest.mark.parametrize("status", ["completed", "failed", "aborted", "skipped"])
async def test_terminal_execution_refuses_exact_receipt_replay_but_preserves_history(receipt_case, status):
    case = receipt_case
    _, execution, payload, receipt = await prepared(case)
    original = (await case.receipt(execution, receipt["id"])).json()
    closed = await case.http.patch(f"/api/agents/{case.agent_id}/executions/{execution['id']}",
                                   json={"status": status}, headers=case.headers["agent"])
    assert closed.status_code == 200, closed.text
    replay = await case.http.post(case.execution_path(execution["id"]) + "/context-receipts",
                                  json=payload, headers=case.headers["agent"])
    assert replay.status_code == 409, replay.text
    assert replay.json()["error_code"] == "execution_not_active"
    refresh = await case.http.get(case.execution_path(execution["id"]) + "/context",
                                 headers=case.headers["agent"])
    assert refresh.status_code == 409 and refresh.json()["error_code"] == "execution_not_active"
    assert (await case.receipt(execution, receipt["id"])).json() == original


async def test_legacy_unbound_execution_cannot_infer_preparation_identity_from_cards_affected(receipt_case):
    case = receipt_case
    assignment = await case.assignment()
    payload = case.start_payload(assignment)
    payload.pop("reservation_id")
    response = await case.http.post(f"/api/agents/{case.agent_id}/executions", json=payload,
                                    headers=case.headers["agent"])
    assert response.status_code == 201, response.text
    execution = response.json()
    assert case.card_id in execution["cards_affected"]
    assert execution.get("context_binding") is None
    denied = await case.prepare(execution, assignment)
    assert denied.status_code == 409, denied.text
    assert denied.json()["error_code"] == "execution_context_unbound"
    refresh = await case.http.get(case.execution_path(execution["id"]) + "/context",
                                 headers=case.headers["agent"])
    assert refresh.status_code == 409 and refresh.json()["error_code"] == "execution_context_unbound"
    listed = await case.http.get(case.execution_path(execution["id"]) + "/context-receipts",
                                headers=case.headers["recipient"])
    assert listed.status_code == 200 and listed.json() == []
    assert listed.headers["X-Total-Count"] == "0"


@pytest.mark.parametrize("control", ["agent_paused", "board_frozen"])
async def test_existing_pause_and_freeze_controls_do_not_cancel_bound_execution(receipt_case, control):
    case = receipt_case
    assignment = await case.assignment()
    execution = await case.start(assignment)
    async with case.factory() as db:
        if control == "agent_paused":
            await db.execute(update(Agent).where(Agent.id == uuid.UUID(case.agent_id)).values(is_paused=True))
        else:
            await db.execute(update(Board).where(Board.id == uuid.UUID(case.board_id)).values(is_frozen=True))
        await db.commit()
    refresh = await case.http.get(case.execution_path(execution["id"]) + "/context",
                                 headers=case.headers["agent"])
    assert refresh.status_code == 200, refresh.text
    response = await case.prepare(execution, refresh.json())
    assert response.status_code == 201, response.text


async def test_caller_cannot_replace_server_provenance_with_a_forged_manifest(receipt_case):
    case = receipt_case
    assignment = await case.assignment()
    execution = await case.start(assignment)
    payload = case.receipt_payload(assignment)
    payload["context_manifest"] = {"sources": [{"note_id": str(uuid.uuid4()), "text": "FORGED"}]}
    response = await case.http.post(case.execution_path(execution["id"]) + "/context-receipts",
                                    json=payload, headers=case.headers["agent"])
    # Project models ignore unknown input fields; server-owned provenance still
    # comes from authorized selection rather than copying this extra field.
    assert response.status_code == 201, response.text
    stored = await case.receipt(execution, response.json()["id"])
    assert stored.json()["context_manifest"] == assignment["context_manifest"]
    assert "FORGED" not in stored.text


@pytest.mark.parametrize("control", [None, "agent_paused", "board_frozen"])
async def test_legacy_start_and_prompt_update_keep_existing_behavior(receipt_case, control):
    case = receipt_case
    assignment = await case.assignment()
    async with case.factory() as db:
        if control == "agent_paused":
            await db.execute(update(Agent).where(Agent.id == uuid.UUID(case.agent_id)).values(is_paused=True))
        elif control == "board_frozen":
            await db.execute(update(Board).where(Board.id == uuid.UUID(case.board_id)).values(is_frozen=True))
        await db.commit()
    payload = case.start_payload(assignment)
    payload.pop("reservation_id")
    started = await case.http.post(f"/api/agents/{case.agent_id}/executions", json=payload,
                                  headers=case.headers["agent"])
    assert started.status_code == 201, started.text
    execution = started.json()
    assert execution.get("context_binding") is None
    patched = await case.http.patch(f"/api/agents/{case.agent_id}/executions/{execution['id']}",
                                   json={"input_prompt": "Legacy exact prompt"}, headers=case.headers["agent"])
    assert patched.status_code == 200 and patched.json()["input_prompt"] == "Legacy exact prompt"
    detail = await case.http.get(case.execution_path(execution["id"]), headers=case.headers["recipient"])
    assert detail.status_code == 200 and detail.json()["input_prompt"] == "Legacy exact prompt"
    assert detail.json().get("context_binding") is None
    assert detail.json().get("context_receipt_count", 0) == 0
