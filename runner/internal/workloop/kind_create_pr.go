// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"fmt"

	"github.com/Valaris-Studio/backplane/runner/internal/forge"
	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// lifecycleCreatePR opens a PR for the work the prior llm step pushed. Mirrors
// the implicit PR-creation block embedded in postActionWithConfig (strategy_generic.go
// ~line 1318). Title defaults to card.Title and body to the legacy
// "Implements card <id>\n\n<summary>" template; title_from / body_from are
// reserved for future template support and ignored today.
//
// Base branch resolution reuses resolveBaseRef so create_branch and create_pr
// agree on the target — without this, gh would silently retarget the repo
// default branch (main) and bypass integration_branch.
//
// On success: stores the PR URL on both ws.Variables["pr_url"] and card.PRURL
// so downstream steps and $pr_url runtime refs see it. On failure: returns the
// error to the walker (operators route via on_failure if they want fail-soft).
func lifecycleCreatePR(ctx context.Context, ws *lifecycle.WalkState, step *valaris.LifecycleStep) (string, string, error) {
	l := loopFromWalk(ws)
	s := strategyFromWalk(ws)
	card, err := requireCard(ws, step.Name, step.Kind)
	if err != nil {
		return "", "", err
	}
	if ws.RepoDir == "" {
		return "", "", &configError{msg: "create_pr requires a prior git_setup step (RepoDir empty)"}
	}

	summary := ""
	if r := llmResultFromWalk(ws); r != nil && r.implResult != nil {
		summary = r.implResult.Summary
	}
	title := card.Title
	body := fmt.Sprintf("Implements card %s\n\n%s", card.CardID, summary)

	// Mirror the legacy create_branch / postActionWithConfig contract: PR base
	// must equal the branch base. The per-stage GitDef carries BaseRef; fall
	// back to the card's default branch when the stage didn't set one.
	baseRef := resolveBaseRef(s.config.Git, card)
	if baseRef == "" {
		baseRef = card.DefaultBranch
	}

	url, err := l.forge.OpenChange(ctx, ws.RepoDir, forge.OpenChangeInput{
		Title:        title,
		Body:         body,
		SourceBranch: card.PRBranch,
		TargetBranch: baseRef,
	})
	if err != nil {
		// FIX #1 case (b): the cutoff can land between the push and this step —
		// the walk context is then already dead, so the gh call above fails on
		// a context error even though the branch is pushed and PR-ready. Retry
		// the whole terminal sequence (push no-op → PR → ship) on a fresh
		// context before failing the card.
		//
		// M3: gated on the DEAD-context shape only (ctx.Err() != nil). A
		// live-context gh failure must take the step's normal on_failure path —
		// salvage ships via the flat-config OnSuccess and would skip the
		// remaining configured lifecycle steps, and the operator's lifecycle
		// stays authoritative over any hardcoded tail. The next-reservation
		// recovery covers the transient-outage case.
		if ctx.Err() != nil {
			branchRecovered, _ := ws.Get("branch_recovered")
			recovered, _ := branchRecovered.(bool)
			// emptyTurn=false: we are PAST the LLM turn (it succeeded); this path
			// salvages a create_pr step that failed on a dead walk context, not a
			// 0-work crash. The implement turn's real work is already committed.
			if s.salvageCommittedImplement(l, card, ws.ExecutionID, ws.RepoDir, ws.Branch, recovered, false, err, walkLogger(ws)) {
				ws.Set("execution_released", true)
				return "", "", lifecycle.ErrSalvaged
			}
		}
		return "", "", err
	}
	card.PRURL = url
	ws.Set("pr_url", url)
	return "", "", nil
}
