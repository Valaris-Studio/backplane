# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Content declarations at ingest: the server's decision order (contract §7),
idempotent acks that a replay re-emits, forward-only admission, quota
reservations, and the guarantee that content never counts as activity."""

import copy
import uuid

import pytest
from sqlalchemy import func, select, update

from app.config import settings
from app.models.agent_session import (
    AgentSessionCapture,
    AgentSessionContent,
    AgentSessionEvent,
    AgentSessionUsage,
)
from app.models.companion import CompanionInstallation, CompanionProjectMapping
from app.models.workspace import WorkspaceMember, WorkspaceRole
from app.schemas.session_content import CHUNK_BYTES, RichIngestResult
from tests.rich_capture import (
    GENERATION,
    ME,
    PNG,
    ROOT,
    acks_by_key,
    content_key,
    declaration,
    enroll_rich,
    ingest,
    installation_bytes,
    only_session,
    rich_record,
    sessions_path,
    wire,
)
from tests.test_agent_sessions import as_user

pytestmark = pytest.mark.usefixtures("content_storage")

MAX_SESSION_BODY_BYTES = 512 << 20


async def rich(client, device_client, db_session, test_workspace, test_board, **kw):
    return await enroll_rich(
        client, device_client, db_session, test_workspace, test_board, **kw
    )


async def contents(db_session) -> list[AgentSessionContent]:
    return list(
        await db_session.scalars(
            select(AgentSessionContent).execution_options(populate_existing=True)
        )
    )


# --- the wire corpus' rich record ------------------------------------------------


async def test_wire_record_is_answered_per_declaration_and_stores_full_events(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    record = wire("ingest-request-rich-record")
    record["mapping_id"] = enrolled["mapping_id"]
    result = await ingest(device_client, enrolled, [record])

    RichIngestResult.model_validate(result)
    assert result["acknowledged"] == [record["capture_id"]]
    acks = acks_by_key(result)
    assert list(acks) == [item["content_key"] for item in record["contents"]]
    prompt, native, reply, output, image, zip_file = record["contents"]
    assert acks[prompt["content_key"]]["outcome"] == "available"
    assert acks[native["content_key"]]["outcome"] == "available"
    # Withheld by the device: nothing to send, so it is settled as available.
    assert acks[zip_file["content_key"]]["outcome"] == "available"
    for uploaded, chunks in [(reply, 1), (output, 8), (image, 1)]:
        ack = acks[uploaded["content_key"]]
        assert ack["outcome"] == "upload_required", ack
        assert ack["upload"]["chunk_bytes"] == CHUNK_BYTES
        assert ack["upload"]["chunk_count"] == chunks
        assert ack["upload"]["received_chunks"] == []

    rows = {row.content_key: row for row in await contents(db_session)}
    assert rows[prompt["content_key"]].state == "available"
    assert rows[prompt["content_key"]].inline_text == prompt["inline_text"]
    assert rows[reply["content_key"]].state == "pending"
    assert rows[reply["content_key"]].inline_text is None
    assert rows[zip_file["content_key"]].coverage == "withheld_by_policy"
    assert rows[zip_file["content_key"]].coverage_reason == "media_type_not_permitted"
    session = await only_session(db_session)
    assert session.content_count == 6
    # Reserved at declaration: inline bodies and every pending upload.
    assert session.content_bytes == sum(
        item.get("byte_count") or 0 for item in record["contents"]
    )
    installation = await db_session.get(
        CompanionInstallation, uuid.UUID(enrolled["installation_id"])
    )
    await db_session.refresh(installation)
    assert installation.content_bytes == session.content_bytes
    # A rich mapping's events are exactly Full events; the level is recorded.
    receipt = await db_session.scalar(select(AgentSessionCapture))
    assert receipt.content_level == "rich"
    assert session.capture_levels == ["rich"]
    [event] = await db_session.scalars(select(AgentSessionEvent))
    assert event.event["prompt"]["text"] == record["events"][0]["prompt"]["text"]


async def test_replay_reemits_the_stored_acks_and_changes_nothing(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    record = rich_record(
        enrolled["mapping_id"],
        [declaration(b"inline body"), declaration(b"x" * 20_000)],
    )
    first = await ingest(device_client, enrolled, [record])
    session = await only_session(db_session)
    counters = (session.content_count, session.content_bytes, session.event_count)

    replay = await ingest(device_client, enrolled, [record])
    assert replay["acknowledged"] == [record["capture_id"]]
    assert replay["contents"] == first["contents"]
    session = await only_session(db_session)
    assert (session.content_count, session.content_bytes, session.event_count) == (
        counters
    )
    assert len(await contents(db_session)) == 2


async def test_a_key_declared_again_in_another_record_gets_its_stored_ack(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    declared = declaration(b"the same item")
    first = await ingest(
        device_client, enrolled, [rich_record(enrolled["mapping_id"], [declared])]
    )
    again = rich_record(enrolled["mapping_id"], [declared], events=[])
    second = await ingest(device_client, enrolled, [again])
    [before], [after] = first["contents"], second["contents"]
    assert after["outcome"] == "available"
    assert after["content_id"] == before["content_id"]
    assert after["capture_id"] == again["capture_id"]
    assert len(await contents(db_session)) == 1


async def test_same_key_with_other_bytes_is_rejected_as_conflict(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    key = content_key("claude_code", "sess-1", "item", "text:0")
    await ingest(
        device_client,
        enrolled,
        [rich_record(enrolled["mapping_id"], [declaration(b"first", key=key)])],
    )
    rewritten = await ingest(
        device_client,
        enrolled,
        [
            rich_record(
                enrolled["mapping_id"], [declaration(b"second", key=key)], events=[]
            )
        ],
    )
    [ack] = rewritten["contents"]
    assert (ack["outcome"], ack["rejection"]) == ("rejected", "conflict")
    [row] = await contents(db_session)
    assert row.inline_text == "first"


async def test_stored_rows_are_never_re_decided_after_a_downgrade(
    client, device_client, db_session, test_workspace, test_board
):
    """R2-6: a key already stored answers its stored ack before the policy
    steps run, so a replay after the mapping left rich still says available."""
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    record = rich_record(enrolled["mapping_id"], [declaration(b"kept body")])
    first = await ingest(device_client, enrolled, [record])
    downgraded = await client.patch(
        f"{ME}/{enrolled['installation_id']}/mappings/{enrolled['mapping_id']}",
        json={"content_level": "standard"},
    )
    assert downgraded.status_code == 200, downgraded.text

    replay = await ingest(device_client, enrolled, [record])
    assert replay["contents"] == first["contents"]
    fresh = await ingest(
        device_client,
        enrolled,
        [rich_record(enrolled["mapping_id"], [declaration(b"after the downgrade")])],
    )
    [ack] = fresh["contents"]
    assert (ack["outcome"], ack["coverage"], ack["coverage_reason"]) == (
        "recorded",
        "withheld_by_policy",
        "content_level",
    )


# --- record admission and deleted history ----------------------------------------


async def test_a_rejected_record_gets_no_content_acks_and_stores_nothing(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    await db_session.execute(
        update(CompanionInstallation)
        .where(CompanionInstallation.id == uuid.UUID(enrolled["installation_id"]))
        .values(paused=True)
    )
    await db_session.flush()
    record = rich_record(enrolled["mapping_id"], [declaration(b"while paused")])
    result = await ingest(device_client, enrolled, [record])
    assert result["rejected"] == [
        {"capture_id": record["capture_id"], "reason": "paused"}
    ]
    assert result["contents"] == []
    assert await contents(db_session) == []


async def test_a_record_whose_contents_break_the_contract_is_rejected_whole(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    record = rich_record(enrolled["mapping_id"], [declaration(b"orphan")])
    del record["capture_generation"]
    result = await ingest(device_client, enrolled, [record])
    assert result["rejected"] == [
        {"capture_id": record["capture_id"], "reason": "invalid"}
    ]
    assert result["contents"] == []
    assert (
        await db_session.scalar(select(func.count()).select_from(AgentSessionEvent))
        == 0
    )


async def test_declarations_of_deleted_history_are_dropped(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    await ingest(
        device_client,
        enrolled,
        [rich_record(enrolled["mapping_id"], [declaration(b"before the deletion")])],
    )
    session = await only_session(db_session)
    deleted = await client.delete(sessions_path(test_workspace, session.id))
    assert deleted.status_code == 204
    # Queued before the deletion: captured and observed inside deleted history.
    late = rich_record(enrolled["mapping_id"], [declaration(b"a stale retry")])
    result = await ingest(device_client, enrolled, [late])
    assert result["dropped"] == [
        {"capture_id": late["capture_id"], "reason": "session_deleted"}
    ]
    [ack] = result["contents"]
    assert ack["outcome"] == "dropped"
    assert await contents(db_session) == []


async def test_rich_capture_off_keeps_events_and_records_contents_withheld(
    client, device_client, db_session, test_workspace, test_board, monkeypatch
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    monkeypatch.setattr(settings, "RICH_CAPTURE_ENABLED", False)
    record = rich_record(
        enrolled["mapping_id"], [declaration(b"inline"), declaration(b"y" * 20_000)]
    )
    result = await ingest(device_client, enrolled, [record])
    assert result["acknowledged"] == [record["capture_id"]]
    for ack in result["contents"]:
        assert (ack["outcome"], ack["coverage"], ack["coverage_reason"]) == (
            "recorded",
            "withheld_by_policy",
            "content_level",
        ), ack
        assert ack["upload"] is None
    assert (
        await db_session.scalar(select(func.count()).select_from(AgentSessionEvent))
        == 1
    )
    assert {row.state for row in await contents(db_session)} == {"recorded"}
    assert (await only_session(db_session)).content_bytes == 0


async def test_a_device_that_did_not_negotiate_rich_capture_gets_contents_recorded(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(
        client, device_client, db_session, test_workspace, test_board, capabilities=None
    )
    result = await ingest(
        device_client,
        enrolled,
        [rich_record(enrolled["mapping_id"], [declaration(b"unoffered")])],
    )
    [ack] = result["contents"]
    assert (ack["outcome"], ack["coverage_reason"]) == ("recorded", "content_level")
    # Delivered and reduced as full, and recorded so.
    receipt = await db_session.scalar(select(AgentSessionCapture))
    assert receipt.content_level == "full"


async def test_a_rich_mapping_never_granted_rich_since_captures_no_bodies(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    await db_session.execute(
        update(CompanionProjectMapping)
        .where(CompanionProjectMapping.id == uuid.UUID(enrolled["mapping_id"]))
        .values(rich_since=None)
    )
    await db_session.flush()
    result = await ingest(
        device_client,
        enrolled,
        [rich_record(enrolled["mapping_id"], [declaration(b"ungranted")])],
    )
    [ack] = result["contents"]
    assert (ack["outcome"], ack["coverage_reason"]) == ("recorded", "content_level")


async def test_an_excluded_display_path_is_recorded_withheld(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    await db_session.execute(
        update(CompanionInstallation)
        .where(CompanionInstallation.id == uuid.UUID(enrolled["installation_id"]))
        .values(exclude_globs=["secrets/*"])
    )
    await db_session.flush()
    excluded = declaration(
        b"API_KEY=x", channel="file_content", display_path="secrets/prod.env"
    )
    kept = declaration(b"print(1)", channel="file_content", display_path="src/main.py")
    result = acks_by_key(
        await ingest(
            device_client,
            enrolled,
            [rich_record(enrolled["mapping_id"], [excluded, kept])],
        )
    )
    assert (
        result[excluded["content_key"]]["outcome"],
        result[excluded["content_key"]]["coverage"],
        result[excluded["content_key"]]["coverage_reason"],
    ) == ("recorded", "withheld_by_policy", "excluded_path")
    assert result[kept["content_key"]]["outcome"] == "available"
    stored = {row.content_key: row for row in await contents(db_session)}
    assert stored[excluded["content_key"]].inline_text is None


# --- generations and forward-only admission -------------------------------------


async def test_content_before_its_generation_is_rejected_and_its_events_are_kept(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    record = wire("ingest-request-content-before-generation")
    record["mapping_id"] = enrolled["mapping_id"]
    record["events"] = wire("ingest-request-rich-record")["events"]
    result = await ingest(device_client, enrolled, [record])
    assert result["acknowledged"] == [record["capture_id"]]
    [ack] = result["contents"]
    assert (ack["outcome"], ack["rejection"]) == ("rejected", "before_admission")
    assert await contents(db_session) == []
    assert (
        await db_session.scalar(select(func.count()).select_from(AgentSessionEvent))
        == 1
    )


async def test_content_long_before_the_mapping_became_rich_is_rejected(
    client, device_client, db_session, test_workspace, test_board
):
    """The server's own bound: one day of clock skew before rich_since, per
    declaration, whatever the device's generation claims."""
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    generation = {**GENERATION, "admitted_from": "2026-10-01T00:00:00Z"}
    imported = declaration(b"old history", occurred_at="2026-10-05T12:00:00Z")
    skewed = declaration(b"clock behind", occurred_at="2026-10-07T20:00:00Z")
    result = acks_by_key(
        await ingest(
            device_client,
            enrolled,
            [
                rich_record(
                    enrolled["mapping_id"],
                    [imported, skewed],
                    capture_generation=generation,
                )
            ],
        )
    )
    assert result[imported["content_key"]]["rejection"] == "before_admission"
    assert result[skewed["content_key"]]["outcome"] == "available"


async def test_a_generation_key_reused_with_other_settings_is_a_mismatch(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    await ingest(
        device_client,
        enrolled,
        [rich_record(enrolled["mapping_id"], [declaration(b"first window")])],
    )
    moved = {**GENERATION, "admitted_from": "2026-10-08T14:01:00Z"}
    other_mapping = (
        await client.post(
            f"{ME}/{enrolled['installation_id']}/mappings",
            json={
                "workspace_id": str(test_workspace.id),
                "root_path": "/synthetic/other",
                "content_level": "rich",
            },
        )
    ).json()
    for record in [
        rich_record(
            enrolled["mapping_id"],
            [declaration(b"moved")],
            events=[],
            capture_generation=moved,
        ),
        rich_record(other_mapping["id"], [declaration(b"another mapping")], events=[]),
        rich_record(
            enrolled["mapping_id"], [declaration(b"pi")], events=[], harness="pi_cli"
        ),
    ]:
        result = await ingest(device_client, enrolled, [record])
        [ack] = result["contents"]
        assert (ack["outcome"], ack["rejection"]) == (
            "rejected",
            "generation_mismatch",
        ), record["mapping_id"]


async def test_the_generation_keeps_its_admission_facts_for_audit(
    client, device_client, db_session, test_workspace, test_board
):
    from app.models.agent_session import AgentSessionCaptureGeneration

    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    await ingest(
        device_client,
        enrolled,
        [rich_record(enrolled["mapping_id"], [declaration(b"audited")])],
    )
    generation = await db_session.scalar(select(AgentSessionCaptureGeneration))
    assert generation.generation_key == GENERATION["id"]
    assert generation.policy_revision == GENERATION["policy_revision"]
    assert str(generation.mapping_id) == enrolled["mapping_id"]
    [row] = await contents(db_session)
    assert row.generation_id == generation.id
    assert row.policy_revision == GENERATION["policy_revision"]
    assert row.filter_version == "asymptoteobserve-redact/1"
    assert row.parser_version == "companion-claude-transcript/1"
    assert row.source_schema_version == "claude-code-jsonl/2"


# --- quota, placement, empty bodies ----------------------------------------------


async def test_session_quota_reserves_then_records_the_overflow_as_withheld(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    # 16 x 32 MiB fill the 512 MiB session budget; the 17th does not fit.
    declared = [
        declaration(
            None,
            delivery="upload",
            byte_count=32 << 20,
            sha256=content_key(str(index)),
            coverage="captured",
        )
        for index in range(17)
    ]
    result = await ingest(
        device_client, enrolled, [rich_record(enrolled["mapping_id"], declared)]
    )
    outcomes = [ack["outcome"] for ack in result["contents"]]
    assert outcomes == ["upload_required"] * 16 + ["recorded"]
    assert result["contents"][-1]["coverage_reason"] == "quota_exceeded"
    session = await only_session(db_session)
    assert session.content_bytes == MAX_SESSION_BODY_BYTES


async def test_installation_quota_spans_the_devices_sessions(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    await db_session.execute(
        update(CompanionInstallation)
        .where(CompanionInstallation.id == uuid.UUID(enrolled["installation_id"]))
        .values(content_bytes=(10 << 30) - 100)
    )
    await db_session.flush()
    result = await ingest(
        device_client,
        enrolled,
        [rich_record(enrolled["mapping_id"], [declaration(b"z" * 200)])],
    )
    [ack] = result["contents"]
    assert (ack["outcome"], ack["coverage_reason"]) == ("recorded", "quota_exceeded")
    assert (await only_session(db_session)).content_bytes == 0


async def test_an_inline_body_that_names_a_local_path_fails_placement(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    unplaced = declaration(f"see {ROOT}/src/a.py".encode())
    escaped = declaration(
        b'{"file": "\\u002fsynthetic\\u002fproject\\u002fa.py"}',
        channel="native_record",
        media_type="application/json",
    )
    placed = declaration(b"see src/a.py and ~/notes.md")
    result = acks_by_key(
        await ingest(
            device_client,
            enrolled,
            [rich_record(enrolled["mapping_id"], [unplaced, escaped, placed])],
        )
    )
    for failed in (unplaced, escaped):
        ack = result[failed["content_key"]]
        assert (ack["outcome"], ack["coverage"], ack["coverage_reason"]) == (
            "recorded",
            "collection_failed",
            "placement_failed",
        )
    assert result[placed["content_key"]]["outcome"] == "available"
    session = await only_session(db_session)
    assert session.content_bytes == len(b"see src/a.py and ~/notes.md")
    stored = {row.content_key: row for row in await contents(db_session)}
    assert stored[unplaced["content_key"]].inline_text is None


async def test_an_empty_body_is_available_without_an_upload(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    empty = declaration(b"", delivery="upload")
    [ack] = (
        await ingest(
            device_client, enrolled, [rich_record(enrolled["mapping_id"], [empty])]
        )
    )["contents"]
    assert ack["outcome"] == "available"
    assert ack["upload"] is None


async def test_an_attachment_upload_asks_for_its_chunks(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    image = declaration(PNG, channel="attachment", role="user", media_type="image/png")
    [ack] = (
        await ingest(
            device_client, enrolled, [rich_record(enrolled["mapping_id"], [image])]
        )
    )["contents"]
    assert ack["outcome"] == "upload_required"
    assert ack["upload"]["chunk_count"] == 1


# --- sessions, identity and counts ------------------------------------------------


async def test_a_content_only_record_resolves_the_session_like_an_event_record(
    client, device_client, db_session, test_workspace, test_board
):
    """m13: same identity as events, beacon provenance kept, no counts."""
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    record = wire("ingest-request-content-only-record")
    record["mapping_id"] = enrolled["mapping_id"]
    record["beacon"] = {"commit": "a1b2c3d4", "schema_version": None}
    result = await ingest(device_client, enrolled, [record])
    assert result["acknowledged"] == [record["capture_id"]]
    session = await only_session(db_session)
    assert (session.harness, session.native_session_id) == ("claude_code", "sess-1")
    assert (session.event_count, session.prompt_count, session.tool_call_count) == (
        0,
        0,
        0,
    )
    assert session.content_count == 1
    receipt = await db_session.scalar(select(AgentSessionCapture))
    assert (receipt.beacon_commit, receipt.beacon_schema_version) == ("a1b2c3d4", None)
    assert receipt.event_count == 0

    events = wire("ingest-request-rich-record")
    events["mapping_id"] = enrolled["mapping_id"]
    await ingest(device_client, enrolled, [events])
    assert (await only_session(db_session)).id == session.id


async def test_an_events_only_rewrite_of_a_stored_record_counts_nothing_twice(
    client, device_client, db_session, test_workspace, test_board
):
    """R2-8: the device's events-only retry R' of a record R whose ack was
    lost adds no events, usage or counter increments, in the same session."""
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    usage_event = {
        "timestamp": "2026-10-08T14:03:30Z",
        "schema_version": "1.0",
        "event": {"id": "u" * 64, "action": "token.usage"},
        "harness": {"name": "claude_code", "collection_method": "hook"},
        "session": {"id": "sess-1"},
        "model": "claude-opus-4-1",
        "gen_ai": {"usage": {"input_tokens": 100, "output_tokens": 50}},
    }
    original = rich_record(
        enrolled["mapping_id"],
        [declaration(b"reply body")],
        events=[*wire("ingest-request-rich-record")["events"], usage_event],
    )
    await ingest(device_client, enrolled, [original])
    before = await only_session(db_session)
    counters = (
        before.id,
        before.event_count,
        before.prompt_count,
        before.input_tokens,
        before.output_tokens,
        before.activity_event_count,
    )
    usage_rows = await db_session.scalar(
        select(func.count()).select_from(AgentSessionUsage)
    )

    rewrite = copy.deepcopy(original)
    rewrite["capture_id"] = uuid.uuid4().hex
    del rewrite["contents"], rewrite["capture_generation"]
    result = await ingest(device_client, enrolled, [rewrite])
    assert result["acknowledged"] == [rewrite["capture_id"]]
    after = await only_session(db_session)
    assert (
        after.id,
        after.event_count,
        after.prompt_count,
        after.input_tokens,
        after.output_tokens,
        after.activity_event_count,
    ) == counters
    assert (
        await db_session.scalar(select(func.count()).select_from(AgentSessionUsage))
        == usage_rows
    )


async def test_old_companions_records_and_responses_still_work(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(
        client, device_client, db_session, test_workspace, test_board, capabilities=None
    )
    record = wire("ingest-request-rich-record")
    record["mapping_id"] = enrolled["mapping_id"]
    del record["contents"], record["capture_generation"]
    result = await ingest(device_client, enrolled, [record])
    assert result["acknowledged"] == [record["capture_id"]]
    assert result["contents"] == []
    assert (await only_session(db_session)).content_count == 0


async def test_sessions_written_before_rich_capture_claim_no_content(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    record = wire("ingest-request-rich-record")
    record["mapping_id"] = enrolled["mapping_id"]
    del record["contents"], record["capture_generation"]
    await ingest(device_client, enrolled, [record])
    session = await only_session(db_session)
    listed = await client.get(f"{sessions_path(test_workspace, session.id)}/contents")
    assert listed.status_code == 200, listed.text
    assert listed.json() == {"items": [], "next_cursor": None}


async def test_contents_publish_their_own_invalidation(
    client, device_client, db_session, test_workspace, test_board
):
    from unittest.mock import AsyncMock, patch

    from app.core.event_bus import event_bus

    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    with patch.object(event_bus, "publish", new_callable=AsyncMock) as publish:
        await ingest(
            device_client,
            enrolled,
            [rich_record(enrolled["mapping_id"], [declaration(b"x")], events=[])],
        )
    reasons = [
        call.kwargs["payload"]["reason"]
        for call in publish.await_args_list
        if call.kwargs.get("event_type") == "agent_session.updated"
    ]
    assert reasons == ["contents"]


# --- privacy of dedupe, deleted history and decision precedence -----------------


async def test_dedupe_never_reaches_another_owner_or_another_device(
    client, device_client, db_session, test_workspace, test_board, second_user
):
    """Idempotency is per (session, key): the same key elsewhere is a fresh
    item, so an ack can never confirm what someone else stored."""
    victim = await rich(client, device_client, db_session, test_workspace, test_board)
    key = content_key("claude_code", "sess-1", "known-item", "text:0")
    stored = await ingest(
        device_client,
        victim,
        [rich_record(victim["mapping_id"], [declaration(b"victim bytes", key=key)])],
    )
    [victim_ack] = stored["contents"]
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=second_user.id,
            role=WorkspaceRole.member,
        )
    )
    await db_session.flush()
    async with as_user(db_session, second_user) as other_owner:
        stranger = await enroll_rich(
            other_owner,
            device_client,
            db_session,
            test_workspace,
            test_board,
            root="/synthetic/stranger",
        )
    second_device = await rich(
        client,
        device_client,
        db_session,
        test_workspace,
        test_board,
        root="/synthetic/second",
    )
    # Same bytes from another owner, other bytes from another device of the
    # same owner on the same native session: neither is the victim's item.
    for enrolled, body in [
        (stranger, b"victim bytes"),
        (second_device, b"other bytes"),
    ]:
        result = await ingest(
            device_client,
            enrolled,
            [
                rich_record(
                    enrolled["mapping_id"], [declaration(body, key=key)], events=[]
                )
            ],
        )
        [ack] = result["contents"]
        assert ack["outcome"] == "available", ack
        assert ack["content_id"] != victim_ack["content_id"]


@pytest.mark.parametrize("deletion", ["owner", "device_sessions"])
async def test_the_original_record_replayed_after_deletion_restores_nothing(
    client, device_client, db_session, test_workspace, test_board, deletion
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    record = rich_record(
        enrolled["mapping_id"],
        [declaration(b"deleted body"), declaration(b"d" * 20_000)],
    )
    await ingest(device_client, enrolled, [record])
    session = await only_session(db_session)
    if deletion == "owner":
        response = await client.delete(sessions_path(test_workspace, session.id))
        assert response.status_code == 204
    else:
        response = await client.delete(f"{ME}/{enrolled['installation_id']}/sessions")
        assert response.status_code == 200

    replay = await ingest(device_client, enrolled, [record])
    assert replay["dropped"] == [
        {"capture_id": record["capture_id"], "reason": "session_deleted"}
    ]
    assert {ack["outcome"] for ack in replay["contents"]} == {"dropped"}
    assert await contents(db_session) == []
    assert await only_session(db_session) is None
    assert await installation_bytes(db_session, enrolled) == 0


async def test_deleted_history_is_dropped_even_with_rich_capture_off(
    client, device_client, db_session, test_workspace, test_board, monkeypatch
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    record = rich_record(enrolled["mapping_id"], [declaration(b"before")])
    await ingest(device_client, enrolled, [record])
    session = await only_session(db_session)
    await client.delete(sessions_path(test_workspace, session.id))
    monkeypatch.setattr(settings, "RICH_CAPTURE_ENABLED", False)
    late = rich_record(enrolled["mapping_id"], [declaration(b"stale retry")])
    [ack] = (await ingest(device_client, enrolled, [late]))["contents"]
    assert ack["outcome"] == "dropped"


async def test_a_stored_key_keeps_its_ack_after_the_quota_fills(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    record = rich_record(enrolled["mapping_id"], [declaration(b"stored first")])
    first = await ingest(device_client, enrolled, [record])
    await db_session.execute(
        update(CompanionInstallation)
        .where(CompanionInstallation.id == uuid.UUID(enrolled["installation_id"]))
        .values(content_bytes=10 << 30)
    )
    await db_session.flush()
    replay = await ingest(device_client, enrolled, [record])
    assert replay["contents"] == first["contents"]


async def test_an_excluded_path_is_decided_before_admission(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    await db_session.execute(
        update(CompanionInstallation)
        .where(CompanionInstallation.id == uuid.UUID(enrolled["installation_id"]))
        .values(exclude_globs=["secrets/*"])
    )
    await db_session.flush()
    early = declaration(
        b"TOKEN=x",
        channel="file_content",
        display_path="secrets/a.env",
        occurred_at="2026-10-08T13:00:00Z",
    )
    [ack] = (
        await ingest(
            device_client, enrolled, [rich_record(enrolled["mapping_id"], [early])]
        )
    )["contents"]
    assert (ack["outcome"], ack["coverage_reason"]) == ("recorded", "excluded_path")


async def test_a_replay_after_its_mapping_was_deleted_still_hears_its_acks(
    client, device_client, db_session, test_workspace, test_board
):
    """A device that lost the first response learns its content ids even
    once the mapping that admitted them is gone."""
    enrolled = await rich(client, device_client, db_session, test_workspace, test_board)
    record = rich_record(
        enrolled["mapping_id"], [declaration(b"x" * 20_000), declaration(b"inline")]
    )
    first = await ingest(device_client, enrolled, [record])
    deleted = await client.delete(
        f"{ME}/{enrolled['installation_id']}/mappings/{enrolled['mapping_id']}"
    )
    assert deleted.status_code == 204, deleted.text
    replay = await ingest(device_client, enrolled, [record])
    assert replay["acknowledged"] == [record["capture_id"]]
    assert replay["contents"] == first["contents"]
