# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
from decimal import Decimal
from pathlib import Path

import pytest

from app.pricing import PriceTable, TokenUsage, current_price_table

SONNET = {
    "litellm_provider": "anthropic",
    "input_cost_per_token": 3e-06,
    "output_cost_per_token": 1.5e-05,
    "cache_read_input_token_cost": 3e-07,
    "cache_creation_input_token_cost": 3.75e-06,
    "cache_creation_input_token_cost_above_1hr": 6e-06,
    "input_cost_per_token_above_200k_tokens": 6e-06,
    "output_cost_per_token_above_200k_tokens": 2.25e-05,
    "cache_read_input_token_cost_above_200k_tokens": 6e-07,
    "cache_creation_input_token_cost_above_200k_tokens": 7.5e-06,
    "cache_creation_input_token_cost_above_1hr_above_200k_tokens": 1.2e-05,
}
GPT = {
    "litellm_provider": "openai",
    "input_cost_per_token": 2.5e-06,
    "output_cost_per_token": 1.5e-05,
    "cache_read_input_token_cost": 2.5e-07,
    "input_cost_per_token_priority": 5e-06,
    "output_cost_per_token_priority": 3e-05,
    "cache_read_input_token_cost_priority": 5e-07,
    "input_cost_per_token_above_272k_tokens": 5e-06,
    "output_cost_per_token_above_272k_tokens": 2.25e-05,
    "input_cost_per_token_above_272k_tokens_priority": 1e-05,
}
LITELLM = {
    "claude-sonnet-4-5": SONNET,
    "claude-sonnet-4-5-20250929": SONNET,
    "gpt-5.4": GPT,
    "thinker-1": {
        "litellm_provider": "openai",
        "input_cost_per_token": 1e-06,
        "output_cost_per_token": 4e-06,
        "output_cost_per_reasoning_token": 2e-06,
    },
    "bare-1": {
        "litellm_provider": "openai",
        "input_cost_per_token": 1e-06,
        "output_cost_per_token": 2e-06,
    },
}
MODELS_DEV = {
    "zai": {
        "models": {
            "glm-9": {
                "cost": {
                    "input": 1,
                    "output": 4,
                    "cache_read": 0.1,
                    "tiers": [
                        {
                            "input": 2,
                            "output": 8,
                            "cache_read": 0.2,
                            "tier": {"type": "context", "size": 128000},
                        }
                    ],
                }
            }
        }
    },
    "anthropic": {
        "models": {"claude-sonnet-4-5": {"cost": {"input": 99, "output": 99}}}
    },
}


@pytest.fixture
def table():
    return PriceTable(LITELLM, MODELS_DEV, version="test-v1")


def usage(**buckets) -> TokenUsage:
    return TokenUsage(**buckets)


def quote(table, model, provider=None, service_tier=None, **buckets):
    return table.quote(
        model=model,
        provider=provider,
        service_tier=service_tier,
        usage=usage(**buckets),
    )


def test_every_bucket_is_priced_at_its_own_rate(table):
    priced = quote(
        table,
        "claude-sonnet-4-5",
        input_uncached=1000,
        cache_read=10_000,
        cache_write_5m=2000,
        cache_write_1h=1000,
        output=500,
    )
    # 1000*3e-6 + 10000*3e-7 + 2000*3.75e-6 + 1000*6e-6 + 500*1.5e-5
    assert priced.status == "priced"
    assert priced.cost_usd == Decimal("0.027")
    assert (priced.pricing_model, priced.source) == ("claude-sonnet-4-5", "litellm")
    assert priced.table_version == "test-v1"


def test_reasoning_is_part_of_output_and_never_priced_twice(table):
    without = quote(table, "bare-1", output=500)
    with_reasoning = quote(table, "bare-1", output=500, reasoning=200)
    assert with_reasoning.cost_usd == without.cost_usd == Decimal("0.001")


def test_a_reasoning_rate_prices_only_the_reasoning_share_of_output(table):
    priced = quote(table, "thinker-1", output=500, reasoning=200)
    # 300 visible output at 4e-6 + 200 reasoning at 2e-6
    assert priced.cost_usd == Decimal("0.0016")


def test_long_context_rates_apply_to_the_whole_request_above_the_threshold(table):
    buckets = dict(input_uncached=1000, cache_read=249_000, output=100)
    short = quote(table, "claude-sonnet-4-5", **buckets)
    long = quote(table, "claude-sonnet-4-5", context_tokens=250_000, **buckets)
    assert short.cost_usd == Decimal("0.0792")  # 1000*3e-6 + 249000*3e-7 + 100*1.5e-5
    assert long.cost_usd == Decimal("0.15765")  # 1000*6e-6 + 249000*6e-7 + 100*2.25e-5


def test_long_context_tier_is_skipped_when_the_request_size_is_unknown(table):
    # A per-turn total spans several requests, so its sum says nothing about
    # any single request's prompt size.
    priced = quote(table, "gpt-5.4", input_uncached=400_000)
    assert priced.cost_usd == Decimal("1.0")


def test_threshold_is_read_from_the_key(table):
    at = quote(table, "gpt-5.4", input_uncached=272_000, context_tokens=272_000)
    above = quote(table, "gpt-5.4", input_uncached=272_001, context_tokens=272_001)
    assert at.cost_usd == Decimal("0.68")
    assert above.cost_usd == Decimal("272001") * Decimal("0.000005")


@pytest.mark.parametrize("tier", ["priority", "fast", "Priority"])
def test_priority_service_tier_uses_priority_rates(table, tier):
    priced = quote(table, "gpt-5.4", service_tier=tier, input_uncached=1000, output=100)
    assert priced.cost_usd == Decimal("0.008")  # 1000*5e-6 + 100*3e-5


def test_long_context_priority_prefers_the_combined_key(table):
    priced = quote(
        table,
        "gpt-5.4",
        service_tier="priority",
        input_uncached=300_000,
        context_tokens=300_000,
    )
    assert priced.cost_usd == Decimal("3.0")


@pytest.mark.parametrize("tier", [None, "default", "standard", "auto", "on_demand"])
def test_standard_tiers_use_base_rates(table, tier):
    priced = quote(table, "gpt-5.4", service_tier=tier, input_uncached=1000)
    assert priced.cost_usd == Decimal("0.0025")


def test_a_tier_without_rates_falls_back_to_the_standard_rate(table):
    priced = quote(table, "bare-1", service_tier="flex", input_uncached=1000)
    assert priced.cost_usd == Decimal("0.001")


def test_one_hour_cache_writes_default_to_twice_the_input_rate(table):
    priced = quote(table, "bare-1", cache_write_1h=1000)
    assert priced.cost_usd == Decimal("0.002")


def test_missing_cache_rates_fall_back_to_the_input_rate(table):
    priced = quote(table, "bare-1", cache_read=1000, cache_write_5m=1000)
    assert priced.cost_usd == Decimal("0.002")


@pytest.mark.parametrize(
    "model",
    [
        "anthropic/claude-sonnet-4-5",
        "claude-sonnet-4-5-20250929",
        "claude-sonnet-4-5-20991231",
        "claude-sonnet-4-5@20250929",
        "claude-sonnet-4-5[1m]",
        "Claude-Sonnet-4-5",
        " claude-sonnet-4-5 ",
    ],
)
def test_model_ids_are_normalized(table, model):
    priced = quote(table, model, input_uncached=1_000_000)
    assert priced.status == "priced", model
    assert priced.cost_usd == Decimal("3")


def test_models_dev_is_the_fallback_in_dollars_per_million(table):
    priced = quote(table, "glm-9", provider="zai", input_uncached=1000, output=1000)
    assert (priced.source, priced.pricing_model) == ("models_dev", "zai/glm-9")
    assert priced.cost_usd == Decimal("0.005")
    long = quote(table, "zai/glm-9", input_uncached=200_000, context_tokens=200_000)
    assert long.cost_usd == Decimal("0.4")


def test_litellm_wins_over_models_dev(table):
    priced = quote(table, "claude-sonnet-4-5", provider="anthropic", input_uncached=1)
    assert priced.source == "litellm"


def test_unknown_model_is_unpriced_never_free(table):
    priced = quote(table, "mystery-model-7", input_uncached=1000, output=10)
    assert priced.status == "unknown_model"
    assert priced.cost_usd is None
    assert priced.table_version == "test-v1"


def test_missing_model_is_unpriced(table):
    assert quote(table, None, input_uncached=10).status == "no_model"


def test_zero_token_usage_has_nothing_to_estimate(table):
    priced = quote(table, "claude-sonnet-4-5")
    assert (priced.status, priced.cost_usd) == ("no_tokens", None)


def test_vendored_table_prices_the_supported_agents():
    table = current_price_table()
    manifest = json.loads(
        (Path(__file__).parents[1] / "app/pricing/data/manifest.json").read_text()
    )
    assert table.version == manifest["version"]
    for model in ("claude-sonnet-4-5", "gpt-5.4", "gpt-5-codex", "claude-opus-4-5"):
        priced = table.quote(
            model=model,
            provider=None,
            service_tier=None,
            usage=TokenUsage(input_uncached=1000, output=100),
        )
        assert priced.status == "priced" and priced.cost_usd > 0, model


def test_priority_long_context_without_a_combined_rate_scales_the_long_rate(table):
    # gpt-5.4 in the fixture has no *_above_272k_tokens_priority output rate:
    # the long-context output rate is scaled by priority's ratio (3e-5/1.5e-5).
    priced = quote(
        table,
        "gpt-5.4",
        service_tier="priority",
        output=1000,
        input_uncached=0,
        context_tokens=300_000,
    )
    assert priced.cost_usd == Decimal("0.045")  # 1000 * 2.25e-5 * 2
    # Never cheaper than priority alone.
    assert (
        priced.cost_usd
        > quote(table, "gpt-5.4", service_tier="priority", output=1000).cost_usd
    )
