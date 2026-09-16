// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"errors"
	"fmt"
	"testing"
)

// Cluster I — budget-cutoff classifier. A per-pass budget cutoff funnels into the
// generic FAILURE path today (wipe branch + retry), re-burning the full budget
// against the same wall (incident M7-03). classifyBudgetSuspend distinguishes a
// budget cutoff from an ordinary error so the caller can checkpoint+resume instead.
//
// Signal: the implement step errored AND the implement-pass cost reached the
// threshold fraction of the effective budget AND there is work worth saving.
// Robust to whatever exit_code the CLI returns on hitting --max-budget-usd.

func TestClassifyBudgetSuspend(t *testing.T) {
	cases := []struct {
		name      string
		costDelta float64
		budget    float64
		threshold float64
		haveWork  bool
		want      bool
	}{
		{"near budget with work", 5.5, 6.0, 0.9, true, true},
		{"at budget with work", 6.0, 6.0, 0.9, true, true},
		{"over budget with work", 7.0, 6.0, 0.9, true, true},
		{"near budget but empty tree", 5.5, 6.0, 0.9, false, false},
		{"low cost (genuine error, not budget)", 1.0, 6.0, 0.9, true, false},
		{"just below threshold", 5.39, 6.0, 0.9, true, false},
		{"no budget configured", 5.5, 0.0, 0.9, true, false},
		{"zero threshold disables (defensive)", 5.5, 6.0, 0.0, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyBudgetSuspend(tc.costDelta, tc.budget, tc.threshold, tc.haveWork)
			if got != tc.want {
				t.Errorf("classifyBudgetSuspend(%v,%v,%v,%v)=%v want %v",
					tc.costDelta, tc.budget, tc.threshold, tc.haveWork, got, tc.want)
			}
		})
	}
}

// The sentinel must survive the existing `return nil, err` unwrap chain
// (implement → executeLLM → walker) so the catch site recovers it via errors.As
// without any signature churn.
func TestBudgetSuspendError_SurvivesWrapping(t *testing.T) {
	cause := errors.New("claude exited with code 1")
	be := &budgetSuspendError{costDelta: 5.5, budget: 6.0, cause: cause}

	// Simulate the wrap chain: executeLLM returns the error verbatim, a higher
	// layer wraps with %w.
	wrapped := fmt.Errorf("implement: %w", be)

	var got *budgetSuspendError
	if !errors.As(wrapped, &got) {
		t.Fatal("errors.As must recover budgetSuspendError through %w wrapping")
	}
	if got.costDelta != 5.5 || got.budget != 6.0 {
		t.Errorf("recovered fields wrong: %+v", got)
	}
	if !errors.Is(wrapped, cause) {
		t.Error("Unwrap must expose the underlying cause for errors.Is")
	}
}
