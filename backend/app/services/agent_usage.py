# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Usage rows, cost estimates and billing provenance for agent sessions.

Each stored event that reports token usage or a cost becomes one
agent_session_usage row; the session's cost columns are rollups of its rows.
Per row, the effective cost is the agent-reported cost when there is one,
otherwise our list-price estimate; both are kept. Cost under a subscription
is an API-equivalent value, never spend.

A new agent slots in by registering a `UsageAdapter` for its harness id; the
Beacon default already reads the canonical gen_ai.usage every harness gets.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Literal

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_session import AgentSession, AgentSessionUsage
from app.pricing import PriceTable, TokenUsage, current_price_table
from app.repositories.agent_session_usage import AgentSessionUsageRepository
from app.schemas.beacon import PromotedEvent

AuthKind = Literal["subscription", "api", "enterprise", "unknown"]
CostBasis = Literal["spend", "api_equivalent"]
CostSource = Literal["reported", "estimated", "mixed"]

# Only an API key (or an enterprise contract) is billed per token; any other
# cost is what the same usage would have cost at API list price.
SPEND_AUTH_KINDS = frozenset({"api", "enterprise"})
ROW_COST_PRECISION = Decimal("0.000000001")


def _dig(value, *path):
    for key in path:
        value = value.get(key) if isinstance(value, dict) else None
    return value


def _count(value) -> int:
    return (
        value
        if isinstance(value, int) and not isinstance(value, bool) and value > 0
        else 0
    )


# The companion's metadata level replaces text it does not know is
# structural with "[omitted <n> bytes sha256:<hash>]"; that is never a value.
_DIGEST_PREFIX = "[omitted "


def _text(value, limit: int) -> str | None:
    if not isinstance(value, str) or value.startswith(_DIGEST_PREFIX):
        return None
    return value.strip()[:limit] or None


def _speed(value) -> str | None:
    speed = _text(value, 16)
    return speed.lower() if speed else None


@dataclass(frozen=True)
class BillingHints:
    provider: str | None = None
    service_tier: str | None = None
    auth_kind: AuthKind | None = None


@dataclass(frozen=True)
class UsageReport:
    event_id: str
    occurred_at: datetime
    model: str | None
    tokens: TokenUsage
    cost_reported_usd: Decimal | None
    hints: BillingHints
    speed: str | None = None


class UsageAdapter:
    """Beacon's gen_ai.usage is already canonical for every harness:
    `input_tokens` is the uncached remainder, `cache_read` and
    `cache_creation` are disjoint from it, `reasoning.output_tokens` is part of
    `output_tokens`, and `cost_usd` is only ever what the runtime reported
    (Beacon never prices). Adapters add what a harness says elsewhere."""

    # Whether one usage event is one model request, whose prompt size then
    # selects long-context rates. False for sums across requests.
    single_request = False

    def hints(self, event: dict) -> BillingHints:
        tier = _text(_dig(event, "gen_ai", "usage", "service_tier"), 32)
        return BillingHints(
            provider=_text(_dig(event, "gen_ai", "provider", "name"), 64),
            service_tier=tier.lower() if tier else None,
        )

    def one_hour_cache_writes(self, event: dict) -> int:
        """The share of cache_creation written with 1-hour retention."""
        return _count(
            _dig(
                event, "gen_ai", "usage", "cache_creation", "ephemeral_1h_input_tokens"
            )
        )

    def report(self, event: dict, promoted: PromotedEvent) -> UsageReport | None:
        usage = _dig(event, "gen_ai", "usage")
        if not isinstance(usage, dict):
            return None
        uncached = _count(usage.get("input_tokens"))
        cache_read = _count(_dig(usage, "cache_read", "input_tokens"))
        cache_writes = _count(_dig(usage, "cache_creation", "input_tokens"))
        one_hour = min(self.one_hour_cache_writes(event), cache_writes)
        output = _count(usage.get("output_tokens"))
        tokens = TokenUsage(
            input_uncached=uncached,
            cache_read=cache_read,
            cache_write_5m=cache_writes - one_hour,
            cache_write_1h=one_hour,
            output=output,
            reasoning=min(_count(_dig(usage, "reasoning", "output_tokens")), output),
            context_tokens=uncached + cache_read + cache_writes
            if self.single_request
            else None,
        )
        reported = promoted.cost_usd
        # Runtimes that price from their own model registry report 0 for a
        # model they have no price for; with tokens spent that is "unknown".
        if reported is not None and reported == 0 and tokens.total > 0:
            reported = None
        if tokens.total == 0 and not reported:
            return None
        return UsageReport(
            event_id=promoted.event_id,
            occurred_at=promoted.occurred_at,
            model=promoted.model,
            tokens=tokens,
            cost_reported_usd=reported,
            hints=self.hints(event),
            speed=_speed(usage.get("speed")),
        )


# Codex's OTel `auth_mode` (codex-rs/otel TelemetryAuthMode, Display of the
# variant): ChatGPT sign-in, including Business and Enterprise seats, is a
# plan; an API key is billed per token. The plan type that would separate
# Enterprise only exists in Codex's rollout files, which are not captured.
_CODEX_AUTH_MODES: dict[str, AuthKind] = {
    "chatgpt": "subscription",
    "chatgptauthtokens": "subscription",
    "apikey": "api",
    "api_key": "api",
}


class CodexUsage(UsageAdapter):
    """Usage arrives on the completed-turn span (a per-turn sum, so no
    long-context tier); plan, tier and provider arrive on the log events."""

    def hints(self, event: dict) -> BillingHints:
        attributes = _dig(event, "raw", "attributes") or {}
        auth_mode = _text(attributes.get("auth_mode"), 32)
        tier = _text(attributes.get("service_tier"), 32)
        return BillingHints(
            provider=_text(attributes.get("provider_name"), 64)
            or super().hints(event).provider,
            service_tier=tier.lower() if tier else None,
            auth_kind=_CODEX_AUTH_MODES.get(auth_mode.lower()) if auth_mode else None,
        )


# Pi provider ids (pi-mono packages/ai/src/providers at d6af72e, plus the
# Google logins of earlier Pi releases). Plan logins with no API-key mode:
_PI_SUBSCRIPTION_PROVIDERS = frozenset(
    {
        "openai-codex",
        "github-copilot",
        "kimi-coding",
        "zai-coding-cn",
        "opencode-go",
        "google-gemini-cli",
        "google-antigravity",
    }
)
# Providers that take only an API key (no OAuth module in pi-mono), so their
# usage is billed per token. Anything not listed, including providers that
# accept either a key or a login (anthropic, xai, openrouter, meta, radius),
# stays unknown: never presented as spend on a guess.
_PI_API_KEY_PROVIDERS = frozenset(
    {
        "amazon-bedrock",
        "azure-openai-responses",
        "baseten",
        "cerebras",
        "cloudflare-ai-gateway",
        "cloudflare-workers-ai",
        "deepseek",
        "fireworks",
        "google",
        "google-vertex",
        "groq",
        "huggingface",
        "minimax",
        "minimax-cn",
        "mistral",
        "moonshotai",
        "moonshotai-cn",
        "nvidia",
        "openai",
        "opencode",
        "together",
        "vercel-ai-gateway",
        "xiaomi",
        "zai",
    }
)


def pi_auth_kind(provider: str) -> AuthKind:
    provider = provider.lower()
    if provider in _PI_SUBSCRIPTION_PROVIDERS or "token-plan" in provider:
        return "subscription"
    if provider in _PI_API_KEY_PROVIDERS:
        return "api"
    return "unknown"


class PiUsage(UsageAdapter):
    """One `message_end` is one assistant response. Pi's own usage object
    rides along under raw.pi: its cacheWrite1h is the 1-hour share of
    cacheWrite, which Beacon's gen_ai.usage does not carry."""

    single_request = True

    def hints(self, event: dict) -> BillingHints:
        message = _dig(event, "raw", "pi", "message") or {}
        provider = _text(message.get("provider"), 64)
        if provider is None:
            qualified = _text(_dig(event, "raw", "pi", "model"), 200) or ""
            provider = _text(qualified.rpartition("/")[0], 64)
        return BillingHints(
            provider=provider,
            auth_kind=pi_auth_kind(provider) if provider else None,
        )

    def one_hour_cache_writes(self, event: dict) -> int:
        return _count(_dig(event, "raw", "pi", "message", "usage", "cacheWrite1h"))


class ClaudeCodeUsage(UsageAdapter):
    """Claude Code reports usage per API request. Nothing it emits says
    whether a Pro/Max login or an API key paid, so auth stays unknown."""

    single_request = True


USAGE_ADAPTERS: dict[str, UsageAdapter] = {
    "claude_code": ClaudeCodeUsage(),
    "codex_cli": CodexUsage(),
    "codex_desktop": CodexUsage(),
    "pi_cli": PiUsage(),
}


def usage_adapter(harness: str) -> UsageAdapter:
    return USAGE_ADAPTERS.get(harness, UsageAdapter())


def _priced(row: dict, prices: PriceTable) -> dict:
    """Row values with the estimate, effective source and table version."""
    quote = prices.quote(
        model=row["model"],
        provider=row["provider"],
        service_tier=row["service_tier"],
        usage=TokenUsage(
            input_uncached=row["input_uncached_tokens"],
            cache_read=row["cache_read_tokens"],
            cache_write_5m=row["cache_write_5m_tokens"],
            cache_write_1h=row["cache_write_1h_tokens"],
            output=row["output_tokens"],
            reasoning=row["reasoning_tokens"],
            context_tokens=row["context_tokens"],
        ),
    )
    estimated = (
        quote.cost_usd.quantize(ROW_COST_PRECISION)
        if quote.cost_usd is not None
        else None
    )
    if row["cost_reported_usd"] is not None:
        source = "reported"
    elif estimated is not None:
        source = "estimated"
    else:
        source = "none"
    return {
        **row,
        "cost_estimated_usd": estimated,
        "cost_source": source,
        "pricing_status": quote.status,
        "pricing_model": quote.pricing_model,
        "price_table_version": quote.table_version,
    }


_ROW_PRICING_INPUTS = (
    "model",
    "provider",
    "service_tier",
    "input_uncached_tokens",
    "cache_read_tokens",
    "cache_write_5m_tokens",
    "cache_write_1h_tokens",
    "output_tokens",
    "reasoning_tokens",
    "context_tokens",
    "cost_reported_usd",
)


def _row_total(row: AgentSessionUsage) -> int:
    return (
        row.input_uncached_tokens
        + row.cache_read_tokens
        + row.cache_write_5m_tokens
        + row.cache_write_1h_tokens
        + row.output_tokens
    )


def _reprice_row(row: AgentSessionUsage, prices: PriceTable) -> None:
    priced = _priced({name: getattr(row, name) for name in _ROW_PRICING_INPUTS}, prices)
    for name in (
        "cost_estimated_usd",
        "cost_source",
        "pricing_status",
        "pricing_model",
        "price_table_version",
    ):
        setattr(row, name, priced[name])


class AgentUsageService:
    def __init__(self, db: AsyncSession, prices: PriceTable | None = None):
        self.db = db
        self.prices = prices or current_price_table()
        self.usage = AgentSessionUsageRepository(db)

    async def record(
        self,
        session: AgentSession,
        events: list[tuple[dict, PromotedEvent]],
    ) -> None:
        """Absorb billing hints and store usage rows for newly stored events,
        then refresh the session's cost rollups."""
        adapter = usage_adapter(session.harness)
        ordered = sorted(events, key=lambda pair: pair[1].occurred_at)
        hints_changed = self._absorb_hints(
            session, [adapter.hints(raw) for raw, _ in ordered]
        )
        rows = [
            self._row(session, report)
            for raw, promoted in ordered
            if (report := adapter.report(raw, promoted)) is not None
        ]
        await self.usage.insert_new(rows)
        if hints_changed:
            for row in await self.usage.missing_session_hints(session):
                row.provider = row.provider or session.provider
                row.service_tier = row.service_tier or session.service_tier
                if row.auth_kind == "unknown" and session.auth_kind:
                    row.auth_kind = session.auth_kind
                _reprice_row(row, self.prices)
            await self.db.flush()
        if rows or hints_changed:
            await self.refresh_rollups(session)

    async def upgrade(
        self,
        session: AgentSession,
        events: list[tuple[dict, PromotedEvent]],
    ) -> bool:
        """Replace the usage of already stored events whose new copy counts
        more tokens: a copy read while a response streamed carries a partial
        output count. Equal or smaller copies are replays and change nothing.
        Only a single request can be caught mid-stream, and a row with a
        reported cost keeps the agent's own figure. Returns whether any row
        changed."""
        adapter = usage_adapter(session.harness)
        if not adapter.single_request:
            return False
        reports = {
            promoted.event_id: report
            for raw, promoted in events
            if (report := adapter.report(raw, promoted)) is not None
        }
        upgraded = False
        for row in await self.usage.for_events(session.id, list(reports)):
            report = reports[row.event_id]
            tokens = report.tokens
            if row.cost_reported_usd is not None or tokens.total <= _row_total(row):
                continue
            session.input_tokens += tokens.input_uncached - row.input_uncached_tokens
            session.output_tokens += tokens.output - row.output_tokens
            session.cache_read_tokens += tokens.cache_read - row.cache_read_tokens
            session.cache_creation_tokens += (
                tokens.cache_write_5m + tokens.cache_write_1h
            ) - (row.cache_write_5m_tokens + row.cache_write_1h_tokens)
            row.input_uncached_tokens = tokens.input_uncached
            row.cache_read_tokens = tokens.cache_read
            row.cache_write_5m_tokens = tokens.cache_write_5m
            row.cache_write_1h_tokens = tokens.cache_write_1h
            row.output_tokens = tokens.output
            row.reasoning_tokens = tokens.reasoning
            row.context_tokens = tokens.context_tokens
            # The final copy's reported cost, if any; repricing then sets the
            # row's cost source from it.
            row.cost_reported_usd = report.cost_reported_usd
            _reprice_row(row, self.prices)
            upgraded = True
        if upgraded:
            await self.db.flush()
            await self.refresh_rollups(session)
        return upgraded

    @staticmethod
    def _absorb_hints(session: AgentSession, hints: list[BillingHints]) -> bool:
        """The session keeps the latest provider, tier and auth kind any of
        its events stated. Returns whether any changed."""
        before = (session.provider, session.service_tier, session.auth_kind)
        for hint in hints:
            session.provider = hint.provider or session.provider
            session.service_tier = hint.service_tier or session.service_tier
            session.auth_kind = hint.auth_kind or session.auth_kind
        return before != (session.provider, session.service_tier, session.auth_kind)

    def _row(self, session: AgentSession, report: UsageReport) -> dict:
        tokens = report.tokens
        return _priced(
            {
                "id": uuid.uuid4(),
                "session_id": session.id,
                "event_id": report.event_id,
                "occurred_at": report.occurred_at,
                "model": report.model or session.model,
                "provider": report.hints.provider or session.provider,
                "service_tier": report.hints.service_tier or session.service_tier,
                "speed": report.speed,
                "auth_kind": report.hints.auth_kind or session.auth_kind or "unknown",
                "input_uncached_tokens": tokens.input_uncached,
                "cache_read_tokens": tokens.cache_read,
                "cache_write_5m_tokens": tokens.cache_write_5m,
                "cache_write_1h_tokens": tokens.cache_write_1h,
                "output_tokens": tokens.output,
                "reasoning_tokens": tokens.reasoning,
                "context_tokens": tokens.context_tokens,
                "cost_reported_usd": report.cost_reported_usd,
            },
            self.prices,
        )

    async def refresh_rollups(self, session: AgentSession) -> None:
        totals = await self.usage.totals(session.id)
        session.cost_reported_usd = totals.cost_reported_usd
        session.cost_estimated_usd = totals.cost_estimated_usd
        session.cost_usd = totals.cost_usd
        session.unpriced_usage_count = totals.unpriced_usage_count
        session.reasoning_tokens = totals.reasoning_tokens
        session.cost_source = cost_source(totals.reported_count, totals.estimated_count)
        await self.db.flush()


async def reprice_next_session(
    db: AsyncSession, prices: PriceTable | None = None
) -> int:
    """Re-estimate the usage rows of one session priced under another table
    version and refresh its rollups. Returns the rows repriced, 0 when none
    are left. It takes a single session lock, so a caller that commits after
    each call can never deadlock with ingest."""
    service = AgentUsageService(db, prices)
    version = service.prices.version
    session_id = await service.usage.a_session_priced_under_another_version(version)
    if session_id is None:
        return 0
    session = await service.usage.lock_session(session_id)
    rows = await service.usage.rows_priced_under_other_versions(session_id, version)
    for row in rows:
        _reprice_row(row, service.prices)
    await db.flush()
    await service.refresh_rollups(session)
    return len(rows)


async def reprice_usage(db: AsyncSession, prices: PriceTable | None = None) -> int:
    """Reprice every stale session inside the caller's one transaction; for
    small tables and tests. Safe to rerun: a second pass finds nothing."""
    repriced = 0
    while count := await reprice_next_session(db, prices):
        repriced += count
    return repriced


def cost_basis(auth_kind: str | None) -> CostBasis:
    return "spend" if auth_kind in SPEND_AUTH_KINDS else "api_equivalent"


def cost_source(reported_rows: int, estimated_rows: int) -> CostSource | None:
    """Where an effective cost came from, by the rows whose effective cost
    was reported or estimated: all of one kind, or mixed."""
    if reported_rows and estimated_rows:
        return "mixed"
    if reported_rows:
        return "reported"
    return "estimated" if estimated_rows else None


def _money(value: Decimal | None) -> float | None:
    return float(value) if value is not None else None


def session_cost_fields(session: AgentSession) -> dict:
    """The cost and billing fields of a session read."""
    return {
        "reasoning_tokens": session.reasoning_tokens or 0,
        "cost_usd": _money(session.cost_usd),
        "cost_reported_usd": _money(session.cost_reported_usd),
        "cost_estimated_usd": _money(session.cost_estimated_usd),
        "cost_source": session.cost_source,
        "cost_basis": cost_basis(session.auth_kind)
        if session.cost_usd is not None
        else None,
        "cost_complete": session.cost_usd is not None
        and not session.unpriced_usage_count,
        "auth_kind": session.auth_kind or "unknown",
        "provider": session.provider,
        "service_tier": session.service_tier,
    }


def model_usage_fields(group) -> dict:
    reported = _decimal_or_none(group.cost_reported_usd)
    effective = _decimal_or_none(group.cost_usd)
    return {
        "model": group.model,
        "provider": group.provider,
        "service_tier": group.service_tier,
        "auth_kind": group.auth_kind,
        "pricing_status": group.pricing_status,
        "usage_count": group.usage_count,
        "input_uncached_tokens": group.input_uncached_tokens or 0,
        "cache_read_tokens": group.cache_read_tokens or 0,
        "cache_write_5m_tokens": group.cache_write_5m_tokens or 0,
        "cache_write_1h_tokens": group.cache_write_1h_tokens or 0,
        "output_tokens": group.output_tokens or 0,
        "reasoning_tokens": group.reasoning_tokens or 0,
        "cost_usd": _money(effective),
        "cost_reported_usd": _money(reported),
        "cost_estimated_usd": _money(_decimal_or_none(group.cost_estimated_usd)),
        "cost_source": cost_source(group.reported_count, group.estimated_count),
        "cost_basis": cost_basis(group.auth_kind) if effective is not None else None,
        "unpriced_usage_count": int(group.unpriced_usage_count or 0),
        "stale_usage_count": int(group.stale_usage_count or 0),
    }


def _decimal_or_none(value) -> Decimal | None:
    return None if value is None else Decimal(str(value))


def _sum(values: list[Decimal | None]) -> Decimal | None:
    known = [value for value in values if value is not None]
    return sum(known, Decimal(0)) if known else None


def _combined_source(sources: set[str | None]) -> CostSource | None:
    known = sources - {None}
    if not known:
        return None
    return known.pop() if len(known) == 1 else "mixed"


def linked_cost_fields(sessions: list[AgentSession]) -> dict:
    """Cost rollup across the sessions linked to one card or note."""
    effective = _sum([session.cost_usd for session in sessions])
    reported = _sum([session.cost_reported_usd for session in sessions])
    bases = {cost_basis(s.auth_kind) for s in sessions if s.cost_usd is not None}
    return {
        "reasoning_tokens": sum(session.reasoning_tokens or 0 for session in sessions),
        "cost_usd": _money(effective),
        "cost_reported_usd": _money(reported),
        "cost_estimated_usd": _money(_sum([s.cost_estimated_usd for s in sessions])),
        "cost_source": _combined_source({s.cost_source for s in sessions}),
        "cost_basis": bases.pop() if len(bases) == 1 else ("mixed" if bases else None),
        "cost_complete": bool(sessions)
        and all(
            s.cost_usd is not None and not s.unpriced_usage_count for s in sessions
        ),
    }
