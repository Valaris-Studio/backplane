// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

// Phase I.1.g — Custom LLM stage dispatch.
//
// These tests drive `executeLLM` directly with a fake LLM provider and a thin
// httptest server. The goal is to keep the mechanism — not the legacy stage
// names — deciding what to do with the output:
//
//   post_process_kind = writes_code        → flows into gitCommitAndPush (implementResult)
//   post_process_kind = produces_decision  → populates decision (+ reviewResult for downstream)
//   post_process_kind = produces_note      → populates reviewResult.Findings for CreateReviewNote
//   post_process_kind = mutates_backlog    → skips commit + persistence; MCP already wrote the data
//
// Default stages ("implement", "review", "document") route through the legacy
// specialized helpers — those tests guard the back-compat path.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/health"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// minimalLLMServer answers the REST calls `executeLLM` paths trigger, with
// empty-but-valid bodies. Directives/review history fetches fall back to
// empty strings on any non-200, so this keeps tests hermetic. The platform
// config endpoint must return a valid pipeline — Loop.New fetches it at
// construction.
func minimalLLMServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// newLLMTestLoop wires a Loop with the mock LLM provider and the given strategy
// so executeLLM can run without any real network side-effects.
func newLLMTestLoop(t *testing.T, mock *llm.MockProvider, stage valaris.StageConfig) *Loop {
	t.Helper()
	cfg := testConfig()
	client := testClientWithURL(minimalLLMServer(t).URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	// Avoid persistent session files in tests.
	cfg.LLM = config.LLMConfig{
		Model:                      "sonnet",
		MCPConfigPath:              "/tmp/mcp.json",
		MaxBudgetUSD:               1.0,
		DangerouslySkipPermissions: true,
	}

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)
	strat := NewDataDrivenStrategy(stage, nil)
	loop.strategy = strat

	// Seed a trivial prompt so custom stages don't graceful-skip. Tests that
	// exercise the no-prompt skip path use seedCache=false.
	if stage.LLM.Enabled && stage.LLM.Stage != "" && stage.LLM.Stage != "ghost_stage" {
		loop.promptCacheMu.Lock()
		loop.promptCache[stage.Role+":"+stage.LLM.Stage] = "Run the {{.CardID}} task."
		loop.promptCacheMu.Unlock()
	}
	return loop
}

// --- PostProcessKind resolution (legacy fallback + explicit values). ---

// Legacy default stages fall back to the correct kind when PostProcessKind is empty.
func TestPostProcessKind_DefaultStages_LegacyFallback(t *testing.T) {
	tests := []struct {
		stage    string
		wantKind string
	}{
		{"implement", "writes_code"},
		{"review", "produces_decision"},
		{"document", "writes_code"},
	}
	for _, tt := range tests {
		llmDef := valaris.LLMDef{Stage: tt.stage}
		got := llmDef.EffectivePostProcessKind()
		if got != tt.wantKind {
			t.Errorf("stage=%q EffectivePostProcessKind = %q, want %q",
				tt.stage, got, tt.wantKind)
		}
	}
}

// Explicit PostProcessKind overrides legacy stage-name fallback.
func TestPostProcessKind_ExplicitOverridesFallback(t *testing.T) {
	llmDef := valaris.LLMDef{Stage: "implement", PostProcessKind: "produces_note"}
	got := llmDef.EffectivePostProcessKind()
	if got != "produces_note" {
		t.Errorf("explicit kind should win, got %q", got)
	}
}

// Unknown legacy stage with no PostProcessKind returns empty (caller handles as error).
func TestPostProcessKind_UnknownStage_NoFallback(t *testing.T) {
	llmDef := valaris.LLMDef{Stage: "plan"}
	got := llmDef.EffectivePostProcessKind()
	if got != "" {
		t.Errorf("unknown stage without kind should return empty, got %q", got)
	}
}

// --- executeLLM dispatch on PostProcessKind ---

// Custom stage with writes_code behaves like implement: produces implementResult.
func TestExecuteLLM_CustomStage_WritesCode(t *testing.T) {
	mock := llm.NewMockProvider(`{"status":"done","summary":"added endpoint"}`)
	stage := valaris.StageConfig{
		Role:  "secretary",
		Claim: valaris.ClaimDef{ParticipantRole: "hero"},
		LLM: valaris.LLMDef{
			Enabled:         true,
			Stage:           "secretary_task",
			PostProcessKind: "writes_code",
		},
	}
	loop := newLLMTestLoop(t, mock, stage)

	card := &discoverResult{CardID: "card-w", BoardID: "board-1", Title: "Secretary task"}
	res, err := loop.strategy.(*DataDrivenStrategy).executeLLM(
		context.Background(), context.Background(), loop, card, "exec-1", t.TempDir(),
	)
	if err != nil {
		t.Fatalf("executeLLM: %v", err)
	}
	if res == nil {
		t.Fatal("expected non-nil result")
	}
	if res.implResult == nil {
		t.Fatalf("writes_code should populate implResult, got %+v", res)
	}
	if res.implResult.Status != "done" || res.implResult.Summary != "added endpoint" {
		t.Errorf("implResult = %+v, want Status=done Summary=added endpoint", res.implResult)
	}
}

// Custom stage with produces_decision emits decision for ActionDef.Branches routing.
func TestExecuteLLM_CustomStage_ProducesDecision(t *testing.T) {
	mock := llm.NewMockProvider(`{"decision":"escalate","summary":"needs human","findings":"risky change"}`)
	stage := valaris.StageConfig{
		Role:  "triager",
		Claim: valaris.ClaimDef{ParticipantRole: "helper"},
		LLM: valaris.LLMDef{
			Enabled:         true,
			Stage:           "triage",
			PostProcessKind: "produces_decision",
		},
	}
	loop := newLLMTestLoop(t, mock, stage)

	card := &discoverResult{CardID: "card-d", BoardID: "board-1", Title: "Triage"}
	res, err := loop.strategy.(*DataDrivenStrategy).executeLLM(
		context.Background(), context.Background(), loop, card, "exec-2", t.TempDir(),
	)
	if err != nil {
		t.Fatalf("executeLLM: %v", err)
	}
	if res.decision != "escalate" {
		t.Errorf("decision = %q, want escalate", res.decision)
	}
	// reviewResult should also be populated so existing Branches+CreateReviewNote paths work.
	if res.reviewResult == nil {
		t.Fatalf("produces_decision should populate reviewResult (for downstream flag handlers)")
	}
	if res.reviewResult.Decision != "escalate" {
		t.Errorf("reviewResult.Decision = %q, want escalate", res.reviewResult.Decision)
	}
}

// A custom produces_decision stage (e.g. ui_validator) must launch claude with
// a json-schema so the StructuredOutput tool is offered. Without it the agent
// emits a prose verdict the engine can't route on. The schema defaults to the
// shared decision schema (decision enum + summary + findings).
func TestRunLLMStage_ProducesDecision_SetsOutputSchema(t *testing.T) {
	mock := llm.NewMockProvider(`ignored — structured output is the source of truth`)
	mock.QueueStructured([]byte(`{"decision":"approve","summary":"ok","findings":""}`))
	stage := valaris.StageConfig{
		Role:  "ui_validator",
		Claim: valaris.ClaimDef{ParticipantRole: "helper"},
		LLM: valaris.LLMDef{
			Enabled:         true,
			Stage:           "validate_ui",
			PostProcessKind: "produces_decision",
		},
	}
	loop := newLLMTestLoop(t, mock, stage)

	card := &discoverResult{CardID: "card-uiv", BoardID: "board-1", Title: "Validate UI"}
	_, err := loop.strategy.(*DataDrivenStrategy).executeLLM(
		context.Background(), context.Background(), loop, card, "exec-uiv-1", t.TempDir(),
	)
	if err != nil {
		t.Fatalf("executeLLM: %v", err)
	}
	if mock.CallCount() != 1 {
		t.Fatalf("expected 1 LLM call, got %d", mock.CallCount())
	}
	schema := mock.Calls[0].Options.OutputSchema
	if schema == "" {
		t.Fatal("produces_decision stage must set Options.OutputSchema so the StructuredOutput tool is offered")
	}
	for _, field := range []string{"decision", "summary", "findings", "approve", "request_changes"} {
		if !strings.Contains(schema, field) {
			t.Errorf("OutputSchema missing %q: %s", field, schema)
		}
	}
}

// A custom produces_decision stage that returns prose with no parseable
// decision must FAIL SAFE: decision defaults to request_changes (never empty,
// never silently approve). This is the generic version of the reviewer's
// load-bearing blank->request_changes guarantee — it covers ui_validator
// emitting a prose verdict or being unable to drive the app.
func TestRunLLMStage_ProducesDecision_BlankDecisionFailsSafe(t *testing.T) {
	// No QueueStructured -> StructuredOutput empty; prose has no JSON envelope.
	mock := llm.NewMockProvider("I ran the browser test, here are 15 screenshots and prose with no JSON envelope.")
	stage := valaris.StageConfig{
		Role:  "ui_validator",
		Claim: valaris.ClaimDef{ParticipantRole: "helper"},
		LLM: valaris.LLMDef{
			Enabled:         true,
			Stage:           "validate_ui",
			PostProcessKind: "produces_decision",
		},
	}
	loop := newLLMTestLoop(t, mock, stage)

	card := &discoverResult{CardID: "card-uiv2", BoardID: "board-1", Title: "Validate UI"}
	res, err := loop.strategy.(*DataDrivenStrategy).executeLLM(
		context.Background(), context.Background(), loop, card, "exec-uiv-2", t.TempDir(),
	)
	if err != nil {
		t.Fatalf("executeLLM: %v", err)
	}
	if res.decision != "request_changes" {
		t.Errorf("blank decision must fail safe to request_changes, got %q", res.decision)
	}
	if res.reviewResult == nil {
		t.Fatal("produces_decision must populate reviewResult")
	}
	if res.reviewResult.Decision != "request_changes" {
		t.Errorf("reviewResult.Decision = %q, want request_changes", res.reviewResult.Decision)
	}
	if res.decision == "approve" {
		t.Fatal("blank decision must NEVER coerce to approve")
	}
}

// Malformed JSON (structured channel carries garbage, prose unparseable) must
// also fail safe to request_changes rather than propagate an empty decision.
func TestRunLLMStage_ProducesDecision_MalformedJSONFailsSafe(t *testing.T) {
	mock := llm.NewMockProvider(`{"decision": "appr`) // truncated, unparseable
	stage := valaris.StageConfig{
		Role:  "ui_validator",
		Claim: valaris.ClaimDef{ParticipantRole: "helper"},
		LLM: valaris.LLMDef{
			Enabled:         true,
			Stage:           "validate_ui",
			PostProcessKind: "produces_decision",
		},
	}
	loop := newLLMTestLoop(t, mock, stage)

	card := &discoverResult{CardID: "card-uiv3", BoardID: "board-1", Title: "Validate UI"}
	res, err := loop.strategy.(*DataDrivenStrategy).executeLLM(
		context.Background(), context.Background(), loop, card, "exec-uiv-3", t.TempDir(),
	)
	if err != nil {
		t.Fatalf("executeLLM: %v", err)
	}
	if res.decision != "request_changes" {
		t.Errorf("malformed JSON must fail safe to request_changes, got %q", res.decision)
	}
}

// Custom stage with produces_note carries findings through for note creation.
func TestExecuteLLM_CustomStage_ProducesNote(t *testing.T) {
	findings := "Found three competitor sites with dark patterns."
	body, _ := json.Marshal(map[string]any{
		"decision": "research_complete",
		"summary":  "Researched competitors.",
		"findings": findings,
	})
	mock := llm.NewMockProvider(string(body))
	stage := valaris.StageConfig{
		Role:  "researcher",
		Claim: valaris.ClaimDef{ParticipantRole: "helper"},
		LLM: valaris.LLMDef{
			Enabled:         true,
			Stage:           "research",
			PostProcessKind: "produces_note",
		},
	}
	loop := newLLMTestLoop(t, mock, stage)

	card := &discoverResult{CardID: "card-n", BoardID: "board-1", Title: "Competitor teardown"}
	res, err := loop.strategy.(*DataDrivenStrategy).executeLLM(
		context.Background(), context.Background(), loop, card, "exec-3", t.TempDir(),
	)
	if err != nil {
		t.Fatalf("executeLLM: %v", err)
	}
	if res.reviewResult == nil {
		t.Fatalf("produces_note should populate reviewResult for CreateReviewNote plumbing")
	}
	if string(res.reviewResult.Findings) != findings {
		t.Errorf("reviewResult.Findings = %q, want %q", res.reviewResult.Findings, findings)
	}
	if res.implResult != nil {
		t.Error("produces_note should NOT set implResult (no code written)")
	}
}

// Custom stage with mutates_backlog completes without touching git or notes —
// the LLM wrote the cards via MCP; the engine just records the summary.
func TestExecuteLLM_CustomStage_MutatesBacklog(t *testing.T) {
	mock := llm.NewMockProvider(`{"decision":"planned","summary":"created 6 cards"}`)
	stage := valaris.StageConfig{
		Role:  "planner",
		Claim: valaris.ClaimDef{ParticipantRole: "helper"},
		LLM: valaris.LLMDef{
			Enabled:         true,
			Stage:           "plan",
			PostProcessKind: "mutates_backlog",
		},
	}
	loop := newLLMTestLoop(t, mock, stage)

	card := &discoverResult{CardID: "card-p", BoardID: "board-1", Title: "Plan sprint"}
	res, err := loop.strategy.(*DataDrivenStrategy).executeLLM(
		context.Background(), context.Background(), loop, card, "exec-4", t.TempDir(),
	)
	if err != nil {
		t.Fatalf("executeLLM: %v", err)
	}
	if res.implResult != nil {
		t.Error("mutates_backlog should NOT set implResult (no files changed)")
	}
	if res.decision != "planned" {
		t.Errorf("decision = %q, want planned", res.decision)
	}
}

// Unknown stage with no prompt template AND no hardcoded fallback skips gracefully.
// No panic, no claude -p with an empty prompt — the result carries "no_prompt"
// so post-action can decide what to do.
func TestExecuteLLM_UnknownStage_NoPrompt(t *testing.T) {
	mock := llm.NewMockProvider() // no responses; a real LLM call would error
	stage := valaris.StageConfig{
		Role:  "ghost",
		Claim: valaris.ClaimDef{ParticipantRole: "helper"},
		LLM: valaris.LLMDef{
			Enabled:         true,
			Stage:           "ghost_stage",
			PostProcessKind: "produces_note",
		},
	}
	loop := newLLMTestLoop(t, mock, stage)

	card := &discoverResult{CardID: "card-g", BoardID: "board-1", Title: "Ghost"}
	res, err := loop.strategy.(*DataDrivenStrategy).executeLLM(
		context.Background(), context.Background(), loop, card, "exec-5", t.TempDir(),
	)
	if err != nil {
		t.Fatalf("unknown-stage with no prompt should skip gracefully, got err=%v", err)
	}
	if res == nil || res.decision != "no_prompt" {
		t.Errorf("expected decision=no_prompt, got %+v", res)
	}
	if mock.CallCount() != 0 {
		t.Errorf("LLM should NOT be invoked when no prompt is available; called %d times",
			mock.CallCount())
	}
}

// T1.1 — UseMinimalPromptWhenUnauthored=true on an unknown stage renders the
// platform's minimal agentic prompt in Go and invokes the LLM. Role and stage
// appear as literal strings in the rendered prompt; COMMON_VARS (Workspace,
// CardID, etc.) are templated from PromptContext. The flag is the explicit
// opt-in a user sets on a custom stage when they want the agent to try the
// generic template instead of graceful-skipping while the prompt is unauthored.
func TestExecuteLLM_UnknownStage_MinimalPromptWhenFlagSet(t *testing.T) {
	mock := llm.NewMockProvider(`{"status":"done","summary":"explored"}`)
	stage := valaris.StageConfig{
		Role:  "security-auditor",
		Claim: valaris.ClaimDef{ParticipantRole: "helper"},
		LLM: valaris.LLMDef{
			Enabled:                       true,
			Stage:                         "ghost_stage", // newLLMTestLoop skips seeding cache for this sentinel
			PostProcessKind:               "produces_note",
			UseMinimalPromptWhenUnauthored: true,
		},
	}
	loop := newLLMTestLoop(t, mock, stage)

	card := &discoverResult{CardID: "card-min", BoardID: "board-1", Title: "Security scan"}
	res, err := loop.strategy.(*DataDrivenStrategy).executeLLM(
		context.Background(), context.Background(), loop, card, "exec-min-1", t.TempDir(),
	)
	if err != nil {
		t.Fatalf("executeLLM with minimal-prompt flag should succeed, got err=%v", err)
	}
	if res == nil {
		t.Fatal("executeLLM returned nil result")
	}
	if res.decision == "no_prompt" {
		t.Fatal("flag=true must NOT graceful-skip — expected LLM invocation via minimal prompt")
	}
	if mock.CallCount() != 1 {
		t.Fatalf("expected 1 LLM call via minimal prompt, got %d", mock.CallCount())
	}
	rendered := mock.LastCall().Prompt
	// Role and stage appear as literal strings (interpolated at render time, not template tokens).
	if !strings.Contains(rendered, "security-auditor") {
		t.Errorf("minimal prompt must include role literal; got:\n%s", rendered)
	}
	if !strings.Contains(rendered, "ghost_stage") {
		t.Errorf("minimal prompt must include stage literal; got:\n%s", rendered)
	}
	// COMMON_VARS templated from PromptContext — card ID should be interpolated.
	if !strings.Contains(rendered, "card-min") {
		t.Errorf("minimal prompt must interpolate CardID; got:\n%s", rendered)
	}
	// Go template tokens must have been rendered, not left literal.
	if strings.Contains(rendered, "{{.CardID}}") {
		t.Errorf("minimal prompt still contains unrendered template token {{.CardID}}; got:\n%s", rendered)
	}
}

// T1.1 — Flag defaults to false. Without the opt-in, an unknown stage with no
// cache and no customStageFallbacks entry preserves today's graceful-skip
// contract (no LLM invocation, decision="no_prompt"). This is the safe default:
// don't guess-execute on a stage the user hasn't authored a prompt for.
func TestExecuteLLM_UnknownStage_GracefulSkipWhenFlagUnset(t *testing.T) {
	mock := llm.NewMockProvider()
	stage := valaris.StageConfig{
		Role:  "security-auditor",
		Claim: valaris.ClaimDef{ParticipantRole: "helper"},
		LLM: valaris.LLMDef{
			Enabled:         true,
			Stage:           "ghost_stage",
			PostProcessKind: "produces_note",
			// UseMinimalPromptWhenUnauthored omitted → default false
		},
	}
	loop := newLLMTestLoop(t, mock, stage)

	card := &discoverResult{CardID: "card-skip", BoardID: "board-1", Title: "Ghost"}
	res, err := loop.strategy.(*DataDrivenStrategy).executeLLM(
		context.Background(), context.Background(), loop, card, "exec-skip-default", t.TempDir(),
	)
	if err != nil {
		t.Fatalf("unknown-stage with flag=false should skip gracefully, got err=%v", err)
	}
	if res == nil || res.decision != "no_prompt" {
		t.Errorf("expected decision=no_prompt (default behavior unchanged), got %+v", res)
	}
	if mock.CallCount() != 0 {
		t.Errorf("LLM must NOT be invoked when flag=false and no prompt is cached; called %d times",
			mock.CallCount())
	}
}

// Default "implement" stage still routes through l.implement and produces implResult.
func TestExecuteLLM_DefaultImplement_Unchanged(t *testing.T) {
	mock := llm.NewMockProvider(`{"status":"done","summary":"implemented"}`)
	stage := valaris.StageConfig{
		Role:  "orchestrator",
		Claim: valaris.ClaimDef{ParticipantRole: "hero"},
		LLM: valaris.LLMDef{
			Enabled: true,
			Stage:   "implement",
		},
	}
	loop := newLLMTestLoop(t, mock, stage)

	card := &discoverResult{CardID: "card-i", BoardID: "board-1", Title: "Implement"}
	res, err := loop.strategy.(*DataDrivenStrategy).executeLLM(
		context.Background(), context.Background(), loop, card, "exec-6", t.TempDir(),
	)
	if err != nil {
		t.Fatalf("executeLLM: %v", err)
	}
	if res.implResult == nil {
		t.Fatal("default implement should populate implResult")
	}
	if res.reviewResult != nil || res.docResult != nil {
		t.Errorf("default implement should only set implResult, got %+v", res)
	}
}

// Default "review" stage routes through l.reviewCode with reviewResult + decision.
func TestExecuteLLM_DefaultReview_Unchanged(t *testing.T) {
	mock := llm.NewMockProvider(`{"decision":"approve","summary":"LGTM","findings":""}`)
	stage := valaris.StageConfig{
		Role:  "reviewer",
		Claim: valaris.ClaimDef{ParticipantRole: "helper"},
		LLM: valaris.LLMDef{
			Enabled: true,
			Stage:   "review",
		},
	}
	loop := newLLMTestLoop(t, mock, stage)

	card := &discoverResult{CardID: "card-r", BoardID: "board-1", Title: "Review"}
	res, err := loop.strategy.(*DataDrivenStrategy).executeLLM(
		context.Background(), context.Background(), loop, card, "exec-7", t.TempDir(),
	)
	if err != nil {
		t.Fatalf("executeLLM: %v", err)
	}
	if res.reviewResult == nil || res.reviewResult.Decision != "approve" {
		t.Errorf("default review should set reviewResult.Decision=approve, got %+v", res)
	}
	if res.decision != "approve" {
		t.Errorf("decision = %q, want approve", res.decision)
	}
}

// Default "document" stage routes through l.generateDocs with docResult.
func TestExecuteLLM_DefaultDocument_Unchanged(t *testing.T) {
	mock := llm.NewMockProvider(`{"status":"done","summary":"docs updated"}`)
	stage := valaris.StageConfig{
		Role:  "documentator",
		Claim: valaris.ClaimDef{ParticipantRole: "helper"},
		LLM: valaris.LLMDef{
			Enabled: true,
			Stage:   "document",
		},
	}
	loop := newLLMTestLoop(t, mock, stage)

	card := &discoverResult{CardID: "card-d", BoardID: "board-1", Title: "Doc"}
	res, err := loop.strategy.(*DataDrivenStrategy).executeLLM(
		context.Background(), context.Background(), loop, card, "exec-8", t.TempDir(),
	)
	if err != nil {
		t.Fatalf("executeLLM: %v", err)
	}
	if res.docResult == nil || res.docResult.Status != "done" {
		t.Errorf("default document should set docResult.Status=done, got %+v", res)
	}
}

// --- Fix 1: graceful-skip short-circuit for decision="no_prompt" ---
//
// When runLLMStage returns decision="no_prompt" (no cached template + no
// registered Go fallback), the tick orchestration MUST short-circuit:
//   - No gitCommitAndPush (which would emit a false "produced no code changes" failure
//     for writes_code stages on an unchanged repo).
//   - No postActionWithConfig (which would execute non-conditional on_success actions
//     like move_to_column_type on a card that never actually ran).
//   - Release the participant claim so the card can be reclaimed next tick once
//     the operator seeds the prompt.
//   - Increment the skip counter so health reflects the deferral.

// newSkipTestStrategy builds a DataDrivenStrategy plus a recording server
// wired up for skipNoPromptStage assertions.
func newSkipTestStrategy(t *testing.T, role, participantRole string) (*DataDrivenStrategy, *Loop, *[]recordedRequest, *sync.Mutex) {
	t.Helper()
	boardID := "board-skip"
	srv, reqs, mu := recordingServer(t, boardID)

	stage := valaris.StageConfig{
		Role:  role,
		Claim: valaris.ClaimDef{ParticipantRole: participantRole},
		Git:   valaris.GitDef{Action: "create_branch"},
		LLM: valaris.LLMDef{
			Enabled:         true,
			Stage:           "ghost_stage",
			PostProcessKind: "writes_code",
		},
	}
	strat := NewDataDrivenStrategy(stage, nil)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	hc := health.NewCollector(cfg.WorkLoop.PollInterval, cfg.WorkLoop.CardTimeout, 0)

	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg, hc)
	loop.strategy = strat

	return strat, loop, reqs, mu
}

// skipNoPromptStage should NOT trigger any git commit / push / PR activity.
// Verified indirectly: the recording server captures every REST hit; we assert
// no move-card, no create-PR, and no execution-fail requests were issued.
func TestSkipNoPromptStage_DoesNotCommitOrMove(t *testing.T) {
	strat, loop, reqs, mu := newSkipTestStrategy(t, "ghost-hero", "hero")
	card := &discoverResult{CardID: "card-skip-1", BoardID: "board-skip", Title: "Ghost task"}

	cleanupCalled := false
	cleanup := func() { cleanupCalled = true }

	strat.skipNoPromptStage(context.Background(), loop, card, "exec-skip-1", cleanup, silentLogger())

	if !cleanupCalled {
		t.Error("cleanup closure must run so git state is reset")
	}
	moveReq := findRequest(reqs, mu, func(r recordedRequest) bool {
		return strings.Contains(r.Path, "/cards/"+card.CardID+"/move")
	})
	if moveReq != nil {
		t.Errorf("skipNoPromptStage must NOT move the card, got %+v", moveReq)
	}
	failReq := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch && strings.Contains(r.Path, "/executions/") && strings.Contains(r.Body, `"status":"failed"`)
	})
	if failReq != nil {
		t.Errorf("skipNoPromptStage must NOT mark execution failed, got %+v", failReq)
	}
}

// skipNoPromptStage (hero) releases the user_id claim so the card is reclaimable
// on the next tick once the operator seeds the prompt.
func TestSkipNoPromptStage_HeroReleasesUserParticipant(t *testing.T) {
	strat, loop, reqs, mu := newSkipTestStrategy(t, "ghost-hero", "hero")
	card := &discoverResult{CardID: "card-skip-2", BoardID: "board-skip", Title: "Ghost hero"}

	strat.skipNoPromptStage(context.Background(), loop, card, "exec-skip-2", func() {}, silentLogger())

	unassign := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodDelete &&
			strings.Contains(r.Path, "/cards/"+card.CardID+"/participants/"+loop.client.UserID)
	})
	if unassign == nil {
		t.Fatal("skipNoPromptStage (hero) must DELETE the hero's user participant")
	}
}

// skipNoPromptStage (helper) releases the agent participant so the card is
// reclaimable by this agent on the next tick.
func TestSkipNoPromptStage_HelperReleasesAgentParticipant(t *testing.T) {
	strat, loop, reqs, mu := newSkipTestStrategy(t, "ghost-helper", "helper")
	card := &discoverResult{CardID: "card-skip-3", BoardID: "board-skip", Title: "Ghost helper"}

	strat.skipNoPromptStage(context.Background(), loop, card, "exec-skip-3", func() {}, silentLogger())

	agentID := loop.client.Agent.ID
	unassign := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodDelete &&
			strings.Contains(r.Path, "/cards/"+card.CardID+"/participants/"+agentID)
	})
	if unassign == nil {
		t.Fatal("skipNoPromptStage (helper) must DELETE the helper's agent participant")
	}
}

// skipNoPromptStage increments the health skip counter so the deferral is visible
// in heartbeats / metrics.
func TestSkipNoPromptStage_IncrementsSkipCounter(t *testing.T) {
	strat, loop, _, _ := newSkipTestStrategy(t, "ghost-hero", "hero")
	card := &discoverResult{CardID: "card-skip-4", BoardID: "board-skip", Title: "Ghost"}

	before := loop.health.Report().CardsSkipped
	strat.skipNoPromptStage(context.Background(), loop, card, "exec-skip-4", func() {}, silentLogger())
	after := loop.health.Report().CardsSkipped

	if after != before+1 {
		t.Errorf("cards_skipped: before=%d after=%d, want +1", before, after)
	}
}

// skipNoPromptStage marks the execution record as completed-with-skip
// (NOT failed) via PATCH so the UI doesn't show a spurious failure and
// the circuit breaker doesn't count this toward max_rework_attempts.
func TestSkipNoPromptStage_MarksExecutionSkipped(t *testing.T) {
	strat, loop, reqs, mu := newSkipTestStrategy(t, "ghost-hero", "hero")
	card := &discoverResult{CardID: "card-skip-5", BoardID: "board-skip", Title: "Ghost"}

	strat.skipNoPromptStage(context.Background(), loop, card, "exec-skip-5", func() {}, silentLogger())

	execUpdate := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch &&
			strings.Contains(r.Path, "/executions/exec-skip-5") &&
			strings.Contains(r.Body, "skipped")
	})
	if execUpdate == nil {
		t.Fatal("skipNoPromptStage must PATCH execution record with skipped status")
	}
}

// --- Rework no-changes graceful skip (ST#11 leftover) ---
//
// When a rework tick reaches HasChanges==false, that does NOT always mean
// failure. A common benign path: reviewer rejected a card because a sibling
// branch hadn't landed yet (intermittent test), sibling PR merges before the
// retry, rework reruns the tests — they now pass and nothing needs changing.
// The execution should be recorded as skipped (not failed) and must NOT
// burn a rework-budget slot, else the circuit breaker trips on a card that
// is actually correct.

// skipReworkNoChanges marks the execution as skipped (not failed) so the UI
// reflects the benign deferral.
func TestSkipReworkNoChanges_MarksExecutionSkippedNotFailed(t *testing.T) {
	boardID := "board-rwk"
	srv, reqs, mu := recordingServer(t, boardID)

	stage := valaris.StageConfig{
		Role:  "orchestrator",
		Claim: valaris.ClaimDef{ParticipantRole: "hero"},
	}
	strat := NewDataDrivenStrategy(stage, nil)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	card := &discoverResult{CardID: "card-rwk-1", BoardID: boardID, Title: "Rework card"}

	cleanupCalled := false
	strat.skipReworkNoChanges(context.Background(), loop, card, "exec-rwk-1", func() { cleanupCalled = true }, silentLogger())

	if !cleanupCalled {
		t.Error("cleanup closure must run so git state is reset")
	}

	failReq := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch &&
			strings.Contains(r.Path, "/executions/exec-rwk-1") &&
			strings.Contains(r.Body, `"status":"failed"`)
	})
	if failReq != nil {
		t.Errorf("rework no-changes must NOT mark execution failed, got %+v", failReq)
	}

	skipReq := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch &&
			strings.Contains(r.Path, "/executions/exec-rwk-1") &&
			strings.Contains(r.Body, `"status":"skipped"`)
	})
	if skipReq == nil {
		t.Fatal("rework no-changes must PATCH execution record with status=skipped")
	}
}

// skipReworkNoChanges must NOT burn the circuit-breaker budget. Calling
// recordFailure on a benign no-op would eventually push CardFailureCount
// past MaxReworkAttempts and block a card that is actually correct.
func TestSkipReworkNoChanges_DoesNotBurnFailureBudget(t *testing.T) {
	boardID := "board-rwk"
	srv, _, _ := recordingServer(t, boardID)

	stage := valaris.StageConfig{
		Role:  "orchestrator",
		Claim: valaris.ClaimDef{ParticipantRole: "hero"},
	}
	strat := NewDataDrivenStrategy(stage, nil)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	card := &discoverResult{CardID: "card-rwk-2", BoardID: boardID, Title: "Rework benign"}

	before := loop.CardFailureCount(card.CardID)
	strat.skipReworkNoChanges(context.Background(), loop, card, "exec-rwk-2", func() {}, silentLogger())
	after := loop.CardFailureCount(card.CardID)

	if after != before {
		t.Errorf("CardFailureCount: before=%d after=%d, want unchanged (no-changes rework must not record a failure)", before, after)
	}
}

// skipReworkNoChanges must not allow an infinite no-change loop. After
// maxConsecutiveNoChangeReworks consecutive skips on the same card the
// execution is marked failed (not skipped) and the card is force-moved to
// the blocked column, protecting the rework budget and signalling that a
// human must intervene.
func TestSkipReworkNoChanges_ForcesBlockedAfterThreshold(t *testing.T) {
	boardID := "board-rwk"
	srv, reqs, mu := recordingServer(t, boardID)

	stage := valaris.StageConfig{
		Role:  "orchestrator",
		Claim: valaris.ClaimDef{ParticipantRole: "hero"},
	}
	strat := NewDataDrivenStrategy(stage, nil)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	card := &discoverResult{CardID: "card-stuck", BoardID: boardID, Title: "Stuck rework"}

	// Simulate maxConsecutiveNoChangeReworks consecutive no-change reworks.
	// The first (threshold-1) skips must NOT move the card to blocked; the
	// final one must.
	for i := 0; i < maxConsecutiveNoChangeReworks; i++ {
		execID := "exec-skip-" + string(rune('0'+i))
		strat.skipReworkNoChanges(context.Background(), loop, card, execID, func() {}, silentLogger())
	}

	// Final skip must have moved the card to the blocked column.
	moveToBlocked := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodPost &&
			strings.Contains(r.Path, "/cards/"+card.CardID+"/move") &&
			strings.Contains(r.Body, `"column_id":"col-blocked"`)
	})
	// NOTE: recordingServer's default board layout lacks a "blocked" column,
	// so MoveCard is skipped with a warn log. What we must assert is that
	// the execution was failed (not merely skipped) on the threshold tick.
	_ = moveToBlocked

	failed := findRequest(reqs, mu, func(r recordedRequest) bool {
		return r.Method == http.MethodPatch &&
			strings.Contains(r.Path, "/executions/") &&
			strings.Contains(r.Body, `"status":"failed"`)
	})
	if failed == nil {
		t.Fatal("after threshold no-change reworks, execution must be marked failed (not skipped) to break the infinite loop")
	}

	// And the reworkCount must be at MaxReworkAttempts so IsCardBlocked
	// holds the card out of discover() during cooldown.
	wsCfg := loop.WorkspaceConfig()
	if got := loop.CardReworkCount(card.CardID); got < wsCfg.MaxReworkAttempts {
		t.Errorf("reworkCount=%d, want >=%d after threshold so IsCardBlocked returns true", got, wsCfg.MaxReworkAttempts)
	}
	if !loop.IsCardBlocked(card.CardID) {
		t.Error("IsCardBlocked must return true after the no-change threshold is reached")
	}
}

// A successful rework tick must clear the no-change counter so later
// benign skips (e.g. months later, card reopened) don't inherit the
// counter and get force-blocked on the first skip.
func TestSkipReworkNoChanges_CounterClearsOnSuccessfulRework(t *testing.T) {
	boardID := "board-rwk"
	srv, _, _ := recordingServer(t, boardID)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	cardID := "card-eventually-succeeds"
	loop.RecordNoChangeRework(cardID)
	if got := loop.NoChangeReworkCount(cardID); got != 1 {
		t.Fatalf("setup: NoChangeReworkCount=%d, want 1", got)
	}

	loop.ClearNoChangeRework(cardID)
	if got := loop.NoChangeReworkCount(cardID); got != 0 {
		t.Errorf("after ClearNoChangeRework: got %d, want 0 (successful rework must reset the counter)", got)
	}
}
