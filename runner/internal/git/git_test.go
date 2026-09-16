// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package git

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// initBareRemote creates a bare git repo to act as a remote.
// Returns the path to the bare repo.
func initBareRemote(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "remote.git")
	run(t, "", "git", "init", "--bare", "--initial-branch=main", dir)
	return dir
}

// initRemoteWithCommit creates a bare remote with one commit so clone works.
// Returns the bare repo path.
func initRemoteWithCommit(t *testing.T) string {
	t.Helper()
	bare := initBareRemote(t)

	// Clone, add a commit, push back.
	scratch := filepath.Join(t.TempDir(), "scratch")
	run(t, "", "git", "clone", bare, scratch)
	run(t, scratch, "git", "config", "user.email", "test@valaris.dev")
	run(t, scratch, "git", "config", "user.name", "Test")
	os.WriteFile(filepath.Join(scratch, "README.md"), []byte("# test"), 0644)
	run(t, scratch, "git", "add", ".")
	run(t, scratch, "git", "commit", "-m", "initial commit")
	run(t, scratch, "git", "push", "origin", "main")

	return bare
}

// run executes a command and fails the test if it errors.
func run(t *testing.T, dir string, name string, args ...string) string {
	t.Helper()
	cmd := exec.Command(name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %v failed: %v\n%s", name, args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func TestCloneOrOpen_ClonesNewRepo(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin"}

	repoDir, err := mgr.CloneOrOpen(context.Background(), remote, "test-repo")
	if err != nil {
		t.Fatal(err)
	}

	// Should have created the directory.
	if _, err := os.Stat(repoDir); os.IsNotExist(err) {
		t.Fatalf("repo dir %s does not exist", repoDir)
	}

	// Should be a git repo with the README from the remote.
	readme := filepath.Join(repoDir, "README.md")
	if _, err := os.Stat(readme); os.IsNotExist(err) {
		t.Fatal("README.md not found in cloned repo")
	}
}

func TestCloneOrOpen_OpensExistingRepo(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin"}

	// Clone once.
	dir1, err := mgr.CloneOrOpen(context.Background(), remote, "test-repo")
	if err != nil {
		t.Fatal(err)
	}

	// Call again — should reuse the same directory without error.
	dir2, err := mgr.CloneOrOpen(context.Background(), remote, "test-repo")
	if err != nil {
		t.Fatal(err)
	}

	if dir1 != dir2 {
		t.Errorf("expected same dir, got %q and %q", dir1, dir2)
	}
}

func TestCreateBranch(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin", BranchPrefix: "runner/"}

	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	branch, _, err := mgr.CreateBranch(context.Background(), repoDir, "fix-login-bug", "main")
	if err != nil {
		t.Fatal(err)
	}

	if branch != "runner/fix-login-bug" {
		t.Errorf("branch = %q, want %q", branch, "runner/fix-login-bug")
	}

	// Should be on the new branch.
	current, err := mgr.CurrentBranch(context.Background(), repoDir)
	if err != nil {
		t.Fatal(err)
	}
	if current != "runner/fix-login-bug" {
		t.Errorf("current branch = %q, want %q", current, "runner/fix-login-bug")
	}
}

func TestCreateBranch_NoPrefixDuplication(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin", BranchPrefix: "runner/"}

	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	// Pass a name that already has the prefix.
	branch, _, err := mgr.CreateBranch(context.Background(), repoDir, "runner/already-prefixed", "main")
	if err != nil {
		t.Fatal(err)
	}

	if branch != "runner/already-prefixed" {
		t.Errorf("branch = %q, want no double prefix", branch)
	}
}

func TestCreateBranch_RecoverFromExisting(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	run(t, repoDir, "git", "config", "user.email", "test@valaris.dev")
	run(t, repoDir, "git", "config", "user.name", "Test")

	// Create the branch, add a file, go back to main — simulating a failed prior attempt.
	mgr.CreateBranch(context.Background(), repoDir, "retry-card", "main") //nolint: errcheck
	os.WriteFile(filepath.Join(repoDir, "stale.txt"), []byte("leftover"), 0644)
	run(t, repoDir, "git", "add", ".")
	run(t, repoDir, "git", "commit", "-m", "stale commit")
	run(t, repoDir, "git", "checkout", "main")

	// Now try to create the same branch again — should recover.
	branch, recovered, err := mgr.CreateBranch(context.Background(), repoDir, "retry-card", "main")
	if err != nil {
		t.Fatalf("expected recovery, got error: %v", err)
	}
	if !recovered {
		t.Error("expected recovered=true for pre-existing branch")
	}
	if branch != "runner/retry-card" {
		t.Errorf("branch = %q, want %q", branch, "runner/retry-card")
	}

	// Should be on the recovered branch.
	current, _ := mgr.CurrentBranch(context.Background(), repoDir)
	if current != "runner/retry-card" {
		t.Errorf("current = %q, want runner/retry-card", current)
	}

	// A commit from a prior attempt is the card's WORK, not disposable scratch —
	// recovery must preserve it (the agent builds on top / the downstream
	// clean-tree+ahead path ships it). Wiping it to main is the bug that made a
	// card failing post-commit re-implement from zero every retry.
	if _, err := os.Stat(filepath.Join(repoDir, "stale.txt")); err != nil {
		t.Error("prior-attempt commit (stale.txt) should be PRESERVED on recovery, not reset to main")
	}
}

// TestCreateBranch_RecoverPreservesPriorCommit pins the M7-03 regression:
// an implement attempt that COMMITS valid work but then fails downstream must,
// on retry, recover the existing branch WITHOUT discarding that commit. The old
// behavior (`reset --hard <default>`) nuked the commit, so the branch came back
// 0-ahead, the LLM rewrote everything, and the card never converged.
func TestCreateBranch_RecoverPreservesPriorCommit(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")
	run(t, repoDir, "git", "config", "user.email", "test@valaris.dev")
	run(t, repoDir, "git", "config", "user.name", "Test")

	// Prior attempt: branch, write a real implementation, COMMIT it, then the
	// pass "fails" downstream (simulated by checking out main).
	mgr.CreateBranch(context.Background(), repoDir, "big-card", "main") //nolint: errcheck
	os.WriteFile(filepath.Join(repoDir, "feature.py"), []byte("# 1091 lines of dispatcher\n"), 0644)
	run(t, repoDir, "git", "add", ".")
	run(t, repoDir, "git", "commit", "-m", "feat: real work from attempt 1")
	run(t, repoDir, "git", "checkout", "main")

	// Retry: recover the same branch.
	branch, recovered, err := mgr.CreateBranch(context.Background(), repoDir, "big-card", "main")
	if err != nil {
		t.Fatalf("recovery errored: %v", err)
	}
	if !recovered {
		t.Error("expected recovered=true")
	}

	// The committed work must still be present...
	if _, err := os.Stat(filepath.Join(repoDir, "feature.py")); err != nil {
		t.Error("committed work feature.py was discarded on recovery — the M7-03 $30 bug")
	}
	// ...and the branch must still be ahead of main (the commit survived).
	ahead, _ := mgr.CommitsAhead(context.Background(), repoDir, "main")
	if ahead < 1 {
		t.Errorf("branch should be >=1 commit ahead of main after recovery, got %d", ahead)
	}
	_ = branch
}

func TestCurrentBranch(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin"}

	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	branch, err := mgr.CurrentBranch(context.Background(), repoDir)
	if err != nil {
		t.Fatal(err)
	}
	if branch != "main" {
		t.Errorf("current branch = %q, want %q", branch, "main")
	}
}

func TestHasChanges(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	// No changes yet.
	has, err := mgr.HasChanges(context.Background(), repoDir)
	if err != nil {
		t.Fatal(err)
	}
	if has {
		t.Error("expected no changes on fresh clone")
	}

	// Create a new file.
	os.WriteFile(filepath.Join(repoDir, "new.txt"), []byte("hello"), 0644)

	has, err = mgr.HasChanges(context.Background(), repoDir)
	if err != nil {
		t.Fatal(err)
	}
	if !has {
		t.Error("expected changes after adding file")
	}
}

// CommitsAhead is used by the rework circuit breaker to distinguish
// "branch already carries the fix" from "executor wrote nothing at all."
// Zero commits ahead means the branch is identical to the base and the
// rework skip path should treat the tick as a benign no-op.
func TestCommitsAhead_IdenticalToBase(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	ahead, err := mgr.CommitsAhead(context.Background(), repoDir, "origin/main")
	if err != nil {
		t.Fatal(err)
	}
	if ahead != 0 {
		t.Errorf("CommitsAhead on fresh clone = %d, want 0", ahead)
	}
}

// Positive commits-ahead must be detected so the rework flow re-ships the
// card to review instead of looping forever on a card whose fix is
// already committed but not yet re-reviewed.
func TestCommitsAhead_BranchWithCommits(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")
	run(t, repoDir, "git", "config", "user.email", "test@valaris.dev")
	run(t, repoDir, "git", "config", "user.name", "Test")

	// Create a feature branch with two new commits on top of main.
	run(t, repoDir, "git", "checkout", "-b", "runner/feature")
	os.WriteFile(filepath.Join(repoDir, "a.txt"), []byte("a"), 0644)
	run(t, repoDir, "git", "add", ".")
	run(t, repoDir, "git", "commit", "-m", "first")
	os.WriteFile(filepath.Join(repoDir, "b.txt"), []byte("b"), 0644)
	run(t, repoDir, "git", "add", ".")
	run(t, repoDir, "git", "commit", "-m", "second")

	ahead, err := mgr.CommitsAhead(context.Background(), repoDir, "origin/main")
	if err != nil {
		t.Fatal(err)
	}
	if ahead != 2 {
		t.Errorf("CommitsAhead on branch with 2 new commits = %d, want 2", ahead)
	}

	// Wrapper must resolve the remote-tracking ref identically.
	aheadViaWrapper, err := mgr.CommitsAheadOfRemoteDefault(context.Background(), repoDir, "main")
	if err != nil {
		t.Fatal(err)
	}
	if aheadViaWrapper != 2 {
		t.Errorf("CommitsAheadOfRemoteDefault = %d, want 2", aheadViaWrapper)
	}
}

func TestCommitAll(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	// Configure git user for commit.
	run(t, repoDir, "git", "config", "user.email", "runner@valaris.studio")
	run(t, repoDir, "git", "config", "user.name", "Backplane Runner")

	os.WriteFile(filepath.Join(repoDir, "feature.go"), []byte("package main"), 0644)

	err := mgr.CommitAll(context.Background(), repoDir, "feat: add feature")
	if err != nil {
		t.Fatal(err)
	}

	// Verify commit message in log.
	log := run(t, repoDir, "git", "log", "--oneline", "-1")
	if !strings.Contains(log, "feat: add feature") {
		t.Errorf("git log = %q, want to contain commit message", log)
	}

	// Should have no changes after commit.
	has, _ := mgr.HasChanges(context.Background(), repoDir)
	if has {
		t.Error("expected no changes after commit")
	}
}

func TestCommitAll_NoChanges(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	err := mgr.CommitAll(context.Background(), repoDir, "empty commit")
	if err == nil {
		t.Fatal("expected error when committing with no changes")
	}
	if !strings.Contains(err.Error(), "no changes") {
		t.Errorf("error = %q, want 'no changes' mention", err)
	}
}

func TestPush(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	run(t, repoDir, "git", "config", "user.email", "runner@valaris.studio")
	run(t, repoDir, "git", "config", "user.name", "Backplane Runner")

	mgr.CreateBranch(context.Background(), repoDir, "push-test", "main")

	os.WriteFile(filepath.Join(repoDir, "pushed.txt"), []byte("data"), 0644)
	mgr.CommitAll(context.Background(), repoDir, "feat: push test")

	err := mgr.Push(context.Background(), repoDir)
	if err != nil {
		t.Fatal(err)
	}

	// Verify the branch exists on the remote.
	refs := run(t, "", "git", "ls-remote", "--heads", remote)
	if !strings.Contains(refs, "push-test") {
		t.Errorf("remote refs don't contain pushed branch:\n%s", refs)
	}
}

func TestResetToMain(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	// Create and switch to a feature branch.
	mgr.CreateBranch(context.Background(), repoDir, "some-feature", "main")
	current, _ := mgr.CurrentBranch(context.Background(), repoDir)
	if current != "runner/some-feature" {
		t.Fatalf("expected to be on feature branch, got %q", current)
	}

	// Reset back to main.
	err := mgr.ResetToDefault(context.Background(), repoDir, "main")
	if err != nil {
		t.Fatal(err)
	}

	current, _ = mgr.CurrentBranch(context.Background(), repoDir)
	if current != "main" {
		t.Errorf("after reset, branch = %q, want %q", current, "main")
	}
}

func TestCleanup(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin", BranchPrefix: "runner/"}

	repoDir, err := mgr.CloneOrOpen(context.Background(), remote, "test-repo")
	if err != nil {
		t.Fatal(err)
	}

	run(t, repoDir, "git", "config", "user.email", "test@valaris.dev")
	run(t, repoDir, "git", "config", "user.name", "Test")

	// Create a feature branch.
	branch, _, err := mgr.CreateBranch(context.Background(), repoDir, "dirty-feature", "main")
	if err != nil {
		t.Fatal(err)
	}

	// Create a dirty file (untracked).
	os.WriteFile(filepath.Join(repoDir, "dirty.txt"), []byte("uncommitted"), 0644)

	// Modify a tracked file.
	os.WriteFile(filepath.Join(repoDir, "README.md"), []byte("modified"), 0644)

	// Call Cleanup.
	mgr.Cleanup(context.Background(), repoDir, branch, "main")

	// Verify: on main.
	current, err := mgr.CurrentBranch(context.Background(), repoDir)
	if err != nil {
		t.Fatal(err)
	}
	if current != "main" {
		t.Errorf("after cleanup, branch = %q, want main", current)
	}

	// Verify: no changes.
	has, err := mgr.HasChanges(context.Background(), repoDir)
	if err != nil {
		t.Fatal(err)
	}
	if has {
		t.Error("expected no changes after cleanup")
	}

	// Verify: feature branch deleted.
	out := run(t, repoDir, "git", "branch")
	if strings.Contains(out, "dirty-feature") {
		t.Errorf("feature branch should be deleted, got branches: %s", out)
	}
}

func TestCleanup_AlreadyClean(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin"}

	repoDir, err := mgr.CloneOrOpen(context.Background(), remote, "test-repo")
	if err != nil {
		t.Fatal(err)
	}

	// No changes, no branch to delete — should be a no-op without error.
	mgr.Cleanup(context.Background(), repoDir, "", "main")

	current, err := mgr.CurrentBranch(context.Background(), repoDir)
	if err != nil {
		t.Fatal(err)
	}
	if current != "main" {
		t.Errorf("after cleanup, branch = %q, want main", current)
	}
}

func TestForceWithLeasePush(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	run(t, repoDir, "git", "config", "user.email", "runner@valaris.studio")
	run(t, repoDir, "git", "config", "user.name", "Backplane Runner")

	// Create branch, commit, push normally first.
	mgr.CreateBranch(context.Background(), repoDir, "rework-card", "main")
	os.WriteFile(filepath.Join(repoDir, "v1.txt"), []byte("first attempt"), 0644)
	mgr.CommitAll(context.Background(), repoDir, "feat: first attempt")
	mgr.Push(context.Background(), repoDir)

	// Now amend (simulates rework — branch diverges from remote).
	os.WriteFile(filepath.Join(repoDir, "v1.txt"), []byte("reworked"), 0644)
	mgr.CommitAll(context.Background(), repoDir, "fix: rework after review")

	// Normal push would fail (non-fast-forward). ForceWithLeasePush should succeed.
	err := mgr.ForceWithLeasePush(context.Background(), repoDir)
	if err != nil {
		t.Fatalf("ForceWithLeasePush failed: %v", err)
	}

	// Verify the new commit is on the remote.
	refs := run(t, "", "git", "ls-remote", "--heads", remote)
	if !strings.Contains(refs, "runner/rework-card") {
		t.Errorf("remote refs don't contain force-pushed branch:\n%s", refs)
	}
}

func TestForceWithLeasePush_RejectsMainBranch(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	// On main branch — ForceWithLeasePush must refuse.
	err := mgr.ForceWithLeasePush(context.Background(), repoDir)
	if err == nil {
		t.Fatal("expected error when force-pushing main")
	}
	if !strings.Contains(err.Error(), "refuse") {
		t.Errorf("error = %q, want mention of 'refuse'", err)
	}
}

func TestForceWithLeasePush_RejectsNonPrefixedBranch(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	// Create a branch without the runner/ prefix manually.
	run(t, repoDir, "git", "checkout", "-b", "feature/manual")

	err := mgr.ForceWithLeasePush(context.Background(), repoDir)
	if err == nil {
		t.Fatal("expected error when force-pushing non-prefixed branch")
	}
	if !strings.Contains(err.Error(), "refuse") {
		t.Errorf("error = %q, want mention of 'refuse'", err)
	}
}

func TestSquashOnto_CollapsesMultipleCommits(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	run(t, repoDir, "git", "config", "user.email", "runner@valaris.studio")
	run(t, repoDir, "git", "config", "user.name", "Backplane Runner")

	mgr.CreateBranch(context.Background(), repoDir, "squash-test", "main")

	os.WriteFile(filepath.Join(repoDir, "file1.txt"), []byte("one"), 0644)
	mgr.CommitAll(context.Background(), repoDir, "feat: first")

	os.WriteFile(filepath.Join(repoDir, "file2.txt"), []byte("two"), 0644)
	mgr.CommitAll(context.Background(), repoDir, "feat: second")

	os.WriteFile(filepath.Join(repoDir, "file3.txt"), []byte("three"), 0644)
	mgr.CommitAll(context.Background(), repoDir, "feat: third")

	// Push so origin/main is established in the local remote-tracking refs.
	mgr.Push(context.Background(), repoDir)

	err := mgr.SquashOnto(context.Background(), repoDir, "main", "squashed: all changes")
	if err != nil {
		t.Fatalf("SquashOnto failed: %v", err)
	}

	// Verify exactly 1 commit on branch relative to main.
	logOutput := run(t, repoDir, "git", "log", "--oneline", "runner/squash-test", "--not", "main")
	commitCount := strings.Count(logOutput, "\n") + 1
	if strings.TrimSpace(logOutput) == "" {
		t.Fatal("expected at least 1 commit, got none")
	}
	if commitCount != 1 {
		t.Errorf("expected 1 squashed commit, got %d:\n%s", commitCount, logOutput)
	}

	// Verify all 3 files exist in working directory.
	for _, f := range []string{"file1.txt", "file2.txt", "file3.txt"} {
		if _, err := os.Stat(filepath.Join(repoDir, f)); os.IsNotExist(err) {
			t.Errorf("expected %s to exist after squash", f)
		}
	}

	// Verify commit message.
	if !strings.Contains(logOutput, "squashed: all changes") {
		t.Errorf("commit message should contain 'squashed: all changes', got:\n%s", logOutput)
	}
}

func TestSquashOnto_SingleCommit(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	run(t, repoDir, "git", "config", "user.email", "runner@valaris.studio")
	run(t, repoDir, "git", "config", "user.name", "Backplane Runner")

	mgr.CreateBranch(context.Background(), repoDir, "squash-single", "main")

	os.WriteFile(filepath.Join(repoDir, "only.txt"), []byte("single change"), 0644)
	mgr.CommitAll(context.Background(), repoDir, "feat: only commit")

	// Push so origin/main remote-tracking ref is available.
	mgr.Push(context.Background(), repoDir)

	// Idempotent: 1 commit stays as 1 commit.
	err := mgr.SquashOnto(context.Background(), repoDir, "main", "squashed: single")
	if err != nil {
		t.Fatalf("SquashOnto with single commit failed: %v", err)
	}

	logOutput := run(t, repoDir, "git", "log", "--oneline", "runner/squash-single", "--not", "main")
	if strings.TrimSpace(logOutput) == "" {
		t.Fatal("expected 1 commit, got none")
	}
	commitCount := strings.Count(logOutput, "\n") + 1
	if commitCount != 1 {
		t.Errorf("expected 1 commit, got %d:\n%s", commitCount, logOutput)
	}
}

func TestSquashOnto_RejectsMainBranch(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	// On main — SquashOnto must refuse.
	err := mgr.SquashOnto(context.Background(), repoDir, "main", "nope")
	if err == nil {
		t.Fatal("expected error when squashing on main")
	}
	if !strings.Contains(err.Error(), "refuse") {
		t.Errorf("error = %q, want mention of 'refuse'", err)
	}
}

func TestSquashOnto_NoChanges(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	run(t, repoDir, "git", "config", "user.email", "runner@valaris.studio")
	run(t, repoDir, "git", "config", "user.name", "Backplane Runner")

	// Create branch but don't change anything from main.
	mgr.CreateBranch(context.Background(), repoDir, "squash-empty", "main")
	mgr.Push(context.Background(), repoDir)

	err := mgr.SquashOnto(context.Background(), repoDir, "main", "empty squash")
	if err == nil {
		t.Fatal("expected error when no changes to squash")
	}
	if !strings.Contains(err.Error(), "no changes") {
		t.Errorf("error = %q, want mention of 'no changes'", err)
	}
}

func TestCommentPR_EmptyBodyNoop(t *testing.T) {
	mgr := &Manager{DefaultRemote: "origin"}

	// Empty body should return nil immediately without calling gh.
	err := mgr.CommentPR(context.Background(), t.TempDir(), "https://github.com/org/repo/pull/1", "")
	if err != nil {
		t.Fatalf("CommentPR with empty body should be no-op, got: %v", err)
	}
}

func TestCommentPR_NonEmptyBody(t *testing.T) {
	mgr := &Manager{DefaultRemote: "origin"}

	// Non-empty body will try to call gh, which will fail in tests (no real PR).
	// Verify the error comes from gh execution, not from internal validation.
	err := mgr.CommentPR(context.Background(), t.TempDir(), "https://github.com/org/repo/pull/1", "Review findings here")
	if err == nil {
		return // gh somehow worked (unlikely in test)
	}
	if !strings.Contains(err.Error(), "commenting on PR") {
		t.Errorf("error = %q, want wrapped 'commenting on PR' error", err)
	}
}

func TestReviewPR_InvalidDecision(t *testing.T) {
	mgr := &Manager{DefaultRemote: "origin"}

	// Invalid decision should be caught before even calling gh.
	err := mgr.ReviewPR(context.Background(), t.TempDir(), "https://github.com/org/repo/pull/1", "invalid", "body")
	if err == nil {
		t.Fatal("expected error for invalid decision")
	}
	if !strings.Contains(err.Error(), "invalid review decision") {
		t.Errorf("error = %q, want 'invalid review decision'", err)
	}
}

func TestReviewPR_ValidDecisions(t *testing.T) {
	// Verify all valid decisions are accepted (command will fail since no real PR,
	// but the error should come from gh, not from validation).
	mgr := &Manager{DefaultRemote: "origin"}
	dir := t.TempDir()

	for _, decision := range []string{"approve", "request-changes", "comment"} {
		err := mgr.ReviewPR(context.Background(), dir, "https://github.com/org/repo/pull/1", decision, "test body")
		if err == nil {
			continue // gh might somehow work (unlikely in test)
		}
		// Error should be from gh execution, not validation.
		if strings.Contains(err.Error(), "invalid review decision") {
			t.Errorf("decision %q should be valid, got validation error", decision)
		}
	}
}

func TestEnsureBranchProtection_EmptyBranchRejected(t *testing.T) {
	mgr := &Manager{DefaultRemote: "origin"}

	err := mgr.EnsureBranchProtection(context.Background(), t.TempDir(), "")
	if err == nil {
		t.Fatal("expected error when branch is empty")
	}
	if !strings.Contains(err.Error(), "branch") {
		t.Errorf("error = %q, want error mentioning branch", err)
	}
}

func TestEnsureBranchProtection_InvalidRepoDirReturnsError(t *testing.T) {
	mgr := &Manager{DefaultRemote: "origin"}

	// Non-existent repo dir can't resolve an origin, so the method must fail cleanly
	// rather than silently succeed. No network, no gh state leak.
	err := mgr.EnsureBranchProtection(context.Background(), "/nonexistent-dir-for-protection-test", "main")
	if err == nil {
		t.Fatal("expected error for invalid repo dir")
	}
}

// TestBranchProtectionRequest_StatusChecksGated locks the policy shape
// produced by branchProtectionRequest: the JSON body MUST require the "ci"
// status check (strict mode) and MUST NOT require any approving reviews.
// This is load-bearing because runner uses a single `gh` identity —
// requiring a formal approval would force self-approval, which GitHub
// refuses. If a future "helpful" revert re-adds
// `required_approving_review_count: 1`, this test fails and flags the
// regression before it hits smoke tests.
//
// The body is sent via `gh api --input -` (stdin) rather than `-F` flags
// because GitHub's branch-protection schema has `anyOf` fields (like
// `restrictions`) that demand either a typed object or JSON null — the
// `-F key=` shorthand coerces to empty string, which the schema rejects
// with HTTP 422.
func TestBranchProtectionRequest_StatusChecksGated(t *testing.T) {
	args, body := branchProtectionRequest("acme/widgets", "main")

	joinedArgs := strings.Join(args, " ")

	if !strings.Contains(joinedArgs, "repos/acme/widgets/branches/main/protection") {
		t.Errorf("args missing branch protection endpoint, got: %v", args)
	}
	if !strings.Contains(joinedArgs, "--input -") {
		t.Errorf("args must use --input - for JSON body, got: %v", args)
	}

	// JSON body must carry the status-checks + zero-reviews policy.
	if !strings.Contains(body, `"required_status_checks":{"strict":true,"contexts":["ci"]}`) {
		t.Errorf("body missing ci status check policy, got: %s", body)
	}
	if !strings.Contains(body, `"required_approving_review_count":0`) {
		t.Errorf("body must explicitly set required_approving_review_count:0, got: %s", body)
	}
	if strings.Contains(body, `"required_approving_review_count":1`) {
		t.Errorf("body must not require 1 approving review (single-identity installs can't self-approve), got: %s", body)
	}

	// `restrictions` must be JSON null, not empty string — GitHub's schema rejects
	// an empty string here with HTTP 422 ("not an object / not a null").
	if !strings.Contains(body, `"restrictions":null`) {
		t.Errorf("body must send restrictions as JSON null, got: %s", body)
	}

	// Body must be valid JSON (catches a stray trailing comma or missing brace).
	var parsed map[string]any
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		t.Errorf("body must be valid JSON, got parse error %v for: %s", err, body)
	}
}

// Cluster III: EnsureAutoMergeEnabled / allowAutoMergeRequest /
// parseAutoMergeArmed / IsAutoMergeArmed / EnableAutoMerge were removed — the
// runner no longer arms GitHub's proprietary auto-merge. Merge happens only via
// the reviewer's MergePR after an approve verdict. Their tests were deleted
// with them. See the 2026-05-26 auto-merge-not-enabled incident (internal note).

func TestPrefixedBranch(t *testing.T) {
	mgr := &Manager{BranchPrefix: "runner/"}

	// Adds prefix.
	if got := mgr.PrefixedBranch("fix-bug"); got != "runner/fix-bug" {
		t.Errorf("PrefixedBranch('fix-bug') = %q, want %q", got, "runner/fix-bug")
	}

	// Idempotent — no double prefix.
	if got := mgr.PrefixedBranch("runner/fix-bug"); got != "runner/fix-bug" {
		t.Errorf("PrefixedBranch('runner/fix-bug') = %q, want no double prefix", got)
	}

	// Empty prefix — pass through.
	mgr2 := &Manager{BranchPrefix: ""}
	if got := mgr2.PrefixedBranch("fix-bug"); got != "fix-bug" {
		t.Errorf("PrefixedBranch with empty prefix = %q, want %q", got, "fix-bug")
	}
}

func TestCommitAll_ExcludesPycache(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	run(t, repoDir, "git", "config", "user.email", "runner@valaris.studio")
	run(t, repoDir, "git", "config", "user.name", "Backplane Runner")

	// Simulate Python artifacts alongside a real change.
	pycacheDir := filepath.Join(repoDir, "__pycache__")
	os.MkdirAll(pycacheDir, 0755)
	os.WriteFile(filepath.Join(pycacheDir, "module.cpython-311.pyc"), []byte("bytecode"), 0644)
	os.WriteFile(filepath.Join(repoDir, "app.py"), []byte("print('hello')"), 0644)

	// Also create a nested __pycache__ inside a package.
	nestedCache := filepath.Join(repoDir, "pkg", "__pycache__")
	os.MkdirAll(nestedCache, 0755)
	os.WriteFile(filepath.Join(nestedCache, "util.cpython-311.pyc"), []byte("bytecode"), 0644)
	os.WriteFile(filepath.Join(repoDir, "pkg", "util.py"), []byte("def f(): pass"), 0644)

	err := mgr.CommitAll(context.Background(), repoDir, "feat: add app")
	if err != nil {
		t.Fatal(err)
	}

	// .gitignore should have been created and committed.
	committed := run(t, repoDir, "git", "ls-tree", "-r", "--name-only", "HEAD")
	if !strings.Contains(committed, ".gitignore") {
		t.Error(".gitignore should be in the commit")
	}

	// __pycache__ files must NOT be in the commit.
	if strings.Contains(committed, "__pycache__") {
		t.Errorf("__pycache__ should be excluded from commit, got:\n%s", committed)
	}
	if strings.Contains(committed, ".pyc") {
		t.Errorf(".pyc files should be excluded from commit, got:\n%s", committed)
	}

	// The real Python file should be committed.
	if !strings.Contains(committed, "app.py") {
		t.Errorf("app.py should be in the commit, got:\n%s", committed)
	}
	if !strings.Contains(committed, "pkg/util.py") {
		t.Errorf("pkg/util.py should be in the commit, got:\n%s", committed)
	}
}

func TestCommitAll_PreservesExistingGitignore(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	run(t, repoDir, "git", "config", "user.email", "runner@valaris.studio")
	run(t, repoDir, "git", "config", "user.name", "Backplane Runner")

	// Create a custom .gitignore before CommitAll.
	customContent := "*.log\nbuild/\n"
	os.WriteFile(filepath.Join(repoDir, ".gitignore"), []byte(customContent), 0644)
	os.WriteFile(filepath.Join(repoDir, "code.py"), []byte("x = 1"), 0644)

	err := mgr.CommitAll(context.Background(), repoDir, "feat: with custom gitignore")
	if err != nil {
		t.Fatal(err)
	}

	// The custom .gitignore should be preserved, not overwritten.
	data, err := os.ReadFile(filepath.Join(repoDir, ".gitignore"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != customContent {
		t.Errorf("existing .gitignore was overwritten, got:\n%s", string(data))
	}
}

func TestCleanArtifacts_RemovesNestedPycache(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	// Create artifact directories at root and nested.
	dirs := []string{
		filepath.Join(repoDir, "__pycache__"),
		filepath.Join(repoDir, "src", "__pycache__"),
		filepath.Join(repoDir, "src", "sub", "__pycache__"),
		filepath.Join(repoDir, ".pytest_cache"),
	}
	for _, d := range dirs {
		os.MkdirAll(d, 0755)
		os.WriteFile(filepath.Join(d, "dummy"), []byte("x"), 0644)
	}

	mgr.cleanArtifacts(context.Background(), repoDir)

	// All artifact dirs should be gone.
	for _, d := range dirs {
		if _, err := os.Stat(d); !os.IsNotExist(err) {
			t.Errorf("expected %s to be removed", d)
		}
	}

	// Non-artifact dirs should survive.
	srcDir := filepath.Join(repoDir, "src", "sub")
	if _, err := os.Stat(srcDir); os.IsNotExist(err) {
		t.Errorf("non-artifact dir %s should still exist", srcDir)
	}
}

func TestCheckoutBranch_CleansArtifactsBeforeCheckout(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	run(t, repoDir, "git", "config", "user.email", "runner@valaris.studio")
	run(t, repoDir, "git", "config", "user.name", "Backplane Runner")

	// Create a feature branch with a file, push it to remote.
	mgr.CreateBranch(context.Background(), repoDir, "checkout-test", "main")
	os.WriteFile(filepath.Join(repoDir, "feature.py"), []byte("pass"), 0644)
	mgr.CommitAll(context.Background(), repoDir, "feat: feature")
	mgr.Push(context.Background(), repoDir)

	// Go back to main.
	run(t, repoDir, "git", "checkout", "main")

	// Simulate __pycache__ in the working tree (would block checkout).
	pycacheDir := filepath.Join(repoDir, "__pycache__")
	os.MkdirAll(pycacheDir, 0755)
	os.WriteFile(filepath.Join(pycacheDir, "cached.pyc"), []byte("bytecode"), 0644)

	// CheckoutBranch should succeed despite the artifact directory.
	err := mgr.CheckoutBranch(context.Background(), repoDir, "runner/checkout-test")
	if err != nil {
		t.Fatalf("CheckoutBranch failed with artifacts present: %v", err)
	}

	// __pycache__ should have been cleaned.
	if _, err := os.Stat(pycacheDir); !os.IsNotExist(err) {
		t.Error("__pycache__ should have been removed before checkout")
	}

	current, _ := mgr.CurrentBranch(context.Background(), repoDir)
	if current != "runner/checkout-test" {
		t.Errorf("expected branch runner/checkout-test, got %q", current)
	}
}

func TestPush_NoCommits(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	mgr.CreateBranch(context.Background(), repoDir, "empty-branch", "main")

	// Push with no new commits — should succeed (nothing to push is OK).
	err := mgr.Push(context.Background(), repoDir)
	if err != nil {
		t.Fatalf("push with no new commits should not error: %v", err)
	}
}

// --- G2: CreateBranch detects existing remote branch ---

func TestCreateBranch_RemoteBranchExists_ReturnsRecovered(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	run(t, repoDir, "git", "config", "user.email", "test@valaris.dev")
	run(t, repoDir, "git", "config", "user.name", "Test")

	// Simulate a prior attempt: create branch, push it to remote, then
	// delete the local branch and return to main.
	run(t, repoDir, "git", "checkout", "-b", "runner/stale-remote")
	os.WriteFile(filepath.Join(repoDir, "old.txt"), []byte("prior attempt"), 0644)
	run(t, repoDir, "git", "add", ".")
	run(t, repoDir, "git", "commit", "-m", "prior attempt")
	run(t, repoDir, "git", "push", "origin", "runner/stale-remote")
	run(t, repoDir, "git", "checkout", "main")
	run(t, repoDir, "git", "branch", "-D", "runner/stale-remote")

	// CreateBranch creates a new local branch but the remote already has it.
	branch, recovered, err := mgr.CreateBranch(context.Background(), repoDir, "stale-remote", "main")
	if err != nil {
		t.Fatalf("CreateBranch failed: %v", err)
	}
	if branch != "runner/stale-remote" {
		t.Errorf("branch = %q, want %q", branch, "runner/stale-remote")
	}
	if !recovered {
		t.Error("expected recovered=true when remote branch exists")
	}
}

func TestCreateBranch_NoRemoteBranch_ReturnsFalse(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	// Fresh branch with no remote counterpart.
	branch, recovered, err := mgr.CreateBranch(context.Background(), repoDir, "brand-new", "main")
	if err != nil {
		t.Fatalf("CreateBranch failed: %v", err)
	}
	if branch != "runner/brand-new" {
		t.Errorf("branch = %q, want %q", branch, "runner/brand-new")
	}
	if recovered {
		t.Error("expected recovered=false when no remote branch exists")
	}
}

// --- G3: extractExistingPRURL ---

func TestExtractExistingPRURL(t *testing.T) {
	tests := []struct {
		name   string
		errMsg string
		want   string
	}{
		{
			name:   "standard gh stderr with newline before URL",
			errMsg: "gh pr create --title test --body body: exit status 1\nstderr: a pull request for branch \"runner/fix-bug\" already exists:\nhttps://github.com/org/repo/pull/42",
			want:   "https://github.com/org/repo/pull/42",
		},
		{
			name:   "URL followed by trailing newline",
			errMsg: "a pull request for branch \"runner/fix\" already exists:\nhttps://github.com/org/repo/pull/7\n",
			want:   "https://github.com/org/repo/pull/7",
		},
		{
			name:   "URL with extra text after",
			errMsg: "already exists:\nhttps://github.com/org/repo/pull/99 some extra text",
			want:   "https://github.com/org/repo/pull/99",
		},
		{
			name:   "no match - different error",
			errMsg: "gh pr create: exit status 1\nstderr: authentication required",
			want:   "",
		},
		{
			name:   "already exists but no URL",
			errMsg: "already exists: but no url here",
			want:   "",
		},
		{
			name:   "empty string",
			errMsg: "",
			want:   "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractExistingPRURL(tt.errMsg)
			if got != tt.want {
				t.Errorf("extractExistingPRURL() = %q, want %q", got, tt.want)
			}
		})
	}
}

// --- CheckPRStatus parsing ---

func TestParsePRStatus_Merged(t *testing.T) {
	input := `{"state":"MERGED","mergeStateStatus":"UNKNOWN"}`
	got, err := parsePRStatus(input, "https://github.com/org/repo/pull/1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.State != "MERGED" {
		t.Errorf("State = %q, want MERGED", got.State)
	}
	if got.MergeStateStatus != "UNKNOWN" {
		t.Errorf("MergeStateStatus = %q, want UNKNOWN", got.MergeStateStatus)
	}
}

func TestParsePRStatus_Open(t *testing.T) {
	tests := []struct {
		name             string
		json             string
		wantState        string
		wantMergeStatus  string
	}{
		{
			name:            "clean merge",
			json:            `{"state":"OPEN","mergeStateStatus":"CLEAN"}`,
			wantState:       "OPEN",
			wantMergeStatus: "CLEAN",
		},
		{
			name:            "dirty merge (conflicts)",
			json:            `{"state":"OPEN","mergeStateStatus":"DIRTY"}`,
			wantState:       "OPEN",
			wantMergeStatus: "DIRTY",
		},
		{
			name:            "blocked by checks",
			json:            `{"state":"OPEN","mergeStateStatus":"BLOCKED"}`,
			wantState:       "OPEN",
			wantMergeStatus: "BLOCKED",
		},
		{
			name:            "behind base branch",
			json:            `{"state":"OPEN","mergeStateStatus":"BEHIND"}`,
			wantState:       "OPEN",
			wantMergeStatus: "BEHIND",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parsePRStatus(tt.json, "https://github.com/org/repo/pull/5")
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.State != tt.wantState {
				t.Errorf("State = %q, want %q", got.State, tt.wantState)
			}
			if got.MergeStateStatus != tt.wantMergeStatus {
				t.Errorf("MergeStateStatus = %q, want %q", got.MergeStateStatus, tt.wantMergeStatus)
			}
		})
	}
}

func TestParsePRStatus_Closed(t *testing.T) {
	input := `{"state":"CLOSED","mergeStateStatus":""}`
	got, err := parsePRStatus(input, "https://github.com/org/repo/pull/3")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.State != "CLOSED" {
		t.Errorf("State = %q, want CLOSED", got.State)
	}
}

func TestParsePRStatus_InvalidJSON(t *testing.T) {
	_, err := parsePRStatus("not json", "https://github.com/org/repo/pull/1")
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
	if !strings.Contains(err.Error(), "parsing PR status") {
		t.Errorf("error = %q, want 'parsing PR status' mention", err)
	}
}

// initRemoteWithCommitOnBranch creates a bare remote with one commit on a custom branch.
// Returns the bare repo path.
func initRemoteWithCommitOnBranch(t *testing.T, branch string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "remote.git")
	run(t, "", "git", "init", "--bare", "--initial-branch="+branch, dir)

	scratch := filepath.Join(t.TempDir(), "scratch")
	run(t, "", "git", "clone", dir, scratch)
	run(t, scratch, "git", "config", "user.email", "test@valaris.dev")
	run(t, scratch, "git", "config", "user.name", "Test")
	os.WriteFile(filepath.Join(scratch, "README.md"), []byte("# test"), 0644)
	run(t, scratch, "git", "add", ".")
	run(t, scratch, "git", "commit", "-m", "initial commit")
	run(t, scratch, "git", "push", "origin", branch)

	return dir
}

func TestCreateBranch_CustomDefaultBranch(t *testing.T) {
	remote := initRemoteWithCommitOnBranch(t, "develop")
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	run(t, repoDir, "git", "config", "user.email", "test@valaris.dev")
	run(t, repoDir, "git", "config", "user.name", "Test")

	// Create a branch with NO commit ahead (a genuinely stale/empty prior
	// attempt), go back to develop. A no-commits-ahead branch IS reset on
	// recovery; this test pins that the reset targets "develop", not "main".
	mgr.CreateBranch(context.Background(), repoDir, "retry-card", "develop") //nolint: errcheck
	run(t, repoDir, "git", "checkout", "develop")

	// Recovery should reset to "develop", not "main".
	branch, recovered, err := mgr.CreateBranch(context.Background(), repoDir, "retry-card", "develop")
	if err != nil {
		t.Fatalf("expected recovery, got error: %v", err)
	}
	if !recovered {
		t.Error("expected recovered=true for pre-existing branch")
	}
	if branch != "runner/retry-card" {
		t.Errorf("branch = %q, want %q", branch, "runner/retry-card")
	}

	// The recovered branch must be based on develop (the custom default), and
	// since it had no commits ahead it should be even with develop (0 ahead).
	ahead, _ := mgr.CommitsAhead(context.Background(), repoDir, "develop")
	if ahead != 0 {
		t.Errorf("stale branch should be reset even with develop (0 ahead), got %d", ahead)
	}
}

func TestResetToDefault(t *testing.T) {
	remote := initRemoteWithCommitOnBranch(t, "develop")
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	// Create and switch to a feature branch.
	mgr.CreateBranch(context.Background(), repoDir, "some-feature", "develop")
	current, _ := mgr.CurrentBranch(context.Background(), repoDir)
	if current != "runner/some-feature" {
		t.Fatalf("expected to be on feature branch, got %q", current)
	}

	// Reset back to develop (not main).
	err := mgr.ResetToDefault(context.Background(), repoDir, "develop")
	if err != nil {
		t.Fatal(err)
	}

	current, _ = mgr.CurrentBranch(context.Background(), repoDir)
	if current != "develop" {
		t.Errorf("after reset, branch = %q, want %q", current, "develop")
	}
}

func TestRun_InjectsRoleToken(t *testing.T) {
	mgr := &Manager{DefaultRemote: "origin", RoleToken: "test-token-123"}

	out, err := mgr.run(context.Background(), "", "sh", "-c", "echo $GH_TOKEN")
	if err != nil {
		t.Fatalf("run failed: %v", err)
	}
	if got := strings.TrimSpace(out); got != "test-token-123" {
		t.Errorf("GH_TOKEN = %q, want %q", got, "test-token-123")
	}
}

func TestRun_NoTokenInjectionWhenEmpty(t *testing.T) {
	mgr := &Manager{DefaultRemote: "origin", RoleToken: ""}

	// Set a known GH_TOKEN in the environment to verify it passes through unchanged.
	t.Setenv("GH_TOKEN", "ambient-token-456")

	out, err := mgr.run(context.Background(), "", "sh", "-c", "echo $GH_TOKEN")
	if err != nil {
		t.Fatalf("run failed: %v", err)
	}
	if got := strings.TrimSpace(out); got != "ambient-token-456" {
		t.Errorf("GH_TOKEN = %q, want ambient %q", got, "ambient-token-456")
	}
}

func TestRunWithStdin_InjectsRoleToken(t *testing.T) {
	mgr := &Manager{DefaultRemote: "origin", RoleToken: "stdin-token-789"}

	out, err := mgr.runWithStdin(context.Background(), "", "ignored", "sh", "-c", "echo $GH_TOKEN")
	if err != nil {
		t.Fatalf("runWithStdin failed: %v", err)
	}
	if got := strings.TrimSpace(out); got != "stdin-token-789" {
		t.Errorf("GH_TOKEN = %q, want %q", got, "stdin-token-789")
	}
}

func TestRunWithStdin_NoTokenInjectionWhenEmpty(t *testing.T) {
	mgr := &Manager{DefaultRemote: "origin", RoleToken: ""}

	t.Setenv("GH_TOKEN", "ambient-stdin-token")

	out, err := mgr.runWithStdin(context.Background(), "", "ignored", "sh", "-c", "echo $GH_TOKEN")
	if err != nil {
		t.Fatalf("runWithStdin failed: %v", err)
	}
	if got := strings.TrimSpace(out); got != "ambient-stdin-token" {
		t.Errorf("GH_TOKEN = %q, want ambient %q", got, "ambient-stdin-token")
	}
}

func TestCleanup_CustomDefaultBranch(t *testing.T) {
	remote := initRemoteWithCommitOnBranch(t, "develop")
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, err := mgr.CloneOrOpen(context.Background(), remote, "test-repo")
	if err != nil {
		t.Fatal(err)
	}

	run(t, repoDir, "git", "config", "user.email", "test@valaris.dev")
	run(t, repoDir, "git", "config", "user.name", "Test")

	// Create a feature branch.
	branch, _, err := mgr.CreateBranch(context.Background(), repoDir, "dirty-feature", "develop")
	if err != nil {
		t.Fatal(err)
	}

	// Create a dirty file.
	os.WriteFile(filepath.Join(repoDir, "dirty.txt"), []byte("uncommitted"), 0644)

	// Cleanup with defaultBranch="develop".
	mgr.Cleanup(context.Background(), repoDir, branch, "develop")

	// Verify: on develop (not main).
	current, err := mgr.CurrentBranch(context.Background(), repoDir)
	if err != nil {
		t.Fatal(err)
	}
	if current != "develop" {
		t.Errorf("after cleanup, branch = %q, want develop", current)
	}

	// Verify: feature branch deleted.
	out := run(t, repoDir, "git", "branch")
	if strings.Contains(out, "dirty-feature") {
		t.Errorf("feature branch should be deleted, got branches: %s", out)
	}
}

// --- G3: MergePR (reviewer's gated merge primitive) ---
// EnableAutoMerge (no-fallback) tests removed with the function (Cluster III).
// The no-direct-merge-fallback invariant they guarded now lives entirely in
// MergePR, which is the only merge path.

func TestMergePR_InvalidStrategy(t *testing.T) {
	mgr := &Manager{DefaultRemote: "origin"}

	err := mgr.MergePR(context.Background(), t.TempDir(), "https://github.com/org/repo/pull/1", "yolo")
	if err == nil {
		t.Fatal("expected error for invalid merge strategy")
	}
	if !strings.Contains(err.Error(), "invalid merge strategy") {
		t.Errorf("error = %q, want 'invalid merge strategy'", err)
	}
}

func TestMergePR_DefaultsToSquash(t *testing.T) {
	mgr := &Manager{DefaultRemote: "origin"}

	// Empty strategy should default to squash (no validation error).
	err := mgr.MergePR(context.Background(), t.TempDir(), "https://github.com/org/repo/pull/1", "")
	if err != nil && strings.Contains(err.Error(), "invalid merge strategy") {
		t.Errorf("empty strategy should default to squash, got: %v", err)
	}
}

func TestMergePR_ValidStrategies(t *testing.T) {
	mgr := &Manager{DefaultRemote: "origin"}
	dir := t.TempDir()

	for _, strategy := range []string{"squash", "rebase", "merge"} {
		err := mgr.MergePR(context.Background(), dir, "https://github.com/org/repo/pull/1", strategy)
		if err == nil {
			continue // gh somehow worked (unlikely in test)
		}
		// Error should be from gh execution, not validation.
		if strings.Contains(err.Error(), "invalid merge strategy") {
			t.Errorf("strategy %q should be valid, got validation error", strategy)
		}
		if !strings.Contains(err.Error(), "merge PR") {
			t.Errorf("strategy %q: error = %q, want wrapped 'merge PR' error", strategy, err)
		}
	}
}

// --- I.1.j: rebase-on-claim — refresh local default before CreateBranch ---

// setupTwoClones creates a bare origin repo with an initial commit on `main`,
// then clones it twice into cloneA and cloneB, simulating two concurrent agents.
// Returns (origin, cloneA, cloneB).
func setupTwoClones(t *testing.T) (origin, cloneA, cloneB string) {
	t.Helper()
	origin = initRemoteWithCommit(t)

	cloneA = filepath.Join(t.TempDir(), "cloneA")
	run(t, "", "git", "clone", origin, cloneA)
	run(t, cloneA, "git", "config", "user.email", "a@valaris.dev")
	run(t, cloneA, "git", "config", "user.name", "Agent A")

	cloneB = filepath.Join(t.TempDir(), "cloneB")
	run(t, "", "git", "clone", origin, cloneB)
	run(t, cloneB, "git", "config", "user.email", "b@valaris.dev")
	run(t, cloneB, "git", "config", "user.name", "Agent B")

	return origin, cloneA, cloneB
}

// TestCreateBranch_ForksFromFreshOriginNotStaleHEAD demonstrates the
// "stale base" bug fixed by I.1.j: when agent A has already pushed a commit
// to origin/main, agent B's new branch must include A's commit. Without
// the fetch-and-reset in CreateBranch, B would fork from its stale local HEAD.
func TestCreateBranch_ForksFromFreshOriginNotStaleHEAD(t *testing.T) {
	origin, cloneA, cloneB := setupTwoClones(t)
	_ = origin

	// Agent A commits to main and pushes.
	os.WriteFile(filepath.Join(cloneA, "from-agent-a.txt"), []byte("A was here"), 0644)
	run(t, cloneA, "git", "add", ".")
	run(t, cloneA, "git", "commit", "-m", "A: concurrent commit to main")
	run(t, cloneA, "git", "push", "origin", "main")

	// Capture A's commit SHA so we can check B's new branch history for it.
	shaFromA := run(t, cloneA, "git", "rev-parse", "HEAD")

	// Agent B — using the Manager — creates a new feature branch.
	// The local main in cloneB is stale (doesn't have A's commit yet).
	mgrB := &Manager{DefaultRemote: "origin", BranchPrefix: "runner/"}
	branch, _, err := mgrB.CreateBranch(context.Background(), cloneB, "b-feature", "main")
	if err != nil {
		t.Fatalf("CreateBranch failed: %v", err)
	}
	if branch != "runner/b-feature" {
		t.Errorf("branch = %q, want runner/b-feature", branch)
	}

	// The critical assertion: B's new branch must descend from A's commit.
	// Use `git merge-base --is-ancestor SHA branch` — exits 0 when SHA is in branch history.
	cmd := exec.Command("git", "merge-base", "--is-ancestor", shaFromA, "HEAD")
	cmd.Dir = cloneB
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	if err := cmd.Run(); err != nil {
		t.Fatalf("B's new branch does not include A's commit %s — CreateBranch forked from stale HEAD", shaFromA)
	}
}

func TestFetchAndResetDefault_UpdatesLocalFromOrigin(t *testing.T) {
	origin, cloneA, cloneB := setupTwoClones(t)
	_ = origin

	// A pushes a commit.
	os.WriteFile(filepath.Join(cloneA, "newfile.txt"), []byte("new"), 0644)
	run(t, cloneA, "git", "add", ".")
	run(t, cloneA, "git", "commit", "-m", "A: new commit")
	run(t, cloneA, "git", "push", "origin", "main")
	shaFromA := run(t, cloneA, "git", "rev-parse", "HEAD")

	// B's local main is stale. Before fetch, B's main != shaFromA.
	shaBefore := run(t, cloneB, "git", "rev-parse", "main")
	if shaBefore == shaFromA {
		t.Fatalf("setup precondition violated: B already has A's commit")
	}

	mgrB := &Manager{DefaultRemote: "origin"}
	if err := mgrB.FetchAndResetDefault(context.Background(), cloneB, "main"); err != nil {
		t.Fatalf("FetchAndResetDefault failed: %v", err)
	}

	shaAfter := run(t, cloneB, "git", "rev-parse", "main")
	if shaAfter != shaFromA {
		t.Errorf("after FetchAndResetDefault, main = %s, want %s", shaAfter, shaFromA)
	}
}

func TestFetchAndResetDefault_IdempotentWhenAlreadyInSync(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	shaBefore := run(t, repoDir, "git", "rev-parse", "main")

	// No-op when already in sync.
	if err := mgr.FetchAndResetDefault(context.Background(), repoDir, "main"); err != nil {
		t.Fatalf("FetchAndResetDefault on in-sync repo failed: %v", err)
	}

	shaAfter := run(t, repoDir, "git", "rev-parse", "main")
	if shaAfter != shaBefore {
		t.Errorf("SHA changed on in-sync fetch: before=%s after=%s", shaBefore, shaAfter)
	}
}

// TestFetchAndResetDefault_DiscardsLocalCommitsNotOnOrigin verifies the
// hard-reset behavior: local commits on the default branch that aren't
// on origin are discarded. This is intentional — agents should never
// accumulate work on the default branch locally.
func TestFetchAndResetDefault_DiscardsLocalCommitsNotOnOrigin(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	run(t, repoDir, "git", "config", "user.email", "local@valaris.dev")
	run(t, repoDir, "git", "config", "user.name", "Local")

	originSHA := run(t, repoDir, "git", "rev-parse", "origin/main")

	// Make a local-only commit on main.
	os.WriteFile(filepath.Join(repoDir, "local-only.txt"), []byte("leftover"), 0644)
	run(t, repoDir, "git", "add", ".")
	run(t, repoDir, "git", "commit", "-m", "local-only, never pushed")
	localSHA := run(t, repoDir, "git", "rev-parse", "HEAD")
	if localSHA == originSHA {
		t.Fatal("setup failure: local commit should produce a new SHA")
	}

	if err := mgr.FetchAndResetDefault(context.Background(), repoDir, "main"); err != nil {
		t.Fatalf("FetchAndResetDefault failed: %v", err)
	}

	// Local main should now match origin/main — the local-only commit was discarded.
	after := run(t, repoDir, "git", "rev-parse", "main")
	if after != originSHA {
		t.Errorf("after reset, main = %s, want origin SHA %s", after, originSHA)
	}

	// File from the discarded commit should be gone.
	if _, err := os.Stat(filepath.Join(repoDir, "local-only.txt")); !os.IsNotExist(err) {
		t.Error("local-only.txt should have been removed after hard reset")
	}
}

func TestFetchAndResetDefault_UnreachableRemoteReturnsError(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	// Point origin at a nonexistent path so fetch fails with a network-like error.
	bogus := filepath.Join(t.TempDir(), "does-not-exist.git")
	run(t, repoDir, "git", "remote", "set-url", "origin", bogus)

	err := mgr.FetchAndResetDefault(context.Background(), repoDir, "main")
	if err == nil {
		t.Fatal("expected error when origin is unreachable")
	}
	if !strings.Contains(err.Error(), "fetch") {
		t.Errorf("error = %q, want mention of 'fetch'", err)
	}
}

// TestCreateBranch_FetchFailureSurfacesAsError verifies that when the pre-branch
// fetch fails, CreateBranch returns an error and does NOT create a local branch
// from stale HEAD.
func TestCreateBranch_FetchFailureSurfacesAsError(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")

	// Break origin so fetch fails.
	bogus := filepath.Join(t.TempDir(), "does-not-exist.git")
	run(t, repoDir, "git", "remote", "set-url", "origin", bogus)

	_, _, err := mgr.CreateBranch(context.Background(), repoDir, "should-not-exist", "main")
	if err == nil {
		t.Fatal("expected CreateBranch to fail when fetch fails")
	}

	// The local branch must not have been created.
	out := run(t, repoDir, "git", "branch")
	if strings.Contains(out, "runner/should-not-exist") {
		t.Errorf("branch should not have been created after fetch failure, got: %s", out)
	}
}

// --- ListOpenPRs / parseOpenPRList (T1.4 scaffolding — pre-refactor seam) ---
//
// `gh pr list` was the sole gh-ism outside this package. Moving it behind
// git.Manager keeps all host-CLI surface area in one place, so T1.4's
// GitHostProvider interface has exactly one package to split.

func TestParseOpenPRList_FlattensFilesToPathStrings(t *testing.T) {
	input := `[
		{"number":7,"headRefName":"feat/x","files":[{"path":"a.go"},{"path":"b.go"}]},
		{"number":9,"headRefName":"feat/y","files":[{"path":"c.md"}]}
	]`
	got, err := parseOpenPRList(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	if got[0].Number != 7 || got[0].HeadRefName != "feat/x" {
		t.Errorf("pr[0] = %+v", got[0])
	}
	if len(got[0].Files) != 2 || got[0].Files[0] != "a.go" || got[0].Files[1] != "b.go" {
		t.Errorf("pr[0].Files = %v, want [a.go b.go]", got[0].Files)
	}
	if got[1].Number != 9 || got[1].Files[0] != "c.md" {
		t.Errorf("pr[1] = %+v", got[1])
	}
}

func TestParseOpenPRList_EmptyArray(t *testing.T) {
	got, err := parseOpenPRList(`[]`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("expected empty slice, got %v", got)
	}
}

func TestParseOpenPRList_InvalidJSON(t *testing.T) {
	_, err := parseOpenPRList("not json")
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
	if !strings.Contains(err.Error(), "parsing open PR list") {
		t.Errorf("error = %q, want 'parsing open PR list' mention", err)
	}
}

func TestParseOpenPRList_MissingFilesFieldTreatedAsEmpty(t *testing.T) {
	// gh pr list sometimes returns PRs without a files array; must not panic.
	got, err := parseOpenPRList(`[{"number":1,"headRefName":"feat/x"}]`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 || got[0].Number != 1 {
		t.Fatalf("got = %+v", got)
	}
	if len(got[0].Files) != 0 {
		t.Errorf("expected empty Files slice, got %v", got[0].Files)
	}
}

func TestListOpenPRs_InvalidRepoDirReturnsError(t *testing.T) {
	mgr := &Manager{DefaultRemote: "origin"}
	_, err := mgr.ListOpenPRs(context.Background(), "/nonexistent-dir-for-list-open-prs", "")
	if err == nil {
		t.Fatal("expected error when repoDir is invalid")
	}
}

func TestOwnerRepoFromURL(t *testing.T) {
	cases := []struct {
		name, in, want string
		wantErr        bool
	}{
		{name: "https with .git suffix", in: "https://github.com/acme/widget.git", want: "acme/widget"},
		{name: "https without .git", in: "https://github.com/acme/widget", want: "acme/widget"},
		{name: "ssh with .git", in: "git@github.com:acme/widget.git", want: "acme/widget"},
		{name: "ssh without .git", in: "git@github.com:acme/widget", want: "acme/widget"},
		{name: "unparseable", in: "not-a-url", wantErr: true},
		{name: "single segment https rejected", in: "https://example/r", wantErr: true},
		{name: "single segment https .git rejected", in: "https://example/r.git", wantErr: true},
		{name: "three segments rejected", in: "https://github.com/acme/group/widget", wantErr: true},
		{name: "empty owner rejected", in: "https://github.com//widget", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := OwnerRepoFromURL(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// TestWipeToHead_RemovesForeignUntrackedButKeepsCommittedWork is the P0
// shared-clone-contamination guard: a stray untracked file left in the shared
// clone by a PRIOR card (e.g. I-01's pnpm-lock.yaml) must NOT survive into the
// next card's commit, while the current card's own committed work is preserved.
func TestWipeToHead_RemovesForeignUntrackedButKeepsCommittedWork(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin"}
	repoDir, _ := mgr.CloneOrOpen(context.Background(), remote, "test-repo")
	run(t, repoDir, "git", "config", "user.email", "runner@valaris.studio")
	run(t, repoDir, "git", "config", "user.name", "Backplane Runner")

	// The card's OWN legitimate work, already committed on its branch.
	os.WriteFile(filepath.Join(repoDir, "feature.tsx"), []byte("export const X = 1"), 0644)
	run(t, repoDir, "git", "add", "feature.tsx")
	run(t, repoDir, "git", "commit", "-m", "feat: card work")

	// Foreign residue left by a PRIOR card in the shared clone:
	//  - an untracked foreign file (pnpm-lock.yaml), and
	//  - an uncommitted modification to a tracked file.
	os.WriteFile(filepath.Join(repoDir, "pnpm-lock.yaml"), []byte("lockfileVersion: 9\n"), 0644)
	os.WriteFile(filepath.Join(repoDir, "pnpm-workspace.yaml"), []byte("packages:\n  - '.'\n"), 0644)
	os.WriteFile(filepath.Join(repoDir, "feature.tsx"), []byte("export const X = 999 // foreign edit"), 0644)

	// Stage entry must wipe the working tree to HEAD before the next commit.
	if err := mgr.WipeToHead(context.Background(), repoDir); err != nil {
		t.Fatalf("WipeToHead: %v", err)
	}

	// Foreign untracked files are gone.
	if _, err := os.Stat(filepath.Join(repoDir, "pnpm-lock.yaml")); !os.IsNotExist(err) {
		t.Error("pnpm-lock.yaml (foreign untracked) should have been removed by WipeToHead")
	}
	if _, err := os.Stat(filepath.Join(repoDir, "pnpm-workspace.yaml")); !os.IsNotExist(err) {
		t.Error("pnpm-workspace.yaml (foreign untracked) should have been removed by WipeToHead")
	}
	// The tracked file is reset to HEAD (foreign edit discarded), card work intact.
	content, _ := os.ReadFile(filepath.Join(repoDir, "feature.tsx"))
	if string(content) != "export const X = 1" {
		t.Errorf("feature.tsx should be reset to HEAD, got: %q", string(content))
	}

	// Now the card adds its real change; a CommitAll must NOT sweep foreign files
	// (they're already gone) — only the card's new change lands.
	os.WriteFile(filepath.Join(repoDir, "fix.tsx"), []byte("export const Y = 2"), 0644)
	if err := mgr.CommitAll(context.Background(), repoDir, "fix: card fix"); err != nil {
		t.Fatal(err)
	}
	committed := run(t, repoDir, "git", "ls-tree", "-r", "--name-only", "HEAD")
	if strings.Contains(committed, "pnpm-lock.yaml") || strings.Contains(committed, "pnpm-workspace.yaml") {
		t.Errorf("foreign pnpm files must NOT be in the commit, got:\n%s", committed)
	}
	if !strings.Contains(committed, "fix.tsx") {
		t.Errorf("the card's own fix.tsx should be committed, got:\n%s", committed)
	}
	if !strings.Contains(committed, "feature.tsx") {
		t.Errorf("the card's prior committed work should remain, got:\n%s", committed)
	}
}
