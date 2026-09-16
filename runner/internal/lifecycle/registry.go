// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package lifecycle

import (
	"context"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// Handler executes a single lifecycle step. Return values:
//
//   - decision: routing key for the next step. Non-empty only for kinds whose
//     KindSchema.ProducesDecision is true (llm, sensor, branch); otherwise the
//     walker treats a non-empty return as a contract violation (the closed set
//     is the platform's API surface).
//   - nextOverride: rarely used; lets a handler force the next step name in
//     situations the static step.Next/step.Branches map can't express. Empty
//     means "use the default routing (Branches[decision] or Next or terminal)".
//   - err: fail-fast walker termination. Handlers should NOT log+continue; the
//     walker's caller is responsible for failure-mode bookkeeping.
type Handler func(ctx context.Context, ws *WalkState, step *valaris.LifecycleStep) (decision string, nextOverride string, err error)

// Handlers binds kind names to their executor. Populated by per-kind init()
// blocks so each kind handler lives in its own file. The walker looks up the
// handler by step.Kind; an unknown kind is a walker-level error.
//
// Mutating this map after init() is unsafe — handlers are looked up under no
// lock. Tests that need to override a handler should swap the entire map via
// a helper that captures and restores it (see walker_test.go).
var Handlers = map[string]Handler{}
