// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package forge abstracts the code-hosting forge behind a provider-neutral
// interface, so the runner is not hard-wired to GitHub's `gh` CLI. Two drivers
// ship today: github (wraps the `gh` CLI) and gitea (Gitea/Forgejo REST API).
// Other forges (GitLab, Bitbucket) are roadmap — the seam exists for them, the
// drivers do not. It covers ONLY the forge-API surface: opening / reviewing
// / merging a "change" (a PR/MR/"pull request" — see ReviewDecision/Change for
// the neutral vocabulary), plus the status rollups the merge gate needs. Plain
// git (clone/branch/commit/push) is provider-neutral already and stays in the
// git package — it is deliberately NOT part of this interface.
//
// Vocabulary: a forge-neutral "Change" is what GitHub/Gitea call a pull request
// and GitLab calls a merge request. Per the program's naming decision (Option
// C) the persisted DB columns keep their `pr_*` names; only this code seam is
// neutralized, mapping at the edge.
package forge

import "context"

// MergeStrategy is the portable lowest-common-denominator merge mode. Not every
// forge honours every strategy identically (rebase in particular is lossy on
// some forges); drivers map it to their native flag and may fall back.
type MergeStrategy string

const (
	MergeSquash  MergeStrategy = "squash"
	MergeRebase  MergeStrategy = "rebase"
	MergeCommit  MergeStrategy = "merge"
	mergeDefault               = MergeSquash
)

func (s MergeStrategy) Valid() bool {
	switch s {
	case MergeSquash, MergeRebase, MergeCommit:
		return true
	}
	return false
}

// ReviewDecision is the neutral verdict a reviewer posts on a change. Drivers
// map it to their native review API (GitHub's approve/request-changes/comment,
// GitLab approvals, …). The string values match the historical gh review verbs
// so the GitHub driver is a pass-through.
type ReviewDecision string

const (
	Approve        ReviewDecision = "approve"
	RequestChanges ReviewDecision = "request-changes"
	Comment        ReviewDecision = "comment"
)

func (d ReviewDecision) Valid() bool {
	switch d {
	case Approve, RequestChanges, Comment:
		return true
	}
	return false
}

// ChangeState is the lifecycle state of a change, normalized across forges.
type ChangeState string

const (
	StateOpen    ChangeState = "open"
	StateMerged  ChangeState = "merged"
	StateClosed  ChangeState = "closed"
	StateUnknown ChangeState = "unknown"
)

// ChangeStatus is the rollup the merge gate consults. Per the 2026 forge
// research, CI checks / approvals / branch-protection do NOT abstract cleanly
// across forges, so they are collapsed to booleans (the Atlantis pattern)
// rather than modeled. Mergeable is the forge's own "can this merge now"
// signal; the runner stays failure-reactive (attempt the merge, react to a
// 4xx) rather than pre-introspecting protection rules.
type ChangeStatus struct {
	State     ChangeState
	Mergeable bool // forge says the change can be merged now (CI green + approvals + not behind)
}

// OpenChangeInput is the neutral payload for opening a change. TargetBranch is
// required by the runner's integration-branch flow (an empty target silently
// defaults to the forge's web-UI default branch, which breaks that flow).
type OpenChangeInput struct {
	Title        string
	Body         string
	SourceBranch string
	TargetBranch string
}

// ChangeFiles is the projection used by the PR-overlap sensor: which files a
// given open change touches. Number/HeadBranch identify the change.
type ChangeFiles struct {
	Number     int
	HeadBranch string
	Files      []string
}

// Provider is the forge-API seam. Each driver (github, gitea, …) implements it;
// the GitHub driver wraps the existing `gh` CLI as a pass-through. repoDir is
// the local clone directory the forge CLI/API operates against (the GitHub
// driver runs `gh` there so it infers owner/repo from the remote); repoSlug,
// when non-empty, names a specific "owner/repo" for cross-repo queries.
type Provider interface {
	// Kind returns the forge identifier, matching the backend GitProvider enum
	// values. Implemented today: "github" | "gitea" (the enum also carries
	// "gitlab" | "bitbucket" for repos no runner driver serves yet).
	Kind() string

	// OpenChange opens a change and returns its URL. Idempotent on the forge
	// side: if a change already exists for the source branch the driver returns
	// the existing URL instead of erroring.
	OpenChange(ctx context.Context, repoDir string, in OpenChangeInput) (url string, err error)

	// Review posts a review verdict on a change.
	Review(ctx context.Context, repoDir, changeURL string, decision ReviewDecision, body string) error

	// CommentOn posts an informational (non-verdict) comment. No-op on empty body.
	CommentOn(ctx context.Context, repoDir, changeURL, body string) error

	// ChangeStatusFor returns the merge-gate rollup for a change.
	ChangeStatusFor(ctx context.Context, repoDir, changeURL string) (ChangeStatus, error)

	// ListOpenChanges lists open changes (with touched files) for overlap
	// detection. repoSlug optionally scopes to a specific "owner/repo".
	ListOpenChanges(ctx context.Context, repoDir, repoSlug string) ([]ChangeFiles, error)

	// CurrentChangeForBranch returns the URL of the open change whose source is
	// the given branch, or "" if none.
	CurrentChangeForBranch(ctx context.Context, repoDir, branch string) (url string, err error)

	// TargetBranchFor returns the change's target/base branch (e.g. "main").
	TargetBranchFor(ctx context.Context, repoDir, changeURL string) (string, error)

	// Merge merges a change with the given strategy. Drivers reject an invalid
	// strategy before contacting the forge.
	Merge(ctx context.Context, repoDir, changeURL string, strategy MergeStrategy) error

	// EnsureBranchProtection best-effort applies the forge's branch-protection
	// policy. Forges without an equivalent may no-op. Callers treat failures as
	// non-fatal (the policy is defense-in-depth, not a gate).
	EnsureBranchProtection(ctx context.Context, repoDir, branch string) error
}
