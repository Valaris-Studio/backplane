// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// Card 102dc48e — terminal transitions belong to the HARNESS, not the LLM.
// Loops #1, #2 and a field run (2026-08-09) each detected completion, reported it in the
// structured `outcome` field, and kept spawning sessions anyway: the runner
// parsed objective_complete, formatted it into the log summary, and discarded
// it. These tests pin the outcome→transition table the runner now owns.

// TestLoopMode_ObjectiveComplete_DisablesLoop proves a successful session
// reporting objective_complete disables the board loop itself, with a reason
// derived from the session's own summary, and runs no further iterations.
func TestLoopMode_ObjectiveComplete_DisablesLoop(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 25 // wide: only the outcome may stop this loop
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := llm.NewMockProvider("all cards done")
	provider.Caps = llm.Capabilities{StructuredOutput: true}
	provider.QueueStructured([]byte(`{"outcome":"objective_complete","summary":"all 8 loop-3 cards are Done"}`))
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 1 {
		t.Errorf("provider called %d times, want 1 — objective_complete must end the loop immediately", provider.CallCount())
	}
	if srv.patchCount() != 1 {
		t.Fatalf("PATCH .../loop/state called %d times, want 1", srv.patchCount())
	}
	patch := srv.lastPatch()
	if enabled, _ := patch["enabled"].(bool); enabled {
		t.Errorf("patch enabled = true, want false")
	}
	reason, _ := patch["reason"].(string)
	if !strings.Contains(reason, "run complete") {
		t.Errorf("reason = %q, want it to name the run as complete", reason)
	}
	if !strings.Contains(reason, "all 8 loop-3 cards are Done") {
		t.Errorf("reason = %q, want the session's own summary carried through — a rail-shaped reason is the defect this card fixes", reason)
	}
}

// TestLoopMode_ObjectiveCompleteOnFailedIteration_DoesNotDisable proves the
// hallucination guard: a session whose iteration FAILED (provider error,
// timeout, empty response) cannot kill the run no matter what its structured
// payload claims. Only a successful session's verdict is load-bearing.
func TestLoopMode_ObjectiveCompleteOnFailedIteration_DoesNotDisable(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 2 // the rail, not the outcome, must be what stops this
	cfg.MaxConsecutiveFailures = 10
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := &scriptedProvider{results: []scriptedResult{
		// Exit code 1 with a completion claim attached: failed iteration.
		{result: &llm.Result{
			Output:           "done?",
			OutputTokens:     5,
			ExitCode:         1,
			StructuredOutput: []byte(`{"outcome":"objective_complete","summary":"I think we are finished"}`),
		}},
		{result: &llm.Result{Output: "worked", OutputTokens: 5}},
	}}
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.callCount() != 2 {
		t.Errorf("provider called %d times, want 2 — a failed iteration's completion claim must not stop the loop", provider.callCount())
	}
	reason, _ := srv.lastPatch()["reason"].(string)
	if !strings.Contains(reason, "max_iterations") {
		t.Errorf("stop reason = %q, want the max_iterations rail — the failed session's claim must have been ignored", reason)
	}
}

// TestLoopMode_BlockedOnHumanThreshold_DisablesAfterN proves repeated
// blocked_on_human stops the loop with a truthful reason naming the blocker
// instead of burning sessions forever. Below the threshold the loop parks per
// starvation_policy and keeps going.
func TestLoopMode_BlockedOnHumanThreshold_DisablesAfterN(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 25
	cfg.MaxBlockedOnHuman = 3
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := llm.NewMockProvider("waiting on a human", "waiting on a human", "waiting on a human")
	provider.Caps = llm.Capabilities{StructuredOutput: true}
	provider.QueueStructured([]byte(`{"outcome":"blocked_on_human","summary":"needs an operator to approve the migration"}`))
	provider.QueueStructured([]byte(`{"outcome":"blocked_on_human","summary":"needs an operator to approve the migration"}`))
	provider.QueueStructured([]byte(`{"outcome":"blocked_on_human","summary":"needs an operator to approve the migration"}`))
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 3 {
		t.Errorf("provider called %d times, want 3 — the 3rd consecutive blocked_on_human is the one that stops it", provider.CallCount())
	}
	if srv.patchCount() != 1 {
		t.Fatalf("PATCH .../loop/state called %d times, want 1", srv.patchCount())
	}
	reason, _ := srv.lastPatch()["reason"].(string)
	if !strings.Contains(reason, "blocked_on_human") {
		t.Errorf("reason = %q, want it to name the blocked_on_human streak", reason)
	}
	if !strings.Contains(reason, "needs an operator to approve the migration") {
		t.Errorf("reason = %q, want the blocker named from the session summary", reason)
	}
}

// TestLoopMode_BlockedOnHumanStreakBroken_KeepsRunning proves the streak
// counter resets: two blocked iterations either side of a productive one never
// reach a threshold of 3.
func TestLoopMode_BlockedOnHumanStreakBroken_KeepsRunning(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 4
	cfg.MaxBlockedOnHuman = 3
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := llm.NewMockProvider("blocked", "worked", "blocked", "blocked")
	provider.Caps = llm.Capabilities{StructuredOutput: true}
	provider.QueueStructured([]byte(`{"outcome":"blocked_on_human","summary":"awaiting review"}`))
	provider.QueueStructured([]byte(`{"outcome":"worked","summary":"shipped a card"}`))
	provider.QueueStructured([]byte(`{"outcome":"blocked_on_human","summary":"awaiting review"}`))
	provider.QueueStructured([]byte(`{"outcome":"blocked_on_human","summary":"awaiting review"}`))
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 4 {
		t.Errorf("provider called %d times, want 4 — a productive iteration resets the blocked streak", provider.CallCount())
	}
	reason, _ := srv.lastPatch()["reason"].(string)
	if !strings.Contains(reason, "max_iterations") {
		t.Errorf("stop reason = %q, want the max_iterations rail", reason)
	}
}

// TestLoopMode_NothingReadyStillParks pins the pre-existing behavior this card
// must not disturb: nothing_ready parks, it never disables.
func TestLoopMode_NothingReadyStillParks(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 2
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := llm.NewMockProvider("nothing to do", "nothing to do")
	provider.Caps = llm.Capabilities{StructuredOutput: true}
	provider.QueueStructured([]byte(`{"outcome":"nothing_ready","summary":"no workable cards"}`))
	provider.QueueStructured([]byte(`{"outcome":"nothing_ready","summary":"no workable cards"}`))
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 2 {
		t.Errorf("provider called %d times, want 2 — nothing_ready parks, it does not disable", provider.CallCount())
	}
	reason, _ := srv.lastPatch()["reason"].(string)
	if !strings.Contains(reason, "max_iterations") {
		t.Errorf("stop reason = %q, want the max_iterations rail — nothing_ready must not disable", reason)
	}
}

// TestLoopMode_MaxBlockedOnHumanZero_NeverDisables proves the knob is opt-out:
// a zero/absent threshold (a pre-rollout backend serving no such field) leaves
// blocked_on_human on the pre-existing park-only path.
func TestLoopMode_MaxBlockedOnHumanZero_NeverDisables(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 3
	cfg.MaxBlockedOnHuman = 0
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := llm.NewMockProvider("blocked", "blocked", "blocked")
	provider.Caps = llm.Capabilities{StructuredOutput: true}
	for range 3 {
		provider.QueueStructured([]byte(`{"outcome":"blocked_on_human","summary":"awaiting review"}`))
	}
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 3 {
		t.Errorf("provider called %d times, want 3 — threshold 0 disables the streak rail entirely", provider.CallCount())
	}
	reason, _ := srv.lastPatch()["reason"].(string)
	if !strings.Contains(reason, "max_iterations") {
		t.Errorf("stop reason = %q, want the max_iterations rail", reason)
	}
}
