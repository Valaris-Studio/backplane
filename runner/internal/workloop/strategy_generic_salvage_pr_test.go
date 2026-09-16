// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// FIX #1 (run-B): a long implement pass can terminate failure-shaped
// AFTER its work is already committed (turn/time cutoff between the LLM's own
// commit+push and the create_pr step). The next-reservation recovery self-heals
// this but costs a whole extra LLM reservation (~$4.66 observed live on I1).
// The SAME tick must salvage the committed work deterministically — cheap
// git/gh calls, no extra LLM pass: push, open the PR, ship the card forward as
// a SUCCESS — while an errored pass that produced NO commits still takes the
// normal failure path, and intentional parks (budget suspend) keep their own
// semantics.

// salvageCapture records the wire effects of a salvage (or its absence).
type salvageCapture struct {
	mu          sync.Mutex
	cardLabels  []string
	moves       []map[string]any
	patches     []map[string]any
	execPatches []recordedRequest
}

func (c *salvageCapture) movedToColumn(colID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, m := range c.moves {
		if v, _ := m["column_id"].(string); v == colID {
			return true
		}
	}
	return false
}

func (c *salvageCapture) labelApplied(label string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, p := range c.patches {
		arr, ok := p["labels"].([]any)
		if !ok {
			continue
		}
		for _, l := range arr {
			if v, _ := l.(string); v == label {
				return true
			}
		}
	}
	return false
}

func (c *salvageCapture) execStatusSeen(status string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, p := range c.execPatches {
		var decoded map[string]any
		_ = json.Unmarshal([]byte(p.Body), &decoded)
		if v, _ := decoded["status"].(string); v == status {
			return true
		}
	}
	return false
}

func salvageCaptureServer(t *testing.T, boardID, cardID string) (*httptest.Server, *salvageCapture) {
	t.Helper()
	cap := &salvageCapture{}
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
		path := r.URL.Path

		switch {
		case strings.Contains(path, "/executions") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "exec-salvage"})
			return

		case strings.Contains(path, "/executions/") && r.Method == http.MethodPatch:
			cap.mu.Lock()
			cap.execPatches = append(cap.execPatches, recordedRequest{Method: r.Method, Path: path, Body: string(body)})
			cap.mu.Unlock()

		case strings.HasSuffix(path, "/move") && r.Method == http.MethodPatch:
			cap.mu.Lock()
			cap.moves = append(cap.moves, decoded)
			cap.mu.Unlock()

		case strings.Contains(path, "/boards/"+boardID) && r.Method == http.MethodGet &&
			!strings.Contains(path, "/cards") && !strings.Contains(path, "/git-repos") && !strings.Contains(path, "/context"):
			_ = json.NewEncoder(w).Encode(map[string]any{"id": boardID, "name": "B", "columns": columns})
			return

		case strings.HasSuffix(path, "/notes") && r.Method == http.MethodGet:
			_, _ = w.Write([]byte("[]"))
			return

		case strings.Contains(path, "/cards/") && r.Method == http.MethodGet && !strings.Contains(path, "/search"):
			cap.mu.Lock()
			labels := append([]string{}, cap.cardLabels...)
			cap.mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": cardID, "title": "Cut-off card", "description": "",
				"labels": labels, "participants": []any{},
			})
			return

		case strings.Contains(path, "/cards/") && r.Method == http.MethodPatch:
			cap.mu.Lock()
			cap.patches = append(cap.patches, decoded)
			cap.mu.Unlock()
		}

		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)
	return srv, cap
}

// fakeGH installs a stub `gh` on PATH that appends each invocation to a log
// file and prints a fixed PR URL — the observable seam for git.Manager.CreatePR
// without GitHub.
func fakeGH(t *testing.T, prURL string) string {
	t.Helper()
	dir := t.TempDir()
	logFile := filepath.Join(dir, "gh-calls.log")
	// One ---CALL--- marker per invocation: args (the PR body) embed newlines,
	// so counting raw lines would overcount.
	script := "#!/bin/sh\necho '---CALL---' >> " + logFile + "\necho \"$@\" >> " + logFile + "\necho \"" + prURL + "\"\n"
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0755); err != nil {
		t.Fatalf("write gh shim: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return logFile
}

func ghCallCount(t *testing.T, logFile string) int {
	t.Helper()
	data, err := os.ReadFile(logFile)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatalf("read gh log: %v", err)
	}
	return strings.Count(string(data), "---CALL---")
}

// salvageStrategy is the implementer shape that owns a branch AND intends a PR
// — the only shape salvage may fire for.
func salvageStrategy() *DataDrivenStrategy {
	return NewDataDrivenStrategy(valaris.StageConfig{
		Role:  "implementer",
		Claim: valaris.ClaimDef{ParticipantRole: "hero", ExecutionAction: "implement_card"},
		Git:   valaris.GitDef{Action: "create_branch", CreatePR: true},
		LLM: valaris.LLMDef{
			Enabled: true, Stage: "implement", PostProcessKind: "writes_code",
		},
		OnSuccess: valaris.ActionDef{MoveToColumnType: "review"},
		OnFailure: valaris.ActionDef{MoveToColumnType: "backlog", Unassign: true},
	}, nil)
}

// implementSalvageSteps is an orchestrator-shaped walk fragment starting at the
// llm step, with an explicit on_failure chain so the tests can assert which
// route the walker took.
func implementSalvageSteps() []valaris.LifecycleStep {
	return []valaris.LifecycleStep{
		{Name: "implement", Kind: "llm", Next: "create_pr_for_card", OnFailure: "fail_mark",
			Params: map[string]any{"stage": "implement", "post_process_kind": "writes_code"}},
		{Name: "create_pr_for_card", Kind: "create_pr", Next: "ship_to_review"},
		{Name: "ship_to_review", Kind: "ship", Params: map[string]any{"to_column_type": "review"}},
		{Name: "fail_mark", Kind: "apply_label", Next: "fail_end",
			Params: map[string]any{"label": "implement-failed"}},
		{Name: "fail_end", Kind: "end"},
	}
}

// salvageWalkFixture clones from a bare remote, creates the card branch, and
// returns everything a Walk over implementSalvageSteps needs.
func salvageWalkFixture(t *testing.T, gitMgr *git.Manager, loop *Loop, strat *DataDrivenStrategy, cardID string) (*lifecycle.WalkState, string) {
	t.Helper()
	bare := initBareRemote(t)
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, cardID)
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, cardID, "main")
	if err != nil {
		t.Fatalf("branch: %v", err)
	}
	card := &discoverResult{
		CardID: cardID, BoardID: "board-1", Title: "Cut-off card",
		GitRepoURL: bare, GitRepoName: cardID, DefaultBranch: "main",
	}
	ws := makeWalkState(t, loop, strat, card)
	ws.ExecutionID = "exec-salvage"
	ws.RepoDir = repoDir
	ws.Branch = branch
	ws.Set("branch_recovered", false)
	return ws, repoDir
}

func commitOnBranch(t *testing.T, gitMgr *git.Manager, repoDir, file, msg string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(repoDir, file), []byte("work\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := gitMgr.CommitAll(context.Background(), repoDir, msg); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

// The headline case: the implement LLM step errors AFTER the work was committed
// on the branch (the LLM committed via its own tooling, then the pass cut off).
// The SAME walk invocation must open the PR deterministically and ship the card
// to review — NOT route to on_failure and pay a second reservation.
func TestLifecycleWalk_ImplementErrorAfterCommits_SalvagesPRSameTick(t *testing.T) {
	ghLog := fakeGH(t, "https://github.com/test/repo/pull/77")
	srv, cap := salvageCaptureServer(t, "board-1", "card-cut")
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	mock := &llm.MockProvider{FailWith: errors.New("turn budget exhausted mid-pass"), FailWithInputTokens: 12000, FailWithOutputTokens: 800}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, testConfig())
	strat := salvageStrategy()

	ws, repoDir := salvageWalkFixture(t, gitMgr, loop, strat, "card-cut")
	// The LLM committed its work mid-run (clean tree, 1 ahead, NOT pushed).
	commitOnBranch(t, gitMgr, repoDir, "feature.go", "feat: implemented before cutoff")

	err := (lifecycle.Walker{}).Walk(context.Background(), ws, implementSalvageSteps())
	if !errors.Is(err, lifecycle.ErrSalvaged) {
		t.Fatalf("walk must stop with lifecycle.ErrSalvaged (success, downstream steps skipped); got %v", err)
	}

	// PR opened exactly once — by the salvage itself, not by a re-run of the
	// create_pr step (whose shared walk ctx may be dead in production).
	if n := ghCallCount(t, ghLog); n != 1 {
		data, _ := os.ReadFile(ghLog)
		t.Errorf("salvage must open the PR exactly once, gh calls = %d\n%s", n, data)
	}
	card := cardFromWalk(ws)
	if card.PRURL != "https://github.com/test/repo/pull/77" {
		t.Errorf("salvage must record the PR URL on the card, got %q", card.PRURL)
	}
	// Routed FORWARD as a success...
	if !cap.movedToColumn("col-review") {
		t.Errorf("salvaged card must ship to review, moves=%v", cap.moves)
	}
	if !cap.execStatusSeen("completed") {
		t.Errorf("salvage must complete the execution, exec_patches=%v", cap.execPatches)
	}
	// ...NOT to the failure path.
	if cap.labelApplied("implement-failed") {
		t.Error("salvage must not route the walk to on_failure")
	}
	if cap.execStatusSeen("failed") {
		t.Errorf("salvage must not fail the execution, exec_patches=%v", cap.execPatches)
	}
	if n := loop.CardFailureCount("card-cut"); n != 0 {
		t.Errorf("salvage must record no card failure, count=%d", n)
	}
	if released, _ := ws.Get("execution_released"); released != true {
		t.Error("salvage must flag execution_released so tickViaLifecycle doesn't double-close")
	}
	// The commits were pushed so the PR has substance.
	run(t, repoDir, "git", "rev-parse", "--verify", "origin/"+ws.Branch)
}

// An errored pass that produced NOTHING (clean tree, no commits) is a real
// failure — the normal on_failure path must run unchanged, no PR.
func TestLifecycleWalk_ImplementErrorNoCommits_NormalFailurePath(t *testing.T) {
	ghLog := fakeGH(t, "https://github.com/test/repo/pull/78")
	srv, cap := salvageCaptureServer(t, "board-1", "card-empty")
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	mock := &llm.MockProvider{FailWith: errors.New("provider exploded")}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, testConfig())
	strat := salvageStrategy()

	ws, _ := salvageWalkFixture(t, gitMgr, loop, strat, "card-empty")

	err := (lifecycle.Walker{}).Walk(context.Background(), ws, implementSalvageSteps())
	if err != nil {
		t.Fatalf("on_failure routing must absorb the error (clean walk end), got %v", err)
	}
	if !cap.labelApplied("implement-failed") {
		t.Errorf("empty pass must route to on_failure, patches=%v", cap.patches)
	}
	if n := ghCallCount(t, ghLog); n != 0 {
		t.Errorf("empty pass must not open a PR, gh calls = %d", n)
	}
	if cap.movedToColumn("col-review") {
		t.Error("empty pass must not ship to review")
	}
}

// A dirty tree WITHOUT any commit is not salvageable either: a commit is the
// LLM's own declaration of a coherent checkpoint; uncommitted scratch alone
// must not be PR'd over a real failure.
func TestLifecycleWalk_ImplementErrorOnlyUncommittedChanges_NotSalvaged(t *testing.T) {
	ghLog := fakeGH(t, "https://github.com/test/repo/pull/79")
	srv, cap := salvageCaptureServer(t, "board-1", "card-scratch")
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	mock := &llm.MockProvider{FailWith: errors.New("crashed mid-write")}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, testConfig())
	strat := salvageStrategy()

	ws, repoDir := salvageWalkFixture(t, gitMgr, loop, strat, "card-scratch")
	if err := os.WriteFile(filepath.Join(repoDir, "scratch.go"), []byte("half-done\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	err := (lifecycle.Walker{}).Walk(context.Background(), ws, implementSalvageSteps())
	if err != nil {
		t.Fatalf("on_failure routing must absorb the error, got %v", err)
	}
	if n := ghCallCount(t, ghLog); n != 0 {
		t.Errorf("uncommitted-only pass must not open a PR, gh calls = %d", n)
	}
	if !cap.labelApplied("implement-failed") {
		t.Errorf("uncommitted-only pass must route to on_failure, patches=%v", cap.patches)
	}
}

// A budget cutoff with commits ahead is an INTENTIONAL park (checkpoint &
// resume by design) — it must stay ErrSuspended, never be hijacked into a PR.
func TestLifecycleWalk_BudgetSuspendWithCommitsAhead_NotSalvaged(t *testing.T) {
	ghLog := fakeGH(t, "https://github.com/test/repo/pull/80")
	srv, cap := salvageCaptureServer(t, "board-1", "card-budget")
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	cfg := testConfig()
	cfg.LLM.MaxBudgetUSD = 6.0
	mock := &llm.MockProvider{FailWith: errors.New("claude exited with code 1"), FailWithCostUSD: 5.95}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, cfg)
	strat := salvageStrategy()

	ws, repoDir := salvageWalkFixture(t, gitMgr, loop, strat, "card-budget")
	commitOnBranch(t, gitMgr, repoDir, "wip.go", "wip: budget pass work")

	err := (lifecycle.Walker{}).Walk(context.Background(), ws, implementSalvageSteps())
	if !errors.Is(err, lifecycle.ErrSuspended) {
		t.Fatalf("budget cutoff must stay a SUSPEND, got %v", err)
	}
	if n := ghCallCount(t, ghLog); n != 0 {
		t.Errorf("budget suspend must not open a PR, gh calls = %d", n)
	}
	if !cap.labelApplied(budgetSuspendedLabel) {
		t.Errorf("budget suspend must park the card, patches=%v", cap.patches)
	}
	if cap.movedToColumn("col-review") {
		t.Error("budget suspend must not ship to review")
	}
}

// A 0-token implement crash (the model never ran — e.g. the codex resume --cd
// arg wedge: exit 2, 0s, 0 tokens) must NOT salvage, even when commits_ahead>0.
// Those commits are LEFTOVER from branch recovery, not this turn's product;
// salvaging them churns force-push/gh-pr-create over a remote that never got
// the work (the field run 2026-07-25 noise). It must take the normal failure path.
func TestLifecycleWalk_EmptyTurnCrashWithCommitsAhead_NotSalvaged(t *testing.T) {
	ghLog := fakeGH(t, "https://github.com/test/repo/pull/91")
	srv, cap := salvageCaptureServer(t, "board-1", "card-empty-turn")
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	// Crash shape: errored with ZERO tokens (the CLI rejected the args before the
	// model ran), unlike a real mid-pass cutoff that spent tokens.
	mock := &llm.MockProvider{FailWith: errors.New("codex exited with code 2: unexpected argument '--cd' found")}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, testConfig())
	strat := salvageStrategy()

	ws, repoDir := salvageWalkFixture(t, gitMgr, loop, strat, "card-empty-turn")
	// A leftover commit from a recovered branch — present, but NOT this turn's.
	commitOnBranch(t, gitMgr, repoDir, "leftover.go", "feat: stale recovered commit")

	err := (lifecycle.Walker{}).Walk(context.Background(), ws, implementSalvageSteps())
	if errors.Is(err, lifecycle.ErrSalvaged) {
		t.Fatal("a 0-token crash must NOT salvage — the commits are leftover, not this turn's work")
	}
	if n := ghCallCount(t, ghLog); n != 0 {
		t.Errorf("empty-turn crash must not open a PR, gh calls = %d", n)
	}
	if !cap.labelApplied("implement-failed") {
		t.Errorf("empty-turn crash must route to on_failure, patches=%v", cap.patches)
	}
	if cap.movedToColumn("col-review") {
		t.Error("empty-turn crash must not ship to review")
	}
}

// Case (b): the cutoff lands BETWEEN the push and the create_pr step — the
// walk context is already dead, so the step's own gh call fails on a context
// error even though the branch is pushed and PR-ready. The step must retry the
// terminal sequence on a fresh context instead of failing the card.
func TestLifecycleCreatePR_DeadContextAfterPush_SalvagesOnFreshContext(t *testing.T) {
	ghLog := fakeGH(t, "https://github.com/test/repo/pull/81")
	srv, cap := salvageCaptureServer(t, "board-1", "card-deadctx")
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	strat := salvageStrategy()

	ws, repoDir := salvageWalkFixture(t, gitMgr, loop, strat, "card-deadctx")
	commitOnBranch(t, gitMgr, repoDir, "feature.go", "feat: done and pushed")
	if err := gitMgr.Push(context.Background(), repoDir); err != nil {
		t.Fatalf("push: %v", err)
	}

	deadCtx, cancel := context.WithCancel(context.Background())
	cancel() // the CardTimeout already expired in this shape

	step := &valaris.LifecycleStep{Name: "create_pr_for_card", Kind: "create_pr"}
	_, _, err := lifecycleCreatePR(deadCtx, ws, step)
	if !errors.Is(err, lifecycle.ErrSalvaged) {
		t.Fatalf("dead-ctx create_pr with pushed commits must salvage, got %v", err)
	}
	if n := ghCallCount(t, ghLog); n != 1 {
		t.Errorf("salvage must open the PR exactly once (the dead-ctx attempt never reaches gh), gh calls = %d", n)
	}
	if !cap.movedToColumn("col-review") {
		t.Errorf("salvaged card must ship to review, moves=%v", cap.moves)
	}
}

// Legacy (non-lifecycle) path: tickCard's executeLLM error with commits already
// on the recovered branch must salvage the same way instead of failWithConfig.
func TestTickCard_LegacyImplementErrorAfterCommits_SalvagesPRSameTick(t *testing.T) {
	ghLog := fakeGH(t, "https://github.com/test/repo/pull/82")
	srv, cap := salvageCaptureServer(t, "board-1", "card-legacy")
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	mock := &llm.MockProvider{FailWith: errors.New("turn budget exhausted mid-pass"), FailWithInputTokens: 12000, FailWithOutputTokens: 800}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, testConfig())
	strat := salvageStrategy()

	// A prior pass committed AND pushed the card branch; this reservation
	// recovers it, then the LLM errors before reaching the PR step.
	bare := initBareRemote(t)
	branch := gitMgr.PrefixedBranch(sanitizeBranch("card-legacy", "Cut-off card"))
	scratch := filepath.Join(t.TempDir(), "pre")
	run(t, "", "git", "clone", bare, scratch)
	run(t, scratch, "git", "config", "user.email", "test@valaris.dev")
	run(t, scratch, "git", "config", "user.name", "Test")
	run(t, scratch, "git", "checkout", "-b", branch)
	if err := os.WriteFile(filepath.Join(scratch, "feature.go"), []byte("done\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	run(t, scratch, "git", "add", ".")
	run(t, scratch, "git", "commit", "-m", "feat: prior pass work")
	run(t, scratch, "git", "push", "origin", branch)

	card := &discoverResult{
		CardID: "card-legacy", BoardID: "board-1", Title: "Cut-off card",
		GitRepoURL: bare, GitRepoName: "card-legacy", DefaultBranch: "main",
	}

	if err := strat.tickCard(context.Background(), context.Background(), loop, card, silentLogger()); err != nil {
		t.Fatalf("salvaged legacy tick must return nil, got %v", err)
	}
	if n := ghCallCount(t, ghLog); n != 1 {
		t.Errorf("legacy salvage must open the PR exactly once, gh calls = %d", n)
	}
	if !cap.movedToColumn("col-review") {
		t.Errorf("legacy salvaged card must ship to review, moves=%v", cap.moves)
	}
	if cap.execStatusSeen("failed") {
		t.Errorf("legacy salvage must not fail the execution, exec_patches=%v", cap.execPatches)
	}
	if n := loop.CardFailureCount("card-legacy"); n != 0 {
		t.Errorf("legacy salvage must record no card failure, count=%d", n)
	}
}

// Legacy path, nothing committed: the failure path is unchanged (error
// surfaces, execution failed, no PR).
func TestTickCard_LegacyImplementErrorNoCommits_FailurePathUnchanged(t *testing.T) {
	ghLog := fakeGH(t, "https://github.com/test/repo/pull/83")
	srv, cap := salvageCaptureServer(t, "board-1", "card-legacy-empty")
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	mock := &llm.MockProvider{FailWith: errors.New("provider exploded")}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, testConfig())
	strat := salvageStrategy()

	bare := initBareRemote(t)
	card := &discoverResult{
		CardID: "card-legacy-empty", BoardID: "board-1", Title: "Empty",
		GitRepoURL: bare, GitRepoName: "card-legacy-empty", DefaultBranch: "main",
	}

	if err := strat.tickCard(context.Background(), context.Background(), loop, card, silentLogger()); err == nil {
		t.Fatal("empty errored pass must keep returning the error")
	}
	if n := ghCallCount(t, ghLog); n != 0 {
		t.Errorf("empty errored pass must not open a PR, gh calls = %d", n)
	}
	if !cap.execStatusSeen("failed") {
		t.Errorf("empty errored pass must fail the execution, exec_patches=%v", cap.execPatches)
	}
}

// Full Tick through tickViaLifecycle: a salvaged walk is a SUCCESS — Tick
// returns nil, no failWithConfig/unassign, the card lands in review.
func TestTickViaLifecycle_SalvagedWalk_IsSuccessNotFailure(t *testing.T) {
	ghLog := fakeGH(t, "https://github.com/test/repo/pull/84")
	bare := initBareRemote(t)

	boardID := "board-1"
	cardID := "card-full"
	title := "Cut-off card"
	branch := (&git.Manager{BranchPrefix: "runner/"}).PrefixedBranch(sanitizeBranch(cardID, title))
	scratch := filepath.Join(t.TempDir(), "pre")
	run(t, "", "git", "clone", bare, scratch)
	run(t, scratch, "git", "config", "user.email", "test@valaris.dev")
	run(t, scratch, "git", "config", "user.name", "Test")
	run(t, scratch, "git", "checkout", "-b", branch)
	if err := os.WriteFile(filepath.Join(scratch, "feature.go"), []byte("done\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	run(t, scratch, "git", "add", ".")
	run(t, scratch, "git", "commit", "-m", "feat: prior pass work")
	run(t, scratch, "git", "push", "origin", branch)

	cap := &salvageCapture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/next-assignment") {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"card":  map[string]any{"id": cardID, "title": title},
				"board": map[string]any{"id": boardID, "name": "B"},
				"repo": map[string]any{
					"id": "repo-1", "name": cardID, "url": bare, "default_branch": "main",
				},
			})
			return
		}
		// Everything else mirrors salvageCaptureServer's routing.
		capServerHandler(t, w, r, boardID, cardID, cap)
	}))
	t.Cleanup(srv.Close)

	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	mock := &llm.MockProvider{FailWith: errors.New("turn budget exhausted mid-pass"), FailWithInputTokens: 12000, FailWithOutputTokens: 800}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, testConfig())

	stage := valaris.StageConfig{
		Role:  "implementer",
		Claim: valaris.ClaimDef{ParticipantRole: "hero", ExecutionAction: "implement_card"},
		Git:   valaris.GitDef{Action: "create_branch", CreatePR: true},
		LLM: valaris.LLMDef{
			Enabled: true, Stage: "implement", PostProcessKind: "writes_code",
		},
		OnSuccess: valaris.ActionDef{MoveToColumnType: "review"},
		OnFailure: valaris.ActionDef{MoveToColumnType: "backlog", Unassign: true},
		Lifecycle: []valaris.LifecycleStep{
			{Name: "discover_unassigned", Kind: "discover", Next: "claim_card",
				Params: map[string]any{"strategy": "unassigned_or_rework"}},
			{Name: "claim_card", Kind: "claim", Next: "git_setup_branch",
				Params: map[string]any{"participant_role": "hero", "execution_action": "implement_card"}},
			{Name: "git_setup_branch", Kind: "git_setup", Next: "implement",
				Params: map[string]any{"action": "create_branch", "create_pr": true}},
			{Name: "implement", Kind: "llm", Next: "create_pr_for_card",
				Params: map[string]any{"stage": "implement", "post_process_kind": "writes_code"}},
			{Name: "create_pr_for_card", Kind: "create_pr", Next: "ship_to_review"},
			{Name: "ship_to_review", Kind: "ship", Params: map[string]any{"to_column_type": "review"}},
		},
	}
	s := NewDataDrivenStrategy(stage, nil)

	if err := s.Tick(context.Background(), loop); err != nil {
		t.Fatalf("a salvaged lifecycle tick must be a SUCCESS (nil), got %v", err)
	}
	if n := ghCallCount(t, ghLog); n != 1 {
		t.Errorf("salvage must open the PR exactly once, gh calls = %d", n)
	}
	if !cap.movedToColumn("col-review") {
		t.Errorf("salvaged card must ship to review, moves=%v", cap.moves)
	}
	if cap.execStatusSeen("failed") {
		t.Errorf("salvage must not fail the execution, exec_patches=%v", cap.execPatches)
	}
	if !loop.lastTickHadWork {
		t.Error("a salvaged tick is productive work (lastTickHadWork=true)")
	}
}

// H3: an approval-shaped exit means the stage explicitly demanded a human
// gate. When the LLM says needs_approval but the approval is untrackable
// (empty approval_id), handleApproval errors — and even with commits already
// on the branch that error must NEVER be salvaged into a shipped PR: that
// would silently drop the human gate. Normal failure path, no PR.
func TestLifecycleWalk_MalformedApprovalWithCommitsAhead_NotSalvaged(t *testing.T) {
	ghLog := fakeGH(t, "https://github.com/test/repo/pull/85")
	srv, cap := salvageCaptureServer(t, "board-1", "card-gate")
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	// The stage wants a human: needs_approval WITHOUT an approval_id.
	mock := llm.NewMockProvider(mustJSON(t, map[string]string{
		"status": "needs_approval", "summary": "human must confirm the signing handoff",
	}))
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, testConfig())
	strat := salvageStrategy()

	ws, repoDir := salvageWalkFixture(t, gitMgr, loop, strat, "card-gate")
	commitOnBranch(t, gitMgr, repoDir, "feature.go", "feat: committed before raising approval")

	steps := implementSalvageSteps()
	steps[0].Params["approval_enabled"] = true

	err := (lifecycle.Walker{}).Walk(context.Background(), ws, steps)
	if errors.Is(err, lifecycle.ErrSalvaged) {
		t.Fatal("an approval-shaped exit must never be salvaged (human gate dropped)")
	}
	if err != nil {
		t.Fatalf("on_failure routing must absorb the error (clean walk end), got %v", err)
	}
	if n := ghCallCount(t, ghLog); n != 0 {
		t.Errorf("approval-shaped exit must not open a PR, gh calls = %d", n)
	}
	if !cap.labelApplied("implement-failed") {
		t.Errorf("approval-shaped exit must route to on_failure, patches=%v", cap.patches)
	}
	if cap.movedToColumn("col-review") {
		t.Error("approval-shaped exit must not ship to review")
	}
}

// fakeGHTransient installs a gh stub that FAILS its first invocation and
// succeeds afterwards — the transient-outage shape M3 guards against.
func fakeGHTransient(t *testing.T, prURL string) string {
	t.Helper()
	dir := t.TempDir()
	logFile := filepath.Join(dir, "gh-calls.log")
	flagFile := filepath.Join(dir, "gh-called-once")
	script := "#!/bin/sh\n" +
		"echo '---CALL---' >> " + logFile + "\n" +
		"echo \"$@\" >> " + logFile + "\n" +
		"if [ ! -f " + flagFile + " ]; then touch " + flagFile + "; echo 'transient gh outage' >&2; exit 1; fi\n" +
		"echo \"" + prURL + "\"\n"
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0755); err != nil {
		t.Fatalf("write gh shim: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return logFile
}

// M3: a LIVE-context CreatePR failure (transient gh outage) is NOT the
// dead-context cutoff shape — it must take the step's normal on_failure path,
// where the configured lifecycle (wake_reviewer, custom post-PR steps) and the
// next-reservation recovery stay authoritative. Salvaging here would ship via
// the flat-config OnSuccess and silently skip operator-configured steps.
func TestLifecycleCreatePR_LiveContextTransientGHError_NotSalvaged(t *testing.T) {
	ghLog := fakeGHTransient(t, "https://github.com/test/repo/pull/86")
	srv, cap := salvageCaptureServer(t, "board-1", "card-flaky")
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	strat := salvageStrategy()

	ws, repoDir := salvageWalkFixture(t, gitMgr, loop, strat, "card-flaky")
	commitOnBranch(t, gitMgr, repoDir, "feature.go", "feat: done and pushed")
	if err := gitMgr.Push(context.Background(), repoDir); err != nil {
		t.Fatalf("push: %v", err)
	}

	step := &valaris.LifecycleStep{Name: "create_pr_for_card", Kind: "create_pr"}
	_, _, err := lifecycleCreatePR(context.Background(), ws, step)
	if errors.Is(err, lifecycle.ErrSalvaged) {
		t.Fatal("a live-context CreatePR failure must not be salvaged (configured lifecycle stays authoritative)")
	}
	if err == nil {
		t.Fatal("a live-context CreatePR failure must propagate to the walker's on_failure routing")
	}
	if n := ghCallCount(t, ghLog); n != 1 {
		t.Errorf("no salvage retry must run on a live context, gh calls = %d", n)
	}
	if cap.movedToColumn("col-review") {
		t.Error("live-context CreatePR failure must not ship to review")
	}
}

// L4: the salvage PR body must not embed the raw cause error (turn-budget /
// provider noise); a short fixed phrase suffices — the detail lives in logs.
func TestSalvage_PRBodyOmitsRawErrorNoise(t *testing.T) {
	ghLog := fakeGH(t, "https://github.com/test/repo/pull/87")
	srv, _ := salvageCaptureServer(t, "board-1", "card-body")
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	mock := &llm.MockProvider{FailWith: errors.New("turn budget exhausted mid-pass: claude exited with code 1"), FailWithInputTokens: 12000, FailWithOutputTokens: 800}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, testConfig())
	strat := salvageStrategy()

	ws, repoDir := salvageWalkFixture(t, gitMgr, loop, strat, "card-body")
	commitOnBranch(t, gitMgr, repoDir, "feature.go", "feat: implemented before cutoff")

	if err := (lifecycle.Walker{}).Walk(context.Background(), ws, implementSalvageSteps()); !errors.Is(err, lifecycle.ErrSalvaged) {
		t.Fatalf("walk must salvage, got %v", err)
	}

	data, err := os.ReadFile(ghLog)
	if err != nil {
		t.Fatalf("read gh log: %v", err)
	}
	if strings.Contains(string(data), "turn budget exhausted") {
		t.Errorf("PR body must not embed the raw cause error, gh args:\n%s", data)
	}
	if !strings.Contains(string(data), "work salvaged from the pushed branch") {
		t.Errorf("PR body must carry the fixed salvage phrase, gh args:\n%s", data)
	}
}

// capServerHandler mirrors salvageCaptureServer's routing for tests that need
// to intercept one endpoint (next-assignment) themselves.
func capServerHandler(t *testing.T, w http.ResponseWriter, r *http.Request, boardID, cardID string, cap *salvageCapture) {
	t.Helper()
	if serveDefaultPlatformConfig(w, r) {
		return
	}
	body, _ := io.ReadAll(r.Body)
	var decoded map[string]any
	_ = json.Unmarshal(body, &decoded)
	path := r.URL.Path

	switch {
	case strings.Contains(path, "/executions") && r.Method == http.MethodPost:
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "exec-salvage"})
		return
	case strings.Contains(path, "/executions/") && r.Method == http.MethodPatch:
		cap.mu.Lock()
		cap.execPatches = append(cap.execPatches, recordedRequest{Method: r.Method, Path: path, Body: string(body)})
		cap.mu.Unlock()
	case strings.HasSuffix(path, "/move") && r.Method == http.MethodPatch:
		cap.mu.Lock()
		cap.moves = append(cap.moves, decoded)
		cap.mu.Unlock()
	case strings.Contains(path, "/boards/"+boardID) && r.Method == http.MethodGet &&
		!strings.Contains(path, "/cards") && !strings.Contains(path, "/git-repos") && !strings.Contains(path, "/context"):
		_ = json.NewEncoder(w).Encode(map[string]any{"id": boardID, "name": "B", "columns": []map[string]any{
			{"id": "col-backlog", "name": "To Do", "column_type": "backlog", "position": 1024.0},
			{"id": "col-active", "name": "Active", "column_type": "active", "position": 2048.0},
			{"id": "col-review", "name": "Review", "column_type": "review", "position": 3072.0},
			{"id": "col-done", "name": "Done", "column_type": "done", "position": 4096.0},
		}})
		return
	case strings.HasSuffix(path, "/notes") && r.Method == http.MethodGet:
		_, _ = w.Write([]byte("[]"))
		return
	case strings.Contains(path, "/cards/") && r.Method == http.MethodGet && !strings.Contains(path, "/search"):
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": cardID, "title": "Cut-off card", "description": "",
			"labels": []string{}, "participants": []any{},
		})
		return
	case strings.Contains(path, "/cards/") && r.Method == http.MethodPatch:
		cap.mu.Lock()
		cap.patches = append(cap.patches, decoded)
		cap.mu.Unlock()
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("{}"))
}
