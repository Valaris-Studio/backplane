// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// helperParticipantServer captures the POST body of the first
// /participants request so claim-handler tests can assert on the wire payload
// the runner actually sends to AddCardParticipant.
func helperParticipantServer(t *testing.T) (*httptest.Server, func() map[string]any) {
	t.Helper()
	var mu sync.Mutex
	var captured map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		if strings.Contains(r.URL.Path, "/participants") && r.Method == http.MethodPost {
			body, _ := io.ReadAll(r.Body)
			mu.Lock()
			if captured == nil {
				_ = json.Unmarshal(body, &captured)
			}
			mu.Unlock()
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{}"))
			return
		}
		if strings.Contains(r.URL.Path, "/executions") && r.Method == http.MethodPost {
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "exec-pl-1"})
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)

	return srv, func() map[string]any {
		mu.Lock()
		defer mu.Unlock()
		return captured
	}
}

// lifecycleClaim must propagate the step-level `pipeline_role` param all the
// way to the AddCardParticipant POST body so the backend can attribute the
// claim to the correct pipeline stage.
func TestLifecycleClaim_PropagatesPipelineRoleToAddParticipant(t *testing.T) {
	srv, getBody := helperParticipantServer(t)

	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{
		Role:  "reviewer",
		Claim: valaris.ClaimDef{ParticipantRole: "helper", ExecutionAction: "review_card"},
	}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c1", BoardID: "b1", Title: "t"})
	step := &valaris.LifecycleStep{
		Name: "claim_for_review",
		Kind: "claim",
		Params: map[string]any{
			"pipeline_role": "reviewer",
		},
	}

	if _, _, err := lifecycleClaim(context.Background(), ws, step); err != nil {
		t.Fatalf("lifecycleClaim: %v", err)
	}

	body := getBody()
	if body == nil {
		t.Fatal("expected POST /participants to be captured")
	}
	if got := body["pipeline_role"]; got != "reviewer" {
		t.Errorf("pipeline_role = %v, want %q", got, "reviewer")
	}
}

// lifecycleClaim with no pipeline_role param (legacy stage config) must still
// succeed, omit the field from the wire payload, and produce a WARN log.
// Stage-level Claim.PipelineRole is also empty — i.e. nothing has filled it.
func TestLifecycleClaim_MissingPipelineRoleWarnsAndOmits(t *testing.T) {
	srv, getBody := helperParticipantServer(t)

	loop := newLoopForKindTest(t, srv.URL)
	// Use a unique role name so the dedup map (package-level sync.Map) doesn't
	// suppress the WARN we want to indirectly assert by reaching the no-pipeline
	// codepath. We can't intercept slog cleanly here, so we assert the wire
	// effect: pipeline_role must NOT appear in the body.
	strat := NewDataDrivenStrategy(valaris.StageConfig{
		Role:  "legacy_unique_role_for_warn_test",
		Claim: valaris.ClaimDef{ParticipantRole: "helper", ExecutionAction: "review_card"},
	}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c2", BoardID: "b2", Title: "t"})
	step := &valaris.LifecycleStep{
		Name: "claim_legacy",
		Kind: "claim",
	}

	if _, _, err := lifecycleClaim(context.Background(), ws, step); err != nil {
		t.Fatalf("lifecycleClaim: %v", err)
	}

	body := getBody()
	if body == nil {
		t.Fatal("expected POST /participants to be captured")
	}
	if _, present := body["pipeline_role"]; present {
		t.Errorf("pipeline_role should be omitted when absent, got %v", body["pipeline_role"])
	}
}

// Stage-level Claim.PipelineRole survives when no step.Params override exists.
// Mirrors the override semantics used for participant_role/execution_action.
func TestLifecycleClaim_StageLevelPipelineRoleSurvives(t *testing.T) {
	srv, getBody := helperParticipantServer(t)

	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{
		Role: "documentator",
		Claim: valaris.ClaimDef{
			ParticipantRole: "helper",
			ExecutionAction: "document_card",
			PipelineRole:    "documentator",
		},
	}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c3", BoardID: "b3", Title: "t"})
	step := &valaris.LifecycleStep{Name: "claim_docs", Kind: "claim"}

	if _, _, err := lifecycleClaim(context.Background(), ws, step); err != nil {
		t.Fatalf("lifecycleClaim: %v", err)
	}

	body := getBody()
	if body == nil {
		t.Fatal("expected POST /participants to be captured")
	}
	if got := body["pipeline_role"]; got != "documentator" {
		t.Errorf("pipeline_role = %v, want %q (stage-level fallback)", got, "documentator")
	}

	// Defer restored stage-level value (overrides shouldn't leak).
	if strat.config.Claim.PipelineRole != "documentator" {
		t.Errorf("stage Claim.PipelineRole = %q, want restored to %q", strat.config.Claim.PipelineRole, "documentator")
	}
}

// Step-level pipeline_role overrides the stage-level value for that one step,
// then restores after the call — same pattern as participant_role overrides.
func TestLifecycleClaim_StepOverridesStagePipelineRole(t *testing.T) {
	srv, getBody := helperParticipantServer(t)

	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{
		Role: "orchestrator",
		Claim: valaris.ClaimDef{
			ParticipantRole: "helper",
			ExecutionAction: "implement_card",
			PipelineRole:    "implementer",
		},
	}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c4", BoardID: "b4", Title: "t"})
	step := &valaris.LifecycleStep{
		Name:   "claim_review",
		Kind:   "claim",
		Params: map[string]any{"pipeline_role": "reviewer"},
	}

	if _, _, err := lifecycleClaim(context.Background(), ws, step); err != nil {
		t.Fatalf("lifecycleClaim: %v", err)
	}

	if got := getBody()["pipeline_role"]; got != "reviewer" {
		t.Errorf("pipeline_role = %v, want step-level override %q", got, "reviewer")
	}
	if strat.config.Claim.PipelineRole != "implementer" {
		t.Errorf("stage Claim.PipelineRole leaked: got %q, want %q", strat.config.Claim.PipelineRole, "implementer")
	}
}

// Existing test (TestKindClaim_PopulatesExecutionID) covers the hero path; this
// test ensures we don't accidentally regress it when the helper path got the
// pipeline_role plumbing. Hero uses ClaimCard (not AddCardParticipant), so the
// /participants endpoint must NOT fire.
func TestLifecycleClaim_HeroPathSkipsAddParticipant(t *testing.T) {
	var participantCalls int
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		if strings.Contains(r.URL.Path, "/participants") && r.Method == http.MethodPost {
			mu.Lock()
			participantCalls++
			mu.Unlock()
		}
		if strings.Contains(r.URL.Path, "/executions") && r.Method == http.MethodPost {
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "exec-hero"})
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)

	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{
		Role:  "implementer",
		Claim: valaris.ClaimDef{ParticipantRole: "hero", ExecutionAction: "implement_card"},
	}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c5", BoardID: "b5", Title: "t"})
	step := &valaris.LifecycleStep{Name: "claim", Kind: "claim", Params: map[string]any{"pipeline_role": "implementer"}}

	if _, _, err := lifecycleClaim(context.Background(), ws, step); err != nil {
		t.Fatalf("lifecycleClaim: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if participantCalls != 0 {
		t.Errorf("hero claim should not POST /participants, got %d call(s)", participantCalls)
	}
}

