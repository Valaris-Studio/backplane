// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// board_reconciler PRODUCER (A1b cross-card duplicate). Distinct from
// resolution=duplicate: that closes the card itself (the change is already on
// the BASE branch — the implementer is sure). needs_reconcile is the UNSURE
// case: the implementer SUSPECTS its scope was already delivered by a DIFFERENT
// card/PR but cannot self-close (cross-card judgment). Instead of looping, it
// parks the card with the `needs-reconcile` label + a note + unassign and stops
// the walk — handing the disposition to the board_reconciler role. The label is
// LOAD-BEARING: the backend implementer discover excludes it (breaking the loop)
// and the board_reconciler discover includes it. Unlike the runtime-proof park,
// this does NOT move the card to a blocked column — it stays in active where
// board_reconciler scans, and the execution closes as `aborted` (a park, not a
// success terminal).

func assertReconcilePark(t *testing.T, loop *Loop, cap *dupCloseCapture, cardID string) {
	t.Helper()
	// (a) load-bearing routing label + participant removed.
	if !cap.labelPatched(needsReconcileLabel) {
		t.Errorf("reconcile park must stamp the `%s` label, patches=%v", needsReconcileLabel, cap.patches)
	}
	if cap.unassignCount() == 0 {
		t.Errorf("reconcile park must unassign the agent, unassigns=%v", cap.unassigns)
	}
	// (b) board-visible note explaining the suspicion for board_reconciler.
	if !cap.noteTitled("Card parked for board reconciliation") {
		t.Errorf("reconcile park must write the reconciliation note, notes=%v", cap.notes)
	}
	// (c) NOT a failure, NO no-op strike (a correct outcome, not a strike).
	if cap.executionFailed() {
		t.Errorf("reconcile park must NOT fail the execution, exec_patches=%v", cap.execPatches)
	}
	if !cap.executionPatchedStatus("aborted") {
		t.Errorf("reconcile park must close the execution as aborted, exec_patches=%v", cap.execPatches)
	}
	if n := loop.CardFailureCount(cardID); n != 0 {
		t.Errorf("reconcile park must NOT record a card failure, count=%d", n)
	}
	if n := loop.NoChangeReworkCount(cardID); n != 0 {
		t.Errorf("reconcile park must NOT count toward the no-op breaker, count=%d", n)
	}
	// (d) does NOT move the card out of active — board_reconciler scans it there.
	if cap.movedToColumn("col-done") {
		t.Error("reconcile park must NOT close the card to done (board_reconciler decides)")
	}
}

// Declared form: the implementer resolves that the card is a suspected
// cross-card duplicate it cannot self-close. Parks regardless of diff state.
func TestGitCommitAndPush_DeclaredNeedsReconcile_ParksForReconciler(t *testing.T) {
	boardID := "b"
	srv, cap := duplicateCloseServer(t, boardID)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	strat := writesCodeStrategy()

	bare := initBareRemote(t)
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, "card-reconcile")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, "card-reconcile", "main")
	if err != nil {
		t.Fatalf("branch: %v", err)
	}
	// Scratch changes in the tree — the declaration must still win (no commit).
	if err := os.WriteFile(filepath.Join(repoDir, "scratch.txt"), []byte("notes\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	card := &discoverResult{CardID: "card-reconcile", BoardID: boardID, Title: "A1b duplicate scope", DefaultBranch: "main"}
	llmResult := &llmStageResult{
		implResult: &implementResult{
			Status:     "done",
			Resolution: resolutionNeedsReconcile,
			Summary:    "Scope looks already delivered by card 89dd9099 / PR #38, but I'm not certain enough to close it myself.",
		},
	}

	done, err := strat.gitCommitAndPush(
		context.Background(), context.Background(),
		loop, card, "exec-reconcile", repoDir, branch, false,
		func() {}, silentLogger(), llmResult,
	)
	if err != nil {
		t.Fatalf("gitCommitAndPush: %v", err)
	}
	if !done {
		t.Fatal("declared needs_reconcile must terminate the tick (done=true)")
	}
	assertReconcilePark(t, loop, cap, card.CardID)

	// Nothing committed: the scratch changes are still uncommitted in the tree.
	hasChanges, err := gitMgr.HasChanges(context.Background(), repoDir)
	if err != nil {
		t.Fatalf("HasChanges: %v", err)
	}
	if !hasChanges {
		t.Error("declared needs_reconcile must not commit/push working-tree changes")
	}

	// Sentinel set so the lifecycle walk stops at the park.
	if llmResult.implResult.Status != statusReconcileParked {
		t.Errorf("reconcile park must set the %q sentinel status, got %q", statusReconcileParked, llmResult.implResult.Status)
	}
}

// Load-bearing label: if the `needs-reconcile` PATCH fails, the park did not
// bind — ending the tick as a clean success would leave the card discoverable
// by the implementer (loop). Must fall back to the bounded no-changes flow.
func TestGitCommitAndPush_ReconcileParkLabelWriteFails_FallsBackToBoundedFailure(t *testing.T) {
	boardID := "b"
	srv, cap := duplicateCloseServer(t, boardID)
	cap.failCardPatch = true // label PATCH 500s — the park cannot bind
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	strat := writesCodeStrategy()

	bare := initBareRemote(t)
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, "card-recfail")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, "card-recfail", "main")
	if err != nil {
		t.Fatalf("branch: %v", err)
	}

	card := &discoverResult{CardID: "card-recfail", BoardID: boardID, Title: "dup", DefaultBranch: "main"}
	llmResult := &llmStageResult{
		implResult: &implementResult{Status: "done", Resolution: resolutionNeedsReconcile, Summary: "suspected duplicate"},
	}

	done, err := strat.gitCommitAndPush(
		context.Background(), context.Background(),
		loop, card, "exec-recfail", repoDir, branch, false,
		func() {}, silentLogger(), llmResult,
	)
	if err != nil {
		t.Fatalf("gitCommitAndPush: %v", err)
	}
	if !done {
		t.Fatal("tick must still terminate (done=true)")
	}
	if cap.noteTitled("Card parked for board reconciliation") {
		t.Error("a park that failed to bind must NOT write the parked note (the card is not safe)")
	}
	if n := loop.NoChangeReworkCount(card.CardID); n != 1 {
		t.Errorf("failed park must fall back to no-change breaker accounting, no_op_count=%d want 1", n)
	}
	if n := loop.CardFailureCount(card.CardID); n != 1 {
		t.Errorf("failed park must take the ordinary failure path, failure_count=%d want 1", n)
	}
}

// The implement scaffolding must teach the needs_reconcile response form so a
// suspected cross-card duplicate self-identifies at implement time.
func TestImplementPrompts_TeachNeedsReconcileResolution(t *testing.T) {
	for name, prompt := range map[string]string{
		"implement":                implementPrompt(PromptContext{}),
		"implement_after_approval": implementAfterApprovalPrompt(PromptContext{}),
	} {
		if !strings.Contains(prompt, `"resolution":"needs_reconcile"`) {
			t.Errorf("%s prompt must teach the needs_reconcile response form", name)
		}
	}
}
