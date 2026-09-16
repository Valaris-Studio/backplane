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

// FOLLOWUP-9: when a lifecycle handler returns a non-ErrNoWork error
// mid-walk, the runner must release the card claim and mark the in-flight
// execution failed. Without this, the card stays heroed forever, every
// subsequent /next-assignment tick 409s with agent_busy, and the runner
// is stuck in a 5s backoff loop.
//
// This test plants a lifecycle that:
//
//	discover  → claim  → bomb (apply_label with no label param fails)
//
// and asserts after the failed Tick:
//   - the execution PATCH (status=failed) was sent
//   - the card participant removal was sent
//
// Mirrors the legacy DataDrivenStrategy.Tick failure path
// (strategy_generic.go: s.failWithConfig + cleanup) which the new walker
// bypassed.
func TestLifecycle_FailedStep_FailsExecutionAndUnassignsCard(t *testing.T) {
	boardID := "board-cleanup"
	cardID := "card-cleanup-1"
	execID := "exec-cleanup-1"
	agentUserID := "user-cleanup-1"

	var (
		mu                      sync.Mutex
		execPatchSeen           bool
		execPatchStatusFailed   bool
		removeParticipantSeen   bool
		removeParticipantTarget string
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		path := r.URL.Path
		switch {
		case strings.Contains(path, "/next-assignment"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"card":  map[string]any{"id": cardID, "title": "Fail me"},
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
			if s, _ := payload["status"].(string); s == "failed" {
				execPatchStatusFailed = true
			}
			mu.Unlock()
			w.Write([]byte("{}"))
		case strings.Contains(path, "/boards/"+boardID) && r.Method == http.MethodGet && !strings.Contains(path, "/cards"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":   boardID,
				"name": "B",
				"columns": []map[string]any{
					{"id": "col-backlog", "name": "To Do", "column_type": "backlog", "position": 1024.0},
				},
			})
		case strings.Contains(path, "/cards/"+cardID+"/participants/") && r.Method == http.MethodDelete:
			mu.Lock()
			removeParticipantSeen = true
			// Path tail is the user_id being unassigned.
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
	client.UserID = agentUserID
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	stage := valaris.StageConfig{
		Role:      "synth",
		Discover:  valaris.DiscoverDef{Strategy: "unassigned_or_rework"},
		Claim:     valaris.ClaimDef{ParticipantRole: "hero", ExecutionAction: "act"},
		OnFailure: valaris.ActionDef{MoveToColumnType: "backlog", Unassign: true},
		Lifecycle: []valaris.LifecycleStep{
			{Name: "step_discover", Kind: "discover", Next: "step_claim"},
			{Name: "step_claim", Kind: "claim", Next: "step_bomb"},
			// apply_label without `label` param returns an error from the
			// handler — a clean way to fail mid-walk without touching the
			// kind registry.
			{Name: "step_bomb", Kind: "apply_label"},
		},
	}

	s := NewDataDrivenStrategy(stage, nil)
	err := s.Tick(context.Background(), loop)
	if err == nil {
		t.Fatalf("expected Tick to return the lifecycle error, got nil")
	}

	mu.Lock()
	defer mu.Unlock()
	if !execPatchSeen {
		t.Errorf("expected PATCH /executions/%s after mid-walk failure, none seen", execID)
	}
	if !execPatchStatusFailed {
		t.Errorf("expected execution PATCH status=failed, got payload without that field")
	}
	if !removeParticipantSeen {
		t.Errorf("expected DELETE /cards/%s/participants/<user> to release the claim, none seen", cardID)
	}
	if removeParticipantTarget != "" && removeParticipantTarget != agentUserID {
		t.Errorf("removed participant = %q, want %q (the agent's owner user_id)", removeParticipantTarget, agentUserID)
	}
}

// On-failure with stay_in_column (documentator-style) must still release the
// claim and fail the execution, just without moving the card. Verifies the
// fix routes through failDocExecution, not just failExecutionTo.
func TestLifecycle_FailedStep_StayInColumn_FailsExecutionAndUnassigns(t *testing.T) {
	boardID := "board-cleanup-stay"
	cardID := "card-cleanup-stay"
	execID := "exec-cleanup-stay"

	var (
		mu                    sync.Mutex
		execPatchSeen         bool
		removeParticipantSeen bool
		moveSeen              bool
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		path := r.URL.Path
		switch {
		case strings.Contains(path, "/next-assignment"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"card":  map[string]any{"id": cardID, "title": "Fail-stay"},
				"board": map[string]any{"id": boardID, "name": "B"},
			})
		case strings.Contains(path, "/executions") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]string{"id": execID})
		case strings.Contains(path, "/executions/"+execID) && r.Method == http.MethodPatch:
			mu.Lock()
			execPatchSeen = true
			mu.Unlock()
			w.Write([]byte("{}"))
		case strings.Contains(path, "/cards/"+cardID+"/move"):
			mu.Lock()
			moveSeen = true
			mu.Unlock()
			w.Write([]byte("{}"))
		case strings.Contains(path, "/cards/"+cardID+"/participants/") && r.Method == http.MethodDelete:
			mu.Lock()
			removeParticipantSeen = true
			mu.Unlock()
			w.Write([]byte("{}"))
		default:
			w.Write([]byte("{}"))
		}
	}))
	t.Cleanup(srv.Close)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	client.UserID = "user-stay-1"
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	stage := valaris.StageConfig{
		Role:      "synth",
		Discover:  valaris.DiscoverDef{Strategy: "unassigned_or_rework"},
		Claim:     valaris.ClaimDef{ParticipantRole: "helper", ExecutionAction: "doc"},
		OnFailure: valaris.ActionDef{StayInColumn: true, Unassign: true},
		Lifecycle: []valaris.LifecycleStep{
			{Name: "step_discover", Kind: "discover", Next: "step_claim"},
			{Name: "step_claim", Kind: "claim", Next: "step_bomb"},
			{Name: "step_bomb", Kind: "apply_label"},
		},
	}

	s := NewDataDrivenStrategy(stage, nil)
	_ = s.Tick(context.Background(), loop)

	mu.Lock()
	defer mu.Unlock()
	if !execPatchSeen {
		t.Errorf("stay-in-column failure: expected execution PATCH, got none")
	}
	if !removeParticipantSeen {
		t.Errorf("stay-in-column failure: expected DELETE participants, got none")
	}
	if moveSeen {
		t.Errorf("stay-in-column failure: card was moved; on_failure.stay_in_column should suppress moves")
	}
}

// An UNCONFIGURED on_failure must keep the card in its current column so the
// same stage retries it next poll — NOT fall back to a backlog move. The old
// "backlog" back-compat default strands any labeled mid-pipeline card in a
// column no role scans (run B, 2026-06-10: a failed reviewer tick dumped a
// `planned` card from review into backlog where planner/implementer/reviewer
// all exclude it; same for a done-column card mid ui-validation).
func TestLifecycle_FailedStep_UnconfiguredOnFailure_DoesNotMoveCard(t *testing.T) {
	boardID := "board-stayput"
	cardID := "card-stayput-1"
	execID := "exec-stayput-1"

	var (
		mu                    sync.Mutex
		execPatchStatusFailed bool
		removeParticipantSeen bool
		moveSeen              bool
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		path := r.URL.Path
		switch {
		case strings.Contains(path, "/next-assignment"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"card":  map[string]any{"id": cardID, "title": "Fail me in place"},
				"board": map[string]any{"id": boardID, "name": "B"},
			})
		case strings.Contains(path, "/executions") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]string{"id": execID})
		case strings.Contains(path, "/executions/"+execID) && r.Method == http.MethodPatch:
			body, _ := stdio.ReadAll(r.Body)
			var payload map[string]any
			_ = json.Unmarshal(body, &payload)
			mu.Lock()
			if s, _ := payload["status"].(string); s == "failed" {
				execPatchStatusFailed = true
			}
			mu.Unlock()
			w.Write([]byte("{}"))
		case strings.Contains(path, "/cards/"+cardID+"/move"):
			mu.Lock()
			moveSeen = true
			mu.Unlock()
			w.Write([]byte("{}"))
		case strings.Contains(path, "/cards/"+cardID+"/participants/") && r.Method == http.MethodDelete:
			mu.Lock()
			removeParticipantSeen = true
			mu.Unlock()
			w.Write([]byte("{}"))
		case strings.Contains(path, "/boards/"+boardID) && r.Method == http.MethodGet && !strings.Contains(path, "/cards"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": boardID, "name": "B",
				"columns": []map[string]any{
					{"id": "col-backlog", "name": "To Do", "column_type": "backlog", "position": 1024.0},
					{"id": "col-review", "name": "Review", "column_type": "review", "position": 2048.0},
				},
			})
		default:
			w.Write([]byte("{}"))
		}
	}))
	t.Cleanup(srv.Close)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	client.UserID = "user-stayput"
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	stage := valaris.StageConfig{
		Role:     "synth",
		Discover: valaris.DiscoverDef{Strategy: "unassigned_or_rework"},
		Claim:    valaris.ClaimDef{ParticipantRole: "hero", ExecutionAction: "act"},
		// OnFailure deliberately zero-value: no stay_in_column, no
		// move_to_column_type — the shape every live default stage ships with.
		Lifecycle: []valaris.LifecycleStep{
			{Name: "step_discover", Kind: "discover", Next: "step_claim"},
			{Name: "step_claim", Kind: "claim", Next: "step_bomb"},
			{Name: "step_bomb", Kind: "apply_label"},
		},
	}

	s := NewDataDrivenStrategy(stage, nil)
	if err := s.Tick(context.Background(), loop); err == nil {
		t.Fatalf("expected Tick to return the lifecycle error, got nil")
	}

	mu.Lock()
	defer mu.Unlock()
	if !execPatchStatusFailed {
		t.Errorf("expected execution PATCH status=failed")
	}
	if !removeParticipantSeen {
		t.Errorf("expected participant release on failure")
	}
	if moveSeen {
		t.Errorf("unconfigured on_failure must NOT move the card (stay-in-column retry); saw a /move call")
	}
}

// stay_in_column (explicit or defaulted) must NOT bypass the failure-threshold
// force-block: once the projected count reaches MaxReworkAttempts the card must
// take the durable park (blocked label + blocked-column move) like any other
// stage — otherwise a stay-in-column stage money-loops forever on a card whose
// only breaker is in-memory (lost on restart).
func TestLifecycle_FailedStep_StayInColumn_ThresholdForceBlocks(t *testing.T) {
	boardID := "board-stay-threshold"
	cardID := "card-stay-threshold"
	execID := "exec-stay-threshold"

	var (
		mu             sync.Mutex
		moveTargetCol  string
		labelsStamped  []string
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		path := r.URL.Path
		switch {
		case strings.Contains(path, "/next-assignment"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"card":  map[string]any{"id": cardID, "title": "Threshold me"},
				"board": map[string]any{"id": boardID, "name": "B"},
			})
		case strings.Contains(path, "/executions") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]string{"id": execID})
		case strings.Contains(path, "/cards/"+cardID+"/move"):
			body, _ := stdio.ReadAll(r.Body)
			var payload map[string]any
			_ = json.Unmarshal(body, &payload)
			mu.Lock()
			moveTargetCol, _ = payload["column_id"].(string)
			mu.Unlock()
			w.Write([]byte("{}"))
		case strings.HasSuffix(path, "/cards/"+cardID) && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": cardID, "title": "Threshold me", "labels": []string{"planned"},
			})
		case strings.HasSuffix(path, "/cards/"+cardID) && r.Method == http.MethodPatch:
			body, _ := stdio.ReadAll(r.Body)
			var payload map[string]any
			_ = json.Unmarshal(body, &payload)
			mu.Lock()
			if raw, ok := payload["labels"].([]any); ok {
				labelsStamped = nil
				for _, v := range raw {
					if s, ok := v.(string); ok {
						labelsStamped = append(labelsStamped, s)
					}
				}
			}
			mu.Unlock()
			w.Write([]byte("{}"))
		case strings.Contains(path, "/boards/"+boardID) && r.Method == http.MethodGet && !strings.Contains(path, "/cards"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": boardID, "name": "B",
				"columns": []map[string]any{
					{"id": "col-done", "name": "Done", "column_type": "done", "position": 1024.0},
					{"id": "col-blocked", "name": "Blocked", "column_type": "blocked", "position": 2048.0},
				},
			})
		default:
			w.Write([]byte("{}"))
		}
	}))
	t.Cleanup(srv.Close)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	client.UserID = "user-stay-threshold"
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	// Seed the card one strike short of the threshold; this Tick's failure is
	// the one that must trip the durable force-block.
	for i := 0; i < defaultMaxReworkAttempts-1; i++ {
		loop.recordFailure("seed strike", cardID)
	}

	stage := valaris.StageConfig{
		Role:      "synth",
		Discover:  valaris.DiscoverDef{Strategy: "unassigned_or_rework"},
		Claim:     valaris.ClaimDef{ParticipantRole: "hero", ExecutionAction: "act"},
		OnFailure: valaris.ActionDef{StayInColumn: true, Unassign: true},
		Lifecycle: []valaris.LifecycleStep{
			{Name: "step_discover", Kind: "discover", Next: "step_claim"},
			{Name: "step_claim", Kind: "claim", Next: "step_bomb"},
			{Name: "step_bomb", Kind: "apply_label"},
		},
	}

	s := NewDataDrivenStrategy(stage, nil)
	if err := s.Tick(context.Background(), loop); err == nil {
		t.Fatalf("expected Tick to return the lifecycle error, got nil")
	}

	mu.Lock()
	defer mu.Unlock()
	if moveTargetCol != "col-blocked" {
		t.Errorf("at threshold the card must move to the blocked column, moved to %q", moveTargetCol)
	}
	blockedStamped := false
	for _, lbl := range labelsStamped {
		if lbl == "blocked" {
			blockedStamped = true
		}
	}
	if !blockedStamped {
		t.Errorf("at threshold the durable `blocked` label must be stamped, labels patched: %v", labelsStamped)
	}
}
