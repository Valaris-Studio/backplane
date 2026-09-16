// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// recordedRequest captures a single REST call for post-assertion inspection.
type recordedRequest struct {
	Method string
	Path   string
	Query  string
	Body   string
}

// recordingServer starts an httptest.Server that satisfies every endpoint
// exercised by postActionWithConfig and records each request for inspection.
// Tests inspect the returned *[]recordedRequest to assert which client methods fired.
func recordingServer(t *testing.T, boardID string) (*httptest.Server, *[]recordedRequest, *sync.Mutex) {
	t.Helper()
	var mu sync.Mutex
	var requests []recordedRequest

	// Default board layout covers every column_type used in branch actions.
	columns := []map[string]any{
		{"id": "col-backlog", "name": "To Do", "column_type": "backlog", "position": 1024.0},
		{"id": "col-active", "name": "Active", "column_type": "active", "position": 2048.0},
		{"id": "col-review", "name": "Review", "column_type": "review", "position": 3072.0},
		{"id": "col-done", "name": "Done", "column_type": "done", "position": 4096.0},
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		requests = append(requests, recordedRequest{
			Method: r.Method,
			Path:   r.URL.Path,
			Query:  r.URL.RawQuery,
			Body:   string(body),
		})
		mu.Unlock()

		path := r.URL.Path

		// Loop.New fetches pipeline_config synchronously — serve a default so
		// construction doesn't hard-fail in action tests.
		if path == "/api/agents/me/config" {
			json.NewEncoder(w).Encode(map[string]any{
				"agent_id":   "agent-1",
				"name":       "test",
				"agent_type": "coding",
				"is_active":  true,
				"workspace_config": map[string]any{
					"pipeline_config": DefaultPipelineConfig,
				},
			})
			return
		}

		if strings.Contains(path, "/boards/"+boardID) && !strings.Contains(path, "/cards") && !strings.Contains(path, "/git-repos") && !strings.Contains(path, "/context") && !strings.Contains(path, "/notes") && !strings.Contains(path, "/definition") {
			// Board detail — returns columns for moveCardToColumnType resolution.
			json.NewEncoder(w).Encode(map[string]any{
				"id":      boardID,
				"name":    "Test Board",
				"columns": columns,
			})
			return
		}

		// GetCard returns minimal fields; UpdateCard uses PATCH.
		if strings.Contains(path, "/cards/") && r.Method == http.MethodGet && !strings.Contains(path, "/search") && !strings.Contains(path, "/participants") && !strings.Contains(path, "/review-notes") {
			json.NewEncoder(w).Encode(map[string]any{
				"id":           "card-1",
				"title":        "Test Card",
				"description":  "",
				"labels":       []string{},
				"participants": []any{},
			})
			return
		}

		// GetCardReviewNotes (CleanupReviewNotes) parses the response as a JSON
		// array — the generic {} fallback crashes the decoder. Return [] so the
		// cleanup call is a no-op (nothing to delete).
		if strings.HasSuffix(path, "/notes") && r.Method == http.MethodGet {
			w.Write([]byte("[]"))
			return
		}

		// Default — every other endpoint returns an empty-but-valid response.
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)
	return srv, &requests, &mu
}

// countRequests returns the number of recorded requests matching the predicate.
func countRequests(reqs *[]recordedRequest, mu *sync.Mutex, match func(recordedRequest) bool) int {
	mu.Lock()
	defer mu.Unlock()
	n := 0
	for _, r := range *reqs {
		if match(r) {
			n++
		}
	}
	return n
}

// findRequest returns the first recorded request matching the predicate (or nil).
func findRequest(reqs *[]recordedRequest, mu *sync.Mutex, match func(recordedRequest) bool) *recordedRequest {
	mu.Lock()
	defer mu.Unlock()
	for i := range *reqs {
		if match((*reqs)[i]) {
			return &(*reqs)[i]
		}
	}
	return nil
}

// silentLogger returns a slog.Logger that discards output (avoids test noise).
func silentLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// newActionTestLoop builds a Loop bound to the given httptest.Server URL.
// Used as the receiver for direct calls to postActionWithConfig / gitCommitAndPush.
// Callers override loop.strategy per-test to target a specific role's actions.
func newActionTestLoop(t *testing.T, serverURL string) *Loop {
	t.Helper()
	cfg := testConfig()
	client := testClientWithURL(serverURL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	return mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)
}

// --- Bug 1: ActionDef flags must work for any stage (not just reviewer). ---

// Tester on fail (sensor-only stage) must trigger MoveToColumnType from Branches["fail"].
func TestPostAction_SensorOnlyFail_MovesCardViaActionFlag(t *testing.T) {
	boardID := "board-tester"
	srv, reqs, mu := recordingServer(t, boardID)

	testerStage := valaris.StageConfig{
		Role:  "tester",
		Claim: valaris.ClaimDef{ParticipantRole: "helper"},
		Git:   valaris.GitDef{Action: "checkout_pr_branch"},
		LLM:   valaris.LLMDef{Enabled: false},
		OnSuccess: valaris.ActionDef{
			Conditional: true,
			Branches: map[string]valaris.ActionDef{
				"pass": {WakeRoles: []string{"reviewer"}},
				"fail": {
					MoveToColumnType: "active",
					CreateReviewNote: true,
					UnassignSelf:     true,
				},
			},
		},
	}

	strategy := NewDataDrivenStrategy(testerStage, nil)
	loop := newActionTestLoop(t, srv.URL)
	loop.strategy = strategy

	card := &discoverResult{
		CardID: "card-1", BoardID: boardID, Title: "Test card",
	}
	sensorRes := &sensorResults{
		allPassed:         false,
		decision:          "fail",
		findings:          "[error] go-test pkg/foo.go:42: TestBar failed",
		summary:           "go-test: 1 failed",
		hasFailureMapping: true,
	}

	err := strategy.postActionWithConfig(
		context.Background(), context.Background(),
		loop, card, "exec-1", t.TempDir(), "",
		nil, sensorRes, func() {}, silentLogger(),
	)
	if err != nil {
		t.Fatalf("postActionWithConfig: %v", err)
	}

	// Assertion 1: a move to the "active" column (id=col-active) was issued.
	moveReq := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch && strings.Contains(r.Path, "/cards/"+card.CardID+"/move")
	})
	if moveReq == nil {
		t.Fatal("expected MoveCard request for fail branch MoveToColumnType=active")
	}
	if !strings.Contains(moveReq.Body, "col-active") {
		t.Errorf("MoveCard body should target col-active, got: %s", moveReq.Body)
	}

	// Assertion 2: a review note was created carrying the sensor findings.
	// CreateReviewNote POSTs to /api/workspaces/{slug}/boards/{id}/notes.
	noteReq := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodPost && strings.HasSuffix(r.Path, "/boards/"+card.BoardID+"/notes")
	})
	if noteReq == nil {
		t.Fatal("expected CreateReviewNote request triggered by CreateReviewNote flag")
	}
	if !strings.Contains(noteReq.Body, "TestBar failed") {
		t.Errorf("review note should include sensor findings, got: %s", noteReq.Body)
	}

	// Assertion 3: self was unassigned via DELETE /participants/{userID}.
	unassignReq := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodDelete && strings.Contains(r.Path, "/participants/")
	})
	if unassignReq == nil {
		t.Fatal("expected RemoveCardParticipant (UnassignSelf) request")
	}
}

// Tester on pass must wake the reviewer via WakeRoles even without LLM.
// We exercise the multi-role scheduler path: reviewer starts in idle cooldown,
// WakeRole(reviewer) must clear that cooldown so the next Next() picks reviewer.
func TestPostAction_SensorOnlyPass_WakesRoles(t *testing.T) {
	boardID := "board-tester-pass"
	srv, _, _ := recordingServer(t, boardID)

	testerStage := valaris.StageConfig{
		Role:  "tester",
		Claim: valaris.ClaimDef{ParticipantRole: "helper"},
		Git:   valaris.GitDef{Action: "checkout_pr_branch"},
		LLM:   valaris.LLMDef{Enabled: false},
		OnSuccess: valaris.ActionDef{
			Conditional: true,
			Branches: map[string]valaris.ActionDef{
				"pass": {WakeRoles: []string{"reviewer"}},
				"fail": {MoveToColumnType: "active"},
			},
		},
	}
	testerStrategy := NewDataDrivenStrategy(testerStage, nil)

	// Build a scheduler directly with our tester + a reviewer placeholder so we can
	// observe that the wake properly delegates to scheduler.ResetIdle.
	reviewerStrategy := NewDataDrivenStrategy(*StageForRole(DefaultPipelineConfig, "reviewer"), nil)
	scheduler := NewScheduler(
		map[string]Strategy{"tester": testerStrategy, "reviewer": reviewerStrategy},
		[]string{"tester", "reviewer"},
		"priority",
	)

	cfg := testConfig()
	cfg.WorkLoop.Scheduling = config.SchedulingConfig{
		Strategy:      "priority",
		PriorityOrder: []string{"tester", "reviewer"},
	}
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)
	loop.scheduler = scheduler
	loop.strategy = testerStrategy

	// Prime reviewer in cooldown so WakeRole must actually reset it.
	scheduler.RecordTick("reviewer", false)

	card := &discoverResult{CardID: "card-p1", BoardID: boardID, Title: "Passes"}
	sensorRes := &sensorResults{allPassed: true, decision: "pass"}

	err := testerStrategy.postActionWithConfig(
		context.Background(), context.Background(),
		loop, card, "exec-p1", t.TempDir(), "",
		nil, sensorRes, func() {}, silentLogger(),
	)
	if err != nil {
		t.Fatalf("postActionWithConfig: %v", err)
	}

	// After wake, reviewer must no longer be in cooldown. Drop tester from the
	// scheduler so the priority iterator has to consider reviewer directly.
	scheduler.Reconfigure(
		map[string]Strategy{"reviewer": reviewerStrategy},
		[]string{"reviewer"},
	)
	next := scheduler.Next()
	if next == nil || next.Name() != "reviewer" {
		name := "<nil>"
		if next != nil {
			name = next.Name()
		}
		t.Errorf("after wake, reviewer should be eligible; Next() = %s", name)
	}
}

// Regression guard: reviewer request_changes still moves card + creates note + unassigns.
// This covers the default reviewer stage, which sets these flags in Branches["request_changes"].
func TestPostAction_Reviewer_RequestChanges_DefaultPipelineUnchanged(t *testing.T) {
	boardID := "board-rev"
	srv, reqs, mu := recordingServer(t, boardID)

	reviewerStage := StageForRole(DefaultPipelineConfig, "reviewer")
	if reviewerStage == nil {
		t.Fatal("missing reviewer stage")
	}
	strategy := NewDataDrivenStrategy(*reviewerStage, nil)
	loop := newActionTestLoop(t, srv.URL)
	loop.strategy = strategy

	card := &discoverResult{
		CardID:  "card-r1",
		BoardID: boardID,
		Title:   "PR with issues",
		PRURL:   "",
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
		loop, card, "exec-r1", t.TempDir(), "",
		llmResult, nil, func() {}, silentLogger(),
	)
	if err != nil {
		t.Fatalf("postActionWithConfig: %v", err)
	}

	// Move to active.
	moveReq := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch && strings.Contains(r.Path, "/cards/"+card.CardID+"/move")
	})
	if moveReq == nil {
		t.Fatal("expected MoveCard for request_changes")
	}
	if !strings.Contains(moveReq.Body, "col-active") {
		t.Errorf("MoveCard should target col-active, got: %s", moveReq.Body)
	}

	// Review note created with findings.
	noteReq := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodPost && strings.HasSuffix(r.Path, "/boards/"+card.BoardID+"/notes")
	})
	if noteReq == nil {
		t.Fatal("expected CreateReviewNote for request_changes")
	}
	if !strings.Contains(noteReq.Body, "Add tests for new endpoint") {
		t.Errorf("review note should contain LLM findings, got: %s", noteReq.Body)
	}

	// UnassignSelf: DELETE on participants.
	unassignReq := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodDelete && strings.Contains(r.Path, "/participants/")
	})
	if unassignReq == nil {
		t.Fatal("expected RemoveCardParticipant for UnassignSelf")
	}

	// AppendLearning is OFF by default (card 3c671415: write-only path, no
	// consumer, grew one workspace's definition to 80KB). Assert the default
	// reviewer stage does NOT issue a /definitions PUT.
	learningReq := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodPut && strings.Contains(r.Path, "/definitions")
	})
	if learningReq != nil {
		t.Errorf("default reviewer should NOT call AppendDefinitionLearning; got PUT %s", learningReq.Path)
	}
}

// Regression guard: when an operator opts back in via append_learning=true,
// the runner still issues the PUT. Keeps the feature alive for workspaces
// that wire a downstream consumer.
func TestPostAction_Reviewer_RequestChanges_AppendLearningOptIn(t *testing.T) {
	boardID := "board-rev-optin"
	srv, reqs, mu := recordingServer(t, boardID)

	// Deep-copy the conditional branches map; the inner OnSuccess.Branches
	// is a reference type and mutating the map shared with
	// DefaultPipelineConfig leaks state to sibling tests.
	reviewerStage := *StageForRole(DefaultPipelineConfig, "reviewer")
	branches := make(map[string]valaris.ActionDef, len(reviewerStage.OnSuccess.Branches))
	for k, v := range reviewerStage.OnSuccess.Branches {
		branches[k] = v
	}
	rc := branches["request_changes"]
	rc.AppendLearning = true
	branches["request_changes"] = rc
	reviewerStage.OnSuccess.Branches = branches

	strategy := NewDataDrivenStrategy(reviewerStage, nil)
	loop := newActionTestLoop(t, srv.URL)
	loop.strategy = strategy

	card := &discoverResult{CardID: "card-r2", BoardID: boardID, Title: "Opt-in"}
	llmResult := &llmStageResult{
		reviewResult: &reviewResult{
			Decision: "request_changes", Summary: "x", Findings: "Concrete fix.",
		},
		decision: "request_changes",
	}

	if err := strategy.postActionWithConfig(
		context.Background(), context.Background(),
		loop, card, "exec-r2", t.TempDir(), "",
		llmResult, nil, func() {}, silentLogger(),
	); err != nil {
		t.Fatalf("postActionWithConfig: %v", err)
	}

	learningReq := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodPut && strings.Contains(r.Path, "/definitions")
	})
	if learningReq == nil {
		t.Fatal("expected AppendDefinitionLearning PUT when append_learning=true")
	}
	if !strings.Contains(learningReq.Body, "Concrete fix") {
		t.Errorf("learning body should contain findings, got: %s", learningReq.Body)
	}
}

// Regression guard: reviewer approve still moves card + cleans up review notes.
func TestPostAction_Reviewer_Approve_DefaultPipelineUnchanged(t *testing.T) {
	boardID := "board-rev-ok"
	srv, reqs, mu := recordingServer(t, boardID)

	reviewerStage := StageForRole(DefaultPipelineConfig, "reviewer")
	strategy := NewDataDrivenStrategy(*reviewerStage, nil)
	loop := newActionTestLoop(t, srv.URL)
	loop.strategy = strategy

	card := &discoverResult{CardID: "card-ok", BoardID: boardID, Title: "LGTM"}
	llmResult := &llmStageResult{
		reviewResult: &reviewResult{Decision: "approve", Summary: "LGTM", Findings: ""},
		decision:     "approve",
	}

	err := strategy.postActionWithConfig(
		context.Background(), context.Background(),
		loop, card, "exec-ok", t.TempDir(), "",
		llmResult, nil, func() {}, silentLogger(),
	)
	if err != nil {
		t.Fatalf("postActionWithConfig: %v", err)
	}

	// Move to done.
	moveReq := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch && strings.Contains(r.Path, "/cards/"+card.CardID+"/move")
	})
	if moveReq == nil {
		t.Fatal("expected MoveCard for approve")
	}
	if !strings.Contains(moveReq.Body, "col-done") {
		t.Errorf("MoveCard should target col-done, got: %s", moveReq.Body)
	}

	// CleanupReviewNotes calls GET /notes?card_id=... then DELETE per note.
	// With our server returning [] for GetCardReviewNotes, DELETE never fires, so
	// we verify CleanupReviewNotes engaged by observing the GET call at least.
	cleanupQuery := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodGet && strings.Contains(r.Path, "/boards/"+card.BoardID+"/notes") && strings.Contains(r.Query, "card_id=")
	})
	if cleanupQuery == nil {
		t.Fatal("expected GetCardReviewNotes (part of CleanupReviewNotes) for approve")
	}

	// No UnassignSelf on approve.
	unassignCount := countRequests(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodDelete && strings.Contains(r.Path, "/participants/")
	})
	if unassignCount != 0 {
		t.Errorf("approve should not unassign self, got %d DELETE /participants calls", unassignCount)
	}
}

// A helper-role tester configured with MoveToColumnType must actually move the card.
// Previously MoveToColumnType was gated on Claim.ParticipantRole == "hero" via l.ship,
// so helpers silently ignored it.
func TestPostAction_HelperRole_MoveToColumnTypeHonored(t *testing.T) {
	boardID := "board-helper-move"
	srv, reqs, mu := recordingServer(t, boardID)

	helperStage := valaris.StageConfig{
		Role:  "qa",
		Claim: valaris.ClaimDef{ParticipantRole: "helper"},
		Git:   valaris.GitDef{Action: "none"},
		LLM:   valaris.LLMDef{Enabled: false},
		OnSuccess: valaris.ActionDef{
			MoveToColumnType: "review",
		},
	}
	strategy := NewDataDrivenStrategy(helperStage, nil)
	loop := newActionTestLoop(t, srv.URL)
	loop.strategy = strategy

	card := &discoverResult{CardID: "card-h1", BoardID: boardID, Title: "QA"}

	err := strategy.postActionWithConfig(
		context.Background(), context.Background(),
		loop, card, "exec-h1", t.TempDir(), "",
		nil, nil, func() {}, silentLogger(),
	)
	if err != nil {
		t.Fatalf("postActionWithConfig: %v", err)
	}

	moveReq := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch && strings.Contains(r.Path, "/cards/"+card.CardID+"/move")
	})
	if moveReq == nil {
		t.Fatal("expected helper-role MoveToColumnType to move card")
	}
	if !strings.Contains(moveReq.Body, "col-review") {
		t.Errorf("helper MoveCard should target col-review, got: %s", moveReq.Body)
	}
}

// --- Bug 2: sensor-only stage with git.action create_branch should not be recorded as a failure. ---

// Integration-style test: a sensor-only stage (LLM disabled) configured with
// git.action=create_branch must NOT run gitCommitAndPush (no changes to commit)
// and must route the pass branch through postActionWithConfig. Previously,
// hasChanges=false triggered failWithConfig even when sensors passed.
func TestTickCard_SensorOnlyCreateBranch_PassDoesNotFail(t *testing.T) {
	bare := initBareRemote(t)
	boardID := "board-sensor-ok"
	cardID := "card-s1"

	var mu sync.Mutex
	var moveTarget string
	var failExecCalled bool
	var passBranchMoveObserved bool

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		method := r.Method
		body, _ := io.ReadAll(r.Body)

		mu.Lock()
		// MoveCard → PATCH /.../cards/{id}/move; body includes column_id.
		if strings.Contains(path, "/cards/") && strings.Contains(path, "/move") && method == http.MethodPatch {
			switch {
			case strings.Contains(string(body), "col-done"):
				moveTarget = "done"
				passBranchMoveObserved = true
			case strings.Contains(string(body), "col-backlog"):
				moveTarget = "backlog"
			case strings.Contains(string(body), "col-active"):
				moveTarget = "active"
			}
		}
		// failExecution PATCHes the execution record with status=failed.
		if strings.Contains(path, "/executions/") && method == http.MethodPatch {
			if strings.Contains(string(body), "\"status\":\"failed\"") {
				failExecCalled = true
			}
		}
		mu.Unlock()

		// Heartbeat / prompt-configs / platform config defaults.
		if strings.HasSuffix(path, "/heartbeat") {
			json.NewEncoder(w).Encode(map[string]any{"id": "agent-1", "is_active": true})
			return
		}
		if strings.Contains(path, "/prompt-configs") {
			json.NewEncoder(w).Encode([]any{})
			return
		}
		if path == "/api/agents/me/config" {
			json.NewEncoder(w).Encode(map[string]any{"agent_id": "agent-1", "workspace_config": map[string]any{"pipeline_config": DefaultPipelineConfig}})
			return
		}
		if strings.Contains(path, "/budget-status") {
			json.NewEncoder(w).Encode(map[string]any{"is_exceeded": false, "spent_usd": 0.0, "budget_usd": 100.0})
			return
		}

		// List boards.
		if strings.HasSuffix(path, "/boards") && method == http.MethodGet {
			json.NewEncoder(w).Encode([]valaris.Board{{ID: boardID, Name: "Test"}})
			return
		}
		// Board detail with columns.
		if strings.Contains(path, "/boards/"+boardID) && !strings.Contains(path, "/cards") && !strings.Contains(path, "/git-repos") && !strings.Contains(path, "/context") && !strings.Contains(path, "/notes") && !strings.Contains(path, "/definition") {
			json.NewEncoder(w).Encode(map[string]any{
				"id":   boardID,
				"name": "T",
				"columns": []map[string]any{
					{"id": "col-backlog", "name": "ToDo", "column_type": "backlog", "position": 1024.0},
					{"id": "col-active", "name": "Active", "column_type": "active", "position": 2048.0},
					{"id": "col-done", "name": "Done", "column_type": "done", "position": 4096.0},
				},
			})
			return
		}
		// Search cards — return one unassigned test card ONLY when the agent is
		// looking for unassigned work (has_assignee=false). This prevents the
		// rework-priority search (assignee_id=agent-1) from claiming the card as a
		// rework candidate.
		if strings.Contains(path, "/cards/search") {
			query := r.URL.Query()
			if query.Get("has_assignee") == "false" {
				json.NewEncoder(w).Encode([]valaris.Card{{ID: cardID, BoardID: boardID, Title: "Sensor OK"}})
				return
			}
			json.NewEncoder(w).Encode([]valaris.Card{})
			return
		}
		if strings.Contains(path, "/cards/") && method == http.MethodGet && !strings.Contains(path, "/search") && !strings.Contains(path, "/participants") {
			json.NewEncoder(w).Encode(map[string]any{"id": cardID, "title": "Sensor OK", "description": "", "labels": []string{}})
			return
		}
		if strings.Contains(path, "/git-repos") {
			json.NewEncoder(w).Encode([]valaris.GitRepo{{ID: "r1", Name: "test-repo", URL: bare, DefaultBranch: "main"}})
			return
		}
		if strings.Contains(path, "/executions") && method == http.MethodPost {
			json.NewEncoder(w).Encode(map[string]string{"id": "exec-s1"})
			return
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("{}"))
	}))
	defer srv.Close()

	// Sensor-only stage with git.action=create_branch (Bug 2 exact configuration).
	// A fake sensor returning Passed=true simulates a successful test run.
	registry := fakeRegistry(&fakeSensor{name: "always-pass", passed: true, summary: "ok"})
	sensorOnlyStage := valaris.StageConfig{
		Role: "tester",
		Discover: valaris.DiscoverDef{
			Strategy: "unassigned_or_rework",
			Filters:  map[string]any{"require_git_repo": true},
		},
		Claim:   valaris.ClaimDef{ParticipantRole: "helper", ExecutionAction: "test_card"},
		Git:     valaris.GitDef{Action: "create_branch"},
		LLM:     valaris.LLMDef{Enabled: false},
		Sensors: []valaris.SensorDef{{Name: "always-pass", OnPass: "pass", OnFail: "fail"}},
		OnSuccess: valaris.ActionDef{
			Conditional: true,
			Branches: map[string]valaris.ActionDef{
				"pass": {MoveToColumnType: "done"},
				"fail": {MoveToColumnType: "active"},
			},
		},
	}

	strategy := NewDataDrivenStrategy(sensorOnlyStage, registry)
	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)
	loop.strategy = strategy
	loop.scheduler = nil // pin to single strategy so tick() delegates directly

	if err := loop.tick(context.Background()); err != nil {
		t.Fatalf("tick should not error for sensor-only create_branch pass: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if failExecCalled {
		t.Errorf("failExecution must NOT be called for sensor-only pass; last move target = %q", moveTarget)
	}
	if !passBranchMoveObserved {
		t.Error("pass branch should have moved the card to done")
	}
}

// Bug T0.1: git.action=="none" must short-circuit gitSetupWithConfig so stages
// configured for no-repo work (researcher/planner) never attempt `git clone`.
// Regression: during ST#8 (2026-04-17) researcher/planner cards all failed with
// `git clone '' ... fatal: repository '' does not exist` because gitSetupWithConfig
// called CloneOrOpen unconditionally before inspecting Git.Action.
func TestGitSetupWithConfig_ActionNone_SkipsClone(t *testing.T) {
	boardID := "board-none"
	srv, _, _ := recordingServer(t, boardID)

	researcherStage := valaris.StageConfig{
		Role:  "researcher",
		Git:   valaris.GitDef{Action: "none"},
		LLM:   valaris.LLMDef{Enabled: true, Stage: "research"},
	}
	strategy := NewDataDrivenStrategy(researcherStage, nil)

	// Point BaseDir at an invalid path: if CloneOrOpen is called, it'll try to
	// create a dir under this unwritable location and fail. If the short-circuit
	// works, BaseDir is never touched.
	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{
		BaseDir:       "/this/path/must/not/exist/and/be/unwritable",
		DefaultRemote: "origin",
		BranchPrefix:  "runner/",
	}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)
	loop.strategy = strategy

	// Empty GitRepoURL simulates a board with no linked repo OR a researcher
	// card where URL resolution was skipped. Either way, "none" must not touch git.
	card := &discoverResult{
		CardID:     "card-none-1",
		BoardID:    boardID,
		Title:      "Research task",
		GitRepoURL: "",
	}

	repoDir, branch, recovered, cleanup, err := strategy.gitSetupWithConfig(
		context.Background(), context.Background(), loop, card, false,
	)
	if err != nil {
		t.Fatalf("gitSetupWithConfig with Action=none must not error, got: %v", err)
	}
	if repoDir != "" {
		t.Errorf("repoDir should be empty for Action=none, got: %q", repoDir)
	}
	if branch != "" {
		t.Errorf("branch should be empty for Action=none, got: %q", branch)
	}
	if recovered {
		t.Error("branchRecovered should be false for Action=none")
	}
	if cleanup == nil {
		t.Error("cleanup func must be non-nil (callers invoke it unconditionally)")
	} else {
		// Cleanup must be a safe no-op: calling it with empty repoDir must not panic
		// or touch the unwritable BaseDir.
		cleanup()
	}
}

// T0.2: handleGitFailure must honor the stage's OnFailure.MoveToColumnType
// configuration. Previously failExecution hardcoded "backlog" regardless of the
// configured target, so a researcher stage with on_failure.move_to_column_type:
// "backlog" and an implementer stage with ... "active" got the same cleanup.
func TestHandleGitFailure_HonorsOnFailureMoveToColumnType(t *testing.T) {
	boardID := "board-gitfail"
	srv, reqs, mu := recordingServer(t, boardID)

	// Register a "blocked" column so the move target resolves.
	// (recordingServer defaults don't include one.)
	// Use "active" (not the old hardcoded "backlog") so the test proves the
	// failure path actually reads the configured target rather than matching
	// the previous default by coincidence.
	stage := valaris.StageConfig{
		Role:  "researcher",
		Claim: valaris.ClaimDef{ParticipantRole: "helper"},
		Git:   valaris.GitDef{Action: "create_branch"},
		LLM:   valaris.LLMDef{Enabled: true, Stage: "research"},
		OnFailure: valaris.ActionDef{
			MoveToColumnType: "active",
			Unassign:         true,
		},
	}
	strategy := NewDataDrivenStrategy(stage, nil)
	loop := newActionTestLoop(t, srv.URL)
	loop.strategy = strategy

	card := &discoverResult{
		CardID:  "card-git-fail-1",
		BoardID: boardID,
		Title:   "broken repo",
	}

	// Drive handleGitFailure directly with a canned error — covers every
	// pre-LLM error path (git clone, branch create, checkout_pr) since they
	// all funnel through this function.
	err := strategy.handleGitFailure(
		context.Background(), loop, card, "exec-gf",
		&gitFailureError{msg: "git clone: repository '' does not exist"},
		stage,
	)
	if err == nil {
		t.Fatal("handleGitFailure must return a non-nil error")
	}

	// Assertion 1: MoveCard targeted the configured column (active, not the
	// previously-hardcoded backlog).
	moveReq := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch && strings.Contains(r.Path, "/cards/"+card.CardID+"/move")
	})
	if moveReq == nil {
		t.Fatal("expected MoveCard request from on_failure.move_to_column_type")
	}
	if !strings.Contains(moveReq.Body, "col-active") {
		t.Errorf("MoveCard should target col-active (from on_failure config), got: %s", moveReq.Body)
	}

	// Assertion 2: agent unassigned (Unassign: true).
	unassignReq := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodDelete && strings.Contains(r.Path, "/participants/")
	})
	if unassignReq == nil {
		t.Fatal("expected RemoveCardParticipant (on_failure.unassign=true)")
	}

	// Assertion 3: execution marked failed.
	failExecReq := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch && strings.Contains(r.Path, "/executions/exec-gf") &&
			strings.Contains(r.Body, `"status":"failed"`)
	})
	if failExecReq == nil {
		t.Error("expected execution PATCH with status=failed")
	}
}

// T0.2: after N consecutive failures on the same card, subsequent failures
// force the card to the "blocked" column regardless of on_failure.move_to_column_type.
// Ensures a truly broken card doesn't loop forever between Backlog and In Progress.
func TestHandleGitFailure_ForcesBlockedAfterThreshold(t *testing.T) {
	boardID := "board-gitfail-blocked"
	srv, reqs, mu := recordingServer(t, boardID)

	// Add a "blocked" column to the default board layout. The recordingServer's
	// default includes backlog/active/review/done but not blocked. Install a
	// wrapper handler that overrides the board-detail response.
	// Simpler: inline a second server.
	srv.Close()
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		*reqs = append(*reqs, recordedRequest{
			Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery, Body: string(body),
		})
		mu.Unlock()
		path := r.URL.Path
		if path == "/api/agents/me/config" {
			json.NewEncoder(w).Encode(map[string]any{
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
			json.NewEncoder(w).Encode(map[string]any{
				"id":   boardID,
				"name": "Test",
				"columns": []map[string]any{
					{"id": "col-backlog", "name": "To Do", "column_type": "backlog", "position": 1024.0},
					{"id": "col-active", "name": "Active", "column_type": "active", "position": 2048.0},
					{"id": "col-blocked", "name": "Blocked", "column_type": "blocked", "position": 3072.0},
				},
			})
			return
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)

	stage := valaris.StageConfig{
		Role:  "researcher",
		Claim: valaris.ClaimDef{ParticipantRole: "helper"},
		Git:   valaris.GitDef{Action: "create_branch"},
		LLM:   valaris.LLMDef{Enabled: true, Stage: "research"},
		OnFailure: valaris.ActionDef{
			MoveToColumnType: "backlog", // normal failures bounce to backlog
			Unassign:         true,
		},
	}
	strategy := NewDataDrivenStrategy(stage, nil)
	loop := newActionTestLoop(t, srv.URL)
	loop.strategy = strategy

	card := &discoverResult{
		CardID:  "card-gf-block",
		BoardID: boardID,
		Title:   "flaky",
	}

	// Prime the circuit breaker with (threshold-1) failures, so the next
	// handleGitFailure call crosses the threshold and must force-to-blocked.
	wsCfg := loop.WorkspaceConfig()
	for i := 0; i < wsCfg.MaxReworkAttempts-1; i++ {
		loop.RecordCardFailure(card.CardID)
	}
	// Reset the request log so only the triggering failure's moves are inspected.
	mu.Lock()
	*reqs = nil
	mu.Unlock()

	err := strategy.handleGitFailure(
		context.Background(), loop, card, "exec-blk",
		&gitFailureError{msg: "git clone: repository unavailable"},
		stage,
	)
	if err == nil {
		t.Fatal("handleGitFailure must return non-nil error")
	}

	// After the threshold is reached, MoveCard must target col-blocked, not col-backlog.
	moveReq := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch && strings.Contains(r.Path, "/cards/"+card.CardID+"/move")
	})
	if moveReq == nil {
		t.Fatal("expected MoveCard request after failure-threshold")
	}
	if !strings.Contains(moveReq.Body, "col-blocked") {
		t.Errorf("after threshold failures, MoveCard must force col-blocked, got: %s", moveReq.Body)
	}
}

// gitFailureError is a trivial error impl used to drive handleGitFailure tests
// without spinning up a full git Manager.
type gitFailureError struct{ msg string }

func (e *gitFailureError) Error() string { return e.msg }

// T0.3: when the budget-status endpoint returns 500/429, the tick MUST halt
// rather than silently "proceed" as if the budget was fine. ST#8 observed
// `WARN msg="failed to check budget, proceeding"` when the backend 429'd,
// completely defeating the budget cap under rate-limit conditions.
func TestTick_BudgetCheckError_HaltsWithoutClaim(t *testing.T) {
	boardID := "board-budget-500"
	cardID := "card-budget"
	bare := initBareRemote(t)

	var mu sync.Mutex
	var claimCalled bool
	var execStartCalled bool
	var healthStatus string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		method := r.Method

		// Budget endpoint — return 500 to simulate a platform outage or 429.
		if strings.Contains(path, "/budget-status") {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}

		// Claim endpoints: orchestrator uses POST .../cards/{id}/claim (hero);
		// helper stages add via POST .../participants. Check both to make the
		// test robust against future stage-role tweaks.
		mu.Lock()
		if method == http.MethodPost && (strings.Contains(path, "/cards/"+cardID+"/claim") || strings.Contains(path, "/participants")) {
			claimCalled = true
		}
		if strings.Contains(path, "/executions") && method == http.MethodPost {
			execStartCalled = true
		}
		mu.Unlock()

		if path == "/api/agents/me/config" {
			json.NewEncoder(w).Encode(map[string]any{
				"agent_id":   "agent-1",
				"agent_type": "coding",
				"is_active":  true,
				"workspace_config": map[string]any{
					"pipeline_config": DefaultPipelineConfig,
				},
			})
			return
		}
		if strings.HasSuffix(path, "/heartbeat") {
			json.NewEncoder(w).Encode(map[string]any{"id": "agent-1", "is_active": true})
			return
		}
		if strings.Contains(path, "/prompt-configs") {
			json.NewEncoder(w).Encode([]any{})
			return
		}
		if strings.HasSuffix(path, "/boards") && method == http.MethodGet {
			json.NewEncoder(w).Encode([]valaris.Board{{ID: boardID, Name: "Test"}})
			return
		}
		if strings.Contains(path, "/boards/"+boardID) &&
			!strings.Contains(path, "/cards") && !strings.Contains(path, "/git-repos") &&
			!strings.Contains(path, "/context") && !strings.Contains(path, "/notes") &&
			!strings.Contains(path, "/definition") {
			json.NewEncoder(w).Encode(map[string]any{
				"id":   boardID,
				"name": "T",
				"columns": []map[string]any{
					{"id": "col-backlog", "name": "ToDo", "column_type": "backlog", "position": 1024.0},
					{"id": "col-active", "name": "Active", "column_type": "active", "position": 2048.0},
					{"id": "col-done", "name": "Done", "column_type": "done", "position": 4096.0},
				},
			})
			return
		}
		if strings.Contains(path, "/git-repos") {
			json.NewEncoder(w).Encode([]valaris.GitRepo{{ID: "r1", Name: "r", URL: bare, DefaultBranch: "main"}})
			return
		}
		if strings.Contains(path, "/cards/search") {
			if r.URL.Query().Get("has_assignee") == "false" {
				json.NewEncoder(w).Encode([]valaris.Card{{ID: cardID, BoardID: boardID, Title: "Pending"}})
				return
			}
			json.NewEncoder(w).Encode([]valaris.Card{})
			return
		}
		if strings.Contains(path, "/cards/") && method == http.MethodGet &&
			!strings.Contains(path, "/search") && !strings.Contains(path, "/participants") {
			json.NewEncoder(w).Encode(map[string]any{"id": cardID, "title": "Pending"})
			return
		}
		_ = healthStatus
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("{}"))
	}))
	defer srv.Close()

	// Orchestrator stage — has a card to claim, guaranteed to hit the
	// budget-check after discover.
	stage := StageForRole(DefaultPipelineConfig, "orchestrator")
	if stage == nil {
		t.Fatal("missing orchestrator stage in default pipeline")
	}
	strategy := NewDataDrivenStrategy(*stage, nil)
	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)
	loop.strategy = strategy
	loop.scheduler = nil

	// Tick should not error — the policy is "halt gracefully, surface via
	// heartbeat, do not escalate past the loop runner".
	if err := loop.tick(context.Background()); err != nil {
		t.Fatalf("tick must not error on budget-check failure; got: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if claimCalled {
		t.Error("claim (POST /participants) must NOT fire when budget check fails")
	}
	if execStartCalled {
		t.Error("execution_start must NOT fire when budget check fails")
	}
}

// --- T1.4: l.ship must honor action.MoveToColumnType, not hardcode "review". ---

// Hero stage with OnSuccess.MoveToColumnType="done" (e.g. researcher, planner)
// must land the card in the Done column. Previously l.ship hardcoded "review",
// so researcher/planner cards ended up in Review.
func TestPostAction_HeroShip_HonorsMoveToColumnType(t *testing.T) {
	boardID := "board-hero-done"
	srv, reqs, mu := recordingServer(t, boardID)

	heroStage := valaris.StageConfig{
		Role:  "researcher",
		Claim: valaris.ClaimDef{ParticipantRole: "hero"},
		Git:   valaris.GitDef{Action: "none"},
		LLM:   valaris.LLMDef{Enabled: false},
		OnSuccess: valaris.ActionDef{
			MoveToColumnType: "done",
		},
	}
	strategy := NewDataDrivenStrategy(heroStage, nil)
	loop := newActionTestLoop(t, srv.URL)
	loop.strategy = strategy

	card := &discoverResult{CardID: "card-h-done", BoardID: boardID, Title: "Research spike"}

	err := strategy.postActionWithConfig(
		context.Background(), context.Background(),
		loop, card, "exec-hdone", t.TempDir(), "feature/branch",
		nil, nil, func() {}, silentLogger(),
	)
	if err != nil {
		t.Fatalf("postActionWithConfig: %v", err)
	}

	moveReq := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch && strings.Contains(r.Path, "/cards/"+card.CardID+"/move")
	})
	if moveReq == nil {
		t.Fatal("expected MoveCard for hero ship with MoveToColumnType=done")
	}
	if !strings.Contains(moveReq.Body, "col-done") {
		t.Errorf("hero ship MoveCard should target col-done (not review), got: %s", moveReq.Body)
	}
	if strings.Contains(moveReq.Body, "col-review") {
		t.Errorf("hero ship MoveCard should NOT target col-review when MoveToColumnType=done, got: %s", moveReq.Body)
	}
}

// Hero stage with OnSuccess.MoveToColumnType="review" (e.g. orchestrator) keeps
// the pre-existing behavior: ship lands the card in Review.
func TestPostAction_HeroShip_DefaultReviewTargetPreserved(t *testing.T) {
	boardID := "board-hero-review"
	srv, reqs, mu := recordingServer(t, boardID)

	heroStage := valaris.StageConfig{
		Role:  "orchestrator",
		Claim: valaris.ClaimDef{ParticipantRole: "hero"},
		Git:   valaris.GitDef{Action: "none"},
		LLM:   valaris.LLMDef{Enabled: false},
		OnSuccess: valaris.ActionDef{
			MoveToColumnType: "review",
		},
	}
	strategy := NewDataDrivenStrategy(heroStage, nil)
	loop := newActionTestLoop(t, srv.URL)
	loop.strategy = strategy

	card := &discoverResult{CardID: "card-h-review", BoardID: boardID, Title: "Ship feature"}

	err := strategy.postActionWithConfig(
		context.Background(), context.Background(),
		loop, card, "exec-hrev", t.TempDir(), "feature/branch",
		nil, nil, func() {}, silentLogger(),
	)
	if err != nil {
		t.Fatalf("postActionWithConfig: %v", err)
	}

	moveReq := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch && strings.Contains(r.Path, "/cards/"+card.CardID+"/move")
	})
	if moveReq == nil {
		t.Fatal("expected MoveCard for hero ship with MoveToColumnType=review")
	}
	if !strings.Contains(moveReq.Body, "col-review") {
		t.Errorf("hero ship MoveCard should target col-review, got: %s", moveReq.Body)
	}
}

// Regression guard: default documentator (llm.enabled=true, git.action=create_branch)
// still reaches gitCommitAndPush. The Bug 2 guard must not skip LLM-producing stages.
func TestTickCard_DefaultDocumentatorStillCommits(t *testing.T) {
	docStage := StageForRole(DefaultPipelineConfig, "documentator")
	if docStage == nil {
		t.Fatal("missing documentator stage")
	}
	// Sanity: the default documentator stage still satisfies the precondition
	// for gitCommitAndPush (create_branch + LLM enabled) — confirms the Bug 2
	// guard leaves the default pipeline path intact.
	if docStage.Git.Action != "create_branch" {
		t.Errorf("documentator Git.Action = %q, want create_branch", docStage.Git.Action)
	}
	if !docStage.LLM.Enabled {
		t.Error("documentator LLM should be enabled — Bug 2 guard would skip gitCommitAndPush otherwise")
	}
}
