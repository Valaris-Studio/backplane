# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The receipt notification stays owned by the actual outer transaction."""

import asyncio

import pytest
import websockets
from sqlalchemy import text

from tests.routers.agents.event_authority_support import (
    RECEIPT,
    _receipt_case_fixture,  # noqa: F401
    _wire_case_fixture,  # noqa: F401
    db_engine,  # noqa: F401
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(40)]


@pytest.mark.parametrize("actor", ["outsider", "invalid"])
async def test_real_handshake_denies_nonmember_and_unknown_bearer(wire_case, actor):
    f = wire_case
    headers = f.case.headers[actor] if actor != "invalid" else {"Authorization": "Bearer vlr_not-a-real-credential"}
    with pytest.raises(websockets.InvalidStatus) as denied:
        await websockets.connect(f.ws_base + f"/ws/workspaces/{f.case.workspace['slug']}/events",
                                 additional_headers=headers, open_timeout=3)
    assert denied.value.response.status_code == 403


@pytest.mark.parametrize("outcome", ["commit", "rollback", "deferred_commit_failure"])
async def test_socket_receipt_follows_outer_commit_and_exact_replay_is_silent(wire_case, outcome):
    f = wire_case
    reader = await f.connect("recipient", [RECEIPT])
    owner = await f.connect("curator", ["*"])
    execution, payload = await f.begin_receipt()
    path = f.case.execution_path(execution["id"]) + "/context-receipts"
    if outcome == "deferred_commit_failure":
        async with f.case.factory() as db:
            await db.execute(text("CREATE TABLE event_test_commit_fail (enabled boolean NOT NULL)"))
            await db.execute(text("INSERT INTO event_test_commit_fail VALUES (true)"))
            await db.execute(text("""
                CREATE FUNCTION event_test_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                  IF (SELECT enabled FROM event_test_commit_fail LIMIT 1) THEN
                    RAISE EXCEPTION 'synthetic event test outer commit failure';
                  END IF;
                  RETURN NULL;
                END $$
            """))
            await db.execute(text("""
                CREATE CONSTRAINT TRIGGER event_test_fail_commit AFTER INSERT ON execution_context_receipts
                DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION event_test_fail_commit()
            """))
            await db.commit()
    f.rollback = outcome == "rollback"
    request = asyncio.create_task(f.case.http.post(path, json=payload,
        headers={**f.case.headers["agent"], "X-Event-Test-Hold": f.hold_token}))
    arrived = asyncio.create_task(f.held.wait())
    try:
        done, _ = await asyncio.wait({request, arrived}, timeout=5, return_when=asyncio.FIRST_COMPLETED)
        assert arrived in done, (await request).text if request.done() else "Caller-owned transaction not reached"
        await f.barrier([reader, owner])
        assert reader.events(RECEIPT) == owner.events(RECEIPT) == []
        f.release.set()
        response = await asyncio.wait_for(request, 5)
    finally:
        f.release.set()
        for task in [arrived, request]:
            if not task.done():
                task.cancel()
        await asyncio.gather(arrived, request, return_exceptions=True)
    if outcome != "commit":
        assert response.status_code == 500, response.text
        await f.barrier([reader, owner])
        assert reader.events(RECEIPT) == owner.events(RECEIPT) == []
        listed = await f.case.http.get(path, headers=f.case.headers["recipient"])
        assert listed.status_code == 200 and listed.json() == []
        if outcome == "deferred_commit_failure":
            async with f.case.factory() as db:
                await db.execute(text("UPDATE event_test_commit_fail SET enabled=false"))
                await db.commit()
        response = await f.case.http.post(path, json=payload, headers=f.case.headers["agent"])
    assert response.status_code == 201, response.text
    first = response.json()
    for client in [reader, owner]:
        await client.until(lambda e: e.get("event") == RECEIPT and e["payload"]["receipt_id"] == first["id"])
    replay = await f.case.http.post(path, json=payload, headers=f.case.headers["agent"])
    assert replay.status_code == 200 and replay.json()["id"] == first["id"]
    second_payload = {**payload, "client_request_id": payload["client_request_id"] + "-second"}
    second = await f.case.http.post(path, json=second_payload, headers=f.case.headers["agent"])
    assert second.status_code == 201 and second.json()["ordinal"] == 2, second.text
    for client in [reader, owner]:
        await client.until(lambda e: e.get("event") == RECEIPT and e["payload"]["receipt_id"] == second.json()["id"])
        assert [e["payload"]["receipt_id"] for e in client.events(RECEIPT)] == [first["id"], second.json()["id"]]
