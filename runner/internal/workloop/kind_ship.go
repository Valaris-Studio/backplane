// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// lifecycleShip is the canonical end-of-stage step for hero roles. Wraps
// Loop.ship, which moves the card to the target column AND patches PR/branch
// metadata onto the card description (legacy footer + first-class columns).
//
// to_column_type defaults to "review" — the historical hero ship target.
// shipWarnings is empty here; warnings flow through on_failure / branches in
// the lifecycle DSL instead of being collected as a side-channel slice.
func lifecycleShip(ctx context.Context, ws *lifecycle.WalkState, step *valaris.LifecycleStep) (string, string, error) {
	l := loopFromWalk(ws)
	card, err := requireCard(ws, step.Name, step.Kind)
	if err != nil {
		return "", "", err
	}
	target := paramString(step, "to_column_type", "review")
	if err := l.ship(ctx, card, ws.ExecutionID, ws.Branch, card.PRURL, target, nil); err != nil {
		return "", "", err
	}
	// FOLLOWUP-12: ship marks the execution completed inline. Signal to the
	// post-walk cleanup in tickViaLifecycle so it doesn't double-release.
	ws.Set("execution_released", true)
	return "", "", nil
}
