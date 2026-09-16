// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// TestLifecycle_SetupDoesNotConsumeCardBudget is the walker-path twin of
// TestTick_CardTimeout. The legacy Tick path was fixed (227c006e) to run
// claim + git setup on their own cardSetupTimeout budget and only start
// CardTimeout once the workspace is ready; tickViaLifecycle still wrapped the
// whole walk — discover, claim, cold clone included — in a single CardTimeout.
//
// The stall sits on the claim round-trip and is deliberately longer than
// CardTimeout, so with the budget starting at tick entry the deadline expires
// during setup and the provider is never reached. Reaching the provider is the
// difference between "the work phase timed out" (correct) and "setup burned the
// card's budget before any work started" (the bug).
func TestLifecycle_SetupDoesNotConsumeCardBudget(t *testing.T) {
	const (
		boardID = "board-setup-budget"
		cardID  = "card-setup-budget"
		execID  = "exec-setup-budget"
	)

	cardTimeout := 300 * time.Millisecond

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}

		switch {
		case strings.Contains(r.URL.Path, "/next-assignment"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"card": map[string]any{
					"id":          cardID,
					"title":       "Slow setup card",
					"description": "test",
				},
				"board": map[string]any{
					"id":   boardID,
					"name": "Setup Budget Board",
				},
			})
		case strings.Contains(r.URL.Path, "/executions") && r.Method == http.MethodPost:
			// The claim round-trip stands in for real-world setup cost (a cold
			// git clone, a slow API). Longer than the card budget on purpose.
			time.Sleep(2 * cardTimeout)
			_ = json.NewEncoder(w).Encode(map[string]string{"id": execID})
		default:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{}"))
		}
	}))
	t.Cleanup(srv.Close)

	cfg := testConfig()
	cfg.WorkLoop.CardTimeout = cardTimeout
	cfg.Git.AutoPR = false
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	// Blocks on the first provider call so the walk dies on the WORK deadline —
	// after the provider was reached, which is what this test pins.
	slow := &SlowMockProvider{
		inner:      llm.NewMockProvider("never-reached"),
		blockIndex: 0,
		blockFor:   10 * time.Second,
	}

	loop := mustNewLoop(t, client, slow, gitMgr, cfg)

	stage := valaris.StageConfig{
		Role:     "setup_budget_role",
		Discover: valaris.DiscoverDef{Strategy: "unassigned_or_rework"},
		Claim:    valaris.ClaimDef{ParticipantRole: "helper", ExecutionAction: "act"},
		Git:      valaris.GitDef{Action: "none"},
		Lifecycle: []valaris.LifecycleStep{
			{Name: "step_discover", Kind: "discover", Next: "step_claim"},
			{Name: "step_claim", Kind: "claim", Next: "step_llm"},
			{Name: "step_llm", Kind: "llm", Next: "step_end",
				Params: map[string]any{"stage": "validate", "post_process_kind": "produces_note"}},
			{Name: "step_end", Kind: "end"},
		},
	}

	s := NewDataDrivenStrategy(stage, nil)
	loop.strategy = s

	loop.promptCacheMu.Lock()
	loop.promptCache[stage.Role+":validate"] = "Validate card {{.CardID}}."
	loop.promptCacheMu.Unlock()

	if err := s.Tick(context.Background(), loop); err == nil {
		t.Fatal("tick should return error when the card timeout expires during the work phase")
	}

	if slow.CallCount() == 0 {
		t.Error("card budget was consumed by setup: provider was never reached")
	}
}
