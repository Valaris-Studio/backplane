// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"

	"github.com/Valaris-Studio/backplane/runner/internal/forge"
	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// lifecyclePostPRReview mirrors the reviewer's verdict onto the PR via gh CLI.
// Wraps git.Manager.ReviewPR (when mode=github) or CommentPR (when mode=comment).
//
// Decision defaults to ws.LastDecision (the last produces_decision step's
// output) so the common case — review_diff llm step → post_pr_review — needs
// no params. Operators set decision explicitly when posting on multiple
// branches (avoids relying on LastDecision ordering).
//
// Body defaults to llmResult.reviewResult.Findings; body_from is reserved
// for future template support. Mode defaults to cfg.Git.ReviewMode.
//
// Skipped (returns nil cleanly) when ReviewOnGitHub is disabled or the card
// has no PR — matches legacy postReviewToGitHub fail-soft behavior. Errors
// from the gh subprocess are logged-and-swallowed for the same reason: a PR
// review failure shouldn't block the tick that produced the verdict.
func lifecyclePostPRReview(ctx context.Context, ws *lifecycle.WalkState, step *valaris.LifecycleStep) (string, string, error) {
	l := loopFromWalk(ws)
	card, err := requireCard(ws, step.Name, step.Kind)
	if err != nil {
		return "", "", err
	}
	if !l.cfg.Git.ReviewOnGitHub || card.PRURL == "" {
		return "", "", nil
	}
	if ws.RepoDir == "" {
		return "", "", &configError{msg: "post_pr_review requires a prior git_setup step (RepoDir empty)"}
	}

	decision := paramString(step, "decision", ws.LastDecision)
	body := ""
	if r := llmResultFromWalk(ws); r != nil && r.reviewResult != nil {
		body = string(r.reviewResult.Findings)
	}
	mode := paramString(step, "mode", l.cfg.Git.ReviewMode)

	logger := walkLogger(ws)
	if mode == "github" {
		fdecision := forge.Comment
		switch decision {
		case "approve":
			fdecision = forge.Approve
		case "request_changes":
			fdecision = forge.RequestChanges
		}
		if err := l.forge.Review(ctx, ws.RepoDir, card.PRURL, fdecision, body); err != nil {
			logger.Warn("post_pr_review: GitHub PR review failed", "error", err)
		}
		return "", "", nil
	}
	if err := l.forge.CommentOn(ctx, ws.RepoDir, card.PRURL, body); err != nil {
		logger.Warn("post_pr_review: GitHub PR comment failed", "error", err)
	}
	return "", "", nil
}
