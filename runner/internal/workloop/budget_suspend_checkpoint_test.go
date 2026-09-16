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

// labelCaptureServer serves a card with the given labels and records every
// labels=[...] body sent via UpdateCard so a test can assert the final label
// set the suspend path wrote. The card GET returns whatever labels the test
// seeds (so the read-modify-write label helpers see prior passes).
func labelCaptureServer(t *testing.T, boardID string, seedLabels []string) (*httptest.Server, *labelRecorder) {
	t.Helper()
	rec := &labelRecorder{seed: seedLabels}
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
		case strings.Contains(r.URL.Path, "/cards/") && r.Method == http.MethodGet && !strings.Contains(r.URL.Path, "/search"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "card-sus", "title": "T", "labels": rec.current(),
			})
		case strings.Contains(r.URL.Path, "/cards/") && (r.Method == http.MethodPut || r.Method == http.MethodPatch):
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if raw, ok := body["labels"]; ok {
				rec.setLabels(raw)
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

type labelRecorder struct {
	mu    sync.Mutex
	seed  []string
	last  []string
	wrote bool
}

func (r *labelRecorder) current() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.wrote {
		return append([]string{}, r.last...)
	}
	return append([]string{}, r.seed...)
}

func (r *labelRecorder) setLabels(raw any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	arr, ok := raw.([]any)
	if !ok {
		return
	}
	out := make([]string, 0, len(arr))
	for _, v := range arr {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	r.last = out
	r.wrote = true
}

func (r *labelRecorder) finalLabels() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.wrote {
		return append([]string{}, r.last...)
	}
	return append([]string{}, r.seed...)
}

func hasLabel(labels []string, want string) bool {
	for _, l := range labels {
		if l == want {
			return true
		}
	}
	return false
}

func suspendTestSetup(t *testing.T, seedLabels []string) (*Loop, *DataDrivenStrategy, *discoverResult, string, *labelRecorder) {
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
	srv, rec := labelCaptureServer(t, "b", seedLabels)
	cfg := testConfig()
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, cfg)
	strat := writesCodeStrategy()
	card := &discoverResult{CardID: "card-sus", BoardID: "b", Title: "Suspend me", DefaultBranch: "main", Labels: seedLabels}
	return loop, strat, card, repoDir, rec
}

// Dirty tree at budget cutoff: commit the WIP, apply budget-suspended +
// budget-pass-1, do NOT wipe the branch, and stop the walk cleanly (no error
// → walker won't route to the wiping on_failure branch).
func TestCheckpointAndSuspend_DirtyTree_CommitsAndLabels(t *testing.T) {
	loop, strat, card, repoDir, rec := suspendTestSetup(t, nil)
	// Uncommitted WIP — the ~80%-done work a cutoff leaves behind.
	if err := os.WriteFile(filepath.Join(repoDir, "wip.py"), []byte("partial\n"), 0644); err != nil {
		t.Fatalf("write wip: %v", err)
	}

	be := &budgetSuspendError{costDelta: 5.9, budget: 6.0}
	suspended, err := strat.checkpointAndSuspend(context.Background(), loop, card, repoDir, false, be)
	if err != nil {
		t.Fatalf("checkpointAndSuspend must succeed (clean stop), got error: %v", err)
	}
	if !suspended {
		t.Error("dirty tree with work must be suspended (handled=true)")
	}

	// WIP must be committed: tree clean + branch ahead.
	has, _ := loop.git.HasChanges(context.Background(), repoDir)
	if has {
		t.Error("WIP must be committed (clean tree) after suspend")
	}
	ahead, _ := loop.git.CommitsAheadOfRemoteDefault(context.Background(), repoDir, "main")
	if ahead == 0 {
		t.Error("branch must be ahead of origin/main after WIP checkpoint commit")
	}

	final := rec.finalLabels()
	if !hasLabel(final, budgetSuspendedLabel) {
		t.Errorf("final labels %v must include %q", final, budgetSuspendedLabel)
	}
	if !hasLabel(final, "budget-pass-1") {
		t.Errorf("final labels %v must include budget-pass-1", final)
	}
}

// Empty tree, nothing committed, branch not ahead: there is no work to save.
// Suspending would park a card that resumes to the same empty state and re-burns
// identically. Must NOT suspend — return the underlying error so the normal
// failure path (which harmlessly wipes the empty branch) runs.
func TestCheckpointAndSuspend_EmptyTree_FallsThroughToFailure(t *testing.T) {
	loop, strat, card, repoDir, rec := suspendTestSetup(t, nil)
	be := &budgetSuspendError{costDelta: 5.9, budget: 6.0}

	suspended, err := strat.checkpointAndSuspend(context.Background(), loop, card, repoDir, false, be)
	if suspended {
		t.Error("empty tree must NOT be suspended (handled=false)")
	}
	if err == nil {
		t.Fatal("empty tree must propagate the error to the failure path")
	}
	if rec.wrote {
		t.Error("empty tree must not apply any suspend labels")
	}
}

// Already-committed work (clean tree, branch ahead) at cutoff: don't try to
// commit (CommitAll would error "no changes"), but still label + suspend.
func TestCheckpointAndSuspend_CleanButAhead_LabelsWithoutCommit(t *testing.T) {
	loop, strat, card, repoDir, rec := suspendTestSetup(t, nil)
	if err := os.WriteFile(filepath.Join(repoDir, "done.py"), []byte("committed\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := loop.git.CommitAll(context.Background(), repoDir, "feat: prior work"); err != nil {
		t.Fatalf("commit: %v", err)
	}

	be := &budgetSuspendError{costDelta: 5.9, budget: 6.0}
	suspended, err := strat.checkpointAndSuspend(context.Background(), loop, card, repoDir, false, be)
	if err != nil {
		t.Fatalf("clean-but-ahead must suspend cleanly, got: %v", err)
	}
	if !suspended {
		t.Error("clean-but-ahead has work to resume; must be suspended (handled=true)")
	}
	if !hasLabel(rec.finalLabels(), budgetSuspendedLabel) {
		t.Error("clean-but-ahead must still apply the suspend label")
	}
}

// Terminal guard: a card already at the max-pass cap must NOT suspend again.
// It clears the suspend labels and returns the error so it escalates to the
// normal failure path (human/escalation) — the runaway backstop.
func TestCheckpointAndSuspend_TerminalGuard_ClearsLabelsAndFails(t *testing.T) {
	// Seed the card at the cap (default max passes 5).
	seed := []string{budgetSuspendedLabel, "budget-pass-5"}
	loop, strat, card, repoDir, rec := suspendTestSetup(t, seed)
	if err := os.WriteFile(filepath.Join(repoDir, "wip.py"), []byte("more\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	be := &budgetSuspendError{costDelta: 5.9, budget: 6.0}
	suspended, err := strat.checkpointAndSuspend(context.Background(), loop, card, repoDir, false, be)
	if suspended {
		t.Fatal("terminal guard must escalate, not suspend again (handled=false)")
	}
	if err == nil {
		t.Fatal("terminal guard must return the error to escalate to the failure path")
	}
	final := rec.finalLabels()
	if hasLabel(final, budgetSuspendedLabel) {
		t.Errorf("terminal guard must clear %q; final labels %v", budgetSuspendedLabel, final)
	}
	for _, l := range final {
		if strings.HasPrefix(l, "budget-pass-") {
			t.Errorf("terminal guard must clear budget-pass-* labels; found %q", l)
		}
	}
}

func TestParseBudgetPass(t *testing.T) {
	cases := []struct {
		labels []string
		want   int
	}{
		{nil, 0},
		{[]string{"budget-pass-3"}, 3},
		{[]string{"other", "budget-pass-2", "x"}, 2},
		{[]string{"budget-pass-2", "budget-pass-4"}, 4}, // max-of-valid wins
		{[]string{"budget-pass-x", "budget-pass-"}, 0},  // malformed → 0
		{[]string{"budget-pass-0"}, 0},
	}
	for _, tc := range cases {
		if got := parseBudgetPass(tc.labels); got != tc.want {
			t.Errorf("parseBudgetPass(%v)=%d want %d", tc.labels, got, tc.want)
		}
	}
}
