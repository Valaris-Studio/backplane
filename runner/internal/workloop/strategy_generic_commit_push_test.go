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
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// writesCodeStrategy builds the implementer-shaped stage that flows into
// gitCommitAndPush (create_branch + writes_code).
func writesCodeStrategy() *DataDrivenStrategy {
	return NewDataDrivenStrategy(valaris.StageConfig{
		Role: "implementer",
		Git:  valaris.GitDef{Action: "create_branch"},
		LLM: valaris.LLMDef{
			Enabled:         true,
			Stage:           "implement",
			PostProcessKind: "writes_code",
		},
	}, nil)
}

// Bug 7849ada8: when the implementer already COMMITTED its work (clean working
// tree) the branch is ahead of origin/<default>. gitCommitAndPush must treat
// that as success — proceed to PR/move-to-review — NOT report a false
// "produced no code changes" failure.
func TestGitCommitAndPush_CleanTreeAheadOfBaseIsSuccess(t *testing.T) {
	bare := initBareRemote(t)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, "test-repo")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, "card-committed", "main")
	if err != nil {
		t.Fatalf("create branch: %v", err)
	}

	// Implementer wrote AND committed its work — clean tree, one commit ahead.
	if err := os.WriteFile(filepath.Join(repoDir, "feature.py"), []byte("print('done')\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := gitMgr.CommitAll(context.Background(), repoDir, "feat: implement"); err != nil {
		t.Fatalf("commit: %v", err)
	}

	hasChanges, err := gitMgr.HasChanges(context.Background(), repoDir)
	if err != nil {
		t.Fatalf("HasChanges: %v", err)
	}
	if hasChanges {
		t.Fatal("setup invariant: working tree must be clean after CommitAll")
	}
	ahead, err := gitMgr.CommitsAheadOfRemoteDefault(context.Background(), repoDir, "main")
	if err != nil {
		t.Fatalf("CommitsAheadOfRemoteDefault: %v", err)
	}
	if ahead == 0 {
		t.Fatalf("setup invariant: branch must be ahead of origin/main, got 0")
	}

	srv, _ := kindHandlersServer(t, "b")
	cfg := testConfig()
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, cfg)
	strat := writesCodeStrategy()

	card := &discoverResult{CardID: "card-committed", BoardID: "b", Title: "Committed work", DefaultBranch: "main"}

	before := loop.CardFailureCount(card.CardID)
	cleanupCalled := false
	done, err := strat.gitCommitAndPush(
		context.Background(), context.Background(),
		loop, card, "exec-1", repoDir, branch, false,
		func() { cleanupCalled = true }, silentLogger(), nil,
	)
	if err != nil {
		t.Fatalf("gitCommitAndPush returned error on already-committed branch: %v", err)
	}
	if done {
		t.Error("done=true would short-circuit the caller and orphan a successful implement; want done=false so it proceeds to PR/move-to-review")
	}
	if cleanupCalled {
		t.Error("cleanup (branch teardown) must NOT run on a successful already-committed branch")
	}
	if after := loop.CardFailureCount(card.CardID); after != before {
		t.Errorf("CardFailureCount before=%d after=%d: already-committed branch must NOT record a failure", before, after)
	}

	// The committed work must be pushed to the remote so create_pr can target it.
	if out := lsRemoteHeads(t, bare); !strings.Contains(out, branch) {
		t.Errorf("expected branch %q pushed to remote, ls-remote:\n%s", branch, out)
	}
}

// True-negative preserved: clean tree AND zero commits ahead (implementer
// produced literally nothing) is still a genuine failure.
func TestGitCommitAndPush_CleanTreeNoCommitsIsFailure(t *testing.T) {
	bare := initBareRemote(t)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, "test-repo")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, "card-empty", "main")
	if err != nil {
		t.Fatalf("create branch: %v", err)
	}

	ahead, err := gitMgr.CommitsAheadOfRemoteDefault(context.Background(), repoDir, "main")
	if err != nil {
		t.Fatalf("CommitsAheadOfRemoteDefault: %v", err)
	}
	if ahead != 0 {
		t.Fatalf("setup invariant: fresh branch must be 0 commits ahead, got %d", ahead)
	}

	srv, _ := kindHandlersServer(t, "b")
	cfg := testConfig()
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, cfg)
	strat := writesCodeStrategy()

	card := &discoverResult{CardID: "card-empty", BoardID: "b", Title: "Empty work", DefaultBranch: "main"}

	before := loop.CardFailureCount(card.CardID)
	done, err := strat.gitCommitAndPush(
		context.Background(), context.Background(),
		loop, card, "exec-2", repoDir, branch, false,
		func() {}, silentLogger(), nil,
	)
	if err != nil {
		t.Fatalf("gitCommitAndPush err: %v", err)
	}
	if !done {
		t.Error("genuine no-op (clean tree, 0 ahead) must return done=true so the caller stops, not open a PR on an empty branch")
	}
	if after := loop.CardFailureCount(card.CardID); after <= before {
		t.Errorf("CardFailureCount before=%d after=%d: empty implement must record a failure (true negative preserved)", before, after)
	}
}

func lsRemoteHeads(t *testing.T, bare string) string {
	t.Helper()
	cmd := newCmd("git", "ls-remote", "--heads", bare)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("ls-remote: %v\n%s", err, out)
	}
	return string(out)
}
