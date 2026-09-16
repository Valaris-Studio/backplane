// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type loopStateTestResponse struct {
	status int
	body   string
}

// newLoopStateSequenceServer returns scripted responses while recording each
// decoded PATCH body. It makes the structured-to-legacy fallback observable
// without coupling the tests to the client's request implementation.
func newLoopStateSequenceServer(t *testing.T, responses ...loopStateTestResponse) (*httptest.Server, func() []map[string]any) {
	t.Helper()

	var mu sync.Mutex
	var requests []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode loop-state request: %v", err)
		}

		mu.Lock()
		requestIndex := len(requests)
		requests = append(requests, body)
		response := responses[len(responses)-1]
		if requestIndex < len(responses) {
			response = responses[requestIndex]
		}
		mu.Unlock()

		w.WriteHeader(response.status)
		_, _ = w.Write([]byte(response.body))
	}))
	t.Cleanup(server.Close)

	return server, func() []map[string]any {
		mu.Lock()
		defer mu.Unlock()
		return append([]map[string]any(nil), requests...)
	}
}

// TestGetBoardLoop_NotFoundReturnsSentinel proves a 404 (board never
// configured for loop mode) translates to the ErrLoopNotConfigured sentinel,
// not a generic *APIError — callers key fatal-vs-retry behavior off this.
func TestGetBoardLoop_NotFoundReturnsSentinel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"detail":"not configured"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	cfg, err := client.GetBoardLoop(context.Background(), "acme", "board-1")
	if cfg != nil {
		t.Errorf("expected nil config on 404, got %+v", cfg)
	}
	if !errors.Is(err, ErrLoopNotConfigured) {
		t.Fatalf("expected ErrLoopNotConfigured, got: %v", err)
	}
}

// TestGetBoardLoop_SuccessDecodesAllFields proves the full wire shape
// round-trips into BoardLoopConfig, including the nullable disabled_reason.
func TestGetBoardLoop_SuccessDecodesAllFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/workspaces/acme/boards/board-1/loop" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if r.Header.Get("Authorization") != "Bearer vlr_test" {
			t.Error("missing or incorrect Authorization header")
		}
		_, _ = w.Write([]byte(`{
			"enabled": true,
			"provider": "claude-cli",
			"model": "mid",
			"system_prompt": "you are the loop agent",
			"loop_prompt": "iteration {{.Iteration}}",
			"tools": ["mcp__valaris__get_card"],
			"max_iterations": 25,
			"iteration_delay_seconds": 30,
			"iteration_timeout_seconds": 3600,
			"budget_usd": 20.0,
			"max_consecutive_failures": 3,
			"disabled_reason": null,
			"version": 4,
			"updated_at": "2026-07-31T00:00:00Z"
		}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	cfg, err := client.GetBoardLoop(context.Background(), "acme", "board-1")
	if err != nil {
		t.Fatalf("GetBoardLoop: %v", err)
	}
	if cfg == nil {
		t.Fatal("expected non-nil config")
	}
	if !cfg.Enabled {
		t.Error("Enabled = false, want true")
	}
	if cfg.Provider != "claude-cli" {
		t.Errorf("Provider = %q", cfg.Provider)
	}
	if cfg.Model != "mid" {
		t.Errorf("Model = %q", cfg.Model)
	}
	if cfg.SystemPrompt != "you are the loop agent" {
		t.Errorf("SystemPrompt = %q", cfg.SystemPrompt)
	}
	if cfg.LoopPrompt != "iteration {{.Iteration}}" {
		t.Errorf("LoopPrompt = %q", cfg.LoopPrompt)
	}
	if len(cfg.Tools) != 1 || cfg.Tools[0] != "mcp__valaris__get_card" {
		t.Errorf("Tools = %v", cfg.Tools)
	}
	if cfg.MaxIterations != 25 {
		t.Errorf("MaxIterations = %d", cfg.MaxIterations)
	}
	if cfg.IterationDelaySeconds != 30 {
		t.Errorf("IterationDelaySeconds = %d", cfg.IterationDelaySeconds)
	}
	if cfg.IterationTimeoutSeconds != 3600 {
		t.Errorf("IterationTimeoutSeconds = %d", cfg.IterationTimeoutSeconds)
	}
	if cfg.BudgetUSD != 20.0 {
		t.Errorf("BudgetUSD = %v", cfg.BudgetUSD)
	}
	if cfg.MaxConsecutiveFailures != 3 {
		t.Errorf("MaxConsecutiveFailures = %d", cfg.MaxConsecutiveFailures)
	}
	if cfg.DisabledReason != nil {
		t.Errorf("DisabledReason = %v, want nil", cfg.DisabledReason)
	}
	if cfg.Version != 4 {
		t.Errorf("Version = %d", cfg.Version)
	}
	if cfg.UpdatedAt != "2026-07-31T00:00:00Z" {
		t.Errorf("UpdatedAt = %q", cfg.UpdatedAt)
	}
}

// TestGetBoardLoop_IgnoresUnknownTemplateRef pins the contract the loop
// templates feature rests on: the backend adds keys to GET /loop additively
// (a `template` ref object, plus board-loop keys the runner never reads such
// as loop_landing/merge_gate), and the runner must decode straight past them.
// The runner stays ignorant of templates — no Template field on
// BoardLoopConfig — so this property, not a struct field, is what keeps
// every templated board working.
func TestGetBoardLoop_IgnoresUnknownTemplateRef(t *testing.T) {
	// Known fields deliberately carry non-zero values that differ from Go's
	// zero value, so a decoder that bailed on the unknown keys (returning the
	// zero config) could not masquerade as a pass.
	const payload = `{
		"enabled": true,
		"provider": "claude-cli",
		"model": "premium",
		"system_prompt": "you are the loop agent",
		"loop_prompt": "iteration {{.Iteration}}",
		"tools": ["mcp__valaris__get_card", "mcp__valaris__move_card"],
		"max_iterations": 25,
		"iteration_delay_seconds": 30,
		"iteration_timeout_seconds": 3600,
		"budget_usd": 20.0,
		"max_consecutive_failures": 3,
		"max_blocked_on_human": 2,
		"starvation_policy": "park",
		"disabled_reason": null,
		"version": 7,
		"updated_at": "2026-08-16T00:00:00Z",
		"template": {"source":"system","ref":"coding-loop","version":2,"drift":{"kind":"none"}},
		"loop_landing": "human",
		"merge_gate": "forge_ci"
	}`

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(payload))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	cfg, err := client.GetBoardLoop(context.Background(), "acme", "board-1")
	if err != nil {
		t.Fatalf("GetBoardLoop with unknown keys must succeed, got: %v", err)
	}
	if cfg == nil {
		t.Fatal("expected non-nil config")
	}

	// Every known field still lands: unknown keys are skipped, not treated as
	// a parse boundary that truncates the rest of the object.
	if !cfg.Enabled {
		t.Error("Enabled = false, want true")
	}
	if cfg.Provider != "claude-cli" {
		t.Errorf("Provider = %q, want claude-cli", cfg.Provider)
	}
	if cfg.Model != "premium" {
		t.Errorf("Model = %q, want premium", cfg.Model)
	}
	if cfg.SystemPrompt != "you are the loop agent" {
		t.Errorf("SystemPrompt = %q", cfg.SystemPrompt)
	}
	if cfg.LoopPrompt != "iteration {{.Iteration}}" {
		t.Errorf("LoopPrompt = %q", cfg.LoopPrompt)
	}
	if len(cfg.Tools) != 2 || cfg.Tools[0] != "mcp__valaris__get_card" || cfg.Tools[1] != "mcp__valaris__move_card" {
		t.Errorf("Tools = %v", cfg.Tools)
	}
	if cfg.MaxIterations != 25 {
		t.Errorf("MaxIterations = %d, want 25", cfg.MaxIterations)
	}
	if cfg.IterationDelaySeconds != 30 {
		t.Errorf("IterationDelaySeconds = %d, want 30", cfg.IterationDelaySeconds)
	}
	if cfg.IterationTimeoutSeconds != 3600 {
		t.Errorf("IterationTimeoutSeconds = %d, want 3600", cfg.IterationTimeoutSeconds)
	}
	if cfg.BudgetUSD != 20.0 {
		t.Errorf("BudgetUSD = %v, want 20", cfg.BudgetUSD)
	}
	if cfg.MaxConsecutiveFailures != 3 {
		t.Errorf("MaxConsecutiveFailures = %d, want 3", cfg.MaxConsecutiveFailures)
	}
	if cfg.MaxBlockedOnHuman != 2 {
		t.Errorf("MaxBlockedOnHuman = %d, want 2", cfg.MaxBlockedOnHuman)
	}
	if cfg.StarvationPolicy != "park" {
		t.Errorf("StarvationPolicy = %q, want park", cfg.StarvationPolicy)
	}
	if cfg.DisabledReason != nil {
		t.Errorf("DisabledReason = %v, want nil", cfg.DisabledReason)
	}
	// Version is the field the backend bumps on every re-render; a decoder that
	// stopped at the `template` key would leave it at 0.
	if cfg.Version != 7 {
		t.Errorf("Version = %d, want 7", cfg.Version)
	}
	if cfg.UpdatedAt != "2026-08-16T00:00:00Z" {
		t.Errorf("UpdatedAt = %q, want 2026-08-16T00:00:00Z", cfg.UpdatedAt)
	}

	// The failure mode this test exists to prevent: were the client's decode
	// path ever tightened to DisallowUnknownFields, the very same payload
	// would error out. Asserting the strict decoder DOES reject proves the
	// assertions above are load-bearing rather than vacuously true of any
	// decoder.
	strict := json.NewDecoder(strings.NewReader(payload))
	strict.DisallowUnknownFields()
	var rejected BoardLoopConfig
	if err := strict.Decode(&rejected); err == nil {
		t.Fatal("strict decode of the templated payload succeeded; the unknown-key " +
			"fixture no longer contains any key absent from BoardLoopConfig, so the " +
			"lenient assertions above prove nothing — add a genuinely unknown key")
	} else if !strings.Contains(err.Error(), "template") {
		t.Errorf("strict decode should have tripped on the unknown \"template\" key, got: %v", err)
	}
}

// TestGetBoardLoop_ServerErrorWraps proves a non-404 failure still surfaces
// as a typed *APIError (not silently swallowed into the 404 sentinel).
func TestGetBoardLoop_ServerErrorWraps(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"detail":"boom"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	cfg, err := client.GetBoardLoop(context.Background(), "acme", "board-1")
	if cfg != nil {
		t.Errorf("expected nil config on error, got %+v", cfg)
	}
	if err == nil {
		t.Fatal("expected an error")
	}
	if errors.Is(err, ErrLoopNotConfigured) {
		t.Error("a 500 must not be reported as ErrLoopNotConfigured")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected *APIError in chain, got: %v", err)
	}
	if apiErr.StatusCode != http.StatusInternalServerError {
		t.Errorf("StatusCode = %d, want 500", apiErr.StatusCode)
	}
}

// TestSetBoardLoopState_SendsExpectedRequest proves the PATCH hits the
// /loop/state sub-path with the exact {"enabled","reason"} body shape the
// spec requires.
func TestSetBoardLoopState_SendsExpectedRequest(t *testing.T) {
	srv, cap := newCaptureServer(t, 0)

	client := NewClient(srv.URL, "vlr_test")
	err := client.SetBoardLoopState(context.Background(), "acme", "board-1", false, "objective complete")
	if err != nil {
		t.Fatalf("SetBoardLoopState: %v", err)
	}

	if cap.method != http.MethodPatch {
		t.Errorf("method = %q, want PATCH", cap.method)
	}
	if cap.path != "/api/workspaces/acme/boards/board-1/loop/state" {
		t.Errorf("path = %q", cap.path)
	}
	if cap.auth != "Bearer vlr_test" {
		t.Error("missing or incorrect Authorization header")
	}
	if enabled, ok := cap.body["enabled"].(bool); !ok || enabled != false {
		t.Errorf("enabled = %v, want false", cap.body["enabled"])
	}
	if cap.body["reason"] != "objective complete" {
		t.Errorf("reason = %v, want %q", cap.body["reason"], "objective complete")
	}
	if len(cap.body) != 2 {
		t.Errorf("legacy request body = %v, want exactly enabled and reason", cap.body)
	}
}

// TestSetBoardLoopStateWithStructuredReason_SendsAdditiveFields proves a
// modern server receives the legacy reason unchanged alongside stable code,
// technical params, and an optional raw diagnostic.
func TestSetBoardLoopStateWithStructuredReason_SendsAdditiveFields(t *testing.T) {
	srv, cap := newCaptureServer(t, 0)
	client := NewClient(srv.URL, "vlr_test")

	err := client.SetBoardLoopStateWithStructuredReason(
		context.Background(),
		"acme",
		"board-1",
		"budget_usd exhausted ($1.25 of $1.00)",
		BoardLoopStructuredReason{
			Code: BoardLoopReasonBudgetExhausted,
			Params: map[string]any{
				"spent_usd":  1.25,
				"budget_usd": 1.0,
			},
			Diagnostic: "provider cutoff: exit status 137",
		},
	)
	if err != nil {
		t.Fatalf("SetBoardLoopStateWithStructuredReason: %v", err)
	}

	if cap.body["reason"] != "budget_usd exhausted ($1.25 of $1.00)" {
		t.Errorf("reason = %v, want legacy reason unchanged", cap.body["reason"])
	}
	if enabled, ok := cap.body["enabled"].(bool); !ok || enabled {
		t.Errorf("enabled = %v, want the structured API to always disable", cap.body["enabled"])
	}
	if cap.body["reason_code"] != "budget_exhausted" {
		t.Errorf("reason_code = %v, want budget_exhausted", cap.body["reason_code"])
	}
	params, ok := cap.body["reason_params"].(map[string]any)
	if !ok {
		t.Fatalf("reason_params = %T, want object", cap.body["reason_params"])
	}
	if params["spent_usd"] != 1.25 || params["budget_usd"] != 1.0 {
		t.Errorf("reason_params = %v", params)
	}
	if cap.body["diagnostic"] != "provider cutoff: exit status 137" {
		t.Errorf("diagnostic = %v, want raw diagnostic unchanged", cap.body["diagnostic"])
	}
}

// TestSetBoardLoopStateWithStructuredReason_422FallsBackToExactLegacyBody
// proves compatibility with servers whose extra=forbid schema predates the
// additive fields. Only the validation 422 triggers one legacy retry.
func TestSetBoardLoopStateWithStructuredReason_422FallsBackToExactLegacyBody(t *testing.T) {
	server, recordedRequests := newLoopStateSequenceServer(t,
		loopStateTestResponse{status: http.StatusUnprocessableEntity, body: `{"detail":"extra_forbidden"}`},
		loopStateTestResponse{status: http.StatusOK, body: `{}`},
	)
	client := NewClient(server.URL, "vlr_test")

	err := client.SetBoardLoopStateWithStructuredReason(
		context.Background(), "acme", "board-1",
		"max_iterations reached (25)",
		BoardLoopStructuredReason{
			Code:   BoardLoopReasonMaxIterationsReached,
			Params: map[string]any{"max_iterations": 25},
		},
	)
	if err != nil {
		t.Fatalf("structured request with legacy fallback: %v", err)
	}

	requests := recordedRequests()
	if len(requests) != 2 {
		t.Fatalf("request count = %d, want 2", len(requests))
	}
	if requests[0]["reason_code"] != "max_iterations_reached" {
		t.Errorf("first request = %v, want structured reason", requests[0])
	}
	if enabled, ok := requests[0]["enabled"].(bool); !ok || enabled {
		t.Errorf("first request enabled = %v, want false", requests[0]["enabled"])
	}
	legacy := requests[1]
	if len(legacy) != 2 || legacy["enabled"] != false || legacy["reason"] != "max_iterations reached (25)" {
		t.Errorf("fallback body = %v, want exact legacy enabled/reason body", legacy)
	}
}

// TestSetBoardLoopStateWithStructuredReason_Non422DoesNotRetry prevents a
// second state mutation attempt for server failures that are not validation
// rejection of the additive wire shape.
func TestSetBoardLoopStateWithStructuredReason_Non422DoesNotRetry(t *testing.T) {
	server, recordedRequests := newLoopStateSequenceServer(t,
		loopStateTestResponse{status: http.StatusInternalServerError, body: `{"detail":"boom"}`},
	)
	client := NewClient(server.URL, "vlr_test")

	err := client.SetBoardLoopStateWithStructuredReason(
		context.Background(), "acme", "board-1",
		"2 consecutive failed iterations",
		BoardLoopStructuredReason{
			Code:   BoardLoopReasonConsecutiveFailures,
			Params: map[string]any{"count": 2},
		},
	)
	if err == nil {
		t.Fatal("expected the 500 response to propagate")
	}
	if len(recordedRequests()) != 1 {
		t.Fatalf("request count = %d, want no retry after non-422", len(recordedRequests()))
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != http.StatusInternalServerError {
		t.Fatalf("error = %v, want APIError 500", err)
	}
}

// TestSetBoardLoopStateWithStructuredReason_FallbackFailureKeepsBothErrors
// proves operators can diagnose both the schema rejection and a failed
// legacy retry instead of losing either response.
func TestSetBoardLoopStateWithStructuredReason_FallbackFailureKeepsBothErrors(t *testing.T) {
	server, recordedRequests := newLoopStateSequenceServer(t,
		loopStateTestResponse{status: http.StatusUnprocessableEntity, body: `{"detail":"extra_forbidden"}`},
		loopStateTestResponse{status: http.StatusInternalServerError, body: `{"detail":"fallback boom"}`},
	)
	client := NewClient(server.URL, "vlr_test")

	err := client.SetBoardLoopStateWithStructuredReason(
		context.Background(), "acme", "board-1",
		"max_iterations reached (25)",
		BoardLoopStructuredReason{
			Code:   BoardLoopReasonMaxIterationsReached,
			Params: map[string]any{"max_iterations": 25},
		},
	)
	if err == nil {
		t.Fatal("expected fallback failure")
	}
	if len(recordedRequests()) != 2 {
		t.Fatalf("request count = %d, want structured request plus one fallback", len(recordedRequests()))
	}
	if !strings.Contains(err.Error(), "extra_forbidden") || !strings.Contains(err.Error(), "fallback boom") {
		t.Fatalf("error = %q, want both response diagnostics", err)
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("error chain = %v, want original APIError 422 retained", err)
	}
}

// TestSetBoardLoopState_ServerErrorPropagates proves a failed PATCH surfaces
// its error rather than being swallowed — the caller (LoopMode.disable) is
// the one responsible for deciding whether to swallow it, not the client.
func TestSetBoardLoopState_ServerErrorPropagates(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write([]byte(`{"detail":"loop_prompt required to enable"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	err := client.SetBoardLoopState(context.Background(), "acme", "board-1", true, "")
	if err == nil {
		t.Fatal("expected an error from a 422 response")
	}
}
