// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package github

import (
	"context"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
)

// managerAdapter wraps *git.Manager to satisfy ghManager, converting git's
// concrete PR types to this package's mirror types. This is the ONLY file that
// imports git, keeping the driver itself unit-testable with a fake.
type managerAdapter struct{ m *git.Manager }

func (a managerAdapter) CreatePR(ctx context.Context, repoDir, title, body, base string) (string, error) {
	return a.m.CreatePR(ctx, repoDir, title, body, base)
}
func (a managerAdapter) ReviewPR(ctx context.Context, repoDir, prURL, decision, body string) error {
	return a.m.ReviewPR(ctx, repoDir, prURL, decision, body)
}
func (a managerAdapter) CommentPR(ctx context.Context, repoDir, prURL, body string) error {
	return a.m.CommentPR(ctx, repoDir, prURL, body)
}
func (a managerAdapter) CheckPRStatus(ctx context.Context, repoDir, prURL string) (ghStatus, error) {
	st, err := a.m.CheckPRStatus(ctx, repoDir, prURL)
	if err != nil {
		return ghStatus{}, err
	}
	return ghStatus{State: st.State, MergeStateStatus: st.MergeStateStatus}, nil
}
func (a managerAdapter) ListOpenPRs(ctx context.Context, repoDir, repoSlug string) ([]ghPR, error) {
	prs, err := a.m.ListOpenPRs(ctx, repoDir, repoSlug)
	if err != nil {
		return nil, err
	}
	out := make([]ghPR, 0, len(prs))
	for _, p := range prs {
		out = append(out, ghPR{Number: p.Number, HeadRefName: p.HeadRefName, Files: p.Files})
	}
	return out, nil
}
func (a managerAdapter) CurrentPRForBranch(ctx context.Context, repoDir, branch string) (string, error) {
	return a.m.CurrentPRForBranch(ctx, repoDir, branch)
}
func (a managerAdapter) PRBaseBranch(ctx context.Context, repoDir, prURL string) (string, error) {
	return a.m.PRBaseBranch(ctx, repoDir, prURL)
}
func (a managerAdapter) MergePR(ctx context.Context, repoDir, prURL, strategy string) error {
	return a.m.MergePR(ctx, repoDir, prURL, strategy)
}
func (a managerAdapter) EnsureBranchProtection(ctx context.Context, repoDir, branch string) error {
	return a.m.EnsureBranchProtection(ctx, repoDir, branch)
}

// New builds a GitHub forge.Provider backed by the given git.Manager.
func New(m *git.Manager) *Driver {
	return &Driver{gh: managerAdapter{m: m}}
}
