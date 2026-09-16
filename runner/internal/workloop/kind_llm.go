// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"errors"
	"log/slog"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// lifecycleLLM wraps DataDrivenStrategy.executeLLM. Reads step.Params
// (stage, post_process_kind, tools, inject_directives, approval_enabled,
// use_minimal_prompt_when_unauthored) to override LLM defaults.
//
// Returns the LLM-derived decision when present so the walker can route via
// step.Branches[decision]. produces_decision kinds (review-style stages) carry
// "approve"/"request_changes" here; writes_code stages typically return empty.
//
// Sentinel handling: when runLLMStage emits decision="no_prompt" (no template
// cached + no fallback registered), the handler does NOT propagate that as a
// routing decision — instead it surfaces it as a soft skip via the dedicated
// branch key "no_prompt", so operators can wire a graceful path. Same semantics
// as the legacy skipNoPromptStage early-return on the Tick side.
func lifecycleLLM(ctx context.Context, ws *lifecycle.WalkState, step *valaris.LifecycleStep) (string, string, error) {
	l := loopFromWalk(ws)
	s := strategyFromWalk(ws)
	card, err := requireCard(ws, step.Name, step.Kind)
	if err != nil {
		return "", "", err
	}

	prev := s.config.LLM
	if stage := paramString(step, "stage", ""); stage != "" {
		s.config.LLM.Stage = stage
	}
	if kind := paramString(step, "post_process_kind", ""); kind != "" {
		s.config.LLM.PostProcessKind = kind
	}
	if step.Params != nil {
		if v, ok := step.Params["tools"].([]any); ok {
			tools := make([]string, 0, len(v))
			for _, t := range v {
				if s, ok := t.(string); ok {
					tools = append(tools, s)
				}
			}
			s.config.LLM.Tools = tools
		}
		if v, ok := step.Params["inject_directives"].(bool); ok {
			s.config.LLM.InjectDirectives = v
		}
		if v, ok := step.Params["approval_enabled"].(bool); ok {
			s.config.LLM.ApprovalEnabled = v
		}
		if v, ok := step.Params["use_minimal_prompt_when_unauthored"].(bool); ok {
			s.config.LLM.UseMinimalPromptWhenUnauthored = v
		}
	}
	s.config.LLM.Enabled = true
	defer func() { s.config.LLM = prev }()

	walkLogger(ws).Info("stage started", "stage", s.config.LLM.Stage, "role", s.config.Role, "card_id", card.CardID)

	result, err := s.executeLLM(ctx, ctx, l, card, ws.ExecutionID, ws.RepoDir)
	if err != nil {
		// Cluster I: a budget cutoff is a SUSPEND, not a failure. Checkpoint the
		// WIP and park the card instead of letting the walker route to the
		// branch-wiping on_failure path. Only applies to stages that own a branch
		// (create_branch); other stages have no WIP to preserve.
		var be *budgetSuspendError
		if errors.As(err, &be) && s.config.Git.Action == "create_branch" {
			branchRecovered, _ := ws.Get("branch_recovered")
			recovered, _ := branchRecovered.(bool)
			suspended, escErr := s.checkpointAndSuspend(ctx, l, card, ws.RepoDir, recovered, be)
			if suspended {
				return "", "", lifecycle.ErrSuspended
			}
			return "", "", escErr
		}
		// FIX #1: a failure-shaped exit that left real commits on the branch
		// (turn/time cutoff after the LLM committed, before create_pr) is
		// salvaged into the PR on THIS tick — deterministic git/gh calls, no
		// second reservation. ErrSalvaged stops the walk cleanly as a SUCCESS;
		// downstream steps must not run (the walk context may already be dead
		// — the cutoff is typically the CardTimeout itself).
		branchRecovered, _ := ws.Get("branch_recovered")
		recovered, _ := branchRecovered.(bool)
		if s.salvageCommittedImplement(l, card, ws.ExecutionID, ws.RepoDir, ws.Branch, recovered, l.lastTurnTokens == 0, err, walkLogger(ws)) {
			ws.Set("execution_released", true)
			return "", "", lifecycle.ErrSalvaged
		}
		return "", "", err
	}
	ws.LLMResult = result
	if result == nil {
		return "", "", nil
	}
	// Verbatim stdout flows to WalkState so terminal kinds (create_note
	// body_from="raw", mcp_call resolving $llm_output) can consume it without
	// re-parsing the structured envelope.
	ws.LLMRawOutput = result.rawOutput

	// FIX #3: the stage raised an approval and parkForApproval already did the
	// whole park (label, unassign, note, execution closed as aborted, repo
	// released). Stop the walk cleanly — ErrSuspended is the walker's existing
	// "card parked, not a failure" stop — and flag the execution as released so
	// tickViaLifecycle doesn't close it a second time.
	if result.implResult != nil && result.implResult.Status == statusAwaitingApproval {
		ws.Set("execution_released", true)
		return "", "", lifecycle.ErrSuspended
	}

	completedAttrs := []any{"stage", s.config.LLM.Stage, "card_id", card.CardID}
	if result.decision != "" {
		completedAttrs = append(completedAttrs, "decision", result.decision)
	}
	walkLogger(ws).Info("stage completed", completedAttrs...)

	// LIFECYCLE-FOLLOWUP-6: writes_code stages on create_branch must commit
	// and push before the downstream create_pr step shells out to `gh pr
	// create` (which 422s on uncommitted or unpushed branches). Mirrors the
	// legacy DataDrivenStrategy.Tick gate at strategy_generic.go:256. Skip
	// when the stage was gracefully bypassed via the no_prompt sentinel.
	if result.decision != "no_prompt" &&
		s.config.Git.Action == "create_branch" &&
		s.config.LLM.EffectivePostProcessKind() == "writes_code" {
		branchRecovered, _ := ws.Get("branch_recovered")
		recovered, _ := branchRecovered.(bool)
		cleanup := func() {}
		if v, ok := ws.Get("git_cleanup"); ok {
			if fn, ok := v.(func()); ok {
				cleanup = fn
			}
		}
		logger := ws.Logger
		if logger == nil {
			logger = slog.Default()
		}
		done, gitErr := s.gitCommitAndPush(ctx, ctx, l, card, ws.ExecutionID, ws.RepoDir, ws.Branch, recovered, cleanup, logger, result)
		if gitErr != nil {
			return "", "", gitErr
		}
		if done {
			// C1: a runtime-proof park is a terminal stop, not a routable
			// decision. parkForRuntimeProof already did the whole park (label,
			// unassign, note, execution closed as aborted); stop the walk via
			// ErrSuspended — exactly like the awaiting-approval sentinel above
			// — so NO downstream step (create_pr, ship, or an on_failure
			// fail-move back to active) can run against the just-parked card.
			//
			// Same treatment for a duplicate close: closeAsDuplicate already
			// finished the card as a SUCCESS terminal (done column, duplicate
			// label, execution COMPLETED — not aborted). Only the walk
			// continuation stops; nothing may open a PR for the closed card or
			// fail-move it back out of done.
			if result.implResult != nil &&
				(result.implResult.Status == statusRuntimeProofParked ||
					result.implResult.Status == statusDuplicateClosed ||
					result.implResult.Status == statusReconcileParked ||
					result.implResult.Status == statusBlockedParked) {
				ws.Set("execution_released", true)
				return "", "", lifecycle.ErrSuspended
			}
			// gitCommitAndPush already handled the no-changes failure path
			// (failExecution + recordFailure). Surface as a soft skip so the
			// walker stops cleanly without the caller trying to open a PR
			// against a no-op branch.
			return "no_changes", "", nil
		}
	}

	return result.decision, "", nil
}
