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

// IMPOSSIBLE-CARD loop (a live run, 2026-06-26: cards I6 `69636dd9` and
// B6c `4cd691de`). A writes_code stage claims a card it CANNOT complete because
// the card needs a HUMAN decision or EXTERNAL input that is not code — an
// architecture choice + a CI secret (B6c), real data from a different/legacy
// repo (I6), a licensed asset (A3b). The agent correctly refuses to fabricate
// filler (cero-dead-code), creates a branch, investigates, writes nothing real,
// sheds its hero, and releases — but NOTHING durably parks the card, so the
// scheduler re-offers it every poll (B6c looped 25x in 21min, burning budget,
// until a human hand-applied `blocked`).
//
// The existing brakes all miss this: parkForBlocked fires only on a `blocked`
// DECISION (the agent never declares one); the empty-LLM breaker needs EMPTY
// output (the investigation is non-empty); the no-op backstop is defeated by an
// investigative scratch commit that resets the per-card counter.
//
// The cure (same failure CLASS + same generic resolution pattern as
// duplicate / needs_runtime_proof / needs_reconcile): a NEW declared resolution
// `cannot_proceed` that any writes_code role can emit when the card needs human
// input it cannot supply. It routes to the EXISTING human-gated `parkForBlocked`
// (durable `blocked` label, note, unassign, execution aborted) — reusing the
// blocked machinery, no new label, no new config, no split-brain. Generic across
// every code-writing role; keyed strictly on the declared resolution.

func TestGitCommitAndPush_DeclaredCannotProceed_ParksBlocked(t *testing.T) {
	boardID := "b"
	srv, cap := duplicateCloseServer(t, boardID)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	strat := writesCodeStrategy()

	bare := initBareRemote(t)
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, "card-cannot")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, "card-cannot", "main")
	if err != nil {
		t.Fatalf("branch: %v", err)
	}
	// Clean tree, nothing committed: the genuine impossible-card no-diff. The
	// park is ordered AFTER the ahead>0 / duplicate checks, so it only catches
	// this case (a committed-WIP branch would ship instead — see the survives test).

	card := &discoverResult{CardID: "card-cannot", BoardID: boardID, Title: "B6c publish channel (human decision)", DefaultBranch: "main"}
	llmResult := &llmStageResult{
		implResult: &implementResult{
			Status:     "done",
			Resolution: resolutionCannotProceed,
			Summary:    "This card needs a human to choose a publish registry and provision a CI secret — no code change can complete it.",
		},
	}

	done, err := strat.gitCommitAndPush(
		context.Background(), context.Background(),
		loop, card, "exec-cannot", repoDir, branch, false,
		func() {}, silentLogger(), llmResult,
	)
	if err != nil {
		t.Fatalf("gitCommitAndPush: %v", err)
	}
	if !done {
		t.Fatal("declared cannot_proceed must terminate the tick (done=true)")
	}

	// Parks via the generic blocked machinery: durable label, note, unassign, abort.
	if !cap.labelPatched(blockedLabel) {
		t.Errorf("cannot_proceed park must stamp the `%s` label so the card leaves discovery, patches=%v", blockedLabel, cap.patches)
	}
	if cap.unassignCount() == 0 {
		t.Errorf("cannot_proceed park must unassign the agent, unassigns=%v", cap.unassigns)
	}
	if !cap.noteTitled("Card blocked — parked for human follow-up") {
		t.Errorf("cannot_proceed park must write the human-follow-up note, notes=%v", cap.notes)
	}
	if !cap.executionPatchedStatus("aborted") {
		t.Errorf("cannot_proceed park must close the execution as aborted, exec_patches=%v", cap.execPatches)
	}

	// Nothing committed and nothing pushed: the impossible card never reaches PR.
	ahead, err := gitMgr.CommitsAheadOfRemoteDefault(context.Background(), repoDir, "main")
	if err != nil {
		t.Fatalf("CommitsAheadOfRemoteDefault: %v", err)
	}
	if ahead != 0 {
		t.Errorf("cannot_proceed must not commit work, commits_ahead=%d", ahead)
	}

	// Sentinel set so the lifecycle walk stops at the park (no create_pr / ship).
	if llmResult.implResult.Status != statusBlockedParked {
		t.Errorf("cannot_proceed park must set the %q sentinel status, got %q", statusBlockedParked, llmResult.implResult.Status)
	}
}

// Load-bearing label: if the `blocked` PATCH fails, the park did not bind —
// ending the tick as a clean success would leave the card discoverable (loop).
// Must fall back to the bounded no-changes flow.
func TestGitCommitAndPush_CannotProceedLabelWriteFails_FallsBackToBounded(t *testing.T) {
	boardID := "b"
	srv, cap := duplicateCloseServer(t, boardID)
	cap.failCardPatch = true // label PATCH 500s — the park cannot bind
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	strat := writesCodeStrategy()

	bare := initBareRemote(t)
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, "card-cpfail")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, "card-cpfail", "main")
	if err != nil {
		t.Fatalf("branch: %v", err)
	}

	card := &discoverResult{CardID: "card-cpfail", BoardID: boardID, Title: "x", DefaultBranch: "main"}
	llmResult := &llmStageResult{
		implResult: &implementResult{Status: "done", Resolution: resolutionCannotProceed, Summary: "needs human input"},
	}

	done, err := strat.gitCommitAndPush(
		context.Background(), context.Background(),
		loop, card, "exec-cpfail", repoDir, branch, false,
		func() {}, silentLogger(), llmResult,
	)
	if err != nil {
		t.Fatalf("gitCommitAndPush: %v", err)
	}
	if !done {
		t.Fatal("tick must still terminate (done=true)")
	}
	if cap.noteTitled("Card blocked — parked for human follow-up") {
		t.Error("a park that failed to bind must NOT write the parked note (the card is not safe)")
	}
	if n := loop.NoChangeReworkCount(card.CardID); n != 1 {
		t.Errorf("failed park must fall back to no-change breaker accounting, no_op_count=%d want 1", n)
	}
	if n := loop.CardFailureCount(card.CardID); n != 1 {
		t.Errorf("failed park must take the ordinary failure path, failure_count=%d want 1", n)
	}
}

// cannot_proceed must order AFTER declaredDuplicate and AFTER the ahead>0 clear:
// a real duplicate (change already on base) or a committed-WIP branch must still
// win, so this park only catches the genuine "needs human input" no-op.
func TestGitCommitAndPush_CannotProceed_DoesNotPreemptDuplicate(t *testing.T) {
	boardID := "b"
	srv, cap := duplicateCloseServer(t, boardID)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	strat := writesCodeStrategy()

	bare := initBareRemote(t)
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, "card-dupwins")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, "card-dupwins", "main")
	if err != nil {
		t.Fatalf("branch: %v", err)
	}

	// A result that (incoherently) declares BOTH — duplicate must win, since the
	// ladder checks declaredDuplicate first. Guards ordering.
	card := &discoverResult{CardID: "card-dupwins", BoardID: boardID, Title: "dup", DefaultBranch: "main"}
	llmResult := &llmStageResult{
		implResult: &implementResult{Status: "done", Resolution: resolutionDuplicate, Summary: "already on base"},
	}

	done, err := strat.gitCommitAndPush(
		context.Background(), context.Background(),
		loop, card, "exec-dupwins", repoDir, branch, false,
		func() {}, silentLogger(), llmResult,
	)
	if err != nil {
		t.Fatalf("gitCommitAndPush: %v", err)
	}
	if !done {
		t.Fatal("declared duplicate must terminate the tick")
	}
	// Closed as duplicate (success terminal), NOT parked blocked.
	if cap.labelPatched(blockedLabel) {
		t.Error("a declared duplicate must NOT be parked as blocked — duplicate wins the ladder")
	}
}

// Committed-WIP must survive a cannot_proceed declaration: the park is ordered
// AFTER the ahead>0 clear, so a branch that already has real commits ships to PR
// rather than being parked-and-abandoned. Guards the ordering bug the adversarial
// review caught (an early-placed park discarded committed work). The contract:
// cannot_proceed only catches a GENUINE no-diff impossible card.
func TestGitCommitAndPush_CannotProceed_DoesNotDiscardCommittedWork(t *testing.T) {
	boardID := "b"
	srv, cap := duplicateCloseServer(t, boardID)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	strat := writesCodeStrategy()

	bare := initBareRemote(t)
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, "card-wip")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, "card-wip", "main")
	if err != nil {
		t.Fatalf("branch: %v", err)
	}
	// Real work committed on the branch (clean tree, but ahead of base).
	if err := os.WriteFile(filepath.Join(repoDir, "feature.go"), []byte("package x\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := gitMgr.CommitAll(context.Background(), repoDir, "feat: real work"); err != nil {
		t.Fatalf("commit: %v", err)
	}

	card := &discoverResult{CardID: "card-wip", BoardID: boardID, Title: "x", DefaultBranch: "main"}
	llmResult := &llmStageResult{
		implResult: &implementResult{Status: "done", Resolution: resolutionCannotProceed, Summary: "late declaration after work was committed"},
	}

	done, err := strat.gitCommitAndPush(
		context.Background(), context.Background(),
		loop, card, "exec-wip", repoDir, branch, false,
		func() {}, silentLogger(), llmResult,
	)
	if err != nil {
		t.Fatalf("gitCommitAndPush: %v", err)
	}
	// ahead>0 wins: the committed branch proceeds to PR (done=false), NOT parked.
	if done {
		t.Fatal("committed-ahead work must ship (done=false), not be parked by a late cannot_proceed")
	}
	if cap.labelPatched(blockedLabel) {
		t.Error("committed-ahead work must NOT be parked as blocked — the ahead>0 path wins")
	}
}

// The implement scaffolding must teach the cannot_proceed response form so a
// human-input-required card self-identifies at implement time (generic, both
// the runner-side prompt and the backend default prompt).
func TestImplementPrompts_TeachCannotProceedResolution(t *testing.T) {
	for name, prompt := range map[string]string{
		"implement":                implementPrompt(PromptContext{}),
		"implement_after_approval": implementAfterApprovalPrompt(PromptContext{}),
	} {
		if !strings.Contains(prompt, `"resolution":"cannot_proceed"`) {
			t.Errorf("%s prompt must teach the cannot_proceed response form", name)
		}
	}
}
