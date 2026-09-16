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

// C1 (adversarial review of FIX #4): on the lifecycle path the runtime-proof
// park MUST stop the walk the way the approval park does (ErrSuspended +
// execution_released). Before this fix, lifecycleLLM returned decision
// "no_changes" after the park and the walk CONTINUED: the default-shaped
// implement step has no "no_changes" branch, so it fell through to create_pr,
// which failed on the no-op branch, routed to on_failure, and the configured
// fail-move re-asserted the JUST-PARKED card into `active` — re-opening the
// exact money-loop class FIX #4/#5 exist to kill (the kind_move_card guard
// keys on IsCardBlocked, which the park leaves empty by design: a park is not
// a failure).

// failingGH installs a stub `gh` on PATH that records each invocation and
// exits 1 — the create_pr step then errors exactly like production gh does on
// a no-op branch, exposing the on_failure → fail-move route.
func failingGH(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	logFile := filepath.Join(dir, "gh-calls.log")
	script := "#!/bin/sh\necho '---CALL---' >> " + logFile + "\nexit 1\n"
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0755); err != nil {
		t.Fatalf("write gh shim: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return logFile
}

// runtimeProofWalkSteps is the default-shaped implement walk fragment: llm →
// create_pr → ship, with the production-shaped fail-move back to active as the
// on_failure chain. No "no_changes" branch — exactly the shape that exposed C1.
func runtimeProofWalkSteps() []valaris.LifecycleStep {
	return []valaris.LifecycleStep{
		{Name: "implement", Kind: "llm", Next: "open_pr", OnFailure: "fail_move_back",
			Params: map[string]any{"stage": "implement", "post_process_kind": "writes_code"}},
		{Name: "open_pr", Kind: "create_pr", Next: "ship_to_review", OnFailure: "fail_move_back"},
		{Name: "ship_to_review", Kind: "ship", Params: map[string]any{"to_column_type": "review"}},
		{Name: "fail_move_back", Kind: "move_card", Params: map[string]any{"to_column_type": "active"}},
	}
}

// A no-diff implement on a runtime-proof-labeled card, walked through the FULL
// lifecycle: the walk must stop AT the park (ErrSuspended), with no PR attempt,
// no fail-move back to active, the blocked label stamped, and the execution
// closed as aborted (not dangling `running`, not failed).
func TestLifecycleWalk_RuntimeProofNoDiff_StopsAtPark(t *testing.T) {
	ghLog := failingGH(t)
	srv, cap := salvageCaptureServer(t, "board-1", "card-rp-walk")
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	mock := llm.NewMockProvider(mustJSON(t, map[string]string{
		"status": "done", "summary": "runtime step, not more code",
	}))
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, testConfig())
	strat := salvageStrategy()

	ws, _ := salvageWalkFixture(t, gitMgr, loop, strat, "card-rp-walk")
	cardFromWalk(ws).Labels = []string{needsRuntimeProofLabel}
	ws.ExecutionID = "exec-rp-walk"

	err := (lifecycle.Walker{}).Walk(context.Background(), ws, runtimeProofWalkSteps())
	if !errors.Is(err, lifecycle.ErrSuspended) {
		t.Fatalf("walk must stop at the park with lifecycle.ErrSuspended; got %v", err)
	}

	// The walk stopped AT the park: downstream steps never ran.
	if n := ghCallCount(t, ghLog); n != 0 {
		t.Errorf("park must stop the walk before create_pr — no PR attempt allowed, gh calls=%d", n)
	}
	if cap.movedToColumn("col-active") {
		t.Errorf("the fail-move must NOT re-assert the parked card into active, moves=%v", cap.moves)
	}
	if cap.movedToColumn("col-review") {
		t.Errorf("a parked card must NOT ship to review, moves=%v", cap.moves)
	}
	// The park itself bound: durable label + no failure bookkeeping.
	if !cap.labelApplied(blockedLabel) {
		t.Errorf("park must stamp the blocked label, patches=%v", cap.patches)
	}
	if n := loop.CardFailureCount("card-rp-walk"); n != 0 {
		t.Errorf("park must record no card failure, count=%d", n)
	}
	// M1: the raising execution is closed (aborted), and flagged released so
	// tickViaLifecycle does not close it a second time.
	if !cap.execStatusSeen("aborted") {
		t.Errorf("park must close the execution as aborted, exec_patches=%v", cap.execPatches)
	}
	if cap.execStatusSeen("failed") {
		t.Errorf("park must not fail the execution, exec_patches=%v", cap.execPatches)
	}
	if released, _ := ws.Get("execution_released"); released != true {
		t.Error("park must flag execution_released so tickViaLifecycle doesn't double-close")
	}
}

// Declared form with COMMITS AHEAD on the branch: the stage itself declared
// "this card's Done condition is a runtime observation I cannot perform", so
// the walk must park and stop — NOT continue through create_pr/ship and merge
// a card whose own park note says a human must verify it first.
func TestLifecycleWalk_DeclaredRuntimeProofWithCommitsAhead_ParksDoesNotShip(t *testing.T) {
	ghLog := fakeGH(t, "https://github.com/test/repo/pull/99") // a SUCCEEDING gh: shipping would work if attempted
	srv, cap := salvageCaptureServer(t, "board-1", "card-rp-declared")
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	mock := llm.NewMockProvider(mustJSON(t, map[string]string{
		"status": "done", "resolution": "needs_runtime_proof",
		"summary": "Done condition is a clean-machine runtime observation I cannot perform.",
	}))
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, testConfig())
	strat := salvageStrategy()

	ws, repoDir := salvageWalkFixture(t, gitMgr, loop, strat, "card-rp-declared")
	ws.ExecutionID = "exec-rp-declared"
	// Scratch commits exist on the branch — the declaration must still win.
	commitOnBranch(t, gitMgr, repoDir, "notes.md", "chore: investigation notes")

	err := (lifecycle.Walker{}).Walk(context.Background(), ws, runtimeProofWalkSteps())
	if !errors.Is(err, lifecycle.ErrSuspended) {
		t.Fatalf("walk must stop at the park with lifecycle.ErrSuspended; got %v", err)
	}

	if n := ghCallCount(t, ghLog); n != 0 {
		t.Errorf("declared runtime-proof must never open a PR, gh calls=%d", n)
	}
	if cap.movedToColumn("col-review") {
		t.Errorf("declared runtime-proof must never ship to review, moves=%v", cap.moves)
	}
	if cap.movedToColumn("col-active") {
		t.Errorf("declared runtime-proof must not bounce back to active either, moves=%v", cap.moves)
	}
	if !cap.labelApplied(blockedLabel) {
		t.Errorf("park must stamp the blocked label, patches=%v", cap.patches)
	}
	if !cap.execStatusSeen("aborted") {
		t.Errorf("park must close the execution as aborted, exec_patches=%v", cap.execPatches)
	}
	if released, _ := ws.Get("execution_released"); released != true {
		t.Error("park must flag execution_released")
	}
	if n := loop.CardFailureCount("card-rp-declared"); n != 0 {
		t.Errorf("park must record no card failure, count=%d", n)
	}
}
