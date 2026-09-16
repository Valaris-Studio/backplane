// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// Card d223a0ec — a curated run's completion condition is a QUERY, not a
// prose instruction the model has to remember to run. With completion_query
// set, the runner answers "is this run over?" from the cards-search API
// BEFORE it pays for a session, and uses the same query to verify a session's
// objective_complete claim. Absent, every behavior below is unchanged.

const cardsSearchOneCard = `[{"id":"c1","title":"still open"}]`

// TestLoopMode_CompletionQueryZero_DisablesBeforeSpawningSession is the whole
// point of the card: zero matching cards means the run is over, and learning
// that must not cost an LLM session.
func TestLoopMode_CompletionQueryZero_DisablesBeforeSpawningSession(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.CompletionQuery = &valaris.LoopCompletionQuery{Label: "loop-3", ExcludeColumnType: "done"}
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	srv.searchBodies = []string{`[]`}
	provider := llm.NewMockProvider("should never run")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 0 {
		t.Errorf("provider called %d times, want 0 — a finished run must cost no session at all", provider.CallCount())
	}
	if srv.executionStartCount() != 0 {
		t.Errorf("started %d executions, want 0 — no session, no execution row", srv.executionStartCount())
	}
	if srv.patchCount() != 1 {
		t.Fatalf("PATCH .../loop/state called %d times, want 1", srv.patchCount())
	}
	patch := srv.lastPatch()
	if enabled, _ := patch["enabled"].(bool); enabled {
		t.Errorf("patch enabled = true, want false")
	}
	reason, _ := patch["reason"].(string)
	if !strings.Contains(reason, "run complete") || !strings.Contains(reason, "loop-3") {
		t.Errorf("reason = %q, want it to name the run complete and the label it queried", reason)
	}
	if got := srv.searchQueryAt(0); !strings.Contains(got, "label=loop-3") ||
		!strings.Contains(got, "exclude_column_type=done") {
		t.Errorf("search query = %q, want the configured label + exclusion — a wider search would end runs early", got)
	}
}

// TestLoopMode_CompletionQueryNonZero_RunsIteration proves work remaining is
// business as usual: the pre-flight is a gate, not a throttle.
func TestLoopMode_CompletionQueryNonZero_RunsIteration(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 1
	cfg.CompletionQuery = &valaris.LoopCompletionQuery{Label: "loop-3", ExcludeColumnType: "done"}
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	srv.searchBodies = []string{cardsSearchOneCard}
	provider := llm.NewMockProvider("worked a card")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 1 {
		t.Errorf("provider called %d times, want 1 — cards remain, the loop must work", provider.CallCount())
	}
	reason, _ := srv.lastPatch()["reason"].(string)
	if !strings.Contains(reason, "max_iterations") {
		t.Errorf("stop reason = %q, want the max_iterations rail", reason)
	}
}

// TestLoopMode_ObjectiveCompleteUnverified_CountsAsFailure is the guard the
// card asks for: with a completion_query configured, the QUERY is the
// authority. A session claiming completion while cards remain is wrong, and a
// wrong session is a failed iteration — not a stop.
func TestLoopMode_ObjectiveCompleteUnverified_CountsAsFailure(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 25
	cfg.MaxConsecutiveFailures = 2
	cfg.CompletionQuery = &valaris.LoopCompletionQuery{Label: "loop-3", ExcludeColumnType: "done"}
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	srv.searchBodies = []string{cardsSearchOneCard} // always work remaining
	provider := llm.NewMockProvider("we are done")
	provider.Caps = llm.Capabilities{StructuredOutput: true}
	provider.QueueStructured([]byte(`{"outcome":"objective_complete","summary":"all cards done"}`))
	provider.QueueStructured([]byte(`{"outcome":"objective_complete","summary":"all cards done"}`))
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 2 {
		t.Errorf("provider called %d times, want 2 — an unverified completion claim must not stop the loop", provider.CallCount())
	}
	reason, _ := srv.lastPatch()["reason"].(string)
	if !strings.Contains(reason, "consecutive failed") {
		t.Errorf("stop reason = %q, want the failure breaker — the claim was refuted by the query, so the iteration failed", reason)
	}
}

// TestLoopMode_ObjectiveCompleteVerified_Disables proves verification is a
// check, not a veto: when the query agrees, the session's own summary still
// carries into the stop reason (card 102dc48e's contract).
func TestLoopMode_ObjectiveCompleteVerified_Disables(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 25
	cfg.CompletionQuery = &valaris.LoopCompletionQuery{Label: "loop-3", ExcludeColumnType: "done"}
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	// Pre-flight sees one card left; the session closes it, so the verify
	// search that follows finds none.
	srv.searchBodies = []string{cardsSearchOneCard, `[]`}
	provider := llm.NewMockProvider("closed the last card")
	provider.Caps = llm.Capabilities{StructuredOutput: true}
	provider.QueueStructured([]byte(`{"outcome":"objective_complete","summary":"all 8 loop-3 cards are Done"}`))
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 1 {
		t.Errorf("provider called %d times, want 1", provider.CallCount())
	}
	reason, _ := srv.lastPatch()["reason"].(string)
	if !strings.Contains(reason, "all 8 loop-3 cards are Done") {
		t.Errorf("reason = %q, want the verified session's own summary", reason)
	}
}

// TestLoopMode_CompletionQueryUnset_NeverSearches pins the opt-in: a board
// without the field must behave exactly as it did before this card, including
// trusting objective_complete outright.
func TestLoopMode_CompletionQueryUnset_NeverSearches(t *testing.T) {
	cfg := baseLoopConfig()
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	provider := llm.NewMockProvider("done")
	provider.Caps = llm.Capabilities{StructuredOutput: true}
	provider.QueueStructured([]byte(`{"outcome":"objective_complete","summary":"finished"}`))
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if srv.searchCallCount() != 0 {
		t.Errorf("searched %d times, want 0 — the feature is opt-in", srv.searchCallCount())
	}
	if provider.CallCount() != 1 {
		t.Errorf("provider called %d times, want 1", provider.CallCount())
	}
	reason, _ := srv.lastPatch()["reason"].(string)
	if !strings.Contains(reason, "finished") {
		t.Errorf("reason = %q, want the unverified claim honored when no query is configured", reason)
	}
}

// TestLoopMode_CompletionQueryProbeFails_RunsAnyway: the probe fails OPEN,
// exactly like the readiness probe. A search outage must never end a run —
// stopping is the irreversible direction.
func TestLoopMode_CompletionQueryProbeFails_RunsAnyway(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 1
	cfg.CompletionQuery = &valaris.LoopCompletionQuery{Label: "loop-3", ExcludeColumnType: "done"}
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	srv.search500 = true
	provider := llm.NewMockProvider("worked a card")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 1 {
		t.Errorf("provider called %d times, want 1 — a probe outage must not stop the run", provider.CallCount())
	}
	reason, _ := srv.lastPatch()["reason"].(string)
	if strings.Contains(reason, "run complete") {
		t.Errorf("stop reason = %q, want anything but a completion claim built on a failed probe", reason)
	}
}

// TestLoopMode_ObjectiveCompleteVerifyFails_DoesNotDisable: same fail-open
// posture on the verify path, but the safe direction is the opposite one —
// an unverifiable claim must not be honored, so the iteration counts failed.
func TestLoopMode_ObjectiveCompleteVerifyFails_DoesNotDisable(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 2
	cfg.MaxConsecutiveFailures = 10
	cfg.CompletionQuery = &valaris.LoopCompletionQuery{Label: "loop-3", ExcludeColumnType: "done"}
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	// Every search 500s, which exercises BOTH postures at once: the pre-flight
	// fails open (the iteration runs) and the verify fails closed (the
	// completion claim is not honored).
	srv.search500 = true
	provider := llm.NewMockProvider("done")
	provider.Caps = llm.Capabilities{StructuredOutput: true}
	provider.QueueStructured([]byte(`{"outcome":"objective_complete","summary":"finished"}`))
	provider.QueueStructured([]byte(`{"outcome":"worked","summary":"kept going"}`))
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 2 {
		t.Errorf("provider called %d times, want 2 — the loop continues to its rail", provider.CallCount())
	}
	reason, _ := srv.lastPatch()["reason"].(string)
	if !strings.Contains(reason, "max_iterations") {
		t.Errorf("stop reason = %q, want the max_iterations rail", reason)
	}
}
