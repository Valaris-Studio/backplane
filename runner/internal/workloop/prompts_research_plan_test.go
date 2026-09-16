// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

// Phase I.1.h — Research + plan prompt templates.
//
// Two new personas get hardcoded Go fallbacks so the engine behaves identically
// to the backend's seeded defaults even when the platform prompt cache is empty.
// Every other custom stage name still graceful-skips with decision="no_prompt".

import (
	"context"
	"regexp"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// --- Render tests: researchPrompt + planPrompt ---

func TestResearchPrompt_RendersWithoutPanic(t *testing.T) {
	// Zero-value PromptContext — exercises every {{if .Field}} branch safely.
	_ = researchPrompt(PromptContext{})

	// Full context — exercises every interpolation site.
	full := researchPrompt(PromptContext{
		Workspace:   "alpha",
		AgentID:     "agent-1",
		BoardID:     "board-42",
		CardID:      "card-7",
		ExecutionID: "exec-9",
	})
	if full == "" {
		t.Fatal("researchPrompt returned empty string")
	}
}

func TestPlanPrompt_RendersWithoutPanic(t *testing.T) {
	_ = planPrompt(PromptContext{})

	full := planPrompt(PromptContext{
		Workspace:   "alpha",
		AgentID:     "agent-1",
		BoardID:     "board-42",
		CardID:      "card-7",
		ExecutionID: "exec-9",
	})
	if full == "" {
		t.Fatal("planPrompt returned empty string")
	}
}

func TestResearchPrompt_IncludesIdentifiers(t *testing.T) {
	p := researchPrompt(PromptContext{
		Workspace:   "ws-alpha",
		AgentID:     "agent-123",
		BoardID:     "board-abc",
		CardID:      "card-xyz",
		ExecutionID: "exec-111",
	})
	for _, want := range []string{"ws-alpha", "agent-123", "board-abc", "card-xyz", "exec-111"} {
		if !strings.Contains(p, want) {
			t.Errorf("researchPrompt missing %q in rendered output", want)
		}
	}
	// Produces_note JSON shape hints.
	if !strings.Contains(p, "findings") {
		t.Error("researchPrompt should mention findings field (produces_note shape)")
	}
}

func TestPlanPrompt_IncludesIdentifiers(t *testing.T) {
	p := planPrompt(PromptContext{
		Workspace:   "ws-alpha",
		AgentID:     "agent-123",
		BoardID:     "board-abc",
		CardID:      "card-xyz",
		ExecutionID: "exec-111",
	})
	for _, want := range []string{"ws-alpha", "agent-123", "board-abc", "card-xyz", "exec-111"} {
		if !strings.Contains(p, want) {
			t.Errorf("planPrompt missing %q in rendered output", want)
		}
	}
	// The default planner can read context; the lifecycle persists its findings.
	allowed := map[string]bool{"get_card": true, "get_project_context": true, "log_execution_update": true}
	for _, match := range regexp.MustCompile(`([a-z][a-z_]+)\(`).FindAllStringSubmatch(p, -1) {
		if !allowed[match[1]] {
			t.Errorf("planner fallback instructs ungranted tool %s", match[1])
		}
	}
	for _, want := range []string{"single plan", "CARD NOTES", "kind=plan", "Out of scope", "Wiring sites"} {
		if !strings.Contains(p, want) {
			t.Errorf("planner fallback missing %q", want)
		}
	}
	if !strings.Contains(p, "decision") {
		t.Error("planPrompt should mention decision field for routing")
	}
}

// --- Fallback dispatch: runLLMStage resolves research/plan fallbacks ---

// When the platform prompt cache is empty, runLLMStage for stage="research"
// must fall back to researchPrompt (not skip with no_prompt).
func TestCustomStageFallbacks_DispatchResearch(t *testing.T) {
	mock := llm.NewMockProvider(`{"status":"done","summary":"researched","findings":"details"}`)
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

	// Clear the seeded cache so the fallback path is exercised.
	loop.promptCacheMu.Lock()
	loop.promptCache = map[string]string{}
	loop.promptCacheMu.Unlock()

	card := &discoverResult{CardID: "card-r", BoardID: "board-1", Title: "Research task"}
	res, err := loop.strategy.(*DataDrivenStrategy).executeLLM(
		context.Background(), context.Background(), loop, card, "exec-r", t.TempDir(),
	)
	if err != nil {
		t.Fatalf("executeLLM: %v", err)
	}
	if res == nil || res.decision == "no_prompt" {
		t.Fatalf("research fallback should run (not skip); got res=%+v", res)
	}
	if mock.CallCount() != 1 {
		t.Fatalf("LLM should be invoked via fallback; called %d times", mock.CallCount())
	}
	// The mock prompt must contain the interpolated card ID, proving the
	// researchPrompt template was rendered.
	if !strings.Contains(mock.LastCall().Prompt, "card-r") {
		t.Errorf("fallback prompt should include card-r, got: %s", mock.LastCall().Prompt)
	}
	if res.reviewResult == nil {
		t.Fatalf("produces_note should populate reviewResult; got %+v", res)
	}
	if res.reviewResult.Findings != "details" {
		t.Errorf("findings = %q, want %q", res.reviewResult.Findings, "details")
	}
}

// Same contract for planner:plan — empty cache, fallback used.
func TestCustomStageFallbacks_DispatchPlan(t *testing.T) {
	mock := llm.NewMockProvider(`{"status":"done","summary":"plan written","decision":"planned","findings":"Approach: implement the card"}`)
	stage := valaris.StageConfig{
		Role:  "planner",
		Claim: valaris.ClaimDef{ParticipantRole: "helper"},
		LLM: valaris.LLMDef{
			Enabled:         true,
			Stage:           "plan",
			PostProcessKind: "produces_note",
		},
	}
	loop := newLLMTestLoop(t, mock, stage)

	loop.promptCacheMu.Lock()
	loop.promptCache = map[string]string{}
	loop.promptCacheMu.Unlock()

	card := &discoverResult{CardID: "card-p", BoardID: "board-1", Title: "Plan sprint"}
	res, err := loop.strategy.(*DataDrivenStrategy).executeLLM(
		context.Background(), context.Background(), loop, card, "exec-p", t.TempDir(),
	)
	if err != nil {
		t.Fatalf("executeLLM: %v", err)
	}
	if res == nil || res.decision == "no_prompt" {
		t.Fatalf("plan fallback should run (not skip); got res=%+v", res)
	}
	if mock.CallCount() != 1 {
		t.Fatalf("LLM should be invoked via fallback; called %d times", mock.CallCount())
	}
	if !strings.Contains(mock.LastCall().Prompt, "card-p") {
		t.Errorf("fallback prompt should include card-p, got: %s", mock.LastCall().Prompt)
	}
	if res.reviewResult == nil || res.reviewResult.Findings != "Approach: implement the card" {
		t.Fatalf("planner must return findings for its plan note: %+v", res)
	}
	if res.decision != "planned" {
		t.Errorf("decision = %q, want planned", res.decision)
	}
}

// Unknown custom stage with no cache and no fallback still graceful-skips.
// This protects the I.1.g contract: adding new fallbacks is opt-in per stage.
func TestCustomStageFallbacks_UnknownStage_GracefulSkip(t *testing.T) {
	mock := llm.NewMockProvider() // no responses — real LLM call would error
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

	loop.promptCacheMu.Lock()
	loop.promptCache = map[string]string{}
	loop.promptCacheMu.Unlock()

	card := &discoverResult{CardID: "card-g", BoardID: "board-1", Title: "Ghost"}
	res, err := loop.strategy.(*DataDrivenStrategy).executeLLM(
		context.Background(), context.Background(), loop, card, "exec-g", t.TempDir(),
	)
	if err != nil {
		t.Fatalf("graceful-skip should not error: %v", err)
	}
	if res == nil || res.decision != "no_prompt" {
		t.Errorf("want decision=no_prompt, got %+v", res)
	}
	if mock.CallCount() != 0 {
		t.Errorf("LLM should NOT be invoked for ghost stage; called %d times", mock.CallCount())
	}
}
