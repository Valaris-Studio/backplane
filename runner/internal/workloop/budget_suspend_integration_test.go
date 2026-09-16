// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// End-to-end through lifecycleLLM: a budget cutoff (LLM errors having spent ~the
// ceiling) on an implementer (create_branch) step must SUSPEND — return
// lifecycle.ErrSuspended (clean stop, no on_failure routing), checkpoint the WIP,
// and park the card — instead of bubbling the error to the branch-wiping path.
func TestLifecycleLLM_BudgetCutoff_SuspendsInsteadOfFailing(t *testing.T) {
	bare := initBareRemote(t)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, "sus-repo")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, "card-sus", "main")
	if err != nil {
		t.Fatalf("create branch: %v", err)
	}
	// The ~80%-done WIP the cutoff leaves in the working tree.
	if err := os.WriteFile(filepath.Join(repoDir, "wip.py"), []byte("partial work\n"), 0644); err != nil {
		t.Fatalf("write wip: %v", err)
	}

	srv, rec := labelCaptureServer(t, "b", nil)
	cfg := testConfig()
	cfg.LLM.MaxBudgetUSD = 6.0 // ceiling the cutoff spent against
	// Mock: error AS IF budget-cut off, having spent ~the full ceiling.
	mock := &llm.MockProvider{FailWith: errors.New("claude exited with code 1"), FailWithCostUSD: 5.95}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, cfg)

	strat := writesCodeStrategy()
	card := &discoverResult{
		CardID: "card-sus", BoardID: "b", Title: "Big card", DefaultBranch: "main",
		GitRepoURL: bare, GitRepoName: "sus-repo",
	}
	ws := makeWalkState(t, loop, strat, card)
	ws.ExecutionID = "exec-1"
	ws.RepoDir = repoDir
	ws.Branch = branch
	ws.Set("branch_recovered", false)

	step := &valaris.LifecycleStep{
		Name: "implement", Kind: "llm",
		Params: map[string]any{"stage": "implement", "post_process_kind": "writes_code"},
	}
	_, _, err = lifecycleLLM(context.Background(), ws, step)
	if !errors.Is(err, lifecycle.ErrSuspended) {
		t.Fatalf("budget cutoff must yield lifecycle.ErrSuspended; got %v", err)
	}

	// WIP checkpointed.
	has, _ := gitMgr.HasChanges(context.Background(), repoDir)
	if has {
		t.Error("WIP must be committed after suspend")
	}
	// Card parked.
	if !hasLabel(rec.finalLabels(), budgetSuspendedLabel) {
		t.Errorf("card must carry %q after suspend; labels=%v", budgetSuspendedLabel, rec.finalLabels())
	}
}

// A genuine (non-budget) error must NOT suspend — it bubbles up so the walker
// routes to on_failure as before. Guards against over-eager suspension.
func TestLifecycleLLM_GenuineError_DoesNotSuspend(t *testing.T) {
	bare := initBareRemote(t)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, "err-repo")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, "card-sus", "main")
	if err != nil {
		t.Fatalf("create branch: %v", err)
	}

	srv, _ := labelCaptureServer(t, "b", nil)
	cfg := testConfig()
	cfg.LLM.MaxBudgetUSD = 6.0
	// Errors with TRIVIAL cost — a real failure early in the pass, not a cutoff.
	mock := &llm.MockProvider{FailWith: errors.New("transient network error"), FailWithCostUSD: 0.10}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, cfg)

	strat := writesCodeStrategy()
	card := &discoverResult{CardID: "card-sus", BoardID: "b", Title: "T", DefaultBranch: "main", GitRepoURL: bare, GitRepoName: "err-repo"}
	ws := makeWalkState(t, loop, strat, card)
	ws.ExecutionID = "exec-1"
	ws.RepoDir = repoDir
	ws.Branch = branch
	ws.Set("branch_recovered", false)

	step := &valaris.LifecycleStep{Name: "implement", Kind: "llm", Params: map[string]any{"stage": "implement", "post_process_kind": "writes_code"}}
	_, _, err = lifecycleLLM(context.Background(), ws, step)
	if err == nil {
		t.Fatal("genuine error must propagate (non-nil)")
	}
	if errors.Is(err, lifecycle.ErrSuspended) {
		t.Error("a low-cost genuine error must NOT be classified as a budget suspend")
	}
}
