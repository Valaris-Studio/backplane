// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"strings"
	"testing"
)

// On resume of a budget-suspended card, the implement prompt must carry a resume
// brief telling the agent to continue from the WIP commit on the branch rather
// than re-implement from scratch. Absent the suspend state, the prompt is
// unchanged (no spurious resume block).

// The resume brief is injected OUTSIDE the prompt template (so it survives the
// backend-cached prod template that wouldn't reference {{.ResumeBrief}}).
func TestPrependResumeBrief_WrapsPrompt_WhenSet(t *testing.T) {
	base := "You are an autonomous coding agent.\nSTEPS: ..."
	brief := "Pass 2: prior pass committed a WIP checkpoint. Continue from branch HEAD."
	out := prependResumeBrief(base, brief)
	if !strings.Contains(out, "RESUME") {
		t.Error("prepended prompt must include a RESUME section when brief is set")
	}
	if !strings.Contains(out, "branch HEAD") {
		t.Errorf("prepended prompt must include the resume brief text; got:\n%s", out)
	}
	if !strings.Contains(out, base) {
		t.Error("prepended prompt must still contain the original prompt body")
	}
	// Resume context must come BEFORE the body so the agent reads it first.
	if strings.Index(out, "RESUME") > strings.Index(out, base) {
		t.Error("resume section must precede the original prompt body")
	}
}

func TestPrependResumeBrief_NoOp_WhenEmpty(t *testing.T) {
	base := "You are an autonomous coding agent."
	if out := prependResumeBrief(base, ""); out != base {
		t.Errorf("empty brief must be a no-op; got:\n%s", out)
	}
}

// buildResumeBrief turns the card's suspend labels into the brief text. Empty
// when the card is not budget-suspended (a fresh, non-resumed pickup).
func TestBuildResumeBrief(t *testing.T) {
	if got := buildResumeBrief(nil); got != "" {
		t.Errorf("no labels → empty brief; got %q", got)
	}
	if got := buildResumeBrief([]string{"planned"}); got != "" {
		t.Errorf("non-suspend labels → empty brief; got %q", got)
	}
	got := buildResumeBrief([]string{budgetSuspendedLabel, "budget-pass-2"})
	if got == "" {
		t.Fatal("suspended card → non-empty resume brief")
	}
	if !strings.Contains(got, "branch HEAD") {
		t.Errorf("resume brief must instruct continuing from branch HEAD; got %q", got)
	}
	// Prior pass was 2, so this resume is pass 3 (the upcoming pass).
	if !strings.Contains(got, "pass 3") {
		t.Errorf("resume brief should mention the upcoming pass number (3); got %q", got)
	}
}
