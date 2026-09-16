// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// suspendUnassignServer is labelCaptureServer + participant-DELETE capture. A
// budget-suspended card must shed its implementer hero participant so the
// `unassigned_or_rework` discover (which skips heroed cards) can re-offer it for
// the resume pass. Without the unassign the card strands in `active`, heroed,
// invisible to a fresh scan — the runner idles with the WIP checkpoint orphaned.
func suspendUnassignServer(t *testing.T, boardID string, seedLabels []string) (*httptest.Server, *unassignRecorder) {
	t.Helper()
	rec := &unassignRecorder{labels: &labelRecorder{seed: seedLabels}}
	columns := []map[string]any{
		{"id": "col-active", "name": "Active", "column_type": "active", "position": 2048.0},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		switch {
		case strings.Contains(r.URL.Path, "/boards/"+boardID) && r.Method == http.MethodGet && !strings.Contains(r.URL.Path, "/cards"):
			_ = json.NewEncoder(w).Encode(map[string]any{"id": boardID, "name": "B", "columns": columns})
		case strings.Contains(r.URL.Path, "/participants/") && r.Method == http.MethodDelete:
			rec.recordDelete(r.URL.Path)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{}"))
		case strings.Contains(r.URL.Path, "/cards/") && r.Method == http.MethodGet && !strings.Contains(r.URL.Path, "/search"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "card-sus", "title": "T", "labels": rec.labels.current(),
			})
		case strings.Contains(r.URL.Path, "/cards/") && (r.Method == http.MethodPut || r.Method == http.MethodPatch):
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if raw, ok := body["labels"]; ok {
				rec.labels.setLabels(raw)
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

type unassignRecorder struct {
	mu      sync.Mutex
	deletes []string
	labels  *labelRecorder
}

func (r *unassignRecorder) recordDelete(path string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.deletes = append(r.deletes, path)
}

// removedUser reports whether a participant DELETE was issued for userID.
func (r *unassignRecorder) removedUser(userID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, p := range r.deletes {
		if strings.HasSuffix(p, "/participants/"+userID) {
			return true
		}
	}
	return false
}

func suspendUnassignSetup(t *testing.T, seedLabels []string) (*Loop, *DataDrivenStrategy, *discoverResult, string, *unassignRecorder) {
	t.Helper()
	bare := initBareRemote(t)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, "sus-repo")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	if _, _, err := gitMgr.CreateBranch(context.Background(), repoDir, "card-sus", "main"); err != nil {
		t.Fatalf("create branch: %v", err)
	}
	srv, rec := suspendUnassignServer(t, "b", seedLabels)
	cfg := testConfig()
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, cfg)
	strat := writesCodeStrategy()
	card := &discoverResult{CardID: "card-sus", BoardID: "b", Title: "Suspend me", DefaultBranch: "main", Labels: seedLabels}
	return loop, strat, card, repoDir, rec
}

// A successful suspend MUST unassign the implementer's hero participant. The
// test client's UserID is "user-1" (the hero on a runner-claimed card); the
// suspend path must DELETE that participant so `unassigned_or_rework` re-offers
// the card for resume. RED until checkpointAndSuspend calls RemoveCardParticipant.
func TestCheckpointAndSuspend_ClearsHeroForResume(t *testing.T) {
	loop, strat, card, repoDir, rec := suspendUnassignSetup(t, nil)
	if err := os.WriteFile(filepath.Join(repoDir, "wip.py"), []byte("partial\n"), 0644); err != nil {
		t.Fatalf("write wip: %v", err)
	}

	be := &budgetSuspendError{costDelta: 5.9, budget: 6.0}
	suspended, err := strat.checkpointAndSuspend(context.Background(), loop, card, repoDir, false, be)
	if err != nil {
		t.Fatalf("checkpointAndSuspend must succeed (clean stop), got error: %v", err)
	}
	if !suspended {
		t.Fatal("dirty tree with work must be suspended (handled=true)")
	}

	if !rec.removedUser(loop.client.UserID) {
		t.Errorf("suspend must unassign the hero (%q) so unassigned_or_rework can re-offer the card; "+
			"no participant DELETE for that user was issued (deletes=%v)", loop.client.UserID, rec.deletes)
	}
	// Sanity: the suspend labels still land (unassign is additive, not a replacement).
	if !hasLabel(rec.labels.finalLabels(), budgetSuspendedLabel) {
		t.Errorf("suspend must still apply %q", budgetSuspendedLabel)
	}
}

// The terminal guard escalates to the normal failure path (the runaway backstop),
// which owns its own cleanup. The guard must NOT also unassign here — it returns
// the error and the failure path handles the participant. (Guards against a
// double-unassign / wrong-path cleanup regression.)
func TestCheckpointAndSuspend_TerminalGuard_DoesNotUnassign(t *testing.T) {
	seed := []string{budgetSuspendedLabel, "budget-pass-5"}
	loop, strat, card, repoDir, rec := suspendUnassignSetup(t, seed)
	if err := os.WriteFile(filepath.Join(repoDir, "wip.py"), []byte("more\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	be := &budgetSuspendError{costDelta: 5.9, budget: 6.0}
	suspended, err := strat.checkpointAndSuspend(context.Background(), loop, card, repoDir, false, be)
	if suspended {
		t.Fatal("terminal guard must escalate, not suspend (handled=false)")
	}
	if err == nil {
		t.Fatal("terminal guard must return the error to escalate")
	}
	if rec.removedUser(loop.client.UserID) {
		t.Error("terminal guard must NOT unassign; the escalated failure path owns cleanup")
	}
}
