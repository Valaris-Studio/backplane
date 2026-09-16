// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// Per-stage provider selection: the backend pipeline_config declares an
// llm.provider per stage and the runner already carries it on
// AssignmentLLM.Provider. execute() must dispatch to the provider the stage
// declared, falling back to the runner's default provider when the stage
// declares none or names a provider that wasn't built.

func newProviderRoutingLoop(def llm.Provider, registry map[string]llm.Provider) *Loop {
	return &Loop{
		provider:  def,
		providers: registry,
	}
}

func mockNamed(name string, responses ...string) *llm.MockProvider {
	m := llm.NewMockProvider(responses...)
	m.NameOverride = name
	return m
}

func TestExecute_RoutesToStageDeclaredProvider(t *testing.T) {
	def := mockNamed("claude-cli", "from-claude")
	codex := mockNamed("codex-cli", "from-codex")
	l := newProviderRoutingLoop(def, map[string]llm.Provider{
		"claude-cli": def,
		"codex-cli":  codex,
	})

	l.SetAssignmentLLM(valaris.AssignmentLLM{Provider: "codex-cli", Model: "gpt-5-codex"})

	res, err := l.execute(context.Background(), "do work", llm.Options{Model: "gpt-5-codex"})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Output != "from-codex" {
		t.Fatalf("expected the codex-cli provider to handle the stage, got output %q", res.Output)
	}
	if codex.CallCount() != 1 {
		t.Errorf("codex provider should have been called once, got %d", codex.CallCount())
	}
	if def.CallCount() != 0 {
		t.Errorf("default (claude-cli) provider must NOT be called for a codex-declared stage, got %d", def.CallCount())
	}
}

func TestExecute_FallsBackToDefaultWhenStageDeclaresNoProvider(t *testing.T) {
	def := mockNamed("claude-cli", "from-default")
	codex := mockNamed("codex-cli", "unused")
	l := newProviderRoutingLoop(def, map[string]llm.Provider{
		"claude-cli": def,
		"codex-cli":  codex,
	})

	// No Provider on the assignment — the YAML default provider must handle it.
	l.SetAssignmentLLM(valaris.AssignmentLLM{Model: "sonnet"})

	res, err := l.execute(context.Background(), "do work", llm.Options{Model: "sonnet"})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Output != "from-default" {
		t.Fatalf("expected the default provider, got %q", res.Output)
	}
	if codex.CallCount() != 0 {
		t.Errorf("codex must not run when no provider declared, got %d", codex.CallCount())
	}
}

func TestExecute_FallsBackToDefaultWhenDeclaredProviderNotBuilt(t *testing.T) {
	// A stage names a provider the runner didn't build (e.g. aider-cli). Rather
	// than crash mid-card, fall back to the default provider — defensive, and
	// the preflight is the place that should have caught a truly-missing one.
	def := mockNamed("claude-cli", "from-default")
	l := newProviderRoutingLoop(def, map[string]llm.Provider{"claude-cli": def})

	l.SetAssignmentLLM(valaris.AssignmentLLM{Provider: "aider-cli", Model: "gpt-4o"})

	res, err := l.execute(context.Background(), "do work", llm.Options{Model: "gpt-4o"})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Output != "from-default" {
		t.Fatalf("expected fallback to default provider, got %q", res.Output)
	}
}

// Tier-aware remap: the backend emits an abstract tier (premium/mid/low) as
// provider-agnostic intent; the runner's llm.tier_providers maps it to an
// ordered local-agent preference list. The runner picks the first provider it
// actually built — backend model is a suggestion, not a mandate.

func newTierRoutingLoop(def llm.Provider, registry map[string]llm.Provider, tiers map[string][]string) *Loop {
	return &Loop{
		provider:  def,
		providers: registry,
		cfg:       &config.Config{LLM: config.LLMConfig{TierProviders: tiers}},
	}
}

// newModelRoutingLoop is like newTierRoutingLoop but lets a test set the runner's
// own configured model (cfg.LLM.Model). This is the model the runner must send
// when a tier/extra remap picks a provider OTHER than the backend-resolved one —
// the backend's assignment.Model was resolved for a different agent and would be
// unrunnable on the remapped provider (the field run 2026-07-25 failure: codex got
// `opus`). Driving execute() through llmOpts() (Options.Model left zero) exercises
// the real model-resolution path the hand-built-Options tests above skip.
func newModelRoutingLoop(def llm.Provider, registry map[string]llm.Provider, tiers map[string][]string, runnerModel string) *Loop {
	l := newTierRoutingLoop(def, registry, tiers)
	l.cfg.LLM.Model = runnerModel
	return l
}

func TestExecute_TierRemapsToFirstAvailableProvider(t *testing.T) {
	// premium -> [claude-cli, codex-cli]; both built, so the FIRST wins even
	// though the backend resolved the stage to codex-cli.
	claude := mockNamed("claude-cli", "from-claude")
	codex := mockNamed("codex-cli", "from-codex")
	l := newTierRoutingLoop(codex,
		map[string]llm.Provider{"claude-cli": claude, "codex-cli": codex},
		map[string][]string{"premium": {"claude-cli", "codex-cli"}},
	)

	l.SetAssignmentLLM(valaris.AssignmentLLM{Tier: "premium", Provider: "codex-cli", Model: "opus"})

	res, err := l.execute(context.Background(), "do work", llm.Options{Model: "opus"})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Output != "from-claude" {
		t.Fatalf("premium tier should remap to claude-cli (first available), got %q", res.Output)
	}
	if claude.CallCount() != 1 || codex.CallCount() != 0 {
		t.Errorf("tier preference list must win over resolved provider: claude=%d codex=%d", claude.CallCount(), codex.CallCount())
	}
}

func TestExecute_TierSkipsUnbuiltAndPicksNext(t *testing.T) {
	// premium -> [aider-cli, codex-cli]; aider not built, so codex (2nd) wins.
	codex := mockNamed("codex-cli", "from-codex")
	l := newTierRoutingLoop(codex,
		map[string]llm.Provider{"codex-cli": codex},
		map[string][]string{"premium": {"aider-cli", "codex-cli"}},
	)

	l.SetAssignmentLLM(valaris.AssignmentLLM{Tier: "premium", Provider: "claude-cli", Model: "opus"})

	res, err := l.execute(context.Background(), "do work", llm.Options{Model: "opus"})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Output != "from-codex" {
		t.Fatalf("unbuilt first entry should be skipped, codex should win, got %q", res.Output)
	}
}

func TestExecute_TierFallsBackToResolvedProviderWhenNoneBuilt(t *testing.T) {
	// premium -> [aider-cli] (not built). No tier match, so fall back to the
	// backend-resolved provider (claude-cli), which IS built.
	claude := mockNamed("claude-cli", "from-claude")
	l := newTierRoutingLoop(claude,
		map[string]llm.Provider{"claude-cli": claude},
		map[string][]string{"premium": {"aider-cli"}},
	)

	l.SetAssignmentLLM(valaris.AssignmentLLM{Tier: "premium", Provider: "claude-cli", Model: "opus"})

	res, err := l.execute(context.Background(), "do work", llm.Options{Model: "opus"})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Output != "from-claude" {
		t.Fatalf("expected fallback to resolved provider claude-cli, got %q", res.Output)
	}
}

func TestExecute_UnmappedTierUsesResolvedProvider(t *testing.T) {
	// A stage carries tier=mid but the runner only maps premium. The resolved
	// provider (codex-cli) handles it — the runner has no policy for mid.
	claude := mockNamed("claude-cli", "from-claude")
	codex := mockNamed("codex-cli", "from-codex")
	l := newTierRoutingLoop(claude,
		map[string]llm.Provider{"claude-cli": claude, "codex-cli": codex},
		map[string][]string{"premium": {"claude-cli"}},
	)

	l.SetAssignmentLLM(valaris.AssignmentLLM{Tier: "mid", Provider: "codex-cli", Model: "sonnet"})

	res, err := l.execute(context.Background(), "do work", llm.Options{Model: "sonnet"})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Output != "from-codex" {
		t.Fatalf("unmapped tier must use resolved provider codex-cli, got %q", res.Output)
	}
}

// --- Model must follow the provider decision (field run 2026-07-25 regression) ---
//
// The bug: providerFor() remapped premium -> codex-cli, but llmOpts() set
// Options.Model = assignment.Model = "opus" (the backend's Claude resolution),
// so the runner ran `codex exec --model opus` -> unrunnable, 0 tokens, breaker
// trip. The model field rode along unchanged after the provider was swapped.
// Contract: when the resolved provider != the backend-resolved provider, the
// backend model is for the wrong agent -> send the RUNNER's configured model.

func TestExecute_TierRemapAlsoSubstitutesRunnerModel(t *testing.T) {
	// premium -> [codex-cli, claude-cli]; backend resolved (provider=claude-cli,
	// model=opus). Tier picks codex-cli. opus is a Claude model -> must NOT reach
	// codex. The runner's own model (gpt-5.5) must be sent instead.
	claude := mockNamed("claude-cli", "unused")
	codex := mockNamed("codex-cli", "from-codex")
	l := newModelRoutingLoop(claude,
		map[string]llm.Provider{"claude-cli": claude, "codex-cli": codex},
		map[string][]string{"premium": {"codex-cli", "claude-cli"}},
		"gpt-5.5",
	)

	l.SetAssignmentLLM(valaris.AssignmentLLM{Tier: "premium", Provider: "claude-cli", Model: "opus"})

	// Production shape: llmOpts already baked the backend model into Options.Model.
	res, err := l.execute(context.Background(), "do work", llm.Options{Model: "opus"})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Output != "from-codex" {
		t.Fatalf("premium tier should remap to codex-cli, got %q", res.Output)
	}
	got := codex.LastCall().Options.Model
	if got != "gpt-5.5" {
		t.Fatalf("remapped provider must receive the runner's model, got %q (want gpt-5.5; opus would crash codex)", got)
	}
}

func TestExecute_NoRemapKeepsBackendModel(t *testing.T) {
	// No tier; backend resolved (provider=claude-cli, model=opus) and claude-cli
	// is what runs. The provider was NOT remapped, so the backend model stands —
	// backend authority is preserved on the non-remap path.
	claude := mockNamed("claude-cli", "from-claude")
	l := newModelRoutingLoop(claude,
		map[string]llm.Provider{"claude-cli": claude},
		nil,
		"gpt-5.5",
	)

	l.SetAssignmentLLM(valaris.AssignmentLLM{Provider: "claude-cli", Model: "opus"})

	if _, err := l.execute(context.Background(), "do work", llm.Options{Model: "opus"}); err != nil {
		t.Fatalf("execute: %v", err)
	}
	got := claude.LastCall().Options.Model
	if got != "opus" {
		t.Fatalf("non-remap path must keep the backend model, got %q (want opus)", got)
	}
}

func TestExecute_StageProviderMatchKeepsBackendModel(t *testing.T) {
	// The backend ships a COHERENT pair: provider=codex-cli, model=gpt-5-codex
	// (it resolved the model FOR codex). The stage routes to codex and the
	// provider matches -> the backend model must be honored, NOT overridden by
	// the runner's default. This guards the per-stage case where the backend
	// legitimately owns a non-default model for the very provider that runs.
	claude := mockNamed("claude-cli", "unused")
	codex := mockNamed("codex-cli", "from-codex")
	l := newModelRoutingLoop(claude,
		map[string]llm.Provider{"claude-cli": claude, "codex-cli": codex},
		nil,
		"gpt-5.5",
	)

	l.SetAssignmentLLM(valaris.AssignmentLLM{Provider: "codex-cli", Model: "gpt-5-codex"})

	if _, err := l.execute(context.Background(), "do work", llm.Options{Model: "gpt-5-codex"}); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if got := codex.LastCall().Options.Model; got != "gpt-5-codex" {
		t.Fatalf("matched provider must keep the backend model, got %q (want gpt-5-codex)", got)
	}
}

// --- Execution-start reporting must log the RESOLVED provider+model ---
//
// The activity feed showed "implementer running opus" while the runner ran
// codex+gpt-5.5: claim() logged card.AssignmentLLM.Model (the backend's tier
// suggestion) before the remap. resolvedProviderModel() must return what
// execute() will actually run so the row records the truth.

func TestResolvedProviderModel_ReportsRemappedProviderAndRunnerModel(t *testing.T) {
	claude := mockNamed("claude-cli", "x")
	codex := mockNamed("codex-cli", "x")
	l := newModelRoutingLoop(claude,
		map[string]llm.Provider{"claude-cli": claude, "codex-cli": codex},
		map[string][]string{"premium": {"codex-cli", "claude-cli"}},
		"gpt-5.5",
	)

	// Backend suggested claude-cli/opus for this premium stage.
	dispatch := valaris.AssignmentLLM{Tier: "premium", Provider: "claude-cli", Model: "opus"}
	provider, model := l.resolvedProviderModel(dispatch)

	if provider != "codex-cli" {
		t.Errorf("logged provider must be the remapped one, got %q (want codex-cli)", provider)
	}
	if model != "gpt-5.5" {
		t.Errorf("logged model must be the runner's model, got %q (want gpt-5.5; NOT the suggested opus)", model)
	}
}

func TestResolvedProviderModel_KeepsBackendPairWhenNoRemap(t *testing.T) {
	claude := mockNamed("claude-cli", "x")
	l := newModelRoutingLoop(claude,
		map[string]llm.Provider{"claude-cli": claude},
		nil,
		"gpt-5.5",
	)

	dispatch := valaris.AssignmentLLM{Provider: "claude-cli", Model: "opus"}
	provider, model := l.resolvedProviderModel(dispatch)

	if provider != "claude-cli" || model != "opus" {
		t.Errorf("non-remap must log the backend pair, got (%q,%q) want (claude-cli,opus)", provider, model)
	}
}

func TestResolvedProviderModel_NilRegistryReportsNoProvider(t *testing.T) {
	// Single-default-provider hosts have no meaningful per-stage provider name to
	// log; provider stays empty (NULL) and the backend model passes through.
	l := &Loop{provider: mockNamed("claude-cli", "x")}
	provider, model := l.resolvedProviderModel(valaris.AssignmentLLM{Model: "sonnet"})
	if provider != "" {
		t.Errorf("nil registry should log empty provider, got %q", provider)
	}
	if model != "sonnet" {
		t.Errorf("nil registry should pass the backend model through, got %q", model)
	}
}

func TestExecute_NilRegistryUsesDefaultProvider(t *testing.T) {
	// Every existing call site / test builds a Loop with no providers map.
	// A nil registry must behave exactly as before: the single default provider
	// handles every stage regardless of what the assignment declares.
	def := mockNamed("claude-cli", "ok")
	l := &Loop{provider: def}

	l.SetAssignmentLLM(valaris.AssignmentLLM{Provider: "codex-cli", Model: "x"})

	res, err := l.execute(context.Background(), "do work", llm.Options{Model: "x"})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Output != "ok" {
		t.Fatalf("nil registry must use the default provider, got %q", res.Output)
	}
	if def.CallCount() != 1 {
		t.Errorf("default provider should have handled the call, got %d", def.CallCount())
	}
}
