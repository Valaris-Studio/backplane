// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// These tests cover two bugs surfaced by the 2026-04-20 field run:
//
//   Bug A (stale PR URL): when a card is re-claimed, the runner appends a new
//   "---\nBranch: x\nPR: y" block to the card description without removing
//   prior ones. extractPRURL walks the description top-down and returns the
//   FIRST PR:, so card.PRURL at applyApproveMergeGate time is stale. The fix
//   is to resolve the live PR for the branch via a gh-backed seam before
//   invoking mergeGate.
//
//   Bug B (Base branch was modified): isTransientMergeError only whitelists
//   network-level transients. GitHub's "Base branch was modified. Review and
//   try the merge again." is recoverable by rebasing onto the updated base
//   and retrying, but the runner currently routes the card to Blocked. The
//   fix is a rebase-then-retry once before giving up.
//
// The tests below reference seams that do NOT exist on main yet:
//
//   - Loop.currentPRResolver: injectable for looking up the open PR on a
//     given branch (contract identical to what git.Manager.CurrentPRForBranch
//     should provide). Defined as an interface so the test can inject a fake
//     without pulling in a real git.Manager. The implementer is free to
//     choose the field name as long as applyApproveMergeGate consults it
//     before falling back to card.PRURL.
//
//   - Loop.rebaseOnBase: injectable function to rebase the PR's branch on
//     top of its base, used between merge attempts when the merge error
//     reports the base branch was modified.
//
//   - isRebaseRetriableMergeError: classifier for "Base branch was modified"
//     (and any sibling retriable merge errors the implementer decides
//     belong here). Must be disjoint from isTransientMergeError.
//
// Compile errors on those symbols are the expected RED phase for TDD.

// prResolverCall captures a single invocation of currentPRResolver.
type prResolverCall struct {
	repoDir string
	branch  string
}

// fakePRResolver implements whatever interface Loop.currentPRResolver expects.
// The contract: given a branch name, return the live PR URL (or "", nil when
// there is no open PR, or "", err when the lookup failed).
//
// The fake FAILS the test if it receives repoDir == "" or a repoDir that does
// not match wantRepoDir. In prod, `gh pr list --head <branch>` resolves the
// target repo from cmd.Dir — an empty repoDir would make gh inherit the
// runner's CWD and silently query the wrong repo. A fake that ignored the
// parameter hid that bug in TDD round 1; this fake refuses to.
type fakePRResolver struct {
	t           *testing.T
	wantRepoDir string

	mu    sync.Mutex
	calls []prResolverCall
	url   string
	err   error
}

func (f *fakePRResolver) CurrentPRForBranch(_ context.Context, repoDir, branch string) (string, error) {
	f.mu.Lock()
	f.calls = append(f.calls, prResolverCall{repoDir: repoDir, branch: branch})
	f.mu.Unlock()
	if repoDir == "" {
		f.t.Fatalf("fakePRResolver.CurrentPRForBranch got empty repoDir (branch=%q); would break gh in prod (gh pr list resolves repo from CWD)", branch)
	}
	if f.wantRepoDir != "" && repoDir != f.wantRepoDir {
		f.t.Fatalf("fakePRResolver.CurrentPRForBranch got repoDir=%q, want %q (branch=%q)", repoDir, f.wantRepoDir, branch)
	}
	return f.url, f.err
}

// rebaseCall captures a single invocation of Loop.rebaseOnBase.
type rebaseCall struct {
	repoDir string
	branch  string
	prURL   string
}

// fakeRebaser records rebase invocations and returns the configured error.
//
// Same rationale as fakePRResolver: an empty repoDir would make git.Manager
// inherit the runner's CWD, potentially force-pushing an unrelated repo. The
// fake fatals on repoDir == "" or a mismatch against wantRepoDir so the bug
// surfaces in the test rather than in prod.
type fakeRebaser struct {
	t           *testing.T
	wantRepoDir string

	mu    sync.Mutex
	calls []rebaseCall
	err   error
}

func (f *fakeRebaser) Rebase(_ context.Context, repoDir, branch, prURL string) error {
	f.mu.Lock()
	f.calls = append(f.calls, rebaseCall{repoDir: repoDir, branch: branch, prURL: prURL})
	f.mu.Unlock()
	if repoDir == "" {
		f.t.Fatalf("fakeRebaser.Rebase got empty repoDir (branch=%q pr=%q); would run git against the runner's CWD in prod", branch, prURL)
	}
	if f.wantRepoDir != "" && repoDir != f.wantRepoDir {
		f.t.Fatalf("fakeRebaser.Rebase got repoDir=%q, want %q (branch=%q)", repoDir, f.wantRepoDir, branch)
	}
	return f.err
}

// sequencedMergeGate returns a mergeGate func that returns errs[i] on the i-th
// call, then errors.New("unexpected extra merge call") thereafter.
func sequencedMergeGate(calls *[]mergeCall, mu *sync.Mutex, errs ...error) func(ctx context.Context, repoDir, prURL, strategy string) error {
	return func(_ context.Context, _, prURL, strategy string) error {
		mu.Lock()
		idx := len(*calls)
		*calls = append(*calls, mergeCall{prURL: prURL, strategy: strategy})
		mu.Unlock()
		if idx >= len(errs) {
			return errors.New("unexpected extra merge call")
		}
		return errs[idx]
	}
}

// --- Bug A: stale PR URL ---

func TestApproveMergeGate_UsesLivePRURLFromGH_WhenDescriptionHasStaleBlock(t *testing.T) {
	boardID := "board-stale-pr"
	srv, _, _ := recordingServerWithBlocked(t, boardID)

	reviewerStage := StageForRole(DefaultPipelineConfig, "reviewer")
	strategy := NewDataDrivenStrategy(*reviewerStage, nil)

	loop := newActionTestLoop(t, srv.URL)
	loop.strategy = strategy

	var mergeMu sync.Mutex
	var merges []mergeCall
	loop.mergeGate = fakeMergeGate(&merges, &mergeMu, nil)

	repoDir := t.TempDir()
	resolver := &fakePRResolver{t: t, wantRepoDir: repoDir, url: "https://github.com/acme/repo/pull/22"}
	loop.currentPRResolver = resolver

	// card.PRURL matches what extractPRURL produces today against a
	// description carrying two "---\nBranch:\nPR:" blocks for the same
	// branch — the FIRST one wins, which is the stale one.
	card := &discoverResult{
		CardID:   "card-stale-pr",
		BoardID:  boardID,
		Title:    "re-claimed card with stale block",
		PRBranch: "runner/same-branch",
		PRURL:    "https://github.com/acme/repo/pull/2", // stale
	}
	llmResult := &llmStageResult{
		reviewResult: &reviewResult{Decision: "approve", Summary: "LGTM"},
		decision:     "approve",
	}

	err := strategy.postActionWithConfig(
		context.Background(), context.Background(),
		loop, card, "exec-stale-pr", repoDir, "",
		llmResult, nil, func() {}, silentLogger(),
	)
	if err != nil {
		t.Fatalf("postActionWithConfig: %v", err)
	}

	mergeMu.Lock()
	defer mergeMu.Unlock()
	if len(merges) != 1 {
		t.Fatalf("expected exactly 1 merge call, got %d: %+v", len(merges), merges)
	}
	if merges[0].prURL != "https://github.com/acme/repo/pull/22" {
		t.Errorf("mergeGate invoked with stale PR URL %q, want live pull/22", merges[0].prURL)
	}

	resolver.mu.Lock()
	defer resolver.mu.Unlock()
	if len(resolver.calls) == 0 {
		t.Error("expected currentPRResolver to be consulted before dispatching merge")
	}
	if len(resolver.calls) > 0 && resolver.calls[0].branch != "runner/same-branch" {
		t.Errorf("resolver asked about branch %q, want runner/same-branch", resolver.calls[0].branch)
	}
}

func TestApproveMergeGate_FallsBackToDescriptionPRURLWhenGhListFails(t *testing.T) {
	boardID := "board-resolver-broken"
	srv, _, _ := recordingServerWithBlocked(t, boardID)

	reviewerStage := StageForRole(DefaultPipelineConfig, "reviewer")
	strategy := NewDataDrivenStrategy(*reviewerStage, nil)

	loop := newActionTestLoop(t, srv.URL)
	loop.strategy = strategy

	var mergeMu sync.Mutex
	var merges []mergeCall
	loop.mergeGate = fakeMergeGate(&merges, &mergeMu, nil)

	// Resolver broken — must NOT burn the card; preserve today's semantics
	// by falling back to card.PRURL (the description-derived one).
	repoDir := t.TempDir()
	loop.currentPRResolver = &fakePRResolver{t: t, wantRepoDir: repoDir, err: errors.New("gh: not logged in")}

	card := &discoverResult{
		CardID:   "card-resolver-broken",
		BoardID:  boardID,
		Title:    "resolver broken — fallback preserves semantics",
		PRBranch: "runner/same-branch",
		PRURL:    "https://github.com/acme/repo/pull/2",
	}
	llmResult := &llmStageResult{
		reviewResult: &reviewResult{Decision: "approve", Summary: "LGTM"},
		decision:     "approve",
	}

	err := strategy.postActionWithConfig(
		context.Background(), context.Background(),
		loop, card, "exec-resolver-broken", repoDir, "",
		llmResult, nil, func() {}, silentLogger(),
	)
	if err != nil {
		t.Fatalf("postActionWithConfig: %v", err)
	}

	mergeMu.Lock()
	defer mergeMu.Unlock()
	if len(merges) != 1 {
		t.Fatalf("expected exactly 1 merge call, got %d: %+v", len(merges), merges)
	}
	if merges[0].prURL != card.PRURL {
		t.Errorf("resolver failure: mergeGate prURL=%q, want fallback %q", merges[0].prURL, card.PRURL)
	}
}

// --- Bug B: rebase-then-retry on "Base branch was modified" ---

func TestApproveMergeGate_RebaseRetriesOnBaseBranchWasModified(t *testing.T) {
	boardID := "board-rebase-retry-ok"
	srv, reqs, reqsMu := recordingServerWithBlocked(t, boardID)

	reviewerStage := StageForRole(DefaultPipelineConfig, "reviewer")
	strategy := NewDataDrivenStrategy(*reviewerStage, nil)

	loop := newActionTestLoop(t, srv.URL)
	loop.strategy = strategy

	baseModified := errors.New(`merge PR https://github.com/acme/repo/pull/42: failed to run gh pr merge: GraphQL: Base branch was modified. Review and try the merge again.`)
	var mergeMu sync.Mutex
	var merges []mergeCall
	loop.mergeGate = sequencedMergeGate(&merges, &mergeMu, baseModified, nil)

	repoDir := t.TempDir()
	// resolver set so applyApproveMergeGate's branch lookup also exercises repoDir.
	loop.currentPRResolver = &fakePRResolver{t: t, wantRepoDir: repoDir}
	rebaser := &fakeRebaser{t: t, wantRepoDir: repoDir}
	loop.rebaseOnBase = rebaser.Rebase

	card := &discoverResult{
		CardID:   "card-rebase-retry-ok",
		BoardID:  boardID,
		Title:    "base moved under us",
		PRBranch: "runner/rebase-branch",
		PRURL:    "https://github.com/acme/repo/pull/42",
	}
	llmResult := &llmStageResult{
		reviewResult: &reviewResult{Decision: "approve", Summary: "LGTM"},
		decision:     "approve",
	}

	err := strategy.postActionWithConfig(
		context.Background(), context.Background(),
		loop, card, "exec-rebase-retry-ok", repoDir, "",
		llmResult, nil, func() {}, silentLogger(),
	)
	if err != nil {
		t.Fatalf("postActionWithConfig: %v", err)
	}

	mergeMu.Lock()
	if len(merges) != 2 {
		t.Fatalf("expected 2 merge calls (fail then retry), got %d: %+v", len(merges), merges)
	}
	mergeMu.Unlock()

	rebaser.mu.Lock()
	if len(rebaser.calls) != 1 {
		t.Errorf("expected rebase to be called exactly once between merges, got %d calls", len(rebaser.calls))
	}
	rebaser.mu.Unlock()

	// Second merge succeeded → card must NOT be routed to Blocked.
	moveReq := findRequest(reqs, reqsMu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch && strings.Contains(r.Path, "/cards/"+card.CardID+"/move")
	})
	if moveReq != nil && strings.Contains(moveReq.Body, "col-blocked") {
		t.Errorf("successful retry must NOT route to Blocked, got: %s", moveReq.Body)
	}

	// No merge-blocked review note on successful retry.
	noteReq := findRequest(reqs, reqsMu, func(r recordedRequest) bool {
		return r.Method == http.MethodPost &&
			strings.HasSuffix(r.Path, "/boards/"+card.BoardID+"/notes") &&
			strings.Contains(r.Body, "merge-blocked")
	})
	if noteReq != nil {
		t.Errorf("successful retry must NOT create a merge-blocked note, got body: %s", noteReq.Body)
	}
}

func TestApproveMergeGate_GivesUpAfterOneRebaseRetry(t *testing.T) {
	boardID := "board-rebase-retry-giveup"
	srv, reqs, reqsMu := recordingServerWithBlocked(t, boardID)

	reviewerStage := StageForRole(DefaultPipelineConfig, "reviewer")
	strategy := NewDataDrivenStrategy(*reviewerStage, nil)

	loop := newActionTestLoop(t, srv.URL)
	loop.strategy = strategy

	first := errors.New(`merge PR https://github.com/acme/repo/pull/42: GraphQL: Base branch was modified. Review and try the merge again.`)
	second := errors.New(`merge PR https://github.com/acme/repo/pull/42: GraphQL: Base branch was modified. Review and try the merge again. (second attempt)`)
	var mergeMu sync.Mutex
	var merges []mergeCall
	loop.mergeGate = sequencedMergeGate(&merges, &mergeMu, first, second)

	repoDir := t.TempDir()
	loop.currentPRResolver = &fakePRResolver{t: t, wantRepoDir: repoDir}
	rebaser := &fakeRebaser{t: t, wantRepoDir: repoDir}
	loop.rebaseOnBase = rebaser.Rebase

	card := &discoverResult{
		CardID:   "card-rebase-retry-giveup",
		BoardID:  boardID,
		Title:    "base keeps moving",
		PRBranch: "runner/rebase-giveup",
		PRURL:    "https://github.com/acme/repo/pull/42",
	}
	llmResult := &llmStageResult{
		reviewResult: &reviewResult{Decision: "approve", Summary: "LGTM"},
		decision:     "approve",
	}

	err := strategy.postActionWithConfig(
		context.Background(), context.Background(),
		loop, card, "exec-rebase-giveup", repoDir, "",
		llmResult, nil, func() {}, silentLogger(),
	)
	if err != nil {
		t.Fatalf("postActionWithConfig: %v", err)
	}

	mergeMu.Lock()
	if len(merges) != 2 {
		t.Fatalf("expected exactly 2 merge attempts (one rebase retry), got %d: %+v", len(merges), merges)
	}
	mergeMu.Unlock()

	rebaser.mu.Lock()
	if len(rebaser.calls) != 1 {
		t.Errorf("expected rebase called exactly once (no second rebase after second failure), got %d", len(rebaser.calls))
	}
	rebaser.mu.Unlock()

	moveReq := findRequest(reqs, reqsMu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch && strings.Contains(r.Path, "/cards/"+card.CardID+"/move")
	})
	if moveReq == nil {
		t.Fatal("expected MoveCard on final rebase-retry failure")
	}
	if !strings.Contains(moveReq.Body, "col-blocked") {
		t.Errorf("final rebase-retry failure must route to Blocked, got: %s", moveReq.Body)
	}

	noteReq := findRequest(reqs, reqsMu, func(r recordedRequest) bool {
		return r.Method == http.MethodPost && strings.HasSuffix(r.Path, "/boards/"+card.BoardID+"/notes")
	})
	if noteReq == nil {
		t.Fatal("expected merge-blocked review note on final failure")
	}
	if !strings.Contains(noteReq.Body, "merge-blocked") {
		t.Errorf("note decision should be merge-blocked, got: %s", noteReq.Body)
	}
	// The SECOND (final) error must be surfaced so the operator sees what the
	// retry actually hit, not just the first "Base branch was modified".
	if !strings.Contains(noteReq.Body, "second attempt") {
		t.Errorf("note must surface the SECOND merge error, got: %s", noteReq.Body)
	}
}

func TestApproveMergeGate_TransientErrorStillStaysInReview(t *testing.T) {
	// Guard against the new rebase-retry path swallowing transient cases.
	// Transient (e.g. rate limit) must still NOT invoke rebase, NOT move
	// the card, and NOT create a note — behavior preserved from before the
	// rebase-retry landed.
	boardID := "board-transient-nolaunchrebase"
	srv, reqs, reqsMu := recordingServerWithBlocked(t, boardID)

	reviewerStage := StageForRole(DefaultPipelineConfig, "reviewer")
	strategy := NewDataDrivenStrategy(*reviewerStage, nil)

	loop := newActionTestLoop(t, srv.URL)
	loop.strategy = strategy

	rateLimited := errors.New("merge PR https://github.com/acme/repo/pull/42: HTTP 429 rate limit exceeded")
	var mergeMu sync.Mutex
	var merges []mergeCall
	loop.mergeGate = fakeMergeGate(&merges, &mergeMu, rateLimited)

	repoDir := t.TempDir()
	loop.currentPRResolver = &fakePRResolver{t: t, wantRepoDir: repoDir}
	rebaser := &fakeRebaser{t: t, wantRepoDir: repoDir}
	loop.rebaseOnBase = rebaser.Rebase

	card := &discoverResult{
		CardID:   "card-transient-nolaunchrebase",
		BoardID:  boardID,
		Title:    "transient guard",
		PRBranch: "runner/transient",
		PRURL:    "https://github.com/acme/repo/pull/42",
	}
	llmResult := &llmStageResult{
		reviewResult: &reviewResult{Decision: "approve", Summary: "LGTM"},
		decision:     "approve",
	}

	err := strategy.postActionWithConfig(
		context.Background(), context.Background(),
		loop, card, "exec-transient-nolaunchrebase", repoDir, "",
		llmResult, nil, func() {}, silentLogger(),
	)
	if err != nil {
		t.Fatalf("postActionWithConfig: %v", err)
	}

	mergeMu.Lock()
	if len(merges) != 1 {
		t.Errorf("transient must NOT trigger rebase-retry; got %d merge calls", len(merges))
	}
	mergeMu.Unlock()

	rebaser.mu.Lock()
	if len(rebaser.calls) != 0 {
		t.Errorf("transient must NOT invoke rebase, got %d rebase calls", len(rebaser.calls))
	}
	rebaser.mu.Unlock()

	moveReq := findRequest(reqs, reqsMu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch && strings.Contains(r.Path, "/cards/"+card.CardID+"/move")
	})
	if moveReq != nil {
		t.Errorf("transient must NOT move the card, got: %s", moveReq.Body)
	}

	noteReq := findRequest(reqs, reqsMu, func(r recordedRequest) bool {
		return r.Method == http.MethodPost && strings.HasSuffix(r.Path, "/boards/"+card.BoardID+"/notes") &&
			strings.Contains(r.Body, "merge-blocked")
	})
	if noteReq != nil {
		t.Errorf("transient must NOT create a merge-blocked note, got: %s", noteReq.Body)
	}
}

// --- Bug B classifier: disjoint predicates ---

func TestIsTransientMergeError_AndIsRebaseRetriableMergeError_AreDisjoint(t *testing.T) {
	// The two predicates route to different code paths (transient → stay in
	// place for next tick, rebase-retriable → rebase + retry immediately).
	// If any error string matched both, the dispatch in applyApproveMergeGate
	// would be ambiguous. Table keeps canonical error strings we expect the
	// implementer to classify.
	cases := []struct {
		name         string
		msg          string
		wantTrans    bool
		wantRebase   bool
	}{
		{
			name:       "base branch was modified",
			msg:        "merge PR https://github.com/org/repo/pull/1: GraphQL: Base branch was modified. Review and try the merge again.",
			wantRebase: true,
		},
		{
			name:      "rate limit",
			msg:       "merge PR https://github.com/org/repo/pull/1: HTTP 429 rate limit exceeded",
			wantTrans: true,
		},
		{
			name:      "503 service unavailable",
			msg:       "merge PR https://github.com/org/repo/pull/1: HTTP 503 Service Unavailable",
			wantTrans: true,
		},
		{
			name:      "connection reset",
			msg:       "merge PR https://github.com/org/repo/pull/1: connection reset by peer",
			wantTrans: true,
		},
		{
			// Permanent error — classified by NEITHER predicate. Routed to
			// Blocked immediately without rebase.
			name: "ci red (permanent)",
			msg:  "merge PR https://github.com/org/repo/pull/1: required status check 'ci' is red",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := errors.New(tc.msg)
			gotTrans := isTransientMergeError(err)
			gotRebase := isRebaseRetriableMergeError(err)

			if gotTrans && gotRebase {
				t.Fatalf("predicates must be disjoint; both matched %q", tc.msg)
			}
			if gotTrans != tc.wantTrans {
				t.Errorf("isTransientMergeError(%q) = %v, want %v", tc.msg, gotTrans, tc.wantTrans)
			}
			if gotRebase != tc.wantRebase {
				t.Errorf("isRebaseRetriableMergeError(%q) = %v, want %v", tc.msg, gotRebase, tc.wantRebase)
			}
		})
	}
}

// --- CRITICAL #1/#2: repoDir must reach the PR resolver and the rebaser ---
//
// applyApproveMergeGate currently passes "" as repoDir to both
// l.currentPRResolver.CurrentPRForBranch and l.rebaseOnBase. In prod this
// empty string propagates into gh (resolves the wrong repo from CWD) and git
// (force-pushes against the runner's CWD). The fakes in round 1 silently
// ignored the param so the bug slipped past review. This test exercises the
// happy path (rebase succeeds on one retry) and asserts both seams received
// the SAME non-empty repoDir that postActionWithConfig was given.
func TestApproveMergeGate_PropagatesRepoDirToPRResolverAndRebase(t *testing.T) {
	boardID := "board-propagate-repodir"
	srv, _, _ := recordingServerWithBlocked(t, boardID)

	reviewerStage := StageForRole(DefaultPipelineConfig, "reviewer")
	strategy := NewDataDrivenStrategy(*reviewerStage, nil)

	loop := newActionTestLoop(t, srv.URL)
	loop.strategy = strategy

	baseModified := errors.New(`merge PR https://github.com/acme/repo/pull/99: GraphQL: Base branch was modified. Review and try the merge again.`)
	var mergeMu sync.Mutex
	var merges []mergeCall
	loop.mergeGate = sequencedMergeGate(&merges, &mergeMu, baseModified, nil)

	repoDir := t.TempDir()
	resolver := &fakePRResolver{t: t, wantRepoDir: repoDir, url: "https://github.com/acme/repo/pull/99"}
	loop.currentPRResolver = resolver
	rebaser := &fakeRebaser{t: t, wantRepoDir: repoDir}
	loop.rebaseOnBase = rebaser.Rebase

	card := &discoverResult{
		CardID:   "card-propagate-repodir",
		BoardID:  boardID,
		Title:    "exact repoDir propagation",
		PRBranch: "runner/propagate-repodir",
		PRURL:    "https://github.com/acme/repo/pull/99",
	}
	llmResult := &llmStageResult{
		reviewResult: &reviewResult{Decision: "approve", Summary: "LGTM"},
		decision:     "approve",
	}

	err := strategy.postActionWithConfig(
		context.Background(), context.Background(),
		loop, card, "exec-propagate-repodir", repoDir, "",
		llmResult, nil, func() {}, silentLogger(),
	)
	if err != nil {
		t.Fatalf("postActionWithConfig: %v", err)
	}

	// Resolver seen: exact repoDir (not "").
	resolver.mu.Lock()
	if len(resolver.calls) == 0 {
		t.Fatal("expected currentPRResolver to be consulted before dispatching merge")
	}
	for i, c := range resolver.calls {
		if c.repoDir != repoDir {
			t.Errorf("resolver call %d: repoDir=%q, want %q", i, c.repoDir, repoDir)
		}
	}
	resolver.mu.Unlock()

	// Rebaser seen: exact repoDir (not "").
	rebaser.mu.Lock()
	if len(rebaser.calls) != 1 {
		t.Fatalf("expected exactly 1 rebase call on base-modified retry, got %d", len(rebaser.calls))
	}
	if rebaser.calls[0].repoDir != repoDir {
		t.Errorf("rebaser repoDir=%q, want %q", rebaser.calls[0].repoDir, repoDir)
	}
	rebaser.mu.Unlock()
}

// --- MAJOR: rebase failures must not flow through isTransientMergeError ---
//
// When the first merge attempt reports "Base branch was modified" and the
// rebase itself fails with a message containing a transient marker (e.g.
// "i/o timeout" mid-fetch), today's code (strategy_generic.go:1614-1621)
// sets err = rebaseErr and falls through to the isTransientMergeError check
// below. The rebase error text contains "i/o timeout" so the card STAYS IN
// REVIEW with a half-rebased local branch — and the next tick compounds the
// problem. Rebase failures are neither transient nor a merge error: they
// route straight to Blocked with the rebase error surfaced.
func TestApproveMergeGate_RebaseFailureRoutesToBlocked_NotTransient(t *testing.T) {
	boardID := "board-rebase-fail-not-transient"
	srv, reqs, reqsMu := recordingServerWithBlocked(t, boardID)

	reviewerStage := StageForRole(DefaultPipelineConfig, "reviewer")
	strategy := NewDataDrivenStrategy(*reviewerStage, nil)

	loop := newActionTestLoop(t, srv.URL)
	loop.strategy = strategy

	baseModified := errors.New(`merge PR https://github.com/acme/repo/pull/42: GraphQL: Base branch was modified. Review and try the merge again.`)
	var mergeMu sync.Mutex
	var merges []mergeCall
	// Second entry intentionally absent; the test asserts mergeGate is NEVER
	// called a second time when rebase itself fails.
	loop.mergeGate = sequencedMergeGate(&merges, &mergeMu, baseModified)

	repoDir := t.TempDir()
	loop.currentPRResolver = &fakePRResolver{t: t, wantRepoDir: repoDir}
	// Rebase fails with a message that contains an isTransientMergeError marker
	// ("i/o timeout"). If the implementation routes rebase errors through
	// isTransientMergeError, this test will observe no Blocked move — and fail.
	rebaser := &fakeRebaser{
		t:           t,
		wantRepoDir: repoDir,
		err:         errors.New("rebase failed: git fetch origin main: dial tcp: i/o timeout"),
	}
	loop.rebaseOnBase = rebaser.Rebase

	card := &discoverResult{
		CardID:   "card-rebase-fail-not-transient",
		BoardID:  boardID,
		Title:    "rebase fetch timed out mid-rebase",
		PRBranch: "runner/rebase-fail",
		PRURL:    "https://github.com/acme/repo/pull/42",
	}
	llmResult := &llmStageResult{
		reviewResult: &reviewResult{Decision: "approve", Summary: "LGTM"},
		decision:     "approve",
	}

	err := strategy.postActionWithConfig(
		context.Background(), context.Background(),
		loop, card, "exec-rebase-fail-not-transient", repoDir, "",
		llmResult, nil, func() {}, silentLogger(),
	)
	if err != nil {
		t.Fatalf("postActionWithConfig: %v", err)
	}

	// mergeGate: called exactly ONCE — no second attempt after rebase failure.
	mergeMu.Lock()
	if len(merges) != 1 {
		t.Errorf("rebase failure must NOT trigger a second mergeGate call; got %d", len(merges))
	}
	mergeMu.Unlock()

	// Rebase: called exactly ONCE.
	rebaser.mu.Lock()
	if len(rebaser.calls) != 1 {
		t.Errorf("expected exactly 1 rebase attempt, got %d", len(rebaser.calls))
	}
	rebaser.mu.Unlock()

	// Card routed to Blocked (not left in Review as transient path would).
	moveReq := findRequest(reqs, reqsMu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch && strings.Contains(r.Path, "/cards/"+card.CardID+"/move")
	})
	if moveReq == nil {
		t.Fatal("rebase failure must route card to Blocked; got no move request (transient path taken?)")
	}
	if !strings.Contains(moveReq.Body, "col-blocked") {
		t.Errorf("rebase failure must route to Blocked, got move body: %s", moveReq.Body)
	}

	// Merge-blocked note created AND surfaces the rebase error text (not the
	// original base-modified error) so the operator sees what actually went wrong.
	noteReq := findRequest(reqs, reqsMu, func(r recordedRequest) bool {
		return r.Method == http.MethodPost &&
			strings.HasSuffix(r.Path, "/boards/"+card.BoardID+"/notes") &&
			strings.Contains(r.Body, "merge-blocked")
	})
	if noteReq == nil {
		t.Fatal("expected merge-blocked review note on rebase failure")
	}
	if !strings.Contains(noteReq.Body, "i/o timeout") {
		t.Errorf("merge-blocked note must surface the rebase error text, got: %s", noteReq.Body)
	}
}
