# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tier-to-(provider, model) resolver tests.

The resolver decouples DEFAULT_PIPELINE_CONFIG from any specific provider's
model names. Pipelines emit tier identifiers ("premium"/"mid"/"low"); the
backend translates to a concrete (provider, model) tuple before /next-assignment.
"""

from __future__ import annotations

import logging

import pytest

from app.services import llm_tiers


def test_resolve_tier_premium_returns_opus():
    provider, model = llm_tiers.resolve_tier("premium")
    assert (provider, model) == ("claude-cli", "opus")


def test_resolve_tier_mid_returns_sonnet():
    provider, model = llm_tiers.resolve_tier("mid")
    assert (provider, model) == ("claude-cli", "sonnet")


def test_resolve_tier_low_returns_haiku():
    provider, model = llm_tiers.resolve_tier("low")
    assert (provider, model) == ("claude-cli", "haiku")


def test_resolve_tier_unknown_raises_valueerror():
    with pytest.raises(ValueError):
        llm_tiers.resolve_tier("ultra")


def test_resolve_tier_literal_model_passes_through_with_warning(caplog):
    caplog.set_level(logging.WARNING)
    provider, model = llm_tiers.resolve_tier("sonnet")
    assert (provider, model) == ("claude-cli", "sonnet")
    assert any("deprecat" in rec.message.lower() for rec in caplog.records), (
        f"expected deprecation warning, got {[r.message for r in caplog.records]}"
    )


def test_resolve_tier_literal_opus_passes_through():
    provider, model = llm_tiers.resolve_tier("opus")
    assert (provider, model) == ("claude-cli", "opus")


def test_resolve_tier_literal_haiku_passes_through():
    provider, model = llm_tiers.resolve_tier("haiku")
    assert (provider, model) == ("claude-cli", "haiku")


def test_resolver_is_swappable():
    """Tests can monkeypatch the module-level callable for custom maps."""
    original = llm_tiers._TIER_RESOLVER

    def custom(tier: str, workspace_id=None):
        return ("openai", f"gpt-{tier}")

    try:
        llm_tiers._TIER_RESOLVER = custom
        provider, model = llm_tiers.resolve_tier("4-turbo")
        assert (provider, model) == ("openai", "gpt-4-turbo")
    finally:
        llm_tiers._TIER_RESOLVER = original


# ---------------------------------------------------------------------------
# Save-time model-value guard (card e019244b: frontend offered tier "high",
# the resolver only knows premium/mid/low — reject the typo class at write
# instead of failing at dispatch).
# ---------------------------------------------------------------------------


def test_model_value_error_accepts_known_tiers():
    for tier in ("premium", "mid", "low"):
        assert llm_tiers.model_value_error(tier) is None


def test_model_value_error_accepts_deprecated_literals():
    for literal in ("opus", "sonnet", "haiku"):
        assert llm_tiers.model_value_error(literal) is None


def test_model_value_error_accepts_empty():
    assert llm_tiers.model_value_error("") is None


def test_model_value_error_accepts_concrete_model_ids():
    """Concrete provider model ids (digits/separators) pass — dispatch
    forwards them verbatim, the documented escape hatch for pinned models."""
    for model_id in ("claude-opus-4", "gpt-4o", "llama3:70b", "models/x-1.5"):
        assert llm_tiers.model_value_error(model_id) is None


def test_model_value_error_rejects_bare_word_non_tier():
    """A bare alphabetic token outside the tier vocabulary is the "high"
    typo class — unresolvable at dispatch, rejected with a clear message."""
    for bad in ("high", "best", "Premium "):
        message = llm_tiers.model_value_error(bad)
        assert message is not None, f"expected rejection for {bad!r}"
    message = llm_tiers.model_value_error("high")
    assert "high" in message
    assert "premium" in message
