// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	stdio "io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// TestLifecycle_ReportsCostOnCleanWalk is the regression guard for the bug where
// the live tickViaLifecycle path created + completed executions but never PATCHed
// cost_usd/tokens_used — so every execution stayed NULL-cost in the DB and the
// frontend showed $0. The legacy tickCard path reported cost via a deferred
// reportCost; the lifecycle walker never did.
//
// It walks discover → claim → llm → end with a seeded prompt (so the llm step
// actually invokes the provider) and a MockProvider that reports tokens. The
// MockProvider returns zero CostUSD, so Loop.execute estimates cost from the
// token counts (mirroring real subscription-auth runs). The test asserts a PATCH
// to /api/agents/{id}/executions/{execId} arrived carrying tokens_used > 0.
func TestLifecycle_ReportsCostOnCleanWalk(t *testing.T) {
	boardID := "board-cost"
	cardID := "card-cost-1"
	const execID = "exec-cost-1"

	var mu sync.Mutex
	var costPatch map[string]any
	var costPatchPath string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}

		switch {
		case strings.Contains(r.URL.Path, "/next-assignment"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"card": map[string]any{
					"id":          cardID,
					"title":       "Cost Card",
					"description": "test",
				},
				"board": map[string]any{
					"id":   boardID,
					"name": "Cost Board",
				},
			})
		case strings.Contains(r.URL.Path, "/executions/"+execID) && r.Method == http.MethodPatch:
			// Several PATCHes hit this path (prompt persistence, status updates).
			// Only the cost report carries tokens_used/cost_usd — capture that one
			// specifically so an unrelated PATCH can't masquerade as a cost report.
			body, _ := stdio.ReadAll(r.Body)
			var payload map[string]any
			_ = json.Unmarshal(body, &payload)
			if _, hasTokens := payload["tokens_used"]; hasTokens {
				mu.Lock()
				costPatchPath = r.URL.Path
				costPatch = payload
				mu.Unlock()
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{}"))
		case strings.Contains(r.URL.Path, "/executions") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]string{"id": execID})
		default:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{}"))
		}
	}))
	t.Cleanup(srv.Close)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	// MockProvider with non-zero tokens so Loop.execute estimates a cost the way
	// real subscription-auth runs do (CostUSD=0, tokens>0 → estimateCost).
	mock := llm.NewMockProvider(`{"summary":"validated"}`)
	mock.InputTokens = 1200
	mock.OutputTokens = 800

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)

	stage := valaris.StageConfig{
		Role:     "cost_role",
		Discover: valaris.DiscoverDef{Strategy: "unassigned_or_rework"},
		Claim:    valaris.ClaimDef{ParticipantRole: "helper", ExecutionAction: "act"},
		Git:      valaris.GitDef{Action: "none"},
		Lifecycle: []valaris.LifecycleStep{
			{Name: "step_discover", Kind: "discover", Next: "step_claim"},
			{Name: "step_claim", Kind: "claim", Next: "step_llm"},
			// produces_note is a non-decision kind: it just runs the provider and
			// wraps the output, so the empty decision routes linearly via Next.
			{Name: "step_llm", Kind: "llm", Next: "step_end",
				Params: map[string]any{"stage": "validate", "post_process_kind": "produces_note"}},
			{Name: "step_end", Kind: "end"},
		},
	}

	s := NewDataDrivenStrategy(stage, nil)
	loop.strategy = s

	// Seed the prompt cache so the llm step doesn't graceful-skip (no_prompt)
	// before reaching the provider. Key is role:stage (see Loop.getPrompt).
	loop.promptCacheMu.Lock()
	loop.promptCache[stage.Role+":validate"] = "Validate card {{.CardID}}."
	loop.promptCacheMu.Unlock()

	if err := s.Tick(context.Background(), loop); err != nil {
		t.Fatalf("Tick (lifecycle): %v", err)
	}

	mu.Lock()
	defer mu.Unlock()

	if costPatch == nil {
		t.Fatalf("no cost PATCH received — tickViaLifecycle never reported cost (path hit: %q)", costPatchPath)
	}
	if !strings.HasSuffix(costPatchPath, "/executions/"+execID) {
		t.Errorf("cost PATCH hit unexpected path %q, want suffix /executions/%s", costPatchPath, execID)
	}
	tokens, ok := costPatch["tokens_used"]
	if !ok {
		t.Fatalf("cost PATCH body missing tokens_used: %v", costPatch)
	}
	if tf, _ := tokens.(float64); tf <= 0 {
		t.Errorf("cost PATCH tokens_used = %v, want > 0", tokens)
	}
}
