# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""PR #391 review: the clock lead is measured over the device's latest
receipts, not over the clock that stamped the deleted history, so a device
clock corrected between capture and deletion opens a resurfacing window."""

from datetime import timedelta

from app.core.time import as_utc
from tests.test_agent_sessions import SESSIONS, enroll, record
from tests.test_session_delete_cutoff import (
    NATIVE,
    PRE_DELETION_PROMPT,
    _events,
    _ingest,
    _now,
    _prompt,
    _record,
    _session_count,
    _stored_json,
    _tombstone,
    device_client,  # noqa: F401
)

CLOCK_WAS_AHEAD = timedelta(hours=1)
BUSY_SESSION = "busy-other-session"


async def _fifty_receipts_on_a_corrected_clock(device_client, token, mapping_id):
    """NTP fixed the clock; the owner keeps working in another session."""
    for batch in range(2):
        records = []
        for index in range(25):
            at = _now()
            records.append(
                record(
                    _events(f"busy-{batch}-{index}", at, count=1),
                    mapping_id,
                    session=BUSY_SESSION,
                )
                | {"captured_at": at.isoformat()}
            )
        await _ingest(device_client, token, records)


async def _delete_native(client, native):
    items = (await client.get(SESSIONS)).json()["items"]
    [item] = [item for item in items if item["native_session_id"] == native]
    assert (await client.delete(f"{SESSIONS}/{item['id']}")).status_code == 204


async def test_a_clock_corrected_before_the_deletion_cannot_resurface_a_retry(
    client, device_client, db_session, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    # Real time now-5min, stamped by a clock running an hour fast.
    stamped = _now() - timedelta(minutes=5) + CLOCK_WAS_AHEAD
    pre_deletion = _record(
        [*_events("old", stamped), _prompt("old", stamped, PRE_DELETION_PROMPT)],
        mapping_id,
        stamped,
    )
    await _ingest(device_client, token, [pre_deletion])
    await _fifty_receipts_on_a_corrected_clock(device_client, token, mapping_id)
    await _delete_native(client, NATIVE)

    # The ack of the original upload was lost; the daemon retries it. Its
    # receipt went with the deleted session, so it is not "already received".
    result = await _ingest(device_client, token, [pre_deletion])

    assert PRE_DELETION_PROMPT not in await _stored_json(db_session), (
        "pre-deletion content resurfaced; cutoff="
        f"{as_utc((await _tombstone(db_session)).history_cutoff)} stamp={stamped}"
    )
    assert [drop["capture_id"] for drop in result["dropped"]] == [
        pre_deletion["capture_id"]
    ]


async def test_re_deleting_never_moves_the_cutoff_back(
    client, device_client, db_session, test_workspace
):
    token, mapping_id = await enroll(client, test_workspace)
    stamped = _now() - timedelta(minutes=5) + CLOCK_WAS_AHEAD
    pre_deletion = _record(
        [*_events("old", stamped), _prompt("old", stamped, PRE_DELETION_PROMPT)],
        mapping_id,
        stamped,
    )
    await _ingest(device_client, token, [pre_deletion])
    await _delete_native(client, NATIVE)
    first_cutoff = as_utc((await _tombstone(db_session)).history_cutoff)

    # Resumed while the clock is still fast, so it is past the first cutoff.
    resumed_at = first_cutoff + timedelta(seconds=30)
    await _ingest(
        device_client,
        token,
        [_record(_events("resumed", resumed_at), mapping_id, resumed_at)],
    )
    await _fifty_receipts_on_a_corrected_clock(device_client, token, mapping_id)
    await _delete_native(client, NATIVE)

    tombstone = await _tombstone(db_session)
    assert as_utc(tombstone.history_cutoff) >= first_cutoff
    await _ingest(device_client, token, [pre_deletion])
    assert PRE_DELETION_PROMPT not in await _stored_json(db_session)
    assert await _session_count(db_session) == 1  # only the busy session
