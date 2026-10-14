// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
	"gopkg.in/yaml.v3"
)

const runnerDispatchHeader = "X-Backplane-Context-Dispatch-Version"
const runnerDispatchAgent = "00000000-0000-4000-8000-000000000147"
const runnerDispatchWorkspace = "00000000-0000-4000-8000-000000000148"
const runnerDispatchBoard = "00000000-0000-4000-8000-000000000149"
const runnerDispatchCard = "00000000-0000-4000-8000-000000000150"
const runnerDispatchHold = "00000000-0000-4000-8000-000000000151"
const runnerDispatchExecution = "00000000-0000-4000-8000-000000000152"
const runnerDispatchRole = "operator-research-47"

func runnerDispatchStamp() map[string]any {
	return map[string]any{"version": 1, "mode": "required", "policy_revision": strings.Repeat("a", 64)}
}
func runnerDispatchContract() map[string]any {
	return map[string]any{"protocol": "context-dispatch", "supported_versions": []int{1}, "minimum_version": 1, "mode": "required", "agent_id": runnerDispatchAgent, "workspace_id": runnerDispatchWorkspace, "policy_revision": strings.Repeat("a", 64), "supported_flows": []string{"scheduled_active_execution"}}
}
func runnerDispatchAssignment() map[string]any {
	return map[string]any{
		"card":   map[string]any{"id": runnerDispatchCard, "title": "Synthetic assignment"},
		"board":  map[string]any{"id": runnerDispatchBoard, "slug": "board"},
		"column": map[string]any{"id": "00000000-0000-4000-8000-000000000153", "column_type": "todo"},
		"role":   runnerDispatchRole, "stage_action": "continue_project",
		"reservation": map[string]any{"id": runnerDispatchHold, "expires_at": "2099-01-01T00:00:00Z"},
		"context":     map[string]string{"approved": "Exact é🧪 note\n"}, "context_revision": strings.Repeat("c", 64),
		"context_manifest": map[string]any{"schema_version": 1, "renderer_version": "context-v1", "sources": []any{}},
		"context_dispatch": runnerDispatchStamp(),
		"llm":              map[string]any{"provider": "operator-provider-47", "model": "operator-model-47", "tool_policy": map[string]any{"deny": []string{}}},
	}
}
func runnerDispatchStart() map[string]any {
	return map[string]any{"id": runnerDispatchExecution, "agent_id": runnerDispatchAgent, "status": "running",
		"context_binding": map[string]any{"reservation_id": runnerDispatchHold, "agent_id": runnerDispatchAgent,
			"workspace_id": runnerDispatchWorkspace, "board_id": runnerDispatchBoard, "card_id": runnerDispatchCard,
			"role": runnerDispatchRole, "created_at": "2026-10-13T00:00:00Z", "context_dispatch": runnerDispatchStamp()},
	}
}

type runnerDispatchHTTP struct {
	contractRequestHeader                                   string
	mu                                                      sync.Mutex
	contract, assignment, start                             map[string]any
	contractStatus, assignmentStatus                        int
	contractHeader, assignmentHeader, startHeader           string
	contractCalls, assignmentCalls, legacyCalls, startCalls int
	assignmentPayload, startPayload                         map[string]any
	assignmentRequestHeader, startRequestHeader             string
	contractAfterFirst                                      map[string]any
	waitAssignment                                          bool
}

func newRunnerDispatchHTTP() *runnerDispatchHTTP {
	return &runnerDispatchHTTP{contract: runnerDispatchContract(), assignment: runnerDispatchAssignment(), start: runnerDispatchStart(), contractStatus: 200, assignmentStatus: 200, contractHeader: "1", assignmentHeader: "1", startHeader: "1"}
}
func (f *runnerDispatchHTTP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch {
	case strings.HasSuffix(r.URL.Path, "/context-dispatch-contract"):
		f.contractCalls++
		f.contractRequestHeader = r.Header.Get(runnerDispatchHeader)
		if f.contractHeader != "" {
			w.Header().Set(runnerDispatchHeader, f.contractHeader)
		}
		w.WriteHeader(f.contractStatus)
		body := f.contract
		if f.contractCalls > 1 && f.contractAfterFirst != nil {
			body = f.contractAfterFirst
		}
		_ = json.NewEncoder(w).Encode(body)
	case strings.HasSuffix(r.URL.Path, "/next-assignment"):
		f.assignmentCalls++
		f.assignmentRequestHeader = r.Header.Get(runnerDispatchHeader)
		_ = json.NewDecoder(r.Body).Decode(&f.assignmentPayload)
		if f.waitAssignment {
			<-r.Context().Done()
			return
		}
		if f.assignmentHeader != "" {
			w.Header().Set(runnerDispatchHeader, f.assignmentHeader)
		}
		w.WriteHeader(f.assignmentStatus)
		if f.assignmentStatus != 204 {
			_ = json.NewEncoder(w).Encode(f.assignment)
		}
	case strings.HasSuffix(r.URL.Path, "/executions") && r.Method == http.MethodPost:
		f.startCalls++
		f.startRequestHeader = r.Header.Get(runnerDispatchHeader)
		_ = json.NewDecoder(r.Body).Decode(&f.startPayload)
		if f.startHeader != "" {
			w.Header().Set(runnerDispatchHeader, f.startHeader)
		}
		w.WriteHeader(201)
		_ = json.NewEncoder(w).Encode(f.start)
	case strings.HasSuffix(r.URL.Path, "/cards/search"):
		f.legacyCalls++
		_ = json.NewEncoder(w).Encode([]any{})
	case r.URL.Path == "/api/workspaces":
		_ = json.NewEncoder(w).Encode([]any{map[string]any{"id": runnerDispatchWorkspace, "slug": "workspace", "name": "Workspace"}})
	case strings.HasSuffix(r.URL.Path, "/claim") || strings.HasSuffix(r.URL.Path, "/participants"):
		_ = json.NewEncoder(w).Encode(map[string]any{})
	default:
		http.Error(w, "unexpected synthetic endpoint: "+r.URL.Path, http.StatusNotFound)
	}
}
func runnerDispatchLoop(t *testing.T, f *runnerDispatchHTTP, require, compat bool, participant string) (*Loop, *DataDrivenStrategy, *llm.MockProvider) {
	t.Helper()
	server := httptest.NewServer(f)
	t.Cleanup(server.Close)
	cfg := &config.Config{Valaris: config.ValarisConfig{WorkspaceSlug: "workspace", BoardIDs: []string{runnerDispatchBoard}}, LLM: config.LLMConfig{Provider: "operator-provider-47", Model: "operator-model-47"}}
	if err := yaml.Unmarshal([]byte(fmt.Sprintf("context_dispatch:\n  require: %t\n  allow_legacy_server: %t\n", require, compat)), cfg); err != nil {
		t.Fatal(err)
	}
	client := valaris.NewClient(server.URL, "synthetic-key")
	client.Agent = &valaris.AgentConfig{ID: runnerDispatchAgent, AllowedWorkspaces: []string{runnerDispatchWorkspace}, IsActive: true}
	provider := llm.NewMockProvider()
	provider.NameOverride = "operator-provider-47"
	stage := valaris.StageConfig{Role: runnerDispatchRole, Discover: valaris.DiscoverDef{Strategy: "column_scan", ColumnType: "todo"}, Claim: valaris.ClaimDef{ParticipantRole: participant, PipelineRole: runnerDispatchRole, ExecutionAction: "continue_project"}, LLM: valaris.LLMDef{Provider: "operator-provider-47", Model: "operator-model-47"}}
	strategy := NewDataDrivenStrategy(stage, nil)
	loop := &Loop{cfg: cfg, client: client, provider: provider, providers: map[string]llm.Provider{provider.Name(): provider}, strategy: strategy}
	return loop, strategy, provider
}

func TestContextDispatchDiscoveryNeverFallsBackAfterNegotiation(t *testing.T) {
	for _, name := range []string{"404", "403", "409", "500", "empty_success", "no_work_missing_header", "assignment_missing_header", "assignment_legacy_stamp", "assignment_policy_changed", "timeout"} {
		t.Run(name, func(t *testing.T) {
			f := newRunnerDispatchHTTP()
			switch name {
			case "404":
				f.assignmentStatus = 404
			case "403":
				f.assignmentStatus = 403
			case "409":
				f.assignmentStatus = 409
			case "500":
				f.assignmentStatus = 500
			case "empty_success":
				f.assignment = map[string]any{}
			case "no_work_missing_header":
				f.assignmentStatus = 204
				f.assignmentHeader = ""
			case "assignment_missing_header":
				f.assignmentHeader = ""
			case "assignment_legacy_stamp":
				f.assignment["context_dispatch"].(map[string]any)["mode"] = "legacy"
			case "assignment_policy_changed":
				f.assignment["context_dispatch"].(map[string]any)["policy_revision"] = strings.Repeat("b", 64)
			case "timeout":
				f.waitAssignment = true
			}
			loop, strategy, provider := runnerDispatchLoop(t, f, false, false, "hero")
			ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
			defer cancel()
			_, err := strategy.discoverWithConfig(ctx, loop)
			if err == nil {
				t.Error("required contract failure was accepted as work/no-work")
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.contractCalls == 0 {
				t.Error("production discovery did not negotiate server policy")
			}
			if f.legacyCalls != 0 || f.startCalls != 0 || provider.CallCount() != 0 {
				t.Errorf("required failure escaped into fallback: legacy=%d starts=%d provider=%d", f.legacyCalls, f.startCalls, provider.CallCount())
			}
		})
	}
}

func TestContextDispatchNegotiationValidationAndCompatibility(t *testing.T) {
	tests := []struct {
		name                           string
		require, compat, valid, legacy bool
		mutate                         func(*runnerDispatchHTTP)
	}{
		{name: "required_acknowledged_no_work", valid: true},
		{name: "old_backend_default_refuses", mutate: func(f *runnerDispatchHTTP) { f.contractStatus = 404; f.assignmentStatus = 404 }},
		{name: "old_backend_explicit_compat", compat: true, valid: true, legacy: true, mutate: func(f *runnerDispatchHTTP) { f.contractStatus = 404; f.assignmentStatus = 404 }},
		{name: "local_require_overrides_compat", require: true, compat: true, mutate: func(f *runnerDispatchHTTP) { f.contractStatus = 404; f.assignmentStatus = 404 }},
		{name: "explicit_negotiated_legacy", valid: true, mutate: func(f *runnerDispatchHTTP) { f.contract["mode"] = "legacy"; f.contract["minimum_version"] = 0 }},
		{name: "local_require_refuses_legacy", require: true, mutate: func(f *runnerDispatchHTTP) { f.contract["mode"] = "legacy"; f.contract["minimum_version"] = 0 }},
		{name: "missing_contract_header", mutate: func(f *runnerDispatchHTTP) { f.contractHeader = "" }},
		{name: "unknown_contract_version", mutate: func(f *runnerDispatchHTTP) { f.contract["supported_versions"] = []int{2} }},
		{name: "wrong_agent", mutate: func(f *runnerDispatchHTTP) { f.contract["agent_id"] = runnerDispatchCard }},
		{name: "malformed_workspace", mutate: func(f *runnerDispatchHTTP) { f.contract["workspace_id"] = "not-a-uuid" }},
		{name: "malformed_revision", mutate: func(f *runnerDispatchHTTP) { f.contract["policy_revision"] = "revision" }},
		{name: "unsupported_flow", mutate: func(f *runnerDispatchHTTP) { f.contract["supported_flows"] = []string{"other_flow"} }},
		{name: "contradictory_floor", mutate: func(f *runnerDispatchHTTP) { f.contract["minimum_version"] = 0 }},
		{name: "outage_is_not_old_server", compat: true, mutate: func(f *runnerDispatchHTTP) { f.contractStatus = 500 }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newRunnerDispatchHTTP()
			f.assignmentStatus = 204
			if tt.mutate != nil {
				tt.mutate(f)
			}
			loop, strategy, provider := runnerDispatchLoop(t, f, tt.require, tt.compat, "hero")
			_, err := strategy.discoverWithConfig(context.Background(), loop)
			if tt.valid && err != nil {
				t.Errorf("valid negotiated/explicit compatibility control: %v", err)
			}
			if !tt.valid && err == nil {
				t.Error("invalid negotiation accepted")
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.contractCalls == 0 {
				t.Error("contract endpoint was bypassed")
			}
			if f.contractCalls > 0 && f.contractRequestHeader != "1" {
				t.Error("contract request did not identify v1 support")
			}
			if tt.legacy {
				if f.legacyCalls != 1 {
					t.Errorf("explicit compatibility legacy searches=%d, want1", f.legacyCalls)
				}
			} else if f.legacyCalls != 0 {
				t.Errorf("unexpected legacy searches=%d", f.legacyCalls)
			}
			if !tt.valid && f.assignmentCalls != 0 {
				t.Errorf("invalid negotiation reached scheduler%d times", f.assignmentCalls)
			}
			if provider.CallCount() != 0 {
				t.Fatal("discovery called provider")
			}
		})
	}
}

func TestContextDispatchClaimRetainsAssignmentAndChecksBinding(t *testing.T) {
	for _, participant := range []string{"hero", "helper"} {
		for _, name := range []string{"complete", "missing_binding", "wrong_reservation", "wrong_agent", "wrong_workspace", "wrong_board", "wrong_card", "wrong_role", "missing_stamp", "downgraded_floor", "wrong_policy", "missing_ack", "policy_removed_before_start"} {
			t.Run(participant+"/"+name, func(t *testing.T) {
				f := newRunnerDispatchHTTP()
				binding := f.start["context_binding"].(map[string]any)
				switch name {
				case "missing_binding":
					delete(f.start, "context_binding")
				case "wrong_reservation":
					binding["reservation_id"] = runnerDispatchCard
				case "wrong_agent":
					binding["agent_id"] = runnerDispatchCard
				case "wrong_workspace":
					binding["workspace_id"] = runnerDispatchCard
				case "wrong_board":
					binding["board_id"] = runnerDispatchCard
				case "wrong_card":
					binding["card_id"] = runnerDispatchBoard
				case "wrong_role":
					binding["role"] = "other-role"
				case "missing_stamp":
					delete(binding, "context_dispatch")
				case "downgraded_floor":
					binding["context_dispatch"].(map[string]any)["mode"] = "legacy"
				case "wrong_policy":
					binding["context_dispatch"].(map[string]any)["policy_revision"] = strings.Repeat("b", 64)
				case "missing_ack":
					f.startHeader = ""
				case "policy_removed_before_start":
					f.contractAfterFirst = runnerDispatchContract()
					f.contractAfterFirst["mode"] = "legacy"
					f.contractAfterFirst["minimum_version"] = 0
					f.contractAfterFirst["policy_revision"] = strings.Repeat("b", 64)
				}
				loop, strategy, provider := runnerDispatchLoop(t, f, false, false, participant)
				card, err := strategy.discoverWithConfig(context.Background(), loop)
				if err != nil || card == nil || card.CardID != runnerDispatchCard {
					t.Fatalf("valid assignment control failed: %+v %v", card, err)
				}
				executionID, err := strategy.claimWithConfig(context.Background(), loop, card)
				if name == "complete" {
					if err != nil || executionID != runnerDispatchExecution {
						t.Errorf("valid bound start: %q %v", executionID, err)
					}
				} else if err == nil {
					t.Errorf("invalid binding/policy accepted: %q", executionID)
				}
				f.mu.Lock()
				defer f.mu.Unlock()
				if f.contractCalls < 2 {
					t.Errorf("assignment/start did not each negotiate current policy: %d", f.contractCalls)
				}
				if name == "policy_removed_before_start" {
					if f.startCalls != 0 {
						t.Error("changed policy started from stale hold")
					}
					return
				}
				if f.assignmentRequestHeader != "1" || f.assignmentPayload["context_dispatch_version"] != float64(1) || f.assignmentPayload["context_dispatch_policy_revision"] != strings.Repeat("a", 64) {
					t.Errorf("discovery omitted negotiated intent: header=%q body=%+v", f.assignmentRequestHeader, f.assignmentPayload)
				}
				if f.startCalls != 1 {
					t.Errorf("expected one actual start, got%d", f.startCalls)
				}
				if f.startRequestHeader != "1" || f.startPayload["context_dispatch_version"] != float64(1) || f.startPayload["context_dispatch_policy_revision"] != strings.Repeat("a", 64) || f.startPayload["reservation_id"] != runnerDispatchHold {
					t.Errorf("discovery-to-claim lost required hold/floor: header=%q body=%+v", f.startRequestHeader, f.startPayload)
				}
				if f.startPayload["role"] != runnerDispatchRole || f.startPayload["board_id"] != runnerDispatchBoard || f.startPayload["card_id"] != runnerDispatchCard {
					t.Error("operator-defined assignment identity changed")
				}
				if provider.CallCount() != 0 {
					t.Error("claim invoked provider")
				}
			})
		}
	}
}
