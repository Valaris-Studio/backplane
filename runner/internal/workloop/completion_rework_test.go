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
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

func TestCompletionReworkDispatch(t *testing.T) {
	for _, scenario := range []string{"review", "evidence_review", "second_page", "claim_denied", "old_backend", "max_iterations", "budget_exhausted"} {
		t.Run(scenario, func(t *testing.T) {
			cfg := baseLoopConfig()
			cfg.Provider, cfg.Model = "configured-source", "source-model"
			cfg.CompletionQuery = &valaris.LoopCompletionQuery{Label: "complete", ExcludeColumnType: "done"}
			if scenario == "max_iterations" {
				cfg.MaxIterations = 0
			}
			if scenario == "budget_exhausted" {
				cfg.BudgetUSD = 0
			}
			disabled := cfg
			disabled.Enabled = false
			wire := completionPolicyConfigJSON(t, cfg, completionPolicyV1, "Mandatory policy")
			srv := newCompletionWorkServer(t, wire, wire, wire, completionPolicyConfigJSON(t, disabled, completionPolicyV1, "paused"))
			srv.base.readinessBodies = []string{readinessJSON(false, 0, 1, 0, 0)}
			source := llm.NewMockProvider("corrected finding")
			source.NameOverride = "configured-source"
			source.Caps = llm.Capabilities{StructuredOutput: true}
			source.QueueStructured([]byte(`{"outcome":"objective_complete","summary":"source claims done"}`))
			claims, pages, retries := 0, 0, 0
			consumed := false
			finding := "Review finding: missing boundary check {{.NotATemplateField}}"
			wrapper := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.HasSuffix(r.URL.Path, "/completion/work"):
					status := map[string]any{"pending_count": 0, "actionable_count": 0, "failed_count": 1, "rework_count": 1}
					kind := "review"
					if scenario == "evidence_review" {
						kind = scenario
					}
					workflow := map[string]any{"card_id": "card-failed", "candidate_id": "candidate-failed", "phase": "failed", "next_action": "rework_completion", "summary": finding, "attempt": map[string]any{"id": "attempt-failed", "kind": kind, "status": "failed"}}
					if consumed {
						status["rework_count"] = 0
						workflow["next_action"] = "resolve_rework"
					}
					if scenario == "old_backend" {
						delete(status, "rework_count")
						workflow["next_action"] = "retry_completion"
					}
					if scenario == "second_page" && !consumed && r.URL.Query().Get("cursor") == "" {
						status["next_cursor"] = "page-two"
					} else {
						status["workflows"] = []any{workflow}
					}
					if r.URL.Query().Get("cursor") == "page-two" {
						pages++
					}
					_ = json.NewEncoder(w).Encode(status)
				case strings.HasSuffix(r.URL.Path, "/completion/cards/card-failed/rework"):
					claims++
					var body map[string]any
					_ = json.NewDecoder(r.Body).Decode(&body)
					if srv.base.executionStartCount() != 1 || body["source_execution_id"] != "exec-1" || body["failed_attempt_id"] != "attempt-failed" || body["candidate_id"] != "candidate-failed" {
						t.Errorf("unbound rework claim: %#v", body)
					}
					consumed = scenario != "claim_denied"
					if scenario == "claim_denied" {
						_, _ = w.Write([]byte(`{"work":null}`))
						return
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"work": map[string]any{"candidate_id": "candidate-failed", "card_id": "card-failed", "failed_attempt_id": "attempt-failed", "execution_id": "exec-1", "context": finding}})
				case strings.Contains(r.URL.Path, "/retry"):
					retries++
					t.Error("runner retried failed evidence without implementation correction")
				default:
					srv.handle(w, r)
				}
			}))
			defer wrapper.Close()
			mode := newLoopModeForServer(t, srv.base, source)
			mode.client = valaris.NewClient(wrapper.URL, "fixture")
			mode.cfg.LLM.MaxBudgetUSD = 0.75
			mode.SetAfter(func(time.Duration) <-chan time.Time { c := make(chan time.Time, 1); c <- time.Now(); return c })
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if err := mode.Run(ctx); err != nil {
				t.Fatal(err)
			}
			wantCalls := 1
			if scenario == "old_backend" || scenario == "claim_denied" || scenario == "max_iterations" || scenario == "budget_exhausted" {
				wantCalls = 0
			}
			if source.CallCount() != wantCalls {
				t.Fatalf("source calls=%d want=%d; claims=%d", source.CallCount(), wantCalls, claims)
			}
			if wantCalls == 1 {
				call := source.Calls[0]
				if !strings.Contains(call.Options.SystemPrompt, finding) || !strings.Contains(call.Options.SystemPrompt, "source_execution_id: exec-1") {
					t.Errorf("mandatory rework context absent: %s", call.Options.SystemPrompt)
				}
				if call.Options.Model != "source-model" || call.Options.MaxBudgetUSD != 0.75 {
					t.Errorf("source dispatch/budget changed: %#v", call.Options)
				}
				if srv.base.patchCount() != 0 {
					t.Error("objective_complete bypassed failed candidate acceptance")
				}
				if srv.base.readinessCallCount() != 0 || len(srv.base.searchQueries) != 0 {
					t.Error("targeted rework reached ordinary readiness/completion query")
				}
			}
			if scenario == "second_page" && pages != 1 {
				t.Errorf("rework page reads=%d want 1", pages)
			}
			if scenario == "claim_denied" && (claims != 1 || srv.base.executionStartCount() != 1 || len(srv.base.executionUpdates) != 1) {
				t.Errorf("denied claim execution was not closed: claims=%d starts=%d updates=%d", claims, srv.base.executionStartCount(), len(srv.base.executionUpdates))
			}
			if retries != 0 {
				t.Error("unexpected blind retry")
			}
		})
	}
}

type reworkSourceProvider struct {
	*llm.MockProvider
	afterCorrection   func()
	deadlineRemaining time.Duration
}

func (p *reworkSourceProvider) Execute(ctx context.Context, prompt string, opts llm.Options) (*llm.Result, error) {
	if deadline, ok := ctx.Deadline(); ok {
		p.deadlineRemaining = time.Until(deadline)
	}
	result, err := p.MockProvider.Execute(ctx, prompt, opts)
	p.afterCorrection()
	return result, err
}

func TestCompletionReworkRequiresFreshIndependentReview(t *testing.T) {
	repo, sha, _ := completionSourceRepo(t)
	cfg := baseLoopConfig()
	cfg.Provider, cfg.Model = "source-agent", "source-model"
	cfg.IterationTimeoutSeconds = 1
	disabled := cfg
	disabled.Enabled = false
	wire := completionPolicyConfigJSON(t, cfg, completionPolicyV1, "Mandatory completion contract")
	srv := newCompletionWorkServer(t, wire, wire, wire, completionPolicyConfigJSON(t, disabled, completionPolicyV1, "paused"))
	srv.claimBody = completionClaim(t, "review", "independent-agent", repo, sha, nil)
	stage := "reviewing_original"
	source := &reworkSourceProvider{MockProvider: llm.NewMockProvider("submitted corrected candidate"), afterCorrection: func() { stage = "awaiting_review" }}
	source.NameOverride = "source-agent"
	reviewer := llm.NewMockProvider("original review failed", "reviewed corrected candidate")
	reviewer.NameOverride = "independent-agent"
	reviewer.Caps = llm.Capabilities{StructuredOutput: true}
	reviewer.QueueStructured([]byte(`{"outcome":"failed","summary":"missing boundary test"}`))
	reviewer.QueueStructured([]byte(`{"outcome":"passed","summary":"corrected boundary now has regression coverage"}`))
	wrapper := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/completion/work") {
			if stage == "failed" {
				_, _ = w.Write([]byte(`{"pending_count":0,"actionable_count":0,"failed_count":1,"rework_count":1,"workflows":[{"card_id":"card-1","candidate_id":"candidate-1","next_action":"rework_completion","summary":"missing boundary test","attempt":{"id":"attempt-1","kind":"review","status":"failed"}}]}`))
			} else {
				_, _ = w.Write([]byte(`{"pending_count":1,"actionable_count":1,"failed_count":0,"rework_count":0}`))
			}
			return
		}
		if strings.HasSuffix(r.URL.Path, "/completion/cards/card-1/rework") {
			_, _ = w.Write([]byte(`{"work":{"card_id":"card-1","candidate_id":"candidate-1","failed_attempt_id":"attempt-1","execution_id":"exec-1","context":"Correct the missing boundary test; submit a fresh candidate for independent review."}}`))
			return
		}
		if strings.HasSuffix(r.URL.Path, "/completion/work/attempt-1/result") && stage == "reviewing_original" {
			stage = "failed"
		}
		if strings.HasSuffix(r.URL.Path, "/completion/work/claim") && stage == "awaiting_review" {
			srv.claimBody = strings.ReplaceAll(srv.claimBody, "attempt-1", "attempt-2")
		}
		srv.handle(w, r)
	}))
	defer wrapper.Close()
	mode := newLoopModeForServer(t, srv.base, source)
	mode.client = valaris.NewClient(wrapper.URL, "fixture")
	mode.providers = map[string]llm.Provider{"source-agent": source, "independent-agent": reviewer}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := mode.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if source.CallCount() != 1 || reviewer.CallCount() != 2 {
		t.Fatalf("source=%d review=%d", source.CallCount(), reviewer.CallCount())
	}
	if source.deadlineRemaining <= 0 || source.deadlineRemaining > time.Second {
		t.Errorf("source rework lost iteration timeout: %s", source.deadlineRemaining)
	}
	if reviewer.Calls[1].Options.ResumeSessionID != "" || reviewer.Calls[1].Options.SourceExecutionID != "" {
		t.Error("independent review inherited source session/execution identity")
	}
	if reviewer.Calls[1].Options.Model != "operator-selected-inspection-model" {
		t.Error("independent configured review model changed")
	}
	if len(srv.results) != 2 || srv.results[0]["outcome"] != "failed" || srv.results[1]["outcome"] != "passed" {
		t.Fatalf("review sequence lost fresh acceptance: %#v", srv.results)
	}
	if srv.base.patchCount() != 0 {
		t.Error("review bypassed landing acceptance")
	}
}
