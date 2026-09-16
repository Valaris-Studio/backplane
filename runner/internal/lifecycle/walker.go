// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package lifecycle

import (
	"context"
	"errors"
	"fmt"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// ErrNoWork is the sentinel a handler may return to signal a clean early exit
// from the walk without an actual failure. The canonical use is discover when
// /next-assignment returns no eligible card: the walker stops, the caller's
// tickViaLifecycle bridge translates this into the same idle-backoff bookkeeping
// the legacy Tick path does. Distinguishable from real errors via errors.Is.
var ErrNoWork = noWorkError{}

type noWorkError struct{}

func (noWorkError) Error() string { return "lifecycle: no work available" }

// ErrSuspended is the sentinel a handler returns to signal the walk should stop
// cleanly because the card was parked (e.g. a budget cutoff checkpointed its WIP
// and suspended). Like ErrNoWork it is NOT a failure: the caller must NOT run the
// branch-wiping git_cleanup or the failure routing — the work is intentionally
// preserved on the branch for the next resume pass. Distinguishable via errors.Is.
var ErrSuspended = suspendedError{}

type suspendedError struct{}

func (suspendedError) Error() string { return "lifecycle: card suspended (checkpoint & resume)" }

// ErrSalvaged is the sentinel a handler returns when a failure-shaped stage
// exit was salvaged out-of-band (FIX #1, run-B): the handler already
// finished the card's terminal sequence (residual commit → push → PR → ship)
// on a fresh context, because the shared walk context may already be dead —
// the cutoff that strands pushed work is typically the tick deadline itself.
// A SUCCESS stop: the walker must skip on_failure routing AND the remaining
// steps; re-running them would double the PR/ship side-effects or fail on the
// dead context and route the shipped card back to failure.
var ErrSalvaged = salvagedError{}

type salvagedError struct{}

func (salvagedError) Error() string {
	return "lifecycle: stage salvaged (PR opened and card shipped out-of-band)"
}

// Walker executes a stage's lifecycle by dispatching each step to its
// kind-keyed handler and routing to the next step via:
//
//  1. step.Branches[decision] when the kind produced a non-empty decision and
//     a branch is mapped for it,
//  2. step.Next when no branch matched,
//  3. nothing → end of walk. Terminal-capable kinds (move_card, apply_label,
//     remove_label, create_note, enqueue_for_merge) end the walk cleanly.
//     Non-terminal kinds without a Next/Branches target are a config error.
//
// The walker is intentionally minimal: no parallelism, no mid-walk persistence,
// no role-specific branching. Dispatch is purely by step.Kind.
type Walker struct{}

// MaxSteps caps the walker's step budget to prevent runaway lifecycles
// (e.g., a branch that loops back on itself). Reaching the cap is an error;
// the cap is generous enough that legitimate lifecycles never hit it.
const MaxSteps = 64

// Walk executes the stage's lifecycle starting from the first step in the
// list. Steps are visited by name (step.Name), so the first step's name need
// not be a special sentinel. Returns the first handler error, an unknown-kind
// error, an unresolvable-next error, or nil on clean termination.
func (Walker) Walk(ctx context.Context, ws *WalkState, steps []valaris.LifecycleStep) error {
	if len(steps) == 0 {
		return fmt.Errorf("lifecycle: empty step list")
	}
	if ws == nil {
		return fmt.Errorf("lifecycle: nil walk state")
	}

	byName := make(map[string]*valaris.LifecycleStep, len(steps))
	for i := range steps {
		s := &steps[i]
		if s.Name == "" {
			return fmt.Errorf("lifecycle: step at index %d has empty name", i)
		}
		if _, dup := byName[s.Name]; dup {
			return fmt.Errorf("lifecycle: duplicate step name %q", s.Name)
		}
		byName[s.Name] = s
	}

	// Setup steps (discover/claim/git_setup) run on the ctx the caller handed
	// us, which the bridge bounds by the generous setup budget. The first
	// non-setup step is the setup→work boundary: from there on the walk runs
	// on a freshly-derived card budget, so a cold clone can no longer eat the
	// time the LLM step was supposed to get. Mirrors tickCard's split (the
	// legacy path's fix, 227c006e) so the two execution shapes time out alike.
	//
	// Re-derived once, at the boundary, rather than per-step: the card budget
	// bounds the work phase as a whole, exactly as it does on the legacy path.
	stepCtx := ctx
	workBudgetStarted := false
	if ws.StartWorkBudget == nil {
		// No hook (unit tests walking a bare WalkState): the caller's ctx is
		// already the whole budget, so the boundary is a no-op.
		workBudgetStarted = true
	}

	current := &steps[0]
	visited := 0
	// inFailureHandler suppresses recursive on_failure routing: a failure inside
	// a failure handler propagates to the caller rather than triggering another
	// jump. Reset on every normal Next/Branches transition.
	inFailureHandler := false
	for current != nil {
		visited++
		if visited > MaxSteps {
			return fmt.Errorf("lifecycle: exceeded MaxSteps=%d (possible loop at %q)", MaxSteps, current.Name)
		}

		schema, known := Kinds[current.Kind]
		if !known {
			return fmt.Errorf("lifecycle: unknown kind %q on step %q", current.Kind, current.Name)
		}

		handler, ok := Handlers[current.Kind]
		if !ok {
			return fmt.Errorf("lifecycle: no handler registered for kind %q (step %q)", current.Kind, current.Name)
		}

		if !workBudgetStarted && !IsSetupKind(current.Kind) {
			workCtx, cancel := ws.StartWorkBudget(ctx)
			defer cancel()
			stepCtx = workCtx
			workBudgetStarted = true
		}

		decision, nextOverride, err := handler(stepCtx, ws, current)
		if err != nil {
			// ErrNoWork is the idle-tick sentinel; preserve it unwrapped so
			// callers can check via errors.Is and short-circuit bookkeeping.
			if errors.Is(err, ErrNoWork) {
				return err
			}
			// ErrSuspended is a clean stop, not a failure: the card was parked
			// with its WIP preserved. Preserve it unwrapped and skip on_failure
			// routing so the walk does NOT fall into the branch-wiping path.
			if errors.Is(err, ErrSuspended) {
				return err
			}
			// ErrSalvaged: same clean-stop contract but a SUCCESS — the handler
			// already finished the card's terminal sequence out-of-band (FIX #1).
			if errors.Is(err, ErrSalvaged) {
				return err
			}
			if current.OnFailure != "" && !inFailureHandler {
				target, ok := byName[current.OnFailure]
				if !ok {
					return fmt.Errorf("lifecycle: step %q on_failure %q doesn't exist", current.Name, current.OnFailure)
				}
				ws.Set("last_error", err.Error())
				current = target
				inFailureHandler = true
				continue
			}
			return fmt.Errorf("lifecycle: step %q (%s): %w", current.Name, current.Kind, err)
		}
		if decision != "" && !schema.ProducesDecision {
			return fmt.Errorf("lifecycle: step %q (%s) returned decision %q but kind is not produces_decision", current.Name, current.Kind, decision)
		}
		if decision != "" {
			ws.LastDecision = decision
		}

		// A produces_decision step that emitted no decision (the LLM child exited
		// 0 but produced no parseable verdict) and has NO other successor would
		// dead-end in resolveNext: branches can't match an empty decision, and
		// the kind isn't terminal. Treat that as a soft failure and route to
		// on_failure — same machinery as a handler-returned error — so the card
		// lands on its failure path instead of retrying identically. Steps that
		// declare a `next` still follow it (a documentation llm emits no verdict
		// but routes linearly); only the branches-but-no-next shape dead-ends.
		// With no on_failure we fall through to the loud resolveNext error: a
		// decision step with neither a successor nor a fallback is misconfigured.
		if schema.ProducesDecision && decision == "" &&
			nextOverride == "" && current.Next == "" && !schema.Terminal &&
			current.OnFailure != "" && !inFailureHandler {
			target, ok := byName[current.OnFailure]
			if !ok {
				return fmt.Errorf("lifecycle: step %q on_failure %q doesn't exist", current.Name, current.OnFailure)
			}
			ws.Set("last_error", fmt.Sprintf("step %q (%s) produced no decision", current.Name, current.Kind))
			current = target
			inFailureHandler = true
			continue
		}

		next, err := resolveNext(current, decision, nextOverride, schema, byName)
		if err != nil {
			return err
		}
		current = next
		inFailureHandler = false
	}
	return nil
}

// resolveNext picks the next step pointer. Returns nil + nil error when the
// walk should terminate cleanly. Order of precedence:
//
//  1. nextOverride from the handler (rare — escape hatch),
//  2. step.Branches[decision] when decision is non-empty and mapped,
//  3. step.Next,
//  4. terminal kinds → nil (clean stop),
//  5. otherwise → error (no successor and kind isn't terminal).
//
// Note: a decision-producing kind with no matching branch falls through to
// step.Next. Pipelines that want strict "every decision must route" semantics
// declare branches for every decision they emit; the closed kind set doesn't
// enforce that — backend validation does (see pipeline_config_validation.py).
//
// The ABSENCE of a decision from a produces_decision step is handled upstream in
// Walk (routes to on_failure), not here: backend validation only checks that
// declared branch targets reach a terminal, never that an empty decision has a
// fallback. resolveNext only sees the empty-decision step when on_failure is
// unset, in which case the no-next/branches error below correctly fires.
func resolveNext(
	step *valaris.LifecycleStep,
	decision, nextOverride string,
	schema KindSchema,
	byName map[string]*valaris.LifecycleStep,
) (*valaris.LifecycleStep, error) {
	if nextOverride != "" {
		next, ok := byName[nextOverride]
		if !ok {
			return nil, fmt.Errorf("lifecycle: step %q handler asked for next %q which doesn't exist", step.Name, nextOverride)
		}
		return next, nil
	}
	if decision != "" {
		if target, ok := step.Branches[decision]; ok {
			if target == "" {
				// Empty branch target means "terminate here". Operators use this
				// for fail-soft branches that should stop the walk without an
				// explicit terminal kind.
				return nil, nil
			}
			next, ok := byName[target]
			if !ok {
				return nil, fmt.Errorf("lifecycle: step %q branch %q points to unknown step %q", step.Name, decision, target)
			}
			return next, nil
		}
	}
	if step.Next != "" {
		next, ok := byName[step.Next]
		if !ok {
			return nil, fmt.Errorf("lifecycle: step %q next %q doesn't exist", step.Name, step.Next)
		}
		return next, nil
	}
	if schema.Terminal {
		return nil, nil
	}
	return nil, fmt.Errorf("lifecycle: step %q (%s) has no next/branches and kind is not terminal", step.Name, step.Kind)
}
