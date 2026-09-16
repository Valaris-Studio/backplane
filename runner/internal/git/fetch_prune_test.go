// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package git

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A branch deleted on the remote out of band (gh pr close --delete-branch, or a
// forge-side cleanup) leaves the reused clone holding a stale origin/<branch>
// remote-tracking ref. --force-with-lease computes its lease from that ref, so
// the next push is rejected with "(stale info)" AFTER the implement LLM has
// already run — one wasted paid pass per occurrence. CloneOrOpen's fetch must
// prune so the lease sees no remote counterpart and the push re-creates the
// branch.
func TestCloneOrOpen_PrunesBranchDeletedOnRemote(t *testing.T) {
	remote := initRemoteWithCommit(t)
	ctx := context.Background()

	base := filepath.Join(t.TempDir(), "runner")
	mgr := &Manager{BaseDir: base, DefaultRemote: "origin", BranchPrefix: "runner/"}
	repo, err := mgr.CloneOrOpen(ctx, remote, "repo")
	if err != nil {
		t.Fatalf("initial CloneOrOpen: %v", err)
	}
	run(t, repo, "git", "config", "user.email", "test@valaris.dev")
	run(t, repo, "git", "config", "user.name", "Test")

	if _, _, err := mgr.CreateBranch(ctx, repo, "stale-card", "main"); err != nil {
		t.Fatalf("CreateBranch: %v", err)
	}
	os.WriteFile(filepath.Join(repo, "work.py"), []byte("# pass 1\n"), 0644)
	run(t, repo, "git", "add", ".")
	run(t, repo, "git", "commit", "-m", "feat(stale-card): pass 1")
	run(t, repo, "git", "push", "origin", "runner/stale-card")

	// The forge deletes the branch; the clone is reused on the next tick.
	run(t, "", "git", "-C", remote, "update-ref", "-d", "refs/heads/runner/stale-card")

	reopened, err := mgr.CloneOrOpen(ctx, remote, "repo")
	if err != nil {
		t.Fatalf("CloneOrOpen on reused clone: %v", err)
	}
	if reopened != repo {
		t.Fatalf("expected the existing clone to be reused, got %q want %q", reopened, repo)
	}

	refs := run(t, repo, "git", "branch", "-r")
	if strings.Contains(refs, "origin/runner/stale-card") {
		t.Errorf("stale remote-tracking ref survived the fetch — CloneOrOpen must fetch with --prune.\nremote refs:\n%s", refs)
	}

	// The recovery path preserves the local commit; the push must now succeed as
	// a branch re-creation rather than dying on a lease against a vanished ref.
	if _, _, err := mgr.CreateBranch(ctx, repo, "stale-card", "main"); err != nil {
		t.Fatalf("recovery CreateBranch: %v", err)
	}
	os.WriteFile(filepath.Join(repo, "work.py"), []byte("# pass 2\n"), 0644)
	run(t, repo, "git", "add", ".")
	run(t, repo, "git", "commit", "-m", "feat(stale-card): pass 2")

	if err := mgr.ForceWithLeasePush(ctx, repo); err != nil {
		t.Fatalf("ForceWithLeasePush after remote-side branch delete must succeed, got: %v", err)
	}
}

// The reviewer's CheckoutBranch does the other full-remote fetch; it must prune
// too, so a reused clone doesn't keep resurrecting deleted PR branches as
// checkout-able remote refs.
func TestCheckoutBranch_PrunesBranchDeletedOnRemote(t *testing.T) {
	remote := initRemoteWithCommit(t)
	ctx := context.Background()

	base := filepath.Join(t.TempDir(), "runner")
	mgr := &Manager{BaseDir: base, DefaultRemote: "origin", BranchPrefix: "runner/"}
	repo, err := mgr.CloneOrOpen(ctx, remote, "repo")
	if err != nil {
		t.Fatalf("initial CloneOrOpen: %v", err)
	}
	run(t, repo, "git", "config", "user.email", "test@valaris.dev")
	run(t, repo, "git", "config", "user.name", "Test")

	if _, _, err := mgr.CreateBranch(ctx, repo, "review-card", "main"); err != nil {
		t.Fatalf("CreateBranch: %v", err)
	}
	os.WriteFile(filepath.Join(repo, "reviewed.py"), []byte("# under review\n"), 0644)
	run(t, repo, "git", "add", ".")
	run(t, repo, "git", "commit", "-m", "feat(review-card): work")
	run(t, repo, "git", "push", "origin", "runner/review-card")
	run(t, repo, "git", "checkout", "main")

	run(t, "", "git", "-C", remote, "update-ref", "-d", "refs/heads/runner/review-card")

	// Checking out the still-local branch succeeds; the fetch it performs first
	// is what must drop the vanished remote ref.
	if err := mgr.CheckoutBranch(ctx, repo, "runner/review-card"); err != nil {
		t.Fatalf("CheckoutBranch: %v", err)
	}
	refs := run(t, repo, "git", "branch", "-r")
	if strings.Contains(refs, "origin/runner/review-card") {
		t.Errorf("stale remote-tracking ref survived CheckoutBranch's fetch — it must fetch with --prune.\nremote refs:\n%s", refs)
	}
}
