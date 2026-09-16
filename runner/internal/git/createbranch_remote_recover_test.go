// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package git

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// Budget-suspend resume: the suspend pass committed + PUSHED the WIP to the
// remote feature branch, then the card was unassigned and parked. On the resume
// pickup the runner does a FRESH clone (or a clone whose local feature branch was
// cleaned), so the WIP branch exists ONLY on the remote. CreateBranch must land
// the working tree ON that remote WIP commit — otherwise the resume LLM sees a
// tree at base (main), the resume brief's "build on branch HEAD" is a lie, and
// the agent re-implements from scratch, re-burning the budget the suspend saved.
func TestCreateBranch_RecoversRemoteOnlyWIP(t *testing.T) {
	remote := initRemoteWithCommit(t)

	// Pass 1's clone: branch, commit WIP, push to remote. This is the suspend
	// checkpoint landing on origin.
	p1Base := filepath.Join(t.TempDir(), "pass1")
	mgr1 := &Manager{BaseDir: p1Base, DefaultRemote: "origin", BranchPrefix: "runner/"}
	repo1, _ := mgr1.CloneOrOpen(context.Background(), remote, "repo")
	run(t, repo1, "git", "config", "user.email", "test@valaris.dev")
	run(t, repo1, "git", "config", "user.name", "Test")
	mgr1.CreateBranch(context.Background(), repo1, "sus-card", "main") //nolint: errcheck
	os.WriteFile(filepath.Join(repo1, "wip.py"), []byte("# 80% done\n"), 0644)
	run(t, repo1, "git", "add", ".")
	run(t, repo1, "git", "commit", "-m", "wip(sus-card): budget checkpoint pass 1")
	run(t, repo1, "git", "push", "origin", "runner/sus-card")

	// Pass 2 (resume): a FRESH clone — the local feature branch does not exist
	// here, only origin/runner/sus-card carries the WIP.
	p2Base := filepath.Join(t.TempDir(), "pass2")
	mgr2 := &Manager{BaseDir: p2Base, DefaultRemote: "origin", BranchPrefix: "runner/"}
	repo2, _ := mgr2.CloneOrOpen(context.Background(), remote, "repo")
	run(t, repo2, "git", "config", "user.email", "test@valaris.dev")
	run(t, repo2, "git", "config", "user.name", "Test")

	branch, recovered, err := mgr2.CreateBranch(context.Background(), repo2, "sus-card", "main")
	if err != nil {
		t.Fatalf("resume CreateBranch errored: %v", err)
	}
	if !recovered {
		t.Error("expected recovered=true (remote branch carries the WIP)")
	}
	_ = branch

	// THE checkpoint must be in the working tree, or resume re-implements from zero.
	if _, err := os.Stat(filepath.Join(repo2, "wip.py")); err != nil {
		t.Error("resume must check out the remote WIP checkpoint (wip.py missing) — " +
			"branch was created from base instead of the pushed WIP commit")
	}
	ahead, _ := mgr2.CommitsAhead(context.Background(), repo2, "main")
	if ahead < 1 {
		t.Errorf("resumed branch must be >=1 ahead of main (carry the WIP commit), got %d", ahead)
	}
}
