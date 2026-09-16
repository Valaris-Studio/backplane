// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"fmt"
	"log/slog"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// This file bridges the lifecycle package's kind-keyed walker to the workloop
// package's existing helpers. Each registered handler is a thin shell that:
//
//  1. casts the opaque WalkState.Loop / WalkState.Strategy to the concrete
//     types it needs (workloop is package-private to the lifecycle package),
//  2. extracts step.Params keys with sensible defaults,
//  3. delegates to an existing DataDrivenStrategy / Loop helper.
//
// The strategy_generic.go helpers stay untouched. New code that wants to drive
// behavior from a lifecycle config goes through these handlers; the legacy
// Tick path keeps working until lane A.3 migrates the default pipeline over.
//
// NOTE on file location: the brief proposed putting per-kind handlers under
// internal/lifecycle/, but those handlers must call DataDrivenStrategy/Loop
// helpers which are package-private to workloop. Reversing the import would
// create a cycle (workloop already imports lifecycle for Walker/WalkState).
// Resolving via function-variable injection added ~12 indirections without
// gain. Living in workloop and registering via init() keeps the API surface
// (the lifecycle.Handlers map) intact while letting handlers compose existing
// helpers directly.

// loopFromWalk asserts the WalkState.Loop opaque back to *Loop. Panics on
// type mismatch — this is a programming error, not a runtime condition.
func loopFromWalk(ws *lifecycle.WalkState) *Loop {
	l, ok := ws.Loop.(*Loop)
	if !ok {
		panic(fmt.Sprintf("lifecycle: WalkState.Loop is %T, want *Loop", ws.Loop))
	}
	return l
}

// strategyFromWalk asserts the WalkState.Strategy opaque back to *DataDrivenStrategy.
func strategyFromWalk(ws *lifecycle.WalkState) *DataDrivenStrategy {
	s, ok := ws.Strategy.(*DataDrivenStrategy)
	if !ok {
		panic(fmt.Sprintf("lifecycle: WalkState.Strategy is %T, want *DataDrivenStrategy", ws.Strategy))
	}
	return s
}

// cardFromWalk asserts the WalkState.Card opaque back to *discoverResult.
// Returns nil when no discover step has populated Card yet — handlers that
// need a card should error in that case (it's a config error, not runtime).
func cardFromWalk(ws *lifecycle.WalkState) *discoverResult {
	if ws.Card == nil {
		return nil
	}
	c, ok := ws.Card.(*discoverResult)
	if !ok {
		panic(fmt.Sprintf("lifecycle: WalkState.Card is %T, want *discoverResult", ws.Card))
	}
	return c
}

// llmResultFromWalk asserts the WalkState.LLMResult opaque back to *llmStageResult.
// Returns nil when no llm step has run yet.
func llmResultFromWalk(ws *lifecycle.WalkState) *llmStageResult {
	if ws.LLMResult == nil {
		return nil
	}
	r, ok := ws.LLMResult.(*llmStageResult)
	if !ok {
		panic(fmt.Sprintf("lifecycle: WalkState.LLMResult is %T, want *llmStageResult", ws.LLMResult))
	}
	return r
}

// sensorResultFromWalk asserts the WalkState.SensorResult opaque back to *sensorResults.
func sensorResultFromWalk(ws *lifecycle.WalkState) *sensorResults {
	if ws.SensorResult == nil {
		return nil
	}
	r, ok := ws.SensorResult.(*sensorResults)
	if !ok {
		panic(fmt.Sprintf("lifecycle: WalkState.SensorResult is %T, want *sensorResults", ws.SensorResult))
	}
	return r
}

// walkLogger returns the WalkState logger or a slog.Default fallback so handlers
// don't need nil-guards.
func walkLogger(ws *lifecycle.WalkState) *slog.Logger {
	if ws.Logger != nil {
		return ws.Logger
	}
	return slog.Default()
}

// paramString reads a string param with a default fallback.
func paramString(step *valaris.LifecycleStep, key, def string) string {
	if step.Params == nil {
		return def
	}
	v, ok := step.Params[key]
	if !ok {
		return def
	}
	s, ok := v.(string)
	if !ok {
		return def
	}
	return s
}

// paramBool reads a bool param with a default fallback.
func paramBool(step *valaris.LifecycleStep, key string, def bool) bool {
	if step.Params == nil {
		return def
	}
	v, ok := step.Params[key]
	if !ok {
		return def
	}
	b, ok := v.(bool)
	if !ok {
		return def
	}
	return b
}

// paramMap reads a sub-object param; returns nil when missing.
func paramMap(step *valaris.LifecycleStep, key string) map[string]any {
	if step.Params == nil {
		return nil
	}
	v, ok := step.Params[key]
	if !ok {
		return nil
	}
	m, _ := v.(map[string]any)
	return m
}

// requireCard returns the WalkState card or an explicit error if no discover
// step ran first. Standardizes the "step needs a card" check so each handler
// doesn't reinvent the error string.
func requireCard(ws *lifecycle.WalkState, stepName, kind string) (*discoverResult, error) {
	card := cardFromWalk(ws)
	if card == nil {
		return nil, fmt.Errorf("step %q (%s) requires a card but no prior discover step set one", stepName, kind)
	}
	return card, nil
}

// init registers every kind handler into lifecycle.Handlers. Each per-kind file
// in this package contributes its handler to the map; this init runs once at
// package load so the walker sees a complete table before any tick runs.
func init() {
	lifecycle.Handlers["discover"] = lifecycleDiscover
	lifecycle.Handlers["claim"] = lifecycleClaim
	lifecycle.Handlers["git_setup"] = lifecycleGitSetup
	lifecycle.Handlers["skills_setup"] = lifecycleSkillsSetup
	lifecycle.Handlers["llm"] = lifecycleLLM
	lifecycle.Handlers["sensor"] = lifecycleSensor
	lifecycle.Handlers["move_card"] = lifecycleMoveCard
	lifecycle.Handlers["apply_label"] = lifecycleApplyLabel
	lifecycle.Handlers["remove_label"] = lifecycleRemoveLabel
	lifecycle.Handlers["create_note"] = lifecycleCreateNote
	lifecycle.Handlers["enqueue_for_merge"] = lifecycleEnqueueForMerge
	lifecycle.Handlers["mcp_call"] = lifecycleMCPCall
	lifecycle.Handlers["create_fix_cards"] = lifecycleCreateFixCards
	lifecycle.Handlers["branch"] = lifecycleBranch
	lifecycle.Handlers["wake_role"] = lifecycleWakeRole
	lifecycle.Handlers["create_pr"] = lifecycleCreatePR
	lifecycle.Handlers["enable_auto_merge"] = lifecycleEnableAutoMerge
	lifecycle.Handlers["merge_pr"] = lifecycleMergePR
	lifecycle.Handlers["post_pr_review"] = lifecyclePostPRReview
	lifecycle.Handlers["ship"] = lifecycleShip
	lifecycle.Handlers["end"] = lifecycleEnd

	// Sanity-check: every closed-set kind must have a handler. If a future
	// commit adds a kind to lifecycle.Kinds without a handler, the runner will
	// panic at startup rather than silently dropping the step at execution.
	for kind := range lifecycle.Kinds {
		if _, ok := lifecycle.Handlers[kind]; !ok {
			panic(fmt.Sprintf("lifecycle: kind %q has no registered handler", kind))
		}
	}
}
