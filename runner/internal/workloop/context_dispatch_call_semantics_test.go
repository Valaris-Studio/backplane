// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/harness"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// A call is shaped by its stage's cached configuration: the decoder, the
// default schema, the directive fetch and the approval gate. When the
// server's refreshed dispatch flags for the call disagree with what the call
// captured, it is refused before preparation: no receipt, no provider,
// nothing decoded under a kind the server no longer names. The tick then
// releases the card for a fresh assignment (execution aborted, its claimed
// participant removed) instead of failing it, and refreshes the released
// role once: later ticks, and later authority passes, run the refreshed
// configuration, never the stale one, and a role the refresh withdraws, or
// cannot establish, claims nothing until a refresh succeeds.

// runnerDispatchOwner is the human the runner's hero claims bind, distinct
// from the agent so a release that unassigns the wrong identity shows.
const runnerDispatchOwner = "00000000-0000-4000-8000-000000000161"

// otherRole is an unrelated pipeline role a refresh must leave alone.
const otherRole = "operator-unrelated-48"

func semanticsFlags(snapshot map[string]any) map[string]any {
	return snapshot["dispatch"].(map[string]any)["flags"].(map[string]any)
}

// semanticsCase is an invocation case whose stage caches kind, with the
// server's flags agreeing with that cache until a test changes them; the
// unset inject/minimal-prompt flags arrive as null, as the server sends them.
func semanticsCase(t *testing.T, stage, kind string) (*invocationCase, *invocationHTTP) {
	t.Helper()
	f := newInvocationHTTP()
	dispatch := f.snapshot["dispatch"].(map[string]any)
	dispatch["prompt_target"].(map[string]any)["stage"] = stage
	dispatch["output_schema"] = ""
	flags := semanticsFlags(f.snapshot)
	flags["post_process_kind"] = kind
	flags["inject_directives"], flags["use_minimal_prompt_when_unauthored"] = nil, nil
	c := newInvocationCase(t, f, stage)
	c.strategy.config.LLM.PostProcessKind = kind
	return c, f
}

// releaseRecorder sits in front of the fixture: it answers the tick's own
// control-plane calls (budget, the agent's config) and records, in order,
// how the bound execution ends, which participant the runner removes, and
// any card move.
type releaseRecorder struct {
	next http.Handler

	mu sync.Mutex
	// platformConfig, when set, is served as the agent's current config;
	// failConfig answers that request with a server error instead.
	platformConfig map[string]any
	failConfig     bool
	configGets     int
	failAbort      bool
	failUnassign   bool

	statusUpdates      []map[string]any
	participantDeletes []string
	// cleanup is every aborted-status PATCH ("abort") and participant
	// DELETE ("unassign") attempt, in arrival order.
	cleanup []string
	moves   int
}

func (h *releaseRecorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/api/agents/me/budget-status":
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"spent_usd": 0, "is_exceeded": false})
		return
	case r.URL.Path == "/api/agents/me/config":
		h.mu.Lock()
		h.configGets++
		served, fail := h.platformConfig, h.failConfig
		h.mu.Unlock()
		if fail {
			http.Error(w, "synthetic outage", http.StatusInternalServerError)
			return
		}
		if served != nil {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(served)
			return
		}
	case r.Method == http.MethodPatch && r.URL.Path == "/api/agents/"+runnerDispatchAgent+"/executions/"+runnerDispatchExecution:
		body, _ := io.ReadAll(r.Body)
		var update map[string]any
		_ = json.Unmarshal(body, &update)
		if _, ok := update["status"]; ok {
			h.mu.Lock()
			h.statusUpdates = append(h.statusUpdates, update)
			if update["status"] == "aborted" {
				h.cleanup = append(h.cleanup, "abort")
			}
			failAbort := h.failAbort
			h.mu.Unlock()
			if failAbort && update["status"] == "aborted" {
				http.Error(w, "synthetic outage", http.StatusInternalServerError)
				return
			}
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
	case r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/cards/"+runnerDispatchCard+"/participants"):
		h.mu.Lock()
		h.participantDeletes = append(h.participantDeletes, r.URL.Path)
		h.cleanup = append(h.cleanup, "unassign")
		failUnassign := h.failUnassign
		h.mu.Unlock()
		if failUnassign {
			http.Error(w, "synthetic outage", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{})
		return
	case strings.HasSuffix(r.URL.Path, "/move"):
		h.mu.Lock()
		h.moves++
		h.mu.Unlock()
	}
	h.next.ServeHTTP(w, r)
}

// serve sets the agent config the server answers with.
func (h *releaseRecorder) serve(config map[string]any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.platformConfig = config
}

func (h *releaseRecorder) configRequests() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.configGets
}

// servedConfig is the agent config payload naming stages as the pipeline.
func servedConfig(version int, stages ...valaris.StageConfig) map[string]any {
	return map[string]any{"workspace_config": map[string]any{
		"version":         version,
		"pipeline_config": valaris.PipelineConfig{Version: version, Stages: stages},
	}}
}

// withKind is stage with another post-process kind.
func withKind(stage valaris.StageConfig, kind string) valaris.StageConfig {
	stage.LLM.PostProcessKind = kind
	return stage
}

func otherStage() valaris.StageConfig {
	return valaris.StageConfig{Role: otherRole, Discover: valaris.DiscoverDef{Strategy: "column_scan", ColumnType: "todo"}}
}

// recordReleases routes c's loop through a releaseRecorder and readies it
// to run whole ticks as New leaves a runner: the case's role owned and in
// the cached pipeline, a sensor registry, and an owner identity distinct
// from the agent.
func recordReleases(t *testing.T, c *invocationCase, f *invocationHTTP) *releaseRecorder {
	t.Helper()
	h := &releaseRecorder{next: f}
	server := httptest.NewServer(h)
	t.Cleanup(server.Close)
	client := valaris.NewClient(server.URL, "synthetic-key")
	client.Agent = c.loop.client.Agent
	client.UserID = runnerDispatchOwner
	c.loop.client = client
	c.loop.cfg.WorkLoop.CardTimeout = 5 * time.Second
	c.loop.cardFailures = map[string]cardFailure{}
	c.loop.git = &git.Manager{}
	stage := c.strategy.config
	c.loop.sensors = harness.DefaultRegistry()
	c.loop.ownedStrategies = map[string]Strategy{stage.Role: c.strategy}
	c.loop.platformPriorityOrder = []string{stage.Role}
	c.loop.platformConfig = valaris.WorkspaceConfigData{Version: 1, PipelineConfig: &valaris.PipelineConfig{Version: 1, Stages: []valaris.StageConfig{stage}}}
	return h
}

// startedAgain is ready once the case's execution has been started again:
// the tick under test finished discovery and its claim, the last steps that
// reach the server before its LLM call waits on the limiter.
func startedAgain(f *invocationHTTP) func() bool {
	f.base.mu.Lock()
	before := f.base.startCalls
	f.base.mu.Unlock()
	return func() bool {
		f.base.mu.Lock()
		defer f.base.mu.Unlock()
		return f.base.startCalls > before
	}
}

// claims counts the assignment requests and execution starts so far.
func claims(f *invocationHTTP) int {
	f.base.mu.Lock()
	defer f.base.mu.Unlock()
	return f.base.assignmentCalls + f.base.startCalls
}

// duringRateWait runs call while the test holds the limiter's mutex, which
// the call's rate wait must take before it can grant the permit its refresh
// needs; nothing on the tick path before the LLM call takes that mutex. Once
// ready reports the call's pre-wait work done, change is applied to the
// server's snapshot and the mutex released; the refresh must then see a
// permit granted after that release.
//
// Lock order is one way: the test takes the limiter's mutex, then the
// fixture's. The refresh handler, which runs holding the fixture's mutex,
// only tries the limiter's, so a refresh that comes before the barrier is
// released is recorded as premature and fails the test instead of hanging
// it.
//
// With ready nil (a direct call, which makes no request before its wait)
// the held mutex alone orders the change after the call's capture and before
// its refresh: current-call drift. The call blocking inside limiter.wait
// itself is not observable without a production hook, so those tests claim
// only that ordering, not that the change landed during the wait.
func duringRateWait(t *testing.T, c *invocationCase, f *invocationHTTP, ready func() bool, change func(map[string]any), call func(context.Context) error) error {
	t.Helper()
	limiter := newRateLimiter(1)
	limiter.timestamps = []time.Time{time.Now().Add(-time.Minute + 200*time.Millisecond)}
	c.loop.limiter = limiter
	var releasedAt time.Time
	premature, permitAfterRelease := false, false
	f.mu.Lock()
	f.onRefresh = func() {
		if !limiter.mu.TryLock() {
			premature = true
			return
		}
		defer limiter.mu.Unlock()
		for _, granted := range limiter.timestamps {
			if !releasedAt.IsZero() && !granted.Before(releasedAt) {
				permitAfterRelease = true
			}
		}
	}
	f.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	limiter.mu.Lock()
	held := true
	release := func() {
		if held {
			held = false
			limiter.mu.Unlock()
		}
	}
	defer release()
	finished := make(chan error, 1)
	go func() { finished <- call(ctx) }()
	if ready != nil {
		deadline := time.Now().Add(2 * time.Second)
		for !ready() {
			if time.Now().After(deadline) {
				t.Fatal("fixture: the call never finished its pre-wait work (discovery and claim)")
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	f.mu.Lock()
	refreshedBefore := len(f.queries)
	f.snapshot["card"].(map[string]any)["title"] = "Edited while waiting é"
	f.snapshot["dispatch_revision"] = strings.Repeat("7", 64)
	if change != nil {
		change(f.snapshot)
	}
	releasedAt = time.Now()
	f.mu.Unlock()
	release()
	err := <-finished
	f.mu.Lock()
	refreshes, sawPremature, sawPermit := len(f.queries), premature, permitAfterRelease
	f.onRefresh = nil
	f.mu.Unlock()
	if refreshedBefore != 0 || sawPremature {
		t.Fatalf("fixture: the call refreshed before its rate wait was released (%d refreshes before the change, premature %v)", refreshedBefore, sawPremature)
	}
	if refreshes > 0 && !sawPermit {
		t.Fatal("fixture: the call refreshed without a rate permit granted after the change")
	}
	return err
}

// stageWithDrift calls the stage directly, its flags changed after its
// capture and before its refresh (current-call drift).
func (c *invocationCase) stageWithDrift(t *testing.T, change func(map[string]any)) (*llmStageResult, error) {
	t.Helper()
	var outcome *llmStageResult
	err := duringRateWait(t, c, c.http, nil, change, func(ctx context.Context) error {
		var err error
		outcome, err = c.strategy.executeLLM(ctx, ctx, c.loop, c.card, c.execution, c.repoDir)
		return err
	})
	return outcome, err
}

func setFlag(name string, value any) func(map[string]any) {
	return func(s map[string]any) { semanticsFlags(s)[name] = value }
}

// expectNoPreparation asserts the call refreshed once and went no further.
func expectNoPreparation(t *testing.T, c *invocationCase, f *invocationHTTP) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.queries) != 1 || len(f.payloads) != 0 || c.current.CallCount()+c.stale.CallCount() != 0 {
		t.Errorf("a call refused for its configuration went on: refresh=%d prepare=%d provider=%d events=%v",
			len(f.queries), len(f.payloads), c.current.CallCount()+c.stale.CallCount(), f.events)
	}
}

func configurationChanged(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "configuration changed")
}

// expectPreparedOnce asserts the call refreshed, prepared and invoked once,
// in that order.
func expectPreparedOnce(t *testing.T, c *invocationCase, f *invocationHTTP) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.queries) != 1 || len(f.payloads) != 1 || c.current.CallCount() != 1 || c.stale.CallCount() != 0 {
		t.Fatalf("an unchanged call was not prepared and invoked once: refresh=%d prepare=%d current=%d stale=%d events=%v",
			len(f.queries), len(f.payloads), c.current.CallCount(), c.stale.CallCount(), f.events)
	}
	if len(f.events) != 3 || f.events[0] != "refresh" || f.events[1] != "prepare" || f.events[2] != "provider:"+invocationProvider {
		t.Errorf("dispatch order = %v", f.events)
	}
}

// The call itself only refuses: releasing the card is its tick's business.
func expectCallLeftTheCardAlone(t *testing.T, c *invocationCase, h *releaseRecorder) {
	t.Helper()
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.statusUpdates) != 0 || len(h.participantDeletes) != 0 || h.moves != 0 {
		t.Errorf("the refused call itself touched the card: status updates %v, participant deletes %v, moves %d", h.statusUpdates, h.participantDeletes, h.moves)
	}
	if count := c.loop.CardFailureCount(runnerDispatchCard); count != 0 {
		t.Errorf("the refused call counted %d failures", count)
	}
}

// Current-call drift at the call boundary: the flags change after the call
// captured its configuration and before its refresh.
func TestContextDispatchCallSemanticsFlagsDriftAfterCaptureBeforeRefresh(t *testing.T) {
	for _, tc := range []struct {
		name, stage, cached string
		change              func(map[string]any)
	}{
		{"decision_to_note", "continue_project", "produces_decision", setFlag("post_process_kind", "produces_note")},
		{"note_to_decision", "continue_project", "produces_note", setFlag("post_process_kind", "produces_decision")},
		{"inject_directives_enabled", "continue_project", "produces_note", setFlag("inject_directives", true)},
		{"minimal_prompt_enabled", "continue_project", "produces_note", setFlag("use_minimal_prompt_when_unauthored", true)},
		{"implement_approval_enabled", "implement", "writes_code", setFlag("approval_enabled", true)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, f := semanticsCase(t, tc.stage, tc.cached)
			h := recordReleases(t, c, f)
			outcome, err := c.stageWithDrift(t, tc.change)
			expectNoPreparation(t, c, f)
			if outcome != nil {
				t.Errorf("an outcome was decoded under the cached configuration: decision=%q", outcome.decision)
			}
			if !configurationChanged(err) {
				t.Errorf("want an actionable configuration-changed outcome, got %v", err)
			}
			expectCallLeftTheCardAlone(t, c, h)
		})
	}
}

// Consumed flags have exact wire types: post_process_kind a string ("" when
// unset), approval_enabled a bool, the directive flags a bool or null. A
// missing key, a null where null is not allowed, or another type cannot be
// compared, so the call fails closed.
func TestContextDispatchCallSemanticsMalformedConsumedFlagFailsClosed(t *testing.T) {
	missing := func(name string) func(map[string]any) {
		return func(s map[string]any) { delete(semanticsFlags(s), name) }
	}
	for _, tc := range []struct {
		name, stage, kind string
		change            func(map[string]any)
	}{
		{"post_process_kind_missing", "continue_project", "produces_note", missing("post_process_kind")},
		{"post_process_kind_null", "continue_project", "produces_note", setFlag("post_process_kind", nil)},
		{"post_process_kind_number", "continue_project", "produces_note", setFlag("post_process_kind", 7)},
		{"inject_directives_missing", "continue_project", "produces_note", missing("inject_directives")},
		{"inject_directives_string", "continue_project", "produces_note", setFlag("inject_directives", "false")},
		{"minimal_prompt_missing", "continue_project", "produces_note", missing("use_minimal_prompt_when_unauthored")},
		{"implement_approval_missing", "implement", "writes_code", missing("approval_enabled")},
		{"implement_approval_null", "implement", "writes_code", setFlag("approval_enabled", nil)},
		{"implement_approval_string", "implement", "writes_code", setFlag("approval_enabled", "false")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, f := semanticsCase(t, tc.stage, tc.kind)
			tc.change(f.snapshot)
			outcome, err := c.strategy.executeLLM(context.Background(), context.Background(), c.loop, c.card, c.execution, c.repoDir)
			if err == nil {
				t.Error("a call whose consumed flag is malformed was accepted")
			}
			if outcome != nil {
				t.Errorf("an outcome was decoded without a comparable flag: decision=%q", outcome.decision)
			}
			expectNoPreparation(t, c, f)
		})
	}
}

// Flags unchanged between capture and refresh, the unset directive flags
// null or false: the call prepares once, invokes once and decodes under its
// kind.
func TestContextDispatchCallSemanticsUnchangedBeforeRefresh(t *testing.T) {
	for _, tc := range []struct {
		name, stage, kind string
		unsetAsFalse      bool
	}{
		{"produces_decision", "continue_project", "produces_decision", false},
		{"produces_note", "continue_project", "produces_note", false},
		{"produces_note_unset_flags_false", "continue_project", "produces_note", true},
		{"implement", "implement", "writes_code", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, f := semanticsCase(t, tc.stage, tc.kind)
			if tc.unsetAsFalse {
				flags := semanticsFlags(f.snapshot)
				flags["inject_directives"], flags["use_minimal_prompt_when_unauthored"] = false, false
			}
			outcome, err := c.stageWithDrift(t, nil)
			if err != nil {
				t.Fatalf("an unchanged call was refused: %v", err)
			}
			expectPreparedOnce(t, c, f)
			schema := c.current.LastCall().Options.OutputSchema
			switch tc.kind {
			case "produces_decision":
				if schema != decisionOutputSchema || outcome.reviewResult == nil || outcome.decision != "approve" {
					t.Errorf("a decision call was not offered the decision schema and decoded as one: schema=%q outcome=%+v", schema, outcome)
				}
			case "produces_note":
				if schema != "" || outcome.reviewResult == nil || outcome.reviewResult.Summary != "Synthetic result" {
					t.Errorf("a note call was offered a schema or not decoded as a note: schema=%q outcome=%+v", schema, outcome)
				}
			case "writes_code":
				if outcome.implResult == nil || outcome.implResult.Status != "done" {
					t.Errorf("an implement call was not decoded: %+v", outcome)
				}
			}
		})
	}
}

// The server sends the kind as configured, "" when none is; that and an
// explicit kind equal to the stage's default are the same configuration.
func TestContextDispatchCallSemanticsUnsetKindMatchesTheStageDefault(t *testing.T) {
	for _, tc := range []struct{ stage, cached string }{
		{"review", ""},
		{"review", "produces_decision"},
		{"implement", "writes_code"},
	} {
		t.Run(tc.stage+"_cached_"+tc.cached, func(t *testing.T) {
			c, f := semanticsCase(t, tc.stage, tc.cached)
			semanticsFlags(f.snapshot)["post_process_kind"] = ""
			if _, err := c.strategy.executeLLM(context.Background(), context.Background(), c.loop, c.card, c.execution, c.repoDir); err != nil {
				t.Fatalf("a stage whose kind is its default was refused: %v", err)
			}
			expectPreparedOnce(t, c, f)
		})
	}
}

// Calls whose decoder, schema and inputs are fixed by their slot capture no
// stage flag, so a drift in the stage's main flags never refuses them.
func TestContextDispatchCallSemanticsAuxiliarySlotsIgnoreMainFlags(t *testing.T) {
	changeAll := func(s map[string]any) {
		flags := semanticsFlags(s)
		flags["post_process_kind"] = "produces_decision"
		flags["approval_enabled"] = true
		flags["inject_directives"] = true
		flags["use_minimal_prompt_when_unauthored"] = true
	}
	for _, tc := range []struct {
		name       string
		invocation map[string]any
		call       func(ctx context.Context, c *invocationCase) error
	}{
		{"rework_implement", map[string]any{"kind": "stage", "step_name": nil, "prompt_slot": "rework_implement"}, func(ctx context.Context, c *invocationCase) error {
			_, err := c.loop.reworkImplement(ctx, c.card, c.execution, c.repoDir, "Synthetic action plan")
			return err
		}},
		{"post_approval", map[string]any{"kind": "post_approval", "step_name": nil, "prompt_slot": "implement_after_approval"}, func(ctx context.Context, c *invocationCase) error {
			_, err := c.loop.implementAfterApproval(ctx, c.card, c.execution, c.repoDir, "Approved synthetic plan")
			return err
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, f := semanticsCase(t, "continue_project", "produces_note")
			f.snapshot["invocation"] = tc.invocation
			err := duringRateWait(t, c, f, nil, changeAll, func(ctx context.Context) error { return tc.call(ctx, c) })
			if err != nil {
				t.Fatalf("an auxiliary slot was refused for a main-slot flag: %v", err)
			}
			expectPreparedOnce(t, c, f)
		})
	}
}

// expectReleased asserts one tick released the card for a fresh assignment:
// its execution ended aborted once, saying why, before the claimed
// participant (participant) was removed once; nothing failed or moved.
func expectReleased(t *testing.T, c *invocationCase, h *releaseRecorder, participant string) {
	t.Helper()
	h.mu.Lock()
	defer h.mu.Unlock()
	aborted := 0
	for _, update := range h.statusUpdates {
		switch update["status"] {
		case "aborted":
			aborted++
			if summary, _ := update["output_summary"].(string); !strings.Contains(strings.ToLower(summary), "configuration changed") {
				t.Errorf("the aborted execution does not say its configuration changed: %v", update)
			}
		case "failed", "completed":
			t.Errorf("a released card's execution ended %q: %v", update["status"], update)
		}
	}
	if aborted != 1 {
		t.Errorf("want the bound execution ended aborted once, got status updates %v", h.statusUpdates)
	}
	if len(h.participantDeletes) != 1 || !strings.HasSuffix(h.participantDeletes[0], "/participants/"+participant) {
		t.Errorf("want the claimed participant %s removed once, got participant deletes %v", participant, h.participantDeletes)
	}
	if strings.Join(h.cleanup, ",") != "abort,unassign" {
		t.Errorf("want the execution aborted, then the participant removed; got %v", h.cleanup)
	}
	if h.moves != 0 {
		t.Errorf("a released card was moved %d times", h.moves)
	}
	if count := c.loop.CardFailureCount(runnerDispatchCard); count != 0 {
		t.Errorf("a released card counted %d failures", count)
	}
}

// One whole tick on a freshly assigned card. The release removes the
// participant the claim bound, through the runner's existing release
// identity: a hero claim binds the owner, a helper claim the agent.
func TestContextDispatchCallSemanticsTickReleasesTheCard(t *testing.T) {
	for _, tc := range []struct{ name, role, cached, current, participant string }{
		{"hero_decision_to_note", "hero", "produces_decision", "produces_note", runnerDispatchOwner},
		{"hero_note_to_decision", "hero", "produces_note", "produces_decision", runnerDispatchOwner},
		{"helper_decision_to_note", "helper", "produces_decision", "produces_note", runnerDispatchAgent},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, f := semanticsCase(t, "continue_project", tc.cached)
			c.strategy.config.Claim.ParticipantRole = tc.role
			h := recordReleases(t, c, f)
			err := duringRateWait(t, c, f, startedAgain(f), setFlag("post_process_kind", tc.current), c.loop.tick)
			expectNoPreparation(t, c, f)
			if err != nil {
				t.Errorf("a released card is a clean tick, got %v", err)
			}
			expectReleased(t, c, h, tc.participant)
		})
	}
}

// Through the lifecycle walker, from its own discover and claim: the judge
// step has a reachable next step and a reachable on_failure step, and the
// stage an on_failure move. The release stops the walk cleanly, so none of
// them runs: the only refresh is the judge's.
func TestContextDispatchCallSemanticsWalkerStopsCleanly(t *testing.T) {
	c, f := semanticsCase(t, "continue_project", "produces_decision")
	f.snapshot["invocation"] = map[string]any{"kind": "lifecycle", "step_name": "judge", "prompt_slot": "main"}
	c.strategy.config.OnFailure.MoveToColumnType = "backlog"
	note := map[string]any{"stage": "continue_project", "post_process_kind": "produces_note"}
	c.strategy.config.Lifecycle = []valaris.LifecycleStep{
		{Name: "discover", Kind: "discover", Next: "claim"},
		{Name: "claim", Kind: "claim", Next: "judge"},
		{Name: "judge", Kind: "llm", Params: map[string]any{"stage": "continue_project", "post_process_kind": "produces_decision"}, Next: "after-judge", OnFailure: "failure-route"},
		{Name: "after-judge", Kind: "llm", Params: note},
		{Name: "failure-route", Kind: "llm", Params: note},
	}
	h := recordReleases(t, c, f)
	err := duringRateWait(t, c, f, startedAgain(f), setFlag("post_process_kind", "produces_note"), c.loop.tick)
	expectNoPreparation(t, c, f)
	f.mu.Lock()
	for _, query := range f.queries {
		if step := query.Get("step_name"); step != "judge" {
			t.Errorf("the walk went on to step %q after the release", step)
		}
	}
	f.mu.Unlock()
	if err != nil {
		t.Errorf("a released card is a clean walk, got %v", err)
	}
	expectReleased(t, c, h, runnerDispatchOwner)
}

// noteProvider swaps in a provider answering a verdict-less note: decoded as
// a decision it would become request_changes; decoded as a note it is the
// note's summary.
func noteProvider(c *invocationCase, f *invocationHTTP) *invocationProviderRecorder {
	mock := llm.NewMockProvider("Plain note prose without a verdict")
	mock.NameOverride = invocationProvider
	mock.Caps.PromptChannels = llm.PromptChannels{Version: 1, FreshInput: true, FreshSystem: true, ResumeInput: true, ResumeSystem: true}
	next := &invocationProviderRecorder{MockProvider: mock, fixture: f}
	c.loop.providers[invocationProvider] = next
	return next
}

// nextTick runs one more tick with a fresh test permit (the 1/min permit of
// the test's limiter is spent; production throttling is untouched) and the
// call records cleared.
func nextTick(t *testing.T, c *invocationCase, f *invocationHTTP, tick func(context.Context) error) error {
	t.Helper()
	c.loop.limiter.mu.Lock()
	c.loop.limiter.timestamps = nil
	c.loop.limiter.mu.Unlock()
	f.mu.Lock()
	f.queries, f.payloads, f.events = nil, nil, nil
	f.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return tick(ctx)
}

// expectNoteCall asserts the tick prepared and invoked one call shaped as
// the refreshed note: no decision schema, and nothing decoded as a verdict.
func expectNoteCall(t *testing.T, f *invocationHTTP, h *releaseRecorder, next *invocationProviderRecorder, calls int) {
	t.Helper()
	f.mu.Lock()
	prepared := len(f.payloads)
	f.mu.Unlock()
	if prepared != 1 || next.CallCount() != calls {
		t.Fatalf("the refreshed role did not run its call: prepare=%d provider=%d (want 1, %d)", prepared, next.CallCount(), calls)
	}
	if schema := next.LastCall().Options.OutputSchema; schema != "" {
		t.Errorf("the refreshed role was offered the stale decision schema: %q", schema)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, update := range h.statusUpdates {
		if summary, _ := update["output_summary"].(string); strings.Contains(summary, "request_changes") {
			t.Errorf("the refreshed role decoded the note as a decision: %v", update)
		}
	}
}

func abortsSoFar(h *releaseRecorder) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	aborted := 0
	for _, update := range h.statusUpdates {
		if update["status"] == "aborted" {
			aborted++
		}
	}
	return aborted
}

// After a release the next assignment runs under the refreshed configuration:
// the same card is not aborted again for the same stale contract, and the
// call is shaped and decoded as the refreshed kind.
func TestContextDispatchCallSemanticsNextTickRunsTheRefreshedConfiguration(t *testing.T) {
	c, f := semanticsCase(t, "continue_project", "produces_decision")
	h := recordReleases(t, c, f)
	h.serve(servedConfig(2, withKind(c.strategy.config, "produces_note")))
	if err := duringRateWait(t, c, f, startedAgain(f), setFlag("post_process_kind", "produces_note"), c.loop.tick); err != nil {
		t.Errorf("a released card is a clean tick, got %v", err)
	}
	expectReleased(t, c, h, runnerDispatchOwner)
	next := noteProvider(c, f)
	if err := nextTick(t, c, f, c.loop.tick); err != nil {
		t.Errorf("the next assignment's tick failed: %v", err)
	}
	expectNoteCall(t, f, h, next, 1)
	if aborted := abortsSoFar(h); aborted != 1 {
		t.Errorf("the same card was aborted again for the same stale contract: %d aborts", aborted)
	}
}

// A release fetches the agent's config exactly once, and what it refreshed
// is what later production authority passes keep: a pass over the cached
// config does not restore the stale strategy.
func TestContextDispatchCallSemanticsRefreshedRoleSurvivesLaterAuthorityPasses(t *testing.T) {
	c, f := semanticsCase(t, "continue_project", "produces_decision")
	h := recordReleases(t, c, f)
	h.serve(servedConfig(2, withKind(c.strategy.config, "produces_note")))
	if err := duringRateWait(t, c, f, startedAgain(f), setFlag("post_process_kind", "produces_note"), c.loop.tick); err != nil {
		t.Errorf("a released card is a clean tick, got %v", err)
	}
	expectReleased(t, c, h, runnerDispatchOwner)
	if gets := h.configRequests(); gets != 1 {
		t.Errorf("want the release to fetch the agent's config once, got %d", gets)
	}
	next := noteProviderFor(c, f, 2)
	c.loop.applyPlatformAuthority(context.Background())
	if err := nextTick(t, c, f, c.loop.tick); err != nil {
		t.Errorf("the tick after an authority pass failed: %v", err)
	}
	expectNoteCall(t, f, h, next, 1)
	c.loop.applyPlatformAuthority(context.Background())
	if err := nextTick(t, c, f, c.loop.tick); err != nil {
		t.Errorf("the tick after a second authority pass failed: %v", err)
	}
	expectNoteCall(t, f, h, next, 2)
	if aborted := abortsSoFar(h); aborted != 1 {
		t.Errorf("a later authority pass restored the stale configuration: %d aborts", aborted)
	}
}

// untouchedRole is a pipeline role unrelated to the release; it only counts
// the ticks the scheduler gives it.
type untouchedRole struct {
	mu    sync.Mutex
	ticks int
}

func (r *untouchedRole) Name() string           { return otherRole }
func (r *untouchedRole) AllowedTools() []string { return nil }
func (r *untouchedRole) Tick(context.Context, *Loop) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ticks++
	return nil
}

// Multi-role: the scheduler's next pick of the released role runs the
// refreshed configuration, and the unrelated role is still scheduled as it
// was.
func TestContextDispatchCallSemanticsSchedulerRunsTheRefreshedRole(t *testing.T) {
	c, f := semanticsCase(t, "continue_project", "produces_decision")
	h := recordReleases(t, c, f)
	other := &untouchedRole{}
	role := c.strategy.config.Role
	c.loop.ownedStrategies[otherRole] = other
	c.loop.platformPriorityOrder = []string{role, otherRole}
	c.loop.platformConfig.PipelineConfig.Stages = append(c.loop.platformConfig.PipelineConfig.Stages, otherStage())
	c.loop.scheduler = NewScheduler(map[string]Strategy{role: c.strategy, otherRole: other}, []string{role, otherRole}, "priority")
	h.serve(servedConfig(2, withKind(c.strategy.config, "produces_note"), otherStage()))
	if err := duringRateWait(t, c, f, startedAgain(f), setFlag("post_process_kind", "produces_note"), c.loop.tick); err != nil {
		t.Errorf("a released card is a clean tick, got %v", err)
	}
	expectReleased(t, c, h, runnerDispatchOwner)
	next := noteProvider(c, f)
	if err := nextTick(t, c, f, c.loop.tick); err != nil {
		t.Errorf("the scheduler's next tick failed: %v", err)
	}
	expectNoteCall(t, f, h, next, 1)
	// With no work left for the released role, the scheduler moves on to the
	// unrelated role, which it still holds.
	f.base.mu.Lock()
	f.base.assignmentStatus = 204
	f.base.mu.Unlock()
	if err := nextTick(t, c, f, c.loop.tick); err != nil {
		t.Errorf("the scheduler's idle tick failed: %v", err)
	}
	other.mu.Lock()
	ticks := other.ticks
	other.mu.Unlock()
	if ticks == 0 {
		t.Error("the unrelated role was no longer scheduled after the refresh")
	}
}

// A role the refresh withdraws from the pipeline, or that leaves the
// runner's team-role scope while its call is in flight, is disabled: it
// claims nothing on the next tick, nor after a later authority pass.
func TestContextDispatchCallSemanticsWithdrawnRoleStaysDisabled(t *testing.T) {
	for _, name := range []string{"withdrawn", "out_of_scope"} {
		t.Run(name, func(t *testing.T) {
			c, f := semanticsCase(t, "continue_project", "produces_decision")
			h := recordReleases(t, c, f)
			change := setFlag("post_process_kind", "produces_note")
			if name == "withdrawn" {
				h.serve(servedConfig(2, otherStage()))
			} else {
				h.serve(servedConfig(2, withKind(c.strategy.config, "produces_note"), otherStage()))
				// The scope narrows after the call was bound, while it waits:
				// the tick goroutine is held at the limiter, so this write
				// is ordered before anything the release reads.
				change = func(s map[string]any) {
					setFlag("post_process_kind", "produces_note")(s)
					c.loop.scopedTeamRoles = map[string]struct{}{otherRole: {}}
				}
			}
			if err := duringRateWait(t, c, f, startedAgain(f), change, c.loop.tick); err != nil {
				t.Errorf("a released card is a clean tick, got %v", err)
			}
			expectReleased(t, c, h, runnerDispatchOwner)
			before := claims(f)
			_ = nextTick(t, c, f, c.loop.tick)
			c.loop.applyPlatformAuthority(context.Background())
			_ = nextTick(t, c, f, c.loop.tick)
			if after := claims(f); after != before {
				t.Errorf("a %s role went on claiming: %d assignment requests and starts after the release", name, after-before)
			}
			if aborted := abortsSoFar(h); aborted != 1 {
				t.Errorf("a %s role was run again with its stale configuration: %d aborts", name, aborted)
			}
		})
	}
}

// pausedForRefresh reports a config error naming role as paused because its
// configuration could not be refreshed.
func pausedForRefresh(errs []valaris.ConfigError, role string) bool {
	for _, err := range errs {
		if strings.Contains(err.Message, role) && strings.Contains(strings.ToLower(err.Message), "could not be refreshed") {
			return true
		}
	}
	return false
}

// A refresh that fails, or still disagrees with the call the server now
// names, pauses the role: no claim with its stale semantics, even after an
// authority pass over the stale cached config, and an actionable config
// error. A later poll whose refresh succeeds re-enables it under the new
// configuration.
func TestContextDispatchCallSemanticsFailedRoleRefreshPausesUntilRecovered(t *testing.T) {
	for _, name := range []string{"fetch_fails", "still_disagrees"} {
		t.Run(name, func(t *testing.T) {
			c, f := semanticsCase(t, "continue_project", "produces_decision")
			h := recordReleases(t, c, f)
			role := c.strategy.config.Role
			stale := c.strategy.config
			if name == "fetch_fails" {
				h.mu.Lock()
				h.failConfig = true
				h.mu.Unlock()
			} else {
				h.serve(servedConfig(2, stale))
			}
			if err := duringRateWait(t, c, f, startedAgain(f), setFlag("post_process_kind", "produces_note"), c.loop.tick); err != nil {
				t.Errorf("a released card is a clean tick, got %v", err)
			}
			expectReleased(t, c, h, runnerDispatchOwner)
			before := claims(f)
			_ = nextTick(t, c, f, c.loop.tick)
			c.loop.applyPlatformAuthority(context.Background())
			_ = nextTick(t, c, f, c.loop.tick)
			if after := claims(f); after != before {
				t.Errorf("a role whose refresh %s claimed again with its stale semantics: %d assignment requests and starts", name, after-before)
			}
			if !pausedForRefresh(c.loop.validateConfig(), role) {
				t.Errorf("no actionable config error says %s is paused because its configuration could not be refreshed: %v", role, c.loop.validateConfig())
			}

			h.mu.Lock()
			h.failConfig = false
			h.mu.Unlock()
			h.serve(servedConfig(3, withKind(stale, "produces_note")))
			next := noteProvider(c, f)
			if err := nextTick(t, c, f, func(ctx context.Context) error {
				c.loop.pollCycle(ctx, ctx)
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			expectNoteCall(t, f, h, next, 1)
			if pausedForRefresh(c.loop.validateConfig(), role) {
				t.Errorf("the role is still reported paused after a successful refresh: %v", c.loop.validateConfig())
			}
		})
	}
}

// A release that could not be recorded is not claimed: the tick reports the
// configuration change instead of a clean release. The injected failure is
// shown reached; cleanup keeps its order (abort, then unassign) and the
// existing bounded retry of a transient failure (at most three attempts per
// request); no ordinary failure handling runs instead: no failed or
// completed execution, no move, no failure count. Later ticks may retry the
// owned cleanup but start no new work while it stays unrecorded.
func TestContextDispatchCallSemanticsUnrecordedReleaseIsNotClaimed(t *testing.T) {
	for _, tc := range []struct {
		name                 string
		failAbort, failUnset bool
	}{
		{"abort_fails", true, false},
		{"unassign_fails", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, f := semanticsCase(t, "continue_project", "produces_decision")
			h := recordReleases(t, c, f)
			h.mu.Lock()
			h.failAbort, h.failUnassign = tc.failAbort, tc.failUnset
			h.mu.Unlock()
			h.serve(servedConfig(2, withKind(c.strategy.config, "produces_note")))
			err := duringRateWait(t, c, f, startedAgain(f), setFlag("post_process_kind", "produces_note"), c.loop.tick)
			expectNoPreparation(t, c, f)
			if !configurationChanged(err) {
				t.Errorf("a release that failed to record was reported as done: %v", err)
			}
			h.mu.Lock()
			aborts, unassigns, lastAbort, firstUnassign := 0, 0, -1, -1
			for index, attempt := range h.cleanup {
				switch attempt {
				case "abort":
					aborts++
					lastAbort = index
				case "unassign":
					unassigns++
					if firstUnassign < 0 {
						firstUnassign = index
					}
				}
			}
			if firstUnassign >= 0 && firstUnassign < lastAbort {
				t.Errorf("the participant was removed before the execution was aborted: %v", h.cleanup)
			}
			switch {
			case tc.failAbort && (aborts < 1 || aborts > 3):
				t.Errorf("the failing aborted PATCH was attempted %d times, want 1 to 3: %v", aborts, h.cleanup)
			case tc.failAbort && unassigns != 0:
				t.Errorf("the participant was removed while the execution was still bound (no abort acknowledged): %v", h.cleanup)
			case tc.failUnset && aborts != 1:
				t.Errorf("the aborted PATCH succeeded but was sent %d times: %v", aborts, h.cleanup)
			case tc.failUnset && (unassigns < 1 || unassigns > 3):
				t.Errorf("the failing participant DELETE was attempted %d times, want 1 to 3: %v", unassigns, h.cleanup)
			}
			for _, path := range h.participantDeletes {
				if !strings.HasSuffix(path, "/participants/"+runnerDispatchOwner) {
					t.Errorf("the release removed another identity than the claimed owner: %s", path)
				}
			}
			for _, update := range h.statusUpdates {
				if update["status"] == "failed" || update["status"] == "completed" {
					t.Errorf("an unrecorded release fell back to ending the execution %q: %v", update["status"], update)
				}
			}
			if h.moves != 0 {
				t.Errorf("an unrecorded release moved the card %d times", h.moves)
			}
			h.mu.Unlock()
			if count := c.loop.CardFailureCount(runnerDispatchCard); count != 0 {
				t.Errorf("an unrecorded release counted %d failures", count)
			}

			// While the cleanup stays unrecorded, a following tick and an
			// authority pass may retry the owned cleanup, but neither claims
			// the release nor starts new work for the role.
			role := c.strategy.config.Role
			before := claims(f)
			for _, step := range []string{"following tick", "tick after an authority pass"} {
				if step != "following tick" {
					c.loop.applyPlatformAuthority(context.Background())
				}
				_ = nextTick(t, c, f, c.loop.tick)
				f.mu.Lock()
				prepared := len(f.payloads)
				f.mu.Unlock()
				if after := claims(f); after != before || prepared != 0 || c.current.CallCount()+c.stale.CallCount() != 0 {
					t.Errorf("%s: new work while the cleanup is unrecorded: %d claims, %d preparations, %d provider calls",
						step, after-before, prepared, c.current.CallCount()+c.stale.CallCount())
				}
			}
			h.mu.Lock()
			if tc.failAbort && len(h.participantDeletes) != 0 {
				t.Errorf("a later tick removed the participant while no abort was acknowledged: %v", h.cleanup)
			}
			for _, update := range h.statusUpdates {
				if update["status"] == "failed" || update["status"] == "completed" {
					t.Errorf("a later tick ended the unreleased execution %q: %v", update["status"], update)
				}
			}
			if h.moves != 0 {
				t.Errorf("a later tick moved the unreleased card %d times", h.moves)
			}
			h.mu.Unlock()
			if count := c.loop.CardFailureCount(runnerDispatchCard); count != 0 {
				t.Errorf("a later tick counted %d failures", count)
			}
			if !reportsRole(c.loop.validateConfig(), role) {
				t.Errorf("no config error reports %s paused while its release is unrecorded: %v", role, c.loop.validateConfig())
			}
		})
	}
}

// reportsRole reports a config error naming role.
func reportsRole(errs []valaris.ConfigError, role string) bool {
	for _, err := range errs {
		if strings.Contains(err.Message, role) {
			return true
		}
	}
	return false
}
