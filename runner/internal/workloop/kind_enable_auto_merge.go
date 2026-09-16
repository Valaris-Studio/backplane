// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// lifecycleEnableAutoMerge is a SILENT NO-OP. The enable_auto_merge kind stays
// in the closed registry (lifecycle/kinds.go, mirrored in the backend's
// lifecycle_kinds.py — the parity test asserts both agree) so existing
// pipeline configs that still reference an arm_auto_merge step don't trip the
// startup handler-completeness panic. But the runner no longer arms GitHub's
// proprietary auto-merge.
//
// Why removed (Cluster III, post-client-pilot hardening): arming depends on a
// GitHub-only feature (enablePullRequestAutoMerge). It soft-failed harmlessly
// on the free-plan repo across all 23 client-pilot cards, generating WARN
// noise on every implement card while contributing nothing — the reviewer's
// explicit merge_pr after an approve verdict is the real (and only) merge
// path. Dropping the arm removes the noise and the single-provider coupling,
// per the git-provider-agnostic north star (card d8f7eba4 Layer 1).
//
// Merges still happen only via the reviewer's merge_pr step (kind_merge_pr.go /
// Loop.mergeGate) after an approve verdict — the Done-gate is unchanged.
func lifecycleEnableAutoMerge(_ context.Context, _ *lifecycle.WalkState, _ *valaris.LifecycleStep) (string, string, error) {
	return "", "", nil
}
