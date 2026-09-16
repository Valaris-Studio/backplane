// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import "testing"

// Cluster I — per-card budget override. The backend ships Card.budget_usd_override
// (migration 067) and surfaces it on the next-assignment bundle. The runner must
// prefer a per-card override over the workspace/yaml max_budget_usd so an outsized
// card can be given more runway without editing the global config — and so the
// SUSPEND classifier compares spend against the SAME ceiling the CLI enforced.
// Backend-authoritative: the override flows from the assignment, never a Go default.

func TestEffectiveBudgetUSD_PrefersCardOverride(t *testing.T) {
	loop := newModelTestLoop(t, "yaml-default")
	loop.cfg.LLM.MaxBudgetUSD = 6.0
	override := 25.0
	loop.SetCardBudgetOverride(&override)

	if got := loop.effectiveBudgetUSD(); got != 25.0 {
		t.Fatalf("effectiveBudgetUSD must prefer per-card override; got %v want 25.0", got)
	}
}

func TestEffectiveBudgetUSD_FallsBackToYaml_WhenNoOverride(t *testing.T) {
	loop := newModelTestLoop(t, "yaml-default")
	loop.cfg.LLM.MaxBudgetUSD = 6.0
	// No override set (nil) — pre-rollout backend or a card without an override.
	if got := loop.effectiveBudgetUSD(); got != 6.0 {
		t.Fatalf("effectiveBudgetUSD must fall back to yaml max_budget_usd; got %v want 6.0", got)
	}
}

func TestLlmOpts_UsesEffectiveBudget_WithCardOverride(t *testing.T) {
	loop := newModelTestLoop(t, "yaml-default")
	loop.cfg.LLM.MaxBudgetUSD = 6.0
	override := 25.0
	loop.SetCardBudgetOverride(&override)

	opts := loop.llmOpts("implement")
	if opts.MaxBudgetUSD != 25.0 {
		t.Fatalf("llmOpts must pass the per-card override to the CLI; got %v want 25.0", opts.MaxBudgetUSD)
	}
}

func TestLlmOpts_UsesYamlBudget_WhenNoOverride(t *testing.T) {
	loop := newModelTestLoop(t, "yaml-default")
	loop.cfg.LLM.MaxBudgetUSD = 6.0
	opts := loop.llmOpts("implement")
	if opts.MaxBudgetUSD != 6.0 {
		t.Fatalf("llmOpts must fall back to yaml budget; got %v want 6.0", opts.MaxBudgetUSD)
	}
}
