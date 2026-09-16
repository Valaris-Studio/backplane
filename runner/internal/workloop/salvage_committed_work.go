// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/forge"
	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
)

// FIX #1 (run-B) — same-tick PR salvage for cut-off implement passes.
//
// A long implement pass can terminate failure-shaped AFTER its work is already
// committed: the LLM commits/pushes via its own tooling mid-run, then the pass
// dies on a turn/time cutoff before the create_pr step (live: I1, 138 turns,
// $16.94, ended between push and PR). The next-reservation branch recovery
// self-heals this ("commits ahead, clean tree → proceed to PR/review") but at
// the price of a whole extra reservation (~$4.66 of LLM spend). Salvage makes
// the SAME tick finish the job deterministically — cheap git/gh calls, no
// extra LLM pass: commit any residue, push, open the PR, ship the card
// forward. The next-reservation recovery stays untouched as defense-in-depth
// for whatever salvage itself cannot reach (e.g. a gh outage).
//
// Signal-keyed and white-label: triggers on git state (commits ahead of the
// remote default) + the stage's git intent (create_branch + create_pr), never
// on role or project names.

// salvageGitTimeout bounds the fresh-context window for the whole salvage
// sequence (residual commit + push + gh pr create + ship). Deliberately
// independent of the tick context: the cutoff that strands pushed work is
// typically the CardTimeout itself, so the walk/tick context is already dead
// when salvage runs.
const salvageGitTimeout = 3 * time.Minute

// salvageCommittedImplement rescues a failure-shaped implement exit whose work
// is already committed on the card branch. Returns true when the card was
// fully salvaged (PR open, card shipped to the stage's success column,
// execution completed) — the caller must then end the tick as a SUCCESS, with
// no failure bookkeeping. Returns false when the exit is not salvageable, in
// which case the caller's normal failure path runs unchanged.
//
// What does NOT qualify (don't mask real outcomes):
//   - no commits ahead of the remote default — a commit is the LLM's own
//     declaration of a coherent checkpoint; an empty branch or uncommitted
//     scratch alone is a real failure,
//   - intentional parks (budget suspend resumes by design; a card still
//     carrying a park label has CHECKPOINT commits on its branch, not
//     finished work),
//   - stages without PR intent (documentator: create_branch but create_pr
//     false) or with auto_pr disabled by the operator.
func (s *DataDrivenStrategy) salvageCommittedImplement(l *Loop, card *discoverResult, execID, repoDir, branch string, branchRecovered bool, emptyTurn bool, cause error, logger *slog.Logger) bool {
	if card == nil || repoDir == "" {
		return false
	}
	// A 0-token turn means the model never ran (a hard CLI/arg crash, e.g. the
	// codex resume --cd wedge: exit 2, 0s, 0 tokens). Any commits-ahead are then
	// LEFTOVER from branch recovery, not this turn's product — salvaging churns
	// force-push/gh-pr-create over a remote that never received real work. Take
	// the normal failure path instead. (A genuine mid-pass cutoff spent tokens,
	// so emptyTurn is false and salvage proceeds.)
	if emptyTurn {
		logger.Info("salvage skipped: implement turn produced 0 tokens (model never ran) — commits-ahead are leftover, not this turn's work")
		return false
	}
	if s.config.Git.Action != "create_branch" || !s.config.Git.CreatePR || !l.cfg.Git.AutoPR {
		return false
	}
	var be *budgetSuspendError
	if errors.As(cause, &be) || errors.Is(cause, lifecycle.ErrSuspended) {
		return false
	}
	// H3: an approval-shaped exit means the stage explicitly demanded a human
	// gate. No park label exists yet at this point (the malformed raise errored
	// before any park), so the typed error is the only signal — shipping the
	// committed work here would silently drop the human gate.
	if errors.Is(cause, errUntrackableApproval) {
		return false
	}
	for _, label := range card.Labels {
		if label == budgetSuspendedLabel || label == awaitingApprovalLabel {
			return false
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), salvageGitTimeout)
	defer cancel()

	ahead, err := l.git.CommitsAheadOfRemoteDefault(ctx, repoDir, card.DefaultBranch)
	if err != nil {
		logger.Warn("salvage skipped: cannot count commits ahead of default", "error", err)
		return false
	}
	if ahead == 0 {
		return false
	}

	logger.Info("implement terminated with commits on the branch — salvaging into PR on this tick",
		"commits_ahead", ahead, "branch", branch, "cause", cause)

	// Residual uncommitted edits ride along on top of the real commits (a
	// commit+push at cutoff is the same salvage family). Best-effort: the
	// existing commits are the load-bearing part.
	if hasChanges, _ := l.git.HasChanges(ctx, repoDir); hasChanges {
		msg := renderCommitMessage(l.WorkspaceConfig().CommitMessageTemplate, card.CardID, card.Title)
		if err := l.git.CommitAll(ctx, repoDir, msg); err != nil {
			logger.Warn("salvage: committing residual changes failed; pushing existing commits only", "error", err)
		}
	}
	// Push is a no-op when the LLM already pushed before the cutoff.
	if branchRecovered {
		if err := l.git.ForceWithLeasePush(ctx, repoDir); err != nil {
			logger.Warn("salvage: force-push failed; attempting PR against the remote state", "error", err)
		}
	} else if err := l.git.Push(ctx, repoDir); err != nil {
		logger.Warn("salvage: push failed; attempting PR against the remote state", "error", err)
	}

	// Same title/body/base contract as the create_pr lifecycle step. CreatePR
	// is idempotent — an already-open PR for the branch returns its URL.
	baseRef := resolveBaseRef(s.config.Git, card)
	if baseRef == "" {
		baseRef = card.DefaultBranch
	}
	// L4: a fixed phrase only — the raw cause (turn-budget/provider noise)
	// stays in the log lines, never in the PR description.
	body := fmt.Sprintf("Implements card %s\n\nImplement pass ended early; work salvaged from the pushed branch.", card.CardID)
	prURL, err := l.forge.OpenChange(ctx, repoDir, forge.OpenChangeInput{
		Title:        card.Title,
		Body:         body,
		SourceBranch: branch,
		TargetBranch: baseRef,
	})
	if err != nil {
		logger.Warn("salvage: PR creation failed — falling back to the normal failure path (next-reservation recovery still applies)", "error", err)
		return false
	}
	card.PRURL = prURL

	// Ship = patch pr_url/branch onto the card, move it to the success column
	// (review by default), complete the execution.
	if err := l.ship(ctx, card, execID, branch, prURL, s.config.OnSuccess.MoveToColumnType, nil); err != nil {
		logger.Warn("salvage: ship after PR creation failed — falling back to the failure path; the open PR makes the next reservation recover cheaply",
			"error", err, "pr_url", prURL)
		return false
	}

	// Mirror the legacy success tail: leave the clone on the default branch and
	// clear the per-card failure/no-op counters.
	if err := l.git.ResetToDefault(ctx, repoDir, card.DefaultBranch); err != nil {
		logger.Warn("salvage: reset to default branch failed", "error", err)
	}
	l.ClearNoChangeRework(card.CardID)
	l.ClearCardFailure(card.CardID)
	logger.Info("salvage complete: PR opened and card shipped without a second reservation", "pr_url", prURL)
	return true
}
