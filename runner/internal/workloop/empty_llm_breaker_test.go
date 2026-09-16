// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

// Empty-LLM circuit breaker (run B, 2026-06-09 quota outage).
//
// When the provider's quota/credits run out, every `claude -p` returns
// instantly with exit_code!=0 and ZERO tokens in/out. Each such result used
// to be treated as a STAGE failure → fail-path → release → re-reserve, so the
// runner cycled cards forever (the participant add/remove board loop) and the
// call burst tripped the backend's per-key rate limit. The cost circuit
// breaker never fired because quota-exhausted calls cost $0.
//
// An empty model response is an ENVIRONMENT failure, not a card defect:
// after maxConsecutiveEmptyLLM of them the loop must pause reservations
// (emptyLLMHaltDuration), then probe again — self-healing once quota returns.

import (
	"context"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

func emptyFailure() *llm.Result {
	return &llm.Result{ExitCode: 1, Output: "credit balance too low", InputTokens: 0, OutputTokens: 0}
}

func tokenBearingFailure() *llm.Result {
	return &llm.Result{ExitCode: 1, InputTokens: 1200, OutputTokens: 40}
}

func successResult() *llm.Result {
	return &llm.Result{ExitCode: 0, InputTokens: 900, OutputTokens: 800}
}

func TestEmptyLLMBreaker_TripsAfterConsecutiveEmptyFailures(t *testing.T) {
	l := &Loop{}
	ctx := context.Background()

	for i := 0; i < maxConsecutiveEmptyLLM-1; i++ {
		l.recordLLMOutcome(ctx, emptyFailure())
		if l.emptyLLMHalted() {
			t.Fatalf("halted after %d empty failures, want trip only at %d", i+1, maxConsecutiveEmptyLLM)
		}
	}
	l.recordLLMOutcome(ctx, emptyFailure())
	if !l.emptyLLMHalted() {
		t.Fatalf("not halted after %d consecutive empty failures", maxConsecutiveEmptyLLM)
	}
}

func TestEmptyLLMBreaker_TokenBearingFailureResets(t *testing.T) {
	l := &Loop{}
	ctx := context.Background()

	l.recordLLMOutcome(ctx, emptyFailure())
	l.recordLLMOutcome(ctx, emptyFailure())
	// A failure that actually consumed tokens is a REAL stage failure (card
	// defect / model said no) — the provider is alive, so the breaker resets.
	l.recordLLMOutcome(ctx, tokenBearingFailure())
	l.recordLLMOutcome(ctx, emptyFailure())
	l.recordLLMOutcome(ctx, emptyFailure())

	if l.emptyLLMHalted() {
		t.Fatal("halted, but the token-bearing failure should have reset the consecutive counter")
	}
}

func TestEmptyLLMBreaker_SuccessResets(t *testing.T) {
	l := &Loop{}
	ctx := context.Background()

	l.recordLLMOutcome(ctx, emptyFailure())
	l.recordLLMOutcome(ctx, emptyFailure())
	l.recordLLMOutcome(ctx, successResult())
	l.recordLLMOutcome(ctx, emptyFailure())

	if l.emptyLLMHalted() {
		t.Fatal("halted, but the success should have reset the consecutive counter")
	}
}

func TestEmptyLLMBreaker_LocalCancellationDoesNotCount(t *testing.T) {
	l := &Loop{}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()

	// A zero-token failure during shutdown/drain is the runner killing the
	// CLI, not the provider failing — it must not feed the breaker.
	for i := 0; i < maxConsecutiveEmptyLLM+2; i++ {
		l.recordLLMOutcome(cancelled, emptyFailure())
	}
	if l.emptyLLMHalted() {
		t.Fatal("halted on locally-cancelled results")
	}
}

func TestEmptyLLMBreaker_HaltExpiresThenReprobesAndRetrips(t *testing.T) {
	l := &Loop{}
	ctx := context.Background()

	for i := 0; i < maxConsecutiveEmptyLLM; i++ {
		l.recordLLMOutcome(ctx, emptyFailure())
	}
	if !l.emptyLLMHalted() {
		t.Fatal("breaker should be tripped")
	}

	// Force the cooldown into the past: the gate opens (probe allowed).
	l.emptyLLMMu.Lock()
	l.emptyLLMHaltUntil = time.Now().Add(-time.Second)
	l.emptyLLMMu.Unlock()
	if l.emptyLLMHalted() {
		t.Fatal("still halted after the cooldown expired — probe must be allowed")
	}

	// Probe fails empty again → re-trip for another cooldown window.
	l.recordLLMOutcome(ctx, emptyFailure())
	if !l.emptyLLMHalted() {
		t.Fatal("probe failed empty but breaker did not re-trip")
	}

	// Probe succeeds → full reset.
	l.emptyLLMMu.Lock()
	l.emptyLLMHaltUntil = time.Now().Add(-time.Second)
	l.emptyLLMMu.Unlock()
	l.recordLLMOutcome(ctx, successResult())
	if l.emptyLLMHalted() {
		t.Fatal("halted after a successful probe")
	}
	l.recordLLMOutcome(ctx, emptyFailure())
	if l.emptyLLMHalted() {
		t.Fatal("a single empty failure after recovery must not re-trip (counter should have reset)")
	}
}

// spyStrategy records whether the loop ticked it.
type spyStrategy struct{ ticked bool }

func (s *spyStrategy) Name() string                            { return "spy" }
func (s *spyStrategy) Tick(ctx context.Context, l *Loop) error { s.ticked = true; return nil }
func (s *spyStrategy) AllowedTools() []string                  { return nil }

func TestEmptyLLMBreaker_HaltedPollCycleSkipsTick(t *testing.T) {
	server := testAPIServer(t, testServerOptions{})
	mock := llm.NewMockProvider()
	cfg := testConfig()
	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	l := mustNewLoop(t, client, mock, gitMgr, cfg)
	spy := &spyStrategy{}
	l.strategy = spy
	l.scheduler = nil

	ctx := context.Background()
	for i := 0; i < maxConsecutiveEmptyLLM; i++ {
		l.recordLLMOutcome(ctx, emptyFailure())
	}

	shutdown := l.pollCycle(ctx, ctx)
	if shutdown {
		t.Fatal("halted pollCycle must pause, not shut the runner down")
	}
	if spy.ticked {
		t.Fatal("pollCycle ran the tick while the empty-LLM breaker was tripped — this is the reserve→fail→re-reserve loop")
	}
	// The gate sits before the refresh path too: an outage cycle must not
	// spend API budget on prompt/config fetches.
	if !l.lastPromptCacheRefresh.IsZero() {
		t.Fatal("halted pollCycle still refreshed the prompt cache")
	}

	// Cooldown over → the very next cycle proceeds past the gate into the
	// normal refresh→authority→tick path. (The tick itself is asserted via
	// the refresh timestamp rather than the spy because platform authority
	// legitimately replaces unknown-role strategies each live cycle.)
	l.emptyLLMMu.Lock()
	l.emptyLLMHaltUntil = time.Now().Add(-time.Second)
	l.emptyLLMMu.Unlock()
	_ = l.pollCycle(ctx, ctx)
	if l.lastPromptCacheRefresh.IsZero() {
		t.Fatal("pollCycle did not resume the normal cycle after the halt window expired")
	}
}
