// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

func TestLoopMode_RunOverrideSurvivesBoardRefresh(t *testing.T) {
	board := baseLoopConfig()
	board.Provider = "claude-cli"
	board.Model = "premium"
	board.MaxIterations = 2
	refreshed := board
	refreshed.Model = "board-new-model"
	srv := newLoopModeServer(t, loopConfigJSON(t, board), loopConfigJSON(t, refreshed))
	fallback := llm.NewMockProvider("unexpected")
	fallback.NameOverride = "claude-cli"
	selected := llm.NewMockProvider("one", "two")
	selected.NameOverride = "codex-cli"
	cfg := loopModeTestConfig(t)
	cfg.LLM.RunOverride = &config.ModelSelection{Provider: "codex-cli", Model: "future-custom-model"}
	cfg.LLM.TierProviders = map[string][]string{"premium": {"claude-cli"}}
	cfg.LLM.MaxBudgetUSD = 0.75
	m := NewLoopMode(testClientWithURL(srv.srv.URL), cfg, map[string]llm.Provider{"codex-cli": selected, "claude-cli": fallback}, fallback, "acme", "board-1", "agent-1")
	if err := m.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if selected.CallCount() != 2 || fallback.CallCount() != 0 {
		t.Fatalf("dispatch selected=%d fallback=%d", selected.CallCount(), fallback.CallCount())
	}
	for _, call := range selected.Calls {
		if call.Options.Model != "future-custom-model" || call.Options.MaxBudgetUSD != 0.75 {
			t.Fatalf("incorrect options: %#v", call.Options)
		}
	}
	if len(srv.executionStarts) != 2 {
		t.Fatalf("execution starts=%d, want 2", len(srv.executionStarts))
	}
	for i, start := range srv.executionStarts {
		requested := board.Model
		if i > 0 {
			requested = refreshed.Model
		}
		summary, _ := start["input_summary"].(string)
		if start["provider"] != "codex-cli" || start["model"] != "future-custom-model" || !strings.Contains(summary, requested) || !strings.Contains(summary, "claude-cli") {
			t.Fatalf("missing requested/effective telemetry: %#v", start)
		}
	}
	for _, patch := range srv.patches {
		if _, ok := patch["model"]; ok {
			t.Fatalf("override mutated board: %#v", patch)
		}
		if _, ok := patch["provider"]; ok {
			t.Fatalf("override mutated board: %#v", patch)
		}
	}
}

func TestLoopMode_RunOverrideMissingProviderNeverFallsBack(t *testing.T) {
	board := baseLoopConfig()
	board.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, board))
	fallback := llm.NewMockProvider("must not run")
	fallback.NameOverride = "claude-cli"
	m := newLoopModeForServer(t, srv, fallback)
	m.cfg.LLM.RunOverride = &config.ModelSelection{Provider: "codex-cli", Model: "custom-model"}
	err := m.Run(context.Background())
	if err == nil || !strings.Contains(err.Error(), "codex-cli") {
		t.Fatalf("expected selected provider error, got %v", err)
	}
	if fallback.CallCount() != 0 || len(srv.executionStarts) != 0 || len(srv.patches) != 0 {
		t.Fatal("missing provider caused execution or board mutation")
	}
}

func TestLoopMode_RunOverrideUsesMatchingDefaultProvider(t *testing.T) {
	board := baseLoopConfig()
	board.Provider, board.Model, board.MaxIterations = "claude-cli", "premium", 1
	srv := newLoopModeServer(t, loopConfigJSON(t, board))
	selected := llm.NewMockProvider("one")
	selected.NameOverride = "codex-cli"
	m := newLoopModeForServer(t, srv, selected)
	m.cfg.LLM.RunOverride = &config.ModelSelection{Provider: "codex-cli", Model: "custom-model"}
	if err := m.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if selected.CallCount() != 1 || selected.Calls[0].Options.Model != "custom-model" {
		t.Fatal("single-provider override not dispatched")
	}
}

func TestLoopMode_RunOverrideRejectsInvalidSelectionBeforeSideEffects(t *testing.T) {
	srv := newLoopModeServer(t, loopConfigJSON(t, baseLoopConfig()))
	provider := llm.NewMockProvider("must not run")
	provider.NameOverride = "codex-cli"
	m := newLoopModeForServer(t, srv, provider)
	m.cfg.LLM.RunOverride = &config.ModelSelection{Provider: "codex-cli", Model: "premium"}
	if err := m.Run(context.Background()); err == nil {
		t.Fatal("invalid override accepted")
	}
	if provider.CallCount() != 0 || srv.getLoopCalls != 0 || len(srv.patches) != 0 {
		t.Fatal("invalid override caused side effects")
	}
}
