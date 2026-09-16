// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// lifecycleMergePR is the direct merge counterpart to enqueue_for_merge. It
// branches on platformConfig.PipelineConfig.MergeViaQueue: when true, hands
// the PR to the backend merge queue (Client.EnqueueForMerge); when false,
// calls Loop.mergeGate (set to git.Manager.MergePR by default, fakeable for
// tests).
//
// Unlike the legacy applyApproveMergeGate, this handler does NOT replicate
// the transient/permanent error classification, the rebase-on-base retry, or
// the routeToBlocked side-effect. Operators compose those via on_failure →
// create_note + move_card chains in their own lifecycle. The handler stays
// thin so the behavior surfaces in the lifecycle DSL and not in implicit
// runner-side logic.
func lifecycleMergePR(ctx context.Context, ws *lifecycle.WalkState, step *valaris.LifecycleStep) (string, string, error) {
	l := loopFromWalk(ws)
	card, err := requireCard(ws, step.Name, step.Kind)
	if err != nil {
		return "", "", err
	}
	if card.PRURL == "" {
		return "", "", &configError{msg: "merge_pr requires a card with a PR URL"}
	}
	strategy := paramString(step, "strategy", l.cfg.Git.MergeStrategy)

	l.platformConfigMu.RLock()
	useQueue := l.platformConfig.PipelineConfig != nil && l.platformConfig.PipelineConfig.MergeViaQueue
	l.platformConfigMu.RUnlock()

	if useQueue {
		return "", "", l.client.EnqueueForMerge(
			ctx,
			l.cfg.Valaris.WorkspaceSlug,
			card.CardID,
			card.GitRepoID,
			card.PRURL,
			card.PRBranch,
			card.IntegrationBranch,
		)
	}
	if l.mergeGate == nil {
		return "", "", &configError{msg: "merge_pr requires a configured mergeGate (runner not built with git manager?)"}
	}
	if ws.RepoDir == "" {
		return "", "", &configError{msg: "merge_pr requires a prior git_setup step (RepoDir empty)"}
	}
	return "", "", l.mergeGate(ctx, ws.RepoDir, card.PRURL, strategy)
}
