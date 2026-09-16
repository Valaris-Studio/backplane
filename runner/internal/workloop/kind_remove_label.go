// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// lifecycleRemoveLabel removes a label from the card. Wraps the strategy
// helper that preserves order and is a no-op when the label is absent.
func lifecycleRemoveLabel(ctx context.Context, ws *lifecycle.WalkState, step *valaris.LifecycleStep) (string, string, error) {
	l := loopFromWalk(ws)
	s := strategyFromWalk(ws)
	card, err := requireCard(ws, step.Name, step.Kind)
	if err != nil {
		return "", "", err
	}
	label := paramString(step, "label", "")
	if label == "" {
		return "", "", &configError{msg: "remove_label requires param 'label'"}
	}
	s.removeLabel(ctx, l, card, label)
	return "", "", nil
}
