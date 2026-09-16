// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package git

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// A corrupt clone left over from a prior run (a directory named ".git" that is
// missing HEAD/config) used to STRAND the runner: isGitRepo only stat'd the
// ".git" directory, so CloneOrOpen took the "already cloned, just fetch" branch
// and died with `git fetch origin: fatal: not a git repository` (exit 128).
// CloneOrOpen must instead detect the corruption and self-heal by re-cloning.
// Live incident 2026-06-04: a repo dir under the shared base_dir was gutted by
// a half-completed cleanup, blocking every card for that repo at git_setup.
func TestCloneOrOpen_RecoversFromCorruptGitDir(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")
	repoDir := filepath.Join(baseDir, "test-repo")

	// Forge the exact corruption seen in prod: a .git directory with the
	// object/ref subdirs but no HEAD and no config — passes os.Stat(".git")
	// as a directory, fails every real git command.
	gitDir := filepath.Join(repoDir, ".git")
	for _, sub := range []string{"objects", "refs/heads", "logs"} {
		if err := os.MkdirAll(filepath.Join(gitDir, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin"}

	got, err := mgr.CloneOrOpen(context.Background(), remote, "test-repo")
	if err != nil {
		t.Fatalf("CloneOrOpen should recover from a corrupt clone, got error: %v", err)
	}
	if got != repoDir {
		t.Fatalf("expected repo dir %q, got %q", repoDir, got)
	}

	// Recovery means a real working clone: the remote's README must be present
	// and `git rev-parse` must succeed inside it.
	if _, err := os.Stat(filepath.Join(repoDir, "README.md")); err != nil {
		t.Fatalf("re-cloned repo missing README from remote: %v", err)
	}
	if _, err := mgr.git(context.Background(), repoDir, "rev-parse", "--git-dir"); err != nil {
		t.Fatalf("recovered dir is not a valid git repo: %v", err)
	}
}

// A leftover NON-git directory at the target path (e.g. a partial extraction or
// an unrelated folder that happens to share the repo name) must also be cleared
// and replaced by a fresh clone rather than colliding with `git clone`.
func TestCloneOrOpen_RecoversFromNonGitDir(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")
	repoDir := filepath.Join(baseDir, "test-repo")

	if err := os.MkdirAll(repoDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// A stray file with no .git anywhere.
	if err := os.WriteFile(filepath.Join(repoDir, "leftover.txt"), []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}

	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin"}

	got, err := mgr.CloneOrOpen(context.Background(), remote, "test-repo")
	if err != nil {
		t.Fatalf("CloneOrOpen should recover from a non-git dir, got error: %v", err)
	}
	if got != repoDir {
		t.Fatalf("expected repo dir %q, got %q", repoDir, got)
	}
	if _, err := os.Stat(filepath.Join(repoDir, "README.md")); err != nil {
		t.Fatalf("re-cloned repo missing README from remote: %v", err)
	}
	// The stale file must be gone — the dir was replaced, not merged into.
	if _, err := os.Stat(filepath.Join(repoDir, "leftover.txt")); !os.IsNotExist(err) {
		t.Fatalf("expected stale leftover.txt to be removed by re-clone, stat err: %v", err)
	}
}

// isGitRepo must reject a directory whose .git lacks HEAD/config (the corruption
// signature), and accept a genuinely cloned repo.
func TestIsGitRepo_RejectsCorruptGitDir(t *testing.T) {
	repoDir := filepath.Join(t.TempDir(), "corrupt")
	for _, sub := range []string{"objects", "refs/heads", "logs"} {
		if err := os.MkdirAll(filepath.Join(repoDir, ".git", sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if isGitRepo(repoDir) {
		t.Fatal("isGitRepo must return false for a .git dir missing HEAD/config")
	}
}

func TestIsGitRepo_AcceptsRealClone(t *testing.T) {
	remote := initRemoteWithCommit(t)
	baseDir := filepath.Join(t.TempDir(), "repos")
	mgr := &Manager{BaseDir: baseDir, DefaultRemote: "origin"}

	repoDir, err := mgr.CloneOrOpen(context.Background(), remote, "test-repo")
	if err != nil {
		t.Fatal(err)
	}
	if !isGitRepo(repoDir) {
		t.Fatal("isGitRepo must return true for a freshly cloned repo")
	}
}
