// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

func unsupportedFlowMode(t *testing.T, mode string, next http.HandlerFunc, provider llm.Provider) (*LoopMode, *atomic.Int32) {
	t.Helper()
	reads := &atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/context-dispatch-contract"):
			reads.Add(1)
			if mode == "local_required_old_server" {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(404)
				_, _ = w.Write([]byte(`{"detail":"Not Found"}`))
				return
			}
			contract := runnerDispatchContract()
			if mode != "required" {
				contract["mode"], contract["minimum_version"] = "legacy", 0
			}
			w.Header().Set(runnerDispatchHeader, "1")
			_ = json.NewEncoder(w).Encode(contract)
		case r.URL.Path == "/api/workspaces":
			_ = json.NewEncoder(w).Encode([]any{map[string]any{"id": runnerDispatchWorkspace, "slug": "workspace"}})
		default:
			next(w, r)
		}
	}))
	t.Cleanup(server.Close)
	client := valaris.NewClient(server.URL, "synthetic-key")
	client.Agent = &valaris.AgentConfig{ID: runnerDispatchAgent, AllowedWorkspaces: []string{runnerDispatchWorkspace}, IsActive: true}
	cfg := loopModeTestConfig(t)
	cfg.Valaris.WorkspaceSlug = "workspace"
	cfg.ContextDispatch.Require = strings.HasPrefix(mode, "local_required")
	cfg.ContextDispatch.AllowLegacyServer = mode == "local_required_old_server"
	m := NewLoopMode(client, cfg, map[string]llm.Provider{provider.Name(): provider}, provider, "workspace", runnerDispatchBoard, runnerDispatchAgent)
	return m, reads
}

func TestContextDispatchUnsupportedBoardLoopDirectEntry(t *testing.T) {
	for _, mode := range []string{"required", "local_required_legacy", "local_required_old_server", "legacy"} {
		t.Run(mode, func(t *testing.T) {
			cfg := baseLoopConfig()
			server := newLoopModeServer(t, loopConfigJSON(t, cfg))
			provider := llm.NewMockProvider("legacy iteration result")
			provider.NameOverride = "operator-board-loop-58"
			m, reads := unsupportedFlowMode(t, mode, server.handle, provider)
			failed, _, _ := m.runIteration(context.Background(), &cfg, 1, runnerDispatchExecution, provider, "exact-model-58", 1, 0)
			if mode == "legacy" {
				if failed || provider.CallCount() != 1 {
					t.Fatalf("explicit legacy direct iteration changed: failed=%t provider=%d", failed, provider.CallCount())
				}
				return
			}
			if !failed || reads.Load() == 0 || provider.CallCount() != 0 {
				t.Errorf("unsupported direct board-loop invoked inference: failed=%t contract=%d provider=%d", failed, reads.Load(), provider.CallCount())
			}
			server.mu.Lock()
			defer server.mu.Unlock()
			if len(server.executionUpdates) != 1 || !strings.Contains(strings.ToLower(stringValue(server.executionUpdates[0]["output_summary"])), "dispatch") {
				t.Errorf("missing one actionable dispatch failure: %v", server.executionUpdates)
			}
		})
	}
}

func TestContextDispatchUnsupportedBoardLoopFailedStartCannotInfer(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 1
	server := newLoopModeServer(t, loopConfigJSON(t, cfg))
	server.failExecutions = true
	provider := llm.NewMockProvider("must not infer after an unbound start")
	provider.NameOverride = "operator-board-loop-58"
	m, reads := unsupportedFlowMode(t, "required", server.handle, provider)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := m.Run(ctx)
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "dispatch") {
		t.Errorf("required board-loop needs an actionable unsupported dispatch outcome, got %v", err)
	}
	if reads.Load() == 0 || provider.CallCount() != 0 {
		t.Errorf("failed start fell through to inference without CompletionPolicy: contract=%d provider=%d", reads.Load(), provider.CallCount())
	}
}

func TestContextDispatchUnsupportedLeasedCompletionDirectEntry(t *testing.T) {
	repo, sourceSHA, _ := completionSourceRepo(t)
	for _, mode := range []string{"required", "local_required_legacy", "local_required_old_server", "legacy"} {
		t.Run(mode, func(t *testing.T) {
			provider := llm.NewMockProvider("independent legacy review")
			provider.NameOverride = "operator-quality-58"
			provider.Caps.StructuredOutput = true
			provider.QueueStructured([]byte(`{"outcome":"passed","summary":"Synthetic independent legacy verdict"}`))
			cfg := decodeCompletionLoopConfig(t, completionPolicyConfigJSON(t, baseLoopConfig(), completionPolicyV1, "Mandatory completion policy."))
			server := newCompletionWorkServer(t, completionPolicyConfigJSON(t, baseLoopConfig(), completionPolicyV1, "Mandatory completion policy."))
			server.claimBody = completionClaim(t, "review", provider.Name(), repo, sourceSHA, nil)
			var envelope struct {
				Work *valaris.CompletionWork `json:"work"`
			}
			if err := json.Unmarshal([]byte(server.claimBody), &envelope); err != nil {
				t.Fatal(err)
			}
			m, reads := unsupportedFlowMode(t, mode, server.handle, provider)
			receipt, _ := m.executeCompletionWork(context.Background(), &cfg, envelope.Work, 1)
			if receipt.LeaseToken != envelope.Work.LeaseToken || receipt.CandidateID != envelope.Work.CandidateID || receipt.SourceSHA != sourceSHA {
				t.Errorf("completion authorization identity changed: %+v", receipt)
			}
			if mode == "legacy" {
				if receipt.Outcome != "passed" || provider.CallCount() != 1 {
					t.Fatalf("legacy leased review control did not reach its provider: receipt=%+v calls=%d", receipt, provider.CallCount())
				}
				if provider.LastCall().Options.SourceExecutionID != "" {
					t.Error("completion review acquired source-execution authorization")
				}
				return
			}
			if receipt.Outcome != "failed" || !strings.Contains(strings.ToLower(receipt.Summary), "dispatch") || reads.Load() == 0 || provider.CallCount() != 0 {
				t.Errorf("unsupported leased completion executed: receipt=%+v contract=%d provider=%d", receipt, reads.Load(), provider.CallCount())
			}
		})
	}
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}
