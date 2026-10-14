# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Per-model usage rows, list-price estimates and cost provenance."""

import copy
import hashlib
import uuid
from decimal import Decimal

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, update

from app.database import get_db
from app.main import create_app
from app.models.agent_session import (
    AgentSession,
    AgentSessionEvent,
    AgentSessionUsage,
)
from app.models.companion import CompanionProjectMapping
from app.pricing import PriceTable, TokenUsage, current_price_table
from app.services.agent_usage import pi_auth_kind, reprice_next_session, reprice_usage
from tests.test_agent_sessions import (
    FIXTURE_EVENTS,
    SESSIONS,
    enroll,
    outcome,
    upload,
    work_under_invocation,
)

AT = "2026-09-24T02:21:29Z"


@pytest.fixture
async def device_client(db_session):
    app = create_app()

    async def database():
        yield db_session

    app.dependency_overrides[get_db] = database
    async with AsyncClient(
        transport=ASGITransport(app), base_url="http://test"
    ) as client:
        yield client


def beacon(event_id, action, harness, session, *, collection_method="otlp", **fields):
    return {
        "schema_version": "1.0",
        "timestamp": fields.pop("timestamp", AT),
        "event": {"action": action, "id": event_id},
        "harness": {"name": harness, "collection_method": collection_method},
        "session": {"id": session},
        **fields,
    }


def codex_turn(event_id="turn-1", *, session="thread-1", model="gpt-5.4", **usage):
    """Beacon's normalization of Codex's completed-turn span: input is the
    uncached remainder, reasoning a subset of output."""
    return beacon(
        event_id,
        "token.usage",
        "codex_cli",
        session,
        model=model,
        gen_ai={
            "usage": {
                "input_tokens": usage.get("uncached", 1000),
                "cache_read": {"input_tokens": usage.get("cache_read", 9000)},
                "output_tokens": usage.get("output", 500),
                "reasoning": {"output_tokens": usage.get("reasoning", 200)},
            }
        },
        raw={"otel_signal": "traces", "source": "codex_turn_span", "turn_id": event_id},
    )


def codex_log(event_id, session="thread-1", **attributes):
    return beacon(
        event_id,
        "session.activity",
        "codex_cli",
        session,
        model="gpt-5.4",
        raw={
            "otel_signal": "logs",
            "attributes": {"event.name": "codex.sse_event", **attributes},
        },
    )


def pi_message(
    event_id="pi-msg-1", *, session="pi-1", provider="anthropic", cost=0.004, **usage
):
    reported = {} if cost is None else {"cost_usd": cost}
    return beacon(
        event_id,
        "token.usage",
        "pi_cli",
        session,
        collection_method="plugin",
        model="claude-sonnet-4-5",
        gen_ai={
            "usage": {
                "input_tokens": usage.get("uncached", 90),
                "output_tokens": usage.get("output", 12),
                "cache_read": {"input_tokens": usage.get("cache_read", 1000)},
                "cache_creation": {"input_tokens": usage.get("cache_write", 300)},
                **reported,
            }
        },
        raw={
            "pi": {
                "type": "message_end",
                "model": f"{provider}/claude-sonnet-4-5",
                "message": {
                    "role": "assistant",
                    "provider": provider,
                    "model": "claude-sonnet-4-5",
                    "usage": {"cacheWrite1h": usage.get("cache_write_1h", 100)},
                },
            }
        },
    )


def capture(events, mapping_id, *, harness, session, collection_method="otlp"):
    return {
        "capture_id": uuid.uuid4().hex,
        "mapping_id": mapping_id,
        "harness": harness,
        "collection_method": collection_method,
        "native_session_id": session,
        "captured_at": "2026-09-24T02:21:30Z",
        "beacon": {"commit": "b" * 40, "schema_version": "1.0"},
        "events": events,
    }


async def session_named(db_session, native_id) -> AgentSession:
    return await db_session.scalar(
        select(AgentSession)
        .where(AgentSession.native_session_id == native_id)
        .execution_options(populate_existing=True)
    )


async def usage_rows(db_session, session_id):
    return (
        await db_session.scalars(
            select(AgentSessionUsage)
            .where(AgentSessionUsage.session_id == session_id)
            .order_by(AgentSessionUsage.occurred_at, AgentSessionUsage.event_id)
            .execution_options(populate_existing=True)
        )
    ).all()


def estimate(model, *, service_tier=None, provider=None, **buckets) -> Decimal:
    quoted = current_price_table().quote(
        model=model,
        provider=provider,
        service_tier=service_tier,
        usage=TokenUsage(**buckets),
    )
    assert quoted.status == "priced"
    return quoted.cost_usd


@pytest.fixture
async def enrolled(client, test_workspace, test_board):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    return token, mapping_id


async def send(device_client, enrolled, events, *, harness, session, **kwargs):
    token, mapping_id = enrolled
    await upload(
        device_client,
        token,
        [capture(events, mapping_id, harness=harness, session=session, **kwargs)],
    )


async def test_codex_turn_is_estimated_at_its_plan_and_tier(
    client,
    device_client,
    enrolled,
    db_session,
):
    await send(
        device_client,
        enrolled,
        [
            codex_log("start", auth_mode="Chatgpt", provider_name="openai"),
            codex_log("sse-1", service_tier="priority"),
            codex_turn(),
        ],
        harness="codex_cli",
        session="thread-1",
    )
    session = await session_named(db_session, "thread-1")
    [row] = await usage_rows(db_session, session.id)
    assert (row.input_uncached_tokens, row.cache_read_tokens) == (1000, 9000)
    assert (row.output_tokens, row.reasoning_tokens) == (500, 200)
    assert (row.cache_write_5m_tokens, row.cache_write_1h_tokens) == (0, 0)
    # A turn sums several model requests: no single prompt size to tier on.
    assert row.context_tokens is None
    assert (row.model, row.provider, row.service_tier) == (
        "gpt-5.4",
        "openai",
        "priority",
    )
    assert row.auth_kind == "subscription"
    assert (row.cost_source, row.pricing_status) == ("estimated", "priced")
    assert row.cost_reported_usd is None
    assert row.price_table_version == current_price_table().version
    expected = estimate(
        "gpt-5.4",
        service_tier="priority",
        input_uncached=1000,
        cache_read=9000,
        output=500,
        reasoning=200,
    )
    assert row.cost_estimated_usd == pytest.approx(expected)
    assert float(session.cost_usd) == pytest.approx(float(expected), abs=1e-6)
    assert float(session.cost_estimated_usd) == pytest.approx(float(expected), abs=1e-6)
    assert session.cost_reported_usd is None
    assert session.reasoning_tokens == 200 and session.unpriced_usage_count == 0

    read = (await client.get(f"{SESSIONS}/{session.id}")).json()
    assert read["cost_source"] == "estimated"
    assert read["cost_basis"] == "api_equivalent"
    assert read["auth_kind"] == "subscription" and read["service_tier"] == "priority"
    assert read["cost_complete"] is True
    assert read["cost_reported_usd"] is None
    assert read["reasoning_tokens"] == 200


async def test_codex_plan_and_tier_learned_after_the_turn_reprice_it(
    device_client,
    enrolled,
    db_session,
):
    await send(
        device_client, enrolled, [codex_turn()], harness="codex_cli", session="thread-1"
    )
    session = await session_named(db_session, "thread-1")
    standard = estimate(
        "gpt-5.4", input_uncached=1000, cache_read=9000, output=500, reasoning=200
    )
    [row] = await usage_rows(db_session, session.id)
    assert (row.auth_kind, row.service_tier) == ("unknown", None)
    assert row.cost_estimated_usd == pytest.approx(standard)

    await send(
        device_client,
        enrolled,
        [
            codex_log("start", auth_mode="ApiKey"),
            codex_log("sse-1", service_tier="priority"),
        ],
        harness="codex_cli",
        session="thread-1",
    )
    priority = estimate(
        "gpt-5.4",
        service_tier="priority",
        input_uncached=1000,
        cache_read=9000,
        output=500,
        reasoning=200,
    )
    [row] = await usage_rows(db_session, session.id)
    session = await session_named(db_session, "thread-1")
    assert (row.auth_kind, row.service_tier) == ("api", "priority")
    assert row.cost_estimated_usd == pytest.approx(priority)
    assert float(session.cost_usd) == pytest.approx(float(priority), abs=1e-6)
    assert session.auth_kind == "api"


async def test_pi_reported_cost_wins_and_the_estimate_is_kept_beside_it(
    client,
    device_client,
    enrolled,
    db_session,
):
    await send(
        device_client,
        enrolled,
        [pi_message()],
        harness="pi_cli",
        session="pi-1",
        collection_method="plugin",
    )
    session = await session_named(db_session, "pi-1")
    [row] = await usage_rows(db_session, session.id)
    # Pi's cacheWrite includes its 1h share; Beacon forwards only the total.
    assert (row.cache_write_5m_tokens, row.cache_write_1h_tokens) == (200, 100)
    assert (row.input_uncached_tokens, row.cache_read_tokens, row.output_tokens) == (
        90,
        1000,
        12,
    )
    # One assistant message is one request: its prompt size selects the tier.
    assert row.context_tokens == 90 + 1000 + 300
    assert row.provider == "anthropic"
    # Anthropic in Pi may be an API key or a Claude subscription login.
    assert row.auth_kind == "unknown"
    assert row.cost_reported_usd == pytest.approx(Decimal("0.004"))
    expected = estimate(
        "claude-sonnet-4-5",
        input_uncached=90,
        cache_read=1000,
        cache_write_5m=200,
        cache_write_1h=100,
        output=12,
        context_tokens=1390,
    )
    assert row.cost_estimated_usd == pytest.approx(expected)
    assert row.cost_source == "reported"
    assert float(session.cost_usd) == pytest.approx(0.004)
    assert float(session.cost_reported_usd) == pytest.approx(0.004)
    assert float(session.cost_estimated_usd) == pytest.approx(float(expected), abs=1e-6)
    read = (await client.get(f"{SESSIONS}/{session.id}")).json()
    assert read["cost_source"] == "reported"
    assert read["cost_basis"] == "api_equivalent"


@pytest.mark.parametrize(
    "provider, auth_kind, basis",
    [("openai-codex", "subscription", "api_equivalent"), ("openai", "api", "spend")],
)
async def test_pi_auth_kind_follows_the_provider(
    client,
    device_client,
    enrolled,
    db_session,
    provider,
    auth_kind,
    basis,
):
    await send(
        device_client,
        enrolled,
        [pi_message(provider=provider)],
        harness="pi_cli",
        session="pi-1",
        collection_method="plugin",
    )
    session = await session_named(db_session, "pi-1")
    assert session.auth_kind == auth_kind
    read = (await client.get(f"{SESSIONS}/{session.id}")).json()
    assert read["cost_basis"] == basis


async def test_a_zero_reported_cost_with_tokens_means_the_agent_had_no_price(
    device_client,
    enrolled,
    db_session,
):
    await send(
        device_client,
        enrolled,
        [pi_message(cost=0)],
        harness="pi_cli",
        session="pi-1",
        collection_method="plugin",
    )
    session = await session_named(db_session, "pi-1")
    [row] = await usage_rows(db_session, session.id)
    assert row.cost_reported_usd is None and row.cost_source == "estimated"
    assert session.cost_usd > 0


async def test_replays_and_duplicate_copies_never_count_twice(
    device_client,
    enrolled,
    db_session,
):
    token, mapping_id = enrolled
    records = [
        capture([codex_turn()], mapping_id, harness="codex_cli", session="thread-1")
    ]
    await upload(device_client, token, records)
    await upload(device_client, token, records)
    # The same observation inside a different capture.
    await send(
        device_client, enrolled, [codex_turn()], harness="codex_cli", session="thread-1"
    )
    session = await session_named(db_session, "thread-1")
    assert len(await usage_rows(db_session, session.id)) == 1
    single = estimate(
        "gpt-5.4", input_uncached=1000, cache_read=9000, output=500, reasoning=200
    )
    assert float(session.cost_usd) == pytest.approx(float(single), abs=1e-6)
    assert session.input_tokens == 1000


async def test_unknown_model_leaves_cost_unknown_and_incomplete(
    client,
    device_client,
    enrolled,
    db_session,
):
    await send(
        device_client,
        enrolled,
        [codex_turn(model="mystery-model-7")],
        harness="codex_cli",
        session="thread-1",
    )
    session = await session_named(db_session, "thread-1")
    [row] = await usage_rows(db_session, session.id)
    assert (row.pricing_status, row.cost_source) == ("unknown_model", "none")
    assert row.cost_estimated_usd is None
    assert session.cost_usd is None and session.unpriced_usage_count == 1
    read = (await client.get(f"{SESSIONS}/{session.id}")).json()
    assert read["cost_usd"] is None and read["cost_complete"] is False
    assert read["cost_basis"] is None


async def test_claude_hook_sessions_have_no_usage_and_unknown_auth(
    client,
    device_client,
    enrolled,
    db_session,
):
    token, mapping_id = enrolled
    await upload(
        device_client,
        token,
        [
            capture(
                FIXTURE_EVENTS,
                mapping_id,
                harness="claude_code",
                session="sc01-synthetic-session",
                collection_method="hook",
            )
        ],
    )
    session = await session_named(db_session, "sc01-synthetic-session")
    assert await usage_rows(db_session, session.id) == []
    read = (await client.get(f"{SESSIONS}/{session.id}")).json()
    assert read["auth_kind"] == "unknown"
    assert read["cost_usd"] is None and read["cost_source"] is None


async def test_metadata_mappings_still_price_usage(
    client,
    device_client,
    enrolled,
    db_session,
):
    _, mapping_id = enrolled
    await db_session.execute(
        update(CompanionProjectMapping)
        .where(CompanionProjectMapping.id == uuid.UUID(mapping_id))
        .values(content_level="metadata")
    )
    await send(
        device_client,
        enrolled,
        [codex_log("start", auth_mode="Chatgpt"), codex_turn()],
        harness="codex_cli",
        session="thread-1",
    )
    session = await session_named(db_session, "thread-1")
    assert session.auth_kind == "subscription" and session.cost_usd > 0


async def test_repricing_moves_rows_to_the_current_table(
    device_client,
    enrolled,
    db_session,
):
    await send(
        device_client, enrolled, [codex_turn()], harness="codex_cli", session="thread-1"
    )
    session = await session_named(db_session, "thread-1")
    await db_session.execute(
        update(AgentSessionUsage).values(
            price_table_version="stale", cost_estimated_usd=Decimal("9")
        )
    )
    await db_session.execute(
        update(AgentSession)
        .where(AgentSession.id == session.id)
        .values(cost_estimated_usd=Decimal("9"), cost_usd=Decimal("9"))
    )
    doubled = PriceTable(
        {
            "gpt-5.4": {
                "input_cost_per_token": 2e-06,
                "output_cost_per_token": 0,
                "cache_read_input_token_cost": 0,
            }
        },
        {},
        version="doubled",
    )
    assert await reprice_usage(db_session, doubled) == 1
    [row] = await usage_rows(db_session, session.id)
    session = await session_named(db_session, "thread-1")
    assert row.price_table_version == "doubled"
    assert row.cost_estimated_usd == pytest.approx(Decimal("0.002"))
    assert float(session.cost_estimated_usd) == pytest.approx(0.002)
    assert float(session.cost_usd) == pytest.approx(0.002)
    assert await reprice_usage(db_session, doubled) == 0


async def test_card_rollup_carries_both_costs_with_provenance(
    client,
    device_client,
    enrolled,
    db_session,
    test_board,
    test_card,
):
    token, mapping_id = enrolled
    events = [dict(event) for event in FIXTURE_EVENTS]
    await upload(
        device_client,
        token,
        [
            capture(
                events,
                mapping_id,
                harness="claude_code",
                session="sc01-synthetic-session",
                collection_method="hook",
            ),
            capture(
                [pi_message(session="sc01-synthetic-session")],
                mapping_id,
                harness="claude_code",
                session="sc01-synthetic-session",
                collection_method="hook",
            ),
        ],
    )
    invocation_id = uuid.uuid4()
    await work_under_invocation(client, test_board, test_card, invocation_id)
    await client.post("/api/me/mcp-invocations", json=outcome(invocation_id))
    summary = (
        await client.get(
            f"/api/workspaces/default/boards/{test_board.id}/cards/{test_card.id}/sessions"
        )
    ).json()["summary"]
    assert summary["session_count"] == 1
    assert summary["cost_usd"] == pytest.approx(0.004)
    assert summary["cost_reported_usd"] == pytest.approx(0.004)
    assert summary["cost_estimated_usd"] > 0
    assert summary["cost_source"] == "reported"
    assert summary["cost_basis"] == "api_equivalent"
    assert summary["cost_complete"] is True
    assert summary["reasoning_tokens"] == 0


async def test_usage_rows_count_matches_usage_events(
    device_client, enrolled, db_session
):
    await send(
        device_client,
        enrolled,
        [
            codex_turn("turn-1"),
            codex_turn("turn-2", timestamp="2026-09-24T02:21:30Z"),
            codex_log("sse-1"),
        ],
        harness="codex_cli",
        session="thread-1",
    )
    assert (
        await db_session.scalar(select(func.count()).select_from(AgentSessionUsage))
        == 2
    )


async def test_usage_breakdown_is_per_model_with_provenance(
    client,
    device_client,
    enrolled,
    db_session,
):
    await send(
        device_client,
        enrolled,
        [
            codex_log("start", auth_mode="Chatgpt"),
            codex_turn("turn-1"),
            codex_turn("turn-2", timestamp="2026-09-24T02:21:30Z"),
            codex_turn(
                "turn-3", model="mystery-model-7", timestamp="2026-09-24T02:21:31Z"
            ),
        ],
        harness="codex_cli",
        session="thread-1",
    )
    session = await session_named(db_session, "thread-1")
    response = await client.get(f"{SESSIONS}/{session.id}/usage")
    assert (
        response.status_code == 200 and response.headers["cache-control"] == "no-store"
    )
    body = response.json()
    assert body["price_table_version"] == current_price_table().version
    by_model = {item["model"]: item for item in body["items"]}
    assert set(by_model) == {"gpt-5.4", "mystery-model-7"}
    gpt = by_model["gpt-5.4"]
    assert gpt["usage_count"] == 2 and gpt["input_uncached_tokens"] == 2000
    assert gpt["reasoning_tokens"] == 400
    assert gpt["cost_source"] == "estimated" and gpt["cost_basis"] == "api_equivalent"
    assert gpt["auth_kind"] == "subscription"
    assert gpt["cost_usd"] == pytest.approx(float(session.cost_usd), abs=1e-6)
    mystery = by_model["mystery-model-7"]
    assert mystery["cost_usd"] is None and mystery["unpriced_usage_count"] == 1
    assert mystery["pricing_status"] == "unknown_model"
    assert (await client.get(f"{SESSIONS}/{uuid.uuid4()}/usage")).status_code == 404


async def test_digested_billing_facts_are_ignored(device_client, enrolled, db_session):
    # An older companion digests these at the metadata level; a digest is not
    # a provider, tier or auth mode.
    digest = "[omitted 7 bytes sha256:ffb34642447ff50f]"
    await send(
        device_client,
        enrolled,
        [
            codex_log(
                "start", auth_mode=digest, provider_name=digest, service_tier=digest
            ),
            codex_turn(),
        ],
        harness="codex_cli",
        session="thread-1",
    )
    session = await session_named(db_session, "thread-1")
    assert (session.provider, session.service_tier, session.auth_kind) == (
        None,
        None,
        None,
    )


def claude_usage(message_id="msg_01", request_id="req_01", **usage):
    """The contract a Claude Code usage event meets (see card CR-16)."""
    event_id = hashlib.sha256(
        f"claude_code:usage:{message_id}:{request_id}".encode()
    ).hexdigest()
    return beacon(
        event_id,
        "token.usage",
        "claude_code",
        "sc01-synthetic-session",
        collection_method="poll",
        model="claude-sonnet-4-5-20250929",
        gen_ai={
            "usage": {
                "input_tokens": 10,
                "cache_read": {"input_tokens": 20_000},
                "cache_creation": {
                    "input_tokens": 3000,
                    "ephemeral_1h_input_tokens": 1000,
                },
                "output_tokens": 400,
                "service_tier": usage.get("service_tier", "standard"),
            }
        },
    )


@pytest.mark.parametrize("content_level", ["metadata", "standard", "full"])
async def test_claude_usage_contract_is_priced_at_every_level(
    device_client, enrolled, db_session, content_level
):
    _, mapping_id = enrolled
    await db_session.execute(
        update(CompanionProjectMapping)
        .where(CompanionProjectMapping.id == uuid.UUID(mapping_id))
        .values(content_level=content_level)
    )
    events = [
        claude_usage(),
        claude_usage(service_tier="priority", request_id="req_02"),
    ]
    await send(
        device_client,
        enrolled,
        events + [claude_usage()],
        harness="claude_code",
        session="sc01-synthetic-session",
        collection_method="poll",
    )
    session = await session_named(db_session, "sc01-synthetic-session")
    rows = await usage_rows(db_session, session.id)
    assert len(rows) == 2
    standard, priority = sorted(rows, key=lambda row: row.service_tier)[::-1]
    assert (standard.cache_write_5m_tokens, standard.cache_write_1h_tokens) == (
        2000,
        1000,
    )
    assert standard.context_tokens == 10 + 20_000 + 3000
    assert (standard.service_tier, priority.service_tier) == ("standard", "priority")
    assert standard.auth_kind == "unknown" and standard.cost_source == "estimated"
    assert standard.cost_estimated_usd == pytest.approx(
        estimate(
            "claude-sonnet-4-5-20250929",
            input_uncached=10,
            cache_read=20_000,
            cache_write_5m=2000,
            cache_write_1h=1000,
            output=400,
            context_tokens=23_010,
        )
    )


@pytest.mark.parametrize("content_level", ["metadata", "standard", "full"])
async def test_claude_fast_mode_is_kept_on_the_row_for_repricing(
    device_client, enrolled, db_session, content_level
):
    # No price table has Claude fast-mode rates yet: the row is estimated at
    # standard rates and keeps its speed, so it can be repriced later.
    _, mapping_id = enrolled
    await db_session.execute(
        update(CompanionProjectMapping)
        .where(CompanionProjectMapping.id == uuid.UUID(mapping_id))
        .values(content_level=content_level)
    )
    fast = claude_usage()
    fast["gen_ai"]["usage"]["speed"] = "fast"
    await send(
        device_client,
        enrolled,
        [fast, claude_usage(request_id="req_02")],
        harness="claude_code",
        session="sc01-synthetic-session",
        collection_method="poll",
    )
    session = await session_named(db_session, "sc01-synthetic-session")
    rows = await usage_rows(db_session, session.id)
    by_speed = {row.speed: row for row in rows}
    assert set(by_speed) == {"fast", None}
    assert by_speed["fast"].service_tier == "standard"
    assert by_speed["fast"].pricing_status == "priced"
    assert by_speed["fast"].cost_estimated_usd == by_speed[None].cost_estimated_usd
    stored = await db_session.scalar(
        select(AgentSessionEvent.event).where(
            AgentSessionEvent.event_id == fast["event"]["id"]
        )
    )
    assert stored["gen_ai"]["usage"]["speed"] == "fast"


def with_output(event, output):
    event = copy.deepcopy(event)
    event["gen_ai"]["usage"]["output_tokens"] = output
    return event


async def test_a_later_larger_copy_of_a_request_upgrades_its_row(
    device_client, enrolled, db_session
):
    # A copy read while the response was streaming carries a partial output
    # count; the final copy replaces it, and nothing else ever does.
    partial = with_output(claude_usage(), 1)
    for event in (
        partial,
        with_output(partial, 900),
        with_output(partial, 900),
        partial,
    ):
        await send(
            device_client,
            enrolled,
            [event],
            harness="claude_code",
            session="sc01-synthetic-session",
            collection_method="poll",
        )
    session = await session_named(db_session, "sc01-synthetic-session")
    [row] = await usage_rows(db_session, session.id)
    assert row.output_tokens == 900
    expected = estimate(
        "claude-sonnet-4-5-20250929",
        input_uncached=10,
        cache_read=20_000,
        cache_write_5m=2000,
        cache_write_1h=1000,
        output=900,
        context_tokens=23_010,
    )
    assert row.cost_estimated_usd == pytest.approx(expected)
    assert float(session.cost_usd) == pytest.approx(float(expected), abs=1e-6)
    assert (session.output_tokens, session.input_tokens) == (900, 10)
    assert (session.cache_read_tokens, session.cache_creation_tokens) == (20_000, 3000)


@pytest.mark.parametrize(
    "provider, auth_kind",
    [
        ("openai", "api"),
        ("google", "api"),
        ("amazon-bedrock", "api"),
        ("openai-codex", "subscription"),
        ("github-copilot", "subscription"),
        ("google-gemini-cli", "subscription"),
        ("google-antigravity", "subscription"),
        ("opencode-go", "subscription"),
        ("qwen-token-plan-cn", "subscription"),
        ("anthropic", "unknown"),
        ("some-new-provider", "unknown"),
    ],
)
def test_pi_providers_are_api_only_when_known_to_take_only_api_keys(
    provider, auth_kind
):
    assert pi_auth_kind(provider) == auth_kind


async def test_cost_source_counts_rows_even_when_estimates_sum_to_zero(
    client, device_client, enrolled, db_session
):
    await send(
        device_client,
        enrolled,
        [claude_usage(), pi_message(session="sc01-synthetic-session")],
        harness="claude_code",
        session="sc01-synthetic-session",
        collection_method="poll",
    )
    free = PriceTable(
        {
            name: {"input_cost_per_token": 0, "output_cost_per_token": 0}
            for name in ("claude-sonnet-4-5-20250929", "claude-sonnet-4-5")
        },
        {},
        version="free",
    )
    await reprice_usage(db_session, free)
    session = await session_named(db_session, "sc01-synthetic-session")
    assert float(session.cost_usd) == pytest.approx(0.004)
    read = (await client.get(f"{SESSIONS}/{session.id}")).json()
    assert read["cost_source"] == "mixed"
    usage = (await client.get(f"{SESSIONS}/{session.id}/usage")).json()
    assert {item["cost_source"] for item in usage["items"]} == {"estimated", "reported"}


async def test_usage_breakdown_counts_rows_awaiting_a_reprice(
    client, device_client, enrolled, db_session
):
    await send(
        device_client,
        enrolled,
        [codex_turn("turn-1"), codex_turn("turn-2", timestamp="2026-09-24T02:21:30Z")],
        harness="codex_cli",
        session="thread-1",
    )
    session = await session_named(db_session, "thread-1")
    await db_session.execute(
        update(AgentSessionUsage)
        .where(AgentSessionUsage.event_id == "turn-1")
        .values(price_table_version="older")
    )
    [item] = (await client.get(f"{SESSIONS}/{session.id}/usage")).json()["items"]
    assert item["stale_usage_count"] == 1


async def test_repricing_takes_one_session_lock_per_transaction(
    device_client, enrolled, db_session
):
    for thread in ("thread-1", "thread-2"):
        await send(
            device_client,
            enrolled,
            [codex_turn(session=thread)],
            harness="codex_cli",
            session=thread,
        )
    await db_session.execute(
        update(AgentSessionUsage).values(price_table_version="stale")
    )
    # The management script commits after each call, so no transaction ever
    # holds more than one session row lock.
    assert await reprice_next_session(db_session) == 1
    versions = (
        await db_session.scalars(select(AgentSessionUsage.price_table_version))
    ).all()
    assert sorted(versions) == sorted([current_price_table().version, "stale"])
    assert await reprice_next_session(db_session) == 1
    assert await reprice_next_session(db_session) == 0


async def test_an_upgraded_row_keeps_cost_source_counts_right(
    client, device_client, enrolled, db_session
):
    # The partial copy had no reported cost (estimated); the final one reports
    # its cost, so the row, session and breakdown all become reported.
    partial = pi_message(cost=None, output=1)
    final = pi_message(cost=0.004, output=12)
    for event in (partial, final, final):
        await send(
            device_client,
            enrolled,
            [event],
            harness="pi_cli",
            session="pi-1",
            collection_method="plugin",
        )
    session = await session_named(db_session, "pi-1")
    [row] = await usage_rows(db_session, session.id)
    assert (row.output_tokens, row.cost_source) == (12, "reported")
    assert row.cost_reported_usd == pytest.approx(Decimal("0.004"))
    assert session.cost_source == "reported"
    assert float(session.cost_usd) == pytest.approx(0.004)
    read = (await client.get(f"{SESSIONS}/{session.id}")).json()
    assert read["cost_source"] == "reported"
    [item] = (await client.get(f"{SESSIONS}/{session.id}/usage")).json()["items"]
    assert item["cost_source"] == "reported" and item["usage_count"] == 1


async def test_only_unreported_single_request_rows_are_upgraded(
    device_client, enrolled, db_session
):
    # A reported cost is the agent's own figure for the tokens it counted;
    # and a turn that sums requests is never a partial copy of itself.
    await send(
        device_client,
        enrolled,
        [pi_message(cost=0.004, output=12)],
        harness="pi_cli",
        session="pi-1",
        collection_method="plugin",
    )
    await send(
        device_client,
        enrolled,
        [pi_message(cost=0.009, output=40)],
        harness="pi_cli",
        session="pi-1",
        collection_method="plugin",
    )
    await send(
        device_client,
        enrolled,
        [codex_turn(output=10)],
        harness="codex_cli",
        session="thread-1",
    )
    await send(
        device_client,
        enrolled,
        [codex_turn(output=500)],
        harness="codex_cli",
        session="thread-1",
    )
    [pi] = await usage_rows(db_session, (await session_named(db_session, "pi-1")).id)
    assert (pi.output_tokens, pi.cost_reported_usd) == (
        12,
        pytest.approx(Decimal("0.004")),
    )
    [codex] = await usage_rows(
        db_session, (await session_named(db_session, "thread-1")).id
    )
    assert codex.output_tokens == 10
