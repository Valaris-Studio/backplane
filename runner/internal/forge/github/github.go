// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package github implements forge.Provider for GitHub by delegating to the
// existing git.Manager `gh`-CLI methods. This is the refactor-in-place seam:
// the gh wiring is not rewritten, only wrapped behind the neutral interface
// (the validated "gh-as-pass-through-inside-the-driver" pattern). The runner
// routes all forge calls through forge.Provider; this driver is what makes the
// GitHub path behave exactly as before.
package github

import (
	"context"
	"fmt"

	"github.com/Valaris-Studio/backplane/runner/internal/forge"
)

// ghStatus mirrors git.PRStatus (avoids importing git here; the adapter in
// adapt.go converts git.PRStatus → ghStatus so this package stays cycle-free
// and unit-testable with a fake).
type ghStatus struct {
	State            string // OPEN, MERGED, CLOSED
	MergeStateStatus string // CLEAN, DIRTY, BLOCKED, BEHIND, UNKNOWN
}

// ghPR mirrors git.PullRequestFiles.
type ghPR struct {
	Number      int
	HeadRefName string
	Files       []string
}

// ghManager is the narrow slice of git.Manager's forge methods this driver
// needs. *git.Manager satisfies it via the thin adapter in adapt.go.
type ghManager interface {
	CreatePR(ctx context.Context, repoDir, title, body, baseBranch string) (string, error)
	ReviewPR(ctx context.Context, repoDir, prURL, decision, body string) error
	CommentPR(ctx context.Context, repoDir, prURL, body string) error
	CheckPRStatus(ctx context.Context, repoDir, prURL string) (ghStatus, error)
	ListOpenPRs(ctx context.Context, repoDir, repoSlug string) ([]ghPR, error)
	CurrentPRForBranch(ctx context.Context, repoDir, branch string) (string, error)
	PRBaseBranch(ctx context.Context, repoDir, prURL string) (string, error)
	MergePR(ctx context.Context, repoDir, prURL, strategy string) error
	EnsureBranchProtection(ctx context.Context, repoDir, branch string) error
}

// Driver is the GitHub forge.Provider.
type Driver struct {
	gh ghManager
}

func (d *Driver) Kind() string { return "github" }

func (d *Driver) OpenChange(ctx context.Context, repoDir string, in forge.OpenChangeInput) (string, error) {
	// gh pr create infers the head from the current branch, so SourceBranch is
	// not forwarded; TargetBranch becomes --base (an empty base would silently
	// default to the web-UI default branch and break the integration flow).
	return d.gh.CreatePR(ctx, repoDir, in.Title, in.Body, in.TargetBranch)
}

func (d *Driver) Review(ctx context.Context, repoDir, changeURL string, decision forge.ReviewDecision, body string) error {
	if !decision.Valid() {
		return fmt.Errorf("invalid review decision %q", decision)
	}
	// Neutral ReviewDecision string values already match gh's verbs.
	return d.gh.ReviewPR(ctx, repoDir, changeURL, string(decision), body)
}

func (d *Driver) CommentOn(ctx context.Context, repoDir, changeURL, body string) error {
	return d.gh.CommentPR(ctx, repoDir, changeURL, body)
}

func (d *Driver) ChangeStatusFor(ctx context.Context, repoDir, changeURL string) (forge.ChangeStatus, error) {
	st, err := d.gh.CheckPRStatus(ctx, repoDir, changeURL)
	if err != nil {
		return forge.ChangeStatus{}, err
	}
	return forge.ChangeStatus{
		State:     mapState(st.State),
		Mergeable: st.State == "OPEN" && st.MergeStateStatus == "CLEAN",
	}, nil
}

func (d *Driver) ListOpenChanges(ctx context.Context, repoDir, repoSlug string) ([]forge.ChangeFiles, error) {
	prs, err := d.gh.ListOpenPRs(ctx, repoDir, repoSlug)
	if err != nil {
		return nil, err
	}
	out := make([]forge.ChangeFiles, 0, len(prs))
	for _, p := range prs {
		out = append(out, forge.ChangeFiles{Number: p.Number, HeadBranch: p.HeadRefName, Files: p.Files})
	}
	return out, nil
}

func (d *Driver) CurrentChangeForBranch(ctx context.Context, repoDir, branch string) (string, error) {
	return d.gh.CurrentPRForBranch(ctx, repoDir, branch)
}

func (d *Driver) TargetBranchFor(ctx context.Context, repoDir, changeURL string) (string, error) {
	return d.gh.PRBaseBranch(ctx, repoDir, changeURL)
}

func (d *Driver) Merge(ctx context.Context, repoDir, changeURL string, strategy forge.MergeStrategy) error {
	if !strategy.Valid() {
		return fmt.Errorf("invalid merge strategy %q", strategy)
	}
	return d.gh.MergePR(ctx, repoDir, changeURL, string(strategy))
}

func (d *Driver) EnsureBranchProtection(ctx context.Context, repoDir, branch string) error {
	return d.gh.EnsureBranchProtection(ctx, repoDir, branch)
}

func mapState(s string) forge.ChangeState {
	switch s {
	case "OPEN":
		return forge.StateOpen
	case "MERGED":
		return forge.StateMerged
	case "CLOSED":
		return forge.StateClosed
	default:
		return forge.StateUnknown
	}
}
