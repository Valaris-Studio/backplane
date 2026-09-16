// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"log/slog"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// lifecycleGitSetup wraps DataDrivenStrategy.gitSetupWithConfig. Reads optional
// step.Params (action, branch_prefix, create_pr, force_push_on_rework, base_ref)
// to override the stage's Git defaults. Populates WalkState.RepoDir and
// WalkState.Branch for downstream llm / git-mutating steps.
//
// The cleanup func returned by gitSetupWithConfig is stashed on the walk
// scratchpad under "git_cleanup" so a terminal step (or a wrapping
// tickViaLifecycle) can run it. Walkers without a terminal mutation never
// reset the working tree — this is intentional; non-mutating lifecycles
// (e.g., reviewer that only reads) don't need a reset.
func lifecycleGitSetup(ctx context.Context, ws *lifecycle.WalkState, step *valaris.LifecycleStep) (string, string, error) {
	l := loopFromWalk(ws)
	s := strategyFromWalk(ws)
	card, err := requireCard(ws, step.Name, step.Kind)
	if err != nil {
		return "", "", err
	}

	prev := s.config.Git
	if action := paramString(step, "action", ""); action != "" {
		s.config.Git.Action = action
	}
	if prefix := paramString(step, "branch_prefix", ""); prefix != "" {
		s.config.Git.BranchPrefix = prefix
	}
	if step.Params != nil {
		if v, ok := step.Params["create_pr"].(bool); ok {
			s.config.Git.CreatePR = v
		}
		if v, ok := step.Params["force_push_on_rework"].(bool); ok {
			s.config.Git.ForcePushOnRework = v
		}
	}
	if baseRef := paramString(step, "base_ref", ""); baseRef != "" {
		s.config.Git.BaseRef = baseRef
	}
	defer func() { s.config.Git = prev }()

	repoDir, branch, branchRecovered, cleanup, err := s.gitSetupWithConfig(ctx, ctx, l, card, false)
	if err != nil {
		return "", "", err
	}
	ws.RepoDir = repoDir
	ws.Branch = branch
	ws.Set("branch_recovered", branchRecovered)
	if cleanup != nil {
		ws.Set("git_cleanup", cleanup)
	}

	// Persist branch_name to the card NOW, before any LLM/PR step runs. If a
	// later step wedges after commit+PR but before completing, the card still
	// carries its branch linkage — so the backend's repo_has_no_open_pr
	// precondition recognizes the card's own PR as its own on retry instead of
	// stranding it in limbo (M1-05, 2026-05-26). Best-effort: a failure here
	// must not abort the stage (the branch exists regardless), so we log and
	// proceed rather than returning the error.
	if branch != "" {
		if err := recordCardBranch(ctx, l, card, branch); err != nil {
			slog.Warn("failed to persist branch_name to card (non-fatal)",
				"card_id", card.CardID, "branch", branch, "error", err)
		}
	}
	return "", "", nil
}

// recordCardBranch PATCHes the card's branch_name field so the branch linkage
// survives a mid-stage failure. Separated from lifecycleGitSetup so it can be
// unit-tested without the real git shell-out.
func recordCardBranch(ctx context.Context, l *Loop, card *discoverResult, branch string) error {
	return l.client.UpdateCard(ctx, l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID,
		map[string]any{"branch_name": branch})
}
