// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package lifecycle

import (
	"context"
	"log/slog"
)

// WalkState carries the mutable context threaded through every lifecycle step
// of a single tick. Handlers read what they need (Card, RepoDir, …) and write
// what they produce (LastDecision, Variables[k] = v, the LLM/sensor outputs).
//
// The walker owns one WalkState per Walk() call. Concurrent ticks each get
// their own; the struct is not goroutine-safe.
//
// Card / ExecutionID / RepoDir / Branch all start as the zero value. discover/
// claim/git_setup populate them in the canonical order; later handlers depend
// on those fields being set. The walker does not enforce ordering — bad
// lifecycles (e.g. llm before discover) will see empty Card and behave like
// the legacy path would have.
type WalkState struct {
	// Loop is an opaque pointer the bridge package uses to reach Loop helpers.
	// Typed as any here to keep this package free of workloop imports (which
	// would be a cycle: workloop imports lifecycle for the walker, lifecycle
	// can't import workloop). The bridge functions in workloop type-assert.
	Loop any

	// Strategy is similarly opaque; bridge functions assert to *DataDrivenStrategy
	// so handlers can reuse helpers like addLabel/removeLabel that already live
	// on the strategy receiver.
	Strategy any

	// Sensors registry, also opaque to dodge import cycles. Bridge asserts.
	Sensors any

	// Card holds the discovered card. Typed as any to avoid pulling workloop's
	// private *discoverResult into this package (which would force a cycle).
	// The bridge functions in workloop type-assert to *discoverResult.
	Card        any
	ExecutionID string // populated by claim
	RepoDir     string // populated by git_setup
	Branch      string // populated by git_setup (when create_branch)

	// LastDecision is the most recent non-empty decision string emitted by a
	// kind whose produces_decision flag is true. Routing reads this; handlers
	// for decision-producing kinds write it via the walker return value, not
	// directly.
	LastDecision string

	// LLMResult is the latest llm-kind output, stored under an `any` to avoid
	// importing workloop here. Bridge code casts.
	LLMResult any

	// LLMRawOutput is the verbatim LLM stdout produced by the most recent llm
	// step. Downstream consumers (terminal create_note body_from="raw",
	// mcp_call(create_note) resolving $llm_output) read it directly without
	// going through the parsed reviewResult envelope. Empty when no llm step
	// has run yet — handlers treat the empty body as an error rather than a
	// silent skip.
	LLMRawOutput string

	// SensorResult is the latest sensor-kind output. Same any-typing reason.
	SensorResult any

	// Variables is the per-walk key/value scratchpad. branch and mcp_call
	// handlers read/write this; other handlers use it for cross-step state
	// (e.g. enqueue_for_merge wants the PR URL produced by git_setup → ship).
	Variables map[string]any

	// StartWorkBudget, when set, is called once by the walker at the boundary
	// between the setup steps (discover/claim/git_setup) and the first step
	// that does actual work. It returns the context the work phase runs on —
	// the bridge derives a fresh card budget there so setup's wall-clock cost
	// is not charged to the card. Nil means "no split": the walk runs entirely
	// on the context handed to Walk.
	StartWorkBudget func(ctx context.Context) (context.Context, context.CancelFunc)

	Logger *slog.Logger
}

// Set assigns a variable. Initializes the map lazily.
func (ws *WalkState) Set(key string, value any) {
	if ws.Variables == nil {
		ws.Variables = make(map[string]any)
	}
	ws.Variables[key] = value
}

// Get reads a variable. Returns nil, false when unset.
func (ws *WalkState) Get(key string) (any, bool) {
	if ws.Variables == nil {
		return nil, false
	}
	v, ok := ws.Variables[key]
	return v, ok
}

// GetString reads a variable as a string. Returns "" when unset or non-string.
func (ws *WalkState) GetString(key string) string {
	v, ok := ws.Get(key)
	if !ok {
		return ""
	}
	s, _ := v.(string)
	return s
}
