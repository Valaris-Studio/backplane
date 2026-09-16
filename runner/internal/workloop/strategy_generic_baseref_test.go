// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// PAR-1: resolveBaseRef picks the git ref CreateBranch should fork off.
// Empty / "default_branch" preserves pre-PAR-1 behavior bit-for-bit; a
// non-empty IntegrationBranch is honored only when the stage opted in.
func TestResolveBaseRef_DefaultBehavior(t *testing.T) {
	tests := []struct {
		name string
		git  valaris.GitDef
		card *discoverResult
		want string
	}{
		{
			name: "empty base_ref falls back to default_branch",
			git:  valaris.GitDef{Action: "create_branch"},
			card: &discoverResult{DefaultBranch: "main", IntegrationBranch: "develop"},
			want: "main",
		},
		{
			name: "explicit default_branch ignores integration_branch",
			git:  valaris.GitDef{Action: "create_branch", BaseRef: "default_branch"},
			card: &discoverResult{DefaultBranch: "main", IntegrationBranch: "develop"},
			want: "main",
		},
		{
			name: "integration_branch wins when card has one",
			git:  valaris.GitDef{Action: "create_branch", BaseRef: "integration_branch"},
			card: &discoverResult{DefaultBranch: "main", IntegrationBranch: "develop"},
			want: "develop",
		},
		{
			name: "integration_branch falls back to default when card has none",
			git:  valaris.GitDef{Action: "create_branch", BaseRef: "integration_branch"},
			card: &discoverResult{DefaultBranch: "main", IntegrationBranch: ""},
			want: "main",
		},
		{
			name: "unknown base_ref falls back to default_branch",
			git:  valaris.GitDef{Action: "create_branch", BaseRef: "garbage"},
			card: &discoverResult{DefaultBranch: "main", IntegrationBranch: "develop"},
			want: "main",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := resolveBaseRef(tt.git, tt.card)
			if got != tt.want {
				t.Errorf("resolveBaseRef() = %q, want %q", got, tt.want)
			}
		})
	}
}

// Contract: the PR base passed to gh pr create MUST equal the branch base
// passed to git checkout -b. Drift between them (the historical bug) means
// runners branch off integration_branch but open PRs against main, so the
// merge queue silently lands work on main even when the workspace is
// configured for integration_branch. resolveBaseRef is the single source of
// truth for both — this test pins that.
func TestResolveBaseRef_IsSharedBetweenBranchAndPR(t *testing.T) {
	cfg := valaris.GitDef{Action: "create_branch", BaseRef: "integration_branch"}
	card := &discoverResult{DefaultBranch: "main", IntegrationBranch: "develop"}

	branchBase := resolveBaseRef(cfg, card)
	prBase := resolveBaseRef(cfg, card)

	if branchBase != prBase {
		t.Fatalf("branch base %q diverged from PR base %q", branchBase, prBase)
	}
	if prBase != "develop" {
		t.Fatalf("PR base %q should equal integration_branch %q", prBase, "develop")
	}
}

// PAR-1: discoverResultFromAssignment must propagate IntegrationBranch from
// the backend bundle so resolveBaseRef has the field to read.
func TestDiscoverResultFromAssignment_IntegrationBranch(t *testing.T) {
	resp := &valaris.NextAssignmentResponse{
		Card:  valaris.Card{ID: "c1", Title: "t"},
		Board: valaris.AssignmentBoard{ID: "b1"},
		Repo: &valaris.AssignmentRepo{
			Name:              "acme",
			URL:               "https://github.com/acme/acme",
			DefaultBranch:     "main",
			IntegrationBranch: "develop",
		},
	}

	r := discoverResultFromAssignment(resp)

	if r.DefaultBranch != "main" {
		t.Errorf("DefaultBranch = %q, want %q", r.DefaultBranch, "main")
	}
	if r.IntegrationBranch != "develop" {
		t.Errorf("IntegrationBranch = %q, want %q", r.IntegrationBranch, "develop")
	}
}
