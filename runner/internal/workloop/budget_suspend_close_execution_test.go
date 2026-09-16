// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// execUpdateRecorder captures the status of every execution PATCH so a test can
// assert the budget-suspend path closes (terminates) the AgentExecution row.
type execUpdateRecorder struct {
	mu       sync.Mutex
	statuses []string
}

func (r *execUpdateRecorder) record(status string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.statuses = append(r.statuses, status)
}

func (r *execUpdateRecorder) all() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string{}, r.statuses...)
}

// execCaptureServer records the status sent to any execution-PATCH endpoint
// (/api/agents/{id}/executions/{exec}) so a suspend tick's terminal close can
// be asserted. Everything else 200s with {} like the other suspend servers.
func execCaptureServer(t *testing.T, boardID string) (*httptest.Server, *execUpdateRecorder) {
	t.Helper()
	rec := &execUpdateRecorder{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		switch {
		case strings.Contains(r.URL.Path, "/executions/") && r.Method == http.MethodPatch:
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if s, ok := body["status"].(string); ok {
				rec.record(s)
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{}"))
		default:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{}"))
		}
	}))
	t.Cleanup(srv.Close)
	return srv, rec
}

// A budget-suspended lifecycle tick must CLOSE its execution with a terminal
// status before returning. The deployment runs a single agent, so an execution
// left in `running` makes the backend's busy-guard 409 every subsequent
// next_assignment (all roles) → the whole pipeline starves. RED until
// tickViaLifecycle's ErrSuspended branch issues the terminal LogExecutionUpdate.
func TestTickViaLifecycle_BudgetSuspend_ClosesExecution(t *testing.T) {
	srv, rec := execCaptureServer(t, "b")
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())

	// Override the llm kind with a stub that mimics the budget cutoff: it engages
	// a card, records the execution id the claim step would have set, then returns
	// the suspend sentinel — exactly the shape Walker.Walk surfaces to the bridge.
	prev := lifecycle.Handlers["llm"]
	t.Cleanup(func() { lifecycle.Handlers["llm"] = prev })
	lifecycle.Handlers["llm"] = func(_ context.Context, ws *lifecycle.WalkState, _ *valaris.LifecycleStep) (string, string, error) {
		ws.Card = &discoverResult{CardID: "card-sus", BoardID: "b", Title: "Big card"}
		ws.ExecutionID = "exec-1"
		return "", "", lifecycle.ErrSuspended
	}

	strat := NewDataDrivenStrategy(valaris.StageConfig{
		Role:      "implementer",
		Lifecycle: []valaris.LifecycleStep{{Name: "implement", Kind: "llm"}},
	}, nil)

	if err := strat.tickViaLifecycle(context.Background(), loop); err != nil {
		t.Fatalf("budget suspend is a clean stop; tickViaLifecycle must return nil, got %v", err)
	}

	statuses := rec.all()
	if len(statuses) == 0 {
		t.Fatal("suspend must close the execution: no execution PATCH was issued; " +
			"the row stays `running` and the backend busy-guard 409s every next_assignment")
	}
	for _, s := range statuses {
		if s == "running" || s == "started" {
			t.Errorf("suspend closed the execution with non-terminal status %q (statuses=%v)", s, statuses)
		}
	}
}
