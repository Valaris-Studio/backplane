// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

func TestCompletionSourceDispatchRejectsUnavailableProviderAndUnresolvedModel(t *testing.T) {
	for _, scenario := range []string{"unavailable_without_registry", "unavailable_with_registry", "registry_identity_mismatch", "explicit_provider_tier_model"} {
		t.Run(scenario, func(t *testing.T) {
			cfg := baseLoopConfig()
			cfg.Provider = "selected-agent"
			cfg.Model = "exact-operator-model"
			disabled := cfg
			disabled.Enabled = false
			provider := llm.NewMockProvider("must not run fallback")
			provider.NameOverride = "fallback-agent"
			selected := llm.NewMockProvider("must not run unresolved model")
			selected.NameOverride = "selected-agent"
			if scenario == "explicit_provider_tier_model" {
				cfg.Model = "mid"
			}
			srv := newCompletionWorkServer(t, completionPolicyConfigJSON(t, cfg, completionPolicyV1, "Mandatory directives."), completionPolicyConfigJSON(t, disabled, completionPolicyV1, "Paused."))
			m := newLoopModeForServer(t, srv.base, provider)
			switch scenario {
			case "unavailable_with_registry":
				m.providers = map[string]llm.Provider{"fallback-agent": provider}
			case "registry_identity_mismatch":
				m.providers = map[string]llm.Provider{"selected-agent": provider}
			case "explicit_provider_tier_model":
				m.providers = map[string]llm.Provider{"selected-agent": selected, "fallback-agent": provider}
				m.cfg.LLM.TierProviders = map[string][]string{"mid": {"fallback-agent"}}
			}
			err := m.Run(context.Background())
			if err == nil {
				t.Fatal("unsupported explicit provider/model became executable")
			}
			if err != nil && !strings.Contains(err.Error(), "selected-agent") {
				t.Errorf("incompatibility does not identify selected provider: %v", err)
			}
			if scenario == "explicit_provider_tier_model" && err != nil && !strings.Contains(err.Error(), "concrete model") {
				t.Errorf("incompatibility does not explain unresolved model: %v", err)
			}
			if provider.CallCount() != 0 || selected.CallCount() != 0 || srv.base.executionStartCount() != 0 || srv.base.patchCount() != 0 {
				t.Fatalf("invalid dispatch ran or mutated board: default=%d selected=%d starts=%d patches=%d", provider.CallCount(), selected.CallCount(), srv.base.executionStartCount(), srv.base.patchCount())
			}
		})
	}
}

func TestCompletionSourceDispatchPreservesExactPairAndUnspecifiedTierSelection(t *testing.T) {
	for _, scenario := range []string{"explicit_registry", "explicit_default_without_registry", "unspecified_provider_tier"} {
		t.Run(scenario, func(t *testing.T) {
			cfg := baseLoopConfig()
			cfg.Provider = "selected-agent"
			cfg.Model = "exact-operator-model"
			source := llm.NewMockProvider("source worked")
			source.NameOverride = "selected-agent"
			fallback := llm.NewMockProvider("fallback unused")
			fallback.NameOverride = "fallback-agent"
			if scenario == "unspecified_provider_tier" {
				cfg.Provider = ""
				cfg.Model = "mid"
			}
			disabled := cfg
			disabled.Enabled = false
			srv := newCompletionWorkServer(t, completionPolicyConfigJSON(t, cfg, completionPolicyV1, "Mandatory directives."), completionPolicyConfigJSON(t, disabled, completionPolicyV1, "Paused."))
			m := newLoopModeForServer(t, srv.base, fallback)
			if scenario == "explicit_default_without_registry" {
				m.defaultProvider = source
			} else {
				m.providers = map[string]llm.Provider{"selected-agent": source, "fallback-agent": fallback}
			}
			m.cfg.LLM.Model = "runner-tier-model"
			m.cfg.LLM.TierProviders = map[string][]string{"mid": {"selected-agent"}}
			if err := m.Run(context.Background()); err != nil {
				t.Fatal(err)
			}
			if source.CallCount() != 1 || fallback.CallCount() != 0 {
				t.Fatalf("wrong provider: source=%d fallback=%d", source.CallCount(), fallback.CallCount())
			}
			want := "exact-operator-model"
			if scenario == "unspecified_provider_tier" {
				want = "runner-tier-model"
			}
			if source.Calls[0].Options.Model != want {
				t.Errorf("model=%q want %q", source.Calls[0].Options.Model, want)
			}
		})
	}
}

func TestCompletionSourceDispatchLegacyUnavailableProviderStillFallsBack(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.Provider = "unavailable-agent"
	cfg.Model = "operator-model"
	disabled := cfg
	disabled.Enabled = false
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg), loopConfigJSON(t, disabled))
	provider := llm.NewMockProvider("legacy fallback")
	provider.NameOverride = "fallback-agent"
	m := newLoopModeForServer(t, srv, provider)
	if err := m.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if provider.CallCount() != 1 {
		t.Fatal("legacy provider fallback behavior changed")
	}
}
