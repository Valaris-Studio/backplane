// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// integrationHeadStrategy builds a strategy whose git_setup uses the post-merge
// audit action. Mirrors a ui_validator stage: it must validate what SHIPS
// (integration HEAD on the default branch), never the frozen PR branch the card
// was merged from.
func integrationHeadStrategy() *DataDrivenStrategy {
	return NewDataDrivenStrategy(valaris.StageConfig{
		Role: "ui_validator",
		Git:  valaris.GitDef{Action: "checkout_integration_head"},
		LLM:  valaris.LLMDef{Enabled: true, Stage: "validate_ui"},
	}, nil)
}

// commitOnDefault adds one commit to the bare remote's default branch and
// returns its SHA — simulating a later epic's fix landing on main AFTER the
// card under audit was merged.
func commitOnDefault(t *testing.T, bareRemote, filename, contents string) string {
	t.Helper()
	scratch := filepath.Join(t.TempDir(), "advance")
	run(t, "", "git", "clone", bareRemote, scratch)
	run(t, scratch, "git", "config", "user.email", "test@valaris.dev")
	run(t, scratch, "git", "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(scratch, filename), []byte(contents), 0644); err != nil {
		t.Fatalf("write %s: %v", filename, err)
	}
	run(t, scratch, "git", "add", ".")
	run(t, scratch, "git", "commit", "-m", "later fix on main")
	run(t, scratch, "git", "push", "origin", "main")
	out := captureGit(t, scratch, "rev-parse", "HEAD")
	return out
}

func captureGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := newCmd("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return trimNL(string(out))
}

func trimNL(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}

// A post-merge auditor (ui_validator) MUST validate integration HEAD, not the
// frozen PR branch. This is the root fix for the phantom-fix-card class: a
// validator checked out on a stale merge-time branch re-renders bugs already
// fixed on main and files fix cards for defects that don't exist on what ships.
//
// Setup mirrors the live failure: the card's PR branch is frozen N commits
// behind main; a later commit (another epic's fix) exists ONLY on main. After
// git_setup, HEAD must equal main's HEAD (sees the later fix), proving we no
// longer audit the stale branch.
func TestGitSetup_CheckoutIntegrationHead_ValidatesMainNotFrozenBranch(t *testing.T) {
	bare := initBareRemote(t)

	// A frozen PR branch cut from main's ORIGINAL HEAD, pushed, then main moves on.
	prScratch := filepath.Join(t.TempDir(), "pr")
	run(t, "", "git", "clone", bare, prScratch)
	run(t, prScratch, "git", "config", "user.email", "test@valaris.dev")
	run(t, prScratch, "git", "config", "user.name", "Test")
	run(t, prScratch, "git", "checkout", "-b", "runner/frozen-pr")
	if err := os.WriteFile(filepath.Join(prScratch, "card_work.txt"), []byte("the card's UI"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	run(t, prScratch, "git", "add", ".")
	run(t, prScratch, "git", "commit", "-m", "card work")
	run(t, prScratch, "git", "push", "origin", "runner/frozen-pr")
	frozenHEAD := captureGit(t, prScratch, "rev-parse", "HEAD")

	// A LATER fix lands on main only (not an ancestor of the frozen PR branch).
	mainHEAD := commitOnDefault(t, bare, "later_fix.txt", "fixes the bug the validator would re-flag")
	if mainHEAD == frozenHEAD {
		t.Fatal("test bug: main HEAD should differ from frozen PR branch HEAD")
	}

	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	srv := testAPIServer(t, testServerOptions{})
	defer srv.Close()
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	strat := integrationHeadStrategy()

	card := &discoverResult{
		CardID:        "card-postmerge",
		BoardID:       "b",
		Title:         "ui audit",
		GitRepoURL:    bare,
		GitRepoName:   "repo",
		DefaultBranch: "main",
		PRBranch:      "runner/frozen-pr",
	}

	repoDir, branch, _, cleanup, err := strat.gitSetupWithConfig(
		context.Background(), context.Background(), loop, card, false,
	)
	if err != nil {
		t.Fatalf("gitSetupWithConfig: %v", err)
	}
	defer cleanup()

	gotHEAD := captureGit(t, repoDir, "rev-parse", "HEAD")
	if gotHEAD != mainHEAD {
		t.Errorf("post-merge audit must position on integration HEAD (main=%s), got %s — validating a stale branch re-files phantom fix cards", mainHEAD, gotHEAD)
	}
	if branch != "main" {
		t.Errorf("reported branch should be the default branch %q, got %q (downstream notes must not claim isolation on a stale PR branch)", "main", branch)
	}
}

// Failure decision (user-confirmed): if integration HEAD can't be positioned
// (fetch/reset fails), HARD-FAIL the stage rather than silently auditing a
// stale or wrong tree. A failed audit re-runs cleanly; a false audit files
// phantoms. Here the default branch doesn't exist on the remote → reset must
// error → gitSetupWithConfig must return a non-nil error.
func TestGitSetup_CheckoutIntegrationHead_HardFailsWhenDefaultUnresolvable(t *testing.T) {
	bare := initBareRemote(t)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	srv := testAPIServer(t, testServerOptions{})
	defer srv.Close()
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	strat := integrationHeadStrategy()

	card := &discoverResult{
		CardID:        "card-badbranch",
		BoardID:       "b",
		Title:         "ui audit",
		GitRepoURL:    bare,
		GitRepoName:   "repo-badbranch",
		DefaultBranch: "nonexistent-default", // cannot be fetched/reset
		PRBranch:      "",
	}

	_, _, _, cleanup, err := strat.gitSetupWithConfig(
		context.Background(), context.Background(), loop, card, false,
	)
	if cleanup != nil {
		cleanup()
	}
	if err == nil {
		t.Fatal("expected hard-fail when integration HEAD cannot be positioned; got nil error (silent stale-tree audit is the bug we're fixing)")
	}
}
