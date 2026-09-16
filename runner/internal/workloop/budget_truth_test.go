// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

func TestBudgetTruthMissingHistoryStopsBeforeSourceOrCompletion(t *testing.T) {
	for _, completion := range []bool{false, true} {
		for _, unavailable := range []string{"404", "500"} {
			t.Run(unavailable+map[bool]string{false: "/source", true: "/completion"}[completion], func(t *testing.T) {
				cfg := baseLoopConfig()
				cfg.MaxIterations = 1
				var srv *loopModeServer
				var completionServer *completionWorkServer
				if completion {
					disabled := cfg
					disabled.Enabled = false
					completionServer = newCompletionWorkServer(t,
						completionPolicyConfigJSON(t, cfg, completionPolicyV1, "review"),
						completionPolicyConfigJSON(t, disabled, completionPolicyV1, "paused"))
					completionServer.workBody = `{"pending_count":1,"actionable_count":1,"failed_count":0}`
					srv = completionServer.base
				} else {
					srv = newLoopModeServer(t, loopConfigJSON(t, cfg))
				}
				srv.history404 = unavailable == "404"
				srv.history500 = unavailable == "500"
				provider := llm.NewMockProvider("must not spend")
				mode := newLoopModeForServer(t, srv, provider)
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				defer cancel()
				err := mode.Run(ctx)
				if err == nil || !strings.Contains(strings.ToLower(err.Error()), "history") {
					t.Errorf("missing spending history must stop launch with an actionable error, got %v", err)
				}
				if provider.CallCount() != 0 || srv.executionStartCount() != 0 {
					t.Errorf("missing history reached paid boundary: calls=%d starts=%d", provider.CallCount(), srv.executionStartCount())
				}
				if completionServer != nil && len(completionServer.claims) != 0 {
					t.Errorf("missing history reached completion claim: %v", completionServer.claims)
				}
			})
		}
	}
}

func TestBudgetTruthSourceAndReviewReportTheSameScopes(t *testing.T) {
	for _, completion := range []bool{false, true} {
		t.Run(map[bool]string{false: "source", true: "review_only"}[completion], func(t *testing.T) {
			logs := captureLogs(t)
			provider := llm.NewMockProvider("work")
			provider.Caps = llm.Capabilities{StructuredOutput: true, BudgetCap: true}
			var srv *loopModeServer
			if completion {
				repo, sha, _ := completionSourceRepo(t)
				completionServer := completionRunOnceServer(t, completionClaim(t, "review", "mock", repo, sha, nil))
				srv = completionServer.base
				provider.QueueStructured([]byte(`{"outcome":"passed","summary":"reviewed"}`))
			} else {
				cfg := baseLoopConfig()
				cfg.MaxIterations = 1
				srv = newLoopModeServer(t, loopConfigJSON(t, cfg))
			}
			srv.historyBody = `{"iteration_count":4,"spent_usd":3,"lifetime_spent_usd":48,"budget_epoch":"2026-09-15T10:00:00"}`
			mode := newLoopModeForServer(t, srv, provider)
			if err := mode.Run(context.Background()); err != nil {
				t.Fatal(err)
			}
			if provider.CallCount() != 1 {
				t.Fatalf("fixture did not execute exactly one source/review: %d", provider.CallCount())
			}
			for _, field := range []string{"lifetime_spent_usd=48", "epoch_start=2026-09-15T10:00:00", "epoch_spent_usd=3", "epoch_remaining_usd=17", "session_setting_usd=", "session_enforcement=advisory"} {
				if !strings.Contains(logs(), field) {
					t.Errorf("launch report missing %q:\n%s", field, logs())
				}
			}
		})
	}
}

func TestBudgetTruthUnrelatedAPIKeyDoesNotProveProviderEnforcement(t *testing.T) {
	provider := llm.NewMockProvider()
	provider.Caps = llm.Capabilities{BudgetCap: true}
	mode := &LoopMode{cfg: loopModeTestConfig(t)}
	mode.cfg.LLM.AnthropicAPIKey = "fixture-unrelated-api-key"
	cfg := baseLoopConfig()
	if report := mode.reportBudget(&cfg, 0, provider, "source"); report.SessionEnforcement != "advisory" {
		t.Fatalf("unrelated provider credential was treated as enforceable: %s", report.SessionEnforcement)
	}
}

func TestBudgetTruthClaudeEnforcementDependsOnConfiguredAuth(t *testing.T) {
	for _, apiKey := range []string{"", "fixture-api-key"} {
		mode := &LoopMode{cfg: loopModeTestConfig(t)}
		mode.cfg.LLM.AnthropicAPIKey = apiKey
		cfg := baseLoopConfig()
		report := mode.reportBudget(&cfg, 0, llm.NewClaudeCLI(), "review")
		want := "advisory"
		if apiKey != "" {
			want = "provider_enforced"
		}
		if report.SessionEnforcement != want {
			t.Fatalf("got %s, want %s", report.SessionEnforcement, want)
		}
	}
}
