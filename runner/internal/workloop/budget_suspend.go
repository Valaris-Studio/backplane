// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
)

// Labels that encode SUSPEND state on the card (board state, no backend
// migration). budgetSuspendedLabel parks the card; the budget-pass-N label
// (budgetPassLabelPrefix + N) tracks how many checkpoint-resumes it has had so
// the terminal guard can cap them. Parking/routing of the suspended card is
// configured backend-side via the list-valued label filters (deploy-gated),
// not hardcoded here.
const (
	budgetSuspendedLabel  = "budget-suspended"
	budgetPassLabelPrefix = "budget-pass-"
)

// Cluster I — SUSPEND outcome (budget cutoff → checkpoint & resume).
//
// The runner historically had two outcomes: SUCCESS or FAILURE, and a per-pass
// budget cutoff was funneled into FAILURE, whose recovery wipes the feature
// branch and retries from scratch. For a budget cutoff that is backwards — the
// work is typically ~80% done, so each retry re-burns the full budget against
// the same wall and never converges. SUSPEND is the third outcome: checkpoint
// the work-in-progress as a commit and resume the next pass from branch HEAD.

// The threshold (fraction of budget that marks a cutoff) and the terminal-guard
// pass cap are operator-tunable with safe defaults — see config.LLMConfig
// SuspendThreshold / SuspendMaxPasses.

// classifyBudgetSuspend reports whether an errored implement pass is a budget
// cutoff worth suspending. True iff there is work to save AND a positive budget
// is configured AND the pass spent at least threshold×budget. The cost compare
// uses the implement-pass delta (not cumulative tick cost) so discover/mediation
// spend in the same tick can't inflate it.
//
// The caller in implement() passes haveWork=true unconditionally — it can't see
// the git tree, so the real "is there work to save" gate lives in
// checkpointAndSuspend (which owns the repo dir). haveWork stays a parameter so
// the cost/budget logic is unit-testable in isolation.
func classifyBudgetSuspend(implementCostDelta, effectiveBudget, threshold float64, haveWork bool) bool {
	if !haveWork || effectiveBudget <= 0 || threshold <= 0 {
		return false
	}
	return implementCostDelta >= threshold*effectiveBudget
}

// budgetSuspendError is the typed sentinel an implement pass wraps when a budget
// cutoff is detected. It rides the existing `return nil, err` chain (implement →
// executeLLM → walker) unchanged; the catch site recovers it via errors.As to
// branch into checkpoint+suspend instead of the branch-wiping failure path.
type budgetSuspendError struct {
	costDelta float64
	budget    float64
	cause     error
}

func (e *budgetSuspendError) Error() string {
	return fmt.Sprintf("budget cutoff suspend (spent ~$%.2f of $%.2f): %v", e.costDelta, e.budget, e.cause)
}

func (e *budgetSuspendError) Unwrap() error { return e.cause }

// escalate returns the error to hand back to the normal failure path when a
// budget cutoff is NOT suspended (empty tree / terminal guard / checkpoint
// failure). It returns the original cause when present, but never nil — the
// walker treats a nil error as success, so escalation must always carry one.
func (e *budgetSuspendError) escalate() error {
	if e.cause != nil {
		return e.cause
	}
	return e
}

// parseBudgetPass returns the highest valid pass number encoded in the card's
// labels (budget-pass-N). Malformed or missing → 0. Max-of-valid wins so a
// stray older pass label can't undercount.
func parseBudgetPass(labels []string) int {
	max := 0
	for _, l := range labels {
		if !strings.HasPrefix(l, budgetPassLabelPrefix) {
			continue
		}
		n, err := strconv.Atoi(strings.TrimPrefix(l, budgetPassLabelPrefix))
		if err != nil || n < 0 {
			continue
		}
		if n > max {
			max = n
		}
	}
	return max
}

// buildResumeBrief returns the continue-from-checkpoint instructions injected
// into the implement prompt when a budget-suspended card is resumed. Empty for a
// fresh (non-suspended) pickup so the prompt is unchanged. The branch already
// carries the prior pass's WIP commit (checkpointAndSuspend committed + pushed
// it); the brief tells the agent to build on it rather than re-implement.
func buildResumeBrief(labels []string) string {
	suspended := false
	for _, l := range labels {
		if l == budgetSuspendedLabel {
			suspended = true
			break
		}
	}
	if !suspended {
		return ""
	}
	pass := parseBudgetPass(labels)
	return fmt.Sprintf(
		"A prior implementation pass on this card hit the budget ceiling and committed its "+
			"work-in-progress as a checkpoint commit. You are now on pass %d. The branch HEAD "+
			"already contains that partial work — DO NOT start over. Read the current state of "+
			"the branch (git log / the existing files), continue from where the prior pass left "+
			"off, and finish the implementation. Replace or build on the WIP checkpoint commit; "+
			"do not duplicate work already present.",
		pass+1,
	)
}

// prependResumeBrief prepends the resume brief to a rendered implement prompt
// when the card is being resumed from a budget checkpoint. Injecting OUTSIDE the
// template (rather than via a {{.ResumeBrief}} reference) means it survives the
// backend-authoritative prompt path — a cached template that doesn't reference
// the field would otherwise silently drop it. No-op when the brief is empty.
func prependResumeBrief(prompt, brief string) string {
	if brief == "" {
		return prompt
	}
	return "=== RESUME FROM CHECKPOINT (this card was budget-suspended mid-implementation) ===\n" +
		brief + "\n=== END RESUME ===\n\n" + prompt
}

// checkpointAndSuspend handles a detected budget cutoff: commit the WIP (or
// confirm it was already committed), park the card with a suspend label + pass
// count, and stop — instead of the branch-wiping failure path. Returns
// (true, nil) when the card was suspended (caller stops the walk cleanly via
// lifecycle.ErrSuspended); (false, cause) when there is nothing worth saving or
// the terminal guard tripped, so the caller falls through to normal failure.
//
// The branch is preserved in BOTH suspend and terminal-guard cases (a human or
// the next pass wants the ~80%-done work); only the parking differs.
func (s *DataDrivenStrategy) checkpointAndSuspend(
	ctx context.Context, l *Loop, card *discoverResult, repoDir string,
	branchRecovered bool, be *budgetSuspendError,
) (bool, error) {
	logger := slog.With("role", s.config.Role, "card_id", card.CardID, "cost_delta", be.costDelta, "budget", be.budget)

	hasChanges, err := l.git.HasChanges(ctx, repoDir)
	if err != nil {
		logger.Warn("suspend: HasChanges failed; falling through to failure", "error", err)
		return false, be.escalate()
	}
	ahead, aheadErr := l.git.CommitsAheadOfRemoteDefault(ctx, repoDir, card.DefaultBranch)
	if aheadErr != nil {
		logger.Warn("suspend: CommitsAhead failed; assuming work present to avoid discarding it", "error", aheadErr)
		ahead = 1 // fail-safe: treat as work present rather than wipe
	}

	// No work to save: suspending would park a card that resumes to the same
	// empty state and re-burns identically. Fall through to normal failure (which
	// harmlessly wipes the empty branch).
	if !hasChanges && ahead == 0 {
		logger.Info("budget cutoff but no work to checkpoint; not suspending")
		return false, be.escalate()
	}

	// Terminal guard: cap checkpoint-resumes so a card that never converges can't
	// suspend-loop forever. Clear the suspend labels and escalate to the normal
	// failure path (human/escalation); keep the branch for forensics.
	pass := parseBudgetPass(card.Labels)
	if pass+1 > l.cfg.LLM.SuspendMaxPasses() {
		logger.Warn("budget suspend terminal guard tripped; escalating to failure",
			"pass", pass, "max_passes", l.cfg.LLM.SuspendMaxPasses())
		s.clearBudgetSuspendLabels(ctx, l, card)
		return false, be.escalate()
	}

	// Checkpoint: commit the WIP so the tree is clean and the branch is ahead.
	// If the cutoff landed after the LLM already committed (clean tree, ahead),
	// CommitAll would error "no changes" — skip it; the work is already saved.
	if hasChanges {
		msg := fmt.Sprintf("wip(%s): budget checkpoint pass %d", card.CardID, pass+1)
		if err := l.git.CommitAll(ctx, repoDir, msg); err != nil {
			logger.Warn("suspend: WIP commit failed; falling through to failure", "error", err)
			return false, be.escalate()
		}
	}
	// Push so the checkpoint survives a fresh clone on the next pickup. Best-
	// effort: a push failure must not turn a successful checkpoint into a wipe.
	if branchRecovered {
		if err := l.git.ForceWithLeasePush(ctx, repoDir); err != nil {
			logger.Warn("suspend: force-push of checkpoint failed; branch kept locally", "error", err)
		}
	} else {
		if err := l.git.Push(ctx, repoDir); err != nil {
			logger.Warn("suspend: push of checkpoint failed; branch kept locally", "error", err)
		}
	}

	// Park: bump the pass count (clear stale pass labels first so they can't
	// accumulate) and apply the suspend label. Order: clear → add pass → park.
	s.clearBudgetPassLabels(ctx, l, card)
	s.addLabel(ctx, l, card, fmt.Sprintf("%s%d", budgetPassLabelPrefix, pass+1))
	s.addLabel(ctx, l, card, budgetSuspendedLabel)

	// Shed the hero participant. The implementer's `unassigned_or_rework`
	// discover skips any card carrying a hero (backend _candidate_cards), so a
	// suspended card that keeps its hero is invisible to the next scan and can
	// never be re-offered — it strands in `active` with the WIP checkpoint
	// orphaned and the runner idles. Dropping the hero makes the card
	// unassigned-eligible again; the surviving budget-suspended label drives the
	// resume brief on re-pickup (buildResumeBrief), so work continues from branch
	// HEAD rather than restarting. Best-effort: a failed unassign is logged, not
	// fatal — better to leave a recoverable strand than to abort a good checkpoint.
	if err := l.client.RemoveCardParticipant(ctx, l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID, l.client.UserID); err != nil {
		logger.Warn("suspend: failed to unassign hero; card may strand until manual unassign", "error", err)
	}

	logger.Info("card budget-suspended; WIP checkpointed, will resume from branch HEAD", "pass", pass+1)
	return true, nil
}

// clearBudgetPassLabels removes every budget-pass-* label. removeLabel only drops
// exact strings, so re-read the live labels and remove each matching one.
func (s *DataDrivenStrategy) clearBudgetPassLabels(ctx context.Context, l *Loop, card *discoverResult) {
	current, err := l.client.GetCard(ctx, l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID)
	if err != nil {
		slog.Warn("clear budget-pass labels: get card failed", "card_id", card.CardID, "error", err)
		return
	}
	for _, lbl := range current.Labels {
		if strings.HasPrefix(lbl, budgetPassLabelPrefix) {
			s.removeLabel(ctx, l, card, lbl)
		}
	}
}

// clearBudgetSuspendLabels removes the suspend label AND all pass labels — used
// by the terminal guard so the card lands on the normal failure path, not as a
// still-parked suspend.
func (s *DataDrivenStrategy) clearBudgetSuspendLabels(ctx context.Context, l *Loop, card *discoverResult) {
	s.clearBudgetPassLabels(ctx, l, card)
	s.removeLabel(ctx, l, card, budgetSuspendedLabel)
}
