# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""A device's own traffic (ingest, rich-capture chunk uploads, finalizes,
status, policy) has its own budget instead of the anonymous per-IP one, while
unauthenticated and forged-token traffic from that IP stays bounded."""

import re
import uuid
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from app.core import rate_limit
from app.core.rate_limit import UNAUTHENTICATED_LIMIT
from app.database import get_db
from app.main import create_app
from tests.test_companion import device, enroll

POLICY = "/api/companion/policy"
OFFICE_IP = ("198.51.100.20", 40000)
COMPANION = Path(__file__).parents[2] / "companion"


@pytest.fixture
async def office(db_session):
    """Real auth and one shared client IP, as devices behind one NAT."""
    app = create_app()

    async def database():
        yield db_session

    app.dependency_overrides[get_db] = database
    async with AsyncClient(
        transport=ASGITransport(app, client=OFFICE_IP), base_url="http://test"
    ) as client:
        yield client


@pytest.fixture
async def laptop(client, test_workspace):
    response = await enroll(client, name="Laptop")
    assert response.status_code == 201, response.text
    return response.json()


async def test_a_device_is_not_held_to_the_anonymous_per_ip_budget(office, laptop):
    for _ in range(UNAUTHENTICATED_LIMIT + 5):
        response = await office.get(POLICY, headers=device(laptop["device_token"]))
        assert response.status_code == 200, response.text


async def test_anonymous_traffic_from_the_devices_ip_stays_bounded(office, laptop):
    for _ in range(UNAUTHENTICATED_LIMIT + 5):
        await office.get(POLICY, headers=device(laptop["device_token"]))
    statuses = [
        (await office.get("/api/health")).status_code
        for _ in range(UNAUTHENTICATED_LIMIT + 1)
    ]
    assert statuses[:UNAUTHENTICATED_LIMIT] == [200] * UNAUTHENTICATED_LIMIT
    assert statuses[-1] == 429


async def test_a_devices_own_excess_is_still_bounded(office, laptop, monkeypatch):
    monkeypatch.setattr(rate_limit, "DEVICE_LIMIT", 3)
    statuses = [
        (await office.get(POLICY, headers=device(laptop["device_token"]))).status_code
        for _ in range(4)
    ]
    assert statuses == [200, 200, 200, 429]


def forged():
    """A device token nobody issued, with a distinct bucket prefix each time."""
    return device("bpc_" + uuid.uuid4().hex + uuid.uuid4().hex[:11])


def limiter_of(client) -> rate_limit.RateLimitMiddleware:
    layer = client._transport.app.middleware_stack
    while not isinstance(layer, rate_limit.RateLimitMiddleware):
        layer = layer.app
    return layer


def device_buckets(client) -> int:
    return sum(1 for key in limiter_of(client)._requests if key.startswith("device:"))


@pytest.mark.parametrize(
    "method, path, refused",
    [
        ("GET", POLICY, 401),
        ("GET", "/api/companion/nope", 404),
        ("DELETE", POLICY, 405),
        ("GET", "/api/companion/pairing", 405),
        (
            "POST",
            "/api/companion/contents/00000000-0000-4000-8000-000000000000/finalize",
            401,
        ),
    ],
)
async def test_forged_device_tokens_stay_within_the_anonymous_budget(
    office, method, path, refused
):
    statuses = [
        (await office.request(method, path, headers=forged())).status_code
        for _ in range(UNAUTHENTICATED_LIMIT + 1)
    ]
    assert statuses[:UNAUTHENTICATED_LIMIT] == [refused] * UNAUTHENTICATED_LIMIT
    assert statuses[-1] == 429


@pytest.mark.parametrize("path", [POLICY, "/api/companion/nope"])
async def test_forged_device_tokens_leave_no_bucket_behind(office, path):
    for _ in range(UNAUTHENTICATED_LIMIT + 200):
        await office.get(path, headers=forged())
    assert device_buckets(office) == 0


async def test_a_verified_device_keeps_working_after_a_forger_spends_its_ip(
    office, laptop
):
    first = await office.get(POLICY, headers=device(laptop["device_token"]))
    assert first.status_code == 200
    for _ in range(UNAUTHENTICATED_LIMIT + 1):
        await office.get(POLICY, headers=forged())
    later = await office.get(POLICY, headers=device(laptop["device_token"]))
    assert later.status_code == 200, later.text


def go_constant(relative_path: str, name: str) -> int:
    source = (COMPANION / relative_path).read_text()
    return int(re.search(rf"^\s*{name}\s*=\s*(\d+)", source, re.MULTILINE).group(1))


def test_the_device_budget_covers_the_daemons_busiest_tick():
    batches = go_constant("internal/daemon/daemon.go", "maxBatchesPerTick")
    chunks = go_constant("internal/daemon/content.go", "maxChunkUploads")
    # Each body a tick uploads ends in a finalize, so chunks bound finalizes too.
    assert rate_limit.DEVICE_LIMIT >= 60 * (batches + 2 * chunks)


async def test_a_colliding_unverified_request_leaves_the_verified_bucket_alone(
    office, laptop
):
    token = laptop["device_token"]
    assert (await office.get(POLICY, headers=device(token))).status_code == 200
    colliding = token[:13] + ("A" if token[13] != "A" else "B") + token[14:]
    assert (await office.get(POLICY, headers=device(colliding))).status_code == 401
    bucket = limiter_of(office)._requests.get(f"device:Bearer {token}"[:27])
    assert bucket is not None and len(bucket) == 1


async def test_concurrent_forgeries_are_all_counted(office):
    import asyncio

    await asyncio.gather(
        *(office.get(POLICY, headers=forged()) for _ in range(UNAUTHENTICATED_LIMIT))
    )
    assert (await office.get(POLICY, headers=forged())).status_code == 429


async def test_concurrent_forgeries_are_gated_at_entry(office):
    """The refused budget is reserved before the route runs, so a burst of
    forgeries in flight together, whether each opens a new bucket or they all
    share one, gets no more through than the same burst sent in sequence."""
    import asyncio

    shared = "bpc_" + uuid.uuid4().hex[:9]
    requests = [
        office.get(POLICY, headers=forged()) for _ in range(UNAUTHENTICATED_LIMIT)
    ]
    requests += [
        office.get(POLICY, headers=device(shared + uuid.uuid4().hex))
        for _ in range(UNAUTHENTICATED_LIMIT)
    ]
    statuses = [response.status_code for response in await asyncio.gather(*requests)]
    assert sum(status != 429 for status in statuses) <= UNAUTHENTICATED_LIMIT
    assert device_buckets(office) == 0


async def test_a_token_that_stops_verifying_is_bounded_again(office, laptop):
    """Verified once is not verified for good: a revoked token's requests
    spend its IP's refused budget like any forgery."""
    token = laptop["device_token"]
    assert (await office.get(POLICY, headers=device(token))).status_code == 200
    revoked = await office.delete("/api/companion/installation", headers=device(token))
    assert revoked.status_code == 200, revoked.text
    statuses = [
        (await office.get(POLICY, headers=device(token))).status_code
        for _ in range(UNAUTHENTICATED_LIMIT + 1)
    ]
    assert statuses[:UNAUTHENTICATED_LIMIT] == [401] * UNAUTHENTICATED_LIMIT
    assert statuses[-1] == 429


async def test_a_verified_devices_refused_request_is_charged_then_reverified(
    office, laptop
):
    token = laptop["device_token"]
    assert (await office.get(POLICY, headers=device(token))).status_code == 200
    assert (
        await office.get("/api/companion/nope", headers=device(token))
    ).status_code == 404
    assert (await office.get(POLICY, headers=device(token))).status_code == 200
    # The wrong-path request spent one slot of the IP's refused budget.
    statuses = [
        (await office.get(POLICY, headers=forged())).status_code
        for _ in range(UNAUTHENTICATED_LIMIT)
    ]
    assert statuses[: UNAUTHENTICATED_LIMIT - 1] == [401] * (UNAUTHENTICATED_LIMIT - 1)
    assert statuses[-1] == 429
