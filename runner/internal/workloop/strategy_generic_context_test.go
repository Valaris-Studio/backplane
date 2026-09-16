// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

// CTX-2 — Backend-rendered context sources flow into PromptContext.
//
// The runner is a dumb consumer: every entry in the assignment bundle's
// `context: {<as>: <rendered_string>}` map must be visible to prompt templates
// as `{{ index .ContextSources "<as>" }}`. The legacy {{.ProjectDirectives}}
// alias is kept forever — backend `board_definition` mirrors the old
// ProjectDirectives.Format() output, so existing prompts stay green.

import (
	"context"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// New context_sources entries reach the LLM via the canonical Go-template
// access pattern. The data-driven runLLMStage path is the seam that all
// future stages flow through.
func TestRunLLMStage_ContextSourcesAccessibleViaIndex(t *testing.T) {
	mock := llm.NewMockProvider(`{"status":"done","summary":"used the notes"}`)
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

	loop.promptCacheMu.Lock()
	loop.promptCache["secretary:secretary_task"] = `Notes: {{ index .ContextSources "notes" }}`
	loop.promptCacheMu.Unlock()

	card := &discoverResult{
		CardID:         "card-ctx",
		BoardID:        "board-1",
		Title:          "With ctx",
		ContextSources: map[string]string{"notes": "the notes"},
	}
	if _, err := loop.strategy.(*DataDrivenStrategy).executeLLM(
		context.Background(), context.Background(), loop, card, "exec-ctx-1", t.TempDir(),
	); err != nil {
		t.Fatalf("executeLLM: %v", err)
	}
	if mock.CallCount() != 1 {
		t.Fatalf("expected 1 LLM call, got %d", mock.CallCount())
	}
	rendered := mock.LastCall().Prompt
	if !strings.Contains(rendered, "Notes: the notes") {
		t.Errorf("ContextSources['notes'] not rendered; got:\n%s", rendered)
	}
}

// Legacy alias (#3 in the locked CTX design): backend `board_definition`
// is mirrored into ProjectDirectives when the latter is empty so that
// existing prompts referencing {{.ProjectDirectives}} keep producing the
// same string they produced when the runner fetched directives via REST.
func TestRunLLMStage_BoardDefinitionAliasesProjectDirectives(t *testing.T) {
	mock := llm.NewMockProvider(`{"status":"done","summary":"applied standards"}`)
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

	loop.promptCacheMu.Lock()
	loop.promptCache["secretary:secretary_task"] = `Standards: {{.ProjectDirectives}}`
	loop.promptCacheMu.Unlock()

	card := &discoverResult{
		CardID:  "card-alias",
		BoardID: "board-1",
		ContextSources: map[string]string{
			"board_definition": "STANDARDS X",
		},
	}
	if _, err := loop.strategy.(*DataDrivenStrategy).executeLLM(
		context.Background(), context.Background(), loop, card, "exec-ctx-2", t.TempDir(),
	); err != nil {
		t.Fatalf("executeLLM: %v", err)
	}
	rendered := mock.LastCall().Prompt
	if !strings.Contains(rendered, "Standards: STANDARDS X") {
		t.Errorf("board_definition should alias to ProjectDirectives; got:\n%s", rendered)
	}
}

// When ProjectDirectives is already set (e.g. via the legacy fetchDirectives
// path during the CTX-5 transition), the alias must NOT clobber it. Direct
// unit test on the helper — the runLLMStage seam can't express "preset" today
// because PromptContext is built locally; the helper enforces the contract.
func TestApplyContextSources_PresetProjectDirectivesWins(t *testing.T) {
	pc := PromptContext{
		ProjectDirectives: "explicit",
		ContextSources:    map[string]string{"board_definition": "ignored"},
	}
	applyBoardDefinitionAlias(&pc)
	if pc.ProjectDirectives != "explicit" {
		t.Errorf("ProjectDirectives = %q, want %q (alias must not clobber preset)",
			pc.ProjectDirectives, "explicit")
	}
}

func TestApplyContextSources_EmptyProjectDirectivesAdoptsBoardDefinition(t *testing.T) {
	pc := PromptContext{
		ContextSources: map[string]string{"board_definition": "from-context"},
	}
	applyBoardDefinitionAlias(&pc)
	if pc.ProjectDirectives != "from-context" {
		t.Errorf("ProjectDirectives = %q, want %q (alias should populate empty field)",
			pc.ProjectDirectives, "from-context")
	}
}

func TestApplyContextSources_NoBoardDefinitionLeavesEmpty(t *testing.T) {
	pc := PromptContext{}
	applyBoardDefinitionAlias(&pc)
	if pc.ProjectDirectives != "" {
		t.Errorf("ProjectDirectives = %q, want empty (no source to adopt)", pc.ProjectDirectives)
	}
}

// review_history alias mirrors the board_definition contract: backend
// `review_history` populates {{.ReviewHistory}} so existing prompts keep
// rendering after operators move to context_sources.
func TestRunLLMStage_ReviewHistoryAliasesReviewHistory(t *testing.T) {
	mock := llm.NewMockProvider(`{"status":"done","summary":"saw history"}`)
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

	loop.promptCacheMu.Lock()
	loop.promptCache["secretary:secretary_task"] = `History: {{.ReviewHistory}}`
	loop.promptCacheMu.Unlock()

	card := &discoverResult{
		CardID:  "card-rh-alias",
		BoardID: "board-1",
		ContextSources: map[string]string{
			"review_history": "REVIEW NOTES X",
		},
	}
	if _, err := loop.strategy.(*DataDrivenStrategy).executeLLM(
		context.Background(), context.Background(), loop, card, "exec-ctx-3", t.TempDir(),
	); err != nil {
		t.Fatalf("executeLLM: %v", err)
	}
	rendered := mock.LastCall().Prompt
	if !strings.Contains(rendered, "History: REVIEW NOTES X") {
		t.Errorf("review_history should alias to ReviewHistory; got:\n%s", rendered)
	}
}

func TestApplyContextSources_PresetReviewHistoryWins(t *testing.T) {
	pc := PromptContext{
		ReviewHistory:  "explicit",
		ContextSources: map[string]string{"review_history": "ignored"},
	}
	applyReviewHistoryAlias(&pc)
	if pc.ReviewHistory != "explicit" {
		t.Errorf("ReviewHistory = %q, want %q (alias must not clobber preset)",
			pc.ReviewHistory, "explicit")
	}
}

func TestApplyContextSources_EmptyReviewHistoryAdoptsContextSource(t *testing.T) {
	pc := PromptContext{
		ContextSources: map[string]string{"review_history": "from-context"},
	}
	applyReviewHistoryAlias(&pc)
	if pc.ReviewHistory != "from-context" {
		t.Errorf("ReviewHistory = %q, want %q (alias should populate empty field)",
			pc.ReviewHistory, "from-context")
	}
}

func TestApplyContextSources_NoReviewHistoryLeavesEmpty(t *testing.T) {
	pc := PromptContext{}
	applyReviewHistoryAlias(&pc)
	if pc.ReviewHistory != "" {
		t.Errorf("ReviewHistory = %q, want empty (no source to adopt)", pc.ReviewHistory)
	}
}
