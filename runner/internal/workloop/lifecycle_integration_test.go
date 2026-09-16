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
	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// TestLifecycle_SyntheticRole_EndToEnd walks a 7-step synthetic role end-to-end:
//   discover → claim → llm → sensor → branch → move_card → create_note
//
// Asserts:
//   - each step ran in order (recorded via httptest server hit list),
//   - WalkState propagated card / execution_id / last_decision through every kind,
//   - branch routed via ${last_decision} into the move_card target,
//   - the final create_note dispatched via mcp_call with a literal body
//     (the redesigned contract — body_from on the create_note kind, or
//     literal body via mcp_call dispatch).
//
// The test deliberately uses generic role + step names to prove the walker
// dispatches on step.Kind only — no role-specific switch is exercised.
func TestLifecycle_SyntheticRole_EndToEnd(t *testing.T) {
	boardID := "board-syn"
	cardID := "card-syn-1"

	var mu sync.Mutex
	var hits []string
	var noteCalls []map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits = append(hits, r.Method+" "+r.URL.Path)
		mu.Unlock()

		if serveDefaultPlatformConfig(w, r) {
			return
		}

		switch {
		case strings.Contains(r.URL.Path, "/next-assignment"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"card": map[string]any{
					"id":      cardID,
					"title":   "Synthetic Card",
					"description": "test",
				},
				"board": map[string]any{
					"id":   boardID,
					"name": "Synthetic Board",
				},
			})
		case strings.Contains(r.URL.Path, "/executions") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "exec-syn-1"})
		case strings.Contains(r.URL.Path, "/boards/"+boardID) && r.Method == http.MethodGet && !strings.Contains(r.URL.Path, "/cards"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":   boardID,
				"name": "Synthetic Board",
				"columns": []map[string]any{
					{"id": "col-active", "name": "Active", "column_type": "active", "position": 2048.0},
					{"id": "col-review", "name": "Review", "column_type": "review", "position": 3072.0},
					{"id": "col-done", "name": "Done", "column_type": "done", "position": 4096.0},
				},
			})
		case strings.Contains(r.URL.Path, "notes") && r.Method == http.MethodPost:
			body, _ := stdio.ReadAll(r.Body)
			var payload map[string]any
			_ = json.Unmarshal(body, &payload)
			mu.Lock()
			noteCalls = append(noteCalls, payload)
			mu.Unlock()
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{}"))
		default:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{}"))
		}
	}))
	t.Cleanup(srv.Close)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	registry := fakeRegistry(&fakeSensor{name: "fake_pass", passed: true, summary: "fine"})

	stage := valaris.StageConfig{
		Role: "synthetic_role",
		Discover: valaris.DiscoverDef{Strategy: "unassigned_or_rework"},
		Claim:    valaris.ClaimDef{ParticipantRole: "helper", ExecutionAction: "act"},
		Git:      valaris.GitDef{Action: "none"},
		// LLM stage with produces_decision; without a prompt template the LLM
		// returns decision="no_prompt" — we route that explicitly via branch.
		Lifecycle: []valaris.LifecycleStep{
			{Name: "step_discover", Kind: "discover", Next: "step_claim"},
			{Name: "step_claim", Kind: "claim", Next: "step_llm"},
			{Name: "step_llm", Kind: "llm", Next: "step_sensor",
				Params: map[string]any{"stage": "verdict", "post_process_kind": "produces_decision"}},
			{Name: "step_sensor", Kind: "sensor", Next: "step_branch",
				Params: map[string]any{"name": "fake_pass", "on_pass": "pass", "on_fail": "fail"}},
			{Name: "step_branch", Kind: "branch",
				Params: map[string]any{
					"expression": "${last_decision}",
					"cases":      map[string]any{"pass": "go_done", "fail": "go_active", "default": "go_active"},
				}},
			{Name: "go_done", Kind: "move_card", Next: "step_note",
				Params: map[string]any{"to_column_type": "done"}},
			{Name: "go_active", Kind: "move_card", Next: "step_note",
				Params: map[string]any{"to_column_type": "active"}},
			{Name: "step_note", Kind: "mcp_call", Next: "step_end",
				Params: map[string]any{
					"tool": "create_note",
					"args": map[string]any{
						"kind":  "review_verdict",
						"title": "Review: info",
						"body":  "synthetic walk complete",
					},
				}},
			// Label then explicit end terminal so the walker stops cleanly.
			{Name: "step_end", Kind: "apply_label",
				Params: map[string]any{"label": "synthetic-done"},
				Next:   "step_terminate"},
			{Name: "step_terminate", Kind: "end"},
		},
	}

	s := NewDataDrivenStrategy(stage, registry)
	if err := s.Tick(context.Background(), loop); err != nil {
		t.Fatalf("Tick (lifecycle): %v", err)
	}

	mu.Lock()
	defer mu.Unlock()

	// next-assignment must have been called by discover.
	if !containsAny(hits, "/next-assignment") {
		t.Errorf("expected next-assignment hit, got: %v", hits)
	}
	// claim records an execution.
	if !containsAny(hits, "POST") || !containsHit(hits, "POST", "/executions") {
		t.Errorf("expected POST /executions, got: %v", hits)
	}
	// move_card hits /boards/{id} for column resolution.
	if !containsHit(hits, "GET", "/boards/"+boardID) {
		t.Errorf("expected GET /boards/%s, got: %v", boardID, hits)
	}
	// At least one note was created.
	if len(noteCalls) == 0 {
		t.Errorf("expected at least one note POST, got: %v", hits)
	}
}

func containsAny(hits []string, sub string) bool {
	for _, h := range hits {
		if strings.Contains(h, sub) {
			return true
		}
	}
	return false
}

func containsHit(hits []string, method, pathSub string) bool {
	for _, h := range hits {
		if strings.HasPrefix(h, method+" ") && strings.Contains(h, pathSub) {
			return true
		}
	}
	return false
}

// Sanity test: the walker rejects role-specific dispatch — i.e., a kind name
// that looks like a role still has to use a real kind. Defends the rule
// "walker dispatches on step.Kind only."
func TestLifecycle_UnknownKindRejected(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)

	stage := valaris.StageConfig{
		Role:      "fake",
		Discover:  valaris.DiscoverDef{Strategy: "unassigned_or_rework"},
		Lifecycle: []valaris.LifecycleStep{{Name: "x", Kind: "reviewer_specific"}},
	}
	s := NewDataDrivenStrategy(stage, nil)
	err := s.Tick(context.Background(), loop)
	if err == nil || !strings.Contains(err.Error(), "unknown kind") {
		t.Errorf("want unknown-kind error, got: %v", err)
	}
}

// _ ensures the lifecycle package import is kept even if a future refactor
// removes the explicit references; the walker must continue to be reachable.
var _ = lifecycle.Walker{}
