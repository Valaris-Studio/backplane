// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// lifecycleMoveCard moves the WalkState card to the column with column_type
// matching step.Params.to_column_type. Wraps Loop.moveCardToColumnType — the
// same helper applyActionFlags uses, so column resolution semantics (board
// has no column of that type → error) match the legacy path.
func lifecycleMoveCard(ctx context.Context, ws *lifecycle.WalkState, step *valaris.LifecycleStep) (string, string, error) {
	l := loopFromWalk(ws)
	card, err := requireCard(ws, step.Name, step.Kind)
	if err != nil {
		return "", "", err
	}
	target := paramString(step, "to_column_type", "")
	if target == "" {
		return "", "", &configError{msg: "move_card requires param 'to_column_type'"}
	}
	// A force-blocked card must stay de-reserved: a configured fail-move (e.g.
	// on_failure → active) running after the breaker engaged would re-assert
	// the card into a discoverable column and undo the park — in production
	// this RACED the force-block every cycle. Only an explicit move to the
	// blocked parking bay is allowed through.
	if l.IsCardBlocked(card.CardID) && target != "blocked" {
		walkLogger(ws).Warn("move_card skipped: card is force-blocked and target would make it discoverable again",
			"card_id", card.CardID, "to_column_type", target)
		return "", "", nil
	}
	if err := l.moveCardToColumnType(ctx, l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID, target); err != nil {
		return "", "", err
	}
	return "", "", nil
}
