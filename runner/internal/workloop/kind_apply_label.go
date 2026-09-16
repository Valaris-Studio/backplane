// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// lifecycleApplyLabel adds a label to the card. Wraps DataDrivenStrategy.addLabel
// so the existing get-then-update idempotency (skip when present) applies.
//
// addLabel swallows REST errors with a slog.Warn; that's preserved here. The
// trade-off is documented on the underlying helper: a label-add backend error
// shouldn't block the current tick, since labels are bookkeeping. If a
// lifecycle wants hard-fail semantics it would compose mcp_call with
// update_card instead.
func lifecycleApplyLabel(ctx context.Context, ws *lifecycle.WalkState, step *valaris.LifecycleStep) (string, string, error) {
	l := loopFromWalk(ws)
	s := strategyFromWalk(ws)
	card, err := requireCard(ws, step.Name, step.Kind)
	if err != nil {
		return "", "", err
	}
	label := paramString(step, "label", "")
	if label == "" {
		return "", "", &configError{msg: "apply_label requires param 'label'"}
	}
	s.addLabel(ctx, l, card, label)
	return "", "", nil
}
