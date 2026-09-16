// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// writesCodeStrategyIntegrationBase is writesCodeStrategy but with the
// create_branch base pinned to integration_branch — the DEFAULT_PIPELINE_CONFIG
// shape for an integration-based board (workspace_config.py base_ref:
// "integration_branch").
func writesCodeStrategyIntegrationBase() *DataDrivenStrategy {
	return NewDataDrivenStrategy(valaris.StageConfig{
		Role: "implementer",
		Git:  valaris.GitDef{Action: "create_branch", BaseRef: "integration_branch"},
		LLM: valaris.LLMDef{
			Enabled:         true,
			Stage:           "implement",
			PostProcessKind: "writes_code",
		},
	}, nil)
}

// pushBranchAheadOf pushes a new branch `name` to the bare remote that is N
// commits ahead of `base` — used to seed an `integration` branch ahead of
// `main`. The commits are empty (history only); the point is the branch is
// AHEAD of base, not what it contains.
func pushBranchAheadOf(t *testing.T, bare, name, base string, commits int) {
	t.Helper()
	scratch := t.TempDir()
	run(t, "", "git", "clone", bare, scratch)
	run(t, scratch, "git", "config", "user.email", "test@valaris.dev")
	run(t, scratch, "git", "config", "user.name", "Test")
	run(t, scratch, "git", "checkout", "-b", name, "origin/"+base)
	for i := 0; i < commits; i++ {
		run(t, scratch, "git", "commit", "--allow-empty", "-m", "integration-only history")
	}
	run(t, scratch, "git", "push", "origin", name)
}

// FCH-3 (a live invoicing-hub run): a stub card forks off the
// integration branch and produces ZERO real commits. Its branch is therefore 0
// commits ahead of integration (the real base) but MANY ahead of main (the repo
// default), because it inherited integration's history. The no-working-tree-
// changes path counts commits ahead of the DEFAULT branch (main), reads a
// positive count, and wrongly concludes "work already committed → proceed to
// PR". No diff vs base → no PR → re-reserve → loop, AND it ClearNoChangeRework's
// the counter so FCH-2's backend cap never accumulates either.
//
// The fix: count ahead against the card's REAL base (resolveBaseRef →
// integration_branch), not the repo default. Against integration the count is 0,
// so the genuine no-op is recognized and the bounded no-changes failure path
// runs (done=true, failure recorded) — exactly like a fresh empty branch.
func TestGitCommitAndPush_NoCommitsAheadOfIntegrationBaseIsFailure(t *testing.T) {
	bare := initBareRemote(t)
	// Seed origin/integration a few commits ahead of origin/main.
	pushBranchAheadOf(t, bare, "integration", "main", 3)

	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, "test-repo")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	// Fork the card branch off integration (the card's real base) — NO new commits.
	run(t, repoDir, "git", "fetch", "origin")
	branch := "runner/card-e1-stub"
	run(t, repoDir, "git", "checkout", "-b", branch, "origin/integration")

	// Sanity: the stub branch is 0 ahead of integration but >0 ahead of main.
	aheadMain, err := gitMgr.CommitsAheadOfRemoteDefault(context.Background(), repoDir, "main")
	if err != nil {
		t.Fatalf("ahead of main: %v", err)
	}
	if aheadMain == 0 {
		t.Fatalf("setup invariant: stub must be ahead of main (inherited integration history), got 0")
	}
	aheadIntegration, err := gitMgr.CommitsAheadOfRemoteDefault(context.Background(), repoDir, "integration")
	if err != nil {
		t.Fatalf("ahead of integration: %v", err)
	}
	if aheadIntegration != 0 {
		t.Fatalf("setup invariant: stub must be 0 ahead of integration (no real work), got %d", aheadIntegration)
	}

	srv, _ := kindHandlersServer(t, "b")
	cfg := testConfig()
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, cfg)
	strat := writesCodeStrategyIntegrationBase()

	// The card carries BOTH branches: DefaultBranch=main, IntegrationBranch=integration.
	card := &discoverResult{
		CardID:            "card-e1-stub",
		BoardID:           "b",
		Title:             "E1 stub (no real work, integration-based)",
		DefaultBranch:     "main",
		IntegrationBranch: "integration",
	}

	before := loop.CardFailureCount(card.CardID)
	done, err := strat.gitCommitAndPush(
		context.Background(), context.Background(),
		loop, card, "exec-e1", repoDir, branch, false,
		func() {}, silentLogger(), nil,
	)
	if err != nil {
		t.Fatalf("gitCommitAndPush err: %v", err)
	}
	if !done {
		t.Error("a stub branch with 0 commits ahead of its REAL base (integration) is a genuine no-op — must return done=true (park/fail), NOT done=false 'proceed to PR' which re-reserves forever (FCH-3 loop)")
	}
	if after := loop.CardFailureCount(card.CardID); after <= before {
		t.Errorf("CardFailureCount before=%d after=%d: the no-op must record a failure so the bounded backstop accumulates (not ClearNoChangeRework'd)", before, after)
	}
}
