// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

func TestMediationFromProse_EscalationKeywords(t *testing.T) {
	tests := []struct {
		name         string
		output       string
		wantEscalate bool
	}{
		{
			name:         "plain rework prose without escalation language",
			output:       "The reviewer wants error handling on line 42. Add a nil check and re-run the tests.",
			wantEscalate: false,
		},
		{
			name:         "explicit escalate verb",
			output:       "There is no review history to work from. Please escalate this to a human operator.",
			wantEscalate: true,
		},
		{
			name:         "uppercase ESCALATE",
			output:       "RECOMMENDATION: ESCALATE — the card contradicts its own acceptance criteria.",
			wantEscalate: true,
		},
		{
			name:         "mixed-case Cannot Proceed",
			output:       "I Cannot Proceed without the missing schema file.",
			wantEscalate: true,
		},
		{
			name:         "human intervention phrasing",
			output:       "This requires human intervention: the repository credentials are invalid.",
			wantEscalate: true,
		},
		{
			name:         "escalation noun form",
			output:       "Escalation is warranted here; three attempts have produced no change.",
			wantEscalate: true,
		},
		{
			name:         "negative control mentioning a similar word",
			output:       "The de-escalation of retry pressure is not relevant; just fix the failing test.",
			wantEscalate: false,
		},
		{
			// A substring-only match on the first occurrence would stop at
			// "de-escalation" and miss the real request that follows.
			name:         "embedded near-miss must not mask a later genuine marker",
			output:       "Ignore the de-escalation guidance. I recommend we escalate this card.",
			wantEscalate: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := mediationFromProse(tc.output)
			if got.Escalate != tc.wantEscalate {
				t.Errorf("Escalate = %v, want %v (output %q)", got.Escalate, tc.wantEscalate, tc.output)
			}
			if got.ActionPlan != tc.output {
				t.Errorf("ActionPlan should carry the raw output verbatim when short, got %q", got.ActionPlan)
			}
		})
	}
}

func TestMediationFromProse_TruncatesActionPlan(t *testing.T) {
	long := strings.Repeat("x", 4000)
	got := mediationFromProse(long)
	// Must match the pre-existing fallback exactly: truncate(output, 3000).
	if want := truncate(long, 3000); got.ActionPlan != want {
		t.Errorf("ActionPlan = %d bytes, want the unchanged truncate(output, 3000) result of %d bytes",
			len(got.ActionPlan), len(want))
	}
	if got.Escalate {
		t.Error("filler prose should not escalate")
	}
}

// The escalation heuristic must scan the FULL output, not just the logged
// prefix — mediators typically bury the recommendation after their reasoning.
func TestMediationFromProse_ScansBeyondLogPrefix(t *testing.T) {
	output := strings.Repeat("Reviewing the prior attempts in detail. ", 40) +
		"Given all of the above, I cannot proceed."
	got := mediationFromProse(output)
	if !got.Escalate {
		t.Error("escalation language beyond the first 200 chars should still set Escalate")
	}
}

func newMediationLoop(t *testing.T, responses ...string) *Loop {
	t.Helper()
	return mustNewLoop(t, testClientStubbed(t), llm.NewMockProvider(responses...),
		&git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin"}, testConfig())
}

// Wiring check: the prose fallback inside mediateRework must carry the
// heuristic's verdict, not the zero value.
func TestMediateRework_ProseEscalationReachesResult(t *testing.T) {
	loop := newMediationLoop(t, "I cannot proceed — the card has no reviewable history. Escalate to a human.")

	got, err := loop.mediateRework(context.Background(), &discoverResult{BoardID: "b1", CardID: "c1"}, 2)
	if err != nil {
		t.Fatalf("mediateRework: %v", err)
	}
	if !got.Escalate {
		t.Error("prose escalation should surface as Escalate=true on the mediation result")
	}
}

// Valid JSON must still win outright: prose keywords in the action_plan text
// never override an explicit escalate:false from the model.
func TestMediateRework_ValidJSONOverridesHeuristic(t *testing.T) {
	loop := newMediationLoop(t, `{"action_plan":"Do not escalate; human intervention is unnecessary.","escalate":false}`)

	got, err := loop.mediateRework(context.Background(), &discoverResult{BoardID: "b1", CardID: "c1"}, 2)
	if err != nil {
		t.Fatalf("mediateRework: %v", err)
	}
	if got.Escalate {
		t.Error("decoded JSON escalate=false must win over prose keywords in the action plan")
	}
}
