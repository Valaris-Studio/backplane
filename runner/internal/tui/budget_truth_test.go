// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"strings"
	"testing"
)

func TestBudgetTruthWizardDisclosesAdvisorySettingAndEpochReset(t *testing.T) {
	w := atLoopProviderFor(t, pinnedLoopBoard())
	view := strings.ToLower(stripANSI(w.View()))
	for _, want := range []string{"advisory", "restart", "re-enabl"} {
		if !strings.Contains(view, want) {
			t.Errorf("budget setup omits %q disclosure:\n%s", want, view)
		}
	}
}

func TestBudgetTruthUnsetSessionSettingIsNotAZeroDollarCap(t *testing.T) {
	for _, board := range []BoardChoice{{}, pinnedLoopBoard()} {
		view := boardBudgetSummary(board, 0)
		if !strings.Contains(view, "Session setting unset") || strings.Contains(view, "Session setting $0.00") {
			t.Errorf("unset session setting presented as zero dollars: %s", view)
		}
	}
}
