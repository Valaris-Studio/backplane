// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// --- $-ref resolution for LLM lifecycle refs ---

func TestResolveMCPRef_LLMOutput_FromRawStdout(t *testing.T) {
	ws := &lifecycle.WalkState{
		Loop:         &Loop{client: &valaris.Client{}},
		LLMRawOutput: "X",
	}
	got, err := resolveMCPRef(ws, "$llm_output")
	if err != nil {
		t.Fatalf("resolveMCPRef: %v", err)
	}
	if got != "X" {
		t.Errorf("$llm_output = %q, want X", got)
	}
}

func TestResolveMCPRef_LLMOutput_EmptyWhenUnset(t *testing.T) {
	ws := &lifecycle.WalkState{Loop: &Loop{client: &valaris.Client{}}}
	got, err := resolveMCPRef(ws, "$llm_output")
	if err != nil {
		t.Fatalf("resolveMCPRef: %v", err)
	}
	if got != "" {
		t.Errorf("$llm_output = %q, want empty", got)
	}
}

func TestResolveMCPRef_LLMFindings_FromReviewResult(t *testing.T) {
	ws := &lifecycle.WalkState{
		Loop:      &Loop{client: &valaris.Client{}},
		LLMResult: &llmStageResult{reviewResult: &reviewResult{Findings: "F"}},
	}
	got, err := resolveMCPRef(ws, "$llm_findings")
	if err != nil {
		t.Fatalf("resolveMCPRef: %v", err)
	}
	if got != "F" {
		t.Errorf("$llm_findings = %q, want F", got)
	}
}

func TestResolveMCPRef_LLMSummary_FromReviewResult(t *testing.T) {
	ws := &lifecycle.WalkState{
		Loop:      &Loop{client: &valaris.Client{}},
		LLMResult: &llmStageResult{reviewResult: &reviewResult{Summary: "S"}},
	}
	got, err := resolveMCPRef(ws, "$llm_summary")
	if err != nil {
		t.Fatalf("resolveMCPRef: %v", err)
	}
	if got != "S" {
		t.Errorf("$llm_summary = %q, want S", got)
	}
}

func TestResolveMCPRef_LLMDecision_FromReviewResult(t *testing.T) {
	ws := &lifecycle.WalkState{
		Loop:      &Loop{client: &valaris.Client{}},
		LLMResult: &llmStageResult{reviewResult: &reviewResult{Decision: "approve"}},
	}
	got, err := resolveMCPRef(ws, "$llm_decision")
	if err != nil {
		t.Fatalf("resolveMCPRef: %v", err)
	}
	if got != "approve" {
		t.Errorf("$llm_decision = %q, want approve", got)
	}
}

func TestResolveMCPRef_LLMFindings_NilReviewResult_ReturnsEmpty(t *testing.T) {
	ws := &lifecycle.WalkState{Loop: &Loop{client: &valaris.Client{}}}
	got, err := resolveMCPRef(ws, "$llm_findings")
	if err != nil {
		t.Fatalf("resolveMCPRef: %v", err)
	}
	if got != "" {
		t.Errorf("$llm_findings nil-safe = %q, want empty", got)
	}
}

// Unknown-ref error message must surface the new ref names so operators can
// discover the supported set without grepping source.
func TestResolveMCPRef_UnknownRef_ListsAvailable(t *testing.T) {
	ws := &lifecycle.WalkState{Loop: &Loop{client: &valaris.Client{}}}
	_, err := resolveMCPRef(ws, "$banana")
	if err == nil {
		t.Fatal("want error on unknown ref")
	}
	msg := err.Error()
	hasNewRef := strings.Contains(msg, "$llm_output") ||
		strings.Contains(msg, "$llm_findings") ||
		strings.Contains(msg, "$llm_summary") ||
		strings.Contains(msg, "$llm_decision")
	if !hasNewRef {
		t.Errorf("error should advertise at least one new LLM ref; got: %v", err)
	}
}

// --- mcp_call create_note dispatch ---

func TestMCPCall_CreateNote_DispatchesToClient(t *testing.T) {
	srv, getPosts := noteCapturingServer(t)
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c1", BoardID: "b"})
	step := &valaris.LifecycleStep{
		Name: "n", Kind: "mcp_call",
		Params: map[string]any{
			"tool": "create_note",
			"args": map[string]any{
				"kind":  "plan",
				"title": "Plan A",
				"body":  "literal body",
			},
		},
	}
	if _, _, err := lifecycleMCPCall(context.Background(), ws, step); err != nil {
		t.Fatalf("mcp_call create_note: %v", err)
	}
	posts := getPosts()
	if len(posts) != 1 {
		t.Fatalf("want 1 note POST, got %d", len(posts))
	}
	if got, _ := posts[0].Decoded["kind"].(string); got != "plan" {
		t.Errorf("kind = %q, want plan", got)
	}
	if got, _ := posts[0].Decoded["title"].(string); got != "Plan A" {
		t.Errorf("title = %q, want Plan A", got)
	}
	if got, _ := posts[0].Decoded["content"].(string); got != "literal body" {
		t.Errorf("content = %q, want literal body", got)
	}
}

func TestMCPCall_CreateNote_ResolvesLLMOutputRef(t *testing.T) {
	srv, getPosts := noteCapturingServer(t)
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c1", BoardID: "b"})
	ws.LLMRawOutput = "raw"
	step := &valaris.LifecycleStep{
		Name: "n", Kind: "mcp_call",
		Params: map[string]any{
			"tool": "create_note",
			"args": map[string]any{
				"kind": "plan",
				"body": "$llm_output",
			},
		},
	}
	if _, _, err := lifecycleMCPCall(context.Background(), ws, step); err != nil {
		t.Fatalf("mcp_call create_note: %v", err)
	}
	posts := getPosts()
	if len(posts) != 1 {
		t.Fatalf("want 1 note POST, got %d", len(posts))
	}
	if got, _ := posts[0].Decoded["content"].(string); got != "raw" {
		t.Errorf("content = %q, want raw (post $-ref resolution)", got)
	}
}

func TestMCPCall_CreateNote_RejectsMissingKind(t *testing.T) {
	srv, getPosts := noteCapturingServer(t)
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c1", BoardID: "b"})
	step := &valaris.LifecycleStep{
		Name: "n", Kind: "mcp_call",
		Params: map[string]any{
			"tool": "create_note",
			"args": map[string]any{"body": "x"},
		},
	}
	_, _, err := lifecycleMCPCall(context.Background(), ws, step)
	if err == nil || !strings.Contains(err.Error(), "kind") {
		t.Fatalf("want missing-kind error, got: %v", err)
	}
	if posts := getPosts(); len(posts) != 0 {
		t.Errorf("client should not POST on missing kind; got %d posts", len(posts))
	}
}

func TestMCPCall_CreateNote_RejectsEmptyBodyAfterResolve(t *testing.T) {
	srv, getPosts := noteCapturingServer(t)
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c1", BoardID: "b"})
	// LLMRawOutput unset → $llm_output resolves to "".
	step := &valaris.LifecycleStep{
		Name: "n", Kind: "mcp_call",
		Params: map[string]any{
			"tool": "create_note",
			"args": map[string]any{"kind": "plan", "body": "$llm_output"},
		},
	}
	_, _, err := lifecycleMCPCall(context.Background(), ws, step)
	if err == nil || !strings.Contains(err.Error(), "body") {
		t.Fatalf("want missing-body error after resolution, got: %v", err)
	}
	if posts := getPosts(); len(posts) != 0 {
		t.Errorf("client should not POST when body resolves to empty; got %d posts", len(posts))
	}
}

func TestMCPCall_CreateNote_PropagatesFailureClass(t *testing.T) {
	srv, getPosts := noteCapturingServer(t)
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c1", BoardID: "b"})
	step := &valaris.LifecycleStep{
		Name: "n", Kind: "mcp_call",
		Params: map[string]any{
			"tool": "create_note",
			"args": map[string]any{
				"kind":          "review_verdict",
				"body":          "x",
				"failure_class": "needs_rework",
			},
		},
	}
	if _, _, err := lifecycleMCPCall(context.Background(), ws, step); err != nil {
		t.Fatalf("mcp_call create_note: %v", err)
	}
	posts := getPosts()
	if len(posts) != 1 {
		t.Fatalf("want 1 note POST, got %d", len(posts))
	}
	if got, _ := posts[0].Decoded["failure_class"].(string); got != "needs_rework" {
		t.Errorf("failure_class = %q, want needs_rework", got)
	}
}
