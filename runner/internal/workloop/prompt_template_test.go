// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"strings"
	"testing"
)

func TestRenderPrompt_BasicInterpolation(t *testing.T) {
	tmpl := `You are working in {{.Workspace}} as agent {{.AgentID}} on board {{.BoardID}}.`
	ctx := PromptContext{
		Workspace: "test-ws",
		AgentID:   "agent-1",
		BoardID:   "board-42",
	}

	result, err := renderPrompt(tmpl, ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	expected := "You are working in test-ws as agent agent-1 on board board-42."
	if result != expected {
		t.Errorf("got %q, want %q", result, expected)
	}
}

func TestRenderPrompt_AllFields(t *testing.T) {
	tmpl := `W={{.Workspace}} A={{.AgentID}} B={{.BoardID}} Bs={{.BoardIDs}} C={{.CardID}} E={{.ExecutionID}} AS={{.ApprovalSummary}} BR={{.Branch}} PR={{.PRURL}} ERR={{.ErrorMsg}} U={{.UserID}} GR={{.GitRepoURL}} GN={{.GitRepoName}} BL={{.BlockedCardIDs}} RH={{.ReviewHistory}} AP={{.ActionPlan}} RA={{.ReworkAttempt}} MRA={{.MaxReworkAttempts}} PD={{.ProjectDirectives}} D={{.Decision}}`
	ctx := PromptContext{
		Workspace:         "ws",
		AgentID:           "a1",
		BoardID:           "b1",
		BoardIDs:          "b1, b2",
		CardID:            "c1",
		ExecutionID:       "e1",
		ApprovalSummary:   "approved deletion",
		Branch:            "runner/fix-bug",
		PRURL:             "https://github.com/org/repo/pull/1",
		ErrorMsg:          "timeout",
		UserID:            "u1",
		GitRepoURL:        "https://github.com/org/repo.git",
		GitRepoName:       "repo",
		BlockedCardIDs:    "card-1, card-2",
		ReviewHistory:     "review 1\nreview 2",
		ActionPlan:        "fix auth module",
		ReworkAttempt:     2,
		MaxReworkAttempts: 3,
		ProjectDirectives: "use TDD",
		Decision:          "approve",
	}

	result, err := renderPrompt(tmpl, ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	expected := `W=ws A=a1 B=b1 Bs=b1, b2 C=c1 E=e1 AS=approved deletion BR=runner/fix-bug PR=https://github.com/org/repo/pull/1 ERR=timeout U=u1 GR=https://github.com/org/repo.git GN=repo BL=card-1, card-2 RH=review 1
review 2 AP=fix auth module RA=2 MRA=3 PD=use TDD D=approve`
	if result != expected {
		t.Errorf("got %q, want %q", result, expected)
	}
}

func TestRenderPrompt_EmptyFields(t *testing.T) {
	tmpl := `Agent {{.AgentID}} in {{.Workspace}}`
	ctx := PromptContext{} // all zero values

	result, err := renderPrompt(tmpl, ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	expected := "Agent  in "
	if result != expected {
		t.Errorf("got %q, want %q", result, expected)
	}
}

func TestRenderPrompt_InvalidTemplate(t *testing.T) {
	tmpl := `Missing closing {{.Workspace`
	ctx := PromptContext{Workspace: "ws"}

	_, err := renderPrompt(tmpl, ctx)
	if err == nil {
		t.Fatal("expected error for malformed template")
	}
}

func TestRenderPrompt_UnknownField(t *testing.T) {
	tmpl := `Value is {{.NonExistent}}`
	ctx := PromptContext{}

	_, err := renderPrompt(tmpl, ctx)
	if err == nil {
		t.Fatal("expected error for unknown field")
	}
}

func TestRenderPrompt_MultilineTemplate(t *testing.T) {
	tmpl := `You are an agent.

WORKSPACE: {{.Workspace}}
BOARD_ID: {{.BoardID}}

Steps:
1. Do the thing for card {{.CardID}}.`

	ctx := PromptContext{
		Workspace: "internal",
		BoardID:   "board-1",
		CardID:    "card-99",
	}

	result, err := renderPrompt(tmpl, ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == "" {
		t.Fatal("expected non-empty result")
	}
	// Verify interpolation happened
	if !contains(result, "WORKSPACE: internal") {
		t.Error("workspace not interpolated")
	}
	if !contains(result, "card card-99") {
		t.Error("card_id not interpolated")
	}
}

func TestMustRender_Success(t *testing.T) {
	result := mustRender(`Hello {{.Workspace}}`, PromptContext{Workspace: "test"})
	if result != "Hello test" {
		t.Errorf("got %q, want %q", result, "Hello test")
	}
}

func TestMustRender_PanicsOnInvalidTemplate(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic for invalid template")
		}
	}()
	mustRender(`{{.Missing`, PromptContext{})
}

func TestMustRenderExt_Success(t *testing.T) {
	type ctx struct {
		Name string
		Age  int
	}
	result := mustRenderExt(`{{.Name}} is {{.Age}}`, ctx{Name: "bot", Age: 1})
	if result != "bot is 1" {
		t.Errorf("got %q, want %q", result, "bot is 1")
	}
}

func TestMustRenderExt_PanicsOnBadField(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic for unknown field")
		}
	}()
	mustRenderExt(`{{.Missing}}`, struct{}{})
}

func TestPromptFunctions_NoPanic(t *testing.T) {
	// Every prompt function must render without panicking, even with zero-value context.
	ctx := PromptContext{
		Workspace: "ws",
		AgentID:   "a1",
		BoardID:   "b1",
		CardID:    "c1",
	}
	funcs := map[string]func(PromptContext) string{
		"implement":         implementPrompt,
		"implementApproval": implementAfterApprovalPrompt,
		"mediateRework":     mediateReworkPrompt,
		"reworkImplement":   reworkImplementPrompt,
		"reviewCode":        reviewCodePrompt,
		"generateDocs":      generateDocsPrompt,
		"research":          researchPrompt,
		"plan":              planPrompt,
	}
	for name, fn := range funcs {
		t.Run(name, func(t *testing.T) {
			result := fn(ctx)
			if result == "" {
				t.Error("expected non-empty prompt")
			}
		})
	}
}

func TestPromptFunctions_ConditionalBlocks(t *testing.T) {
	t.Run("implement_with_directives", func(t *testing.T) {
		p := implementPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "c1", ProjectDirectives: "use TDD"})
		if !strings.Contains(p, "PROJECT DIRECTIVES") {
			t.Error("expected directives block")
		}
		if !strings.Contains(p, "use TDD") {
			t.Error("expected directive content")
		}
	})
	t.Run("implement_without_directives", func(t *testing.T) {
		p := implementPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "c1"})
		if strings.Contains(p, "PROJECT DIRECTIVES") {
			t.Error("directives block should be omitted when empty")
		}
	})
	t.Run("mediate_escalation_triggered", func(t *testing.T) {
		p := mediateReworkPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "c1", ReworkAttempt: 3, MaxReworkAttempts: 3})
		if !strings.Contains(p, "ESCALATION WARNING") {
			t.Error("expected escalation warning at threshold")
		}
	})
	t.Run("mediate_no_escalation", func(t *testing.T) {
		p := mediateReworkPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "c1", ReworkAttempt: 1, MaxReworkAttempts: 3})
		if strings.Contains(p, "ESCALATION WARNING") {
			t.Error("escalation warning should not appear below threshold")
		}
	})
	t.Run("reworkImplement_with_directives", func(t *testing.T) {
		p := reworkImplementPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "c1", ActionPlan: "fix bug", ProjectDirectives: "standards"})
		if !strings.Contains(p, "PROJECT DIRECTIVES") {
			t.Error("expected directives block in rework implement")
		}
	})
	t.Run("reworkImplement_without_directives", func(t *testing.T) {
		p := reworkImplementPrompt(PromptContext{Workspace: "ws", AgentID: "a1", BoardID: "b1", CardID: "c1", ActionPlan: "fix bug"})
		if strings.Contains(p, "PROJECT DIRECTIVES") {
			t.Error("directives block should be omitted when empty")
		}
	})
}

func TestRenderPrompt_ContextSourcesIndex(t *testing.T) {
	tmpl := `Notes: {{ index .ContextSources "notes" }}`
	ctx := PromptContext{
		ContextSources: map[string]string{
			"notes":     "the notes",
			"reference": "ignored",
		},
	}
	result, err := renderPrompt(tmpl, ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "Notes: the notes" {
		t.Errorf("got %q, want %q", result, "Notes: the notes")
	}
}

func TestRenderPrompt_ContextSourcesNilNoPanic(t *testing.T) {
	tmpl := `Notes: {{ index .ContextSources "notes" }}`
	result, err := renderPrompt(tmpl, PromptContext{}) // ContextSources nil
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "Notes: " {
		t.Errorf("nil map should render empty value, got %q", result)
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsHelper(s, substr))
}

func containsHelper(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// TestRenderPrompt_EscapedBracesRoundTrip is the Go half of the backend's slot
// renderer contract (spec §3.1 rule 6). The backend escapes every `{{` inside a
// SLOT VALUE to the text/template literal `{{"{{"}}` rather than rejecting it,
// because real prompts quote Go templates, shell braces and JSON. This test is
// the proof that the escape is lossless: what an operator typed is what the
// agent reads.
//
// It also pins the asymmetry that makes the escape safe to apply one-sided: a
// bare `}}` outside an action is ordinary text to text/template, so escaping it
// too would corrupt the value instead of protecting it.
//
// If this fails, the backend's _escape_go_template (loop_template_render.py) and
// this expectation have drifted apart — fix them together.
func TestRenderPrompt_EscapedBracesRoundTrip(t *testing.T) {
	// Exactly what a person typed into a slot on the platform.
	original := "Use {{.Iteration}} and {{x}} and a bare }} plus {{ spaced."

	// What the backend stores after escaping: `{{` -> `{{"{{"}}`, `}}` untouched.
	escaped := strings.ReplaceAll(original, "{{", `{{"{{"}}`)

	// The kernel keeps its OWN runner var unescaped — only values are escaped —
	// so the rendered output must substitute there and only there.
	tmpl := escaped + " (iteration {{.Iteration}})"

	result, err := renderPrompt(tmpl, PromptContext{Iteration: 7})
	if err != nil {
		t.Fatalf("escaped value must be a parseable template: %v", err)
	}

	want := original + " (iteration 7)"
	if result != want {
		t.Errorf("round trip lost data:\n got %q\nwant %q", result, want)
	}

	// The literal the operator typed must survive as literal text, never as a
	// substituted value: `{{.Iteration}}` inside a VALUE is prose about the
	// contract, not an instance of it.
	if !strings.Contains(result, "{{.Iteration}} and {{x}}") {
		t.Errorf("escaped braces did not render back to literals: %q", result)
	}
	if strings.Contains(result, `{{"{{"}}`) {
		t.Errorf("escape sequence leaked into the rendered prompt: %q", result)
	}
	if strings.Count(result, "7") != 1 {
		t.Errorf("Iteration substituted somewhere it should not have been: %q", result)
	}
}

// TestRenderPrompt_UnescapedValueBracesBreakTheTemplate is the negative control
// for the test above: it shows WHY the backend escapes instead of storing the
// value verbatim. `{{x}}` is not a valid action, so an unescaped value makes the
// whole iteration fail to render — which is exactly the failure the escape moves
// from a paid runner iteration to a 422 at save time.
func TestRenderPrompt_UnescapedValueBracesBreakTheTemplate(t *testing.T) {
	if _, err := renderPrompt("literal {{x}} here", PromptContext{}); err == nil {
		t.Fatal("expected unescaped {{x}} to fail parsing; escaping would be pointless")
	}
}
