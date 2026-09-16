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

// FOLLOWUP-12: when a lifecycle terminates cleanly on a kind that doesn't
// itself mark the execution complete (e.g. apply_label, move_card,
// create_note), the walker post-step must mark it complete. Without this, the
// documentator's lifecycle (... → generate_docs → apply_label) leaves its
// execution `running` forever — every subsequent next-assignment 409s with
// agent_busy and the runner wedges. Smoke round 4 (2026-05-16) reproduced
// this on card 2d471ad2 after a successful end-to-end run.
//
// The contract:
//
//   - On clean Walker.Walk exit (err == nil), if ws.ExecutionID is set AND no
//     prior step has set ws.Set("execution_released", true), the
//     tickViaLifecycle bridge calls LogExecutionUpdate(status=completed).
//   - ship (and any future kind that releases inline) sets the sentinel so the
//     post-walk cleanup skips it — exactly one PATCH per execution.
//   - Participant removal is NOT done by the cleanup: legacy keeps hero/helper
//     attached as the record of who worked the card. on_success.Unassign on a
//     branch-action path is the explicit way to opt in.

func TestLifecycle_SuccessfulEnd_ApplyLabel_ReleasesExecutionAndParticipant(t *testing.T) {
	boardID := "board-success-apply-label"
	cardID := "card-success-apply-label"
	execID := "exec-success-apply-label"
	userID := "user-success-1"

	var (
		mu                       sync.Mutex
		execPatchSeen            bool
		execPatchStatusCompleted bool
		execPatchCount           int
		removeParticipantSeen    bool
		removeParticipantTarget  string
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		path := r.URL.Path
		switch {
		case strings.Contains(path, "/next-assignment"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"card":  map[string]any{"id": cardID, "title": "Doc-stretch"},
				"board": map[string]any{"id": boardID, "name": "B"},
			})
		case strings.Contains(path, "/executions") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]string{"id": execID})
		case strings.Contains(path, "/executions/"+execID) && r.Method == http.MethodPatch:
			body, _ := stdio.ReadAll(r.Body)
			var payload map[string]any
			_ = json.Unmarshal(body, &payload)
			mu.Lock()
			execPatchSeen = true
			execPatchCount++
			if s, _ := payload["status"].(string); s == "completed" {
				execPatchStatusCompleted = true
			}
			mu.Unlock()
			w.Write([]byte("{}"))
		case strings.Contains(path, "/cards/"+cardID) && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":     cardID,
				"title":  "Doc-stretch",
				"labels": []string{},
			})
		case strings.Contains(path, "/cards/"+cardID) && r.Method == http.MethodPatch:
			w.Write([]byte("{}"))
		case strings.Contains(path, "/cards/"+cardID+"/participants/") && r.Method == http.MethodDelete:
			mu.Lock()
			removeParticipantSeen = true
			parts := strings.Split(path, "/")
			removeParticipantTarget = parts[len(parts)-1]
			mu.Unlock()
			w.Write([]byte("{}"))
		default:
			w.Write([]byte("{}"))
		}
	}))
	t.Cleanup(srv.Close)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	client.UserID = userID
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	stage := valaris.StageConfig{
		Role:     "documentator",
		Discover: valaris.DiscoverDef{Strategy: "unassigned_or_rework"},
		Claim:    valaris.ClaimDef{ParticipantRole: "helper", ExecutionAction: "document_card"},
		Lifecycle: []valaris.LifecycleStep{
			{Name: "step_discover", Kind: "discover", Next: "step_claim"},
			{Name: "step_claim", Kind: "claim", Next: "step_label"},
			{Name: "step_label", Kind: "apply_label", Params: map[string]any{"label": "documented"}, Next: "step_end"},
			{Name: "step_end", Kind: "end"},
		},
	}

	s := NewDataDrivenStrategy(stage, nil)
	if err := s.Tick(context.Background(), loop); err != nil {
		t.Fatalf("Tick: unexpected error %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if !execPatchSeen {
		t.Errorf("expected PATCH /executions/%s after clean walk, none seen", execID)
	}
	if !execPatchStatusCompleted {
		t.Errorf("expected exec PATCH status=completed, got payload without it (count=%d)", execPatchCount)
	}
	// Legacy semantics: helper participant stays as the record of work; we
	// don't auto-unassign on success. Sanity-check the cleanup didn't quietly
	// add a participant-removal side effect.
	if removeParticipantSeen {
		t.Errorf("unexpected DELETE /cards/%s/participants/%s — cleanup must not auto-unassign on success", cardID, removeParticipantTarget)
	}
}

// ship sets the sentinel; post-walk cleanup must NOT re-release the execution
// or re-remove the participant. Regression guard against double-cleanup.
func TestLifecycle_SuccessfulEnd_Ship_DoesNotDoubleReleaseExecution(t *testing.T) {
	boardID := "board-ship-dup"
	cardID := "card-ship-dup"
	execID := "exec-ship-dup"
	userID := "user-ship-1"

	var (
		mu                       sync.Mutex
		execPatchCount           int
		removeParticipantCount   int
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		path := r.URL.Path
		switch {
		case strings.Contains(path, "/next-assignment"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"card":  map[string]any{"id": cardID, "title": "Shipper"},
				"board": map[string]any{"id": boardID, "name": "B"},
			})
		case strings.Contains(path, "/executions") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]string{"id": execID})
		case strings.Contains(path, "/executions/"+execID) && r.Method == http.MethodPatch:
			mu.Lock()
			execPatchCount++
			mu.Unlock()
			w.Write([]byte("{}"))
		case strings.Contains(path, "/boards/"+boardID) && r.Method == http.MethodGet && !strings.Contains(path, "/cards"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":   boardID,
				"name": "B",
				"columns": []map[string]any{
					{"id": "col-review", "name": "Review", "column_type": "review", "position": 3072.0},
				},
			})
		case strings.Contains(path, "/cards/"+cardID) && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":          cardID,
				"title":       "Shipper",
				"description": "",
			})
		case strings.Contains(path, "/cards/"+cardID) && r.Method == http.MethodPatch:
			w.Write([]byte("{}"))
		case strings.Contains(path, "/cards/"+cardID+"/participants/") && r.Method == http.MethodDelete:
			mu.Lock()
			removeParticipantCount++
			mu.Unlock()
			w.Write([]byte("{}"))
		default:
			w.Write([]byte("{}"))
		}
	}))
	t.Cleanup(srv.Close)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	client.UserID = userID
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	stage := valaris.StageConfig{
		Role:     "orchestrator",
		Discover: valaris.DiscoverDef{Strategy: "unassigned_or_rework"},
		Claim:    valaris.ClaimDef{ParticipantRole: "hero", ExecutionAction: "implement_card"},
		Lifecycle: []valaris.LifecycleStep{
			{Name: "step_discover", Kind: "discover", Next: "step_claim"},
			{Name: "step_claim", Kind: "claim", Next: "step_ship"},
			{Name: "step_ship", Kind: "ship", Params: map[string]any{"to_column_type": "review"}},
		},
	}

	s := NewDataDrivenStrategy(stage, nil)
	if err := s.Tick(context.Background(), loop); err != nil {
		t.Fatalf("Tick: unexpected error %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	// ship marks exec completed exactly once. Post-walk cleanup must skip it.
	if execPatchCount != 1 {
		t.Errorf("execution PATCH count = %d, want 1 (ship's own release, no double-cleanup)", execPatchCount)
	}
	// Legacy semantics: orchestrator hero stays attached after ship as the
	// "who implemented this" record. No participant removal on success.
	if removeParticipantCount != 0 {
		t.Errorf("remove-participant count = %d, want 0 (no auto-unassign on success)", removeParticipantCount)
	}
}
