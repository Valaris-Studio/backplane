// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// Wave 2 / CRIT-2: model resolution prefers the backend assignment payload
// over the runner's yaml. These tests pin the behavior so a future yaml
// change can't silently shadow a backend-declared per-stage model.

func newModelTestLoop(t *testing.T, yamlModel string) *Loop {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		w.Write([]byte("{}"))
	}))
	t.Cleanup(server.Close)

	cfg := &config.Config{
		Valaris: config.ValarisConfig{WorkspaceSlug: "ws"},
		LLM: config.LLMConfig{
			Model: yamlModel,
			ModelOverrides: map[string]string{
				"implement": yamlModel + "-phase-override",
			},
		},
	}
	client := valaris.NewClient(server.URL, "vlr_test")
	client.UserID = "user-1"
	client.Agent = &valaris.AgentConfig{ID: "agent-1", Name: "t", AgentType: "coding", IsActive: true}
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop, err := New(context.Background(), client, llm.NewMockProvider(), gitMgr, cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	loop.strategy = NewDataDrivenStrategy(valaris.StageConfig{Role: "orchestrator"}, nil)
	return loop
}

func TestModel_PrefersAssignmentOverYaml(t *testing.T) {
	loop := newModelTestLoop(t, "yaml-default")
	loop.SetAssignmentLLM(valaris.AssignmentLLM{
		Provider:   "claude-cli",
		Model:      "backend-opus",
		PromptSlug: "implement",
	})

	opts := loop.llmOpts("implement")
	if opts.Model != "backend-opus" {
		t.Fatalf("llmOpts must prefer assignment model; got %q want %q", opts.Model, "backend-opus")
	}
}

func TestModel_FallsBackToYamlWithWarn_WhenAssignmentEmpty(t *testing.T) {
	loop := newModelTestLoop(t, "yaml-default")
	// No SetAssignmentLLM call — assignment block is empty (pre-rollout backend
	// or non-assignment code path like the heartbeat goroutine).
	opts := loop.llmOpts("implement")
	// Phase override beats raw default; ensures the legacy per-phase yaml path
	// still works as a fallback during the one-deploy migration window.
	if opts.Model != "yaml-default-phase-override" {
		t.Fatalf("llmOpts must fall back to yaml phase override; got %q", opts.Model)
	}
}

func TestModel_FallsBackToYamlBareDefault_WhenNoPhase(t *testing.T) {
	loop := newModelTestLoop(t, "yaml-default")
	opts := loop.llmOpts() // no phase, no assignment — bare default
	if opts.Model != "yaml-default" {
		t.Fatalf("llmOpts must fall back to yaml bare default; got %q", opts.Model)
	}
}

// Tool deny-list resolution mirrors model dispatch: the backend-authoritative
// llm.tool_policy.deny flows into llmOpts().DisallowedTools; an empty/missing
// backend list falls back to the SafeToolDenyFloor security floor so an old or
// misconfigured backend still can't bypass the review gate.

func TestToolDeny_PrefersAssignmentOverFloor(t *testing.T) {
	loop := newModelTestLoop(t, "yaml-default")
	backendDeny := []string{"Bash(rm -rf:*)", "Bash(gh pr merge:*)"}
	assignment := valaris.AssignmentLLM{Provider: "claude-cli", Model: "opus", PromptSlug: "implement"}
	assignment.ToolPolicy.Deny = backendDeny
	loop.SetAssignmentLLM(assignment)

	opts := loop.llmOpts("implement")
	if len(opts.DisallowedTools) != len(backendDeny) {
		t.Fatalf("DisallowedTools = %v, want backend deny %v", opts.DisallowedTools, backendDeny)
	}
	for _, d := range backendDeny {
		if !containsStr(opts.DisallowedTools, d) {
			t.Errorf("DisallowedTools missing backend entry %q; got %v", d, opts.DisallowedTools)
		}
	}
}

func TestToolDeny_FallsBackToFloor_WhenAssignmentEmpty(t *testing.T) {
	loop := newModelTestLoop(t, "yaml-default")
	// No ToolPolicy.Deny set — empty backend list (configured-empty or pre-rollout).
	loop.SetAssignmentLLM(valaris.AssignmentLLM{Provider: "claude-cli", Model: "opus"})

	opts := loop.llmOpts("implement")
	if len(opts.DisallowedTools) != len(llm.SafeToolDenyFloor) {
		t.Fatalf("DisallowedTools = %v, want floor %v", opts.DisallowedTools, llm.SafeToolDenyFloor)
	}
	for _, d := range llm.SafeToolDenyFloor {
		if !containsStr(opts.DisallowedTools, d) {
			t.Errorf("floor fallback missing %q; got %v", d, opts.DisallowedTools)
		}
	}
}

func TestResolveToolDeny(t *testing.T) {
	tests := []struct {
		name       string
		backend    []string
		wantDeny   []string
		wantSource string
	}{
		{"backend non-empty wins", []string{"Bash(x:*)"}, []string{"Bash(x:*)"}, "backend"},
		{"empty falls back to floor", nil, llm.SafeToolDenyFloor, "floor-fallback"},
		{"explicit empty slice falls back", []string{}, llm.SafeToolDenyFloor, "floor-fallback"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			deny, source := resolveToolDeny(tt.backend)
			if source != tt.wantSource {
				t.Errorf("source = %q, want %q", source, tt.wantSource)
			}
			if len(deny) != len(tt.wantDeny) {
				t.Fatalf("deny = %v, want %v", deny, tt.wantDeny)
			}
			for i := range tt.wantDeny {
				if deny[i] != tt.wantDeny[i] {
					t.Errorf("deny[%d] = %q, want %q", i, deny[i], tt.wantDeny[i])
				}
			}
		})
	}
}

func containsStr(haystack []string, needle string) bool {
	for _, h := range haystack {
		if h == needle {
			return true
		}
	}
	return false
}

func TestPromptSlug_FromAssignmentPlumbsToDiscoverResult(t *testing.T) {
	resp := &valaris.NextAssignmentResponse{
		Card:  valaris.Card{ID: "card-1", Title: "x"},
		Board: valaris.AssignmentBoard{ID: "board-1"},
		LLM: valaris.AssignmentLLM{
			Provider:   "claude-cli",
			Model:      "backend-sonnet",
			PromptSlug: "implement-orchestrator",
		},
	}
	d := discoverResultFromAssignment(resp)
	if d.AssignmentLLM.Model != "backend-sonnet" {
		t.Fatalf("AssignmentLLM.Model must round-trip; got %q", d.AssignmentLLM.Model)
	}
	if d.AssignmentLLM.PromptSlug != "implement-orchestrator" {
		t.Fatalf("AssignmentLLM.PromptSlug must round-trip; got %q", d.AssignmentLLM.PromptSlug)
	}
	if d.AssignmentLLM.Provider != "claude-cli" {
		t.Fatalf("AssignmentLLM.Provider must round-trip; got %q", d.AssignmentLLM.Provider)
	}
}

// REGRESSION (2026-05-25, client-pilot model-dispatch): the lifecycle execution
// path (s.config.Lifecycle non-empty → tickViaLifecycle → walker → discover
// kind) must stash the backend-declared per-stage model the same way the legacy
// Tick path does at strategy_generic.go:74. Before the fix, lifecycleDiscover
// populated ws.Card but never called SetAssignmentLLM, so llmOpts saw an empty
// assignment and fell back to the runner's yaml model (sonnet) while logging the
// "backend did not declare a model" WARN — even though /next-assignment returned
// llm.model=opus. This test drives the real discover handler against a stub that
// returns a model and asserts the model reaches llmOpts with no yaml fallback.
func TestModel_LifecycleDiscover_StashesBackendModel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		if r.URL.Path == "/api/workspaces/ws/agents/agent-1/next-assignment" {
			_ = json.NewEncoder(w).Encode(valaris.NextAssignmentResponse{
				Card:  valaris.Card{ID: "card-1", Title: "M1-01"},
				Board: valaris.AssignmentBoard{ID: "board-1"},
				Role:  "planner",
				LLM: valaris.AssignmentLLM{
					Provider:   "claude-cli",
					Model:      "opus",
					PromptSlug: "plan",
				},
			})
			return
		}
		w.Write([]byte("{}"))
	}))
	t.Cleanup(server.Close)

	cfg := &config.Config{
		Valaris: config.ValarisConfig{WorkspaceSlug: "ws", BoardIDs: []string{"board-1"}},
		LLM:     config.LLMConfig{Model: "sonnet"},
	}
	client := valaris.NewClient(server.URL, "vlr_test")
	client.UserID = "user-1"
	client.Agent = &valaris.AgentConfig{ID: "agent-1", Name: "t", AgentType: "coding", IsActive: true}
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop, err := New(context.Background(), client, llm.NewMockProvider(), gitMgr, cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	s := NewDataDrivenStrategy(valaris.StageConfig{Role: "planner"}, nil)
	loop.strategy = s

	ws := &lifecycle.WalkState{Loop: loop, Strategy: s}
	if _, _, err := lifecycleDiscover(context.Background(), ws, &valaris.LifecycleStep{Name: "discover", Kind: "discover"}); err != nil {
		t.Fatalf("lifecycleDiscover: %v", err)
	}

	if got := loop.assignmentLLM().Model; got != "opus" {
		t.Fatalf("lifecycle discover must stash backend model; assignmentLLM().Model = %q, want %q", got, "opus")
	}
	if opts := loop.llmOpts("plan"); opts.Model != "opus" {
		t.Fatalf("llmOpts after lifecycle discover must dispatch backend model; got %q want %q", opts.Model, "opus")
	}
}
