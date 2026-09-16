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

// FIX #4 (run-B): cards whose Done condition is a RUNTIME OBSERVATION
// ("prove it works at runtime") are not code-diff tasks — the implementer
// correctly produces no diff, but the pipeline read no-diff as failure →
// re-reserve → money-loop. A no-diff on a card carrying the verification
// signal must instead park HUMAN-GATED on the FIRST no-diff: blocked label +
// unassign + board-visible note, with NO failure recorded and NO no-op counter
// increment (it is a correct outcome, not a strike).

func runtimeProofTickOnce(t *testing.T, gitMgr *git.Manager, loop *Loop, strat *DataDrivenStrategy, card *discoverResult, llmResult *llmStageResult) bool {
	t.Helper()
	bare := initBareRemote(t)
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, card.CardID)
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, card.CardID, "main")
	if err != nil {
		t.Fatalf("branch: %v", err)
	}
	done, err := strat.gitCommitAndPush(
		context.Background(), context.Background(),
		loop, card, "exec-rp", repoDir, branch, false,
		func() {}, silentLogger(), llmResult,
	)
	if err != nil {
		t.Fatalf("gitCommitAndPush: %v", err)
	}
	return done
}

func assertRuntimeProofPark(t *testing.T, loop *Loop, cap *dupCloseCapture, cardID string) {
	t.Helper()
	// (a) intrinsic park: blocked label + participant removed.
	if !cap.labelPatched("blocked") {
		t.Errorf("runtime-proof park must stamp the `blocked` label, patches=%v", cap.patches)
	}
	if cap.unassignCount() == 0 {
		t.Errorf("runtime-proof park must unassign the agent, unassigns=%v", cap.unassigns)
	}
	// (b) board-visible note explaining the human gate.
	if !cap.noteTitled("Runtime-proof card parked for human verification") {
		t.Errorf("runtime-proof park must write the human-verification note, notes=%v", cap.notes)
	}
	// (c) NOT a failure: no failed execution, no failure counter, no no-op strike.
	if cap.executionFailed() {
		t.Errorf("runtime-proof park must NOT fail the execution, exec_patches=%v", cap.execPatches)
	}
	// M1: the raising execution is closed as aborted — never left dangling as
	// `running` (a dangling row 409s agent_busy on every next_assignment).
	if !cap.executionPatchedStatus("aborted") {
		t.Errorf("runtime-proof park must close the execution as aborted, exec_patches=%v", cap.execPatches)
	}
	if n := loop.CardFailureCount(cardID); n != 0 {
		t.Errorf("runtime-proof park must NOT record a card failure, count=%d", n)
	}
	if n := loop.NoChangeReworkCount(cardID); n != 0 {
		t.Errorf("runtime-proof park must NOT count toward the generic no-op breaker, count=%d", n)
	}
	// Not closed either — a human must verify before this card is done.
	if cap.movedToColumn("col-done") {
		t.Error("runtime-proof park must NOT close the card to done")
	}
}

// Signal: `needs-runtime-proof` label on the discover result. Parks on the
// FIRST no-diff — no second strike, no failure path.
func TestGitCommitAndPush_NoDiffOnRuntimeProofLabeledCard_ParksHumanGated(t *testing.T) {
	boardID := "b"
	srv, cap := duplicateCloseServer(t, boardID)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	strat := writesCodeStrategy()

	card := &discoverResult{
		CardID: "card-verify", BoardID: boardID, Title: "Prove it runs",
		DefaultBranch: "main", Labels: []string{"needs-runtime-proof"},
	}
	llmResult := &llmStageResult{
		implResult: &implementResult{Status: "done", Summary: "nothing to code — runtime verification required"},
	}

	done := runtimeProofTickOnce(t, gitMgr, loop, strat, card, llmResult)
	if !done {
		t.Fatal("runtime-proof park must terminate the tick (done=true)")
	}
	assertRuntimeProofPark(t, loop, cap, card.CardID)
}

// Signal: body marker `Acceptance: runtime-proof` (case-insensitive), read via
// get-card when the discover result carries no labels (legacy discover paths).
func TestGitCommitAndPush_NoDiffOnRuntimeProofBodyMarker_ParksHumanGated(t *testing.T) {
	boardID := "b"
	srv, cap := duplicateCloseServer(t, boardID)
	cap.cardGET = map[string]any{
		"id": "card-marker", "title": "Verify provisioning",
		"labels":      []string{},
		"description": "Run the built app on a clean machine.\n\nACCEPTANCE: Runtime-Proof\n",
	}
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	strat := writesCodeStrategy()

	card := &discoverResult{CardID: "card-marker", BoardID: boardID, Title: "Verify provisioning", DefaultBranch: "main"}
	llmResult := &llmStageResult{
		implResult: &implementResult{Status: "done", Summary: "runtime step, not more code"},
	}

	done := runtimeProofTickOnce(t, gitMgr, loop, strat, card, llmResult)
	if !done {
		t.Fatal("runtime-proof park must terminate the tick (done=true)")
	}
	assertRuntimeProofPark(t, loop, cap, card.CardID)
}

// Declared form (mirrors resolution=duplicate): the stage itself declares the
// Done condition is a runtime observation it cannot perform. Parks regardless
// of diff state — even with working-tree changes nothing is committed/pushed.
func TestGitCommitAndPush_DeclaredNeedsRuntimeProof_ParksRegardlessOfDiff(t *testing.T) {
	boardID := "b"
	srv, cap := duplicateCloseServer(t, boardID)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	strat := writesCodeStrategy()

	bare := initBareRemote(t)
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, "card-declared")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, "card-declared", "main")
	if err != nil {
		t.Fatalf("branch: %v", err)
	}
	// Scratch changes in the tree — the declaration must still win.
	if err := os.WriteFile(filepath.Join(repoDir, "scratch.txt"), []byte("notes\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	card := &discoverResult{CardID: "card-declared", BoardID: boardID, Title: "Verify at runtime", DefaultBranch: "main"}
	llmResult := &llmStageResult{
		implResult: &implementResult{
			Status:     "done",
			Resolution: "needs_runtime_proof",
			Summary:    "Done condition is a clean-machine runtime observation I cannot perform.",
		},
	}

	done, err := strat.gitCommitAndPush(
		context.Background(), context.Background(),
		loop, card, "exec-declared", repoDir, branch, false,
		func() {}, silentLogger(), llmResult,
	)
	if err != nil {
		t.Fatalf("gitCommitAndPush: %v", err)
	}
	if !done {
		t.Fatal("declared needs_runtime_proof must terminate the tick (done=true)")
	}
	assertRuntimeProofPark(t, loop, cap, card.CardID)

	// Nothing committed: the scratch changes are still uncommitted in the tree.
	hasChanges, err := gitMgr.HasChanges(context.Background(), repoDir)
	if err != nil {
		t.Fatalf("HasChanges: %v", err)
	}
	if !hasChanges {
		t.Error("declared needs_runtime_proof must not commit/push working-tree changes")
	}
}

// H2 (adversarial review): the blocked label is the LOAD-BEARING half of the
// park. If the label write fails, the card is NOT parked — ending the tick as
// a clean success would leave it discoverable with zero strikes (an unbounded
// loop on workspaces whose config doesn't exclude the label). The park must
// report failure-to-bind and fall back to the bounded no-changes flow: no-op
// counter incremented, ordinary failure recorded, NO park note claiming the
// card is safe.
func TestGitCommitAndPush_RuntimeProofParkLabelWriteFails_FallsBackToBoundedFailure(t *testing.T) {
	boardID := "b"
	srv, cap := duplicateCloseServer(t, boardID)
	cap.failCardPatch = true // label PATCH 500s — the park cannot bind
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	strat := writesCodeStrategy()

	card := &discoverResult{
		CardID: "card-bindfail", BoardID: boardID, Title: "Prove it runs",
		DefaultBranch: "main", Labels: []string{"needs-runtime-proof"},
	}
	llmResult := &llmStageResult{
		implResult: &implementResult{Status: "done", Summary: "runtime verification required"},
	}

	done := runtimeProofTickOnce(t, gitMgr, loop, strat, card, llmResult)
	if !done {
		t.Fatal("tick must still terminate (done=true)")
	}
	if cap.noteTitled("Runtime-proof card parked for human verification") {
		t.Error("a park that failed to bind must NOT write the parked note (the card is not safe)")
	}
	// Bounded fallback: the generic no-change breaker accounting must engage.
	if n := loop.NoChangeReworkCount(card.CardID); n != 1 {
		t.Errorf("failed park must fall back to no-change breaker accounting, no_op_count=%d want 1", n)
	}
	if n := loop.CardFailureCount(card.CardID); n != 1 {
		t.Errorf("failed park must take the ordinary failure path, failure_count=%d want 1", n)
	}
}

// L1 (adversarial review): the body marker must match the backend's ANCHORED,
// whitespace/case-tolerant line regex — `(?im)^\s*acceptance:\s*runtime-proof\s*$`
// — not a bare one-space substring. A mid-prose mention must never park a card;
// a sloppily spaced marker line must.
func TestRuntimeProofMarker_AnchoredLineSemantics(t *testing.T) {
	t.Run("multi_space_mixed_case_line_matches", func(t *testing.T) {
		boardID := "b"
		srv, cap := duplicateCloseServer(t, boardID)
		cap.cardGET = map[string]any{
			"id": "card-sloppy", "title": "Verify", "labels": []string{},
			"description": "Steps to verify.\n\t ACCEPTANCE:   Runtime-Proof  \nDone when observed.",
		}
		gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
		loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
		strat := writesCodeStrategy()
		card := &discoverResult{CardID: "card-sloppy", BoardID: boardID, Title: "Verify", DefaultBranch: "main"}
		llmResult := &llmStageResult{implResult: &implementResult{Status: "done", Summary: "runtime step"}}

		if done := runtimeProofTickOnce(t, gitMgr, loop, strat, card, llmResult); !done {
			t.Fatal("tick must terminate")
		}
		if !cap.noteTitled("Runtime-proof card parked for human verification") {
			t.Errorf("a whitespace/case-sloppy marker LINE must still park the card, notes=%v", cap.notes)
		}
	})

	t.Run("mid_prose_mention_does_not_match", func(t *testing.T) {
		boardID := "b"
		srv, cap := duplicateCloseServer(t, boardID)
		cap.cardGET = map[string]any{
			"id": "card-prose", "title": "Docs", "labels": []string{},
			"description": "This card discusses the acceptance: runtime-proof gates in passing prose only.",
		}
		gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
		loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
		strat := writesCodeStrategy()
		card := &discoverResult{CardID: "card-prose", BoardID: boardID, Title: "Docs", DefaultBranch: "main"}
		llmResult := &llmStageResult{implResult: &implementResult{Status: "done", Summary: "nothing to do"}}

		if done := runtimeProofTickOnce(t, gitMgr, loop, strat, card, llmResult); !done {
			t.Fatal("tick must terminate")
		}
		if cap.noteTitled("Runtime-proof card parked for human verification") {
			t.Error("a mid-prose mention must NOT park the card")
		}
		if n := loop.CardFailureCount(card.CardID); n != 1 {
			t.Errorf("non-marker card must take the ordinary no-changes failure path, failure_count=%d want 1", n)
		}
	})
}

// The hardcoded implement scaffolding must teach the declared form the same
// way close_as_duplicate is taught, so every runtime-proof card self-identifies
// at implement time instead of looping.
func TestImplementPrompts_TeachNeedsRuntimeProofResolution(t *testing.T) {
	for name, prompt := range map[string]string{
		"implement":                implementPrompt(PromptContext{}),
		"implement_after_approval": implementAfterApprovalPrompt(PromptContext{}),
	} {
		if !strings.Contains(prompt, `"resolution":"needs_runtime_proof"`) {
			t.Errorf("%s prompt must teach the needs_runtime_proof response form", name)
		}
	}
}
