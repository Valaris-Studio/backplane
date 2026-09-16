// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import "testing"

// The default price (no provider/model match) must reproduce the historical
// Claude Sonnet numbers exactly, so existing cost reports don't shift.
func TestPriceFor_DefaultIsSonnet(t *testing.T) {
	p := priceFor("", "")
	if p.inputPer1M != 3.0 || p.outputPer1M != 15.0 || p.cacheCreatePer1M != 3.75 || p.cacheReadPer1M != 0.30 {
		t.Errorf("default price = %+v, want Sonnet 3/15/3.75/0.30", p)
	}
}

// An unknown provider/model also falls back to the Sonnet default rather than
// zeroing cost (a cost-blind provider must not silently look free).
func TestPriceFor_UnknownFallsBackToDefault(t *testing.T) {
	if priceFor("some-future-cli", "mystery-model") != priceFor("", "") {
		t.Errorf("unknown provider/model should fall back to the default price")
	}
}

// estimateCostWith uses a supplied price; the legacy estimateCost keeps the
// Sonnet baseline. Both must agree for the default price.
func TestEstimateCostWith_MatchesLegacyForDefault(t *testing.T) {
	legacy := estimateCost(1000, 500, 0, 0)
	keyed := estimateCostWith(priceFor("", ""), 1000, 500, 0, 0)
	if legacy != keyed {
		t.Errorf("estimateCostWith(default) = %f, legacy estimateCost = %f", keyed, legacy)
	}
}

// Cost-blind safety: zero tokens cost zero regardless of price, no panic.
func TestEstimateCostWith_ZeroTokens(t *testing.T) {
	if c := estimateCostWith(priceFor("anthropic", "opus"), 0, 0, 0, 0); c != 0 {
		t.Errorf("zero tokens should cost 0, got %f", c)
	}
}

// A known non-default model resolves to its own rate, distinct from Sonnet.
func TestPriceFor_KnownModelOverridesDefault(t *testing.T) {
	opus := priceFor("claude-cli", "opus")
	if opus == priceFor("", "") {
		t.Errorf("opus should have its own price distinct from the Sonnet default")
	}
	if opus.outputPer1M <= 15.0 {
		t.Errorf("opus output price %.2f should exceed Sonnet's 15.0", opus.outputPer1M)
	}
}
