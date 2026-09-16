// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import "testing"

// T2.3b: branch-protection policy must be opted out by default for legacy
// repos, must not fire on non-GitHub providers until T1.4 lands, and must
// have a default branch to target.
func TestShouldEnsureBranchProtection_GatingMatrix(t *testing.T) {
	cases := []struct {
		name string
		card *discoverResult
		want bool
	}{
		{
			name: "opted_in_github_with_default_branch",
			card: &discoverResult{
				RequireBranchProtection: true,
				GitRepoProvider:         "github",
				DefaultBranch:           "main",
			},
			want: true,
		},
		{
			name: "opted_in_blank_provider_treated_as_github",
			card: &discoverResult{
				RequireBranchProtection: true,
				GitRepoProvider:         "",
				DefaultBranch:           "main",
			},
			want: true,
		},
		{
			name: "opted_out",
			card: &discoverResult{
				RequireBranchProtection: false,
				GitRepoProvider:         "github",
				DefaultBranch:           "main",
			},
			want: false,
		},
		{
			name: "gitlab_provider_deferred_to_T1_4",
			card: &discoverResult{
				RequireBranchProtection: true,
				GitRepoProvider:         "gitlab",
				DefaultBranch:           "main",
			},
			want: false,
		},
		{
			name: "bitbucket_provider_deferred_to_T1_4",
			card: &discoverResult{
				RequireBranchProtection: true,
				GitRepoProvider:         "bitbucket",
				DefaultBranch:           "main",
			},
			want: false,
		},
		{
			name: "empty_default_branch",
			card: &discoverResult{
				RequireBranchProtection: true,
				GitRepoProvider:         "github",
				DefaultBranch:           "",
			},
			want: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := shouldEnsureBranchProtection(tc.card)
			if got != tc.want {
				t.Errorf("shouldEnsureBranchProtection = %v, want %v", got, tc.want)
			}
		})
	}
}
