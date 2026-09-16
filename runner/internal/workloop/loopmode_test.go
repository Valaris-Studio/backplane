// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// loopModeTestConfig returns a *config.Config with the fields LoopMode.Run
// actually reads, mirroring testConfig()'s tone but scoped to loop mode's
// needs (Git.BaseDir must be a real tmp dir since Run calls os.MkdirAll).
func loopModeTestConfig(t *testing.T) *config.Config {
	t.Helper()
	cfg := testConfig()
	cfg.Git.BaseDir = t.TempDir()
	return cfg
}

// loopConfigJSON marshals a BoardLoopConfig the way the platform would serve
// it from GET .../loop.
func loopConfigJSON(t *testing.T, cfg valaris.BoardLoopConfig) string {
	t.Helper()
	b, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal loop config: %v", err)
	}
	return string(b)
}

// baseLoopConfig returns a permissive, always-enabled loop config a test can
// tweak per-iteration. Rails are set generously wide so only the behavior
// under test trips them.
func baseLoopConfig() valaris.BoardLoopConfig {
	return valaris.BoardLoopConfig{
		Enabled:                 true,
		LoopPrompt:              "iteration {{.Iteration}}",
		SystemPrompt:            "you are the loop agent",
		MaxIterations:           25,
		IterationDelaySeconds:   0,
		IterationTimeoutSeconds: 3600,
		BudgetUSD:               20.0,
		MaxConsecutiveFailures:  3,
		StarvationPolicy:        "park", // the backend's documented default
	}
}

// loopModeServer builds an httptest server serving a scripted sequence of
// GET .../loop responses (one per call, the last one repeats once exhausted)
// and recording every PATCH .../loop/state body. Execution start/update and
// heartbeat endpoints return 200 {} by default so those non-fatal calls
// don't error unless the test overrides via failExecutions/failHeartbeat.
//
// executionStarts/executionUpdates record the wire bodies POSTed/PATCHed to
// .../executions and .../executions/{id} respectively, so tests can assert on
// exactly what LoopMode told the platform — provider/model at start,
// tokens_used/cost_usd/duration_seconds at completion — independent of
// whichever client method/helper name the implementation ends up using.
type loopModeServer struct {
	mu               sync.Mutex
	getLoopBodies    []string
	getLoopCalls     int
	patches          []map[string]any
	executionStarts  []map[string]any
	executionUpdates []map[string]any
	failExecutions   bool
	failHeartbeat    bool
	// rejectLoopState makes the heartbeat 422 when the body carries this
	// loop_state, modelling a backend whose Literal predates the value (the
	// WS/HTTP schemas reject unknown enum members rather than ignoring them).
	rejectLoopState string
	heartbeats      int
	// heartbeatBodies records every POST .../heartbeat body, nil for a
	// body-less tick. Loop state now rides the heartbeat (card 442ff0f2), so
	// "did it beat?" is no longer the whole assertion — "what did it say?" is.
	heartbeatBodies []map[string]any
	// readinessBodies scripts GET .../loop/readiness one body per call (last
	// repeats). Empty => a default actionable payload, so pre-existing tests
	// that never think about parking keep running their sessions.
	readinessBodies []string
	readinessCalls  int
	// boardSkillsBody scripts GET .../boards/{id}/skills. Empty => an empty
	// set, so pre-existing loop tests materialize nothing.
	boardSkillsBody  string
	boardSkillsCalls int
	readiness404     bool // pre-rollout backend: no such route
	readiness500     bool // transient probe failure
	// historyBody scripts GET .../loop/history. Empty => zero history, the
	// no-prior-runs default every pre-existing test assumes.
	historyBody  string
	history404   bool
	history500   bool
	historyCalls int
	// failPatch makes PATCH .../loop/state return 500 — the board keeps the
	// loop ENABLED even though the runner tried to turn it off.
	failPatch bool
	// searchBodies scripts GET .../cards/search one body per call (last
	// repeats) for completion_query evaluation; empty => an empty card list,
	// which reads as "run complete" only for loops that set the query at all.
	// searchQueries records each call's raw query string so tests can prove
	// the runner sent the configured filters and not a wider search.
	searchBodies  []string
	searchQueries []string
	search500     bool
	// denyOffSwitchProbe makes the off-switch callability probe (an idempotent
	// PATCH .../loop/state re-asserting the CURRENT state) come back 403 —
	// the "granted but uncallable" shape card ba778abd root-caused, which the
	// allowlist-only pre-flight is structurally blind to.
	denyOffSwitchProbe bool
	probeCalls         int
	srv                *httptest.Server
}

// offSwitchProbes reports how many callability probes reached the server.
func (s *loopModeServer) offSwitchProbes() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.probeCalls
}

// statePatches returns a copy of every PATCH .../loop/state body observed.
func (s *loopModeServer) statePatches() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]map[string]any, len(s.patches))
	copy(out, s.patches)
	return out
}

func newLoopModeServer(t *testing.T, getLoopBodies ...string) *loopModeServer {
	t.Helper()
	s := &loopModeServer{getLoopBodies: getLoopBodies}
	s.srv = httptest.NewServer(http.HandlerFunc(s.handle))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *loopModeServer) handle(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	switch {
	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/loop/history"):
		s.historyCalls++
		if s.history404 {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"detail":"Not Found"}`))
			return
		}
		if s.history500 {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"detail":"boom"}`))
			return
		}
		body := s.historyBody
		if body == "" {
			body = `{"iteration_count":0,"spent_usd":0,"lifetime_spent_usd":0,"budget_epoch":null}`
		}
		_, _ = w.Write([]byte(body))
	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/loop/readiness"):
		if s.readiness404 {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"detail":"Not Found"}`))
			return
		}
		if s.readiness500 {
			s.readinessCalls++
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"detail":"boom"}`))
			return
		}
		idx := s.readinessCalls
		s.readinessCalls++
		if len(s.readinessBodies) == 0 {
			_, _ = w.Write([]byte(readinessJSON(true, 1, 0, 0, 0)))
			return
		}
		if idx >= len(s.readinessBodies) {
			idx = len(s.readinessBodies) - 1
		}
		_, _ = w.Write([]byte(s.readinessBodies[idx]))
	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/cards/search"):
		idx := len(s.searchQueries)
		s.searchQueries = append(s.searchQueries, r.URL.RawQuery)
		if s.search500 {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"detail":"boom"}`))
			return
		}
		if len(s.searchBodies) == 0 {
			_, _ = w.Write([]byte(`[]`))
			return
		}
		if idx >= len(s.searchBodies) {
			idx = len(s.searchBodies) - 1
		}
		_, _ = w.Write([]byte(s.searchBodies[idx]))
	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/loop"):
		idx := s.getLoopCalls
		if idx >= len(s.getLoopBodies) {
			idx = len(s.getLoopBodies) - 1
		}
		s.getLoopCalls++
		if idx < 0 {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"detail":"not configured"}`))
			return
		}
		_, _ = w.Write([]byte(s.getLoopBodies[idx]))
	case r.Method == http.MethodPatch && strings.HasSuffix(r.URL.Path, "/loop/state"):
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		// The probe re-asserts enabled=true against an already-enabled loop; a
		// real stop sends enabled=false. The probe is counted separately and
		// kept OUT of s.patches because it is a no-op by construction — folding
		// it in would make every existing "what did the runner turn off?"
		// assertion read a write that never changed anything. Only the probe is
		// subject to denyOffSwitchProbe, so a test can refuse the pre-flight
		// without also breaking the runner's actual off-switch.
		if enabled, ok := body["enabled"].(bool); ok && enabled {
			s.probeCalls++
			if s.denyOffSwitchProbe {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"detail":"Forbidden"}`))
				return
			}
			_, _ = w.Write([]byte(`{}`))
			return
		}
		s.patches = append(s.patches, body)
		if s.failPatch {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"detail":"boom"}`))
			return
		}
		_, _ = w.Write([]byte(`{}`))
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/executions"):
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		s.executionStarts = append(s.executionStarts, body)
		if s.failExecutions {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"detail":"boom"}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"exec-1"}`))
	case r.Method == http.MethodPatch && strings.Contains(r.URL.Path, "/executions/"):
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		s.executionUpdates = append(s.executionUpdates, body)
		if s.failExecutions {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"detail":"boom"}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"exec-1"}`))
	case strings.Contains(r.URL.Path, "/executions"):
		if s.failExecutions {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"detail":"boom"}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"exec-1"}`))
	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/skills"):
		s.boardSkillsCalls++
		if s.boardSkillsBody == "" {
			_, _ = w.Write([]byte(`{"skills":[]}`))
			return
		}
		_, _ = w.Write([]byte(s.boardSkillsBody))
	case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/skills/") && strings.Contains(r.URL.Path, "/versions/"):
		_, _ = w.Write([]byte(`{"version":1,"content_hash":"hash-loop","files":[{"path":"SKILL.md","content":"# Loop Skill\n"}]}`))
	case strings.Contains(r.URL.Path, "/heartbeat"):
		s.heartbeats++
		var hb map[string]any
		if err := json.NewDecoder(r.Body).Decode(&hb); err != nil {
			hb = nil
		}
		s.heartbeatBodies = append(s.heartbeatBodies, hb)
		if s.rejectLoopState != "" && hb != nil && hb["loop_state"] == s.rejectLoopState {
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"detail":[{"loc":["body","loop_state"],"msg":"unexpected value"}]}`))
			return
		}
		if s.failHeartbeat {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"detail":"boom"}`))
			return
		}
		_, _ = w.Write([]byte(`{}`))
	default:
		_, _ = w.Write([]byte(`{}`))
	}
}

func readinessJSON(actionable bool, ready, blocked, awaiting, reviewPRs int) string {
	return fmt.Sprintf(
		`{"ready_count":%d,"blocked_count":%d,"awaiting_merge_count":%d,"review_open_pr_count":%d,"actionable":%t}`,
		ready, blocked, awaiting, reviewPRs, actionable,
	)
}

func (s *loopModeServer) readinessCallCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readinessCalls
}

func (s *loopModeServer) heartbeatCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.heartbeats
}

// heartbeatBodyAt returns the i'th (0-indexed) heartbeat body, or nil for a
// body-less tick or an index past the end.
func (s *loopModeServer) heartbeatBodyAt(i int) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	if i >= len(s.heartbeatBodies) {
		return nil
	}
	return s.heartbeatBodies[i]
}

func (s *loopModeServer) executionStartCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.executionStarts)
}

func (s *loopModeServer) getLoopCallCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.getLoopCalls
}

func (s *loopModeServer) searchQueryAt(i int) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if i >= len(s.searchQueries) {
		return ""
	}
	return s.searchQueries[i]
}

func (s *loopModeServer) searchCallCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.searchQueries)
}

func (s *loopModeServer) patchCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.patches)
}

func (s *loopModeServer) lastPatch() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.patches) == 0 {
		return nil
	}
	return s.patches[len(s.patches)-1]
}

// lastExecutionStart returns the most recent POST .../executions body, or nil
// if none happened yet.
func (s *loopModeServer) lastExecutionStart() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.executionStarts) == 0 {
		return nil
	}
	return s.executionStarts[len(s.executionStarts)-1]
}

// executionUpdateAt returns the i'th (0-indexed) PATCH .../executions/{id}
// body, or nil if fewer than i+1 updates have happened.
func (s *loopModeServer) executionUpdateAt(i int) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	if i >= len(s.executionUpdates) {
		return nil
	}
	return s.executionUpdates[i]
}

func (s *loopModeServer) executionUpdateCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.executionUpdates)
}

// scriptedProvider is a local llm.Provider test double for scenarios
// MockProvider cannot express: per-call CostUSD and a mixed
// fail/fail/succeed/fail script (MockProvider.FailWith fails ALL calls,
// with no way to interleave successes).
type scriptedProvider struct {
	mu      sync.Mutex
	results []scriptedResult
	calls   int
	name    string
	opts    []llm.Options // Options captured per call, for cap assertions
}

type scriptedResult struct {
	result *llm.Result
	err    error
}

func (p *scriptedProvider) Name() string {
	if p.name != "" {
		return p.name
	}
	return "scripted"
}

func (p *scriptedProvider) Execute(_ context.Context, _ string, opts llm.Options) (*llm.Result, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.opts = append(p.opts, opts)
	if p.calls >= len(p.results) {
		return nil, fmt.Errorf("scriptedProvider: no more scripted results (call #%d)", p.calls+1)
	}
	r := p.results[p.calls]
	p.calls++
	return r.result, r.err
}

func (p *scriptedProvider) optionsAt(i int) llm.Options {
	p.mu.Lock()
	defer p.mu.Unlock()
	if i >= len(p.opts) {
		return llm.Options{}
	}
	return p.opts[i]
}

func (p *scriptedProvider) callCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls
}

func newLoopModeForServer(t *testing.T, srv *loopModeServer, provider llm.Provider) *LoopMode {
	t.Helper()
	cfg := loopModeTestConfig(t)
	client := testClientWithURL(srv.srv.URL)
	m := NewLoopMode(client, cfg, nil, provider, "acme", "board-1", "agent-1")
	// Scheduling fixtures model a qualified MCP. The generation/preflight
	// regression constructs NewLoopMode directly and exercises real stdio.
	m.completionMCPCheck = func(context.Context, string, string, string, *valaris.BoardLoopConfig) (MCPLaunchReport, error) {
		return MCPLaunchReport{Version: "fixture"}, nil
	}
	return m
}

// TestLoopMode_DisabledAtFetch_CleanExit proves a loop that is disabled the
// very first time it's fetched exits Run cleanly with zero provider calls
// and zero PATCH .../loop/state calls — the runner only observes, it never
// flips a flag that's already off.
func TestLoopMode_DisabledAtFetch_CleanExit(t *testing.T) {
	disabled := baseLoopConfig()
	disabled.Enabled = false
	srv := newLoopModeServer(t, loopConfigJSON(t, disabled))
	provider := llm.NewMockProvider()
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 0 {
		t.Errorf("provider called %d times, want 0", provider.CallCount())
	}
	if srv.patchCount() != 0 {
		t.Errorf("PATCH .../loop/state called %d times, want 0", srv.patchCount())
	}
}

// TestLoopMode_EnabledThenDisabled_ExitsAfterOneIteration proves the loop
// re-fetches config each iteration: enabled on GET #1, disabled on GET #2.
// Exactly one provider call runs; Run exits cleanly because the platform
// toggled it off, not because a runner rail tripped — no PATCH expected.
func TestLoopMode_EnabledThenDisabled_ExitsAfterOneIteration(t *testing.T) {
	enabled := baseLoopConfig()
	disabled := baseLoopConfig()
	disabled.Enabled = false
	srv := newLoopModeServer(t, loopConfigJSON(t, enabled), loopConfigJSON(t, disabled))
	provider := llm.NewMockProvider("iteration output")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 1 {
		t.Errorf("provider called %d times, want 1", provider.CallCount())
	}
	if srv.patchCount() != 0 {
		t.Errorf("PATCH .../loop/state called %d times, want 0 (platform-side toggle, not a runner rail)", srv.patchCount())
	}
}

// TestLoopMode_RefetchesConfigEachIteration proves an operator edit to
// loop_prompt between iterations takes effect on the very next iteration
// without a runner restart — each iteration renders ITS OWN fetched config.
func TestLoopMode_RefetchesConfigEachIteration(t *testing.T) {
	first := baseLoopConfig()
	first.LoopPrompt = "first prompt, iteration {{.Iteration}}"
	second := baseLoopConfig()
	second.LoopPrompt = "second prompt, iteration {{.Iteration}}"
	third := baseLoopConfig()
	third.Enabled = false
	srv := newLoopModeServer(t, loopConfigJSON(t, first), loopConfigJSON(t, second), loopConfigJSON(t, third))
	provider := llm.NewMockProvider("out1", "out2")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 2 {
		t.Fatalf("provider called %d times, want 2", provider.CallCount())
	}
	call0 := provider.Calls[0].Prompt
	call1 := provider.Calls[1].Prompt
	if call0 == call1 {
		t.Fatalf("expected distinct prompts per iteration, both were %q", call0)
	}
	if !strings.Contains(call0, "first prompt, iteration 1") {
		t.Errorf("call0 prompt = %q, want to contain %q", call0, "first prompt, iteration 1")
	}
	if !strings.Contains(call1, "second prompt, iteration 2") {
		t.Errorf("call1 prompt = %q, want to contain %q", call1, "second prompt, iteration 2")
	}
}

// TestLoopMode_404OnFetch_FatalError proves a board with no loop config
// (backend never configured / pre-rollout) is a fatal Run error carrying the
// ErrLoopNotConfigured sentinel and actionable text, not a silent no-op.
func TestLoopMode_404OnFetch_FatalError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"detail":"not found"}`))
	}))
	defer server.Close()

	cfg := loopModeTestConfig(t)
	client := testClientWithURL(server.URL)
	m := NewLoopMode(client, cfg, nil, llm.NewMockProvider(), "acme", "board-1", "agent-1")

	err := m.Run(context.Background())
	if err == nil {
		t.Fatal("expected a fatal error")
	}
	if !errors.Is(err, valaris.ErrLoopNotConfigured) {
		t.Fatalf("expected errors.Is match on ErrLoopNotConfigured, got: %v", err)
	}
	if !strings.Contains(err.Error(), "loop config") && !strings.Contains(err.Error(), "loop mode") {
		t.Errorf("error message not actionable: %q", err.Error())
	}
}

// TestLoopMode_MaxIterationsRail proves that once max_iterations is reached,
// the TOP of the next iteration trips the rail before running another
// session: exactly one PATCH disables with a reason naming max_iterations,
// and Run returns nil (a tripped rail is a normal, successful stop).
func TestLoopMode_MaxIterationsRail(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := llm.NewMockProvider("only response")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 1 {
		t.Errorf("provider called %d times, want 1", provider.CallCount())
	}
	if srv.patchCount() != 1 {
		t.Fatalf("PATCH .../loop/state called %d times, want 1", srv.patchCount())
	}
	patch := srv.lastPatch()
	if enabled, _ := patch["enabled"].(bool); enabled {
		t.Error("expected enabled=false in the disable PATCH")
	}
	if reason, _ := patch["reason"].(string); reason != "max_iterations reached (1)" {
		t.Errorf("reason = %q, want legacy reason unchanged", reason)
	}
	if code, _ := patch["reason_code"].(string); code != "max_iterations_reached" {
		t.Errorf("reason_code = %q, want max_iterations_reached", code)
	}
	params, ok := patch["reason_params"].(map[string]any)
	if !ok {
		t.Fatalf("reason_params = %T, want object", patch["reason_params"])
	}
	if params["max_iterations"] != float64(1) {
		t.Errorf("reason_params = %v, want max_iterations=1", params)
	}
	if _, present := patch["diagnostic"]; present {
		t.Errorf("diagnostic = %v, want omitted when no diagnostic exists", patch["diagnostic"])
	}
}

// TestLoopMode_BudgetRail proves cumulative estimated cost (derived from
// token counts via the shared estimateCostWith/priceFor rate sheet, since
// MockProvider has no per-call CostUSD override) tripping budget_usd disables
// the loop with an actionable reason.
func TestLoopMode_BudgetRail(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.BudgetUSD = 0.0001 // trivially small so one iteration's token cost exceeds it
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := llm.NewMockProvider("expensive output")
	provider.InputTokens = 100_000
	provider.OutputTokens = 100_000
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 1 {
		t.Errorf("provider called %d times, want 1", provider.CallCount())
	}
	if srv.patchCount() != 1 {
		t.Fatalf("PATCH .../loop/state called %d times, want 1", srv.patchCount())
	}
	patch := srv.lastPatch()
	wantSpent := estimateCostWith(priceFor(provider.Name(), ""), provider.InputTokens, provider.OutputTokens, 0, 0)
	wantReason := fmt.Sprintf("budget_usd exhausted ($%.2f of $%.2f)", wantSpent, cfg.BudgetUSD)
	if reason, _ := patch["reason"].(string); reason != wantReason {
		t.Errorf("reason = %q, want legacy reason %q", reason, wantReason)
	}
	if code, _ := patch["reason_code"].(string); code != "budget_exhausted" {
		t.Errorf("reason_code = %q, want budget_exhausted", code)
	}
	params, ok := patch["reason_params"].(map[string]any)
	if !ok {
		t.Fatalf("reason_params = %T, want object", patch["reason_params"])
	}
	if params["spent_usd"] != wantSpent || params["budget_usd"] != cfg.BudgetUSD {
		t.Errorf("reason_params = %v, want spent_usd=%v budget_usd=%v", params, wantSpent, cfg.BudgetUSD)
	}
	if _, present := patch["diagnostic"]; present {
		t.Errorf("diagnostic = %v, want omitted when no diagnostic exists", patch["diagnostic"])
	}
}

// TestLoopMode_ConsecutiveFailuresRail proves N consecutive failed
// iterations (provider errors) trip max_consecutive_failures with an
// actionable disable reason.
func TestLoopMode_ConsecutiveFailuresRail(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxConsecutiveFailures = 2
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := &scriptedProvider{results: []scriptedResult{
		{result: &llm.Result{ExitCode: 1}, err: errors.New("boom 1")},
		{result: &llm.Result{ExitCode: 1}, err: errors.New("boom 2")},
	}}
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.callCount() != 2 {
		t.Errorf("provider called %d times, want 2", provider.callCount())
	}
	if srv.patchCount() != 1 {
		t.Fatalf("PATCH .../loop/state called %d times, want 1", srv.patchCount())
	}
	patch := srv.lastPatch()
	if reason, _ := patch["reason"].(string); reason != "2 consecutive failed iterations" {
		t.Errorf("reason = %q, want legacy reason unchanged", reason)
	}
	if code, _ := patch["reason_code"].(string); code != "consecutive_failures" {
		t.Errorf("reason_code = %q, want consecutive_failures", code)
	}
	params, ok := patch["reason_params"].(map[string]any)
	if !ok {
		t.Fatalf("reason_params = %T, want object", patch["reason_params"])
	}
	if params["count"] != float64(2) {
		t.Errorf("reason_params = %v, want count=2", params)
	}
	if _, present := patch["diagnostic"]; present {
		t.Errorf("diagnostic = %v, want omitted when no diagnostic exists", patch["diagnostic"])
	}
}

// TestLoopMode_SuccessResetsFailureCounter proves a success between two
// failures resets the consecutive-failure count, so the rail does NOT trip
// even though total failures (3) would exceed max_consecutive_failures (2)
// if counted cumulatively instead of consecutively.
func TestLoopMode_SuccessResetsFailureCounter(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxConsecutiveFailures = 2
	cfg.MaxIterations = 3
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := &scriptedProvider{results: []scriptedResult{
		{result: &llm.Result{ExitCode: 1}, err: errors.New("boom 1")},
		{result: &llm.Result{Output: "recovered", ExitCode: 0}, err: nil},
		{result: &llm.Result{ExitCode: 1}, err: errors.New("boom 2")},
	}}
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	// max_iterations=3 trips at the top of iteration 4, after all 3 scripted
	// calls ran — proving the failure rail never fired despite 2 total failures.
	if provider.callCount() != 3 {
		t.Errorf("provider called %d times, want 3", provider.callCount())
	}
	if srv.patchCount() != 1 {
		t.Fatalf("PATCH .../loop/state called %d times, want 1", srv.patchCount())
	}
	reason, _ := srv.lastPatch()["reason"].(string)
	if !strings.Contains(reason, "max_iterations") {
		t.Errorf("reason = %q, want max_iterations (not a failure-rail trip)", reason)
	}
}

// TestLoopMode_TierRemap proves cfg.Model="premium" (a tier alias) routes
// through llm.tier_providers to the mapped local provider, not the default —
// and that the alias itself is NEVER forwarded as the session's model id.
// Unlike pipeline assignments (where the backend pre-resolves tiers to
// concrete model ids before the runner sees them), loop configs are served
// verbatim, so without runner-side substitution the session would exec
// `claude --model premium` and fail every iteration. A tier alias is
// provider-routing intent; the runnable model is the runner's own configured
// llm.model.
func TestLoopMode_TierRemap(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.Model = "premium"
	cfg.MaxIterations = 1 // deterministic single-iteration run via the max_iterations rail
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))

	defaultProvider := llm.NewMockProvider("default response")
	mockBResponses := llm.NewMockProvider("tier response")
	mockBResponses.NameOverride = "mock-b"

	tcfg := loopModeTestConfig(t)
	tcfg.LLM.Model = "sonnet-runner-configured"
	tcfg.LLM.TierProviders = map[string][]string{"premium": {"mock-b"}}

	client := testClientWithURL(srv.srv.URL)
	providers := map[string]llm.Provider{"mock-b": mockBResponses}
	m := NewLoopMode(client, tcfg, providers, defaultProvider, "acme", "board-1", "agent-1")

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if defaultProvider.CallCount() != 0 {
		t.Errorf("default provider called %d times, want 0 (should have routed to the tier-mapped provider)", defaultProvider.CallCount())
	}
	if mockBResponses.CallCount() != 1 {
		t.Fatalf("tier-mapped provider called %d times, want 1", mockBResponses.CallCount())
	}
	gotModel := mockBResponses.Calls[0].Options.Model
	if gotModel != "sonnet-runner-configured" {
		t.Errorf("model sent = %q, want runner's configured model %q (a tier alias must never reach the coding agent as a model id)", gotModel, "sonnet-runner-configured")
	}
}

// TestLoopMode_TierRemap_ModelFollowsProviderWhenBackendNamesOne proves the
// substitution DOES fire when BoardLoopConfig.Provider is non-empty and the
// tier remap routes to a DIFFERENT provider than the one named — the
// documented model-follows-provider case (spec point 4), as distinct from
// the previous test's dispatch.Provider=="" short-circuit.
func TestLoopMode_TierRemap_ModelFollowsProviderWhenBackendNamesOne(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.Provider = "claude-cli"
	cfg.Model = "premium"
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))

	defaultProvider := llm.NewMockProvider("default response")
	defaultProvider.NameOverride = "claude-cli"
	mockBResponses := llm.NewMockProvider("tier response")
	mockBResponses.NameOverride = "mock-b"

	tcfg := loopModeTestConfig(t)
	tcfg.LLM.Model = "sonnet-runner-configured"
	tcfg.LLM.TierProviders = map[string][]string{"premium": {"mock-b"}}

	client := testClientWithURL(srv.srv.URL)
	providers := map[string]llm.Provider{"claude-cli": defaultProvider, "mock-b": mockBResponses}
	m := NewLoopMode(client, tcfg, providers, defaultProvider, "acme", "board-1", "agent-1")

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if mockBResponses.CallCount() != 1 {
		t.Fatalf("tier-mapped provider called %d times, want 1", mockBResponses.CallCount())
	}
	gotModel := mockBResponses.Calls[0].Options.Model
	if gotModel != "sonnet-runner-configured" {
		t.Errorf("model sent = %q, want runner's configured model %q (model-follows-provider fires when the backend named a provider that diverged)", gotModel, "sonnet-runner-configured")
	}
}

// TestLoopMode_TemplateRendering proves {{.Iteration}} and the system prompt
// both land in the provider call exactly where expected.
func TestLoopMode_TemplateRendering(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.LoopPrompt = "iteration {{.Iteration}} on board {{.BoardID}}"
	cfg.SystemPrompt = "system directive for the loop agent"
	cfg.MaxIterations = 1 // deterministic single-iteration run via the max_iterations rail
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := llm.NewMockProvider("ok")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 1 {
		t.Fatalf("provider called %d times, want 1", provider.CallCount())
	}
	call := provider.Calls[0]
	if !strings.Contains(call.Prompt, "iteration 1 on board board-1") {
		t.Errorf("prompt = %q, want it to contain rendered iteration/board", call.Prompt)
	}
	if call.Options.SystemPrompt != "system directive for the loop agent" {
		t.Errorf("SystemPrompt = %q", call.Options.SystemPrompt)
	}
}

// TestLoopMode_ToolsAndMCPConfigForwarded proves cfg.Tools (the platform
// allowlist) and the runner's own MCPConfigPath both reach Options verbatim.
func TestLoopMode_ToolsAndMCPConfigForwarded(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.Tools = []string{"mcp__valaris__get_card", "mcp__valaris__update_card"}
	cfg.MaxIterations = 1 // deterministic single-iteration run via the max_iterations rail
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := llm.NewMockProvider("ok")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 1 {
		t.Fatalf("provider called %d times, want 1", provider.CallCount())
	}
	call := provider.Calls[0]
	if len(call.Options.AllowedTools) != 2 || call.Options.AllowedTools[0] != "mcp__valaris__get_card" {
		t.Errorf("AllowedTools = %v, want %v", call.Options.AllowedTools, cfg.Tools)
	}
	if call.Options.MCPConfigPath != "/tmp/mcp.json" {
		t.Errorf("MCPConfigPath = %q, want the runner-configured path", call.Options.MCPConfigPath)
	}
}

// TestLoopMode_ToolManifestAppendedToPrompt proves the loop agent is TOLD
// what it was granted. Sixteen field-report iterations reported set_board_loop as
// unavailable while it was allowlisted the whole time — keyword tool search
// missed it and the prompt never named it.
func TestLoopMode_ToolManifestAppendedToPrompt(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.LoopPrompt = "do the work"
	cfg.Tools = []string{"mcp__valaris__set_board_loop", "Bash"}
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := llm.NewMockProvider("ok")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 1 {
		t.Fatalf("provider called %d times, want 1", provider.CallCount())
	}
	prompt := provider.Calls[0].Prompt
	if !strings.HasPrefix(prompt, "do the work") {
		t.Errorf("prompt = %q, want the rendered template preserved at the front", prompt)
	}
	for _, want := range []string{
		"## Tools available",
		"mcp__valaris__set_board_loop",
		"Bash",
		`ToolSearch("select:<name>")`,
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt = %q, want it to contain %q", prompt, want)
		}
	}
}

// TestLoopMode_NoToolManifestWhenAllowlistEmpty proves a board that grants no
// explicit allowlist STILL gets the manifest section and, above all, the
// ToolSearch escape-hatch line. Suppressing it was the old behavior and it is
// precisely backwards: an empty allowlist is the case where an agent is most
// likely to conclude a tool does not exist when it merely was not surfaced.
func TestLoopMode_ToolManifestEscapeHatchSurvivesEmptyAllowlist(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.LoopPrompt = "do the work"
	cfg.Tools = nil
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := llm.NewMockProvider("ok")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 1 {
		t.Fatalf("provider called %d times, want 1", provider.CallCount())
	}
	prompt := provider.Calls[0].Prompt
	if !strings.HasPrefix(prompt, "do the work") {
		t.Errorf("prompt = %q, want the rendered template preserved at the front", prompt)
	}
	for _, want := range []string{
		"## Tools available",
		`ToolSearch("select:<name>")`,
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt = %q, want it to contain %q", prompt, want)
		}
	}
}

// TestToolManifest_EscapeHatchAlwaysPresent pins the unit-level contract for
// both allowlist shapes: the escape hatch is unconditional, and a non-empty
// allowlist still enumerates every granted tool.
func TestToolManifest_EscapeHatchAlwaysPresent(t *testing.T) {
	for _, tc := range []struct {
		name  string
		tools []string
		want  []string
	}{
		{
			name:  "empty allowlist still carries the section and escape hatch",
			tools: nil,
			want:  []string{"## Tools available", `ToolSearch("select:<name>")`},
		},
		{
			name:  "granted tools are enumerated alongside the escape hatch",
			tools: []string{"mcp__valaris__set_board_loop", "Bash"},
			want: []string{
				"## Tools available",
				"mcp__valaris__set_board_loop",
				"Bash",
				`ToolSearch("select:<name>")`,
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := toolManifest(tc.tools)
			for _, want := range tc.want {
				if !strings.Contains(got, want) {
					t.Errorf("toolManifest(%v) = %q, want it to contain %q", tc.tools, got, want)
				}
			}
		})
	}
}

// TestLoopMode_OffSwitchPreflight covers the loop-start pre-flight: when the
// board's allowlist omits set_board_loop the runner cannot self-disable, so a
// safety rail becomes the only stop. Loop #1 burned ~12 premium sessions on
// exactly that failure while it was invisible in the logs.
func TestLoopMode_OffSwitchPreflight(t *testing.T) {
	for _, tc := range []struct {
		name     string
		tools    []string
		wantWarn bool
	}{
		{name: "allowlist omits the off-switch", tools: []string{"Bash", "Read"}, wantWarn: true},
		{name: "empty allowlist", tools: nil, wantWarn: true},
		{name: "allowlist grants the off-switch", tools: []string{"Bash", offSwitchTool}, wantWarn: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := baseLoopConfig()
			cfg.Tools = tc.tools
			cfg.MaxIterations = 1
			srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
			provider := llm.NewMockProvider("ok")
			m := newLoopModeForServer(t, srv, provider)

			var buf strings.Builder
			prev := slog.Default()
			slog.SetDefault(slog.New(slog.NewTextHandler(&lockedWriter{mu: &sync.Mutex{}, b: &buf}, &slog.HandlerOptions{Level: slog.LevelDebug})))
			t.Cleanup(func() { slog.SetDefault(prev) })

			if err := m.Run(context.Background()); err != nil {
				t.Fatalf("Run: %v", err)
			}
			// Non-fatal: the loop must still run its iteration either way.
			if provider.CallCount() != 1 {
				t.Errorf("provider called %d times, want 1 — the pre-flight must not stop the loop", provider.CallCount())
			}

			got := strings.Count(buf.String(), offSwitchPreflightWarning)
			want := 0
			if tc.wantWarn {
				want = 1
			}
			if got != want {
				t.Errorf("off-switch pre-flight warning appeared %d times, want %d; log: %s", got, want, buf.String())
			}
			if tc.wantWarn && !strings.Contains(buf.String(), "level=WARN") {
				t.Errorf("pre-flight must be slog.Warn (level=WARN); log: %s", buf.String())
			}
		})
	}
}

// TestLoopMode_OffSwitchPreflight_FiresOncePerRun proves the warning is a
// run-scoped diagnostic, not per-iteration log spam.
func TestLoopMode_OffSwitchPreflight_FiresOncePerRun(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.Tools = []string{"Bash"}
	cfg.MaxIterations = 3
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := llm.NewMockProvider("ok", "ok", "ok")
	m := newLoopModeForServer(t, srv, provider)

	var buf strings.Builder
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&lockedWriter{mu: &sync.Mutex{}, b: &buf}, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 3 {
		t.Fatalf("provider called %d times, want 3", provider.CallCount())
	}
	if got := strings.Count(buf.String(), offSwitchPreflightWarning); got != 1 {
		t.Errorf("pre-flight warning appeared %d times across 3 iterations, want exactly 1", got)
	}
}

// TestLoopMode_CtxCancelDuringDelay_NoRailTrips proves an operator interrupt
// (ctx cancellation) during the inter-iteration delay exits cleanly WITHOUT
// ever calling disable — the one exit path the rails must never see.
func TestLoopMode_CtxCancelDuringDelay_NoRailTrips(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.IterationDelaySeconds = 30 // long enough that cancellation always wins the race
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := llm.NewMockProvider("ok")
	m := newLoopModeForServer(t, srv, provider)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- m.Run(ctx) }()

	// Let the first iteration run to completion, then cancel during the delay.
	time.Sleep(150 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if err != nil && !errors.Is(err, context.Canceled) {
			t.Fatalf("Run returned unexpected error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after ctx cancellation during delay")
	}
	if srv.patchCount() != 0 {
		t.Errorf("PATCH .../loop/state called %d times, want 0 — cancellation must bypass all rails", srv.patchCount())
	}
}

// cancellingProvider simulates an operator interrupt landing while the
// provider session is running: Execute cancels the parent ctx and returns the
// cancellation error, exactly what a real CLI session returns when its
// context dies mid-run.
type cancellingProvider struct {
	cancel context.CancelFunc
}

func (p *cancellingProvider) Name() string { return "cancelling" }

func (p *cancellingProvider) Execute(context.Context, string, llm.Options) (*llm.Result, error) {
	p.cancel()
	return nil, context.Canceled
}

// TestLoopMode_CtxCancelDuringExecution_NoDisable proves an operator
// interrupt that lands while the provider session is RUNNING (not just during
// the delay) exits cleanly without counting the aborted session toward the
// consecutive-failures rail — otherwise an interrupt would flip the board's
// flag off ("stopping the process is not finishing the job"). With
// MaxConsecutiveFailures=1, counting the abort as a failure would trip the
// rail and PATCH the flag.
func TestLoopMode_CtxCancelDuringExecution_NoDisable(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxConsecutiveFailures = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := newLoopModeForServer(t, srv, &cancellingProvider{cancel: cancel})

	if err := m.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		t.Fatalf("Run returned unexpected error: %v", err)
	}
	if srv.patchCount() != 0 {
		t.Errorf("PATCH .../loop/state called %d times, want 0 — a cancelled session must not count toward any rail", srv.patchCount())
	}
}

// TestLoopMode_ExecutionLoggingFailureTolerated proves a 500 from the
// execution-logging endpoints (start/heartbeat) never stops the loop — the
// provider still gets called and the config-driven exit still fires cleanly.
func TestLoopMode_ExecutionLoggingFailureTolerated(t *testing.T) {
	enabled := baseLoopConfig()
	disabled := baseLoopConfig()
	disabled.Enabled = false
	srv := newLoopModeServer(t, loopConfigJSON(t, enabled), loopConfigJSON(t, disabled))
	srv.failExecutions = true
	srv.failHeartbeat = true
	provider := llm.NewMockProvider("ok despite logging failures")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 1 {
		t.Errorf("provider called %d times, want 1 (logging failures must not abort the iteration)", provider.CallCount())
	}
}

// ---------------------------------------------------------------------------
// Card 3f850adb — loop-mode iterations must report structured cost/tokens/
// duration (+ resolved model/provider) on their AgentExecution rows, not only
// a formatted "cost=$X duration=Y" summary string. Today runIteration's
// completeExecution call carries just status+outputSummary, so the backend's
// tokens_used/cost_usd/duration_seconds columns stay null for every loop
// iteration despite the runner having computed exactly those numbers
// (resultCost/resultDuration) one line above the call it throws them away at.
// ---------------------------------------------------------------------------

// TestLoopMode_SuccessfulIteration_StampsResolvedProviderAndModel proves the
// execution-START call (POST .../executions) carries the RESOLVED provider
// name and model — not empty strings — once loop mode adopts
// LogExecutionStartWithLLM's promptSlug/model/provider params the way the
// pipeline path already does. Today startExecution always passes "","","" for
// those three trailing params, so this must fail at HEAD.
func TestLoopMode_SuccessfulIteration_StampsResolvedProviderAndModel(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.Model = "claude-sonnet-4" // concrete, non-tier-alias model so resolution is a no-op passthrough
	cfg.MaxIterations = 1         // deterministic single-iteration run via the max_iterations rail
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))

	provider := llm.NewMockProvider("iteration output")
	provider.NameOverride = "mock-resolved-provider"
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 1 {
		t.Fatalf("provider called %d times, want 1", provider.CallCount())
	}

	start := srv.lastExecutionStart()
	if start == nil {
		t.Fatal("no POST .../executions body captured")
	}
	if got, _ := start["provider"].(string); got != "mock-resolved-provider" {
		t.Errorf("execution start provider = %q, want the resolved provider name %q", got, "mock-resolved-provider")
	}
	if got, _ := start["model"].(string); got != "claude-sonnet-4" {
		t.Errorf("execution start model = %q, want the resolved model %q", got, "claude-sonnet-4")
	}
}

// TestLoopMode_SuccessfulIteration_ReportsStructuredMetrics proves a
// successful iteration's completion PATCH carries tokens_used, cost_usd, and
// duration_seconds computed from the SAME values runIteration already derives
// via resultCost/resultDuration — not just the human-readable summary string.
// At HEAD, LogExecutionUpdate only ever sends status+output_summary, so these
// keys are absent from the wire body and this must fail.
func TestLoopMode_SuccessfulIteration_ReportsStructuredMetrics(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))

	provider := llm.NewMockProvider("iteration output")
	provider.InputTokens = 1234
	provider.OutputTokens = 567
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 1 {
		t.Fatalf("provider called %d times, want 1", provider.CallCount())
	}

	if srv.executionUpdateCount() != 1 {
		t.Fatalf("PATCH .../executions/{id} called %d times, want 1", srv.executionUpdateCount())
	}
	update := srv.executionUpdateAt(0)

	wantTokens := float64(provider.InputTokens + provider.OutputTokens)
	wantCost := estimateCostWith(priceFor(provider.Name(), ""), provider.InputTokens, provider.OutputTokens, 0, 0)

	if status, _ := update["status"].(string); status != "completed" {
		t.Errorf("status = %q, want %q", status, "completed")
	}
	summary, _ := update["output_summary"].(string)
	if !strings.Contains(summary, "cost=$") || !strings.Contains(summary, "duration=") {
		t.Errorf("output_summary = %q, want it to still carry the human summary", summary)
	}

	gotTokens, ok := update["tokens_used"].(float64) // JSON numbers decode as float64
	if !ok {
		t.Fatalf("tokens_used missing from completion PATCH body: %v", update)
	}
	if gotTokens != wantTokens {
		t.Errorf("tokens_used = %v, want %v (InputTokens+OutputTokens)", gotTokens, wantTokens)
	}

	gotCost, ok := update["cost_usd"].(float64)
	if !ok {
		t.Fatalf("cost_usd missing from completion PATCH body: %v", update)
	}
	if gotCost != wantCost {
		t.Errorf("cost_usd = %v, want %v (same value resultCost yields)", gotCost, wantCost)
	}

	gotDuration, ok := update["duration_seconds"].(float64)
	if !ok {
		t.Fatalf("duration_seconds missing from completion PATCH body: %v", update)
	}
	if gotDuration <= 0 {
		t.Errorf("duration_seconds = %v, want a positive value reflecting result.Duration", gotDuration)
	}
}

// TestLoopMode_FailedIteration_StillReportsRealMetrics proves a FAILED
// iteration (the provider ran and returned a real Result, but the session
// itself failed — non-zero exit code) still reports its true tokens/cost/
// duration on the completion PATCH, with status "failed". Failure must not
// suppress the metrics the provider actually produced.
func TestLoopMode_FailedIteration_StillReportsRealMetrics(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxConsecutiveFailures = 999 // don't let the failure rail short-circuit before we can inspect the PATCH
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))

	provider := &scriptedProvider{results: []scriptedResult{
		{result: &llm.Result{
			ExitCode:     1,
			Duration:     250 * time.Millisecond,
			InputTokens:  800,
			OutputTokens: 200,
		}, err: nil},
	}}
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.callCount() != 1 {
		t.Fatalf("provider called %d times, want 1", provider.callCount())
	}

	if srv.executionUpdateCount() != 1 {
		t.Fatalf("PATCH .../executions/{id} called %d times, want 1", srv.executionUpdateCount())
	}
	update := srv.executionUpdateAt(0)

	if status, _ := update["status"].(string); status != "failed" {
		t.Errorf("status = %q, want %q", status, "failed")
	}

	wantTokens := float64(800 + 200)
	gotTokens, ok := update["tokens_used"].(float64)
	if !ok {
		t.Fatalf("tokens_used missing from FAILED completion PATCH body: %v", update)
	}
	if gotTokens != wantTokens {
		t.Errorf("tokens_used = %v, want %v — a failed session still spent real tokens", gotTokens, wantTokens)
	}

	gotCost, ok := update["cost_usd"].(float64)
	if !ok {
		t.Fatalf("cost_usd missing from FAILED completion PATCH body: %v", update)
	}
	if gotCost <= 0 {
		t.Errorf("cost_usd = %v, want a positive real cost for a failed-but-executed session", gotCost)
	}

	gotDuration, ok := update["duration_seconds"].(float64)
	if !ok {
		t.Fatalf("duration_seconds missing from FAILED completion PATCH body: %v", update)
	}
	if gotDuration < 0.2 || gotDuration > 0.3 {
		t.Errorf("duration_seconds = %v, want ~0.25 (250ms result.Duration)", gotDuration)
	}
}

// ---------------------------------------------------------------------------
// Card fe5336ea — pre-flight + park: a starved iteration must cost $0 and
// consume nothing. The probe (GET /loop/readiness, card 0ae69fd9) answers "is
// there anything to do?" for one HTTP GET; actionable=false parks the loop —
// no session, no iteration number, no budget, no failure-counter interaction.
// ---------------------------------------------------------------------------

// TestLoopMode_Park_StarvedCycleIsFree proves two not-actionable probe results
// park the loop for free: the provider runs only once (when readiness flips
// actionable), the parked cycles log NO execution rows, and the single real
// iteration is numbered 1 — parked cycles consumed nothing. Heartbeats still
// fire per parked cycle so agent presence stays fresh while waiting.
func TestLoopMode_Park_StarvedCycleIsFree(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	srv.readinessBodies = []string{
		readinessJSON(false, 0, 3, 3, 3),
		readinessJSON(false, 0, 3, 3, 3),
		readinessJSON(true, 2, 1, 0, 3),
	}
	provider := llm.NewMockProvider("worked the ready card")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 1 {
		t.Errorf("provider called %d times, want 1 (two parked cycles + one real iteration)", provider.CallCount())
	}
	if got := srv.readinessCallCount(); got != 3 {
		t.Errorf("readiness probed %d times, want 3", got)
	}
	if got := srv.executionStartCount(); got != 1 {
		t.Errorf("execution rows logged = %d, want 1 — parked cycles must not spam the feed", got)
	}
	start := srv.lastExecutionStart()
	if summary, _ := start["input_summary"].(string); !strings.Contains(summary, "loop iteration 1") {
		t.Errorf("input_summary = %q, want %q — parked cycles must not consume iteration numbers", summary, "loop iteration 1")
	}
	if got := srv.heartbeatCount(); got < 3 {
		t.Errorf("heartbeats = %d, want >= 3 (one per parked cycle + the real iteration)", got)
	}
	reason, _ := srv.lastPatch()["reason"].(string)
	if !strings.Contains(reason, "max_iterations") {
		t.Errorf("reason = %q, want a max_iterations trip AFTER the single real iteration", reason)
	}
}

// TestLoopMode_Park_BudgetAndFailuresUntouched proves a parked cycle never
// interacts with the budget or failure rails: with budget_usd barely above one
// session's cost and MaxConsecutiveFailures=1, three parked cycles followed by
// a platform disable exit cleanly with zero sessions and zero rail PATCHes.
func TestLoopMode_Park_BudgetAndFailuresUntouched(t *testing.T) {
	enabled := baseLoopConfig()
	enabled.BudgetUSD = 0.0001
	enabled.MaxConsecutiveFailures = 1
	disabled := baseLoopConfig()
	disabled.Enabled = false
	srv := newLoopModeServer(t,
		loopConfigJSON(t, enabled),
		loopConfigJSON(t, enabled),
		loopConfigJSON(t, enabled),
		loopConfigJSON(t, disabled),
	)
	srv.readinessBodies = []string{readinessJSON(false, 0, 2, 2, 2)}
	provider := llm.NewMockProvider("never called")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 0 {
		t.Errorf("provider called %d times, want 0 — parked cycles are free", provider.CallCount())
	}
	if srv.patchCount() != 0 {
		t.Errorf("PATCH .../loop/state called %d times, want 0 — no rail may trip while parked", srv.patchCount())
	}
}

// TestLoopMode_AlwaysRun_SkipsProbe proves starvation_policy="always_run"
// preserves v1 behavior byte-for-byte: no readiness call ever happens and the
// session runs regardless of board state (docs/triage loops whose prompt does
// non-card work).
func TestLoopMode_AlwaysRun_SkipsProbe(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.StarvationPolicy = "always_run"
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	srv.readinessBodies = []string{readinessJSON(false, 0, 5, 5, 5)} // would park if consulted
	provider := llm.NewMockProvider("ran anyway")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 1 {
		t.Errorf("provider called %d times, want 1", provider.CallCount())
	}
	if got := srv.readinessCallCount(); got != 0 {
		t.Errorf("readiness probed %d times, want 0 under always_run", got)
	}
}

// TestLoopMode_Readiness404_FallsBackToAlwaysRun proves a pre-rollout backend
// (no /loop/readiness route) downgrades parking to always_run with a WARN —
// never fatal, and the 404 is latched so the probe isn't retried every cycle.
func TestLoopMode_Readiness404_FallsBackToAlwaysRun(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 2
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	srv.readiness404 = true
	provider := llm.NewMockProvider("one", "two")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 2 {
		t.Errorf("provider called %d times, want 2 (404 must fall back to running, not park or die)", provider.CallCount())
	}
}

// TestLoopMode_ReadinessTransientError_RunsIterationAnyway proves a 500 from
// the probe fails OPEN: the iteration runs (a probe outage must not stall the
// loop), and the probe is retried on the next cycle rather than latched off.
func TestLoopMode_ReadinessTransientError_RunsIterationAnyway(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 2
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	srv.readiness500 = true
	provider := llm.NewMockProvider("one", "two")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 2 {
		t.Errorf("provider called %d times, want 2 (probe failure fails open)", provider.CallCount())
	}
	if got := srv.readinessCallCount(); got != 2 {
		t.Errorf("readiness probed %d times, want 2 — a transient error must NOT latch the probe off", got)
	}
}

// TestLoopMode_Park_CtxCancelDuringParkSleep_CleanExit proves an operator
// interrupt landing during a park sleep exits cleanly: no rail, no PATCH, no
// session — same contract as cancellation during the iteration delay.
func TestLoopMode_Park_CtxCancelDuringParkSleep_CleanExit(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.IterationDelaySeconds = 30 // park sleep long enough that cancel always wins
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	srv.readinessBodies = []string{readinessJSON(false, 0, 1, 1, 1)}
	provider := llm.NewMockProvider("never")
	m := newLoopModeForServer(t, srv, provider)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- m.Run(ctx) }()

	time.Sleep(150 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if err != nil && !errors.Is(err, context.Canceled) {
			t.Fatalf("Run returned unexpected error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after ctx cancellation during park sleep")
	}
	if provider.CallCount() != 0 {
		t.Errorf("provider called %d times, want 0", provider.CallCount())
	}
	if srv.patchCount() != 0 {
		t.Errorf("PATCH .../loop/state called %d times, want 0", srv.patchCount())
	}
}

// TestParkDelay_BackoffDoublesAndCaps pins the park pacing pure function:
// doubling per consecutive parked cycle from the iteration delay, capped at
// 10×; a zero base stays zero (the operator opted out of pacing and a probe
// is one HTTP GET).
func TestParkDelay_BackoffDoublesAndCaps(t *testing.T) {
	cases := []struct {
		base  int
		parks int
		want  time.Duration
	}{
		{30, 1, 30 * time.Second},
		{30, 2, 60 * time.Second},
		{30, 3, 120 * time.Second},
		{30, 4, 240 * time.Second},
		{30, 5, 300 * time.Second}, // 480 capped to 10×base
		{30, 12, 300 * time.Second},
		{0, 5, 0},
	}
	for _, c := range cases {
		if got := parkDelay(c.base, c.parks); got != c.want {
			t.Errorf("parkDelay(%d, %d) = %v, want %v", c.base, c.parks, got, c.want)
		}
	}
}

// TestLoopMode_OutcomeSchema_SetOnlyWhenProviderSupportsIt proves loop
// sessions request the structured outcome via Options.OutputSchema exactly
// when the provider reports the StructuredOutput capability — and never for a
// bare provider, where the flag would be rejected argv.
func TestLoopMode_OutcomeSchema_SetOnlyWhenProviderSupportsIt(t *testing.T) {
	t.Run("supported", func(t *testing.T) {
		cfg := baseLoopConfig()
		cfg.MaxIterations = 1
		srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
		provider := llm.NewMockProvider("ok")
		provider.Caps = llm.Capabilities{StructuredOutput: true}
		m := newLoopModeForServer(t, srv, provider)

		if err := m.Run(context.Background()); err != nil {
			t.Fatalf("Run: %v", err)
		}
		schema := provider.Calls[0].Options.OutputSchema
		if schema == "" {
			t.Fatal("OutputSchema empty — loop sessions must request the outcome backstop when the provider supports it")
		}
		if !json.Valid([]byte(schema)) {
			t.Fatalf("OutputSchema is not valid JSON: %q", schema)
		}
		for _, needle := range []string{"nothing_ready", "blocked_on_human", "objective_complete", "worked", "summary"} {
			if !strings.Contains(schema, needle) {
				t.Errorf("OutputSchema missing %q: %s", needle, schema)
			}
		}
	})
	t.Run("unsupported", func(t *testing.T) {
		cfg := baseLoopConfig()
		cfg.MaxIterations = 1
		srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
		provider := llm.NewMockProvider("ok") // zero-value Caps: no StructuredOutput
		m := newLoopModeForServer(t, srv, provider)

		if err := m.Run(context.Background()); err != nil {
			t.Fatalf("Run: %v", err)
		}
		if schema := provider.Calls[0].Options.OutputSchema; schema != "" {
			t.Errorf("OutputSchema = %q, want empty for a provider without StructuredOutput", schema)
		}
	})
}

// TestLoopMode_NothingReadyOutcome_RecordedNotFailed proves a session that
// reports {outcome: nothing_ready} is recorded on the execution row's summary
// (so the operator sees WHY nothing happened in the loop feed) and still
// counts as a SUCCESS — an honest "nothing to do" must not walk toward the
// consecutive-failures rail.
func TestLoopMode_NothingReadyOutcome_RecordedNotFailed(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := llm.NewMockProvider("checked the board, nothing actionable")
	provider.Caps = llm.Capabilities{StructuredOutput: true}
	provider.QueueStructured([]byte(`{"outcome":"nothing_ready","summary":"all cards blocked on open PRs"}`))
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	update := srv.executionUpdateAt(0)
	if update == nil {
		t.Fatal("no completion PATCH captured")
	}
	if status, _ := update["status"].(string); status != "completed" {
		t.Errorf("status = %q, want completed — nothing_ready is not a failure", status)
	}
	summary, _ := update["output_summary"].(string)
	if !strings.Contains(summary, "nothing_ready") {
		t.Errorf("output_summary = %q, want it to carry the structured outcome", summary)
	}
	if !strings.Contains(summary, "cost=$") || !strings.Contains(summary, "duration=") {
		t.Errorf("output_summary = %q, must keep the cost/duration telemetry", summary)
	}
}

// ---------------------------------------------------------------------------
// Card 998294ca — loop budget truth. The per-session cap handed to the
// provider must be min(board budget REMAINING, yaml llm.max_budget_usd) —
// previously the board term was the FULL budget, so the cap never tightened
// as the loop spent and a late session could overshoot by a whole budget.
// Plus: per-iteration budget log line, ≥80% warnings in the execution row's
// summary, a loud once-per-run WARN when the provider cannot enforce a
// session cap, and a spend recap on exit.
// ---------------------------------------------------------------------------

// captureLogs redirects slog's default logger to a buffer for the duration of
// the test, returning a getter for the accumulated text.
func captureLogs(t *testing.T) func() string {
	t.Helper()
	var mu sync.Mutex
	var buf strings.Builder
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&lockedWriter{mu: &mu, b: &buf}, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return func() string {
		mu.Lock()
		defer mu.Unlock()
		return buf.String()
	}
}

type lockedWriter struct {
	mu *sync.Mutex
	b  *strings.Builder
}

func (w *lockedWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.b.Write(p)
}

// TestLoopMode_SessionCapShrinksAsSpendAccumulates proves the remaining-budget
// fix: with no yaml cap, session 1 is capped at the full board budget and
// session 2 at budget − spent. The cap must tighten with every dollar spent.
func TestLoopMode_SessionCapShrinksAsSpendAccumulates(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.BudgetUSD = 10.0
	cfg.MaxIterations = 2
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := &scriptedProvider{results: []scriptedResult{
		{result: &llm.Result{Output: "one", CostUSD: 3.0}},
		{result: &llm.Result{Output: "two", CostUSD: 3.0}},
	}}
	tcfg := loopModeTestConfig(t)
	tcfg.LLM.MaxBudgetUSD = 0 // no yaml ceiling — board remaining is the only cap
	client := testClientWithURL(srv.srv.URL)
	m := NewLoopMode(client, tcfg, nil, provider, "acme", "board-1", "agent-1")

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.callCount() != 2 {
		t.Fatalf("provider called %d times, want 2", provider.callCount())
	}
	if got := provider.optionsAt(0).MaxBudgetUSD; got != 10.0 {
		t.Errorf("session 1 MaxBudgetUSD = %v, want 10 (full budget, nothing spent)", got)
	}
	if got := provider.optionsAt(1).MaxBudgetUSD; got != 7.0 {
		t.Errorf("session 2 MaxBudgetUSD = %v, want 7 (10 − 3 spent) — the cap must TIGHTEN as the loop spends", got)
	}
}

// TestLoopMode_SessionCapIsMinOfYamlAndRemaining proves the yaml per-session
// ceiling binds while it is the smaller term, and remaining takes over once
// spend brings it below the yaml value.
func TestLoopMode_SessionCapIsMinOfYamlAndRemaining(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.BudgetUSD = 10.0
	cfg.MaxIterations = 2
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := &scriptedProvider{results: []scriptedResult{
		{result: &llm.Result{Output: "one", CostUSD: 6.0}},
		{result: &llm.Result{Output: "two", CostUSD: 1.0}},
	}}
	tcfg := loopModeTestConfig(t)
	tcfg.LLM.MaxBudgetUSD = 5.0
	client := testClientWithURL(srv.srv.URL)
	m := NewLoopMode(client, tcfg, nil, provider, "acme", "board-1", "agent-1")

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := provider.optionsAt(0).MaxBudgetUSD; got != 5.0 {
		t.Errorf("session 1 MaxBudgetUSD = %v, want 5 (yaml < remaining 10)", got)
	}
	if got := provider.optionsAt(1).MaxBudgetUSD; got != 4.0 {
		t.Errorf("session 2 MaxBudgetUSD = %v, want 4 (remaining 10−6 < yaml 5)", got)
	}
}

// TestLoopMode_BudgetWarningInExecutionSummaryAt80Percent proves crossing 80%
// of the board budget lands a warning in the execution row's output_summary —
// the loop feed is where the operator actually looks between iterations.
func TestLoopMode_BudgetWarningInExecutionSummaryAt80Percent(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.BudgetUSD = 10.0
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := &scriptedProvider{results: []scriptedResult{
		{result: &llm.Result{Output: "big session", CostUSD: 8.5}},
	}}
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	update := srv.executionUpdateAt(0)
	if update == nil {
		t.Fatal("no completion PATCH captured")
	}
	summary, _ := update["output_summary"].(string)
	if !strings.Contains(summary, "budget warning") {
		t.Errorf("output_summary = %q, want a budget warning at 85%% of the board budget", summary)
	}
	if !strings.Contains(summary, "of $10.00") {
		t.Errorf("output_summary = %q, want the board budget figure in the warning", summary)
	}
}

// TestLoopMode_NoBudgetWarningBelowThreshold proves a modest session leaves
// the summary clean — the warning must not cry wolf.
func TestLoopMode_NoBudgetWarningBelowThreshold(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.BudgetUSD = 10.0
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := &scriptedProvider{results: []scriptedResult{
		{result: &llm.Result{Output: "small session", CostUSD: 1.0}},
	}}
	tcfg := loopModeTestConfig(t)
	tcfg.LLM.MaxBudgetUSD = 0 // testConfig ships a $1 yaml cap — clear it so nothing is near 80%
	client := testClientWithURL(srv.srv.URL)
	m := NewLoopMode(client, tcfg, nil, provider, "acme", "board-1", "agent-1")

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	summary, _ := srv.executionUpdateAt(0)["output_summary"].(string)
	if strings.Contains(summary, "budget warning") {
		t.Errorf("output_summary = %q, must not warn at 10%% of budget", summary)
	}
}

// TestLoopMode_IterationStartBudgetLine proves every iteration logs the
// budget picture BEFORE the session runs: board budget, session cap, spent,
// remaining — the operator must never have to read the YAML to learn which
// cap binds.
func TestLoopMode_IterationStartBudgetLine(t *testing.T) {
	logs := captureLogs(t)
	cfg := baseLoopConfig()
	cfg.BudgetUSD = 10.0
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := llm.NewMockProvider("ok")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	text := logs()
	if !strings.Contains(text, "loop budget") {
		t.Fatalf("no iteration-start budget line in logs:\n%s", text)
	}
	for _, key := range []string{"board_budget_usd", "session_cap_usd", "spent_usd", "remaining_usd"} {
		if !strings.Contains(text, key) {
			t.Errorf("budget line missing %q in logs:\n%s", key, text)
		}
	}
}

// TestLoopMode_CapUnenforceableWarnedOncePerRun proves a provider without the
// BudgetCap capability draws exactly ONE loud WARN per run — the session cap
// is advisory there (codex has no cap flag; claude's binds only API-billed
// sessions), and the operator must learn that from the log, not from a $31
// session under a $10 cap.
func TestLoopMode_CapUnenforceableWarnedOncePerRun(t *testing.T) {
	logs := captureLogs(t)
	cfg := baseLoopConfig()
	cfg.MaxIterations = 3
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := llm.NewMockProvider("one", "two", "three") // zero-value Caps: no BudgetCap
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := strings.Count(logs(), "cannot enforce a per-session budget cap"); got != 1 {
		t.Errorf("cap-unenforceable WARN appeared %d times, want exactly 1 per run:\n%s", got, logs())
	}
}

// TestLoopMode_CapEnforceableNoWarn proves a provider that CAN enforce the
// cap (BudgetCap capability) does not draw the warning.
func TestLoopMode_CapEnforceableNoWarn(t *testing.T) {
	logs := captureLogs(t)
	cfg := baseLoopConfig()
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := llm.NewMockProvider("ok")
	provider.Caps = llm.Capabilities{BudgetCap: true}
	tcfg := loopModeTestConfig(t)
	tcfg.LLM.AnthropicAPIKey = "sk-ant-test" // API-billed: the cap can bind
	client := testClientWithURL(srv.srv.URL)
	m := NewLoopMode(client, tcfg, nil, provider, "acme", "board-1", "agent-1")

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if strings.Contains(logs(), "cannot enforce a per-session budget cap") {
		t.Errorf("cap-unenforceable WARN fired for a BudgetCap-capable provider:\n%s", logs())
	}
}

// TestLoopMode_SubscriptionAuthCapAdvisoryWarn proves the field-run root
// cause is now named in the log: a BudgetCap-capable provider running WITHOUT
// an API key (subscription/OAuth auth) is unmetered — the CLI's cap counts
// API dollars, which stay 0, so a $31 session sails under a $10 cap. One WARN
// per run.
func TestLoopMode_SubscriptionAuthCapAdvisoryWarn(t *testing.T) {
	logs := captureLogs(t)
	cfg := baseLoopConfig()
	cfg.MaxIterations = 2
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := llm.NewMockProvider("one", "two")
	provider.Caps = llm.Capabilities{BudgetCap: true}
	m := newLoopModeForServer(t, srv, provider) // loopModeTestConfig: no AnthropicAPIKey

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := strings.Count(logs(), "subscription auth"); got != 1 {
		t.Errorf("subscription-auth advisory WARN appeared %d times, want exactly 1:\n%s", got, logs())
	}
}

// TestLoopMode_SpendRecapOnRailExit proves the loop's exit leaves a final
// spend recap in the log — total spent, budget, iterations — on the rail
// path.
func TestLoopMode_SpendRecapOnRailExit(t *testing.T) {
	logs := captureLogs(t)
	cfg := baseLoopConfig()
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := &scriptedProvider{results: []scriptedResult{
		{result: &llm.Result{Output: "ok", CostUSD: 2.5}},
	}}
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	text := logs()
	if !strings.Contains(text, "loop spend recap") {
		t.Fatalf("no spend recap on exit in logs:\n%s", text)
	}
	if !strings.Contains(text, "spent_usd=2.5") {
		t.Errorf("spend recap missing the actual spend in logs:\n%s", text)
	}
}

// ---------------------------------------------------------------------------
// Card 371bd382 — cross-run continuity. {{.Iteration}} restarted at 1 on
// every launch (note-title collisions) and, worse, the spent accumulator was
// process-local: a crash-restart loop reset the budget rail. The runner now
// seeds both from GET /loop/history at startup: iteration numbering is
// monotonic across the board's life; spent is cumulative since budget_epoch.
// max_iterations stays per-process (a runaway guard, not money).
// ---------------------------------------------------------------------------

// TestLoopMode_HistorySeed_IterationNumbersContinue proves a restarted loop
// renders {{.Iteration}} as offset+1, not 1, and stamps the same global
// number on the execution row.
func TestLoopMode_HistorySeed_IterationNumbersContinue(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.LoopPrompt = "iteration {{.Iteration}}"
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	srv.historyBody = `{"iteration_count":7,"spent_usd":2.5,"lifetime_spent_usd":2.5,"budget_epoch":"2026-08-07T00:00:00"}`
	provider := llm.NewMockProvider("ok")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 1 {
		t.Fatalf("provider called %d times, want 1", provider.CallCount())
	}
	if prompt := provider.Calls[0].Prompt; !strings.Contains(prompt, "iteration 8") {
		t.Errorf("prompt = %q, want {{.Iteration}} rendered as 8 (7 prior + 1)", prompt)
	}
	start := srv.lastExecutionStart()
	if summary, _ := start["input_summary"].(string); !strings.Contains(summary, "loop iteration 8") {
		t.Errorf("input_summary = %q, want the global iteration number 8", summary)
	}
}

// TestLoopMode_HistorySeed_SpentTripsBudgetRailImmediately proves seeded
// spend reaches the budget rail before any session runs: a restart cannot
// launder money already spent this epoch.
func TestLoopMode_HistorySeed_SpentTripsBudgetRailImmediately(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.BudgetUSD = 10.0
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	srv.historyBody = `{"iteration_count":4,"spent_usd":12.5,"lifetime_spent_usd":12.5,"budget_epoch":"2026-08-07T00:00:00"}`
	provider := llm.NewMockProvider("never called")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 0 {
		t.Errorf("provider called %d times, want 0 — seeded spend already exceeds the budget", provider.CallCount())
	}
	reason, _ := srv.lastPatch()["reason"].(string)
	if !strings.Contains(reason, "budget_usd exhausted") {
		t.Errorf("reason = %q, want the budget rail trip", reason)
	}
	if !strings.Contains(reason, "12.50") {
		t.Errorf("reason = %q, want the seeded spend figure", reason)
	}
}

// TestLoopMode_HistorySeed_MaxIterationsStaysPerProcess proves the
// iteration-count seed does NOT feed the max_iterations rail — it is a
// per-process runaway guard by contract, or a restart could never run again.
func TestLoopMode_HistorySeed_MaxIterationsStaysPerProcess(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 2
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	srv.historyBody = `{"iteration_count":50,"spent_usd":0,"lifetime_spent_usd":0,"budget_epoch":null}`
	provider := llm.NewMockProvider("one", "two")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 2 {
		t.Errorf("provider called %d times, want 2 — 50 historical iterations must not consume the per-process cap", provider.CallCount())
	}
}

// History is a prerequisite for a truthful cumulative budget rail.
func TestLoopMode_HistoryUnavailable_FailsClosed(t *testing.T) {
	for name, arm := range map[string]func(*loopModeServer){
		"404": func(s *loopModeServer) { s.history404 = true },
		"500": func(s *loopModeServer) { s.history500 = true },
	} {
		t.Run(name, func(t *testing.T) {
			cfg := baseLoopConfig()
			cfg.MaxIterations = 1
			srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
			arm(srv)
			provider := llm.NewMockProvider("must not run")
			mode := newLoopModeForServer(t, srv, provider)
			if err := mode.Run(context.Background()); err == nil {
				t.Fatal("missing history did not stop execution")
			}
			if provider.CallCount() != 0 {
				t.Fatal("missing history reached provider")
			}
		})
	}
}

// TestLoopMode_HistoryFetchedOncePerProcess proves the seed is a startup
// read, not a per-cycle one — per-iteration spend tracking stays local.
func TestLoopMode_HistoryFetchedOncePerProcess(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 3
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := llm.NewMockProvider("one", "two", "three")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := srv.historyCalls; got != 1 {
		t.Errorf("history fetched %d times, want exactly 1 (startup seed)", got)
	}
}

// TestLoopMode_EarlyTemplateFailure_CompletesWithoutFabricatedMetrics proves
// an early failure that never reaches the provider (a system_prompt template
// render error) completes via the plain no-metrics path: the provider is
// never called, and the completion PATCH must NOT carry tokens_used/cost_usd/
// duration_seconds keys at all — there is no real Result to report numbers
// from, so the runner must not send fabricated zeros that would misrepresent
// "we don't know" as "this cost nothing".
func TestLoopMode_EarlyTemplateFailure_CompletesWithoutFabricatedMetrics(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxConsecutiveFailures = 999
	cfg.MaxIterations = 1
	cfg.SystemPrompt = "{{.Undefined.Nested}}" // invalid template field access -> render error
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))

	provider := llm.NewMockProvider("should never be called")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 0 {
		t.Fatalf("provider called %d times, want 0 (template render must fail before execution)", provider.CallCount())
	}

	if srv.executionUpdateCount() != 1 {
		t.Fatalf("PATCH .../executions/{id} called %d times, want 1", srv.executionUpdateCount())
	}
	update := srv.executionUpdateAt(0)

	if status, _ := update["status"].(string); status != "failed" {
		t.Errorf("status = %q, want %q", status, "failed")
	}
	if _, present := update["tokens_used"]; present {
		t.Errorf("tokens_used present in early-failure PATCH body (%v) — must be omitted, not fabricated as 0", update["tokens_used"])
	}
	if _, present := update["cost_usd"]; present {
		t.Errorf("cost_usd present in early-failure PATCH body (%v) — must be omitted, not fabricated as 0", update["cost_usd"])
	}
	if _, present := update["duration_seconds"]; present {
		t.Errorf("duration_seconds present in early-failure PATCH body (%v) — must be omitted, not fabricated as 0", update["duration_seconds"])
	}
}

// TestLoopMode_RunnerVarsFixtureAllFilled is the runner half of the
// LOOP_RUNNER_VARS drift guard. testdata/loop_runner_vars.json is the shared
// contract file: the backend asserts LOOP_RUNNER_VARS equals it, and this test
// asserts loop mode really FILLS every name in it. Together they make the
// vocabulary un-driftable — dropping a field from the loop-mode PromptContext
// leaves its {{.X}} rendering empty and fails here, while adding a name to the
// backend constant without a runner fill fails here too.
func TestLoopMode_RunnerVarsFixtureAllFilled(t *testing.T) {
	data, err := os.ReadFile("testdata/loop_runner_vars.json")
	if err != nil {
		t.Fatalf("read runner vars fixture: %v", err)
	}
	var vars []string
	if err := json.Unmarshal(data, &vars); err != nil {
		t.Fatalf("parse runner vars fixture: %v", err)
	}
	if len(vars) == 0 {
		t.Fatal("runner vars fixture is empty — it must list every var loop mode fills")
	}

	// One probe line per var: "NAME=[{{.NAME}}]". The brackets make an EMPTY
	// render (the unset-field signature — Go templates render a zero string,
	// they do not error) distinguishable from a filled one.
	var probe strings.Builder
	for _, name := range vars {
		fmt.Fprintf(&probe, "%s=[{{.%s}}]\n", name, name)
	}

	cfg := baseLoopConfig()
	cfg.LoopPrompt = probe.String()
	cfg.MaxIterations = 1 // deterministic single-iteration run via the max_iterations rail
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := llm.NewMockProvider("ok")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 1 {
		t.Fatalf("provider called %d times, want 1", provider.CallCount())
	}

	rendered := provider.Calls[0].Prompt
	for _, name := range vars {
		if strings.Contains(rendered, name+"=[]") {
			t.Errorf("loop mode does not fill {{.%s}} — rendered empty; "+
				"testdata/loop_runner_vars.json and the loop-mode PromptContext disagree", name)
		}
		if !strings.Contains(rendered, name+"=[") {
			t.Errorf("probe line for %s missing from rendered prompt entirely: %q", name, rendered)
		}
	}
}
