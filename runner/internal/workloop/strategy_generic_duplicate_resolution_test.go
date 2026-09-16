// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// duplicateCloseServer records the wire effects of a duplicate-close: the card
// move (POST /cards/{id}/move), the label PATCH (PATCH /cards/{id} with a
// labels array), and any /notes POSTs. It serves a 4-type board so
// moveCardToColumnType can resolve the success column, and a card GET so
// addLabel can read existing labels.
type dupCloseCapture struct {
	mu          sync.Mutex
	moves       []map[string]any // bodies PATCHed to /cards/{id}/move
	patches     []map[string]any // bodies PATCHed to /cards/{id}
	notes       []map[string]any // bodies POSTed to /notes
	unassigns   []string         // paths of DELETE /cards/{id}/participants/{uid}
	execPatches []map[string]any // bodies PATCHed to /agents/{id}/executions/{id}
	moveColID   string
	// cardGET overrides the default GET /cards/{id} payload when non-nil, so
	// tests can control the labels/description the runner reads back.
	cardGET map[string]any
	// failCardPatch makes PATCH /cards/{id} return 500 — injects a label-write
	// failure so park paths can prove they don't claim success without binding.
	failCardPatch bool
}

func duplicateCloseServer(t *testing.T, boardID string) (*httptest.Server, *dupCloseCapture) {
	t.Helper()
	cap := &dupCloseCapture{}
	columns := []map[string]any{
		{"id": "col-backlog", "name": "To Do", "column_type": "backlog", "position": 1024.0},
		{"id": "col-active", "name": "Active", "column_type": "active", "position": 2048.0},
		{"id": "col-review", "name": "Review", "column_type": "review", "position": 3072.0},
		{"id": "col-done", "name": "Done", "column_type": "done", "position": 4096.0},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		body, _ := io.ReadAll(r.Body)
		var decoded map[string]any
		_ = json.Unmarshal(body, &decoded)

		switch {
		case strings.HasSuffix(r.URL.Path, "/move") && r.Method == http.MethodPatch:
			cap.mu.Lock()
			cap.moves = append(cap.moves, decoded)
			if cid, ok := decoded["column_id"].(string); ok {
				cap.moveColID = cid
			}
			cap.mu.Unlock()
		case strings.HasSuffix(r.URL.Path, "/notes") && r.Method == http.MethodPost:
			cap.mu.Lock()
			cap.notes = append(cap.notes, decoded)
			cap.mu.Unlock()
		case strings.Contains(r.URL.Path, "/participants/") && r.Method == http.MethodDelete:
			cap.mu.Lock()
			cap.unassigns = append(cap.unassigns, r.URL.Path)
			cap.mu.Unlock()
		case strings.Contains(r.URL.Path, "/executions/") && r.Method == http.MethodPatch:
			cap.mu.Lock()
			cap.execPatches = append(cap.execPatches, decoded)
			cap.mu.Unlock()
		case strings.Contains(r.URL.Path, "/cards/") && r.Method == http.MethodPatch:
			cap.mu.Lock()
			fail := cap.failCardPatch
			if !fail {
				cap.patches = append(cap.patches, decoded)
			}
			cap.mu.Unlock()
			if fail {
				w.WriteHeader(http.StatusInternalServerError)
				_, _ = w.Write([]byte(`{"detail":"injected label-write failure"}`))
				return
			}
		case strings.Contains(r.URL.Path, "/boards/"+boardID) && r.Method == http.MethodGet && !strings.Contains(r.URL.Path, "/cards"):
			_ = json.NewEncoder(w).Encode(map[string]any{"id": boardID, "name": "B", "columns": columns})
			return
		case strings.Contains(r.URL.Path, "/cards/") && r.Method == http.MethodGet:
			cap.mu.Lock()
			payload := cap.cardGET
			cap.mu.Unlock()
			if payload == nil {
				payload = map[string]any{"id": "card-dup", "title": "T", "labels": []string{"frontend"}}
			}
			_ = json.NewEncoder(w).Encode(payload)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)
	return srv, cap
}

func (c *dupCloseCapture) labelPatched(label string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, p := range c.patches {
		raw, ok := p["labels"]
		if !ok {
			continue
		}
		arr, ok := raw.([]any)
		if !ok {
			continue
		}
		for _, l := range arr {
			if s, _ := l.(string); s == label {
				return true
			}
		}
	}
	return false
}

func (c *dupCloseCapture) movedToColumn(colID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.moveColID == colID
}

func (c *dupCloseCapture) moveCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.moves)
}

func (c *dupCloseCapture) unassignCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.unassigns)
}

// executionPatchedStatus reports whether any execution PATCH carried the given
// status ("failed" = FailExecution; "aborted"/"completed" = park/close paths).
func (c *dupCloseCapture) executionPatchedStatus(status string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, p := range c.execPatches {
		if s, _ := p["status"].(string); s == status {
			return true
		}
	}
	return false
}

func (c *dupCloseCapture) executionFailed() bool {
	return c.executionPatchedStatus("failed")
}

func (c *dupCloseCapture) noteTitled(title string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, n := range c.notes {
		if s, _ := n["title"].(string); s == title {
			return true
		}
	}
	return false
}

// The implementResult envelope must carry the generic `resolution` field so any
// writes_code stage (implement, post-approval, custom fixer roles) can declare a
// sanctioned no-op. Parsed via the shared decode seam.
func TestImplementResult_DecodesResolution(t *testing.T) {
	var impl implementResult
	res := &llm.Result{
		StructuredOutput: []byte(`{"status":"done","resolution":"duplicate","summary":"already on main"}`),
	}
	if ok := decodeLLMEnvelope(res, &impl); !ok {
		t.Fatal("expected ok=true")
	}
	if impl.Resolution != "duplicate" {
		t.Fatalf("resolution did not decode, got %+v", impl)
	}
}

// A clean tree + not-ahead implement that DECLARES resolution=duplicate is a
// sanctioned no-op, not a failure: the card must close as a duplicate (move to
// the success column + `duplicate` label, drop participant, clear failure) and
// the reservation must be released — NOT recordFailure, which re-reserves and
// money-loops. Generic to any writes_code role.
func TestGitCommitAndPush_DeclaredDuplicateClosesAsSuccess(t *testing.T) {
	boardID := "b"
	bare := initBareRemote(t)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, "test-repo")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, "card-dup", "main")
	if err != nil {
		t.Fatalf("create branch: %v", err)
	}

	srv, cap := duplicateCloseServer(t, boardID)
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	strat := writesCodeStrategy()

	card := &discoverResult{CardID: "card-dup", BoardID: boardID, Title: "Phantom dup", DefaultBranch: "main"}
	// The implementer ran the approved post-pass, found the fix already on main,
	// and declared the resolution.
	llmResult := &llmStageResult{
		implResult: &implementResult{
			Status:     "done",
			Resolution: "duplicate",
			Summary:    "Already fixed on main (PR #98 lineage); no diff possible.",
		},
		rawOutput: "duplicate determination output",
	}

	before := loop.CardFailureCount(card.CardID)
	done, err := strat.gitCommitAndPush(
		context.Background(), context.Background(),
		loop, card, "exec-dup", repoDir, branch, false,
		func() {}, silentLogger(), llmResult,
	)
	if err != nil {
		t.Fatalf("gitCommitAndPush err: %v", err)
	}
	if !done {
		t.Fatal("declared duplicate must terminate the tick (done=true)")
	}
	// MUST NOT record a failure — that is what re-reserves and money-loops.
	if after := loop.CardFailureCount(card.CardID); after != before {
		t.Errorf("declared duplicate must NOT recordFailure: before=%d after=%d", before, after)
	}
	if !cap.movedToColumn("col-done") {
		t.Errorf("declared duplicate must move the card to the done column, moves=%v", cap.moves)
	}
	if !cap.labelPatched("duplicate") {
		t.Errorf("declared duplicate must stamp the `duplicate` label, patches=%v", cap.patches)
	}
}

// M1 (adversarial review): a duplicate close must not leave its execution
// dangling as `running` — a dangling running row 409s agent_busy on every
// subsequent next_assignment in single-agent deployments. The close is a
// SUCCESS terminal, so the execution closes as "completed" (never "failed").
func TestCloseAsDuplicate_ClosesExecutionCompleted(t *testing.T) {
	boardID := "b"
	bare := initBareRemote(t)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, "test-repo")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, "card-dup-exec", "main")
	if err != nil {
		t.Fatalf("create branch: %v", err)
	}

	srv, cap := duplicateCloseServer(t, boardID)
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	strat := writesCodeStrategy()

	card := &discoverResult{CardID: "card-dup-exec", BoardID: boardID, Title: "Dup", DefaultBranch: "main"}
	llmResult := &llmStageResult{
		implResult: &implementResult{Status: "done", Resolution: "duplicate", Summary: "already on main"},
	}

	done, err := strat.gitCommitAndPush(
		context.Background(), context.Background(),
		loop, card, "exec-dup-close", repoDir, branch, false,
		func() {}, silentLogger(), llmResult,
	)
	if err != nil || !done {
		t.Fatalf("duplicate close must terminate the tick: done=%v err=%v", done, err)
	}
	if !cap.executionPatchedStatus("completed") {
		t.Errorf("duplicate close must complete the execution (no dangling running row), exec_patches=%v", cap.execPatches)
	}
	if cap.executionFailed() {
		t.Errorf("duplicate close must never fail the execution, exec_patches=%v", cap.execPatches)
	}
}

// Symmetry guard: a clean-tree no-op that does NOT declare a resolution is still
// the genuine no-changes failure (unexplained empty diff). The duplicate path
// must key strictly on the declared signal, never fire for an ordinary no-op.
func TestGitCommitAndPush_UndeclaredNoOpIsNotADuplicate(t *testing.T) {
	boardID := "b"
	bare := initBareRemote(t)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, "test-repo")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, "card-noop", "main")
	if err != nil {
		t.Fatalf("create branch: %v", err)
	}

	srv, cap := duplicateCloseServer(t, boardID)
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	strat := writesCodeStrategy()

	card := &discoverResult{CardID: "card-noop", BoardID: boardID, Title: "Empty", DefaultBranch: "main"}
	llmResult := &llmStageResult{
		implResult: &implementResult{Status: "done", Summary: "found nothing to change"},
		rawOutput:  "no resolution declared",
	}

	done, err := strat.gitCommitAndPush(
		context.Background(), context.Background(),
		loop, card, "exec-noop", repoDir, branch, false,
		func() {}, silentLogger(), llmResult,
	)
	if err != nil {
		t.Fatalf("gitCommitAndPush err: %v", err)
	}
	if !done {
		t.Fatal("undeclared no-op keeps existing done=true failure flow")
	}
	if cap.labelPatched("duplicate") {
		t.Error("undeclared no-op must NOT be stamped `duplicate`")
	}
	if cap.movedToColumn("col-done") {
		t.Error("undeclared no-op must NOT be auto-closed to done")
	}
}
