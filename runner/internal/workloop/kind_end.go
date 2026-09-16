// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// lifecycleEnd is a no-op terminal. It exists so a non-terminal kind that
// should stop the walk (e.g. apply_label at the end of a failure subtree)
// can point at an explicit terminator instead of being terminal-by-default.
func lifecycleEnd(ctx context.Context, ws *lifecycle.WalkState, step *valaris.LifecycleStep) (string, string, error) {
	return "", "", nil
}
