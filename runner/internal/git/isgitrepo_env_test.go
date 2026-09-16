// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package git

import (
	"os"
	"path/filepath"
	"testing"
)

// isGitRepo is a free function with no Manager receiver, so it cannot reach
// subprocessEnv() — it spawns `git rev-parse --git-dir` with cmd.Env unset and
// therefore inherits the ambient environment wholesale. Every other spawn site
// in this package is hardened; this one is the hole.
//
// It is also the highest-stakes hole. isGitRepo gates CloneOrOpen: a wrong
// "yes" returns a repoDir that git resolves somewhere else entirely, and a
// wrong "no" sends CloneOrOpen down the recovery path that calls os.RemoveAll
// on the directory. An environment variable deciding that answer is the same
// class of bug as the base_dir incident, reached by a different door.

// makeJunkRepoDir builds a directory that carries a ".git" *directory* which is
// not a usable repository — objects/ and refs/ present, no HEAD and no config.
// This is the half-deleted-clone shape isGitRepo's own doc comment describes.
//
// The shape matters for honesty. isGitRepo returns false immediately when
// os.Stat(dir/".git") fails, so a plainly empty directory would answer false
// whether or not the env leaks, and the test would pass vacuously against the
// broken code. With a junk .git present the stat succeeds and `rev-parse` is
// what actually decides — which is exactly the decision the ambient env hijacks.
func makeJunkRepoDir(t *testing.T, dir string) string {
	t.Helper()
	for _, sub := range []string{"objects", "refs"} {
		if err := os.MkdirAll(filepath.Join(dir, ".git", sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// Acceptance: real git, two real directories, a real ambient redirect.
//
// GIT_DIR and GIT_WORK_TREE outrank `git -C <dir>` completely. Pointed at a
// healthy repo A, they make `rev-parse --git-dir` in the junk directory B exit
// 0 and report A's git dir — so isGitRepo(B) reports true about a repository it
// was never asked about. With the env scrubbed, rev-parse in B fails (exit 128)
// and the answer is the correct false, which is what makes this discriminate on
// the leak rather than on the fixture.
func TestIsGitRepo_IgnoresAmbientGitDir(t *testing.T) {
	base := t.TempDir()
	healthy := initRepoWithCommit(t, filepath.Join(base, "healthy"))
	notARepo := makeJunkRepoDir(t, filepath.Join(base, "not-a-repo"))

	t.Setenv("GIT_DIR", filepath.Join(healthy, ".git"))
	t.Setenv("GIT_WORK_TREE", healthy)

	if isGitRepo(notARepo) {
		t.Fatalf("isGitRepo(%s) = true: ambient GIT_DIR/GIT_WORK_TREE redirected "+
			"`rev-parse --git-dir` onto %s, so the liveness check answered about a "+
			"different repository. CloneOrOpen branches on this: a false yes hands "+
			"back a repoDir that git resolves elsewhere.", notARepo, healthy)
	}
}

// The mirror case, and the more damaging one. An ambient GIT_DIR pointing at a
// repo that is *not* usable makes rev-parse fail inside a perfectly healthy
// clone, so isGitRepo answers false about a live repository. CloneOrOpen then
// takes the stale-directory branch and os.RemoveAll's it — the runner deletes a
// working clone because of an environment variable.
func TestIsGitRepo_AmbientGitDirCannotFalsifyAHealthyRepo(t *testing.T) {
	base := t.TempDir()
	healthy := initRepoWithCommit(t, filepath.Join(base, "healthy"))
	junk := makeJunkRepoDir(t, filepath.Join(base, "junk"))

	t.Setenv("GIT_DIR", filepath.Join(junk, ".git"))

	if !isGitRepo(healthy) {
		t.Fatalf("isGitRepo(%s) = false for a real repo with a real commit: ambient "+
			"GIT_DIR pointed rev-parse at %s and it failed there. CloneOrOpen reads "+
			"this false as a stale directory and os.RemoveAll's the live clone.",
			healthy, junk)
	}
}

// Discovery escape: the base_dir incident shape, reached through isGitRepo.
//
// A wiped or half-deleted clone under BaseDir is not a repository, so git walks
// *up* looking for one — and binds to whatever repo encloses BaseDir. Here that
// is the enclosing repo standing in for the live worktree. isGitRepo then
// reports true for a directory that holds no repository at all.
//
// GIT_CEILING_DIRECTORIES stops that walk, and subprocessEnv already pins it to
// BaseDir for every Manager-driven command. isGitRepo takes no Manager and gets
// no ceiling, which is why it is the one caller that still escapes.
func TestIsGitRepo_DiscoveryCannotEscapeIntoEnclosingRepo(t *testing.T) {
	enclosing := initRepoWithCommit(t, filepath.Join(t.TempDir(), "enclosing"))
	wipedClone := makeJunkRepoDir(t, filepath.Join(enclosing, "repos", "board-clone"))

	// No ambient env is set: the enclosing repo alone is enough. The ceiling has
	// to come from the spawn site, so this fails until isGitRepo supplies one.
	if isGitRepo(wipedClone) {
		t.Fatalf("isGitRepo(%s) = true: git discovery walked up past the wiped clone "+
			"and bound to the enclosing repository at %s. That directory contains no "+
			"usable repo — every command CloneOrOpen then runs targets the enclosing "+
			"repo instead, which is precisely how a relative base_dir rewound main.",
			wipedClone, enclosing)
	}
}

// The scrub must not be written as a blanket os.Environ() wipe. PATH decides
// which `git` binary runs at all, so a child with no environment is a different
// bug wearing the same fix. Pinned here so the cure keeps the child runnable.
func TestIsGitRepo_StillFindsARealRepoWithCleanEnv(t *testing.T) {
	repo := initRepoWithCommit(t, filepath.Join(t.TempDir(), "healthy"))

	if !isGitRepo(repo) {
		t.Fatal("isGitRepo returned false for a real repo with a real commit and no " +
			"ambient interference: the hardened env must still let git run (PATH, HOME)")
	}
}
