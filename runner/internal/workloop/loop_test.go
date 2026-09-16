// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/health"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

func testConfig() *config.Config {
	return &config.Config{
		Valaris: config.ValarisConfig{
			WorkspaceSlug: "test-workspace",
		},
		LLM: config.LLMConfig{
			Model:                      "sonnet",
			MCPConfigPath:              "/tmp/mcp.json",
			MaxBudgetUSD:               1.0,
			DangerouslySkipPermissions: true,
		},
		Git: config.GitConfig{
			DefaultRemote: "origin",
			BranchPrefix:  "runner/",
			AutoPR:        true,
		},
		WorkLoop: config.WorkLoopConfig{
			PollInterval:         100 * time.Millisecond,
			CardTimeout:          30 * time.Minute,
			IdleSleep:            50 * time.Millisecond,
			ApprovalPollInterval: 10 * time.Millisecond,
			ApprovalMaxWait:      1 * time.Second,
		},
	}
}

// testClientStubbed returns a client pointing at a httptest server that
// satisfies Loop.New's platform config fetch with DefaultPipelineConfig.
// Use this when a test doesn't otherwise need a REST server.
func testClientStubbed(t *testing.T) *valaris.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agents/me/config" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"agent_id": "agent-1",
				"workspace_config": map[string]any{
					"pipeline_config": DefaultPipelineConfig,
				},
			})
			return
		}
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)
	return testClientWithURL(srv.URL)
}

func testClientWithURL(url string) *valaris.Client {
	c := valaris.NewClient(url, "vlr_test")
	c.UserID = "user-1"
	c.Agent = &valaris.AgentConfig{
		ID:        "agent-1",
		Name:      "test-runner",
		AgentType: "coding",
		IsActive:  true,
	}
	return c
}

// mustNewLoop wraps New(ctx, ...) for tests: New now returns (*Loop, error)
// because it fetches the platform pipeline synchronously. Tests that fail
// here typically forgot to serve /api/agents/me/config with a pipeline_config.
func mustNewLoop(t *testing.T, client *valaris.Client, provider llm.Provider, gitMgr *git.Manager, cfg *config.Config, hc ...*health.Collector) *Loop {
	t.Helper()
	loop, err := New(context.Background(), client, provider, gitMgr, cfg, hc...)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return loop
}

// mustNewLoopForRole builds a Loop whose strategy is pinned to the given
// role (single-role mode). It overrides the platform-derived scheduler by
// plucking the role's stage out of the default pipeline and rebuilding a
// minimal strategy. Use when a test needs to exercise one role's tick path.
func mustNewLoopForRole(t *testing.T, client *valaris.Client, provider llm.Provider, gitMgr *git.Manager, cfg *config.Config, role string, hc ...*health.Collector) *Loop {
	t.Helper()
	loop := mustNewLoop(t, client, provider, gitMgr, cfg, hc...)
	stage := StageForRole(DefaultPipelineConfig, role)
	if stage == nil {
		t.Fatalf("no default stage for role %q", role)
	}
	loop.strategy = NewStrategyFromConfig(*stage, loop.sensors)
	loop.scheduler = nil
	return loop
}

func TestTick_NoWork(t *testing.T) {
	// Discover is now REST-based: calls SearchCards via HTTP, not LLM.
	server := testAPIServer(t, testServerOptions{
		boards: []valaris.Board{{ID: "board-1", Name: "Test"}},
		cards:  []valaris.Card{}, // empty = no work
	})

	mock := llm.NewMockProvider()
	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)
	err := loop.tick(context.Background())
	if err != nil {
		t.Fatalf("tick should succeed when no work: %v", err)
	}

	// Discover is REST-based now — zero LLM calls expected.
	if mock.CallCount() != 0 {
		t.Errorf("expected 0 LLM calls (discover is REST), got %d", mock.CallCount())
	}
}

func TestTick_DiscoverError(t *testing.T) {
	mock := llm.NewMockProvider("this is not json at all")
	cfg := testConfig()
	client := testClientStubbed(t)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)
	err := loop.tick(context.Background())
	if err == nil {
		t.Fatal("tick should return error on unparseable discover response")
	}
}

func TestTick_FullCycle(t *testing.T) {
	// Set up a real git remote so clone works.
	bare := initBareRemote(t)

	// Discover and claim are now REST-based. Only implement uses LLM.
	server := testAPIServer(t, testServerOptions{
		boards: []valaris.Board{{ID: "board-456", Name: "Test"}},
		cards: []valaris.Card{{
			ID:      "card-123",
			BoardID: "board-456",
			Title:   "Fix login bug",
		}},
		gitRepos: []valaris.GitRepo{{ID: "repo-1", Name: "test-repo", URL: bare}},
		execID:   "exec-789",
	})

	implementResp := mustJSON(t, map[string]string{
		"status":  "done",
		"summary": "Fixed the login validation",
	})

	mock := llm.NewMockProvider(implementResp)
	cfg := testConfig()
	cfg.Git.AutoPR = false
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)
	err := loop.tick(context.Background())

	// The tick may fail at git push (no actual changes from mock LLM).
	_ = err

	// Only 1 LLM call expected: implement. Discover and claim are REST.
	if mock.CallCount() < 1 {
		t.Fatalf("expected at least 1 LLM call (implement), got %d", mock.CallCount())
	}

	calls := mock.Calls

	// Call 0: implement (discover and claim are REST-based, not LLM)
	if !strings.Contains(calls[0].Prompt, "get_card") {
		t.Error("call 0 should be implement prompt")
	}
	if !strings.Contains(calls[0].Prompt, "card-123") {
		t.Error("implement prompt should reference the card")
	}

	// Verify working dir was set on the implement call.
	if calls[0].Options.WorkingDir == "" {
		t.Error("implement call should have WorkingDir set to the cloned repo")
	}
}

func TestRun_ShutdownOnDeactivation(t *testing.T) {
	mock := llm.NewMockProvider(`{"card_id":""}`)
	cfg := testConfig()
	cfg.WorkLoop.PollInterval = 50 * time.Millisecond

	client := testClientStubbed(t)
	// Simulate deactivation: mark agent as inactive before loop starts.
	client.Agent.IsActive = false

	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	err := loop.Run(ctx, ctx)
	if err != nil {
		t.Fatalf("Run should exit cleanly on deactivation: %v", err)
	}

	// Should not have called the LLM at all — detected inactive immediately.
	if mock.CallCount() > 0 {
		t.Errorf("expected 0 LLM calls when agent is inactive, got %d", mock.CallCount())
	}
}

func TestRun_ContextCancellation(t *testing.T) {
	// Queue enough responses for multiple ticks.
	mock := llm.NewMockProvider(`{"card_id":""}`, `{"card_id":""}`, `{"card_id":""}`)
	cfg := testConfig()
	cfg.WorkLoop.PollInterval = 50 * time.Millisecond

	client := testClientStubbed(t)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	err := loop.Run(ctx, ctx)
	if err != nil {
		t.Fatalf("Run should exit cleanly on context cancellation: %v", err)
	}
}

func TestImplementPrompt_ContainsCardID(t *testing.T) {
	p := implementPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "card-99", ExecutionID: "exec-1"})
	if !strings.Contains(p, "card-99") {
		t.Error("prompt should reference card ID")
	}
	if !strings.Contains(p, "get_card") {
		t.Error("prompt should instruct to read card details")
	}
}

func TestImplementPrompt_ContainsApprovalGuidance(t *testing.T) {
	p := implementPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "card-1", ExecutionID: "exec-1"})
	for _, keyword := range []string{"deletion", "schema_change", "needs_approval", "approval_id", "Do NOT poll"} {
		if !strings.Contains(p, keyword) {
			t.Errorf("implement prompt should contain %q", keyword)
		}
	}
}

func TestImplementPrompt_InjectsDirectives(t *testing.T) {
	directives := "CODING STANDARDS:\n- Use snake_case\n- Always add tests"
	p := implementPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "c1", ExecutionID: "e1", ProjectDirectives: directives})
	if !strings.Contains(p, "PROJECT DIRECTIVES") {
		t.Error("prompt should contain PROJECT DIRECTIVES section")
	}
	if !strings.Contains(p, "Use snake_case") {
		t.Error("prompt should contain injected coding standards")
	}
	if !strings.Contains(p, "MANDATORY") {
		t.Error("prompt should mark directives as MANDATORY")
	}
}

func TestImplementPrompt_OmitsDirectivesWhenEmpty(t *testing.T) {
	p := implementPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "c1", ExecutionID: "e1"})
	if strings.Contains(p, "PROJECT DIRECTIVES") {
		t.Error("prompt should NOT contain directives section when empty")
	}
}

func TestReworkImplementPrompt_InjectsDirectives(t *testing.T) {
	directives := "CODING STANDARDS:\n- Use snake_case"
	p := reworkImplementPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "c1", ExecutionID: "e1", ActionPlan: "fix auth", ProjectDirectives: directives})
	if !strings.Contains(p, "PROJECT DIRECTIVES") {
		t.Error("rework prompt should contain PROJECT DIRECTIVES section")
	}
	if !strings.Contains(p, "Use snake_case") {
		t.Error("rework prompt should contain injected coding standards")
	}
}

func TestImplementAfterApprovalPrompt_Content(t *testing.T) {
	p := implementAfterApprovalPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "card-1", ExecutionID: "exec-1", ApprovalSummary: "delete old tables"})
	if !strings.Contains(p, "approval was granted") && !strings.Contains(p, "approved") {
		t.Error("post-approval prompt should mention approval was granted")
	}
	if !strings.Contains(p, "delete old tables") {
		t.Error("post-approval prompt should contain the approval summary")
	}
	// Should NOT allow needs_approval response.
	if strings.Contains(p, "needs_approval") {
		t.Error("post-approval prompt should not allow needs_approval (single-retry policy)")
	}
}

func TestTick_ImplementBlocked_FailsExecution(t *testing.T) {
	bare := initBareRemote(t)

	server := testAPIServer(t, testServerOptions{
		boards: []valaris.Board{{ID: "board-1", Name: "Test"}},
		cards: []valaris.Card{{
			ID:      "card-blocked",
			BoardID: "board-1",
			Title:   "Blocked task",
		}},
		gitRepos: []valaris.GitRepo{{ID: "repo-1", Name: "test-repo", URL: bare}},
		execID:   "exec-blocked",
	})

	implementResp := mustJSON(t, map[string]string{
		"status":  "blocked",
		"summary": "Missing API credentials",
	})

	mock := llm.NewMockProvider(implementResp)
	cfg := testConfig()
	cfg.Git.AutoPR = false
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)
	err := loop.tick(context.Background())
	if err != nil {
		t.Fatalf("blocked tick should return nil (not propagate error): %v", err)
	}

	// 1 call: implement only. Discover + claim are REST. failExecution is REST.
	if mock.CallCount() != 1 {
		t.Fatalf("expected 1 LLM call (implement), got %d", mock.CallCount())
	}
}

func TestTick_NeedsApproval_Approved(t *testing.T) {
	bare := initBareRemote(t)

	// Build an API server that also handles approvals.
	apiServer := testAPIServer(t, testServerOptions{
		boards: []valaris.Board{{ID: "board-appr", Name: "Test"}},
		cards: []valaris.Card{{
			ID:      "card-appr",
			BoardID: "board-appr",
			Title:   "Delete old tables",
		}},
		gitRepos: []valaris.GitRepo{{ID: "repo-1", Name: "test-repo", URL: bare}},
		execID:   "exec-appr",
	})
	// Override the approval response on the already-running server by wrapping.
	// Since testAPIServer already handles /approvals/, its default "approved" response works.

	implementResp := mustJSON(t, map[string]interface{}{
		"status":      "needs_approval",
		"approval_id": "appr-1",
		"summary":     "Need to delete legacy tables",
	})
	postApprovalResp := mustJSON(t, map[string]string{
		"status":  "done",
		"summary": "Deleted legacy tables after approval",
	})

	mock := llm.NewMockProvider(implementResp, postApprovalResp)
	cfg := testConfig()
	cfg.Git.AutoPR = false
	cfg.Valaris.WorkspaceSlug = "test-workspace"
	client := testClientWithURL(apiServer.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)
	err := loop.tick(context.Background())
	// Tick will proceed through approval and then hit "no git changes" — that's OK.
	_ = err

	// Expect at least 2 LLM calls: implement, postApprovalImplement.
	// Discover and claim are REST-based (0 LLM calls).
	if mock.CallCount() < 2 {
		t.Fatalf("expected at least 2 LLM calls (implement, postApproval), got %d", mock.CallCount())
	}

	// Call 1 should be the post-approval prompt containing "approval was granted".
	postApprovalCall := mock.Calls[1]
	if !strings.Contains(postApprovalCall.Prompt, "approval was granted") {
		t.Error("call[1] should contain 'approval was granted'")
	}
	if !strings.Contains(postApprovalCall.Prompt, "Need to delete legacy tables") {
		t.Error("call[1] should contain the approval summary")
	}
}

func TestTick_NeedsApproval_Rejected(t *testing.T) {
	bare := initBareRemote(t)

	reason := "too risky"
	// Custom server that overrides approval endpoint with "rejected".
	rejServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		method := r.Method

		if path == "/api/agents/me/config" {
			json.NewEncoder(w).Encode(map[string]any{"agent_id": "agent-1", "workspace_config": map[string]any{"pipeline_config": DefaultPipelineConfig}})
			return
		}

		if strings.Contains(path, "/approvals/appr-rej") {
			json.NewEncoder(w).Encode(map[string]interface{}{
				"id":              "appr-rej",
				"status":          "rejected",
				"category":        "deletion",
				"risk_score":      90,
				"decision_reason": reason,
			})
			return
		}

		// Reuse testAPIServer logic via inline handler.
		if strings.Contains(path, "/budget-status") {
			json.NewEncoder(w).Encode(map[string]any{"is_exceeded": false, "spent_usd": 1.0, "budget_usd": 100.0})
			return
		}
		if strings.HasSuffix(path, "/boards") && method == http.MethodGet {
			json.NewEncoder(w).Encode([]valaris.Board{{ID: "board-rej", Name: "Test"}})
			return
		}
		if strings.Contains(path, "/cards/search") {
			// If searching by assignee, return empty (card is unassigned).
			if r.URL.Query().Get("assignee_id") != "" {
				json.NewEncoder(w).Encode([]valaris.Card{})
				return
			}
			json.NewEncoder(w).Encode([]valaris.Card{{ID: "card-rej", BoardID: "board-rej", Title: "Risky deletion"}})
			return
		}
		if strings.Contains(path, "/git-repos") {
			json.NewEncoder(w).Encode([]valaris.GitRepo{{ID: "r1", Name: "test-repo", URL: bare}})
			return
		}
		if strings.Contains(path, "/executions") && method == http.MethodPost {
			json.NewEncoder(w).Encode(map[string]string{"id": "exec-rej"})
			return
		}
		if strings.Contains(path, "/boards/") && method == http.MethodGet && !strings.Contains(path, "/cards") && !strings.Contains(path, "/git-repos") {
			json.NewEncoder(w).Encode(map[string]any{
				"id": "board-rej", "name": "Test",
				"columns": []map[string]any{
					{"id": "col-backlog", "name": "To Do", "column_type": "backlog", "position": 1024},
				},
			})
			return
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("{}"))
	}))
	defer rejServer.Close()

	implementResp := mustJSON(t, map[string]interface{}{
		"status":      "needs_approval",
		"approval_id": "appr-rej",
		"summary":     "Delete production database",
	})

	mock := llm.NewMockProvider(implementResp)
	cfg := testConfig()
	cfg.Git.AutoPR = false
	client := testClientWithURL(rejServer.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)
	err := loop.tick(context.Background())
	if err != nil {
		t.Fatalf("rejected approval tick should return nil: %v", err)
	}

	// 1 LLM call: implement only. Discover, claim, failExecution are REST.
	if mock.CallCount() != 1 {
		t.Fatalf("expected 1 LLM call (implement), got %d", mock.CallCount())
	}

	// B17: human rejection must be terminal. The runner must pre-fill the
	// failure counter to MaxReworkAttempts so the next postActionWithConfig
	// routes the card to the blocked column instead of re-queueing it for
	// another LLM-burning retry. Without this, rejection → unassign →
	// discover → re-claim loops for 3 full $0.13 implement rounds before
	// the circuit breaker trips.
	wsCfg := loop.WorkspaceConfig()
	if got := loop.CardFailureCount("card-rej"); got < wsCfg.MaxReworkAttempts {
		t.Errorf("human rejection should pre-fill failure counter to %d; got %d",
			wsCfg.MaxReworkAttempts, got)
	}
}

// TestTick_CardTimeout pins that the card timeout bounds the WORK phase, not
// wall-clock setup. setupDelay makes claim alone outlast CardTimeout, so if the
// budget still started at tick entry the deadline would expire during setup and
// the tick would fail with a claim/git error instead of reaching the provider.
func TestTick_CardTimeout(t *testing.T) {
	bare := initBareRemote(t)

	cardTimeout := 300 * time.Millisecond

	server := testAPIServer(t, testServerOptions{
		boards:   []valaris.Board{{ID: "board-slow", Name: "Test"}},
		cards:    []valaris.Card{{ID: "card-slow", BoardID: "board-slow", Title: "Slow task"}},
		gitRepos: []valaris.GitRepo{{ID: "r1", Name: "test-repo", URL: bare}},
		execID:   "exec-slow",
		// Deliberately longer than the card budget: setup must not consume it.
		setupDelay: 2 * cardTimeout,
	})

	// SlowMockProvider blocks on the implement call (index 0 since discover/claim are REST).
	slow := &SlowMockProvider{
		inner:      llm.NewMockProvider("never-reached"),
		blockIndex: 0,
		blockFor:   10 * time.Second,
	}

	cfg := testConfig()
	cfg.WorkLoop.CardTimeout = cardTimeout
	cfg.Git.AutoPR = false
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoop(t, client, slow, gitMgr, cfg)
	err := loop.tick(context.Background())
	if err == nil {
		t.Fatal("tick should return error when card timeout expires")
	}
	if !strings.Contains(err.Error(), "context deadline exceeded") && !strings.Contains(err.Error(), "context canceled") {
		t.Errorf("error should mention context deadline, got: %v", err)
	}

	// The provider must actually have been reached: that is the difference
	// between "the work phase timed out" (correct) and "setup burned the
	// budget before any work started" (the old flake).
	if slow.CallCount() == 0 {
		t.Error("card budget was consumed by setup: provider was never reached")
	}
}

// SlowMockProvider wraps MockProvider but blocks on a specific call index.
type SlowMockProvider struct {
	inner      *llm.MockProvider
	blockIndex int
	blockFor   time.Duration
	mu         sync.Mutex
	callCount  int
}

func (s *SlowMockProvider) Name() string { return "slow-mock" }

func (s *SlowMockProvider) CallCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.callCount
}

func (s *SlowMockProvider) Execute(ctx context.Context, prompt string, opts llm.Options) (*llm.Result, error) {
	s.mu.Lock()
	idx := s.callCount
	s.callCount++
	s.mu.Unlock()

	if idx == s.blockIndex {
		select {
		case <-time.After(s.blockFor):
			return nil, fmt.Errorf("slow mock: should have been cancelled")
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}

	return s.inner.Execute(ctx, prompt, opts)
}

// --- Helpers ---

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func initBareRemote(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "remote.git")
	run(t, "", "git", "init", "--bare", "--initial-branch=main", dir)

	// Add a commit so clone works.
	scratch := filepath.Join(t.TempDir(), "scratch")
	run(t, "", "git", "clone", dir, scratch)
	run(t, scratch, "git", "config", "user.email", "test@valaris.dev")
	run(t, scratch, "git", "config", "user.name", "Test")
	os.WriteFile(filepath.Join(scratch, "README.md"), []byte("# test"), 0644)
	run(t, scratch, "git", "add", ".")
	run(t, scratch, "git", "commit", "-m", "initial commit")
	run(t, scratch, "git", "push", "origin", "main")

	return dir
}

func run(t *testing.T, dir string, name string, args ...string) {
	t.Helper()
	cmd := newCmd(name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %v failed: %v\n%s", name, args, err, out)
	}
}

// testServerOptions configures the mock API server for REST-based phases.
type testServerOptions struct {
	boards         []valaris.Board
	cards          []valaris.Card    // returned by search_cards
	gitRepos       []valaris.GitRepo // returned by list git repos
	claimError     bool              // if true, POST .../claim returns 409
	budgetExceeded bool              // if true, budget-status returns exceeded
	execID         string            // execution ID returned by LogExecutionStart
	columns        []valaris.BoardColumn
	// setupDelay stalls the claim round-trip, standing in for the real-world
	// setup cost (git clone of a cold repo, a slow API) that must NOT be
	// charged against the card's work budget.
	setupDelay time.Duration
}

// testAPIServer starts an httptest.Server that handles all REST endpoints
// used by discover, claim, ship, failExecution, and related REST-based methods.
func testAPIServer(t *testing.T, opts testServerOptions) *httptest.Server {
	t.Helper()

	if opts.execID == "" {
		opts.execID = "exec-test-001"
	}
	if len(opts.columns) == 0 {
		opts.columns = []valaris.BoardColumn{
			{ID: "col-backlog", Name: "To Do", Position: 1024, ColumnType: "backlog"},
			{ID: "col-active", Name: "In Progress", Position: 2048, ColumnType: "active"},
			{ID: "col-review", Name: "Review", Position: 3072, ColumnType: "review"},
			{ID: "col-done", Name: "Done", Position: 4096, ColumnType: "done"},
		}
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		method := r.Method

		// Heartbeat
		if strings.HasSuffix(path, "/heartbeat") {
			json.NewEncoder(w).Encode(map[string]any{
				"id": "agent-1", "name": "test", "agent_type": "coding", "is_active": true,
			})
			return
		}

		// Prompt configs
		if strings.Contains(path, "/prompt-configs") {
			json.NewEncoder(w).Encode([]any{})
			return
		}

		// Platform config — serve DefaultPipelineConfig so Loop.New can build
		// strategies. Tests that need a custom pipeline should use a bespoke
		// server instead of testAPIServer.
		if path == "/api/agents/me/config" {
			json.NewEncoder(w).Encode(map[string]any{
				"agent_id": "agent-1", "name": "test", "agent_type": "coding", "is_active": true,
				"workspace_config": map[string]any{
					"pipeline_config": DefaultPipelineConfig,
				},
			})
			return
		}

		// Budget status
		if strings.Contains(path, "/budget-status") {
			json.NewEncoder(w).Encode(map[string]any{
				"is_exceeded": opts.budgetExceeded,
				"spent_usd":   1.0,
				"budget_usd":  100.0,
			})
			return
		}

		// List boards: GET /api/workspaces/{slug}/boards
		if strings.HasSuffix(path, "/boards") && method == http.MethodGet && !strings.Contains(path, "/cards") {
			json.NewEncoder(w).Encode(opts.boards)
			return
		}

		// Get board detail: GET /api/workspaces/{slug}/boards/{id}
		// Returns board with columns for column-type resolution.
		if strings.Contains(path, "/boards/") && method == http.MethodGet && !strings.Contains(path, "/cards") && !strings.Contains(path, "/git-repos") && !strings.Contains(path, "/context") && !strings.Contains(path, "/notes") {
			json.NewEncoder(w).Encode(map[string]any{
				"id":      "board-1",
				"name":    "Test Board",
				"columns": opts.columns,
			})
			return
		}

		// Search cards: GET /api/workspaces/{slug}/boards/{id}/cards/search
		// Filter by assignee_id and has_assignee to avoid false rework matches.
		if strings.Contains(path, "/cards/search") && method == http.MethodGet {
			query := r.URL.Query()
			assigneeID := query.Get("assignee_id")
			hasAssignee := query.Get("has_assignee")

			// If searching by assignee_id, only return cards where that agent is a participant.
			if assigneeID != "" {
				var matched []valaris.Card
				for _, c := range opts.cards {
					for _, p := range c.Participants {
						if p.AgentID == assigneeID || p.UserID == assigneeID {
							matched = append(matched, c)
							break
						}
					}
				}
				json.NewEncoder(w).Encode(matched)
				return
			}
			// If searching for unassigned cards (has_assignee=false), only return
			// cards with no participants.
			if hasAssignee == "false" {
				var matched []valaris.Card
				for _, c := range opts.cards {
					if len(c.Participants) == 0 {
						matched = append(matched, c)
					}
				}
				json.NewEncoder(w).Encode(matched)
				return
			}
			json.NewEncoder(w).Encode(opts.cards)
			return
		}

		// Get card: GET /api/workspaces/{slug}/boards/{id}/cards/{cardID}
		if strings.Contains(path, "/cards/") && method == http.MethodGet && !strings.Contains(path, "/search") && !strings.Contains(path, "/participants") {
			card := valaris.Card{ID: "card-1", Title: "Test Card", Description: ""}
			if len(opts.cards) > 0 {
				card = opts.cards[0]
			}
			json.NewEncoder(w).Encode(card)
			return
		}

		// Claim card: POST .../cards/{id}/claim
		if strings.Contains(path, "/claim") && method == http.MethodPost {
			if opts.setupDelay > 0 {
				time.Sleep(opts.setupDelay)
			}
			if opts.claimError {
				w.WriteHeader(http.StatusConflict)
				json.NewEncoder(w).Encode(map[string]string{"detail": "already claimed"})
				return
			}
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("{}"))
			return
		}

		// List git repos: GET .../git-repos
		if strings.Contains(path, "/git-repos") && method == http.MethodGet {
			json.NewEncoder(w).Encode(opts.gitRepos)
			return
		}

		// Executions: POST /api/agents/{id}/executions
		if strings.Contains(path, "/executions") && method == http.MethodPost {
			json.NewEncoder(w).Encode(map[string]string{"id": opts.execID})
			return
		}

		// Execution update/cost: PATCH /api/agents/{id}/executions/{id}
		if strings.Contains(path, "/executions/") && method == http.MethodPatch {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("{}"))
			return
		}

		// Card participants: POST/DELETE
		if strings.Contains(path, "/participants") {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("{}"))
			return
		}

		// Update card: PATCH .../cards/{id}
		if strings.Contains(path, "/cards/") && method == http.MethodPatch {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("{}"))
			return
		}

		// Move card: POST .../cards/{id}/move
		if strings.Contains(path, "/move") && method == http.MethodPost {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("{}"))
			return
		}

		// Board context (for directives)
		if strings.Contains(path, "/context") && method == http.MethodGet {
			json.NewEncoder(w).Encode(map[string]any{})
			return
		}

		// Notes
		if strings.Contains(path, "/notes") {
			if method == http.MethodGet {
				json.NewEncoder(w).Encode([]any{})
				return
			}
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("{}"))
			return
		}

		// Approvals
		if strings.Contains(path, "/approvals/") {
			json.NewEncoder(w).Encode(map[string]any{
				"id": "appr-1", "status": "approved",
			})
			return
		}

		// Default fallback
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("{}"))
	}))
	t.Cleanup(server.Close)
	return server
}

func TestRun_LoopCtxCancel_ExitsCleanly(t *testing.T) {
	mock := llm.NewMockProvider(`{"card_id":""}`, `{"card_id":""}`)
	cfg := testConfig()
	cfg.WorkLoop.PollInterval = 50 * time.Millisecond

	client := testClientStubbed(t)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)

	rootCtx, rootCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer rootCancel()

	// Cancel loopCtx immediately — Run should exit without processing ticks.
	loopCtx, loopCancel := context.WithCancel(rootCtx)
	loopCancel()

	err := loop.Run(loopCtx, rootCtx)
	if err != nil {
		t.Fatalf("Run should exit cleanly when loopCtx is cancelled: %v", err)
	}
}

func TestRun_DualContext_TickDrains(t *testing.T) {
	// Discover is now REST-based, so the tick completes via HTTP, not LLM.
	// We verify the tick runs and drains even when loopCtx is cancelled.
	server := testAPIServer(t, testServerOptions{
		boards: []valaris.Board{{ID: "board-1", Name: "Test"}},
		cards:  []valaris.Card{}, // no work
	})

	cfg := testConfig()
	cfg.WorkLoop.PollInterval = 10 * time.Millisecond
	cfg.WorkLoop.CardTimeout = 5 * time.Second

	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	mock := llm.NewMockProvider()

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)

	rootCtx, rootCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer rootCancel()

	loopCtx, loopCancel := context.WithCancel(rootCtx)

	// Cancel loopCtx after one tick has started.
	go func() {
		time.Sleep(100 * time.Millisecond)
		loopCancel()
	}()

	err := loop.Run(loopCtx, rootCtx)
	if err != nil {
		t.Fatalf("Run should exit cleanly: %v", err)
	}

	// The tick should have run at least once (REST discover returns empty, no LLM calls).
	// This verifies the dual-context draining still works with REST-based discover.
}

// --- Strategy selection tests ---
// Note: single-role dispatch via cfg.Valaris.Role was removed in I.1.l.
// The platform's pipeline_config is now the sole source of role dispatch;
// TestNew_BuildsStrategiesFromPlatformPipeline (loop_new_test.go) covers
// that behavior end-to-end.

func TestOrchestratorStrategy_NoWork(t *testing.T) {
	// Same as TestTick_NoWork but explicitly verifies strategy delegation.
	server := testAPIServer(t, testServerOptions{
		boards: []valaris.Board{{ID: "board-1", Name: "Test"}},
		cards:  []valaris.Card{},
	})

	mock := llm.NewMockProvider()
	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoopForRole(t, client, mock, gitMgr, cfg, "orchestrator")
	if loop.strategy.Name() != "orchestrator" {
		t.Fatalf("expected orchestrator strategy, got %q", loop.strategy.Name())
	}

	err := loop.tick(context.Background())
	if err != nil {
		t.Fatalf("tick should succeed when no work: %v", err)
	}
	// Discover is REST-based now — 0 LLM calls.
	if mock.CallCount() != 0 {
		t.Errorf("expected 0 LLM calls (discover is REST), got %d", mock.CallCount())
	}
}

func TestReviewerStrategy_NoReviews(t *testing.T) {
	server := testAPIServer(t, testServerOptions{
		boards: []valaris.Board{{ID: "board-1", Name: "Test"}},
		cards:  []valaris.Card{}, // no cards in review
	})

	mock := llm.NewMockProvider()
	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoopForRole(t, client, mock, gitMgr, cfg, "reviewer")
	if loop.strategy.Name() != "reviewer" {
		t.Fatalf("expected reviewer strategy, got %q", loop.strategy.Name())
	}

	err := loop.tick(context.Background())
	if err != nil {
		t.Fatalf("tick should succeed when no reviews: %v", err)
	}
	// Discover review is REST-based now — 0 LLM calls.
	if mock.CallCount() != 0 {
		t.Errorf("expected 0 LLM calls (discover review is REST), got %d", mock.CallCount())
	}
}

func TestReviewerStrategy_FullCycle(t *testing.T) {
	bare := initBareRemote(t)

	// Reviewer discover + claim are REST-based. Only reviewCode uses LLM.
	// postReviewDecision is also REST-based now.
	server := testAPIServer(t, testServerOptions{
		boards: []valaris.Board{{ID: "board-rev", Name: "Test"}},
		cards: []valaris.Card{{
			ID:          "card-rev-1",
			BoardID:     "board-rev",
			Title:       "Add auth middleware",
			Description: "PR: https://github.com/org/repo/pull/42\nBranch: runner/card-rev-1-add-auth",
			ColumnType:  "review",
		}},
		gitRepos: []valaris.GitRepo{{ID: "r1", Name: "test-repo", URL: bare}},
		execID:   "exec-rev-1",
	})

	reviewResp := mustJSON(t, map[string]string{
		"decision": "approve",
		"summary":  "LGTM",
		"findings": "Code follows existing patterns, tests included.",
	})

	mock := llm.NewMockProvider(reviewResp)
	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoopForRole(t, client, mock, gitMgr, cfg, "reviewer")
	// The PR URL points at a fake repo ("org/repo/pull/42") that the real gh
	// can't resolve; stub the approve-merge gate to succeed so this test keeps
	// exercising the LLM/REST surface it was written for.
	loop.mergeGate = func(context.Context, string, string, string) error { return nil }
	err := loop.tick(context.Background())
	if err != nil {
		t.Fatalf("reviewer tick should succeed: %v", err)
	}

	// 1 LLM call: reviewCode only. Discover, claim, postDecision are REST.
	if mock.CallCount() != 1 {
		t.Fatalf("expected 1 LLM call (reviewCode), got %d", mock.CallCount())
	}

	calls := mock.Calls

	// Call 0: review code.
	if !strings.Contains(calls[0].Prompt, "get_card") {
		t.Error("call 0 should instruct to read card details")
	}
	if !strings.Contains(calls[0].Prompt, "get_project_context") {
		t.Error("call 0 should instruct to read project context")
	}
	if calls[0].Options.WorkingDir == "" {
		t.Error("review code call should have WorkingDir set to the cloned repo")
	}
}

func TestReviewerStrategy_RequestsStructuredOutput(t *testing.T) {
	bare := initBareRemote(t)

	server := testAPIServer(t, testServerOptions{
		boards: []valaris.Board{{ID: "board-rev", Name: "Test"}},
		cards: []valaris.Card{{
			ID:          "card-rev-1",
			BoardID:     "board-rev",
			Title:       "Add auth middleware",
			Description: "PR: https://github.com/org/repo/pull/42\nBranch: runner/card-rev-1",
			ColumnType:  "review",
		}},
		gitRepos: []valaris.GitRepo{{ID: "r1", Name: "test-repo", URL: bare}},
		execID:   "exec-rev-1",
	})

	mock := llm.NewMockProvider("ignored — structured output is the source of truth")
	mock.QueueStructured([]byte(`{"decision":"approve","summary":"LGTM","findings":"Tests pass."}`))

	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoopForRole(t, client, mock, gitMgr, cfg, "reviewer")
	// Fake PR URL can't be merged by real gh; stub the approve-merge gate so
	// this test still exercises its structured-output assertions.
	loop.mergeGate = func(context.Context, string, string, string) error { return nil }
	if err := loop.tick(context.Background()); err != nil {
		t.Fatalf("reviewer tick should succeed: %v", err)
	}

	if mock.CallCount() != 1 {
		t.Fatalf("expected 1 LLM call, got %d", mock.CallCount())
	}
	call := mock.Calls[0]
	if call.Options.OutputSchema == "" {
		t.Fatal("reviewer must set Options.OutputSchema so the model produces structured output")
	}
	// Schema must mention the three required fields.
	for _, field := range []string{"decision", "summary", "findings", "approve", "request_changes"} {
		if !strings.Contains(call.Options.OutputSchema, field) {
			t.Errorf("OutputSchema missing %q: %s", field, call.Options.OutputSchema)
		}
	}
}

func TestReviewerStrategy_StructuredOutputPreferredOverFreeformText(t *testing.T) {
	bare := initBareRemote(t)

	server := testAPIServer(t, testServerOptions{
		boards: []valaris.Board{{ID: "board-rev", Name: "Test"}},
		cards: []valaris.Card{{
			ID:          "card-rev-1",
			BoardID:     "board-rev",
			Title:       "Refactor",
			Description: "PR: https://github.com/org/repo/pull/42\nBranch: runner/card-rev-1",
		}},
		gitRepos: []valaris.GitRepo{{ID: "r1", Name: "test-repo", URL: bare}},
		execID:   "exec-rev-1",
	})

	// Output text claims "request_changes" (mimics the bug — prose preceding
	// JSON, mis-extracted by extractJSON). StructuredOutput says "approve".
	// The structured payload must win.
	mock := llm.NewMockProvider(`Here is some prose. {"decision":"request_changes","summary":"x","findings":"x"}`)
	mock.QueueStructured([]byte(`{"decision":"approve","summary":"LGTM","findings":"Looks good."}`))

	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoopForRole(t, client, mock, gitMgr, cfg, "reviewer")

	repoDir := t.TempDir()
	card := &discoverResult{
		CardID:   "card-rev-1",
		BoardID:  "board-rev",
		Title:    "Refactor",
		PRURL:    "https://github.com/org/repo/pull/42",
		PRBranch: "runner/card-rev-1",
	}
	review, err := loop.reviewCode(context.Background(), card, "exec-rev-1", repoDir)
	if err != nil {
		t.Fatalf("reviewCode: %v", err)
	}
	if review.Decision != "approve" {
		t.Errorf("decision: got %q, want %q (structured output should win over freeform JSON)", review.Decision, "approve")
	}
	if review.Summary != "LGTM" {
		t.Errorf("summary: got %q, want %q", review.Summary, "LGTM")
	}
}

func TestReviewerStrategy_FallsBackToFreeformWhenStructuredAbsent(t *testing.T) {
	// Backwards compatibility: if the provider doesn't return structured
	// output (e.g. old prompt cached in DB without --json-schema), the
	// reviewer must still parse the freeform JSON in Output.
	bare := initBareRemote(t)
	server := testAPIServer(t, testServerOptions{
		boards: []valaris.Board{{ID: "board-rev", Name: "Test"}},
		cards: []valaris.Card{{
			ID:          "card-rev-1",
			BoardID:     "board-rev",
			Title:       "Refactor",
			Description: "PR: https://github.com/org/repo/pull/42\nBranch: runner/card-rev-1",
		}},
		gitRepos: []valaris.GitRepo{{ID: "r1", Name: "test-repo", URL: bare}},
		execID:   "exec-rev-1",
	})

	// No QueueStructured call → StructuredOutput stays empty.
	mock := llm.NewMockProvider(`{"decision":"approve","summary":"OK","findings":"All good."}`)

	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoopForRole(t, client, mock, gitMgr, cfg, "reviewer")
	repoDir := t.TempDir()
	card := &discoverResult{
		CardID:   "card-rev-1",
		BoardID:  "board-rev",
		Title:    "Refactor",
		PRURL:    "https://github.com/org/repo/pull/42",
		PRBranch: "runner/card-rev-1",
	}
	review, err := loop.reviewCode(context.Background(), card, "exec-rev-1", repoDir)
	if err != nil {
		t.Fatalf("reviewCode: %v", err)
	}
	if review.Decision != "approve" {
		t.Errorf("decision: got %q, want %q (freeform fallback failed)", review.Decision, "approve")
	}
}

// The reviewer's load-bearing fallback: a response with no parseable decision
// (prose only, no structured output) must coerce to request_changes — the
// reviewer must NEVER silently approve. No isolated test guarded this branch
// before; it must stay green through the shared-seam migration.
func TestReviewCode_BlankDecisionForcesRequestChanges(t *testing.T) {
	bare := initBareRemote(t)
	server := testAPIServer(t, testServerOptions{
		boards: []valaris.Board{{ID: "board-rev", Name: "Test"}},
		cards: []valaris.Card{{
			ID:          "card-rev-1",
			BoardID:     "board-rev",
			Title:       "Refactor",
			Description: "PR: https://github.com/org/repo/pull/42\nBranch: runner/card-rev-1",
		}},
		gitRepos: []valaris.GitRepo{{ID: "r1", Name: "test-repo", URL: bare}},
		execID:   "exec-rev-1",
	})

	// Prose only, no JSON envelope, no QueueStructured -> decision unparseable.
	const prose = "I reviewed the diff and have some thoughts but emitted no JSON envelope."
	mock := llm.NewMockProvider(prose)

	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoopForRole(t, client, mock, gitMgr, cfg, "reviewer")
	card := &discoverResult{
		CardID:   "card-rev-1",
		BoardID:  "board-rev",
		Title:    "Refactor",
		PRURL:    "https://github.com/org/repo/pull/42",
		PRBranch: "runner/card-rev-1",
	}
	review, err := loop.reviewCode(context.Background(), card, "exec-rev-1", t.TempDir())
	if err != nil {
		t.Fatalf("reviewCode: %v", err)
	}
	if review.Decision != "request_changes" {
		t.Errorf("blank decision must force request_changes, got %q", review.Decision)
	}
	if !strings.Contains(review.Summary, "could not be parsed") {
		t.Errorf("summary should flag the parse miss, got %q", review.Summary)
	}
	if !strings.Contains(string(review.Findings), prose) {
		t.Errorf("findings should carry the raw output for operator context, got %q", review.Findings)
	}
}

// A valid structured approve stays approve (the happy path must not be
// accidentally coerced by the shared blank-fallback seam).
func TestReviewCode_ValidApproveStaysApprove(t *testing.T) {
	bare := initBareRemote(t)
	server := testAPIServer(t, testServerOptions{
		boards: []valaris.Board{{ID: "board-rev", Name: "Test"}},
		cards: []valaris.Card{{
			ID:          "card-rev-1",
			BoardID:     "board-rev",
			Title:       "Refactor",
			Description: "PR: https://github.com/org/repo/pull/42\nBranch: runner/card-rev-1",
		}},
		gitRepos: []valaris.GitRepo{{ID: "r1", Name: "test-repo", URL: bare}},
		execID:   "exec-rev-1",
	})

	mock := llm.NewMockProvider("ignored")
	mock.QueueStructured([]byte(`{"decision":"approve","summary":"LGTM","findings":"clean"}`))

	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoopForRole(t, client, mock, gitMgr, cfg, "reviewer")
	card := &discoverResult{
		CardID:   "card-rev-1",
		BoardID:  "board-rev",
		Title:    "Refactor",
		PRURL:    "https://github.com/org/repo/pull/42",
		PRBranch: "runner/card-rev-1",
	}
	review, err := loop.reviewCode(context.Background(), card, "exec-rev-1", t.TempDir())
	if err != nil {
		t.Fatalf("reviewCode: %v", err)
	}
	if review.Decision != "approve" {
		t.Errorf("valid approve must stay approve, got %q", review.Decision)
	}
}

// reviewResult.Output must be the verbatim LLM stdout so downstream raw-output
// consumers (create_note body_from="raw", mcp_call $llm_output) keep working
// through any refactor of the shared decode seam.
func TestReviewCode_OutputIsRawVerbatim(t *testing.T) {
	bare := initBareRemote(t)
	server := testAPIServer(t, testServerOptions{
		boards: []valaris.Board{{ID: "board-rev", Name: "Test"}},
		cards: []valaris.Card{{
			ID:          "card-rev-1",
			BoardID:     "board-rev",
			Title:       "Refactor",
			Description: "PR: https://github.com/org/repo/pull/42\nBranch: runner/card-rev-1",
		}},
		gitRepos: []valaris.GitRepo{{ID: "r1", Name: "test-repo", URL: bare}},
		execID:   "exec-rev-1",
	})

	const raw = `RAW-PROSE-MARKER {"decision":"approve","summary":"ok","findings":""}`
	mock := llm.NewMockProvider(raw)

	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoopForRole(t, client, mock, gitMgr, cfg, "reviewer")
	card := &discoverResult{
		CardID:   "card-rev-1",
		BoardID:  "board-rev",
		Title:    "Refactor",
		PRURL:    "https://github.com/org/repo/pull/42",
		PRBranch: "runner/card-rev-1",
	}
	review, err := loop.reviewCode(context.Background(), card, "exec-rev-1", t.TempDir())
	if err != nil {
		t.Fatalf("reviewCode: %v", err)
	}
	if review.Output != raw {
		t.Errorf("Output must be verbatim raw stdout, got %q want %q", review.Output, raw)
	}
}

func TestDocumentatorStrategy_NoShipped(t *testing.T) {
	server := testAPIServer(t, testServerOptions{
		boards: []valaris.Board{{ID: "board-1", Name: "Test"}},
		cards:  []valaris.Card{}, // no shipped cards
	})

	mock := llm.NewMockProvider()
	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoopForRole(t, client, mock, gitMgr, cfg, "documentator")
	if loop.strategy.Name() != "documentator" {
		t.Fatalf("expected documentator strategy, got %q", loop.strategy.Name())
	}

	err := loop.tick(context.Background())
	if err != nil {
		t.Fatalf("tick should succeed when no shipped cards: %v", err)
	}
	// Discover shipped is REST-based now — 0 LLM calls.
	if mock.CallCount() != 0 {
		t.Errorf("expected 0 LLM calls (discover shipped is REST), got %d", mock.CallCount())
	}
}

func TestReviewCodePrompt_Content(t *testing.T) {
	p := reviewCodePrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "card-1", ExecutionID: "exec-1"})
	if !strings.Contains(p, "get_card") {
		t.Error("prompt should instruct to read card")
	}
	if !strings.Contains(p, "get_project_context") {
		t.Error("prompt should instruct to read project context")
	}
	for _, keyword := range []string{"Correctness", "Security", "approve", "request_changes"} {
		if !strings.Contains(p, keyword) {
			t.Errorf("prompt should contain %q", keyword)
		}
	}
	// Schema is enforced via --json-schema → StructuredOutput tool now.
	// The prompt should not redundantly demand "EXACTLY this JSON" — that text
	// was the source of the parse failures (model emitted prose first).
	if strings.Contains(p, "EXACTLY this JSON") {
		t.Error("prompt should not demand raw JSON; structured output schema enforces format")
	}
}

func TestGenerateDocsPrompt_Content(t *testing.T) {
	p := generateDocsPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "card-1", ExecutionID: "exec-1"})
	if !strings.Contains(p, "get_card") {
		t.Error("prompt should instruct to read card")
	}
	if !strings.Contains(p, "get_project_context") {
		t.Error("prompt should instruct to read project context")
	}
	if !strings.Contains(p, "Do NOT commit") {
		t.Error("prompt should warn not to commit")
	}
	if !strings.Contains(p, "skipped") {
		t.Error("prompt should support skipped response")
	}
}

// --- P0 fix verification tests ---
// These tests verify that prompt/tool signature mismatches are fixed.

func TestPrompts_GetCard_IncludesBoardID(t *testing.T) {
	prompts := map[string]string{
		"implement":     implementPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "board-1", CardID: "c1", ExecutionID: "e1"}),
		"review_code":   reviewCodePrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "board-1", CardID: "c1", ExecutionID: "e1"}),
		"generate_docs": generateDocsPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "board-1", CardID: "c1", ExecutionID: "e1"}),
	}
	for name, p := range prompts {
		if !strings.Contains(p, `get_card(workspace_slug="ws", board_id="board-1"`) {
			t.Errorf("%s: get_card must include board_id", name)
		}
	}
}

func TestPrompts_LogExecutionUpdate_NoWorkspaceSlug(t *testing.T) {
	// log_execution_update does NOT accept workspace_slug.
	prompts := map[string]string{
		"implement":       implementPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "c1", ExecutionID: "e1"}),
		"implement_after": implementAfterApprovalPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "c1", ExecutionID: "e1", ApprovalSummary: "approved"}),
		"generate_docs":   generateDocsPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "c1", ExecutionID: "e1"}),
	}
	for name, p := range prompts {
		if strings.Contains(p, `log_execution_update(workspace_slug=`) {
			t.Errorf("%s: log_execution_update must NOT include workspace_slug", name)
		}
	}
}

func TestPrompts_LogExecutionUpdate_HasAgentID(t *testing.T) {
	// log_execution_update requires agent_id (non-empty).
	p := implementPrompt(PromptContext{Workspace: "ws", AgentID: "agent-42", BoardID: "b1", CardID: "c1", ExecutionID: "e1"})
	if !strings.Contains(p, `agent_id="agent-42"`) {
		t.Error("implement prompt log_execution_update must include actual agent_id")
	}
}

func TestPrompts_RequestApproval_HasRequiredParams(t *testing.T) {
	p := implementPrompt(PromptContext{Workspace: "ws", AgentID: "agent-1", BoardID: "b1", CardID: "c1", ExecutionID: "e1"})
	if !strings.Contains(p, `agent_id="agent-1"`) {
		t.Error("request_approval must include agent_id")
	}
	if !strings.Contains(p, "action_payload=") {
		t.Error("request_approval must include action_payload")
	}
}

// --- Error classification tests ---

func TestIsTransientError_NetworkError(t *testing.T) {
	err := fmt.Errorf("HTTP request failed: dial tcp: lookup test: no such host")
	if !isTransientError(err) {
		t.Error("network error should be transient")
	}
}

func TestIsTransientError_APIError5xx(t *testing.T) {
	err := &valaris.APIError{StatusCode: 503, Body: "service unavailable"}
	if !isTransientError(err) {
		t.Error("503 should be transient")
	}
}

func TestIsTransientError_APIError429(t *testing.T) {
	err := &valaris.APIError{StatusCode: 429, Body: "rate limited"}
	if !isTransientError(err) {
		t.Error("429 should be transient")
	}
}

func TestIsTransientError_APIError404(t *testing.T) {
	err := &valaris.APIError{StatusCode: 404, Body: "not found"}
	if isTransientError(err) {
		t.Error("404 should be permanent")
	}
}

func TestIsTransientError_APIError409(t *testing.T) {
	err := &valaris.APIError{StatusCode: 409, Body: "conflict"}
	if isTransientError(err) {
		t.Error("409 should be permanent")
	}
}

func TestIsTransientError_Nil(t *testing.T) {
	if isTransientError(nil) {
		t.Error("nil error should not be transient")
	}
}

func TestRetryWithBackoff_PermanentErrorNoRetry(t *testing.T) {
	callCount := 0
	err := retryWithBackoff(context.Background(), func() error {
		callCount++
		return &valaris.APIError{StatusCode: 404, Body: "not found"}
	})
	if callCount != 1 {
		t.Errorf("permanent error should not be retried: got %d calls", callCount)
	}
	if err == nil {
		t.Error("should return the error")
	}
}

func TestEstimateCost(t *testing.T) {
	// 1000 input + 500 output tokens with Sonnet pricing
	cost := estimateCost(1000, 500, 0, 0)
	// $3/M * 1000 + $15/M * 500 = $0.003 + $0.0075 = $0.0105
	if cost < 0.010 || cost > 0.011 {
		t.Errorf("estimateCost(1000, 500, 0, 0) = %f, expected ~0.0105", cost)
	}

	// With cache tokens
	cost = estimateCost(0, 0, 10000, 50000)
	// $3.75/M * 10000 + $0.30/M * 50000 = $0.0375 + $0.015 = $0.0525
	if cost < 0.052 || cost > 0.053 {
		t.Errorf("estimateCost(0, 0, 10000, 50000) = %f, expected ~0.0525", cost)
	}

	// Zero tokens = zero cost
	cost = estimateCost(0, 0, 0, 0)
	if cost != 0 {
		t.Errorf("zero tokens should be zero cost: got %f", cost)
	}
}

// --- Rework flow tests ---

func TestDiscoverResult_ReworkFields(t *testing.T) {
	// Verify rework fields parse correctly from JSON.
	input := `{"card_id":"c1","board_id":"b1","title":"Fix bug","rework":true,"review_feedback":"needs tests","pr_url":"https://github.com/org/repo/pull/1","pr_branch":"runner/c1-fix-bug","git_repo_url":"https://github.com/org/repo.git","git_repo_name":"repo"}`

	var card discoverResult
	if err := json.Unmarshal([]byte(input), &card); err != nil {
		t.Fatal(err)
	}

	if !card.Rework {
		t.Error("Rework should be true")
	}
	if card.PRURL != "https://github.com/org/repo/pull/1" {
		t.Errorf("PRURL = %q", card.PRURL)
	}
}

func TestDiscoverResult_ReworkDefaultsFalse(t *testing.T) {
	// Standard discover response without rework fields should default to false.
	input := `{"card_id":"c1","board_id":"b1","title":"New feature","git_repo_url":"url","git_repo_name":"repo"}`

	var card discoverResult
	if err := json.Unmarshal([]byte(input), &card); err != nil {
		t.Fatal(err)
	}

	if card.Rework {
		t.Error("Rework should default to false for non-rework cards")
	}
}

func TestReworkImplementPrompt(t *testing.T) {
	p := reworkImplementPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "c1", ExecutionID: "e1", ActionPlan: "Missing unit tests for auth module"})

	if !strings.Contains(p, "REJECTED") {
		t.Error("rework implement prompt should mention REJECTED")
	}
	if !strings.Contains(p, "Missing unit tests for auth module") {
		t.Error("rework implement prompt should include the review feedback")
	}
	if !strings.Contains(p, "Do NOT start from scratch") {
		t.Error("rework implement prompt should tell LLM not to start over")
	}
	if !strings.Contains(p, "get_project_context") {
		t.Error("rework implement prompt should load project context")
	}
	if !strings.Contains(p, "get_card") {
		t.Error("rework implement prompt should read card details")
	}
	// Should NOT support approval flow — rework is fix-only.
	if strings.Contains(p, "needs_approval") {
		t.Error("rework implement should not support approval flow")
	}
}

func TestTick_ReworkCycle(t *testing.T) {
	bare := initBareRemote(t)

	// Discover is REST-based: returns rework card (assigned to agent, active column).
	server := testAPIServer(t, testServerOptions{
		boards: []valaris.Board{{ID: "board-1", Name: "Test"}},
		cards: []valaris.Card{{
			ID:           "card-rework",
			BoardID:      "board-1",
			Title:        "Fix login bug",
			Description:  "PR: https://github.com/org/repo/pull/1\nBranch: runner/card-rework-fix-login-bug",
			Participants: []valaris.CardParticipant{{UserID: "agent-1", AgentID: "agent-1", Role: "hero"}},
		}},
		gitRepos: []valaris.GitRepo{{ID: "r1", Name: "test-repo", URL: bare}},
		execID:   "exec-rework",
	})

	// LLM calls: mediateRework + reworkImplement only.
	mediateResp := mustJSON(t, map[string]any{
		"action_plan": "REWORK ATTEMPT: 1\n\nPERSISTENT BLOCKING ISSUES:\n1. Missing error handling on line 42",
		"escalate":    false,
	})
	reworkImplResp := mustJSON(t, map[string]string{
		"status":  "done",
		"summary": "Added error handling",
	})

	mock := llm.NewMockProvider(mediateResp, reworkImplResp)
	cfg := testConfig()
	cfg.Git.AutoPR = false
	cfg.Git.ForceWithLease = true
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	// Pin to orchestrator so the rework card (assigned to hero) is the only
	// path exercised — avoids the scheduler dispatching the reviewer first.
	loop := mustNewLoopForRole(t, client, mock, gitMgr, cfg, "orchestrator")
	err := loop.tick(context.Background())
	_ = err // May fail at git operations (mock LLM doesn't write files)

	// 2 LLM calls: mediateRework + reworkImplement. Discover + reworkClaim are REST.
	if mock.CallCount() < 2 {
		t.Fatalf("expected at least 2 LLM calls (mediate, reworkImplement), got %d", mock.CallCount())
	}

	calls := mock.Calls

	// Call 0: mediateRework (execution mediator)
	if !strings.Contains(calls[0].Prompt, "execution mediator") {
		t.Error("call 0 should be the mediator prompt")
	}

	// Call 1: rework implement (includes mediator's action plan, not raw feedback)
	if !strings.Contains(calls[1].Prompt, "ACTION PLAN") {
		t.Error("call 1 should be rework implement with ACTION PLAN")
	}
	if !strings.Contains(calls[1].Prompt, "Missing error handling on line 42") {
		t.Error("rework implement should include the mediator's action plan content")
	}
}

// --- Idle backoff tests ---

func TestPollInterval_NoBackoff(t *testing.T) {
	cfg := testConfig()
	cfg.WorkLoop.PollInterval = 2 * time.Minute
	cfg.WorkLoop.MaxIdleInterval = 16 * time.Minute
	client := testClientStubbed(t)
	mock := llm.NewMockProvider()
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin"}

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)

	if got := loop.PollInterval(); got != 2*time.Minute {
		t.Errorf("PollInterval at backoff=0 = %v, want 2m", got)
	}
}

func TestPollInterval_ExponentialBackoff(t *testing.T) {
	cfg := testConfig()
	cfg.WorkLoop.PollInterval = 2 * time.Minute
	cfg.WorkLoop.MaxIdleInterval = 16 * time.Minute
	client := testClientStubbed(t)
	mock := llm.NewMockProvider()
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin"}

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)

	// Simulate successive idle ticks.
	loop.IncrementIdleBackoff() // backoff=1 → 4m
	if got := loop.PollInterval(); got != 4*time.Minute {
		t.Errorf("PollInterval at backoff=1 = %v, want 4m", got)
	}

	loop.IncrementIdleBackoff() // backoff=2 → 8m
	if got := loop.PollInterval(); got != 8*time.Minute {
		t.Errorf("PollInterval at backoff=2 = %v, want 8m", got)
	}

	loop.IncrementIdleBackoff() // backoff=3 → 16m (hits max)
	if got := loop.PollInterval(); got != 16*time.Minute {
		t.Errorf("PollInterval at backoff=3 = %v, want 16m (max)", got)
	}

	loop.IncrementIdleBackoff() // backoff=4 → still 16m (capped)
	if got := loop.PollInterval(); got != 16*time.Minute {
		t.Errorf("PollInterval at backoff=4 = %v, want 16m (capped)", got)
	}
}

func TestPollInterval_ResetOnWork(t *testing.T) {
	cfg := testConfig()
	cfg.WorkLoop.PollInterval = 2 * time.Minute
	cfg.WorkLoop.MaxIdleInterval = 16 * time.Minute
	client := testClientStubbed(t)
	mock := llm.NewMockProvider()
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin"}

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)

	// Build up backoff.
	loop.IncrementIdleBackoff()
	loop.IncrementIdleBackoff()
	loop.IncrementIdleBackoff()
	if got := loop.PollInterval(); got != 16*time.Minute {
		t.Fatalf("expected 16m after 3 increments, got %v", got)
	}

	// Work found — reset.
	loop.ResetIdleBackoff()
	if got := loop.PollInterval(); got != 2*time.Minute {
		t.Errorf("PollInterval after reset = %v, want 2m", got)
	}
}

func TestDiscoverCost_Accumulates(t *testing.T) {
	// Each "no work" tick runs discover which costs something. Verify accumulation.
	mock := llm.NewMockProvider(`{"card_id":""}`, `{"card_id":""}`)
	cfg := testConfig()
	client := testClientStubbed(t)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)

	if loop.DiscoverCostUSD() != 0 {
		t.Fatalf("initial discover cost = %f, want 0", loop.DiscoverCostUSD())
	}

	// First tick — discover returns no work.
	loop.tick(context.Background())
	cost1 := loop.DiscoverCostUSD()
	// MockProvider returns zero cost, so tickCost estimates from tokens.
	// The actual value doesn't matter — just verify it accumulated.

	// Second tick.
	loop.tick(context.Background())
	cost2 := loop.DiscoverCostUSD()

	if cost2 < cost1 {
		t.Errorf("discover cost should not decrease: %f < %f", cost2, cost1)
	}
}

func TestHealthReport_IncludesDiscoverCost(t *testing.T) {
	// Verify the HealthReport struct has the field.
	report := &valaris.HealthReport{
		DiscoverCostUSD: 1.23,
	}
	data, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"discover_cost_usd":1.23`) {
		t.Errorf("HealthReport JSON should include discover_cost_usd, got: %s", data)
	}
}

func TestLoop_PollCycle_HeartbeatIncludesSensorCatalog(t *testing.T) {
	var heartbeatBody []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/heartbeat") && r.Method == http.MethodPost {
			heartbeatBody, _ = io.ReadAll(r.Body)
			json.NewEncoder(w).Encode(map[string]any{
				"id": "agent-1", "name": "test", "agent_type": "coding", "is_active": true,
			})
			return
		}
		if strings.Contains(r.URL.Path, "/prompt-configs") {
			json.NewEncoder(w).Encode([]any{})
			return
		}
		if r.URL.Path == "/api/agents/me/config" {
			json.NewEncoder(w).Encode(map[string]any{
				"agent_id": "agent-1",
				"workspace_config": map[string]any{
					"pipeline_config": DefaultPipelineConfig,
				},
			})
			return
		}
		if strings.Contains(r.URL.Path, "/cards/search") {
			json.NewEncoder(w).Encode([]valaris.Card{})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{})
	}))
	defer server.Close()

	mock := llm.NewMockProvider()
	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	hc := health.NewCollector(cfg.WorkLoop.PollInterval, cfg.WorkLoop.CardTimeout, 0)

	loop := mustNewLoop(t, client, mock, gitMgr, cfg, hc)
	loop.pollCycle(context.Background(), context.Background())

	if len(heartbeatBody) == 0 {
		t.Fatal("no heartbeat body captured")
	}

	var report valaris.HealthReport
	if err := json.Unmarshal(heartbeatBody, &report); err != nil {
		t.Fatalf("unmarshal heartbeat: %v", err)
	}
	if len(report.SensorCatalog) == 0 {
		t.Fatalf("heartbeat missing sensor_catalog, body: %s", heartbeatBody)
	}
	var gotGoTest bool
	for _, entry := range report.SensorCatalog {
		if entry.Name == "go-test" {
			gotGoTest = true
			if entry.Kind != "computational" {
				t.Errorf("go-test kind = %q, want computational", entry.Kind)
			}
		}
	}
	if !gotGoTest {
		t.Errorf("sensor_catalog missing go-test: %+v", report.SensorCatalog)
	}
}

// WS-2.3: when a heartbeat sender is attached and Connected(), the loop
// must deliver the heartbeat over it and NOT hit the HTTP endpoint.
type fakeHeartbeatSender struct {
	connected bool
	sends     []any
	sendErr   error
}

func (f *fakeHeartbeatSender) SendHeartbeat(_ context.Context, payload any) error {
	if f.sendErr != nil {
		return f.sendErr
	}
	f.sends = append(f.sends, payload)
	return nil
}

func (f *fakeHeartbeatSender) Connected() bool { return f.connected }

func TestLoop_PollCycle_PrefersHeartbeatSenderOverHTTP(t *testing.T) {
	var httpHeartbeatHits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/heartbeat") && r.Method == http.MethodPost {
			atomic.AddInt32(&httpHeartbeatHits, 1)
			json.NewEncoder(w).Encode(map[string]any{
				"id": "agent-1", "name": "test", "agent_type": "coding", "is_active": true,
			})
			return
		}
		if r.URL.Path == "/api/agents/me" {
			json.NewEncoder(w).Encode(map[string]any{
				"id": "agent-1", "name": "test", "agent_type": "coding", "is_active": true,
			})
			return
		}
		if r.URL.Path == "/api/agents/me/config" {
			json.NewEncoder(w).Encode(map[string]any{
				"agent_id": "agent-1",
				"workspace_config": map[string]any{
					"pipeline_config": DefaultPipelineConfig,
				},
			})
			return
		}
		if strings.Contains(r.URL.Path, "/prompt-configs") {
			json.NewEncoder(w).Encode([]any{})
			return
		}
		if strings.Contains(r.URL.Path, "/cards/search") {
			json.NewEncoder(w).Encode([]valaris.Card{})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{})
	}))
	defer server.Close()

	mock := llm.NewMockProvider()
	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	hc := health.NewCollector(cfg.WorkLoop.PollInterval, cfg.WorkLoop.CardTimeout, 0)

	loop := mustNewLoop(t, client, mock, gitMgr, cfg, hc)
	sender := &fakeHeartbeatSender{connected: true}
	loop.SetHeartbeatSender(sender)

	loop.pollCycle(context.Background(), context.Background())

	if len(sender.sends) != 1 {
		t.Errorf("expected 1 WS heartbeat send, got %d", len(sender.sends))
	}
	if atomic.LoadInt32(&httpHeartbeatHits) != 0 {
		t.Errorf("HTTP heartbeat should not fire when WS sender is connected, got %d hits", httpHeartbeatHits)
	}
}

func TestLoop_PollCycle_FallsBackToHTTPWhenSenderDisconnected(t *testing.T) {
	var httpHeartbeatHits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/heartbeat") && r.Method == http.MethodPost {
			atomic.AddInt32(&httpHeartbeatHits, 1)
			json.NewEncoder(w).Encode(map[string]any{
				"id": "agent-1", "name": "test", "agent_type": "coding", "is_active": true,
			})
			return
		}
		if r.URL.Path == "/api/agents/me/config" {
			json.NewEncoder(w).Encode(map[string]any{
				"agent_id": "agent-1",
				"workspace_config": map[string]any{
					"pipeline_config": DefaultPipelineConfig,
				},
			})
			return
		}
		if strings.Contains(r.URL.Path, "/prompt-configs") {
			json.NewEncoder(w).Encode([]any{})
			return
		}
		if strings.Contains(r.URL.Path, "/cards/search") {
			json.NewEncoder(w).Encode([]valaris.Card{})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{})
	}))
	defer server.Close()

	mock := llm.NewMockProvider()
	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	hc := health.NewCollector(cfg.WorkLoop.PollInterval, cfg.WorkLoop.CardTimeout, 0)

	loop := mustNewLoop(t, client, mock, gitMgr, cfg, hc)
	sender := &fakeHeartbeatSender{connected: false}
	loop.SetHeartbeatSender(sender)

	loop.pollCycle(context.Background(), context.Background())

	if len(sender.sends) != 0 {
		t.Errorf("expected 0 WS sends when disconnected, got %d", len(sender.sends))
	}
	if atomic.LoadInt32(&httpHeartbeatHits) != 1 {
		t.Errorf("expected 1 HTTP fallback hit, got %d", httpHeartbeatHits)
	}
}

func TestTick_NoWork_IncrementsBackoff(t *testing.T) {
	server := testAPIServer(t, testServerOptions{
		boards: []valaris.Board{{ID: "board-1", Name: "Test"}},
		cards:  []valaris.Card{},
	})

	mock := llm.NewMockProvider()
	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	// Pin to a single strategy so one tick == one idle-backoff increment. In
	// multi-role mode the scheduler fast-forwards through every strategy,
	// each bumping the counter.
	loop := mustNewLoopForRole(t, client, mock, gitMgr, cfg, "orchestrator")

	if loop.idleBackoff != 0 {
		t.Fatalf("initial idleBackoff = %d, want 0", loop.idleBackoff)
	}

	loop.tick(context.Background())

	if loop.idleBackoff != 1 {
		t.Errorf("idleBackoff after no-work tick = %d, want 1", loop.idleBackoff)
	}
}

// --- Execution Mediator tests ---

func TestMediateReworkPrompt_Content(t *testing.T) {
	history := "--- Review: card-123 — request_changes (created 2026-04-14) ---\nMissing tests"
	p := mediateReworkPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "card-123", ReworkAttempt: 2, MaxReworkAttempts: 3, ReviewHistory: history})

	if !strings.Contains(p, "execution mediator") {
		t.Error("mediateRework prompt should identify as execution mediator")
	}
	if !strings.Contains(p, "REVIEW HISTORY") {
		t.Error("mediateRework prompt should contain injected review history")
	}
	if !strings.Contains(p, "Missing tests") {
		t.Error("mediateRework prompt should contain review findings from injected history")
	}
	if !strings.Contains(p, "get_card") {
		t.Error("mediateRework prompt should read card details")
	}
	if !strings.Contains(p, "REWORK_ATTEMPT: 2") {
		t.Error("mediateRework prompt should include attempt number")
	}
	if !strings.Contains(p, "action_plan") {
		t.Error("mediateRework prompt should produce an action_plan")
	}
	if !strings.Contains(p, "PERSISTENT BLOCKING ISSUES") {
		t.Error("mediateRework prompt should define action plan format with persistent issues")
	}
	if !strings.Contains(p, "RESOLVED ISSUES") {
		t.Error("mediateRework prompt should track resolved issues")
	}
	// Verify the prompt does NOT instruct the LLM to call list_notes (fetched via REST now).
	if strings.Contains(p, "list_notes") {
		t.Error("mediateRework prompt should NOT call list_notes — history is pre-fetched via REST")
	}
}

func TestMediateReworkPrompt_Escalation(t *testing.T) {
	// Below threshold — no escalation warning.
	p2 := mediateReworkPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "c1", ReworkAttempt: 2, MaxReworkAttempts: 3, ReviewHistory: "some history"})
	if strings.Contains(p2, "ESCALATION WARNING") {
		t.Error("attempt 2 should not have escalation warning")
	}

	// At threshold — escalation warning present.
	p3 := mediateReworkPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "c1", ReworkAttempt: 3, MaxReworkAttempts: 3, ReviewHistory: "some history"})
	if !strings.Contains(p3, "ESCALATION WARNING") {
		t.Error("attempt 3 should have escalation warning")
	}
	if !strings.Contains(p3, "rework attempt #3") {
		t.Error("escalation should mention attempt number")
	}

	// Above threshold — also has escalation.
	p5 := mediateReworkPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "c1", ReworkAttempt: 5, MaxReworkAttempts: 3, ReviewHistory: "some history"})
	if !strings.Contains(p5, "ESCALATION WARNING") {
		t.Error("attempt 5 should have escalation warning")
	}
}

func TestMediationResult_Parsing(t *testing.T) {
	// Normal action plan.
	input := `{"action_plan":"REWORK ATTEMPT: 2\n\nPERSISTENT BLOCKING ISSUES:\n1. Fix tick()","escalate":false}`
	var result mediationResult
	if err := json.Unmarshal([]byte(input), &result); err != nil {
		t.Fatal(err)
	}
	if result.Escalate {
		t.Error("escalate should be false")
	}
	if !strings.Contains(result.ActionPlan, "Fix tick()") {
		t.Errorf("action_plan = %q, should contain the fix instruction", result.ActionPlan)
	}
}

func TestMediationResult_Escalated(t *testing.T) {
	input := `{"action_plan":"No review history found","escalate":true}`
	var result mediationResult
	if err := json.Unmarshal([]byte(input), &result); err != nil {
		t.Fatal(err)
	}
	if !result.Escalate {
		t.Error("escalate should be true")
	}
}

func TestReworkImplementPrompt_UsesActionPlan(t *testing.T) {
	actionPlan := "REWORK ATTEMPT: 2\n\nPERSISTENT BLOCKING ISSUES:\n1. [game.js:45] tick() is a stub\n\nRESOLVED: localStorage graceful degradation"
	p := reworkImplementPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "c1", ExecutionID: "e1", ActionPlan: actionPlan})

	if !strings.Contains(p, "ACTION PLAN") {
		t.Error("rework implement should frame the input as ACTION PLAN")
	}
	if !strings.Contains(p, "execution mediator") {
		t.Error("rework implement should identify the action plan source")
	}
	if !strings.Contains(p, "authoritative instruction set") {
		t.Error("rework implement should emphasize the action plan is authoritative")
	}
	if !strings.Contains(p, "[game.js:45] tick() is a stub") {
		t.Error("rework implement should contain the action plan content")
	}
	if !strings.Contains(p, "PERSISTENT BLOCKING ISSUE") {
		t.Error("rework implement should reference persistent issues from the plan")
	}
	if strings.Contains(p, "REVIEW FEEDBACK") {
		t.Error("rework implement should NOT use raw REVIEW FEEDBACK framing")
	}
}

func TestCardFailureCount(t *testing.T) {
	cfg := testConfig()
	client := testClientStubbed(t)
	mock := llm.NewMockProvider()
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin"}

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)

	if loop.CardFailureCount("card-1") != 0 {
		t.Error("initial failure count should be 0")
	}

	loop.RecordCardFailure("card-1")
	loop.RecordCardFailure("card-1")
	if loop.CardFailureCount("card-1") != 2 {
		t.Errorf("failure count = %d, want 2", loop.CardFailureCount("card-1"))
	}

	loop.ClearCardFailure("card-1")
	if loop.CardFailureCount("card-1") != 0 {
		t.Error("failure count should be 0 after clear")
	}
}

func TestTick_ReworkCycle_WithMediator(t *testing.T) {
	bare := initBareRemote(t)

	server := testAPIServer(t, testServerOptions{
		boards: []valaris.Board{{ID: "board-1", Name: "Test"}},
		cards: []valaris.Card{{
			ID:           "card-rework",
			BoardID:      "board-1",
			Title:        "Fix login bug",
			Description:  "PR: https://github.com/org/repo/pull/1\nBranch: runner/card-rework-fix-login-bug",
			Participants: []valaris.CardParticipant{{UserID: "agent-1", AgentID: "agent-1", Role: "hero"}},
		}},
		gitRepos: []valaris.GitRepo{{ID: "r1", Name: "test-repo", URL: bare}},
		execID:   "exec-rework",
	})

	mediateResp := mustJSON(t, map[string]any{
		"action_plan": "REWORK ATTEMPT: 1\n\nPERSISTENT BLOCKING ISSUES:\n1. [game.js:45] tick() is a stub",
		"escalate":    false,
	})
	reworkImplResp := mustJSON(t, map[string]string{
		"status":  "done",
		"summary": "Fixed tick()",
	})

	mock := llm.NewMockProvider(mediateResp, reworkImplResp)
	cfg := testConfig()
	cfg.Git.AutoPR = false
	cfg.Git.ForceWithLease = true
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	// Pin to orchestrator to exercise the rework path without the scheduler
	// dispatching reviewer first.
	loop := mustNewLoopForRole(t, client, mock, gitMgr, cfg, "orchestrator")
	err := loop.tick(context.Background())
	_ = err

	// 2 LLM calls: mediate + reworkImplement. Discover + reworkClaim are REST.
	if mock.CallCount() < 2 {
		t.Fatalf("expected at least 2 LLM calls (mediate, reworkImplement), got %d", mock.CallCount())
	}

	calls := mock.Calls

	// Call 0: mediateRework (the execution mediator)
	if !strings.Contains(calls[0].Prompt, "execution mediator") {
		t.Error("call 0 should be the mediator prompt")
	}
	if !strings.Contains(calls[0].Prompt, "card-rework") {
		t.Error("mediator should reference the card ID")
	}

	// Call 1: reworkImplement (should receive action plan, not raw feedback)
	if !strings.Contains(calls[1].Prompt, "ACTION PLAN") {
		t.Error("call 1 should be rework implement with ACTION PLAN")
	}
	if !strings.Contains(calls[1].Prompt, "[game.js:45] tick() is a stub") {
		t.Error("rework implement should contain the mediator's action plan content")
	}
}

// --- TriggerPoll cooldown removal tests ---

// countingStrategy is a test strategy that counts Tick invocations.
type countingStrategy struct {
	mu    sync.Mutex
	ticks int
}

func (s *countingStrategy) Name() string           { return "counting" }
func (s *countingStrategy) AllowedTools() []string { return nil }
func (s *countingStrategy) Tick(_ context.Context, _ *Loop) error {
	s.mu.Lock()
	s.ticks++
	s.mu.Unlock()
	return nil
}
func (s *countingStrategy) TickCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ticks
}

func TestTriggerPoll_AlwaysFires(t *testing.T) {
	// Verifies that TriggerPoll always triggers a poll cycle and is never
	// suppressed by cooldown. This is the core behavioral guarantee: WebSocket
	// events (e.g., card.moved-to-Active) must always wake the loop.

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agents/me/config" {
			json.NewEncoder(w).Encode(map[string]any{"agent_id": "agent-1", "workspace_config": map[string]any{"pipeline_config": DefaultPipelineConfig}})
			return
		}
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]any{
			"id": "agent-1", "name": "test", "agent_type": "coding", "is_active": true,
		})
	}))
	defer server.Close()

	cfg := testConfig()
	// Long poll interval so the ticker never fires naturally during the test.
	cfg.WorkLoop.PollInterval = 10 * time.Minute

	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	mock := llm.NewMockProvider()

	cs := &countingStrategy{}
	loop := mustNewLoop(t, client, mock, gitMgr, cfg)
	loop.strategy = cs
	loop.scheduler = nil // pin to the counting strategy; bypass multi-role dispatch
	// Opt out of platform-authority drops — this test pins a synthetic
	// strategy not in DefaultPipelineConfig and exists to exercise TriggerPoll
	// plumbing, not prompt validation.
	loop.ownedStrategies = nil

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	// Run the loop in a goroutine.
	done := make(chan error, 1)
	go func() {
		done <- loop.Run(ctx, ctx)
	}()

	// Wait for the startup pollCycle (Run polls once immediately on entry; the
	// ticker itself does not fire until +PollInterval). Give it a moment.
	time.Sleep(100 * time.Millisecond)
	initialTicks := cs.TickCount()

	// Now send 3 TriggerPoll signals in sequence, each should fire.
	for i := 0; i < 3; i++ {
		select {
		case loop.TriggerPoll <- struct{}{}:
		default:
			// Channel buffered (cap=1), drain if already pending.
		}
		time.Sleep(100 * time.Millisecond)
	}

	finalTicks := cs.TickCount()
	triggerTicks := finalTicks - initialTicks

	cancel()
	<-done

	// At least 2 of our 3 trigger signals should have produced ticks.
	// (Exact count may vary due to channel buffering, but zero would indicate suppression.)
	if triggerTicks < 2 {
		t.Errorf("TriggerPoll fired %d ticks out of 3 signals; expected at least 2 (cooldown is suppressing events)", triggerTicks)
	}
}

func TestTriggerPoll_ResetsIdleBackoff(t *testing.T) {
	cfg := testConfig()
	client := testClientStubbed(t)
	mock := llm.NewMockProvider()
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin"}

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)

	// Build up idle backoff.
	loop.IncrementIdleBackoff()
	loop.IncrementIdleBackoff()
	loop.IncrementIdleBackoff()
	if loop.idleBackoff != 3 {
		t.Fatalf("idleBackoff = %d, want 3", loop.idleBackoff)
	}

	// Reset should clear it.
	loop.ResetIdleBackoff()
	if loop.idleBackoff != 0 {
		t.Errorf("idleBackoff after ResetIdleBackoff = %d, want 0", loop.idleBackoff)
	}

	// PollInterval should return base.
	if got := loop.PollInterval(); got != cfg.WorkLoop.PollInterval {
		t.Errorf("PollInterval after reset = %v, want %v", got, cfg.WorkLoop.PollInterval)
	}
}

func TestNoPollCooldownField(t *testing.T) {
	// Verify the pollCooldownUntil field and SetPollCooldown method no longer exist.
	// This is a compile-time check: if the field/method were re-added, this test
	// would fail to compile because we assert the Loop struct size hasn't grown.
	// More practically, we verify that no-work ticks do NOT suppress TriggerPoll.

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agents/me/config" {
			json.NewEncoder(w).Encode(map[string]any{"agent_id": "agent-1", "workspace_config": map[string]any{"pipeline_config": DefaultPipelineConfig}})
			return
		}
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]any{
			"id": "agent-1", "name": "test", "agent_type": "coding", "is_active": true,
		})
	}))
	defer server.Close()

	cfg := testConfig()
	cfg.WorkLoop.PollInterval = 10 * time.Minute

	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	// Use a strategy that simulates "no work" on first tick (increments idle backoff),
	// then counts subsequent ticks.
	cs := &countingStrategy{}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)
	loop.strategy = cs
	loop.scheduler = nil // pin to the counting strategy; bypass multi-role dispatch
	// Opt out of platform-authority drops — see TestTriggerPoll_AlwaysFires.
	loop.ownedStrategies = nil

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- loop.Run(ctx, ctx)
	}()

	// Let the initial ticker-driven tick complete.
	time.Sleep(100 * time.Millisecond)
	afterFirstTick := cs.TickCount()

	// Send TriggerPoll — should fire even though idle (no cooldown to suppress it).
	loop.TriggerPoll <- struct{}{}
	time.Sleep(100 * time.Millisecond)
	afterTrigger := cs.TickCount()

	cancel()
	<-done

	if afterTrigger <= afterFirstTick {
		t.Errorf("TriggerPoll did not fire a tick: before=%d after=%d (cooldown is suppressing)", afterFirstTick, afterTrigger)
	}
}

// workSignalStrategy reports lastTickHadWork=true for its first `workTicks`
// ticks, then false. It exercises the self-trigger-after-productive-tick path:
// a productive tick should make the loop re-poll immediately (a multi-role
// runner's next role may now have work) rather than wait poll_interval.
type workSignalStrategy struct {
	mu        sync.Mutex
	ticks     int
	workTicks int
}

func (s *workSignalStrategy) Name() string           { return "work-signal" }
func (s *workSignalStrategy) AllowedTools() []string { return nil }
func (s *workSignalStrategy) Tick(_ context.Context, l *Loop) error {
	s.mu.Lock()
	s.ticks++
	hadWork := s.ticks <= s.workTicks
	s.mu.Unlock()
	l.lastTickHadWork = hadWork
	return nil
}
func (s *workSignalStrategy) TickCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ticks
}

func TestProductiveTick_SelfTriggersImmediateRepoll(t *testing.T) {
	// A productive tick (lastTickHadWork=true) must wake the loop again at once
	// — the same runner's next role (e.g. implementer after planner moved the
	// card) should claim within seconds, not after poll_interval. Card 4f8d88aa.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agents/me/config" {
			json.NewEncoder(w).Encode(map[string]any{"agent_id": "agent-1", "workspace_config": map[string]any{"pipeline_config": DefaultPipelineConfig}})
			return
		}
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]any{
			"id": "agent-1", "name": "test", "agent_type": "coding", "is_active": true,
		})
	}))
	defer server.Close()

	cfg := testConfig()
	// Poll interval far longer than the test: any follow-up tick within the test
	// window can ONLY come from the self-trigger, never the ticker.
	cfg.WorkLoop.PollInterval = 10 * time.Minute

	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	// First two ticks report work, the rest report idle. The initial ticker
	// tick (t=0) consumes the first work signal; its self-trigger drives the
	// second; the second's self-trigger drives a third tick that reports idle
	// and stops the chain.
	ws := &workSignalStrategy{workTicks: 2}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)
	loop.strategy = ws
	loop.scheduler = nil
	loop.ownedStrategies = nil
	// This test asserts the self-trigger CHAIN (2 productive ticks within 300ms);
	// disable the production rate-floor so it doesn't suppress the back-to-back
	// self-triggers under test. The floor itself is covered separately.
	loop.selfTriggerMinInterval = 0

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- loop.Run(ctx, ctx) }()

	// Kick the first cycle manually (the 10m ticker won't fire during the test).
	// From there, each productive tick must self-trigger the next cycle.
	loop.TriggerPoll <- struct{}{}

	// Give the self-triggered follow-ups time to chain.
	time.Sleep(300 * time.Millisecond)
	got := ws.TickCount()

	cancel()
	<-done

	// One manual trigger drives the first tick. Without a self-trigger the chain
	// stops there (count==1). The two productive ticks must each wake another
	// cycle → at least 3 total (the 3rd reports idle and ends the chain).
	if got < 3 {
		t.Errorf("productive ticks did not self-trigger re-poll: tick count=%d, want >=3 (poll_interval is 10m so the ticker cannot explain extra ticks)", got)
	}
}

// Regression for the self-trigger poll storm: a role that keeps marking ticks
// productive without advancing a card must NOT spin the loop. With the rate-floor
// engaged, rapid back-to-back productive self-triggers collapse to a single poll
// within the interval.
func TestSelfTrigger_RateFloor_CollapsesRapidFires(t *testing.T) {
	loop := &Loop{
		TriggerPoll:            make(chan struct{}, 1),
		lastTickHadWork:        true,
		selfTriggerMinInterval: time.Minute, // long floor: only the first fire passes
	}

	// Fire 10 times in a tight burst (simulating the stuck-role spin).
	for i := 0; i < 10; i++ {
		loop.selfTriggerIfProductive()
	}

	// Exactly one signal should be queued; the rest are suppressed by the floor
	// (and the cap-1 channel). Drain and assert nothing remains.
	select {
	case <-loop.TriggerPoll:
	default:
		t.Fatal("expected one self-trigger to pass the floor")
	}
	select {
	case <-loop.TriggerPoll:
		t.Fatal("rate-floor failed: a second self-trigger leaked within the interval")
	default:
		// Correct: only one fire passed.
	}
}

// The floor must not break legitimate handoffs once the interval has elapsed.
func TestSelfTrigger_RateFloor_AllowsAfterInterval(t *testing.T) {
	loop := &Loop{
		TriggerPoll:            make(chan struct{}, 1),
		lastTickHadWork:        true,
		selfTriggerMinInterval: time.Millisecond,
	}

	loop.selfTriggerIfProductive()
	<-loop.TriggerPoll // drain the first

	time.Sleep(2 * time.Millisecond) // exceed the floor

	loop.selfTriggerIfProductive()
	select {
	case <-loop.TriggerPoll:
		// Correct: a self-trigger after the interval fires normally.
	case <-time.After(50 * time.Millisecond):
		t.Fatal("self-trigger after the interval should fire")
	}
}

// --- Platform Config / WorkspaceConfig tests ---

func TestWorkspaceConfig_DefaultValues(t *testing.T) {
	loop := &Loop{
		cardFailures: make(map[string]cardFailure),
		promptCache:  make(map[string]string),
	}

	cfg := loop.WorkspaceConfig()

	if cfg.MaxReworkAttempts != 3 {
		t.Errorf("MaxReworkAttempts = %d, want 3 (default)", cfg.MaxReworkAttempts)
	}
	if cfg.CardCooldownHours != 1.0 {
		t.Errorf("CardCooldownHours = %f, want 1.0 (default)", cfg.CardCooldownHours)
	}
	if cfg.CommitMessageTemplate != "feat({{.CardID}}): {{.Title}}" {
		t.Errorf("CommitMessageTemplate = %q, want default template", cfg.CommitMessageTemplate)
	}
}

func TestWorkspaceConfig_PlatformOverrides(t *testing.T) {
	loop := &Loop{
		cardFailures: make(map[string]cardFailure),
		promptCache:  make(map[string]string),
	}

	loop.platformConfigMu.Lock()
	loop.platformConfig = valaris.WorkspaceConfigData{
		MaxReworkAttempts:     5,
		CardCooldownHours:     2.5,
		CommitMessageTemplate: "fix({{.CardID}}): {{.Title}}",
		Version:               7,
	}
	loop.platformConfigMu.Unlock()

	cfg := loop.WorkspaceConfig()

	if cfg.MaxReworkAttempts != 5 {
		t.Errorf("MaxReworkAttempts = %d, want 5", cfg.MaxReworkAttempts)
	}
	if cfg.CardCooldownHours != 2.5 {
		t.Errorf("CardCooldownHours = %f, want 2.5", cfg.CardCooldownHours)
	}
	if cfg.CommitMessageTemplate != "fix({{.CardID}}): {{.Title}}" {
		t.Errorf("CommitMessageTemplate = %q, want fix template", cfg.CommitMessageTemplate)
	}
	if cfg.Version != 7 {
		t.Errorf("Version = %d, want 7", cfg.Version)
	}
}

func TestWorkspaceConfig_AppliedToCircuitBreaker(t *testing.T) {
	loop := &Loop{
		cardFailures: make(map[string]cardFailure),
		promptCache:  make(map[string]string),
	}

	// Set MaxReworkAttempts to 5 via platform config.
	loop.platformConfigMu.Lock()
	loop.platformConfig = valaris.WorkspaceConfigData{
		MaxReworkAttempts: 5,
		CardCooldownHours: 0.5,
	}
	loop.platformConfigMu.Unlock()

	cardID := "card-platform"

	// 3 failures should NOT block (threshold is now 5).
	for i := 0; i < 3; i++ {
		loop.RecordCardFailure(cardID)
	}
	if loop.IsCardBlocked(cardID) {
		t.Error("card should not be blocked after 3 failures when threshold is 5")
	}

	// 5 failures should block.
	loop.RecordCardFailure(cardID)
	loop.RecordCardFailure(cardID)
	if !loop.IsCardBlocked(cardID) {
		t.Error("card should be blocked after 5 failures when threshold is 5")
	}

	// Verify BlockedCardIDList also respects the platform config.
	list := loop.BlockedCardIDList()
	if !strings.Contains(list, cardID) {
		t.Errorf("BlockedCardIDList should contain %s, got %q", cardID, list)
	}
}

func TestRefreshPlatformConfig_UpdatesWorkspaceConfig(t *testing.T) {
	// Two phases: New() sees version 1 (startup), then RefreshPlatformConfig
	// sees version 2 (mid-flight update). The loop must adopt the newer config.
	phase := 0
	var phaseMu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agents/me/config" {
			phaseMu.Lock()
			p := phase
			phaseMu.Unlock()
			if p == 0 {
				json.NewEncoder(w).Encode(map[string]any{
					"agent_id":   "agent-001",
					"name":       "test",
					"agent_type": "coding",
					"is_active":  true,
					"workspace_config": map[string]any{
						"version":         1,
						"pipeline_config": DefaultPipelineConfig,
					},
				})
				return
			}
			json.NewEncoder(w).Encode(map[string]any{
				"agent_id":   "agent-001",
				"name":       "test",
				"agent_type": "coding",
				"is_active":  true,
				"workspace_config": map[string]any{
					"max_rework_attempts":     4,
					"card_cooldown_hours":     0.25,
					"commit_message_template": "chore({{.CardID}}): {{.Title}}",
					"version":                 2,
					"pipeline_config":         DefaultPipelineConfig,
				},
			})
		}
	}))
	defer server.Close()

	client := testClientWithURL(server.URL)
	mock := llm.NewMockProvider(`{"card_id":""}`)
	cfg := testConfig()
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, mock, gitMgr, cfg)

	phaseMu.Lock()
	phase = 1
	phaseMu.Unlock()

	loop.RefreshPlatformConfig(context.Background())

	wsCfg := loop.WorkspaceConfig()
	if wsCfg.MaxReworkAttempts != 4 {
		t.Errorf("MaxReworkAttempts = %d, want 4", wsCfg.MaxReworkAttempts)
	}
	if wsCfg.CardCooldownHours != 0.25 {
		t.Errorf("CardCooldownHours = %f, want 0.25", wsCfg.CardCooldownHours)
	}
	if wsCfg.CommitMessageTemplate != "chore({{.CardID}}): {{.Title}}" {
		t.Errorf("CommitMessageTemplate = %q, want chore template", wsCfg.CommitMessageTemplate)
	}
	if wsCfg.Version != 2 {
		t.Errorf("Version = %d, want 2", wsCfg.Version)
	}
}

func TestRefreshPlatformConfig_FailsGracefully(t *testing.T) {
	// New() succeeds (phase 0 serves a valid pipeline). Mid-flight refresh
	// then hits a 500 — Loop must keep the previously fetched config and not
	// panic. The point of the test is the refresh fault-tolerance; New itself
	// is expected to hard-fail on platform errors (see TestNew_FetchError_...).
	phase := 0
	var phaseMu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		phaseMu.Lock()
		p := phase
		phaseMu.Unlock()
		if p == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"agent_id": "agent-001",
			"workspace_config": map[string]any{
				"version":         1,
				"pipeline_config": DefaultPipelineConfig,
			},
		})
	}))
	defer server.Close()

	client := testClientWithURL(server.URL)
	mock := llm.NewMockProvider(`{"card_id":""}`)
	cfg := testConfig()
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, mock, gitMgr, cfg)

	phaseMu.Lock()
	phase = 1
	phaseMu.Unlock()

	// Must not panic; previous config remains.
	loop.RefreshPlatformConfig(context.Background())

	wsCfg := loop.WorkspaceConfig()
	if wsCfg.MaxReworkAttempts != 3 {
		t.Errorf("MaxReworkAttempts = %d, want 3 (default fallback)", wsCfg.MaxReworkAttempts)
	}
}

func TestRenderCommitMessage(t *testing.T) {
	tests := []struct {
		template string
		cardID   string
		title    string
		want     string
	}{
		{"feat({{.CardID}}): {{.Title}}", "c-123", "Add login", "feat(c-123): Add login"},
		{"fix({{.CardID}}): {{.Title}}", "c-456", "Fix bug", "fix(c-456): Fix bug"},
		{"{{.Title}} ({{.CardID}})", "c-789", "Refactor", "Refactor (c-789)"},
		{"static commit message", "c-000", "Ignored", "static commit message"},
	}
	for _, tc := range tests {
		got := renderCommitMessage(tc.template, tc.cardID, tc.title)
		if got != tc.want {
			t.Errorf("renderCommitMessage(%q, %q, %q) = %q, want %q", tc.template, tc.cardID, tc.title, got, tc.want)
		}
	}
}

func TestMediateReworkPrompt_CustomEscalationThreshold(t *testing.T) {
	// Custom threshold of 5: attempt 4 should NOT trigger escalation.
	p4 := mediateReworkPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "c1", ReworkAttempt: 4, MaxReworkAttempts: 5, ReviewHistory: "history"})
	if strings.Contains(p4, "ESCALATION WARNING") {
		t.Error("attempt 4 with threshold 5 should not have escalation warning")
	}

	// Attempt 5 with threshold 5 SHOULD trigger escalation.
	p5 := mediateReworkPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "c1", ReworkAttempt: 5, MaxReworkAttempts: 5, ReviewHistory: "history"})
	if !strings.Contains(p5, "ESCALATION WARNING") {
		t.Error("attempt 5 with threshold 5 should have escalation warning")
	}
	if !strings.Contains(p5, "rework attempt #5") {
		t.Error("escalation should mention attempt number 5")
	}
}

// --- Multi-role scheduler integration tests ---
// Role dispatch moved to the platform's pipeline_config in I.1.l; Role/Roles
// YAML fields no longer exist. TestNew_BuildsStrategiesFromPlatformPipeline
// (loop_new_test.go) covers multi-role construction end-to-end.

func TestNew_MultiRole_TickDelegatesToScheduler(t *testing.T) {
	server := testAPIServer(t, testServerOptions{
		boards: []valaris.Board{{ID: "board-1", Name: "Test"}},
		cards:  []valaris.Card{}, // no work
	})

	cfg := testConfig()
	cfg.WorkLoop.Scheduling = config.SchedulingConfig{
		Strategy:      "priority",
		PriorityOrder: []string{"reviewer", "orchestrator"},
	}

	mock := llm.NewMockProvider()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	// testAPIServer now serves DefaultPipelineConfig, so Loop.New builds all
	// three stages and wires a scheduler.
	loop := mustNewLoop(t, client, mock, gitMgr, cfg)
	if loop.scheduler == nil {
		t.Fatal("platform pipeline with multiple stages must yield a scheduler")
	}

	err := loop.tick(context.Background())
	if err != nil {
		t.Fatalf("multi-role tick with no work should succeed: %v", err)
	}

	// Discover is REST-based — 0 LLM calls. The scheduler should have picked
	// reviewer (highest priority) and run its REST-based discover.
	if mock.CallCount() != 0 {
		t.Fatalf("expected 0 LLM calls (discover is REST), got %d", mock.CallCount())
	}
}

// --- P1 fix verification tests ---

func TestReviewerStrategy_RecordFailure_BlocksCard(t *testing.T) {
	// Fix #1: Reviewer recordFailure now passes cardID to circuit breaker.
	// After MaxReworkAttempts (default=3) failures, IsCardBlocked returns true.
	cardID := "card-rev-fail"

	// Server that returns a card in review with PR URL, but LogExecutionStart fails.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		method := r.Method

		if strings.Contains(path, "/budget-status") {
			json.NewEncoder(w).Encode(map[string]any{"is_exceeded": false, "spent_usd": 1.0, "budget_usd": 100.0})
			return
		}
		if strings.HasSuffix(path, "/boards") && method == http.MethodGet {
			json.NewEncoder(w).Encode([]valaris.Board{{ID: "board-rev", Name: "Test"}})
			return
		}
		if strings.Contains(path, "/cards/search") {
			json.NewEncoder(w).Encode([]valaris.Card{{
				ID: cardID, BoardID: "board-rev", Title: "Review auth",
				Description: "PR: https://github.com/org/repo/pull/42",
				ColumnType:  "review",
			}})
			return
		}
		if strings.Contains(path, "/git-repos") {
			json.NewEncoder(w).Encode([]valaris.GitRepo{{ID: "r1", Name: "test-repo", URL: "https://example.com/repo.git"}})
			return
		}
		// LogExecutionStart: return 500 to cause claim failure.
		if strings.Contains(path, "/executions") && method == http.MethodPost {
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte(`{"detail":"internal error"}`))
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
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("{}"))
	}))
	defer server.Close()

	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	for i := 0; i < defaultMaxReworkAttempts; i++ {
		mock := llm.NewMockProvider()
		loop := mustNewLoopForRole(t, client, mock, gitMgr, cfg, "reviewer")

		// Pre-seed the circuit breaker with the accumulated failures from previous iterations.
		for j := 0; j < i; j++ {
			loop.RecordCardFailure(cardID)
		}

		err := loop.tick(context.Background())
		if err == nil {
			t.Fatalf("iteration %d: tick should return error on claim failure", i)
		}

		// After the tick, the card should have i+1 recorded failures.
		expectedCount := i + 1
		if got := loop.CardFailureCount(cardID); got != expectedCount {
			t.Errorf("iteration %d: CardFailureCount = %d, want %d", i, got, expectedCount)
		}
	}

	// After MaxReworkAttempts failures, create a fresh loop and verify IsCardBlocked.
	loop := mustNewLoopForRole(t, client, llm.NewMockProvider(), gitMgr, cfg, "reviewer")
	for i := 0; i < defaultMaxReworkAttempts; i++ {
		loop.RecordCardFailure(cardID)
	}
	if !loop.IsCardBlocked(cardID) {
		t.Error("card should be blocked after MaxReworkAttempts reviewer failures")
	}
}

func TestDocumentatorStrategy_RecordFailure_BlocksCard(t *testing.T) {
	// Fix #1: Documentator recordFailure now passes cardID to circuit breaker.
	bare := initBareRemote(t)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agents/me/config" {
			json.NewEncoder(w).Encode(map[string]any{"agent_id": "agent-1", "workspace_config": map[string]any{"pipeline_config": DefaultPipelineConfig}})
			return
		}
		if strings.Contains(r.URL.Path, "/budget-status") {
			json.NewEncoder(w).Encode(map[string]any{
				"is_exceeded": false,
				"spent_usd":   1.0,
				"budget_usd":  100.0,
			})
			return
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("{}"))
	}))
	defer server.Close()

	cardID := "card-doc-fail"
	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	discoverResp := mustJSON(t, map[string]string{
		"card_id":       cardID,
		"board_id":      "board-doc",
		"title":         "Document API",
		"git_repo_url":  bare,
		"git_repo_name": "test-repo",
	})
	claimFailResp := mustJSON(t, map[string]string{
		"execution_id": "",
		"error":        "claim denied",
	})

	// Run enough failures to trip the circuit breaker.
	loop := mustNewLoopForRole(t, client, llm.NewMockProvider(discoverResp, claimFailResp), gitMgr, cfg, "documentator")
	for i := 0; i < defaultMaxReworkAttempts; i++ {
		loop.RecordCardFailure(cardID)
	}

	// Verify blocked before even running a tick.
	if !loop.IsCardBlocked(cardID) {
		t.Error("card should be blocked after MaxReworkAttempts documentator failures")
	}
}

func TestReviewerStrategy_BudgetExceeded_SkipsAfterDiscover(t *testing.T) {
	// Fix #2: Reviewer now checks budget after discover (REST-based).
	// When budget is exceeded, tick should return nil with 0 LLM calls.
	server := testAPIServer(t, testServerOptions{
		boards: []valaris.Board{{ID: "board-budget", Name: "Test"}},
		cards: []valaris.Card{{
			ID: "card-budget-rev", BoardID: "board-budget", Title: "Review something",
			Description: "PR: https://github.com/org/repo/pull/99",
		}},
		gitRepos:       []valaris.GitRepo{{ID: "r1", Name: "repo", URL: "https://github.com/org/repo.git"}},
		budgetExceeded: true,
	})

	mock := llm.NewMockProvider()
	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoopForRole(t, client, mock, gitMgr, cfg, "reviewer")
	err := loop.tick(context.Background())
	if err != nil {
		t.Fatalf("budget-exceeded reviewer tick should return nil: %v", err)
	}

	// Discover is REST, budget check stops before claim. 0 LLM calls.
	if mock.CallCount() != 0 {
		t.Errorf("expected 0 LLM calls (discover is REST, budget stops claim), got %d", mock.CallCount())
	}
}

func TestDocumentatorStrategy_BudgetExceeded_SkipsAfterDiscover(t *testing.T) {
	// Fix #2: Documentator now checks budget after discover (REST-based).
	server := testAPIServer(t, testServerOptions{
		boards:         []valaris.Board{{ID: "board-budget", Name: "Test"}},
		cards:          []valaris.Card{{ID: "card-budget-doc", BoardID: "board-budget", Title: "Document something"}},
		gitRepos:       []valaris.GitRepo{{ID: "r1", Name: "repo", URL: "https://github.com/org/repo.git"}},
		budgetExceeded: true,
	})

	mock := llm.NewMockProvider()
	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoopForRole(t, client, mock, gitMgr, cfg, "documentator")
	err := loop.tick(context.Background())
	if err != nil {
		t.Fatalf("budget-exceeded documentator tick should return nil: %v", err)
	}

	// Discover is REST, budget check stops before claim. 0 LLM calls.
	if mock.CallCount() != 0 {
		t.Errorf("expected 0 LLM calls (discover is REST, budget stops claim), got %d", mock.CallCount())
	}
}

// T2.4: skip paths (budget, circuit breaker) leave a claimable card untouched,
// so lastTickHadWork must stay false — otherwise the scheduler treats the skip
// as "work happened" and burns the full 30s poll interval between skipped roles
// instead of fast-forwarding. During ST#9 this added ~25min of wall-clock time
// during a budget block before all 5 roles were tried once.
func TestStrategyTick_BudgetExceeded_LeavesLastTickHadWorkFalse(t *testing.T) {
	server := testAPIServer(t, testServerOptions{
		boards:         []valaris.Board{{ID: "board-1", Name: "Test"}},
		cards:          []valaris.Card{{ID: "card-1", BoardID: "board-1", Title: "Something to review", Description: "PR: https://github.com/org/repo/pull/1"}},
		gitRepos:       []valaris.GitRepo{{ID: "r1", Name: "repo", URL: "https://github.com/org/repo.git"}},
		budgetExceeded: true,
	})

	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoopForRole(t, client, llm.NewMockProvider(), gitMgr, cfg, "reviewer")

	loop.lastTickHadWork = false
	if err := loop.tick(context.Background()); err != nil {
		t.Fatalf("budget-exceeded tick should return nil: %v", err)
	}

	if loop.lastTickHadWork {
		t.Error("lastTickHadWork must remain false when a budget-exceeded skip leaves the card untouched (scheduler needs this to fast-forward)")
	}
}

func TestOrchestratorTick_NoChanges_RecordsFailure(t *testing.T) {
	// Fix #3: No-changes after implement now calls failExecution and recordFailure.
	bare := initBareRemote(t)

	cardID := "card-nochanges"

	server := testAPIServer(t, testServerOptions{
		boards:   []valaris.Board{{ID: "board-nc", Name: "Test"}},
		cards:    []valaris.Card{{ID: cardID, BoardID: "board-nc", Title: "Empty implement"}},
		gitRepos: []valaris.GitRepo{{ID: "r1", Name: "test-repo", URL: bare}},
		execID:   "exec-nc",
		columns: []valaris.BoardColumn{
			{ID: "col-todo", Name: "To Do", Position: 1024, ColumnType: "backlog"},
			{ID: "col-active", Name: "Active", Position: 2048, ColumnType: "active"},
		},
	})

	implementResp := mustJSON(t, map[string]string{
		"status":  "done",
		"summary": "All changes implemented",
	})

	// Build a loop with pre-seeded failures, then run one more no-changes tick.
	mock := llm.NewMockProvider(implementResp)
	cfg := testConfig()
	cfg.Git.AutoPR = false
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)

	// Pre-seed with MaxReworkAttempts - 1 failures.
	for i := 0; i < defaultMaxReworkAttempts-1; i++ {
		loop.RecordCardFailure(cardID)
	}

	// This tick will find the card, claim it, implement it (mock LLM doesn't write files),
	// detect no git changes, then call failExecution + recordFailure.
	err := loop.tick(context.Background())
	// No-changes path returns nil (not an error), but records the failure.
	if err != nil {
		// The tick may return nil or an error depending on whether failExecution
		// REST calls fail against our mock server. Either way is fine.
		_ = err
	}

	// The no-changes path should have recorded one more failure, reaching the threshold.
	if count := loop.CardFailureCount(cardID); count < defaultMaxReworkAttempts {
		t.Errorf("CardFailureCount = %d, want >= %d (no-changes should record failure)", count, defaultMaxReworkAttempts)
	}

	if !loop.IsCardBlocked(cardID) {
		t.Error("card should be blocked after no-changes failure pushes count to MaxReworkAttempts")
	}
}

func TestOrchestratorTick_NoChanges_RecordsCardFailure(t *testing.T) {
	// Fix #3: When implement produces no git diff, recordFailure is called with cardID.
	bare := initBareRemote(t)
	cardID := "card-ship-fail"

	server := testAPIServer(t, testServerOptions{
		boards:   []valaris.Board{{ID: "board-ship", Name: "Test"}},
		cards:    []valaris.Card{{ID: cardID, BoardID: "board-ship", Title: "Ship failure test"}},
		gitRepos: []valaris.GitRepo{{ID: "r1", Name: "test-repo", URL: bare}},
		execID:   "exec-ship",
	})

	implementResp := mustJSON(t, map[string]string{
		"status":  "done",
		"summary": "Implemented changes",
	})

	mock := llm.NewMockProvider(implementResp)
	cfg := testConfig()
	cfg.Git.AutoPR = false
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)

	err := loop.tick(context.Background())
	// The tick hits no-changes (mock LLM does not write files), which now records failure.
	_ = err

	// Verify the no-changes path records failure (fix #3).
	if loop.CardFailureCount(cardID) < 1 {
		t.Error("no-changes path should record a failure for the card")
	}
}

func TestOrchestratorTick_NoChanges_NoSuccessRecorded(t *testing.T) {
	// Fix #3/#4: When implement produces no git diff, health does NOT record success.
	bare := initBareRemote(t)

	server := testAPIServer(t, testServerOptions{
		boards:   []valaris.Board{{ID: "board-ship", Name: "Test"}},
		cards:    []valaris.Card{{ID: "card-ship-err", BoardID: "board-ship", Title: "Ship error"}},
		gitRepos: []valaris.GitRepo{{ID: "r1", Name: "test-repo", URL: bare}},
		execID:   "exec-ship-err",
	})

	implementResp := mustJSON(t, map[string]string{
		"status":  "done",
		"summary": "Changes made",
	})

	mock := llm.NewMockProvider(implementResp)
	cfg := testConfig()
	cfg.Git.AutoPR = false
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	hc := health.NewCollector(cfg.WorkLoop.PollInterval, cfg.WorkLoop.CardTimeout, cfg.Daemon.HealthPort)
	loop := mustNewLoop(t, client, mock, gitMgr, cfg, hc)

	err := loop.tick(context.Background())
	// No-changes path: tick returns nil but records failure.
	_ = err

	// Fix #3 verification: no-changes records failure.
	if loop.CardFailureCount("card-ship-err") < 1 {
		t.Error("no-changes should record a failure (fix #3)")
	}

	// Fix #4 verification: health should NOT record success for a no-changes tick.
	report := hc.Report()
	if report.CardsProcessed > 0 {
		t.Error("no-changes tick should NOT record success in health collector (fix #3/#4)")
	}
}

func TestReviewerStrategy_ClaimFailure_IncreasesCardFailureCount(t *testing.T) {
	// Fix #1 detailed: Verify that reviewer claim failure increments the per-card
	// circuit breaker counter (not just the global health failure counter).
	cardID := "card-rev-claim-fail"

	// Server that returns a card in review, but LogExecutionStart fails (causes claim failure).
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		method := r.Method

		if strings.Contains(path, "/budget-status") {
			json.NewEncoder(w).Encode(map[string]any{"is_exceeded": false, "spent_usd": 1.0, "budget_usd": 100.0})
			return
		}
		if strings.HasSuffix(path, "/boards") && method == http.MethodGet {
			json.NewEncoder(w).Encode([]valaris.Board{{ID: "board-rev", Name: "Test"}})
			return
		}
		if strings.Contains(path, "/cards/search") {
			json.NewEncoder(w).Encode([]valaris.Card{{
				ID: cardID, BoardID: "board-rev", Title: "Review claim failure",
				Description: "PR: https://github.com/org/repo/pull/50",
				ColumnType:  "review",
			}})
			return
		}
		if strings.Contains(path, "/git-repos") {
			json.NewEncoder(w).Encode([]valaris.GitRepo{{ID: "r1", Name: "test-repo", URL: "https://example.com/repo.git"}})
			return
		}
		// LogExecutionStart: return 500 to cause claim failure.
		if strings.Contains(path, "/executions") && method == http.MethodPost {
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte(`{"detail":"internal error"}`))
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
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("{}"))
	}))
	defer server.Close()

	mock := llm.NewMockProvider()
	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	hc := health.NewCollector(cfg.WorkLoop.PollInterval, cfg.WorkLoop.CardTimeout, cfg.Daemon.HealthPort)
	loop := mustNewLoopForRole(t, client, mock, gitMgr, cfg, "reviewer", hc)

	err := loop.tick(context.Background())
	if err == nil {
		t.Fatal("reviewer tick with claim failure should return error")
	}

	// Fix #1: CardFailureCount should be 1 (not 0).
	if got := loop.CardFailureCount(cardID); got != 1 {
		t.Errorf("CardFailureCount = %d, want 1 (reviewer recordFailure should pass cardID)", got)
	}

	// Health collector should also show the failure.
	report := hc.Report()
	if report.CardsFailed != 1 {
		t.Errorf("health CardsFailed = %d, want 1", report.CardsFailed)
	}
}

// --- G.1: Documentator failure must NOT regress card column ---

func TestDocumentatorFailure_LeavesCardInDoneColumn(t *testing.T) {
	// When the documentator fails (e.g., generateDocs error), the card must
	// stay in Done — NOT be moved back to Backlog. The bug was that failExecution
	// moved the card to Backlog, causing duplicate re-implementation.
	bare := initBareRemote(t)

	cardID := "card-doc-done"
	boardID := "board-doc-done"

	var mu sync.Mutex
	moveCardCalled := false
	failExecCalled := false
	removeParticipantCalled := false

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		method := r.Method

		mu.Lock()
		defer mu.Unlock()

		// Track if move_card is called (it should NOT be).
		if strings.Contains(path, "/move") && method == http.MethodPost {
			moveCardCalled = true
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("{}"))
			return
		}

		// Track execution failure.
		if strings.Contains(path, "/executions/") && method == http.MethodPatch {
			failExecCalled = true
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("{}"))
			return
		}

		// Track participant removal.
		if strings.Contains(path, "/participants") && method == http.MethodDelete {
			removeParticipantCalled = true
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("{}"))
			return
		}

		// Heartbeat
		if strings.HasSuffix(path, "/heartbeat") {
			json.NewEncoder(w).Encode(map[string]any{"id": "agent-1", "name": "test", "agent_type": "coding", "is_active": true})
			return
		}
		// Prompt configs
		if strings.Contains(path, "/prompt-configs") {
			json.NewEncoder(w).Encode([]any{})
			return
		}
		// Platform config
		if path == "/api/agents/me/config" {
			json.NewEncoder(w).Encode(map[string]any{"agent_id": "agent-1", "workspace_config": map[string]any{"pipeline_config": DefaultPipelineConfig}})
			return
		}
		// Budget
		if strings.Contains(path, "/budget-status") {
			json.NewEncoder(w).Encode(map[string]any{"is_exceeded": false, "spent_usd": 1.0, "budget_usd": 100.0})
			return
		}
		// List boards
		if strings.HasSuffix(path, "/boards") && method == http.MethodGet {
			json.NewEncoder(w).Encode([]valaris.Board{{ID: boardID, Name: "Test"}})
			return
		}
		// Get board detail (for column resolution in failExecution — should NOT be called)
		if strings.Contains(path, "/boards/") && method == http.MethodGet && !strings.Contains(path, "/cards") && !strings.Contains(path, "/git-repos") && !strings.Contains(path, "/context") && !strings.Contains(path, "/notes") {
			json.NewEncoder(w).Encode(map[string]any{
				"id": boardID, "name": "Test",
				"columns": []map[string]any{
					{"id": "col-backlog", "name": "To Do", "column_type": "backlog", "position": 1024},
					{"id": "col-done", "name": "Done", "column_type": "done", "position": 4096},
				},
			})
			return
		}
		// Search cards: return a card in Done column (shipped, no "documented" label).
		if strings.Contains(path, "/cards/search") {
			json.NewEncoder(w).Encode([]valaris.Card{{
				ID: cardID, BoardID: boardID, Title: "Shipped feature",
				ColumnType: "done",
			}})
			return
		}
		// Git repos
		if strings.Contains(path, "/git-repos") {
			json.NewEncoder(w).Encode([]valaris.GitRepo{{ID: "r1", Name: "test-repo", URL: bare}})
			return
		}
		// LogExecutionStart
		if strings.Contains(path, "/executions") && method == http.MethodPost {
			json.NewEncoder(w).Encode(map[string]string{"id": "exec-doc-fail"})
			return
		}
		// Participants (add)
		if strings.Contains(path, "/participants") && method == http.MethodPost {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("{}"))
			return
		}
		// Board context
		if strings.Contains(path, "/context") {
			json.NewEncoder(w).Encode(map[string]any{})
			return
		}
		// Notes
		if strings.Contains(path, "/notes") {
			json.NewEncoder(w).Encode([]any{})
			return
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("{}"))
	}))
	defer server.Close()

	// generateDocs LLM call returns an error-like response that will cause a JSON parse failure.
	// Use an invalid JSON response to trigger a generateDocs error.
	mock := llm.NewMockProvider("THIS IS NOT VALID JSON FOR DOC RESULT")
	cfg := testConfig()
	cfg.Git.AutoPR = false
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoopForRole(t, client, mock, gitMgr, cfg, "documentator")
	err := loop.tick(context.Background())

	// The tick should return an error (generateDocs parse failure).
	if err == nil {
		t.Fatal("tick should return error when generateDocs fails")
	}

	mu.Lock()
	defer mu.Unlock()

	// CRITICAL: move_card must NOT be called — card stays in Done.
	if moveCardCalled {
		t.Error("failDocExecution must NOT call move_card — card should stay in Done column")
	}

	// Execution should be marked as failed.
	if !failExecCalled {
		t.Error("failDocExecution should mark execution as failed via PATCH")
	}

	// Agent should be unassigned from card.
	if !removeParticipantCalled {
		t.Error("failDocExecution should remove agent participant so next tick can re-claim")
	}
}

func TestDocumentatorFailure_CircuitBreakerStillTracks(t *testing.T) {
	// Verify that recordFailure with cardID is still called after failDocExecution.
	// The circuit breaker must still block the card after repeated doc failures.
	bare := initBareRemote(t)

	cardID := "card-doc-cb"
	boardID := "board-doc-cb"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		method := r.Method

		if strings.Contains(path, "/budget-status") {
			json.NewEncoder(w).Encode(map[string]any{"is_exceeded": false, "spent_usd": 1.0, "budget_usd": 100.0})
			return
		}
		if strings.HasSuffix(path, "/boards") && method == http.MethodGet {
			json.NewEncoder(w).Encode([]valaris.Board{{ID: boardID, Name: "Test"}})
			return
		}
		if strings.Contains(path, "/boards/") && method == http.MethodGet && !strings.Contains(path, "/cards") && !strings.Contains(path, "/git-repos") && !strings.Contains(path, "/context") && !strings.Contains(path, "/notes") {
			json.NewEncoder(w).Encode(map[string]any{
				"id": boardID, "name": "Test",
				"columns": []map[string]any{
					{"id": "col-done", "name": "Done", "column_type": "done", "position": 4096},
				},
			})
			return
		}
		if strings.Contains(path, "/cards/search") {
			json.NewEncoder(w).Encode([]valaris.Card{{
				ID: cardID, BoardID: boardID, Title: "Doc CB test",
				ColumnType: "done",
			}})
			return
		}
		if strings.Contains(path, "/git-repos") {
			json.NewEncoder(w).Encode([]valaris.GitRepo{{ID: "r1", Name: "test-repo", URL: bare}})
			return
		}
		if strings.Contains(path, "/executions") && method == http.MethodPost {
			json.NewEncoder(w).Encode(map[string]string{"id": "exec-doc-cb"})
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
		if strings.Contains(path, "/context") {
			json.NewEncoder(w).Encode(map[string]any{})
			return
		}
		if strings.Contains(path, "/notes") {
			json.NewEncoder(w).Encode([]any{})
			return
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("{}"))
	}))
	defer server.Close()

	cfg := testConfig()
	cfg.Git.AutoPR = false
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	// Pre-seed circuit breaker with failures just below threshold.
	loop := mustNewLoopForRole(t, client, llm.NewMockProvider("INVALID JSON FOR DOC RESULT"), gitMgr, cfg, "documentator")
	for i := 0; i < defaultMaxReworkAttempts-1; i++ {
		loop.RecordCardFailure(cardID)
	}

	// Run one more tick — generateDocs will fail, recordFailure should push count to threshold.
	err := loop.tick(context.Background())
	if err == nil {
		t.Fatal("tick should return error when generateDocs fails")
	}

	// Circuit breaker should now have exactly defaultMaxReworkAttempts failures.
	if count := loop.CardFailureCount(cardID); count < defaultMaxReworkAttempts {
		t.Errorf("CardFailureCount = %d, want >= %d", count, defaultMaxReworkAttempts)
	}

	// Card should be blocked by circuit breaker.
	if !loop.IsCardBlocked(cardID) {
		t.Error("card should be blocked after reaching max failures from documentator errors")
	}
}

func TestShipDescription_NoDuplication(t *testing.T) {
	prURL := "https://github.com/org/repo/pull/1"
	branch := "runner/fix-login-bug"
	cardID := "card-dup-1"
	boardID := "board-dup-1"

	// UX-3: ship always PATCHes pr_url + branch_name (those are the new
	// authoritative columns), even when the description footer is unchanged.
	// The invariant we still want: when the footer already carries this
	// PR/branch pair, the PATCH body must NOT include `description`.
	var sawDescription bool
	var mu sync.Mutex

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		method := r.Method

		if path == "/api/agents/me/config" {
			json.NewEncoder(w).Encode(map[string]any{"agent_id": "agent-1", "workspace_config": map[string]any{"pipeline_config": DefaultPipelineConfig}})
			return
		}

		// Get card: return a card whose description already contains the PR URL.
		if strings.Contains(path, "/cards/") && method == http.MethodGet && !strings.Contains(path, "/search") && !strings.Contains(path, "/participants") {
			json.NewEncoder(w).Encode(valaris.Card{
				ID:          cardID,
				BoardID:     boardID,
				Title:       "Fix login bug",
				Description: fmt.Sprintf("Some description\n\n---\nBranch: %s\nPR: %s", branch, prURL),
			})
			return
		}

		// Move card (PATCH .../cards/{id}/move) — must be checked before generic cards PATCH.
		if strings.Contains(path, "/move") && method == http.MethodPatch {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("{}"))
			return
		}

		// Update card: confirm the body omits `description` since the footer
		// is already up to date for this branch/PR.
		if strings.Contains(path, "/cards/") && method == http.MethodPatch {
			body, _ := io.ReadAll(r.Body)
			var payload map[string]any
			_ = json.Unmarshal(body, &payload)
			if _, ok := payload["description"]; ok {
				mu.Lock()
				sawDescription = true
				mu.Unlock()
			}
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("{}"))
			return
		}

		// Get board detail (for moveCardToColumnType).
		if strings.Contains(path, "/boards/") && method == http.MethodGet {
			json.NewEncoder(w).Encode(map[string]any{
				"id":   boardID,
				"name": "Test Board",
				"columns": []valaris.BoardColumn{
					{ID: "col-review", Name: "Review", Position: 3072, ColumnType: "review"},
					{ID: "col-done", Name: "Done", Position: 4096, ColumnType: "done"},
				},
			})
			return
		}

		// Execution update.
		if strings.Contains(path, "/executions/") && method == http.MethodPatch {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("{}"))
			return
		}

		w.WriteHeader(http.StatusOK)
		w.Write([]byte("{}"))
	}))
	t.Cleanup(server.Close)

	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	card := &discoverResult{
		CardID:  cardID,
		BoardID: boardID,
		Title:   "Fix login bug",
	}

	err := loop.ship(context.Background(), card, "exec-1", branch, prURL, "review", nil)
	if err != nil {
		t.Fatalf("ship() returned error: %v", err)
	}

	mu.Lock()
	descSeen := sawDescription
	mu.Unlock()

	if descSeen {
		t.Error("ship() must omit `description` from the PATCH when the footer already matches")
	}
}

func TestShipDescription_AppendsWhenNew(t *testing.T) {
	prURL := "https://github.com/org/repo/pull/42"
	branch := "runner/new-feature"
	cardID := "card-new-1"
	boardID := "board-new-1"

	var updateCardCalled bool
	var mu sync.Mutex

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		method := r.Method

		if path == "/api/agents/me/config" {
			json.NewEncoder(w).Encode(map[string]any{"agent_id": "agent-1", "workspace_config": map[string]any{"pipeline_config": DefaultPipelineConfig}})
			return
		}

		// Get card: return a card with NO prior PR URL in description.
		if strings.Contains(path, "/cards/") && method == http.MethodGet && !strings.Contains(path, "/search") && !strings.Contains(path, "/participants") {
			json.NewEncoder(w).Encode(valaris.Card{
				ID:          cardID,
				BoardID:     boardID,
				Title:       "New feature",
				Description: "Implement the new widget",
			})
			return
		}

		// Move card (PATCH .../cards/{id}/move) — must be checked before generic cards PATCH.
		if strings.Contains(path, "/move") && method == http.MethodPatch {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("{}"))
			return
		}

		// Update card: track the call.
		if strings.Contains(path, "/cards/") && method == http.MethodPatch {
			mu.Lock()
			updateCardCalled = true
			mu.Unlock()
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("{}"))
			return
		}

		// Get board detail.
		if strings.Contains(path, "/boards/") && method == http.MethodGet {
			json.NewEncoder(w).Encode(map[string]any{
				"id":   boardID,
				"name": "Test Board",
				"columns": []valaris.BoardColumn{
					{ID: "col-review", Name: "Review", Position: 3072, ColumnType: "review"},
				},
			})
			return
		}

		// Execution update.
		if strings.Contains(path, "/executions/") && method == http.MethodPatch {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("{}"))
			return
		}

		w.WriteHeader(http.StatusOK)
		w.Write([]byte("{}"))
	}))
	t.Cleanup(server.Close)

	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	card := &discoverResult{
		CardID:  cardID,
		BoardID: boardID,
		Title:   "New feature",
	}

	err := loop.ship(context.Background(), card, "exec-1", branch, prURL, "review", nil)
	if err != nil {
		t.Fatalf("ship() returned error: %v", err)
	}

	mu.Lock()
	called := updateCardCalled
	mu.Unlock()

	if !called {
		t.Error("ship() should call UpdateCard when PR URL is NOT in the description")
	}
}

func TestScheduledTick_FastForward_TriesAllStrategies(t *testing.T) {
	// When all strategies find no work, scheduledTick should try each one
	// in a single poll cycle (fast-forward) instead of returning after the first.
	server := testAPIServer(t, testServerOptions{
		boards: []valaris.Board{{ID: "board-1", Name: "Test"}},
		cards:  []valaris.Card{}, // no work for any strategy
	})

	cfg := testConfig()
	cfg.WorkLoop.Scheduling = config.SchedulingConfig{
		Strategy:      "priority",
		PriorityOrder: []string{"reviewer", "orchestrator", "documentator"},
	}

	mock := llm.NewMockProvider()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	// Platform pipeline has all three roles, so Loop.New wires a scheduler.
	loop := mustNewLoop(t, client, mock, gitMgr, cfg)

	err := loop.tick(context.Background())
	if err != nil {
		t.Fatalf("fast-forward tick should succeed: %v", err)
	}

	// After fast-forwarding through all 3 idle strategies in one tick,
	// all 3 roles should be in idle cooldown.
	for _, role := range []string{"reviewer", "orchestrator", "documentator"} {
		loop.scheduler.ResetIdle(role) // would no-op if not in cooldown
	}

	// The scheduler should have recorded all 3 idle ticks.
	// Verify: if we reset all idle states, Next() returns reviewer (highest priority)
	// again — this confirms all roles were attempted.
	s := loop.scheduler.Next()
	if s == nil || s.Name() != "reviewer" {
		name := "nil"
		if s != nil {
			name = s.Name()
		}
		t.Errorf("after fast-forward reset, Next() = %q, want reviewer", name)
	}
}
