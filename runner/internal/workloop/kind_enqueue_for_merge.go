// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// lifecycleEnqueueForMerge submits the card to the backend merge queue.
// Wraps Client.EnqueueForMerge directly rather than the strategy helper —
// the strategy helper mutates an ActionDef.MoveToColumnType for legacy
// suppression semantics; the lifecycle DSL handles "where to go on failure"
// via explicit Branches instead of action mutation, so we use the lower-level
// call.
//
// On enqueue failure: returns the error to the walker. Operators wire
// branches:{"enqueue_failed":...} on a wrapping step or rely on the legacy
// stage-level on_failure path (out of scope for A.2). The strategy helper's
// "swallow + clear move_to" behavior is not preserved here on purpose: the
// DSL's branch routing is the new mechanism for that intent.
func lifecycleEnqueueForMerge(ctx context.Context, ws *lifecycle.WalkState, step *valaris.LifecycleStep) (string, string, error) {
	l := loopFromWalk(ws)
	card, err := requireCard(ws, step.Name, step.Kind)
	if err != nil {
		return "", "", err
	}
	if card.PRURL == "" {
		return "", "", &configError{msg: "enqueue_for_merge requires a card with a PR URL"}
	}
	if err := l.client.EnqueueForMerge(
		ctx,
		l.cfg.Valaris.WorkspaceSlug,
		card.CardID,
		card.GitRepoID,
		card.PRURL,
		card.PRBranch,
		card.IntegrationBranch,
	); err != nil {
		return "", "", err
	}
	return "", "", nil
}
