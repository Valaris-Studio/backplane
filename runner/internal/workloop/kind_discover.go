// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// lifecycleDiscover wraps DataDrivenStrategy.discoverWithConfig. Step params
// are intentionally ignored at execution time — the strategy's StageConfig
// already carries Discover/Filters/Preconditions, and re-deriving them from
// step.Params per tick would duplicate validation. Future lanes that want to
// drive discover purely from step.Params can switch the helper to read a
// stage built from params; for A.2 we preserve back-compat.
//
// On no-card: returns lifecycle.ErrNoWork so the walker exits cleanly and the
// tickViaLifecycle caller runs the same idle-backoff bookkeeping the legacy
// Tick path does. On card found: populates WalkState.Card and returns nil.
//
// Model dispatch (2026-05-25 regression fix): like the legacy Tick path
// (strategy_generic.go:74), stash the backend-declared per-stage LLM so
// llmOpts prefers it over the runner's yaml model. Without this, lifecycle
// stages fell back to yaml (sonnet) and logged the "backend did not declare a
// model" WARN even when /next-assignment returned a model. tickViaLifecycle
// clears the stash on every tick exit so the heartbeat goroutine's budget
// bookkeeping never reads a stale per-card model.
func lifecycleDiscover(ctx context.Context, ws *lifecycle.WalkState, _ *valaris.LifecycleStep) (string, string, error) {
	l := loopFromWalk(ws)
	s := strategyFromWalk(ws)

	card, err := s.discoverWithConfig(ctx, l)
	if err != nil {
		return "", "", err
	}
	if card == nil || card.CardID == "" {
		return "", "", lifecycle.ErrNoWork
	}
	ws.Card = card
	l.SetAssignmentLLM(card.AssignmentLLM)
	l.SetCardBudgetOverride(card.BudgetUSDOverride)

	// Rebind the walk logger so every downstream stage handler that logs via
	// walkLogger automatically carries card identity. The walker path was
	// otherwise silent on which card it took — card id appeared reliably only
	// on failure.
	ws.Logger = walkLogger(ws).With("card_id", card.CardID, "title", truncate(card.Title, 60))
	walkLogger(ws).Info("reserved card", "card_id", card.CardID, "title", card.Title, "role", s.config.Role)
	return "", "", nil
}
