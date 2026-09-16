// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// Backstop (defense-in-depth, generic): even when a stage NEVER declares
// resolution=duplicate, an undeclared clean-tree no-op must not money-loop
// forever. The fresh-implement no-op path records a failure each cycle, and the
// circuit breaker blocks the card once consecutive no-ops reach the dedicated
// no-op threshold — so the scheduler stops re-reserving it. This locks the
// safety net that backs up the declared-duplicate fast path, for ANY
// writes_code role, with no role/project coupling.
func TestGitCommitAndPush_UndeclaredNoOpTripsBreakerAfterThreshold(t *testing.T) {
	boardID := "b"
	srv, _ := duplicateCloseServer(t, boardID)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	strat := writesCodeStrategy()

	card := &discoverResult{CardID: "card-loop", BoardID: boardID, Title: "Phantom", DefaultBranch: "main"}
	llmResult := &llmStageResult{
		implResult: &implementResult{Status: "done", Summary: "nothing to change"},
	}

	// Re-clone a fresh empty branch each cycle to simulate the scheduler
	// re-reserving and the implementer producing no diff again.
	runOnce := func() {
		bare := initBareRemote(t)
		repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, card.CardID)
		if err != nil {
			t.Fatalf("clone: %v", err)
		}
		branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, card.CardID, "main")
		if err != nil {
			t.Fatalf("branch: %v", err)
		}
		if _, err := strat.gitCommitAndPush(
			context.Background(), context.Background(),
			loop, card, "exec", repoDir, branch, false,
			func() {}, silentLogger(), llmResult,
		); err != nil {
			t.Fatalf("gitCommitAndPush: %v", err)
		}
	}

	if loop.IsCardBlocked(card.CardID) {
		t.Fatal("card must not start blocked")
	}

	// Run enough cycles to cross the consecutive-no-op threshold. The breaker
	// must engage so the scheduler can no longer re-reserve the card.
	for i := 0; i < maxConsecutiveNoChangeImplements; i++ {
		runOnce()
	}

	if !loop.IsCardBlocked(card.CardID) {
		t.Errorf("after %d consecutive undeclared no-ops the card must be blocked (loop must not run forever); no_op_count=%d",
			maxConsecutiveNoChangeImplements, loop.NoChangeReworkCount(card.CardID))
	}
}
