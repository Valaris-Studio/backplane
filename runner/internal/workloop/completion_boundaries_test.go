// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

func TestCompletionClaimRejectsModifiedTrackedSource(t *testing.T) {
	repo, sha, _ := completionSourceRepo(t)
	check := []map[string]any{{"id": "mutates-source", "argv": []string{"sh", "-c", "printf changed > version.txt"}, "timeout_seconds": 2}}
	srv := completionRunOnceServer(t, completionClaim(t, "validation", "mock", repo, sha, check))
	m := newLoopModeForServer(t, srv.base, llm.NewMockProvider("unused"))
	if err := m.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertCompletionAcknowledgment(t, srv, sha, "failed")
}

func TestCompletionReviewPreservesConfiguredToolRestrictions(t *testing.T) {
	repo, sha, _ := completionSourceRepo(t)
	var claim map[string]any
	if err := json.Unmarshal([]byte(completionClaim(t, "review", "mock", repo, sha, nil)), &claim); err != nil {
		t.Fatal(err)
	}
	work := claim["work"].(map[string]any)
	work["tool_policy"] = map[string]any{"deny": []string{"Bash(curl:*)", "WebFetch", "Edit"}}
	encoded, _ := json.Marshal(claim)
	srv := completionRunOnceServer(t, string(encoded))
	provider := llm.NewMockProvider("reviewed")
	provider.Caps = llm.Capabilities{StructuredOutput: true}
	provider.QueueStructured([]byte(`{"outcome":"passed","summary":"configured role reviewed exact source"}`))
	m := newLoopModeForServer(t, srv.base, provider)
	if err := m.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertCompletionAcknowledgment(t, srv, sha, "passed")
	if provider.CallCount() != 1 {
		t.Fatalf("expected one fresh review, got %d", provider.CallCount())
	}
	denied := provider.Calls[0].Options.DisallowedTools
	for _, required := range []string{"Bash(curl:*)", "WebFetch", "Edit", "Write", "NotebookEdit"} {
		found := false
		for _, actual := range denied {
			found = found || actual == required
		}
		if !found {
			t.Errorf("review dropped configured or immutable restriction %s: %v", required, denied)
		}
	}
}

func TestCompletionCheckTimeoutKillsDescendantsBeforeTheyMutateCheckout(t *testing.T) {
	repo, sha, _ := completionSourceRepo(t)
	marker := filepath.Join(t.TempDir(), "orphan")
	check := []map[string]any{{"id": "timeout", "argv": []string{"sh", "-c", "(sleep 2; printf orphan > \"$1\") & wait", "fixture", marker}, "timeout_seconds": 1}}
	srv := completionRunOnceServer(t, completionClaim(t, "validation", "mock", repo, sha, check))
	m := newLoopModeForServer(t, srv.base, llm.NewMockProvider("unused"))
	if err := m.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertCompletionAcknowledgment(t, srv, sha, "failed")
	time.Sleep(1500 * time.Millisecond)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("timed-out check left descendants alive")
	}
}

func TestCompletionCheckOutputBoundedAndControlSecretsRemoved(t *testing.T) {
	repo, sha, _ := completionSourceRepo(t)
	t.Setenv("VALARIS_API_KEY", "vlr_sensitive_fixture")
	check := []map[string]any{{"id": "output", "argv": []string{"sh", "-c", "printf '%s' \"$VALARIS_API_KEY\"; head -c 65536 /dev/zero | tr '\\0' x"}, "timeout_seconds": 2}}
	srv := completionRunOnceServer(t, completionClaim(t, "validation", "mock", repo, sha, check))
	m := newLoopModeForServer(t, srv.base, llm.NewMockProvider("unused"))
	if err := m.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	receipt := assertCompletionAcknowledgment(t, srv, sha, "passed")
	encoded, _ := json.Marshal(receipt["checks"])
	if strings.Contains(string(encoded), "vlr_sensitive_fixture") || len(encoded) > 18000 {
		t.Fatalf("unsafe bounded evidence length=%d", len(encoded))
	}
}

func TestCompletionResultRetriesExactPayloadOnTransientFailure(t *testing.T) {
	repo, sha, _ := completionSourceRepo(t)
	srv := completionRunOnceServer(t, completionClaim(t, "review", "mock", repo, sha, nil))
	var payloads []map[string]any
	wrapper := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/result") {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			payloads = append(payloads, body)
			if len(payloads) == 1 {
				w.WriteHeader(503)
				_, _ = w.Write([]byte(`{"detail":"retry"}`))
				return
			}
			_, _ = w.Write([]byte(`{"status":"accepted"}`))
			return
		}
		srv.handle(w, r)
	}))
	defer wrapper.Close()
	provider := llm.NewMockProvider("independent review")
	provider.Caps = llm.Capabilities{StructuredOutput: true}
	provider.QueueStructured([]byte(`{"outcome":"passed","summary":"accepted source inspected"}`))
	m := newLoopModeForServer(t, srv.base, provider)
	m.client = valaris.NewClient(wrapper.URL, "vlr_fixture")
	if err := m.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(payloads) != 2 || !reflect.DeepEqual(payloads[0], payloads[1]) || provider.CallCount() != 1 {
		t.Fatalf("result retry reran work or changed payload: calls=%d receipts=%d", provider.CallCount(), len(payloads))
	}
}

func TestCompletionIterationInjectsActualExecutionIDAndFailsClosedWithoutIt(t *testing.T) {
	for _, failedStart := range []bool{false, true} {
		t.Run(map[bool]string{false: "injected", true: "unavailable"}[failedStart], func(t *testing.T) {
			cfg := baseLoopConfig()
			disabled := cfg
			disabled.Enabled = false
			srv := newCompletionWorkServer(t, completionPolicyConfigJSON(t, cfg, completionPolicyV1, "Mandatory project directives."), completionPolicyConfigJSON(t, disabled, completionPolicyV1, "Paused."))
			srv.base.failExecutions = failedStart
			provider := llm.NewMockProvider("worked")
			m := newLoopModeForServer(t, srv.base, provider)
			err := m.Run(context.Background())
			if failedStart {
				if err == nil || provider.CallCount() != 0 || srv.base.patchCount() != 0 {
					t.Fatalf("unrecorded source execution ran or disabled board: calls=%d err=%v", provider.CallCount(), err)
				}
			} else {
				if err != nil || provider.CallCount() != 1 {
					t.Fatalf("Run: %v calls=%d", err, provider.CallCount())
				}
				if !strings.Contains(provider.Calls[0].Options.SystemPrompt, "source_execution_id: exec-1") {
					t.Fatal("mandatory context omitted actual execution ID")
				}
			}
		})
	}
}

func TestCompletionValidationCheckReceiptCarriesExactSourceSHA(t *testing.T) {
	repo, sha, _ := completionSourceRepo(t)
	srv := completionRunOnceServer(t, completionClaim(t, "validation", "mock", repo, sha, []map[string]any{{"id": "source", "argv": []string{"git", "rev-parse", "HEAD"}, "timeout_seconds": 2}}))
	m := newLoopModeForServer(t, srv.base, llm.NewMockProvider("unused"))
	if err := m.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	receipt := assertCompletionAcknowledgment(t, srv, sha, "passed")
	checks := receipt["checks"].([]any)
	check := checks[0].(map[string]any)
	if check["source_sha"] != sha {
		t.Fatal("check result missing exact source provenance")
	}
	if _, ok := check["duration_seconds"]; ok {
		t.Fatal("check result includes field rejected by backend strict schema")
	}
}

func TestCompletionRejectedResultDoesNotExposeLeaseInError(t *testing.T) {
	repo, sha, _ := completionSourceRepo(t)
	srv := completionRunOnceServer(t, completionClaim(t, "validation", "mock", repo, sha, []map[string]any{{"id": "source", "argv": []string{"git", "rev-parse", "HEAD"}, "timeout_seconds": 2}}))
	wrapper := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/result") {
			w.WriteHeader(422)
			_, _ = w.Write([]byte(`{"detail":"invalid input private-lease-do-not-inject"}`))
			return
		}
		srv.handle(w, r)
	}))
	defer wrapper.Close()
	m := newLoopModeForServer(t, srv.base, llm.NewMockProvider("unused"))
	m.client = valaris.NewClient(wrapper.URL, "vlr_fixture")
	err := m.Run(context.Background())
	if err == nil || strings.Contains(err.Error(), "private-lease-do-not-inject") {
		t.Fatalf("control-plane lease leaked through result error: %v", err)
	}
}

func TestCompletionReviewAcknowledgmentIncludesSuccessAndFailureMetrics(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "failure"}[failed], func(t *testing.T) {
			repo, sha, _ := completionSourceRepo(t)
			srv := completionRunOnceServer(t, completionClaim(t, "review", "mock", repo, sha, nil))
			srv.workBody = `{"pending_count":1,"actionable_count":1,"failed_count":0,"rework_count":0}`
			provider := llm.NewMockProvider("reviewed")
			provider.Caps = llm.Capabilities{StructuredOutput: true}
			provider.InputTokens = 100
			provider.OutputTokens = 50
			provider.QueueStructured([]byte(`{"outcome":"passed","summary":"exact source reviewed"}`))
			outcome := "passed"
			if failed {
				outcome = "failed"
				provider.FailWith = fmt.Errorf("provider interrupted")
				provider.FailWithInputTokens = 100
				provider.FailWithOutputTokens = 50
				provider.FailWithCostUSD = 2.5
			}
			m := newLoopModeForServer(t, srv.base, provider)
			if err := m.Run(context.Background()); err != nil {
				t.Fatal(err)
			}
			receipt := assertCompletionAcknowledgment(t, srv, sha, outcome)
			if failed && receipt["failure_class"] != "execution" {
				t.Errorf("provider execution failure was exposed as an implementation finding: %#v", receipt)
			}
			if !failed && receipt["failure_class"] != nil {
				t.Errorf("review verdict incorrectly classified as execution failure: %#v", receipt)
			}
			if receipt["tokens_used"] != float64(150) {
				t.Errorf("missing completion token metrics: %#v", receipt["tokens_used"])
			}
			duration, ok := receipt["duration_seconds"].(float64)
			if !ok || duration <= 0 {
				t.Error("completion duration not measured")
			}
			cost, ok := receipt["cost_usd"].(float64)
			if !ok || cost < 0 || (failed && cost != 2.5) {
				t.Errorf("completion cost not recorded: %#v", receipt["cost_usd"])
			}
		})
	}
}

type heartbeatReviewProvider struct {
	*llm.MockProvider
	arrived <-chan struct{}
}

func (p *heartbeatReviewProvider) Execute(ctx context.Context, prompt string, opts llm.Options) (*llm.Result, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-p.arrived:
		return p.MockProvider.Execute(ctx, prompt, opts)
	}
}

func TestCompletionClaimKeepsRunnerAliveWhileReviewRuns(t *testing.T) {
	repo, sha, _ := completionSourceRepo(t)
	srv := completionRunOnceServer(t, completionClaim(t, "review", "mock", repo, sha, nil))
	arrived := make(chan struct{})
	var once sync.Once
	wrapper := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/heartbeat") {
			var hb map[string]any
			_ = json.NewDecoder(r.Body).Decode(&hb)
			if hb["loop_state"] == "ticking" && hb["loop_board_id"] == "board-1" {
				once.Do(func() { close(arrived) })
			}
			_, _ = w.Write([]byte(`{"id":"agent-1"}`))
			return
		}
		srv.handle(w, r)
	}))
	defer wrapper.Close()
	mock := llm.NewMockProvider("reviewed")
	mock.Caps = llm.Capabilities{StructuredOutput: true}
	mock.QueueStructured([]byte(`{"outcome":"passed","summary":"review complete"}`))
	provider := &heartbeatReviewProvider{MockProvider: mock, arrived: arrived}
	m := newLoopModeForServer(t, srv.base, provider)
	m.client = valaris.NewClient(wrapper.URL, "vlr_fixture")
	m.client.Agent = &valaris.AgentConfig{ID: "agent-1"}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := m.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if mock.CallCount() != 1 {
		t.Fatal("review received no liveness heartbeat while in flight")
	}
	assertCompletionAcknowledgment(t, srv, sha, "passed")
}

func TestCompletionCheckRejectsBackgroundWorkWithUnfinishedOutput(t *testing.T) {
	repo, sha, _ := completionSourceRepo(t)
	marker := filepath.Join(t.TempDir(), "orphan")
	checks := []map[string]any{{"id": "background", "argv": []string{"sh", "-c", "(sleep 2; printf orphan > \"$1\") &", "fixture", marker}, "timeout_seconds": 5}}
	srv := completionRunOnceServer(t, completionClaim(t, "validation", "mock", repo, sha, checks))
	m := newLoopModeForServer(t, srv.base, llm.NewMockProvider("unused"))
	if err := m.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertCompletionAcknowledgment(t, srv, sha, "failed")
	time.Sleep(1500 * time.Millisecond)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("check completed while its background work remained alive")
	}
}

func TestCompletionPollingFallbackRemainsBoundedForLongConfiguredDelay(t *testing.T) {
	cfg := decodeCompletionLoopConfig(t, completionPolicyConfigJSON(t, baseLoopConfig(), completionPolicyV1, "Mandatory policy."))
	srv := newLoopModeServer(t)
	m := newLoopModeForServer(t, srv, llm.NewMockProvider("unused"))
	var delay time.Duration
	m.SetAfter(func(d time.Duration) <-chan time.Time { delay = d; return make(chan time.Time) })
	m.iterationWait(&cfg, time.Hour)
	if delay <= 0 || delay > 60*time.Second {
		t.Fatalf("lost completion events can strand the loop for %s", delay)
	}
}

func TestCompletionExecutionFailureSupportsStrictLegacyBackend(t *testing.T) {
	repo, sha, _ := completionSourceRepo(t)
	srv := completionRunOnceServer(t, completionClaim(t, "review", "mock", repo, sha, nil))
	acknowledged := false
	wrapper := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/result") {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if _, ok := body["failure_class"]; ok {
				w.WriteHeader(http.StatusUnprocessableEntity)
				_, _ = w.Write([]byte(`{"detail":"extra field failure_class"}`))
				return
			}
			acknowledged = body["outcome"] == "failed"
			_, _ = w.Write([]byte(`{"status":"accepted"}`))
			return
		}
		srv.handle(w, r)
	}))
	defer wrapper.Close()
	provider := llm.NewMockProvider("unavailable")
	provider.Caps = llm.Capabilities{StructuredOutput: true}
	provider.FailWith = fmt.Errorf("provider unavailable")
	mode := newLoopModeForServer(t, srv.base, provider)
	mode.client = valaris.NewClient(wrapper.URL, "fixture")
	if err := mode.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !acknowledged {
		t.Fatal("legacy backend never accepted failed execution bookkeeping")
	}
}
