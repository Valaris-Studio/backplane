// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// recordingServerWithBlocked mirrors recordingServer but surfaces a "blocked"
// column alongside the default four so move_to_column_type="blocked" resolves.
// Returned only from this test file — the production recordingServer's layout
// is kept minimal for the other tests.
func recordingServerWithBlocked(t *testing.T, boardID string) (*httptest.Server, *[]recordedRequest, *sync.Mutex) {
	t.Helper()
	var mu sync.Mutex
	var requests []recordedRequest

	columns := []map[string]any{
		{"id": "col-backlog", "name": "To Do", "column_type": "backlog", "position": 1024.0},
		{"id": "col-active", "name": "Active", "column_type": "active", "position": 2048.0},
		{"id": "col-review", "name": "Review", "column_type": "review", "position": 3072.0},
		{"id": "col-done", "name": "Done", "column_type": "done", "position": 4096.0},
		{"id": "col-blocked", "name": "Blocked", "column_type": "blocked", "position": 5120.0},
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		requests = append(requests, recordedRequest{
			Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery, Body: string(body),
		})
		mu.Unlock()

		path := r.URL.Path

		if path == "/api/agents/me/config" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"agent_id":   "agent-1",
				"is_active":  true,
				"agent_type": "coding",
				"workspace_config": map[string]any{
					"pipeline_config": DefaultPipelineConfig,
				},
			})
			return
		}

		if strings.Contains(path, "/boards/"+boardID) &&
			!strings.Contains(path, "/cards") && !strings.Contains(path, "/git-repos") &&
			!strings.Contains(path, "/context") && !strings.Contains(path, "/notes") &&
			!strings.Contains(path, "/definition") {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":      boardID,
				"name":    "Test Board",
				"columns": columns,
			})
			return
		}

		// GET /notes?card_id=... seeds a pre-existing review note so that if
		// CleanupReviewNotes fires it issues a DELETE we can observe. Without a
		// seeded note the cleanup's GET→DELETE loop is a no-op and silently
		// masks the "cleanup wipes the merge-blocked note" regression.
		if strings.HasSuffix(path, "/notes") && r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`[{"id":"note-preexisting","card_id":"card-approve-fail","decision":"stale","findings":"prior review"}]`))
			return
		}

		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)
	return srv, &requests, &mu
}

// mergeCall captures one invocation of the merge gate.
type mergeCall struct {
	prURL    string
	strategy string
}

// fakeMergeGate returns a merge function that records invocations and returns
// the configured error. Used to avoid shelling out to real `gh` in tests.
func fakeMergeGate(calls *[]mergeCall, mu *sync.Mutex, err error) func(ctx context.Context, repoDir, prURL, strategy string) error {
	return func(_ context.Context, _, prURL, strategy string) error {
		mu.Lock()
		*calls = append(*calls, mergeCall{prURL: prURL, strategy: strategy})
		mu.Unlock()
		return err
	}
}

// --- Core behavior: reviewer approve with a PR must merge before the card moves to Done ---

func TestReviewerApprove_WithPR_MergesBeforeMovingToDone(t *testing.T) {
	boardID := "board-approve-merge"
	srv, reqs, reqsMu := recordingServerWithBlocked(t, boardID)

	reviewerStage := StageForRole(DefaultPipelineConfig, "reviewer")
	if reviewerStage == nil {
		t.Fatal("missing default reviewer stage")
	}
	strategy := NewDataDrivenStrategy(*reviewerStage, nil)

	loop := newActionTestLoop(t, srv.URL)
	loop.strategy = strategy

	var mergeMu sync.Mutex
	var merges []mergeCall
	loop.mergeGate = fakeMergeGate(&merges, &mergeMu, nil) // merge succeeds

	prURL := "https://github.com/org/repo/pull/42"
	card := &discoverResult{
		CardID:  "card-approve-1",
		BoardID: boardID,
		Title:   "LGTM",
		PRURL:   prURL,
	}
	llmResult := &llmStageResult{
		reviewResult: &reviewResult{Decision: "approve", Summary: "LGTM", Findings: ""},
		decision:     "approve",
	}

	err := strategy.postActionWithConfig(
		context.Background(), context.Background(),
		loop, card, "exec-approve-1", t.TempDir(), "",
		llmResult, nil, func() {}, silentLogger(),
	)
	if err != nil {
		t.Fatalf("postActionWithConfig: %v", err)
	}

	// Merge gate must have been invoked once with the card's PR URL.
	mergeMu.Lock()
	defer mergeMu.Unlock()
	if len(merges) != 1 {
		t.Fatalf("expected 1 merge invocation, got %d: %+v", len(merges), merges)
	}
	if merges[0].prURL != prURL {
		t.Errorf("merge called with prURL=%q, want %q", merges[0].prURL, prURL)
	}

	// Card moved to col-done (normal approve flow preserved).
	moveReq := findRequest(reqs, reqsMu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch && strings.Contains(r.Path, "/cards/"+card.CardID+"/move")
	})
	if moveReq == nil {
		t.Fatal("expected MoveCard on successful merge + approve")
	}
	if !strings.Contains(moveReq.Body, "col-done") {
		t.Errorf("MoveCard on merge-success should target col-done, got: %s", moveReq.Body)
	}
	if strings.Contains(moveReq.Body, "col-blocked") {
		t.Errorf("MoveCard must NOT target col-blocked on successful merge: %s", moveReq.Body)
	}
}

func TestReviewerApprove_MergeFails_CardMovesToBlockedWithNote(t *testing.T) {
	boardID := "board-approve-fail"
	srv, reqs, reqsMu := recordingServerWithBlocked(t, boardID)

	reviewerStage := StageForRole(DefaultPipelineConfig, "reviewer")
	strategy := NewDataDrivenStrategy(*reviewerStage, nil)

	loop := newActionTestLoop(t, srv.URL)
	loop.strategy = strategy

	mergeErr := errors.New("merge PR https://github.com/org/repo/pull/42: CI red, required status check failed")
	var mergeMu sync.Mutex
	var merges []mergeCall
	loop.mergeGate = fakeMergeGate(&merges, &mergeMu, mergeErr)

	card := &discoverResult{
		CardID:  "card-approve-fail",
		BoardID: boardID,
		Title:   "LGTM but broken",
		PRURL:   "https://github.com/org/repo/pull/42",
	}
	llmResult := &llmStageResult{
		reviewResult: &reviewResult{Decision: "approve", Summary: "LGTM", Findings: ""},
		decision:     "approve",
	}

	err := strategy.postActionWithConfig(
		context.Background(), context.Background(),
		loop, card, "exec-approve-fail", t.TempDir(), "",
		llmResult, nil, func() {}, silentLogger(),
	)
	if err != nil {
		t.Fatalf("postActionWithConfig: %v", err)
	}

	// Card moved to col-blocked — NOT col-done.
	moveReq := findRequest(reqs, reqsMu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch && strings.Contains(r.Path, "/cards/"+card.CardID+"/move")
	})
	if moveReq == nil {
		t.Fatal("expected MoveCard request when merge fails")
	}
	if !strings.Contains(moveReq.Body, "col-blocked") {
		t.Errorf("merge failure must move card to col-blocked, got: %s", moveReq.Body)
	}
	if strings.Contains(moveReq.Body, "col-done") {
		t.Errorf("merge failure must NOT move card to col-done, got: %s", moveReq.Body)
	}

	// Review note created carrying the merge-blocked reason.
	noteReq := findRequest(reqs, reqsMu, func(r recordedRequest) bool {
		return r.Method == http.MethodPost && strings.HasSuffix(r.Path, "/boards/"+card.BoardID+"/notes")
	})
	if noteReq == nil {
		t.Fatal("expected CreateReviewNote with merge failure reason")
	}
	if !strings.Contains(noteReq.Body, "merge-blocked") {
		t.Errorf("review note decision should be merge-blocked, got body: %s", noteReq.Body)
	}
	if !strings.Contains(noteReq.Body, "CI red") {
		t.Errorf("review note should include the merge error detail, got body: %s", noteReq.Body)
	}

	// Regression guard: the approve-branch carries CleanupReviewNotes=true. After
	// the merge-blocked POST, no DELETE on /notes may fire — otherwise the operator
	// sees a card silently sitting in Blocked with no explanation.
	reqsMu.Lock()
	postIdx := -1
	for i, r := range *reqs {
		if r.Method == http.MethodPost && strings.HasSuffix(r.Path, "/boards/"+card.BoardID+"/notes") {
			postIdx = i
			break
		}
	}
	if postIdx < 0 {
		reqsMu.Unlock()
		t.Fatal("did not find the merge-blocked POST in recorded requests")
	}
	for i := postIdx + 1; i < len(*reqs); i++ {
		r := (*reqs)[i]
		if r.Method == http.MethodDelete && strings.Contains(r.Path, "/notes/") {
			reqsMu.Unlock()
			t.Fatalf("DELETE on /notes after merge-blocked POST wipes the explanation: %s %s", r.Method, r.Path)
		}
		// A cleanup GET /notes?card_id=... issued after the POST is the first step
		// of DeleteCardReviewNotes — even if the seeded note's DELETE subsequently
		// fails, the intent to wipe is itself the bug.
		if r.Method == http.MethodGet && strings.HasSuffix(r.Path, "/notes") && strings.Contains(r.Query, "card_id="+card.CardID) {
			reqsMu.Unlock()
			t.Fatalf("cleanup GET /notes?card_id=... after merge-blocked POST attempts to wipe the explanation: %s %s?%s", r.Method, r.Path, r.Query)
		}
	}
	reqsMu.Unlock()
}

func TestReviewerApprove_NoPRURL_SkipsMergeGate(t *testing.T) {
	boardID := "board-approve-nopr"
	srv, reqs, reqsMu := recordingServerWithBlocked(t, boardID)

	reviewerStage := StageForRole(DefaultPipelineConfig, "reviewer")
	strategy := NewDataDrivenStrategy(*reviewerStage, nil)

	loop := newActionTestLoop(t, srv.URL)
	loop.strategy = strategy

	var mergeMu sync.Mutex
	var merges []mergeCall
	// Inject a gate that would fail if invoked — the card has no PR so the
	// gate must be skipped entirely.
	loop.mergeGate = fakeMergeGate(&merges, &mergeMu, errors.New("should not be called"))

	card := &discoverResult{
		CardID:  "card-approve-nopr",
		BoardID: boardID,
		Title:   "no PR attached",
		PRURL:   "",
	}
	llmResult := &llmStageResult{
		reviewResult: &reviewResult{Decision: "approve", Summary: "LGTM", Findings: ""},
		decision:     "approve",
	}

	err := strategy.postActionWithConfig(
		context.Background(), context.Background(),
		loop, card, "exec-approve-nopr", t.TempDir(), "",
		llmResult, nil, func() {}, silentLogger(),
	)
	if err != nil {
		t.Fatalf("postActionWithConfig: %v", err)
	}

	mergeMu.Lock()
	if len(merges) != 0 {
		t.Errorf("merge gate must not run without a PR URL, got %d calls", len(merges))
	}
	mergeMu.Unlock()

	// Card moves to Done via the normal approve path.
	moveReq := findRequest(reqs, reqsMu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch && strings.Contains(r.Path, "/cards/"+card.CardID+"/move")
	})
	if moveReq == nil {
		t.Fatal("expected MoveCard for approve without PR")
	}
	if !strings.Contains(moveReq.Body, "col-done") {
		t.Errorf("no-PR approve must still reach col-done, got: %s", moveReq.Body)
	}
}

func TestReviewerRequestChanges_MergeGateSkipped(t *testing.T) {
	boardID := "board-reject-nomerge"
	srv, _, _ := recordingServerWithBlocked(t, boardID)

	reviewerStage := StageForRole(DefaultPipelineConfig, "reviewer")
	strategy := NewDataDrivenStrategy(*reviewerStage, nil)

	loop := newActionTestLoop(t, srv.URL)
	loop.strategy = strategy

	var mergeMu sync.Mutex
	var merges []mergeCall
	loop.mergeGate = fakeMergeGate(&merges, &mergeMu, errors.New("must not run"))

	card := &discoverResult{
		CardID:  "card-reject",
		BoardID: boardID,
		Title:   "has a PR but reviewer rejected",
		PRURL:   "https://github.com/org/repo/pull/7",
	}
	llmResult := &llmStageResult{
		reviewResult: &reviewResult{
			Decision: "request_changes",
			Summary:  "Missing tests",
			Findings: "Add tests for new endpoint.",
		},
		decision: "request_changes",
	}

	err := strategy.postActionWithConfig(
		context.Background(), context.Background(),
		loop, card, "exec-reject", t.TempDir(), "",
		llmResult, nil, func() {}, silentLogger(),
	)
	if err != nil {
		t.Fatalf("postActionWithConfig: %v", err)
	}

	mergeMu.Lock()
	defer mergeMu.Unlock()
	if len(merges) != 0 {
		t.Errorf("reviewer request_changes must never invoke merge gate, got %d calls", len(merges))
	}
}

// Transient gh errors (network, rate limit, 5xx) must NOT burn the card to
// Blocked. The reviewer re-runs next tick and the merge retries; only a
// persistent/permanent failure (merge conflict, CI red, branch protection)
// routes to Blocked with an explanation.
func TestReviewerApprove_TransientMergeError_CardStaysInPlace(t *testing.T) {
	boardID := "board-approve-transient"
	srv, reqs, reqsMu := recordingServerWithBlocked(t, boardID)

	reviewerStage := StageForRole(DefaultPipelineConfig, "reviewer")
	strategy := NewDataDrivenStrategy(*reviewerStage, nil)

	loop := newActionTestLoop(t, srv.URL)
	loop.strategy = strategy

	transientErr := errors.New("merge PR https://github.com/org/repo/pull/42: HTTP 503 Service Unavailable")
	var mergeMu sync.Mutex
	var merges []mergeCall
	loop.mergeGate = fakeMergeGate(&merges, &mergeMu, transientErr)

	card := &discoverResult{
		CardID:  "card-approve-transient",
		BoardID: boardID,
		Title:   "transient failure",
		PRURL:   "https://github.com/org/repo/pull/42",
	}
	llmResult := &llmStageResult{
		reviewResult: &reviewResult{Decision: "approve", Summary: "LGTM", Findings: ""},
		decision:     "approve",
	}

	err := strategy.postActionWithConfig(
		context.Background(), context.Background(),
		loop, card, "exec-approve-transient", t.TempDir(), "",
		llmResult, nil, func() {}, silentLogger(),
	)
	if err != nil {
		t.Fatalf("postActionWithConfig: %v", err)
	}

	// No move_card on transient: card must stay in Review for the next tick.
	moveReq := findRequest(reqs, reqsMu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch && strings.Contains(r.Path, "/cards/"+card.CardID+"/move")
	})
	if moveReq != nil {
		t.Errorf("transient merge error must NOT move the card, got: %s %s body=%s", moveReq.Method, moveReq.Path, moveReq.Body)
	}

	// No merge-blocked review note should be posted either — the failure is retryable.
	noteReq := findRequest(reqs, reqsMu, func(r recordedRequest) bool {
		if r.Method != http.MethodPost {
			return false
		}
		if !strings.HasSuffix(r.Path, "/boards/"+card.BoardID+"/notes") {
			return false
		}
		return strings.Contains(r.Body, "merge-blocked")
	})
	if noteReq != nil {
		t.Errorf("transient merge error must NOT create a merge-blocked note, got body: %s", noteReq.Body)
	}
}

// Permanent gh errors (merge conflict, CI red, branch protection) must route
// the card to Blocked with a merge-blocked note — tested separately from the
// transient path because the error-string classifier is the seam.
func TestReviewerApprove_PermanentMergeError_CardRoutesToBlocked(t *testing.T) {
	boardID := "board-approve-permanent"
	srv, reqs, reqsMu := recordingServerWithBlocked(t, boardID)

	reviewerStage := StageForRole(DefaultPipelineConfig, "reviewer")
	strategy := NewDataDrivenStrategy(*reviewerStage, nil)

	loop := newActionTestLoop(t, srv.URL)
	loop.strategy = strategy

	permanentErr := errors.New("merge PR https://github.com/org/repo/pull/42: required status check 'ci' is red")
	var mergeMu sync.Mutex
	var merges []mergeCall
	loop.mergeGate = fakeMergeGate(&merges, &mergeMu, permanentErr)

	card := &discoverResult{
		CardID:  "card-approve-permanent",
		BoardID: boardID,
		Title:   "ci red",
		PRURL:   "https://github.com/org/repo/pull/42",
	}
	llmResult := &llmStageResult{
		reviewResult: &reviewResult{Decision: "approve", Summary: "LGTM", Findings: ""},
		decision:     "approve",
	}

	err := strategy.postActionWithConfig(
		context.Background(), context.Background(),
		loop, card, "exec-approve-permanent", t.TempDir(), "",
		llmResult, nil, func() {}, silentLogger(),
	)
	if err != nil {
		t.Fatalf("postActionWithConfig: %v", err)
	}

	moveReq := findRequest(reqs, reqsMu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch && strings.Contains(r.Path, "/cards/"+card.CardID+"/move")
	})
	if moveReq == nil {
		t.Fatal("permanent merge error must move card to Blocked")
	}
	if !strings.Contains(moveReq.Body, "col-blocked") {
		t.Errorf("permanent merge error must target col-blocked, got: %s", moveReq.Body)
	}

	noteReq := findRequest(reqs, reqsMu, func(r recordedRequest) bool {
		return r.Method == http.MethodPost && strings.HasSuffix(r.Path, "/boards/"+card.BoardID+"/notes")
	})
	if noteReq == nil {
		t.Fatal("permanent merge error must create a merge-blocked note")
	}
	if !strings.Contains(noteReq.Body, "merge-blocked") {
		t.Errorf("note decision should be merge-blocked, got: %s", noteReq.Body)
	}
}

// mergeGate must default to the real git.MergePR when New initializes the Loop
// — no test hook should be required in production, only in tests.
func TestLoopNew_DefaultsMergeGateToGitManagerMergePR(t *testing.T) {
	srv := servePlatformConfig(t)
	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	if loop.mergeGate == nil {
		t.Fatal("Loop.mergeGate must be initialized in New() — production path cannot be nil")
	}
}
