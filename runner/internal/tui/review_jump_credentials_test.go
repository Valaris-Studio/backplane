// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import "testing"

// A credential edited from the review screen must be revalidated before the
// review claims it: a jumped commit goes through the connect step like any
// other commit, and only a SUCCESSFUL connect returns to review.
func TestReviewStep_JumpedCredentialsCommit_ReconnectsThenReturnsToReview(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	w := atReview(t, deps)

	// 8, not 7: the loop-only "on loop off" row (card 5ffe97cf) sits above.
	w = drive(w, key("8"))
	if w.Step() != StepCredentials {
		t.Fatalf("8 on review should jump to the credentials step, got %v", w.Step())
	}

	w = drive(w, key("enter"))
	if w.Step() != StepConnect {
		t.Fatalf("a jumped credentials commit must revalidate through connect, got %v", w.Step())
	}

	w = drive(w, connectedMsg{identity: mustConnect(t, deps)})
	if w.Step() != StepReview {
		t.Fatalf("connect success after a review jump must return to review, not %v", w.Step())
	}

	w = drive(w, key("esc"))
	if w.Step() != StepProvider {
		t.Errorf("the jump must be spent by the connect round-trip; esc from review should walk back, got %v", w.Step())
	}
}
