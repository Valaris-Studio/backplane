// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// Cluster III (post-client-pilot hardening): the enable_auto_merge KIND stays
// registered for backend parity, but its handler is now a SILENT NO-OP. The
// runner is git-provider-agnostic — it never arms GitHub's proprietary
// auto-merge. Merge happens ONLY via the reviewer's merge_pr step after an
// approve verdict (see kind_merge_pr.go / Loop.mergeGate).
//
// See the 2026-05-26 auto-merge-not-enabled incident (internal note): arming soft-failed
// harmlessly on the free-plan repo and the reviewer's explicit merge was the
// real path on all 23 client-pilot cards. Dropping the arm removes WARN noise
// and the single-provider coupling.

// The handler must never touch git and never record a ship_warning, regardless
// of card/PR/RepoDir state — it does nothing. A PR URL that would previously
// have triggered a (failing) gh shell-out now produces zero side effects.
func TestKindEnableAutoMerge_IsNoOp(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)

	ws := makeWalkState(t, loop, strat, &discoverResult{
		CardID:  "c1",
		BoardID: "b",
		PRURL:   "https://github.com/Valaris-Studio/backplane/runner-test-nonexistent/pull/99999",
	})
	ws.RepoDir = t.TempDir()

	step := &valaris.LifecycleStep{Name: "arm", Kind: "enable_auto_merge"}
	next, decision, err := lifecycleEnableAutoMerge(context.Background(), ws, step)
	if err != nil {
		t.Fatalf("enable_auto_merge no-op must not error, got: %v", err)
	}
	if next != "" || decision != "" {
		t.Fatalf("no-op must return empty next/decision, got next=%q decision=%q", next, decision)
	}

	// No arming attempt → no soft-fail warning recorded.
	if _, ok := ws.Get("ship_warnings"); ok {
		t.Error("no-op handler must not record any ship_warnings")
	}
}

// The handler is unconditionally a no-op: it must NOT hard-error on a missing
// PR URL or RepoDir the way the old arming handler did. Nothing it would have
// validated still applies once it does nothing.
func TestKindEnableAutoMerge_NoOpEvenWithoutPRURLOrRepoDir(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := &lifecycle.WalkState{Loop: loop, Strategy: strat, Card: &discoverResult{CardID: "c", BoardID: "b"}}

	step := &valaris.LifecycleStep{Name: "arm", Kind: "enable_auto_merge"}
	if _, _, err := lifecycleEnableAutoMerge(context.Background(), ws, step); err != nil {
		t.Errorf("no-op must not error on missing PR URL / RepoDir, got: %v", err)
	}
}
