// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

func TestExecutionLogDescriptionIsConfigDriven(t *testing.T) {
	tests := []struct {
		name  string
		stage valaris.StageConfig
		want  string
	}{
		{
			name:  "built-in orchestrator keeps its legacy string",
			stage: valaris.StageConfig{Role: "orchestrator", Claim: valaris.ClaimDef{ExecutionAction: "implement_card"}},
			want:  "Implementing card",
		},
		{
			name:  "built-in reviewer keeps its legacy string",
			stage: valaris.StageConfig{Role: "reviewer", Claim: valaris.ClaimDef{ExecutionAction: "review_card"}},
			want:  "Reviewing card",
		},
		{
			name:  "built-in documentator keeps its legacy string",
			stage: valaris.StageConfig{Role: "documentator", Claim: valaris.ClaimDef{ExecutionAction: "document_card"}},
			want:  "Documenting card",
		},
		{
			name:  "log_verb overrides every derivation",
			stage: valaris.StageConfig{Role: "security-auditor", Claim: valaris.ClaimDef{ExecutionAction: "audit_card", LogVerb: "Auditing"}},
			want:  "Auditing card",
		},
		{
			name:  "log_verb wins even when the role is a built-in",
			stage: valaris.StageConfig{Role: "reviewer", Claim: valaris.ClaimDef{ExecutionAction: "review_card", LogVerb: "Double-checking"}},
			want:  "Double-checking card",
		},
		{
			name:  "custom execution_action derives a gerund",
			stage: valaris.StageConfig{Role: "security-auditor", Claim: valaris.ClaimDef{ExecutionAction: "audit_card"}},
			want:  "Auditing card",
		},
		{
			name:  "multi-word execution_action humanizes underscores",
			stage: valaris.StageConfig{Role: "smoke", Claim: valaris.ClaimDef{ExecutionAction: "smoke_test_card"}},
			want:  "Smoke testing card",
		},
		{
			name:  "execution_action without the _card suffix still derives",
			stage: valaris.StageConfig{Role: "triager", Claim: valaris.ClaimDef{ExecutionAction: "triage"}},
			want:  "Triaging card",
		},
		{
			name:  "role fallback capitalizes the first rune unicode-safely",
			stage: valaris.StageConfig{Role: "ünit-tester"},
			want:  "Ünit-tester card",
		},
		{
			name:  "already-capitalized role is not mangled",
			stage: valaris.StageConfig{Role: "QA"},
			want:  "QA card",
		},
		{
			name:  "empty stage falls back to a generic description",
			stage: valaris.StageConfig{},
			want:  "Processing card",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := executionLogDescription(tt.stage); got != tt.want {
				t.Errorf("executionLogDescription() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestGerundOfHandlesEnglishSpellingRules(t *testing.T) {
	tests := []struct{ verb, want string }{
		{"implement", "implementing"},
		{"review", "reviewing"},
		{"document", "documenting"},
		{"audit", "auditing"},   // unstressed final syllable does not double
		{"visit", "visiting"},   // ditto
		{"triage", "triaging"},  // silent trailing e is dropped
		{"see", "seeing"},       // -ee keeps both e's
		{"run", "running"},      // consonant-vowel-consonant doubles
		{"scan", "scanning"},    // ditto
		{"fix", "fixing"},       // x is never doubled
		{"deploy", "deploying"}, // vowel-vowel-consonant does not double
		{"testing", "testing"},  // already a gerund
		{"", ""},
	}

	for _, tt := range tests {
		t.Run(tt.verb, func(t *testing.T) {
			if got := gerundOf(tt.verb); got != tt.want {
				t.Errorf("gerundOf(%q) = %q, want %q", tt.verb, got, tt.want)
			}
		})
	}
}
