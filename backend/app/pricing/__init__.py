# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""API list-price estimates for agent token usage.

Rates come from vendored, pinned snapshots (see data/manifest.json and
scripts/refresh_price_tables.py): LiteLLM's model_prices_and_context_window.json
first, models.dev as the fallback, both MIT. The semantics follow ccusage.
A model neither table knows is never priced at 0: it is reported unpriced.
"""

import json
import re
from dataclasses import dataclass
from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Literal

DATA_DIR = Path(__file__).parent / "data"

PricingStatus = Literal["priced", "unknown_model", "no_model", "no_tokens"]
PriceSource = Literal["litellm", "models_dev"]

# Anthropic bills a 1-hour cache write at twice the base input rate (a 5-minute
# write is 1.25x, which the tables carry). Used when a table has no 1h rate.
ONE_HOUR_CACHE_WRITE_INPUT_MULTIPLIER = Decimal(2)
_PER_MILLION = Decimal(1_000_000)

# LiteLLM long-context keys name their threshold: `input_cost_per_token_above_272k_tokens`.
_LONG_CONTEXT_KEY = re.compile(r"_above_(\d+)k_tokens")
# Claude Code tags the 1M-context variant as `claude-sonnet-4-5[1m]`.
_CONTEXT_TAG = re.compile(r"\[[^\]]*\]$")
# Release dates on model ids: `-20250929`, `-2026-03-05`, Vertex's `@20250929`.
_DATE_SUFFIX = re.compile(r"[-@](\d{8}|\d{4}-\d{2}-\d{2})$")

_SERVICE_TIERS = {
    "priority": "priority",
    # Codex's config spelling of the priority tier.
    "fast": "priority",
    "flex": "flex",
    "batch": "batches",
    "batches": "batches",
}

# models.dev provider ids searched, in order, when a usage event names no
# provider: first-party vendors before resellers, whose prices differ.
_FIRST_PARTY_PROVIDERS = ("anthropic", "openai", "google", "xai", "deepseek", "mistral")


@dataclass(frozen=True)
class TokenUsage:
    """Disjoint token buckets of one usage event, except `reasoning`, which is
    the part of `output` spent thinking. `context_tokens` is one request's
    prompt size; it selects long-context rates and is None when the event sums
    several requests."""

    input_uncached: int = 0
    cache_read: int = 0
    cache_write_5m: int = 0
    cache_write_1h: int = 0
    output: int = 0
    reasoning: int = 0
    context_tokens: int | None = None

    @property
    def total(self) -> int:
        return (
            self.input_uncached
            + self.cache_read
            + self.cache_write_5m
            + self.cache_write_1h
            + self.output
        )


@dataclass(frozen=True)
class PriceQuote:
    status: PricingStatus
    cost_usd: Decimal | None
    pricing_model: str | None
    source: PriceSource | None
    table_version: str


@dataclass(frozen=True)
class _Rates:
    """Per-token USD rates for one model, keyed like LiteLLM's base keys:
    input_cost_per_token, cache_read_input_token_cost, ..."""

    key: str
    source: PriceSource
    rates: dict[str, Decimal]
    # Lowest prompt size above which the `*<long_context_suffix>` rates apply.
    long_context_threshold: int | None = None
    long_context_suffix: str | None = None


def _decimal(value) -> Decimal:
    return Decimal(str(value))


def _litellm_rates(key: str, entry: dict) -> _Rates:
    rates = {
        name: _decimal(value)
        for name, value in entry.items()
        if isinstance(value, (int, float)) and "cost" in name
    }
    # LiteLLM's "200k" is 200,000 tokens. With several thresholds the lowest
    # wins, as in ccusage.
    thousands = min(
        (
            int(match.group(1))
            for name in rates
            if (match := _LONG_CONTEXT_KEY.search(name))
        ),
        default=None,
    )
    if thousands is None:
        return _Rates(key, "litellm", rates)
    return _Rates(
        key, "litellm", rates, thousands * 1000, f"_above_{thousands}k_tokens"
    )


def _models_dev_rates(key: str, cost: dict) -> _Rates:
    """models.dev prices per million tokens; translated to LiteLLM's per-token
    key names so one pricing function serves both tables."""
    names = {
        "input": "input_cost_per_token",
        "output": "output_cost_per_token",
        "cache_read": "cache_read_input_token_cost",
        "cache_write": "cache_creation_input_token_cost",
        "reasoning": "output_cost_per_reasoning_token",
    }
    rates = {
        names[name]: _decimal(value) / _PER_MILLION
        for name, value in cost.items()
        if name in names and isinstance(value, (int, float))
    }
    context_tiers = [
        tier
        for tier in cost.get("tiers") or []
        if isinstance(tier, dict)
        and (tier.get("tier") or {}).get("type") == "context"
        and isinstance((tier.get("tier") or {}).get("size"), int)
    ]
    if not context_tiers:
        return _Rates(key, "models_dev", rates)
    lowest = min(context_tiers, key=lambda tier: tier["tier"]["size"])
    suffix = "_above_context_tier"
    for name, value in lowest.items():
        if name in names and isinstance(value, (int, float)):
            rates[names[name] + suffix] = _decimal(value) / _PER_MILLION
    return _Rates(key, "models_dev", rates, lowest["tier"]["size"], suffix)


def _model_names(model: str) -> list[str]:
    """Spellings of a model id to look up, most specific first.

    Lowercased and trimmed; Claude Code's `[1m]` context tag dropped; a
    Vertex `@date` spelled as `-date`; then the id without its release date,
    so a dated snapshot the table lacks prices as its undated alias.
    """
    name = _CONTEXT_TAG.sub("", model.strip().lower()).strip()
    names = [name]
    if "@" in name:
        names.append(name.replace("@", "-"))
    undated = _DATE_SUFFIX.sub("", name)
    if undated != name:
        names.append(undated)
    return list(dict.fromkeys(names))


class PriceTable:
    def __init__(self, litellm: dict, models_dev: dict, *, version: str):
        self.version = version
        self._litellm = {
            key.lower(): entry
            for key, entry in litellm.items()
            if isinstance(entry, dict) and "input_cost_per_token" in entry
        }
        self._models_dev = {
            provider.lower(): {
                model_id.lower(): model["cost"]
                for model_id, model in (body.get("models") or {}).items()
                if isinstance(model, dict) and isinstance(model.get("cost"), dict)
            }
            for provider, body in models_dev.items()
            if isinstance(body, dict)
        }

    def quote(
        self,
        *,
        model: str | None,
        provider: str | None,
        service_tier: str | None,
        usage: TokenUsage,
    ) -> PriceQuote:
        if usage.total <= 0:
            return self._unpriced("no_tokens")
        if not model or not model.strip():
            return self._unpriced("no_model")
        rates = self._lookup(model, provider)
        if rates is None:
            return self._unpriced("unknown_model")
        return PriceQuote(
            status="priced",
            cost_usd=_cost(
                rates, _SERVICE_TIERS.get((service_tier or "").lower()), usage
            ),
            pricing_model=rates.key,
            source=rates.source,
            table_version=self.version,
        )

    def _unpriced(self, status: PricingStatus) -> PriceQuote:
        return PriceQuote(status, None, None, None, self.version)

    def _lookup(self, model: str, provider: str | None) -> _Rates | None:
        """LiteLLM by exact id, then without the `vendor/` prefix routers and
        Pi add; then models.dev under the named (or prefixed) provider, then
        under the first-party vendors. No fuzzy matching: a near miss would
        price one model at another's rates."""
        prefix, _, bare = model.strip().rpartition("/")
        spellings = _model_names(model) + (_model_names(bare) if prefix else [])
        for name in spellings:
            if name in self._litellm:
                return _litellm_rates(name, self._litellm[name])
        providers = [
            candidate.lower()
            for candidate in (provider, prefix.split("/")[-1] if prefix else None)
            if candidate
        ] + list(_FIRST_PARTY_PROVIDERS)
        for provider_id in dict.fromkeys(providers):
            models = self._models_dev.get(provider_id, {})
            for name in _model_names(bare if prefix else model):
                if name in models:
                    return _models_dev_rates(f"{provider_id}/{name}", models[name])
        return None


def _cost(rates: _Rates, tier: str | None, usage: TokenUsage) -> Decimal:
    """Each bucket at its own rate. Above the long-context threshold the whole
    request moves to the long-context rates (Anthropic and OpenAI bill the
    entire request, not the marginal tokens), which needs one request's
    prompt size: summed usage keeps base rates. A rate missing for the tier
    falls back to the standard rate; a missing cache rate to the input rate."""
    long_suffix = None
    if (
        rates.long_context_threshold is not None
        and usage.context_tokens is not None
        and usage.context_tokens > rates.long_context_threshold
    ):
        long_suffix = rates.long_context_suffix

    def rate(base_key: str) -> Decimal | None:
        table = rates.rates
        base = table.get(base_key)
        long = table.get(base_key + long_suffix) if long_suffix else None
        tiered = table.get(f"{base_key}_{tier}") if tier else None
        if long_suffix and tier and f"{base_key}{long_suffix}_{tier}" in table:
            return table[f"{base_key}{long_suffix}_{tier}"]
        if long is not None and tiered is not None:
            # No combined long-context tier rate: apply the tier's ratio to
            # the long-context rate, so it never undercuts the tier alone.
            return long * tiered / base if base else max(long, tiered)
        return next(
            (value for value in (long, tiered, base) if value is not None), None
        )

    input_rate = rate("input_cost_per_token") or Decimal(0)
    output_rate = rate("output_cost_per_token") or Decimal(0)
    cache_read_rate = rate("cache_read_input_token_cost")
    cache_write_rate = rate("cache_creation_input_token_cost")
    one_hour_rate = rate("cache_creation_input_token_cost_above_1hr")
    reasoning_rate = rate("output_cost_per_reasoning_token")

    reasoning = min(usage.reasoning, usage.output) if reasoning_rate is not None else 0
    return (
        usage.input_uncached * input_rate
        + usage.cache_read
        * (input_rate if cache_read_rate is None else cache_read_rate)
        + usage.cache_write_5m
        * (input_rate if cache_write_rate is None else cache_write_rate)
        + usage.cache_write_1h
        * (
            input_rate * ONE_HOUR_CACHE_WRITE_INPUT_MULTIPLIER
            if one_hour_rate is None
            else one_hour_rate
        )
        + (usage.output - reasoning) * output_rate
        + reasoning * (reasoning_rate or Decimal(0))
    )


@lru_cache(maxsize=1)
def current_price_table() -> PriceTable:
    manifest = json.loads((DATA_DIR / "manifest.json").read_text())
    return PriceTable(
        json.loads((DATA_DIR / manifest["litellm"]["file"]).read_text()),
        json.loads((DATA_DIR / manifest["models_dev"]["file"]).read_text()),
        version=manifest["version"],
    )
