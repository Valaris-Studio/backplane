// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package forge

import (
	"context"
	"fmt"
)

// Fake is an in-memory Provider for tests: it records every call and returns
// canned results, so call-site tests exercise forge behavior without a real
// CLI/API. Mirrors the backend's _FakeGitOps seam. The zero value is usable.
type Fake struct {
	// Canned results.
	OpenChangeURL string
	Status        ChangeStatus
	OpenChanges   []ChangeFiles
	BranchURL     string // returned by CurrentChangeForBranch
	TargetBranch  string
	Err           error // when set, every method returns it

	// Recorded calls.
	OpenChangeCalls   []OpenChangeCall
	ReviewCalls       []ReviewCall
	CommentCalls      []CommentCall
	MergeCalls        []MergeCall
	StatusCalls       []string // changeURLs
	ProtectionCalls   []string // branches
	ListOpenCalls     []string // repoSlugs
	BranchLookupCalls []string // branches
}

type OpenChangeCall struct {
	RepoDir string
	Input   OpenChangeInput
}
type ReviewCall struct {
	ChangeURL string
	Decision  ReviewDecision
	Body      string
}
type CommentCall struct {
	ChangeURL string
	Body      string
}
type MergeCall struct {
	ChangeURL string
	Strategy  MergeStrategy
}

func (f *Fake) Kind() string { return "fake" }

func (f *Fake) OpenChange(_ context.Context, repoDir string, in OpenChangeInput) (string, error) {
	if f.Err != nil {
		return "", f.Err
	}
	f.OpenChangeCalls = append(f.OpenChangeCalls, OpenChangeCall{RepoDir: repoDir, Input: in})
	return f.OpenChangeURL, nil
}

func (f *Fake) Review(_ context.Context, _ string, changeURL string, decision ReviewDecision, body string) error {
	if f.Err != nil {
		return f.Err
	}
	if !decision.Valid() {
		return fmt.Errorf("invalid review decision %q", decision)
	}
	f.ReviewCalls = append(f.ReviewCalls, ReviewCall{ChangeURL: changeURL, Decision: decision, Body: body})
	return nil
}

func (f *Fake) CommentOn(_ context.Context, _ string, changeURL, body string) error {
	if f.Err != nil {
		return f.Err
	}
	if body == "" {
		return nil
	}
	f.CommentCalls = append(f.CommentCalls, CommentCall{ChangeURL: changeURL, Body: body})
	return nil
}

func (f *Fake) ChangeStatusFor(_ context.Context, _ string, changeURL string) (ChangeStatus, error) {
	if f.Err != nil {
		return ChangeStatus{}, f.Err
	}
	f.StatusCalls = append(f.StatusCalls, changeURL)
	return f.Status, nil
}

func (f *Fake) ListOpenChanges(_ context.Context, _ string, repoSlug string) ([]ChangeFiles, error) {
	if f.Err != nil {
		return nil, f.Err
	}
	f.ListOpenCalls = append(f.ListOpenCalls, repoSlug)
	return f.OpenChanges, nil
}

func (f *Fake) CurrentChangeForBranch(_ context.Context, _ string, branch string) (string, error) {
	if f.Err != nil {
		return "", f.Err
	}
	f.BranchLookupCalls = append(f.BranchLookupCalls, branch)
	return f.BranchURL, nil
}

func (f *Fake) TargetBranchFor(_ context.Context, _ string, _ string) (string, error) {
	if f.Err != nil {
		return "", f.Err
	}
	return f.TargetBranch, nil
}

func (f *Fake) Merge(_ context.Context, _ string, changeURL string, strategy MergeStrategy) error {
	if !strategy.Valid() {
		return fmt.Errorf("invalid merge strategy %q", strategy)
	}
	if f.Err != nil {
		return f.Err
	}
	f.MergeCalls = append(f.MergeCalls, MergeCall{ChangeURL: changeURL, Strategy: strategy})
	return nil
}

func (f *Fake) EnsureBranchProtection(_ context.Context, _ string, branch string) error {
	if f.Err != nil {
		return f.Err
	}
	f.ProtectionCalls = append(f.ProtectionCalls, branch)
	return nil
}
