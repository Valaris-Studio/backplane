// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"errors"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// Same seam family as C1 (runtime-proof park): on the lifecycle path,
// closeAsDuplicate is a TERMINAL — the card is already moved to done, labeled
// `duplicate`, unassigned, and its execution closed as "completed" (M1). But
// lifecycleLLM used to surface it as decision "no_changes" and let the walk
// CONTINUE: the default-shaped implement step has no "no_changes" branch, so
// the walk fell through to create_pr — a succeeding gh would open a PR for a
// CLOSED card; a failing gh would route on_failure → fail_move_back and drag
// the duplicate-closed card from done back into active. The walk must stop AT
// the close (ErrSuspended + execution_released), exactly like the
// statusRuntimeProofParked sentinel — with one difference: a duplicate close
// is a SUCCESS terminal, so the execution stays "completed", never "aborted".

// A declared duplicate on the full default-shaped walk (llm → open_pr → ship,
// fail_move_back as the on_failure chain) with a SUCCEEDING gh: if the walk
// leaked past the close, a PR would open and the card would ship to review.
func TestLifecycleWalk_DeclaredDuplicateClose_StopsWalkNoPR(t *testing.T) {
	ghLog := fakeGH(t, "https://github.com/test/repo/pull/90")
	srv, cap := salvageCaptureServer(t, "board-1", "card-dup-walk")
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	mock := llm.NewMockProvider(mustJSON(t, map[string]string{
		"status": "done", "resolution": "duplicate",
		"summary": "Already fixed on main (sibling PR shipped it); no diff possible.",
	}))
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, testConfig())
	strat := salvageStrategy()

	ws, _ := salvageWalkFixture(t, gitMgr, loop, strat, "card-dup-walk")
	ws.ExecutionID = "exec-dup-walk"

	err := (lifecycle.Walker{}).Walk(context.Background(), ws, runtimeProofWalkSteps())
	if !errors.Is(err, lifecycle.ErrSuspended) {
		t.Fatalf("walk must stop cleanly at the duplicate close; got %v", err)
	}

	// The close happened (SUCCESS terminal)...
	if !cap.movedToColumn("col-done") {
		t.Errorf("duplicate close must move the card to done, moves=%v", cap.moves)
	}
	if !cap.labelApplied(duplicateLabel) {
		t.Errorf("duplicate close must stamp the `duplicate` label, patches=%v", cap.patches)
	}
	if !cap.execStatusSeen("completed") {
		t.Errorf("duplicate close is a SUCCESS terminal — execution must be completed, exec_patches=%v", cap.execPatches)
	}
	if cap.execStatusSeen("aborted") {
		t.Errorf("duplicate close must NOT abort the execution (that is the park shape), exec_patches=%v", cap.execPatches)
	}
	if cap.execStatusSeen("failed") {
		t.Errorf("duplicate close must not fail the execution, exec_patches=%v", cap.execPatches)
	}
	// ...and NOTHING ran after it.
	if n := ghCallCount(t, ghLog); n != 0 {
		t.Errorf("no PR may be opened for a duplicate-closed card, gh calls=%d", n)
	}
	if cap.movedToColumn("col-review") {
		t.Errorf("a duplicate-closed card must not ship to review, moves=%v", cap.moves)
	}
	if cap.movedToColumn("col-active") {
		t.Errorf("a duplicate-closed card must not be re-asserted into active, moves=%v", cap.moves)
	}
	if n := loop.CardFailureCount("card-dup-walk"); n != 0 {
		t.Errorf("duplicate close must record no card failure, count=%d", n)
	}
	if released, _ := ws.Get("execution_released"); released != true {
		t.Error("duplicate close must flag execution_released so tickViaLifecycle doesn't override the completed close")
	}
}

// Same walk with a FAILING gh: if the walk leaked, open_pr would error and the
// on_failure fail_move_back would drag the just-closed card from done back to
// active — re-opening the exact re-reservation loop the duplicate close exists
// to end.
func TestLifecycleWalk_DeclaredDuplicateClose_FailMoveCannotDragCardBack(t *testing.T) {
	ghLog := failingGH(t)
	srv, cap := salvageCaptureServer(t, "board-1", "card-dup-drag")
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	mock := llm.NewMockProvider(mustJSON(t, map[string]string{
		"status": "done", "resolution": "duplicate",
		"summary": "Requested change already on base.",
	}))
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, testConfig())
	strat := salvageStrategy()

	ws, _ := salvageWalkFixture(t, gitMgr, loop, strat, "card-dup-drag")
	ws.ExecutionID = "exec-dup-drag"

	err := (lifecycle.Walker{}).Walk(context.Background(), ws, runtimeProofWalkSteps())
	if !errors.Is(err, lifecycle.ErrSuspended) {
		t.Fatalf("walk must stop cleanly at the duplicate close; got %v", err)
	}

	if cap.movedToColumn("col-active") {
		t.Errorf("fail_move_back must never drag the duplicate-closed card out of done, moves=%v", cap.moves)
	}
	if n := ghCallCount(t, ghLog); n != 0 {
		t.Errorf("no gh invocation may run after the close, gh calls=%d", n)
	}
	if !cap.movedToColumn("col-done") {
		t.Errorf("duplicate close must move the card to done, moves=%v", cap.moves)
	}
	if !cap.execStatusSeen("completed") {
		t.Errorf("execution must stay completed, exec_patches=%v", cap.execPatches)
	}
}
