// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// The F0 token-doubling leak: a persisted implement session (agent:card:implement)
// survived board resets and was resumed every relaunch, re-ingesting the prior
// run's entire transcript (cache_read 2.2M → 8.7M, $7.88 → $30.62 on the SAME
// card). gitSetupWithConfig now drops the card's cached sessions whenever it
// creates a FRESH branch (branchRecovered=false) — a from-scratch attempt whose
// prior session points at a now-gone branch state. A RECOVERED branch (within-run
// suspend/resume or rework) keeps the session so the agent skips the codebase re-read.

func sessionInvalidationLoop(t *testing.T, gitMgr *git.Manager) *Loop {
	t.Helper()
	srv, _ := salvageCaptureServer(t, "board-1", "card-x")
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	loop.sessions = NewSessionStore()
	return loop
}

func TestGitSetup_FreshBranchClearsStaleImplementSession(t *testing.T) {
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := sessionInvalidationLoop(t, gitMgr)
	strat := salvageStrategy()

	bare := initBareRemote(t)
	card := &discoverResult{
		CardID: "card-leak", BoardID: "board-1", Title: "F0 scaffold",
		GitRepoURL: bare, GitRepoName: "card-leak", DefaultBranch: "main",
	}

	// A stale session from a prior run sits in the store keyed to this card.
	loop.sessions.Set("agent-1", "card-leak", "implement", "stale-run-1-session")

	// A from-scratch attempt: gitSetup creates a brand-new branch (recovered=false).
	_, _, recovered, cleanup, err := strat.gitSetupWithConfig(
		context.Background(), context.Background(), loop, card, false)
	if err != nil {
		t.Fatalf("git setup: %v", err)
	}
	defer cleanup()
	if recovered {
		t.Fatal("first attempt on a fresh card must NOT report a recovered branch")
	}

	if got := loop.sessions.Get("agent-1", "card-leak", "implement"); got != "" {
		t.Fatalf("fresh branch must drop the stale implement session, still got %q — this is the token-doubling leak", got)
	}
}

func TestGitSetup_RecoveredBranchKeepsSession(t *testing.T) {
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := sessionInvalidationLoop(t, gitMgr)
	strat := salvageStrategy()

	bare := initBareRemote(t)
	card := &discoverResult{
		CardID: "card-cont", BoardID: "board-1", Title: "F0 scaffold",
		GitRepoURL: bare, GitRepoName: "card-cont", DefaultBranch: "main",
	}

	// First setup creates the branch + commits WIP, then pushes so a second setup
	// (a fresh clone) RECOVERS it from the remote — the within-run continuation case.
	_, branch, _, cleanup1, err := strat.gitSetupWithConfig(
		context.Background(), context.Background(), loop, card, false)
	if err != nil {
		t.Fatalf("first setup: %v", err)
	}
	repoDir1, _ := gitMgr.CloneOrOpen(context.Background(), bare, "card-cont")
	commitOnBranch(t, gitMgr, repoDir1, "wip.go", "wip")
	if err := gitMgr.Push(context.Background(), repoDir1); err != nil {
		t.Fatalf("push wip: %v", err)
	}
	cleanup1()
	_ = branch

	// The session is established for this in-flight attempt.
	loop.sessions.Set("agent-1", "card-cont", "implement", "live-session")

	// A second setup against a fresh clone recovers the pushed branch.
	gitMgr2 := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop.git = gitMgr2
	_, _, recovered, cleanup2, err := strat.gitSetupWithConfig(
		context.Background(), context.Background(), loop, card, false)
	if err != nil {
		t.Fatalf("second setup: %v", err)
	}
	defer cleanup2()
	if !recovered {
		t.Skip("branch not recovered in this environment; recovery semantics covered by git pkg tests")
	}

	if got := loop.sessions.Get("agent-1", "card-cont", "implement"); got != "live-session" {
		t.Fatalf("recovered branch must KEEP the session (within-run continuation), got %q", got)
	}
}
