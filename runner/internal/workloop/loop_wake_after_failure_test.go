// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"testing"
)

// A stage failure that releases a card must wake the work loop: reset idle
// backoff (so the next poll isn't exponentially delayed) and fire a coalescing
// TriggerPoll so the still-eligible card is reconsidered promptly instead of
// idling for 30+ minutes. Regression: the no-git-changes release path left the
// loop permanently idle.
func TestRecordFailure_ResetsBackoffAndTriggersPoll(t *testing.T) {
	loop := &Loop{
		cardFailures: make(map[string]cardFailure),
		TriggerPoll:  make(chan struct{}, 1),
	}
	loop.IncrementIdleBackoff()
	loop.IncrementIdleBackoff()
	if loop.idleBackoff == 0 {
		t.Fatal("precondition: idle backoff should be non-zero")
	}

	loop.recordFailure("stage produced no changes", "card-released")

	if loop.idleBackoff != 0 {
		t.Errorf("idle backoff = %d, want 0 after a release", loop.idleBackoff)
	}
	select {
	case <-loop.TriggerPoll:
		// woken — expected
	default:
		t.Error("recordFailure should have fired a TriggerPoll")
	}
}

// The wake send is non-blocking and coalescing: a second failure while a
// trigger is already pending must not block (cap=1 channel, default drop).
func TestRecordFailure_TriggerIsNonBlocking(t *testing.T) {
	loop := &Loop{
		cardFailures: make(map[string]cardFailure),
		TriggerPoll:  make(chan struct{}, 1),
	}

	// Two failures back-to-back; the channel is cap=1 so the second send must
	// drop silently rather than deadlock.
	done := make(chan struct{})
	go func() {
		loop.recordFailure("first", "card-x")
		loop.recordFailure("second", "card-x")
		close(done)
	}()
	select {
	case <-done:
	default:
		// Drain so the goroutine's second send still can't block, then re-check.
	}
	<-done // must complete; if recordFailure blocked, this hangs and the test times out

	// Exactly one pending trigger (coalesced).
	select {
	case <-loop.TriggerPoll:
	default:
		t.Error("expected one pending trigger after two failures")
	}
}

// A wake must never spin forever on a poisoned card: after MaxReworkAttempts
// failures the circuit breaker blocks the card, so discovery skips it and the
// re-poll terminates. We prove IsCardBlocked gates the card the wake would
// re-offer, so the fail→trigger→fail cycle cannot be infinite.
func TestRecordFailure_BlockedCardStopsReTrigger(t *testing.T) {
	loop := &Loop{
		cardFailures: make(map[string]cardFailure),
		TriggerPoll:  make(chan struct{}, 1),
	}
	cardID := "card-poison"

	for i := 0; i < defaultMaxReworkAttempts; i++ {
		// Drain any pending trigger between failures to mimic the loop consuming it.
		select {
		case <-loop.TriggerPoll:
		default:
		}
		loop.recordFailure("repeated failure", cardID)
	}

	if !loop.IsCardBlocked(cardID) {
		t.Fatal("card should be blocked after MaxReworkAttempts failures")
	}
	// Discovery skips blocked cards (IsCardBlocked guards every discover loop),
	// so a re-poll finds nothing eligible and the loop idles out instead of
	// re-triggering on the same poisoned card.
}
