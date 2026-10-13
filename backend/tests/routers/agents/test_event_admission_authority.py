# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored: subscription admission uses the CURRENT role.

No event is published between the committed change and the subscribe frame,
so a role cached from connect or from an earlier delivery would be stale.
"""

import json
import uuid

import pytest

from tests.routers.agents.event_authority_support import (
    RECEIPT,
    _receipt_case_fixture,  # noqa: F401
    _wire_case_fixture,  # noqa: F401
    db_engine,  # noqa: F401
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(40)]


def _denials(client):
    return [f for f in client.frames if f.get("type") == "subscription_denied"]


async def test_admission_after_committed_demotion_denies_observer_patterns(wire_case):
    f = wire_case
    await f.member_role("admin")
    reader = await f.connect("recipient", [])
    assert _denials(reader) == []
    await f.member_role("member")
    await reader.ws.send(json.dumps({"subscribe": ["card.*", RECEIPT, "execution.*", "*"]}))
    denied = await reader.until(lambda e: e.get("type") == "subscription_denied")
    assert denied["error_code"] == "admin_required"
    assert denied["patterns"] == ["execution.*", "*"]
    # The board pattern and the exact receipt name stay subscribed.
    marker = uuid.uuid4().hex
    await f.publish("card.updated", {"marker": marker})
    await reader.until(lambda e: e.get("payload", {}).get("marker") == marker)
    assert reader.closed is None


async def test_admission_after_committed_promotion_allows_observer_patterns(wire_case):
    f = wire_case
    await f.member_role("member")
    reader = await f.connect("recipient", [])
    await f.member_role("admin")
    await reader.ws.send(json.dumps({"subscribe": ["card.*", "*"]}))
    # No subscribe acknowledgement exists: repeat an observer marker until the
    # new frame is applied. A denied `*` never receives one.
    for attempt in range(20):
        marker = uuid.uuid4().hex
        await f.publish("execution.completed", {"marker": marker})
        try:
            await reader.until(lambda e: e.get("event") == "execution.completed"
                               and e["payload"].get("marker") == marker, timeout=0.2)
            break
        except TimeoutError:
            assert attempt < 19, "observer pattern was never admitted"
    assert _denials(reader) == []


async def test_admission_after_committed_revocation_closes_opaquely(wire_case):
    f = wire_case
    reader = await f.connect("recipient", [])
    response = await f.case.http.delete(
        f"/api/workspaces/{f.case.workspace['slug']}/members/{f.case.recipient_id}",
        headers=f.case.headers["curator"])
    assert response.status_code == 204, response.text
    await reader.ws.send(json.dumps({"subscribe": ["card.*", "*"]}))
    await reader.until(lambda e: False, allow_closed=True)
    assert reader.closed is not None and reader.closed[0] in {4001, 4002}
    assert _denials(reader) == []
