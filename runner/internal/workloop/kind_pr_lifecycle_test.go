// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// LIFECYCLE-FOLLOWUP-4 — happy-path tests for the 5 PR-lifecycle kinds.
// Deep git mechanics (gh CLI calls, MergePR strategy plumbing) are covered in
// internal/git/git_test.go. Tests here focus on dispatch + param plumbing +
// early-error gates (missing card, missing PR URL, missing RepoDir) so a
// regression in the bridge layer surfaces fast.

// --- create_pr ---

func TestKindCreatePR_RequiresCard(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := &lifecycle.WalkState{Loop: loop, Strategy: strat}
	step := &valaris.LifecycleStep{Name: "open", Kind: "create_pr"}
	_, _, err := lifecycleCreatePR(context.Background(), ws, step)
	if err == nil || !strings.Contains(err.Error(), "requires a card") {
		t.Errorf("want requires-a-card error, got: %v", err)
	}
}

func TestKindCreatePR_RequiresRepoDir(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c", BoardID: "b"}) // no RepoDir
	step := &valaris.LifecycleStep{Name: "open", Kind: "create_pr"}
	_, _, err := lifecycleCreatePR(context.Background(), ws, step)
	if err == nil || !strings.Contains(err.Error(), "RepoDir") {
		t.Errorf("want missing-repo-dir error, got: %v", err)
	}
}

// TODO(LIFECYCLE-FOLLOWUP-4): a happy-path test would need a fake git.Manager
// recording CreatePR(args). The real Manager shells out to `gh pr create` and
// the package has no mocking framework today — keeping the gate checks above
// as the bridge-layer regression net; deep PR creation is covered in
// internal/git/git_test.go.

// --- git_setup branch persistence (M1-05 limbo fix) ---

// When git_setup creates/recovers the feature branch it must persist
// branch_name to the card immediately — not wait for the PR step. A stage that
// wedges after branch+commit+PR but before completing leaves the card with NO
// branch linkage, so the backend's repo_has_no_open_pr precondition can't
// recognize the card's own PR as its own and strands it in limbo (M1-05,
// 2026-05-26). Recording the branch at setup time makes the card self-recover.
func TestRecordCardBranch_PersistsBranchNameToCard(t *testing.T) {
	var captured struct {
		method, path string
		branchName   string
		got          bool
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		if r.Method == http.MethodPatch && strings.Contains(r.URL.Path, "/cards/") {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			captured.method = r.Method
			captured.path = r.URL.Path
			if v, ok := body["branch_name"].(string); ok {
				captured.branchName = v
				captured.got = true
			}
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)

	loop := newLoopForKindTest(t, srv.URL)
	card := &discoverResult{CardID: "card-x", BoardID: "b"}

	if err := recordCardBranch(context.Background(), loop, card, "runner/m1-05-foo"); err != nil {
		t.Fatalf("recordCardBranch: %v", err)
	}
	if !captured.got {
		t.Fatal("expected a PATCH carrying branch_name to the card")
	}
	if captured.branchName != "runner/m1-05-foo" {
		t.Errorf("branch_name = %q, want runner/m1-05-foo", captured.branchName)
	}
}

// enable_auto_merge is a registered-but-no-op kind (Cluster III). Its behavior
// is covered by kind_enable_auto_merge_test.go; nothing to assert here.

// --- merge_pr ---

func TestKindMergePR_RequiresPRURL(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c", BoardID: "b"}) // no PRURL
	step := &valaris.LifecycleStep{Name: "merge", Kind: "merge_pr"}
	_, _, err := lifecycleMergePR(context.Background(), ws, step)
	if err == nil || !strings.Contains(err.Error(), "PR URL") {
		t.Errorf("want missing-pr error, got: %v", err)
	}
}

func TestKindMergePR_DirectPathInvokesMergeGate(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	// platformConfig defaults to MergeViaQueue=false (the test harness's
	// DefaultPipelineConfig doesn't set it), so merge_pr takes the direct path.
	var captured struct {
		repoDir, prURL, strategy string
		called                   bool
	}
	loop.mergeGate = func(_ context.Context, repoDir, prURL, strategy string) error {
		captured.repoDir = repoDir
		captured.prURL = prURL
		captured.strategy = strategy
		captured.called = true
		return nil
	}
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{
		CardID: "c", BoardID: "b", PRURL: "https://github.com/x/y/pull/1",
	})
	ws.RepoDir = "/tmp/repo"
	step := &valaris.LifecycleStep{Name: "merge", Kind: "merge_pr",
		Params: map[string]any{"strategy": "rebase"}}

	if _, _, err := lifecycleMergePR(context.Background(), ws, step); err != nil {
		t.Fatalf("merge_pr: %v", err)
	}
	if !captured.called {
		t.Fatal("expected mergeGate to be called")
	}
	if captured.strategy != "rebase" {
		t.Errorf("strategy = %q, want rebase", captured.strategy)
	}
	if captured.prURL != "https://github.com/x/y/pull/1" {
		t.Errorf("prURL = %q, want PR url from card", captured.prURL)
	}
	if captured.repoDir != "/tmp/repo" {
		t.Errorf("repoDir = %q, want /tmp/repo", captured.repoDir)
	}
}

func TestKindMergePR_QueuePathSkipsMergeGate(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	// Flip the runner's snapshotted platform config to enable the queue path.
	loop.platformConfigMu.Lock()
	if loop.platformConfig.PipelineConfig == nil {
		loop.platformConfig.PipelineConfig = &valaris.PipelineConfig{}
	}
	loop.platformConfig.PipelineConfig.MergeViaQueue = true
	loop.platformConfigMu.Unlock()

	mergeGateCalled := false
	loop.mergeGate = func(_ context.Context, _, _, _ string) error {
		mergeGateCalled = true
		return nil
	}

	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{
		CardID: "c", BoardID: "b", PRURL: "https://github.com/x/y/pull/1",
		PRBranch: "feature/x", GitRepoID: "repo-1",
	})
	ws.RepoDir = "/tmp/repo"
	step := &valaris.LifecycleStep{Name: "merge", Kind: "merge_pr"}

	// EnqueueForMerge POSTs to the backend; kindHandlersServer responds 200 to
	// any POST so the call returns nil and we just need to verify the queue
	// path was taken (mergeGate untouched).
	if _, _, err := lifecycleMergePR(context.Background(), ws, step); err != nil {
		t.Fatalf("merge_pr (queue): %v", err)
	}
	if mergeGateCalled {
		t.Error("expected mergeGate NOT to be called when MergeViaQueue=true")
	}
}

// --- post_pr_review ---

func TestKindPostPRReview_SkipsWhenReviewOnGitHubDisabled(t *testing.T) {
	srv, rec := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	loop.cfg.Git.ReviewOnGitHub = false // explicit
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{
		CardID: "c", BoardID: "b", PRURL: "https://github.com/x/y/pull/1",
	})
	ws.RepoDir = "/tmp/repo"
	step := &valaris.LifecycleStep{Name: "post", Kind: "post_pr_review",
		Params: map[string]any{"decision": "approve"}}

	if _, _, err := lifecyclePostPRReview(context.Background(), ws, step); err != nil {
		t.Fatalf("post_pr_review: %v", err)
	}
	// No git operations mean no extra HTTP traffic beyond what kindHandlersServer
	// already serves; the only safe assertion is that no panic + nil error
	// happened. (Hits include the platform-config fetch from loop construction.)
	_ = rec
}

func TestKindPostPRReview_SkipsWhenNoPRURL(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	loop.cfg.Git.ReviewOnGitHub = true
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c", BoardID: "b"})
	step := &valaris.LifecycleStep{Name: "post", Kind: "post_pr_review"}
	if _, _, err := lifecyclePostPRReview(context.Background(), ws, step); err != nil {
		t.Fatalf("post_pr_review (no PR): %v", err)
	}
}

// TODO(LIFECYCLE-FOLLOWUP-4): when ReviewOnGitHub=true + PRURL set, the
// handler shells out to `gh pr review` via git.Manager. A meaningful happy-path
// test needs a fake gh executable on PATH, which doesn't exist in workloop
// tests. Coverage lives in internal/git/git_test.go.

// --- ship ---

func TestKindShip_RequiresCard(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := &lifecycle.WalkState{Loop: loop, Strategy: strat}
	step := &valaris.LifecycleStep{Name: "land", Kind: "ship"}
	_, _, err := lifecycleShip(context.Background(), ws, step)
	if err == nil || !strings.Contains(err.Error(), "requires a card") {
		t.Errorf("want requires-a-card error, got: %v", err)
	}
}

func TestKindShip_DefaultsToReviewColumn(t *testing.T) {
	boardID := "board-ship"
	srv, rec := kindHandlersServer(t, boardID)
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{
		CardID: "card-ship", BoardID: boardID, Title: "t",
	})
	step := &valaris.LifecycleStep{Name: "land", Kind: "ship", Params: map[string]any{}}

	if _, _, err := lifecycleShip(context.Background(), ws, step); err != nil {
		t.Fatalf("ship: %v", err)
	}
	// l.ship calls GetCard + UpdateCard + moveCardToColumnType — at least one
	// GET on the card is observable.
	if !rec.any("/cards/card-ship", "GET") {
		t.Errorf("expected GET on card during ship, hits=%v", rec.hits)
	}
}
